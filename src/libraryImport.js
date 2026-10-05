import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import multer from 'multer';
import * as plist from 'plist';
import yauzl from 'yauzl';
import { fileTypeFromFile } from 'file-type';
import { deleteJob, getJobs, importJobFiles } from './jobManager.js';
import { getLibrary, linkLibraryJob, setLibrary } from './libraryStore.js';
import { individualPlaylistNames, individualVideosId, songKey } from './library.js';
import { isSongFile } from './transcription.js';
import { isPlayableFile, mediaType } from './media.js';

const maxUploadBytes = 2 * 1024 ** 3;
const maxAudioBytes = 512 * 1024 ** 2;
const maxXmlBytes = 20 * 1024 ** 2;
const maxExpandedBytes = 4 * 1024 ** 3;
const activeImports = new Set();
const activeLocalFiles = new Set();
const importProgress = new Map();
const importLogLifetime = 60 * 60 * 1000;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const libraryJobs = async (user) => (await getJobs(user.id)).filter((job) => job.initiatedBy?.id === user.id
  || job.contributors?.some((contributor) => contributor.id === user.id));

const importStorageRoot = () => path.resolve(process.env.IMPORT_STORAGE_ROOT || path.join(process.cwd(), 'import-storage'));

async function archiveLocalImportFiles(files) {
  const destination = path.resolve(process.env.IMPORT_STORAGE_COMPLETED_ROOT || path.join(importStorageRoot(), '..', 'import-storage-completed'));
  await fs.mkdir(destination, { recursive: true });
  if (await fs.realpath(destination) === await fs.realpath(importStorageRoot())) throw failure('Completed import storage must be a separate folder');
  const copied = [];
  const removed = [];
  try {
    for (const file of files) {
      let target = path.join(destination, file.name);
      try { await fs.copyFile(file.path, target, fs.constants.COPYFILE_EXCL); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const extension = path.extname(file.name);
        target = path.join(destination, `${path.basename(file.name, extension)}-${randomUUID()}${extension}`);
        await fs.copyFile(file.path, target, fs.constants.COPYFILE_EXCL);
      }
      copied.push({ source: file.path, target });
    }
    for (const file of copied) {
      await fs.unlink(file.source);
      removed.push(file);
    }
  } catch (error) {
    for (const file of removed) await fs.copyFile(file.target, file.source, fs.constants.COPYFILE_EXCL);
    for (const file of copied) await fs.rm(file.target, { force: true });
    throw error;
  }
}

export function getImportProgress(userId, importId) {
  const progress = importProgress.get(userId);
  if (!progress || progress.importId !== importId) return null;
  if (progress.finishedAt && Date.now() - progress.finishedAt > importLogLifetime) {
    importProgress.delete(userId);
    return null;
  }
  return progress;
}

export async function resolveLocalImportFile(name, extension) {
  if (typeof name !== 'string' || !name || /[\\/:\x00-\x1f\x7f]/.test(name)
    || name === '.' || name === '..' || path.extname(name).toLowerCase() !== extension) {
    throw failure(`Select a ${extension} file from local storage`);
  }
  try {
    const root = await fs.realpath(importStorageRoot());
    const candidate = path.join(root, name);
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(await fs.realpath(candidate)) !== root) {
      throw failure('Local import files must be regular files inside the storage folder');
    }
    return { path: candidate, name, size: stat.size };
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('Local import file is no longer available. Refresh the file list.', 404);
    if (error.code === 'EACCES' || error.code === 'EPERM') throw failure('The local import file is not readable by the server', 403);
    throw error;
  }
}

