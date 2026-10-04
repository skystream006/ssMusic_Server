import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZipArchive } from 'archiver';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createJob, deleteJob, deleteJobFile, getAvailableContributors, getFilePath, getJob, getJobs, isFileInsideJobFolder, isValidJobFileName, rerunJob, setJobContributors, setJobTitle, setSongMetadata, transcribeJobFile } from './jobManager.js';
import { isSongFile } from './transcription.js';
import { isPlayableFile, mediaType } from './media.js';
import { readSongMetadata, readSongSummary } from './music.js';
import { readSongThumbnail } from './artworkThumbnails.js';
import { createThumbnailMaintenance, thumbnailSongs } from './thumbnailMaintenance.js';
import { findNoVocals, individualPlaylistId, orderFiles, songKey } from './library.js';
import { addLibraryJobFiles, getLibrary, getPreferences, linkLibraryJob, moveLibrarySong, moveLibraryPlaylists, mutateLibraryEntry, reorderLibrarySong, setLibrary, setTheme, transferLibrarySongs } from './libraryStore.js';
import { createLibraryBackupService } from './libraryBackup.js';
import { getImportProgress, handleLibraryImport, listLocalImportFiles } from './libraryImport.js';
import { createReplaceFileHandler } from './replaceFile.js';
import { countMediaFiles, createMediaCountMonitor, getSystemHealth } from './health.js';
import { isYouTubeUrl } from './utils.js';
import { scheduleDailyMaintenance, scheduleLibraryBackups } from './scheduler.js';
import { attachUser, registerAuthRoutes, requireAdmin, requireAuth } from './auth.js';
import { restrictSharedAccess, sharedLibraryUsers, libraryReaderId, canReadSharedSong, sharedJobSummary } from './sharedAccess.js';
import { loadHttpsOptions } from './tls.js';
import { openDatabase } from './database.js';
import { pagePostgresTracks, postgresPageJobs, readPostgresLibrary } from './postgresCatalog.js';
import { adminMediaSharesRouter, createMediaShare, mediaShareHeaders, publicMediaRouter } from './mediaShares.js';

const app = express();
if (process.env.TRUST_PROXY) {
  const trustProxy = /^\d+$/.test(process.env.TRUST_PROXY)
    ? Number(process.env.TRUST_PROXY)
    : process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy);
}
const { values: options, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    'http-port': { type: 'string' },
    'https-port': { type: 'string' }
  },
  allowPositionals: true
});
const httpPort = Number(options['http-port'] || options.port || positionals[0] || process.env.WEB_API_PORT || process.env.PORT || 3000);
const httpsPort = Number(options['https-port'] || process.env.HTTPS_WEB_PORT || 4000);

if (![httpPort, httpsPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
  throw new Error('HTTP and HTTPS ports must be integers between 1 and 65535');
}
if (httpPort === httpsPort) {
  throw new Error('WEB_API_PORT and HTTPS_WEB_PORT must use different ports');
}

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});
const artworkLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

function authLimiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many passkey requests. Please wait before trying again.' }
  });
}

