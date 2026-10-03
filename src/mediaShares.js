import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { openDatabase } from './database.js';
import { getFilePath, isFileInsideJobFolder, isValidJobFileName } from './jobManager.js';
import { isSongFile } from './transcription.js';
import { readSongMetadata } from './music.js';

const metadataFields = ['title', 'artist', 'album', 'performerInfo', 'genre', 'year',
  'trackNumber', 'partOfSet', 'rating', 'artwork', 'sylt', 'uslt'];
const unavailable = () => Object.assign(new Error('Shared song not found'), { statusCode: 404 });
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function canShare(job, user) {
  return Boolean(user?.status === 'approved' && user.role !== 'shared' && (
    user.role === 'admin' || user.id === job.initiatedBy?.id
    || job.contributors?.some((contributor) => contributor.id === user.id)
  ));
}

async function resolveSong(job, name) {
  if (!job.outputDir || !isValidJobFileName(name) || !isSongFile(name)) throw unavailable();
  const filePath = getFilePath(job, name);
  const [outputDir, realPath] = await Promise.all([fs.realpath(job.outputDir), fs.realpath(filePath)]);
  if (outputDir !== path.resolve(job.outputDir) || realPath !== filePath
    || !isFileInsideJobFolder({ outputDir }, realPath)) throw unavailable();
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw unavailable();
  return { filePath: realPath, name: path.basename(name), sizeBytes: stat.size };
}

export function mediaShareHeaders(_req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  next();
}

export async function createMediaShare(req, res) {
  try {
    const database = openDatabase();
    const url = await database.withTransaction(async () => {
      const creator = await database.prepare('SELECT id, role, status FROM users WHERE id = $1').get(req.user.id);
      const record = await database.prepare(`SELECT jobs.data FROM jobs
        JOIN songs ON songs.job_id = jobs.id
        WHERE jobs.id = $1 AND songs.name = $2 AND songs.media_type = 'audio'`)
        .get(req.params.id, req.params.name);
      if (!record) throw unavailable();
      const job = JSON.parse(record.data);
      if (!canShare(job, creator)) {
        throw Object.assign(new Error('You do not have permission to share this song'), { statusCode: 403 });
      }
      await resolveSong(job, req.params.name);
      const token = crypto.randomBytes(32).toString('base64url');
      await database.prepare('INSERT INTO media_shares (token_hash, job_id, name, creator_id) VALUES ($1, $2, $3, $4)')
        .run(hashToken(token), req.params.id, req.params.name, creator.id);
      return `/share/${token}`;
    });
    return res.status(201).json({ url });
  } catch (error) {
    if (error.statusCode === 403) return res.status(403).json({ error: error.message });
    return res.status(404).json({ error: 'Shared song not found' });
  }
}

async function resolveShare(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)
    || Buffer.from(token, 'base64url').toString('base64url') !== token) throw unavailable();
  const record = await openDatabase().prepare(`SELECT shares.name, jobs.data, users.id, users.role, users.status
    FROM media_shares shares
    JOIN songs ON songs.job_id = shares.job_id AND songs.name = shares.name
    JOIN jobs ON jobs.id = songs.job_id
    JOIN users ON users.id = shares.creator_id
    WHERE shares.token_hash = $1 AND songs.media_type = 'audio'`).get(hashToken(token));
  if (!record) throw unavailable();
  const job = JSON.parse(record.data);
  if (!canShare(job, record)) throw unavailable();
  return resolveSong(job, record.name);
}

function notFound(_req, res) {
  return res.status(404).json({ error: 'Shared song not found' });
}

function sendError(res, error) {
  if (!error || res.destroyed) return;
  if (res.headersSent) return res.destroy();
  res.removeHeader('Content-Disposition');
  res.removeHeader('Content-Length');
  res.removeHeader('Content-Type');
  if (error.statusCode === 416) {
    if (error.headers?.['Content-Range']) res.set('Content-Range', error.headers['Content-Range']);
    return res.status(416).end();
  }
  res.removeHeader('Content-Range');
  return notFound(null, res);
}

export function publicMediaRouter() {
  const router = Router();
  let metadataInFlight = 0;
  router.use((req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : notFound(req, res));
  router.get('/media/:token', async (req, res) => {
    if (metadataInFlight >= 4) {
      return res.set('Retry-After', '1').status(503).json({ error: 'Shared song metadata is busy. Please retry.' });
    }
    metadataInFlight += 1;
    let extractionDone = false;
    let released = false;
    const release = () => {
      if (!released && extractionDone && (res.writableFinished || res.destroyed)) {
        released = true;
        metadataInFlight -= 1;
      }
    };
    res.once('finish', release);
    res.once('close', release);
    try {
      const song = await resolveShare(req.params.token);
      const metadata = await readSongMetadata(song.filePath, { bounded: true });
      const url = `/api/public/media/${req.params.token}`;
      res.json({
        ...Object.fromEntries(metadataFields.map((field) => [field, metadata[field]])),
        name: song.name,
        sizeBytes: song.sizeBytes,
        streamUrl: `${url}/stream`,
        downloadUrl: `${url}/download`
      });
    } catch { notFound(req, res); }
    finally {
      extractionDone = true;
      release();
    }
  });
  for (const action of ['stream', 'download']) {
    router.get(`/media/:token/${action}`, async (req, res) => {
      try {
        const song = await resolveShare(req.params.token);
        const options = { cacheControl: false, lastModified: false };
        if (action === 'download') {
          res.download(song.filePath, song.name, options, (error) => sendError(res, error));
        } else {
          res.sendFile(song.filePath, options, (error) => sendError(res, error));
        }
      } catch { notFound(req, res); }
    });
  }
  router.use(notFound);
  router.use((_error, req, res, _next) => notFound(req, res));
  return router;
}