export async function listLocalImportFiles() {
  const result = { xmlFiles: [], zipFiles: [] };
  let entries;
  try { entries = await fs.readdir(importStorageRoot(), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return result;
    throw failure('Unable to read the local import storage folder. Check its mount and permissions.', 503);
  }
  for (const entry of entries) {
    const extension = path.extname(entry.name).toLowerCase();
    if (!entry.isFile() || !['.xml', '.zip'].includes(extension)) continue;
    try {
      const file = await resolveLocalImportFile(entry.name, extension);
      result[extension === '.xml' ? 'xmlFiles' : 'zipFiles'].push({ name: file.name, size: file.size });
    } catch (error) {
      if (![400, 404].includes(error.statusCode)) throw error;
    }
  }
  for (const files of Object.values(result)) files.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

export function createImportUploadCounter(req, fieldname) {
  let size = 0;
  const limit = fieldname === 'xml' ? maxXmlBytes : fieldname === 'media' ? maxUploadBytes : maxAudioBytes;
  return new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    req.importBytes += chunk.length;
    done(size > limit || req.importBytes > maxUploadBytes ? failure('Import upload exceeds the size limit', 413) : null, chunk);
  } });
}

const upload = multer({
  storage: {
    _handleFile(req, file, callback) {
      const filePath = path.join(req.importDirectory, randomUUID());
      pipeline(file.stream, createImportUploadCounter(req, file.fieldname), createWriteStream(filePath, { flags: 'wx' }))
        .then(async () => callback(null, { path: filePath, size: (await fs.stat(filePath)).size }))
        .catch(callback);
    },
    _removeFile(_req, file, callback) { fs.rm(file.path, { force: true }).then(() => callback(null), callback); }
  },
  limits: { files: 1000, fields: 4, parts: 1004, fieldSize: 1024, fileSize: maxUploadBytes }
}).fields([{ name: 'files', maxCount: 1000 }, { name: 'xml', maxCount: 1 }, { name: 'media', maxCount: 1 }]);

function ffmpegExecutable(name) {
  const location = process.env.FFMPEG_PATH || path.resolve(process.cwd(), 'runtime', 'ffmpeg', 'bin');
  const directory = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  return path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
}