const authLimiters = {
  registrationOptions: authLimiter(60 * 60_000, 5),
  registrationVerify: authLimiter(60 * 60_000, 10),
  loginOptions: authLimiter(10 * 60_000, 20),
  loginVerify: authLimiter(10 * 60_000, 20)
};

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(['/api/public', '/share'], mediaShareHeaders);
app.use('/api', (req, res, next) => {
  const artwork = ['GET', 'HEAD'].includes(req.method) && /^\/jobs\/[^/]+\/artwork\/[^/]+\/?$/i.test(req.path);
  return (artwork ? artworkLimiter : apiLimiter)(req, res, next);
});
app.use('/api/public', publicMediaRouter());
app.get('/share/:token', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'), { cacheControl: false });
});
app.use('/api/jobs/:id/files/:name/metadata', express.json({ limit: '3mb' }));
app.use(['/api/library/playlists/move', '/api/library/songs/transfer'], express.json({ limit: '3mb' }));
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.resolve(process.cwd(), 'public')));
app.use(attachUser);
app.use(restrictSharedAccess);
registerAuthRoutes(app, authLimiters);
app.use('/api/admin/media-shares', requireAdmin, mediaShareHeaders, adminMediaSharesRouter());
app.use(['/api/jobs', '/api/library', '/api/preferences'], requireAuth, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/health', requireAuth);

const thumbnailMaintenance = createThumbnailMaintenance({
  songs: () => thumbnailSongs(openDatabase()),
  async resolveFile(song) {
    if (!song.output_dir || !isValidJobFileName(song.name)) throw new Error('Invalid thumbnail source');
    const outputDir = await fs.realpath(song.output_dir);
    const filePath = await fs.realpath(path.join(outputDir, song.name));
    if (!isFileInsideJobFolder({ outputDir }, filePath)) throw new Error('Invalid thumbnail source');
    return filePath;
  }
});
app.use('/api/admin/artwork-thumbnails', requireAdmin, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/api/admin/artwork-thumbnails', (_req, res) => res.json(thumbnailMaintenance.status()));
app.post('/api/admin/artwork-thumbnails', (_req, res) => {
  try { return res.status(202).json(thumbnailMaintenance.start()); }
  catch (error) { return res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.get('/api/preferences', async (req, res) => {
  res.json((await getPreferences(req.user.id)));
});

app.put('/api/preferences', async (req, res) => {
  try {
    return res.json((await setTheme(req.user.id, req.body?.theme, req.body?.mode)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

async function getLibraryJobs(user) {
  return (await getJobs(user.id)).filter((job) => job.initiatedBy?.id === user.id
    || job.contributors?.some((contributor) => contributor.id === user.id));
}

const libraryBackups = (await createLibraryBackupService({ async loadLibrary(userId) {
  const jobs = (await getLibraryJobs({ id: userId }));
  return { library: (await getLibrary(userId, jobs)), jobs };
} }));

app.get('/api/library/shared-users', async (req, res) => {
  res.json({ users: req.user.role === 'shared' ? await sharedLibraryUsers(req.user.id) : [] });
});

app.get('/api/library', async (req, res) => {
  try {
    const ownerId = await libraryReaderId(req.user, req.query.userId);
    const library = await readPostgresLibrary(openDatabase(), ownerId);
    if (req.user.role === 'shared') {
      library.jobs = library.jobs.map(sharedJobSummary);
      library.playlists = library.playlists.map(({ initiatedBy, contributors, ...playlist }) => playlist);
    }
    res.json({ ...library, ownerId });
  } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.put('/api/library', async (req, res) => {
  try {
    return res.json((await setLibrary(req.user.id, req.body, (await getLibraryJobs(req.user)))));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/entries', async (req, res) => {
  try {
    return res.json((await mutateLibraryEntry(req.user.id, req.body, (await getLibraryJobs(req.user)))));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/library/backup', async (req, res) => {
  res.json((await libraryBackups.getStatus(req.user.id)));
});

app.put('/api/library/backup/schedule', async (req, res) => {
  try {
    res.json((await libraryBackups.saveSchedule(req.user.id, req.body)));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to save backup schedule.' });
  }
});

app.post('/api/library/backup', async (req, res) => {
  try {
    void libraryBackups.start(req.user.id, req.body).catch((error) => console.error('Library backup failed:', error.message));
    res.status(202).json((await libraryBackups.getStatus(req.user.id)));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to start library backup.' });
  }
});

app.get('/api/library/export', async (req, res) => {
  let download;
  try {
    const source = req.query.source || 'new';
    if (!['latest', 'new'].includes(source)) return res.status(400).json({ error: 'Choose the latest backup or a new export.' });
    if (source === 'new') await libraryBackups.start(req.user.id, req.query);
    if (res.destroyed) return;
    download = await libraryBackups.openLatest(req.user.id);
    res.attachment(`ssMusic-${download.latest.format}.zip`);
    res.type('application/zip');
    res.set('Content-Length', String(download.latest.sizeBytes));
    await pipeline(download.handle.createReadStream(), res);
  } catch (error) {
    if (res.destroyed || res.headersSent) return;
    res.removeHeader('Content-Disposition');
    res.removeHeader('Content-Length');
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to export library.' });
  } finally { await download?.release(); }
});

app.post('/api/library/links', async (req, res) => {
  try {
    if (typeof req.body?.jobId !== 'string') return res.status(400).json({ error: 'A job ID is required' });
    const job = (await getJob(req.body.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const jobs = (await getLibraryJobs(req.user));
    if (!jobs.some((item) => item.id === job.id)) return res.status(403).json({ error: 'Only job owners and contributors can add this playlist' });
    const library = (await linkLibraryJob(req.user.id, job, jobs));
    return res.json({ ...library, selectedId: job.isPlaylist === false ? individualPlaylistId(job) : job.id });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/jobs/add', async (req, res) => {
  try {
    if (typeof req.body?.jobId !== 'string') return res.status(400).json({ error: 'A job ID is required' });
    const job = (await getJob(req.body.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const jobs = (await getLibraryJobs(req.user));
    if (!jobs.some((item) => item.id === job.id)) return res.status(403).json({ error: 'Only job owners and contributors can add these files' });
    return res.json((await addLibraryJobFiles(req.user.id, req.body, jobs)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/songs/move', async (req, res) => {
  try {
    return res.json((await moveLibrarySong(req.user.id, req.body, (await getLibraryJobs(req.user)))));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/songs/reorder', async (req, res) => {
  try {
    return res.json((await reorderLibrarySong(req.user.id, req.body, (await getLibraryJobs(req.user)))));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/library/tracks', async (req, res) => {
  try {
    const selectedId = req.query.entryId ?? null;
    if (selectedId !== null && typeof selectedId !== 'string') return res.status(400).json({ error: 'Invalid library selection' });
    const paginated = selectedId === null || req.query.page !== undefined || req.query.pageSize !== undefined;
    const positiveInteger = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
    if ((req.query.page !== undefined && !positiveInteger(req.query.page))
      || (req.query.pageSize !== undefined && (!positiveInteger(req.query.pageSize) || Number(req.query.pageSize) > 100))
      || (req.query.search !== undefined && (typeof req.query.search !== 'string' || req.query.search.length > 200))) {
      return res.status(400).json({ error: 'Invalid track pagination or search' });
    }
    const search = (req.query.search || '').trim().toLowerCase();
    const ownerId = await libraryReaderId(req.user, req.query.userId);
    const result = await pagePostgresTracks(openDatabase(), ownerId, { entryId: selectedId,
      page: Number(req.query.page || 1), pageSize: paginated ? Number(req.query.pageSize || 50) : null, search });
    const pageJobs = await postgresPageJobs(openDatabase(), result.files);
    const available = new Map((await Promise.all([...pageJobs.values()].map(async (job) =>
      (await listJobFiles(job)).map((file) => [songKey({ jobId: job.id, name: file.name }), file])))).flat());
    result.files = result.files.filter((track) => available.has(songKey(track))).map((track) => ({ ...track, ...available.get(songKey(track)) }));
    if (req.user.role === 'shared') {
      result.files = await Promise.all(result.files.map(async ({ noVocalsName, noVocalsVersion, ...track }) => ({
        ...track, sourceJob: sharedJobSummary(track.sourceJob),
        ...(noVocalsVersion && await canReadSharedSong(req.user.id, noVocalsVersion.jobId, noVocalsVersion.name) ? { noVocalsVersion } : {})
      })));
    }
    return res.json(paginated ? result : { files: result.files, version: result.version });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/playlists/move', async (req, res) => {
  try { res.json((await moveLibraryPlaylists(req.user.id, req.body, (await getLibraryJobs(req.user))))); }
  catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/library/songs/transfer', async (req, res) => {
  try { res.json((await transferLibrarySongs(req.user.id, req.body, (await getLibraryJobs(req.user))))); }
  catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/library/songs/remove', async (req, res) => {
  try {
    if (typeof req.body?.jobId !== 'string' || typeof req.body?.name !== 'string'
      || typeof req.body?.playlistId !== 'string') return res.status(400).json({ error: 'Invalid song membership' });
    const result = await deleteJobFile(req.body.jobId, req.body.name, req.user, req.body);
    if (!result) return res.status(404).json({ error: 'Job not found' });
    return res.json({ ...(await getLibrary(req.user.id, (await getLibraryJobs(req.user)))), fileDeleted: result.fileDeleted });
  } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/jobs/import', handleLibraryImport);

app.get('/api/jobs/import/logs/:importId', (req, res) => {
  const progress = getImportProgress(req.user.id, req.params.importId);
  if (!progress) return res.status(404).json({ error: 'Import log is no longer available' });
  res.json(progress);
});

app.get('/api/jobs/import/local', async (_req, res) => {
  try { res.json(await listLocalImportFiles()); }
  catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to list local import files' }); }
});

app.get('/api/jobs', async (req, res) => {
  const jobs = (await getJobs());
  const library = (await getLibrary(req.user.id, jobs));
  res.json(jobs.map((job) => ({ ...job, files: orderFiles(job.files || [], library.songOrder[job.id]) })));
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = (await getJob(req.params.id));
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  const library = (await getLibrary(req.user.id, [job]));
  return res.json({ ...job, files: orderFiles(job.files || [], library.songOrder[job.id]) });
});

app.patch('/api/jobs/:id/title', async (req, res) => {
  try {
    const job = await setJobTitle(req.params.id, req.body?.playlistTitle, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/files', async (req, res) => {
  const job = (await getJob(req.params.id));
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    const library = (await getLibrary(req.user.id, [job]));
    return res.json({ jobId: job.id, files: await listJobFiles(job, library.songOrder[job.id]) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

async function listJobFiles(job, order, names) {
  if (!job.outputDir) return [];
  const outputDir = await fs.realpath(job.outputDir).catch(() => null);
  if (!outputDir) return [];
  const files = [];
  let selectedNames = job.files || [];
  if (names) {
    const available = (job.files || []).map((name) => ({ name, jobId: job.id }));
    const required = new Set(names);
    for (const name of names) {
      const version = findNoVocals({ name, jobId: job.id, noVocalsName: job.transcriptions?.[name]?.noVocalsName }, available);
      if (version) required.add(version.name);
    }
    selectedNames = [...required];
  }
  for (const fileName of orderFiles(selectedNames, order)) {
    if (!isValidJobFileName(fileName)) continue;
    const absoluteFilePath = getFilePath(job, fileName);
    const stat = await fs.stat(absoluteFilePath).catch(() => null);
    if (stat?.isFile()) {
      const realPath = await fs.realpath(absoluteFilePath).catch(() => null);
      if (!realPath || !isFileInsideJobFolder({ outputDir }, realPath)) continue;
      const metadata = await readSongSummary(realPath, stat).catch(() => ({}));
      files.push({
        ...job.songMetadata?.[fileName],
        ...metadata,
        name: fileName,
        noVocalsName: job.transcriptions?.[fileName]?.noVocalsName,
        sizeBytes: stat.size,
        downloadUrl: `/api/jobs/${job.id}/download/${encodeURIComponent(fileName)}`,
        artworkUrl: /\.mp3$/i.test(fileName) ? `/api/jobs/${job.id}/artwork/${encodeURIComponent(fileName)}?v=${stat.mtimeMs}` : null,
        isSong: isSongFile(fileName),
        isPlayable: isPlayableFile(fileName),
        mediaType: mediaType(fileName),
        streamUrl: isPlayableFile(fileName) ? `/api/jobs/${job.id}/stream/${encodeURIComponent(fileName)}?v=${stat.mtimeMs}` : null
      });
    }
  }

  return files.map((file) => {
    const version = findNoVocals(file, files);
    return version ? { ...file, noVocalsVersion: { ...version, jobId: job.id, playlistTitle: job.playlistTitle } } : file;
  });
}

async function resolveRequestedFile(req, acceptsFile = null) {
  if (req.user.role === 'shared' && !await canReadSharedSong(req.user.id, req.params.id, req.params.name)) {
    throw Object.assign(new Error('Library song access denied'), { statusCode: 403 });
  }
  const job = (await getJob(req.params.id));
  if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  const name = req.params.name;
  if (!isValidJobFileName(name) || (acceptsFile && !acceptsFile(name))) {
    throw Object.assign(new Error('Invalid file path'), { statusCode: 400 });
  }
  if (!job.outputDir || !job.files.includes(name)) {
    throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  }
  const filePath = getFilePath(job, name);
  const realPath = await fs.realpath(filePath).catch(() => null);
  if (!realPath || !(await fs.stat(realPath)).isFile()) {
    throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  }
  if (!isFileInsideJobFolder({ outputDir: await fs.realpath(job.outputDir) }, realPath)) {
    throw Object.assign(new Error('Invalid file path'), { statusCode: 400 });
  }
  return filePath;
}

app.get('/api/jobs/:id/download/:name', async (req, res) => {
  try {
    const filePath = await resolveRequestedFile(req);
    return res.download(filePath, path.basename(req.params.name));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/stream/:name', async (req, res) => {
  try {
    const filePath = await resolveRequestedFile(req, isPlayableFile);
    res.set('Cache-Control', 'private, no-cache');
    if (/\.m4v$/i.test(filePath)) res.type('video/mp4');
    return res.sendFile(filePath);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/artwork/:name', async (req, res) => {
  res.set('Cache-Control', 'private, no-cache');
  try {
    const filePath = await resolveRequestedFile(req, isSongFile);
    const artwork = await readSongThumbnail(filePath);
    if (!artwork) return res.status(404).end();
    return res.type('image/webp').send(artwork);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/lyrics/:name', async (req, res) => {
  try {
    const filePath = await resolveRequestedFile(req, isSongFile);
    const job = await getJob(req.params.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ ...await readSongMetadata(filePath),
      transcriptionLocked: Boolean(job.songMetadata?.[req.params.name]?.transcriptionLocked),
      canEdit: Boolean(req.user.role !== 'shared' && /\.mp3$/i.test(req.params.name)
        && (req.user.role === 'admin' || req.user.id === job.initiatedBy?.id || job.contributors?.some((user) => user.id === req.user.id))
        && !['queued', 'running'].includes(job.status) && job.transcriptions?.[req.params.name]?.status !== 'sent') });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.patch('/api/jobs/:id/files/:name/metadata', async (req, res) => {
  try {
    const metadata = await setSongMetadata(req.params.id, req.params.name, req.body, req.user);
    if (!metadata) return res.status(404).json({ error: 'Job not found' });
    return res.json(metadata);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/files/:name/replace', createReplaceFileHandler(listJobFiles));

app.post('/api/jobs/:id/files/:name/share', createMediaShare);

app.post('/api/jobs/:id/files/:name/transcribe', async (req, res) => {
  try {
    const job = await transcribeJobFile(req.params.id, req.params.name, req.body || {}, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/download-all', async (req, res) => {
  const job = (await getJob(req.params.id));
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const files = [];
  for (const fileName of job.files) {
    const filePath = getFilePath(job, fileName);
    if (!isFileInsideJobFolder(job, filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) files.push({ fileName, filePath });
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'Job has no downloadable files' });
  }

  const archiveName = `${String(job.playlistTitle || job.id).replace(/[^a-z0-9._-]+/gi, '_')}.zip`;
  res.attachment(archiveName);
  res.type('application/zip');

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('warning', (error) => console.warn('Archive warning:', error.message));
  const handleArchiveError = (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  };
  archive.on('error', handleArchiveError);
  archive.pipe(res);
  for (const file of files) {
    archive.file(file.filePath, { name: file.fileName });
  }
  void archive.finalize().catch(handleArchiveError);
});

app.post('/api/jobs', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({
      error: 'Please provide a valid YouTube or YouTube Music URL'
    });
  }

  try {
    const job = await createJob(url, req.user, { metadataOnly: req.body?.metadataOnly, downloadType: req.body?.downloadType });
    (await linkLibraryJob(req.user.id, job, (await getLibraryJobs(req.user))));
    return res.status(202).json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message,
      code: error.code,
      existingJob: error.existingJob
    });
  }
});

app.get('/api/jobs/:id/contributors/users', async (req, res) => {
  try {
    const users = (await getAvailableContributors(req.params.id, req.user));
    if (!users) return res.status(404).json({ error: 'Job not found' });
    return res.json({ users });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.put('/api/jobs/:id/contributors', async (req, res) => {
  try {
    const job = await setJobContributors(req.params.id, req.body?.userIds, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/rerun', async (req, res) => {
  try {
    const job = await rerunJob(req.params.id, req.user);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.status(202).json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/api/jobs/:id/files/:name', async (req, res) => {
  try {
    const job = await deleteJobFile(req.params.id, req.params.name, req.user);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    const deleted = await deleteJob(req.params.id, req.user);
    if (!deleted) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.status(204).end();
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

const mediaCount = createMediaCountMonitor(async () => countMediaFiles((await getJobs())));

app.get('/api/health', async (_req, res) => {
  try {
    const data = await getSystemHealth();
    res.set('Cache-Control', 'no-store');
    return res.json({ ...data, media: (await mediaCount.getStatus()) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get('/app-login', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get(['/admin', '/admin/shared-links', '/admin/users/:id', '/settings'], (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get(['/job', '/job/:id', '/job/:id/player'], (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Request body must contain valid JSON' });
  }
  return next(error);
});

const httpsOrigin = process.env.PASSKEY_ORIGIN || `https://localhost:${httpsPort}`;
const httpsOptions = await loadHttpsOptions();

function protectServer(server) {
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = Number(process.env.MAX_CONNECTIONS || 500);
  return server;
}

protectServer(http.createServer((req, res) => {
  const location = new URL(req.url || '/', httpsOrigin);
  res.writeHead(308, { Location: location.toString() });
  res.end();
})).listen(httpPort, () => {
  console.log(`ssYTDLP HTTP redirect listening on http://localhost:${httpPort}`);
});

protectServer(https.createServer(httpsOptions, app)).listen(httpsPort, () => {
  console.log(`ssYTDLP HTTPS server listening on https://localhost:${httpsPort}`);
});

scheduleDailyMaintenance(3, 0);
scheduleLibraryBackups(libraryBackups);
