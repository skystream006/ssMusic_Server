import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { openDatabase } from './database.js';
import { getFilePath, isFileInsideJobFolder, isValidJobFileName } from './jobManager.js';
import { isSongFile } from './transcription.js';
import { readSongMetadata } from './music.js';
import { individualPlaylistNames } from './library.js';
import { entryVisibilitySql, fileVisibilitySql, jobVisibilitySql } from './privacy.js';

const metadataFields = ['title', 'artist', 'album', 'performerInfo', 'genre', 'year',
  'trackNumber', 'partOfSet', 'rating', 'artwork', 'sylt', 'uslt'];
const unavailable = () => Object.assign(new Error('Shared song not found'), { statusCode: 404 });
const playlistUnavailable = () => Object.assign(new Error('Shared playlist not found'), { statusCode: 404 });
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const validToken = (token) => /^[A-Za-z0-9_-]{43}$/.test(token)
  && Buffer.from(token, 'base64url').toString('base64url') === token;
const playlistTrackId = "encode(sha256(convert_to(jsonb_build_array(songs.job_id, songs.name)::text, 'UTF8')), 'hex')";
const playlistTracks = `FROM library_memberships membership
  JOIN songs ON songs.job_id = membership.job_id AND songs.name = membership.name
  JOIN jobs ON jobs.id = songs.job_id
  WHERE membership.user_id = $1 AND membership.playlist_id = $2 AND songs.media_type = 'audio'
    AND ${fileVisibilitySql('jobs', 'songs.name', 'NULL')}
    AND ($3 = 'admin' OR jobs.data->'initiatedBy'->>'id' = $1
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(jobs.data->'contributors', '[]'::jsonb)) contributor
        WHERE contributor->>'id' = $1))`;

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
        WHERE jobs.id = $1 AND songs.name = $2 AND songs.media_type = 'audio'
          AND ${fileVisibilitySql('jobs', 'songs.name', 'NULL')}`)
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

async function loadPlaylist(creatorId, playlistId) {
  const record = await openDatabase().prepare(`SELECT users.id, users.role, users.status,
    entry.data AS entry_data, jobs.data AS job_data
    FROM users JOIN library_entries entry ON entry.user_id = users.id
    LEFT JOIN jobs ON jobs.id = entry.id
    WHERE users.id = $1 AND entry.id = $2 AND entry.entry_type = 'playlist'
      AND ${entryVisibilitySql('entry', 'NULL')}`).get(creatorId, playlistId);
  if (!record) throw playlistUnavailable();
  const entry = JSON.parse(record.entry_data);
  const job = record.job_data ? JSON.parse(record.job_data) : null;
  const individual = entry.protected && Object.hasOwn(individualPlaylistNames, playlistId);
  if ((!job && !individual) || !canShare(individual ? { initiatedBy: { id: creatorId } } : job, record)) {
    throw playlistUnavailable();
  }
  return { id: playlistId, jobId: job?.id || null, title: entry.name || job?.playlistTitle || 'Playlist', creator: record };
}

export async function createPlaylistShare(req, res) {
  try {
    const database = openDatabase();
    const url = await database.withTransaction(async () => {
      const playlist = await loadPlaylist(req.user.id, req.params.id);
      const available = await database.prepare(`SELECT 1 ${playlistTracks} LIMIT 1`)
        .get(playlist.creator.id, playlist.id, playlist.creator.role);
      if (!available) throw playlistUnavailable();
      const token = crypto.randomBytes(32).toString('base64url');
      await database.prepare('INSERT INTO playlist_shares (token_hash, playlist_id, job_id, creator_id) VALUES ($1, $2, $3, $4)')
        .run(hashToken(token), playlist.id, playlist.jobId, req.user.id);
      return `/share/playlist/${token}`;
    });
    return res.status(201).json({ url });
  } catch {
    return res.status(404).json({ error: 'Shared playlist not found or no public songs available' });
  }
}

async function resolvePlaylistShare(token) {
  if (!validToken(token)) throw playlistUnavailable();
  const share = await openDatabase().prepare('SELECT playlist_id, creator_id FROM playlist_shares WHERE token_hash = $1').get(hashToken(token));
  if (!share) throw playlistUnavailable();
  return loadPlaylist(share.creator_id, share.playlist_id);
}

async function resolvePlaylistSong(req) {
  if (!/^[a-f0-9]{64}$/.test(req.params.trackId)) throw unavailable();
  const playlist = await resolvePlaylistShare(req.params.token);
  const song = await openDatabase().prepare(`SELECT songs.name, jobs.data ${playlistTracks} AND ${playlistTrackId} = $4`)
    .get(playlist.creator.id, playlist.id, playlist.creator.role, req.params.trackId);
  if (!song) throw unavailable();
  return resolveSong(JSON.parse(song.data), song.name);
}

async function resolveShare(token) {
  if (!validToken(token)) throw unavailable();
  const record = await openDatabase().prepare(`SELECT shares.name, jobs.data, users.id, users.role, users.status
    FROM media_shares shares
    JOIN songs ON songs.job_id = shares.job_id AND songs.name = shares.name
    JOIN jobs ON jobs.id = songs.job_id
    JOIN users ON users.id = shares.creator_id
    WHERE shares.token_hash = $1 AND songs.media_type = 'audio'
      AND ${fileVisibilitySql('jobs', 'songs.name', 'NULL')}`).get(hashToken(token));
  if (!record) throw unavailable();
  const job = JSON.parse(record.data);
  if (!canShare(job, record)) throw unavailable();
  return resolveSong(job, record.name);
}

function notFound(_req, res) {
  return res.status(404).json({ error: 'Shared song not found' });
}

export function adminMediaSharesRouter() {
  const router = Router();
  const listing = `SELECT shares.token_hash AS id, shares.job_id AS "jobId", shares.name,
    users.name AS "creatorName", shares.creator_id AS "creatorId",
    jobs.data->>'playlistTitle' AS "playlistTitle", NULL::text AS kind
    FROM media_shares shares LEFT JOIN users ON users.id = shares.creator_id
    JOIN jobs ON jobs.id = shares.job_id WHERE ${fileVisibilitySql('jobs', 'shares.name', '$1')}
    UNION ALL
    SELECT shares.token_hash AS id, jobs.id AS "jobId",
    COALESCE(entry.data->>'name', jobs.data->>'playlistTitle', 'Playlist') AS name,
    users.name AS "creatorName", shares.creator_id AS "creatorId",
    COALESCE(entry.data->>'name', jobs.data->>'playlistTitle', 'Playlist') AS "playlistTitle", 'playlist' AS kind
    FROM playlist_shares shares LEFT JOIN users ON users.id = shares.creator_id
    LEFT JOIN jobs ON jobs.id = shares.playlist_id
    LEFT JOIN library_entries entry ON entry.user_id = shares.creator_id AND entry.id = shares.playlist_id
    WHERE ${entryVisibilitySql('entry', '$1')} AND ${jobVisibilitySql('jobs', '$1')}`;
  router.get('/', async (req, res) => {
    const requestedPage = Number(req.query.page || 1);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
      return res.status(400).json({ error: 'Invalid page' });
    }
    const result = await openDatabase().withTransaction(async () => {
      const database = openDatabase();
      const { total } = await database.prepare(`SELECT COUNT(*)::integer AS total FROM (${listing}) links`).get(req.user.id);
      const pageSize = 50;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const rows = await database.prepare(`SELECT * FROM (${listing}) links ORDER BY id LIMIT $2 OFFSET $3`)
        .all(req.user.id, pageSize, (page - 1) * pageSize);
      return { shares: rows.map(({ kind, ...share }) => kind ? { ...share, kind } : share), page, pageSize, total, totalPages };
    });
    res.json(result);
  });
  router.delete('/:id', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) return res.status(404).json({ error: 'Shared link not found' });
    const database = openDatabase();
    let deleted = await database.prepare(`DELETE FROM media_shares shares USING jobs
      WHERE shares.token_hash = $1 AND jobs.id = shares.job_id
        AND ${fileVisibilitySql('jobs', 'shares.name', '$2')} RETURNING shares.token_hash`)
      .get(req.params.id, req.user.id);
    if (!deleted) deleted = await database.prepare(`DELETE FROM playlist_shares shares WHERE shares.token_hash = $1
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = shares.playlist_id AND NOT ${jobVisibilitySql('jobs', '$2')})
      AND NOT EXISTS (SELECT 1 FROM library_entries entry WHERE entry.user_id = shares.creator_id
        AND entry.id = shares.playlist_id AND NOT (${entryVisibilitySql('entry', '$2')}))
      RETURNING shares.token_hash`).get(req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Shared link not found' });
    return res.status(204).end();
  });
  return router;
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
  router.get('/playlists/:token', async (req, res) => {
    try {
      const playlist = await resolvePlaylistShare(req.params.token);
      const requestedPage = Number(req.query.page || 1);
      if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) return res.status(400).json({ error: 'Invalid page' });
      const database = openDatabase();
      const parameters = [playlist.creator.id, playlist.id, playlist.creator.role];
      const { total } = await database.prepare(`SELECT count(*)::integer AS total ${playlistTracks}`).get(...parameters);
      const pageSize = 50;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const rows = await database.prepare(`SELECT ${playlistTrackId} AS id, songs.name, songs.metadata ${playlistTracks}
        ORDER BY membership.position, membership.job_id, membership.name LIMIT $4 OFFSET $5`)
        .all(...parameters, pageSize, (page - 1) * pageSize);
      return res.json({ title: playlist.title, page, pageSize, total, totalPages, tracks: rows.map((row) => {
        const metadata = JSON.parse(row.metadata);
        const url = `/api/public/playlists/${req.params.token}/tracks/${row.id}`;
        return { id: row.id, name: path.basename(row.name), title: metadata.title || null,
          artist: metadata.artist || null, album: metadata.album || null,
          metadataUrl: url, streamUrl: `${url}/stream`, downloadUrl: `${url}/download` };
      }) });
    } catch { return res.status(404).json({ error: 'Shared playlist not found' }); }
  });
  const sources = [
    { route: '/media/:token', resolve: (req) => resolveShare(req.params.token), url: (req) => `/api/public/media/${req.params.token}` },
    { route: '/playlists/:token/tracks/:trackId', resolve: resolvePlaylistSong,
      url: (req) => `/api/public/playlists/${req.params.token}/tracks/${req.params.trackId}` }
  ];
  for (const source of sources) {
    router.get(source.route, async (req, res) => {
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
        const song = await source.resolve(req);
        const metadata = await readSongMetadata(song.filePath, { bounded: true });
        const url = source.url(req);
        res.json({
          ...Object.fromEntries(metadataFields.map((field) => [field, metadata[field]])),
          name: song.name, sizeBytes: song.sizeBytes, streamUrl: `${url}/stream`, downloadUrl: `${url}/download`
        });
      } catch { notFound(req, res); }
      finally {
        extractionDone = true;
        release();
      }
    });
    for (const action of ['stream', 'download']) {
      router.get(`${source.route}/${action}`, async (req, res) => {
        try {
          const song = await source.resolve(req);
          const options = { cacheControl: false, lastModified: false };
          if (action === 'download') {
            res.download(song.filePath, song.name, options, (error) => sendError(res, error));
          } else {
            res.sendFile(song.filePath, options, (error) => sendError(res, error));
          }
        } catch { notFound(req, res); }
      });
    }
  }
  router.use(notFound);
  router.use((_error, req, res, _next) => notFound(req, res));
  return router;
}