async function probeImportAudio(file, extension, requireFrames = false) {
  const formats = { '.mp3': 'mp3', '.mp2': 'mp3', '.wav': 'wav', '.flac': 'flac', '.m4a': 'mp4',
    '.aac': 'aac', '.ogg': 'ogg', '.opus': 'ogg', '.wma': 'asf' };
  const codecs = { '.mp3': 'mp3', '.mp2': 'mp2', '.flac': 'flac', '.aac': 'aac', '.opus': 'opus' };
  try {
    const stdout = await new Promise((resolve, reject) => {
      childProcess.execFile(ffmpegExecutable('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'mp3,wav,flac,mov,aac,ogg,asf', '-probesize', '1048576', '-analyzeduration', '5000000',
        ...(requireFrames ? ['-read_intervals', '%+#64', '-show_frames'] : []),
        '-show_entries', `format=format_name:stream=codec_type,codec_name,sample_rate,channels${requireFrames ? ',index' : ''}:stream_disposition=attached_pic${requireFrames ? ':frame=media_type,stream_index,nb_samples' : ''}`,
        '-of', 'json', path.resolve(file.path)], { timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, output) => error ? reject(error) : resolve(output));
    });
    const metadata = JSON.parse(stdout);
    return metadata.format?.format_name?.split(',').includes(formats[extension])
      && Array.isArray(metadata.streams)
      && metadata.streams.some((stream) => stream.codec_type === 'audio' && Number(stream.sample_rate) > 0
        && stream.channels > 0 && (!codecs[extension] || stream.codec_name === codecs[extension])
        && (!requireFrames || (Array.isArray(metadata.frames) && metadata.frames.some((frame) => frame.media_type === 'audio'
          && frame.stream_index === stream.index && Number(frame.nb_samples) > 0))))
      && !metadata.streams.some((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      throw failure(`Cannot validate audio: ${file.name}. ffprobe is unavailable. Install FFmpeg or check FFMPEG_PATH.`);
    }
    return false;
  }
}

export async function validateImportAudio(file, { local = false, requireProbe = false } = {}) {
  const extension = path.extname(file.name).toLowerCase();
  if (!isSongFile(file.name)) throw failure(`Unsupported audio file: ${file.name}`);
  const { size } = await fs.stat(file.path);
  if (!size) throw failure(`Empty audio file: ${file.name}`);
  if (!local && size > maxAudioBytes) throw failure(`Audio file exceeds the 512 MB limit: ${file.name}`, 413);
  const type = await fileTypeFromFile(file.path).catch(() => null);
  const expected = { '.m4a': ['m4a', 'mp4'], '.wma': ['asf'], '.opus': ['opus', 'ogg'] }[extension] || [extension.slice(1)];
  const mismatched = type && !expected.includes(type.ext);
  if (mismatched || ((!type || requireProbe) && !await probeImportAudio(file, extension, requireProbe))) {
    const reason = mismatched ? `detected ${type.ext.toUpperCase()}, expected ${extension.slice(1).toUpperCase()}`
      : `ffprobe could not confirm ${extension.slice(1).toUpperCase()} audio`;
    throw failure(`Invalid or mismatched audio: ${file.name} (${reason}). Re-export or convert the original file; changing its extension is not enough.`);
  }
  return { ...file, size };
}

export async function validateImportMedia(file, { local = false } = {}) {
  if (mediaType(file.name) !== 'video') return validateImportAudio(file, { local });
  const extension = path.extname(file.name).toLowerCase();
  const type = await fileTypeFromFile(file.path).catch(() => null);
  const expected = { '.mp4': ['mp4'], '.m4v': ['mp4', 'm4v'], '.webm': ['webm'], '.mov': ['mov'], '.ogv': ['ogv'] }[extension];
  if (!type || !expected.includes(type.ext)) throw failure(`Invalid or mismatched video: ${file.name}`);
  const { size } = await fs.stat(file.path);
  if (!size) throw failure(`Empty video file: ${file.name}`);
  if (!local && size > maxAudioBytes) throw failure(`Video file exceeds the 512 MB limit: ${file.name}`, 413);
  return { ...file, size };
}

async function convertItunesWav(file, { local, report }) {
  const output = { name: `${path.posix.parse(file.name).name}.mp3`, path: path.join(path.dirname(file.path), randomUUID()) };
  report('convert', 'Converting WAV to MP3', { file: file.name, output: output.name });
  try {
    await new Promise((resolve, reject) => {
      childProcess.execFile(ffmpegExecutable('ffmpeg'), ['-nostdin', '-v', 'error', '-n',
        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav', '-f', 'wav', '-i', path.resolve(file.path),
        '-map', '0:a:0', '-map_metadata', '0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-ac', '2', '-f', 'mp3', output.path],
      { timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024, windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    const converted = await validateImportAudio(output, { local });
    report('convert', 'WAV converted to MP3', { file: file.name, output: converted.name, bytes: converted.size });
    return converted;
  } catch (error) {
    await fs.rm(output.path, { force: true });
    if (error.statusCode) throw error;
    const reason = error.code === 'ENOENT' || error.code === 'EACCES' ? 'FFmpeg is unavailable; check FFMPEG_PATH'
      : error.killed ? 'conversion timed out' : 'FFmpeg could not encode this WAV file';
    throw failure(`Unable to convert WAV to MP3: ${file.name} (${reason})`);
  }
}

export async function extractImportMedia(zipPath, directory, { local = false, report = () => {} } = {}) {
  report('extract', 'Opening media ZIP');
  const archive = await new Promise((resolve, reject) => yauzl.open(zipPath,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(failure('Invalid media ZIP')) : resolve(zip)));
  return new Promise((resolve, reject) => {
    const files = [];
    let count = 0;
    let total = 0;
    let currentEntry;
    const fail = (error) => {
      report('extract', 'Media ZIP extraction failed', { entry: currentEntry, entries: count, files: files.length, error: error.message }, 'error');
      archive.close();
      reject(error.statusCode ? error : failure('Invalid or damaged media ZIP'));
    };
    archive.on('error', fail);
    archive.on('end', () => {
      report('extract', 'Media ZIP extracted', { entries: count, files: files.length, bytes: total, skipped: count - files.length });
      resolve(files);
    });
    archive.on('entry', (entry) => {
      void (async () => {
        currentEntry = entry.fileName;
        count += 1;
        if (!local && count > 10000) throw failure('The ZIP contains too many entries', 413);
        if (entry.fileName.length > 2048 || entry.fileName.split('/').length > 32
          || entry.fileName.split('/').some((part) => part === '..') || /^[\\/]|^[a-z]:/i.test(entry.fileName)
          || /[\\\x00]/.test(entry.fileName) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          || entry.isEncrypted()) throw failure('The ZIP contains an unsafe or encrypted entry');
        if (!entry.fileName.endsWith('/') && !entry.fileName.startsWith('__MACOSX/') && isPlayableFile(entry.fileName)) {
          total += entry.uncompressedSize;
          if (!local && (files.length >= 2000 || entry.uncompressedSize > maxAudioBytes || total > maxExpandedBytes)) {
            throw failure('The media ZIP exceeds the import limits', 413);
          }
          const filePath = path.join(directory, randomUUID());
          const stream = await new Promise((done, failStream) => archive.openReadStream(entry, (error, value) => error ? failStream(error) : done(value)));
          await pipeline(stream, createWriteStream(filePath, { flags: 'wx' }));
          const type = await fileTypeFromFile(filePath).catch(() => null);
          if (type?.ext === 'wav') {
            const audio = await validateImportAudio({ name: `${entry.fileName}.wav`, path: filePath }, { local });
            files.push({ ...audio, name: entry.fileName, convertFromWav: true });
          } else if (path.posix.extname(entry.fileName).toLowerCase() === '.mp3'
            && (type?.ext === 'mp2' || (!type && await probeImportAudio({ path: filePath, name: entry.fileName }, '.mp2', true)))) {
            const importName = entry.fileName.replace(/\.mp3$/i, '.mp2');
            const audio = await validateImportAudio({ name: importName, path: filePath }, { local, requireProbe: true });
            files.push({ ...audio, name: entry.fileName, importName });
            report('extract', 'Corrected MP2 audio with an MP3 filename', { entry: entry.fileName, matched: importName });
          } else {
            files.push(await validateImportMedia({ name: entry.fileName, path: filePath }, { local }));
          }
        }
        if (count === 1 || count % 100 === 0) {
          report('extract', 'Extracting media ZIP', { entries: count, files: files.length, bytes: total, entry: entry.fileName });
        }
        archive.readEntry();
      })().catch(fail);
    });
    archive.readEntry();
  });
}

export function parseItunesImport(xml, media, { local = false, report = () => {} } = {}) {
  report('parse', 'Reading iTunes library XML', { bytes: Buffer.byteLength(xml), mediaFiles: media.length });
  if (!local && Buffer.byteLength(xml) > maxXmlBytes) throw failure('The XML exceeds the 20 MB limit', 413);
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml)) throw failure('XML entity declarations are not supported');
  let library;
  try { library = plist.parse(xml); } catch { throw failure('Invalid iTunes library XML'); }
  if (!library?.Tracks || typeof library.Tracks !== 'object' || Array.isArray(library.Tracks)
    || (library.Playlists !== undefined && !Array.isArray(library.Playlists))) throw failure('Select an iTunes library XML export');
  report('match', 'Matching library tracks to media', { tracks: Object.keys(library.Tracks).length, playlists: library.Playlists?.length || 0 });
  const suffixes = new Map();
  for (const file of media) {
    const parts = file.name.normalize('NFC').toLowerCase().split('/');
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('/');
      suffixes.set(suffix, suffixes.has(suffix) ? null : file);
    }
  }
  const tracks = new Map();
  let skipped = 0;
  for (const [key, track] of Object.entries(library.Tracks)) {
    if (track?.['Track Type'] === 'URL') { skipped += 1; continue; }
    if (!local && tracks.size >= 2000) throw failure('The library contains too many tracks', 413);
    let location;
    try {
      if (typeof track.Location !== 'string' || track.Location.length > 4096) throw new Error();
      const url = new URL(track.Location);
      if (url.protocol !== 'file:') throw new Error();
      location = decodeURIComponent(url.pathname).replaceAll('\\', '/').normalize('NFC').toLowerCase();
    } catch {
      report('match', 'Track has no valid local media location', { trackId: key, track: track?.Name }, 'error');
      throw failure(`Missing local media location for track ${key}`);
    }
    const parts = location.split('/').filter(Boolean);
    let match;
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('/');
      if (suffixes.has(suffix)) {
        match = suffixes.get(suffix);
        break;
      }
    }
    if (!match) {
      report('match', match === null ? 'Multiple media files match this track' : 'No media file matches this track',
        { trackId: key, track: track.Name, location }, 'error');
      throw failure(`Missing or ambiguous media for ${track.Name || key}`);
    }
    const id = String(track['Track ID'] ?? key);
    if (tracks.has(id)) throw failure('Duplicate iTunes track ID');
    tracks.set(id, { ...match, name: path.posix.basename(match.name) });
    if (tracks.size % 100 === 0) report('match', 'Matching library tracks', { matched: tracks.size, skipped });
  }
  report('match', 'Library tracks matched', { matched: tracks.size, skipped });
  if (!tracks.size) throw failure('No local media tracks found in the iTunes library');
  const playlists = [];
  const included = new Set();
  for (const playlist of library.Playlists || []) {
    if (playlist?.Folder || playlist?.Master || playlist?.Distinguished) continue;
    if (!Array.isArray(playlist?.['Playlist Items'])) continue;
    const ids = [...new Set(playlist['Playlist Items'].map((item) => String(item?.['Track ID'])))].filter((id) => tracks.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => included.add(id));
    playlists.push({ playlistTitle: String(playlist.Name || 'Imported playlist').slice(0, 200), files: ids.map((id) => tracks.get(id)) });
  }
  const remaining = [...tracks].filter(([id]) => !included.has(id)).map(([, file]) => file);
  if (remaining.length) playlists.push({ playlistTitle: 'iTunes Library', files: remaining });
  const uniqueFiles = new Map([...tracks.values()].map((file) => [file.path, file]));
  if (!local && (playlists.length > 500
    || [...uniqueFiles.values()].reduce((size, file) => size + file.size, 0) > maxExpandedBytes)) {
    throw failure('The imported playlists exceed the import limits', 413);
  }
  report('plan', 'Playlists ready to import', { playlists: playlists.length, files: playlists.reduce((total, playlist) => total + playlist.files.length, 0) });
  return playlists;
}

export async function importUploadedFiles(files, options, user) {
  const jobs = (await libraryJobs(user));
  const library = (await getLibrary(user.id, jobs));
  if (options.createNew !== 'true' && options.createNew !== 'false') throw failure('Choose an existing or new playlist');
  const createNew = options.createNew === 'true';
  if (!createNew && !library.entries.some((entry) => entry.id === options.playlistId && entry.type === 'playlist')) {
    throw failure('Select one of your existing playlists');
  }
  if (createNew && library.entries.length >= 5000) throw failure('The library contains too many entries', 413);
  if (!files.length) throw failure('Select audio or movie files to import');
  const validated = [];
  for (const file of files) validated.push(await validateImportMedia(file));
  const individual = !createNew && Object.hasOwn(individualPlaylistNames, options.playlistId);
  const individualVideo = individual && options.playlistId === individualVideosId;
  const job = await importJobFiles({ files: validated, playlistId: createNew || individual ? undefined : options.playlistId,
    playlistTitle: individual ? (individualVideo ? 'Imported videos' : 'Imported songs') : options.playlistTitle,
    individual, downloadType: individualVideo ? 'video' : 'audio' }, user);
  if (individual) {
    try { (await linkLibraryJob(user.id, job, (await libraryJobs(user)))); }
    catch (error) { await deleteJob(job.id, user); throw error; }
  }
  return { jobs: [job], importedFiles: files.length };
}

export async function importItunesLibrary(xml, media, user, { local = false, report = () => {}, complete = async () => {} } = {}) {
  const plans = parseItunesImport(xml, media, { local, report });
  const current = (await getLibrary(user.id, (await libraryJobs(user))));
  if (current.entries.length + plans.length > 5000) throw failure('The library contains too many entries', 413);
  for (const plan of plans) {
    plan.files = [...new Map(plan.files.map((file) => [file.path, file])).values()];
  }
  const created = [];
  const converted = new Map();
  try {
    let copiedBytes = 0;
    const countedPaths = new Set();
    for (const plan of plans) {
      for (const [index, file] of plan.files.entries()) {
        if (file.convertFromWav) {
          if (!converted.has(file.path)) converted.set(file.path, await convertItunesWav(file, { local, report }));
          plan.files[index] = converted.get(file.path);
        } else if (file.importName) {
          plan.files[index] = { ...file, name: file.importName };
        }
        if (!countedPaths.has(file.path)) copiedBytes += plan.files[index].size;
        countedPaths.add(file.path);
        if (!local && copiedBytes > maxExpandedBytes) throw failure('The imported playlists exceed the import limits', 413);
      }
    }
    const sources = new Map();
    const playlistTracks = new Map();
    for (const plan of plans) {
      report('copy', 'Importing playlist', { playlist: plan.playlistTitle, files: plan.files.length, index: created.length + 1, total: plans.length });
      const files = plan.files.filter((file) => !sources.has(file.path));
      const job = await importJobFiles({ ...plan, files, source: 'itunes', playlistSongCount: plan.files.length }, user);
      created.push(job);
      files.forEach((file, index) => sources.set(file.path, { jobId: job.id, name: job.files[index] }));
      playlistTracks.set(job.id, plan.files.map((file) => sources.get(file.path)));
      report('copy', 'Playlist imported', { playlist: plan.playlistTitle, jobId: job.id, files: files.length, linked: plan.files.length - files.length });
    }
    report('save', 'Saving library order', { playlists: created.length });
    const jobs = (await libraryJobs(user));
    const library = (await getLibrary(user.id, jobs));
    for (const job of created) {
      const tracks = playlistTracks.get(job.id);
      library.songOrder[job.id] = job.files;
      library.playlistSongOrder[job.id] = tracks.map(songKey);
      library.songAdds.push(...tracks.filter((track) => track.jobId !== job.id).map((track) => ({ ...track, playlistId: job.id })));
    }
    (await setLibrary(user.id, library, jobs));
    await complete();
    return { jobs: created, importedFiles: sources.size };
  } catch (error) {
    report('rollback', 'Import failed; removing created playlists', { playlists: created.length, error: error.message }, 'error');
    for (const job of created) {
      await deleteJob(job.id, user);
      report('rollback', 'Removed imported playlist', { jobId: job.id });
    }
    throw error;
  } finally {
    for (const file of converted.values()) await fs.rm(file.path, { force: true });
  }
}

export async function handleLibraryImport(req, res) {
  if (activeImports.has(req.user.id) || activeImports.size >= 2) return res.status(409).json({ error: 'Another import is in progress. Try again shortly.' });
  const requestedId = req.query?.importId;
  if (requestedId !== undefined && (typeof requestedId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedId))) {
    return res.status(400).json({ error: 'Invalid import ID' });
  }
  activeImports.add(req.user.id);
  const importId = requestedId || randomUUID();
  const started = Date.now();
  for (const [userId, previous] of importProgress) {
    if (previous.finishedAt && (started - previous.finishedAt > importLogLifetime || importProgress.size >= 20)) importProgress.delete(userId);
  }
  const progress = { importId, status: 'running', entries: [] };
  importProgress.delete(req.user.id);
  importProgress.set(req.user.id, progress);
  let stage = 'receive';
  const report = (nextStage, message, details = {}, level = 'info') => {
    stage = nextStage;
    const entry = { time: new Date().toISOString(), importId, userId: req.user.id, elapsedMs: Date.now() - started, stage, level, message, ...details };
    console[level === 'error' ? 'error' : 'info'](`[library-import] ${JSON.stringify(entry)}`);
    const visibleDetails = Object.fromEntries(Object.entries(details).filter(([key]) => [
      'source', 'xml', 'xmlBytes', 'zip', 'zipBytes', 'bytes', 'mediaFiles', 'entries', 'files', 'linked', 'skipped',
      'entry', 'tracks', 'playlists', 'trackId', 'track', 'location', 'matched', 'playlist', 'index', 'total', 'jobId', 'status'
    ].includes(key)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 1024) : value]));
    progress.entries.push({ time: entry.time, elapsedMs: entry.elapsedMs, stage, level, message, details: visibleDetails });
    if (progress.entries.length > 200) progress.entries.shift();
  };
  let result;
  let status = 201;
  let acknowledged = false;
  const lockedFiles = [];
  report('receive', 'Import started', { source: req.is('application/json') ? 'local' : 'upload' });
  try {
    req.importDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-import-'));
    let itunesFiles;
    const local = Boolean(req.is('application/json'));
    if (local) {
      if (req.body?.mode !== 'itunes' || req.body?.source !== 'local') throw failure('Choose an iTunes local storage import');
      itunesFiles = {
        xml: await resolveLocalImportFile(req.body.xmlName, '.xml'),
        media: await resolveLocalImportFile(req.body.zipName, '.zip')
      };
      const paths = Object.values(itunesFiles).map((file) => file.path);
      if (paths.some((file) => activeLocalFiles.has(file))) throw failure('These local files are already being imported', 409);
      for (const file of paths) { activeLocalFiles.add(file); lockedFiles.push(file); }
      if (req.query?.background === 'true') {
        acknowledged = true;
        res.status(202).json({ importId, status: 'running' });
      }
    } else {
      req.importBytes = 0;
      await new Promise((resolve, reject) => upload(req, res, (error) => error ? reject(error) : resolve()));
      if (req.body?.mode === 'itunes' && req.files?.xml?.length === 1 && req.files?.media?.length === 1 && !req.files?.files) {
        itunesFiles = { xml: req.files.xml[0], media: req.files.media[0] };
      }
    }
    if (itunesFiles) {
      report('read', 'Reading import files', { xml: itunesFiles.xml.name || itunesFiles.xml.originalname,
        xmlBytes: itunesFiles.xml.size, zip: itunesFiles.media.name || itunesFiles.media.originalname, zipBytes: itunesFiles.media.size });
      const xml = await fs.readFile(itunesFiles.xml.path, 'utf8');
      const media = await extractImportMedia(itunesFiles.media.path, req.importDirectory, { local, report });
      result = await importItunesLibrary(xml, media, req.user, { local, report, complete: async () => {
        if (!local) return;
        report('archive', 'Moving XML and ZIP to completed import storage');
        await archiveLocalImportFiles(Object.values(itunesFiles));
        report('archive', 'Import source files moved to completed storage');
      } });
    } else if (req.body?.mode === 'files' && !req.files?.xml && !req.files?.media) {
      const files = (req.files?.files || []).map((file) => {
        const bytes = Buffer.from(file.originalname, 'latin1');
        const name = /^[\x00-\xff]*$/.test(file.originalname) && isUtf8(bytes) ? bytes.toString('utf8') : file.originalname;
        return { name, path: file.path };
      });
      result = await importUploadedFiles(files, req.body, req.user);
    } else throw failure('Choose files, or upload both an iTunes XML and a media ZIP');
  } catch (error) {
    status = error instanceof multer.MulterError
      ? (['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT'].includes(error.code) ? 413 : 400)
      : error.statusCode || 500;
    result = { error: status === 500 ? 'Unable to import music' : error.message };
    report(stage, 'Import failed', { status, error: error.message, code: error.code, stack: error.stack }, 'error');
  } finally {
    report('cleanup', 'Removing temporary import files');
    if (req.importDirectory) await fs.rm(req.importDirectory, { recursive: true, force: true }).catch((error) => {
      report('cleanup', 'Unable to remove temporary import files', { error: error.message }, 'error');
    });
    for (const file of lockedFiles) activeLocalFiles.delete(file);
    activeImports.delete(req.user.id);
  }
  report('complete', status === 201 ? 'Import completed' : 'Import ended with errors', { status,
    ...(status === 201 ? { playlists: result.jobs.length, files: result.importedFiles } : {}) });
  progress.status = status === 201 ? 'completed' : 'failed';
  if (status === 201) {
    progress.result = { importedFiles: result.importedFiles,
      jobs: result.jobs.map((job) => ({ id: job.id, playlistTitle: job.playlistTitle })) };
  } else progress.error = result.error;
  progress.finishedAt = Date.now();
  if (!acknowledged && !res.destroyed) res.status(status).json({ ...result, importId });
}