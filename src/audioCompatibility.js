import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaType } from './media.js';

const version = 'aac-lc-192k-faststart-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const signature = (stat, fragmented = false) => hash(`${version}${fragmented ? ':fragmented-v1' : ''}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export async function encodeCompatibilityAudio(source, target, { fragmented = false } = {}) {
  const formats = { '.mp3': 'mp3', '.mp2': 'mp3', '.wav': 'wav', '.flac': 'flac', '.m4a': 'mov', '.aac': 'aac', '.ogg': 'ogg', '.opus': 'ogg', '.wma': 'asf' };
  const format = formats[path.extname(source).toLowerCase()];
  if (!format) throw failure('AAC compatibility is available for audio files only', 400);
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const executable = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? location
    : path.join(location, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  await new Promise((resolve, reject) => {
    execFile(executable, ['-nostdin', '-v', 'error', '-max_alloc', '33554432', '-protocol_whitelist', 'file,pipe', '-f', format,
      ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
      '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-threads', '1',
      ...(fragmented ? ['-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '2000000', '-f', 'mp4']
        : ['-movflags', '+faststart', '-f', 'ipod']), target],
    { timeout: 15 * 60_000, maxBuffer: 128 * 1024, windowsHide: true }, (error) => {
      if (error) reject(failure(error.code === 'ENOENT' || error.code === 'EACCES'
        ? 'AAC compatibility requires FFmpeg; check FFMPEG_PATH.' : 'Unable to prepare AAC audio. Retry or use original playback.', 503));
      else resolve();
    });
  });
}

export function createCompatibilityAudioCache({ root = path.resolve('data', 'playback-aac'), encode = encodeCompatibilityAudio,
  maxBytes = 5 * 1024 ** 3, concurrency = 2, maxPending = 16 } = {}) {
  const pending = new Map();
  const waiting = [];
  let running = 0;

  async function cached(target) {
    const stat = await fs.stat(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    return stat?.isFile() && stat.size > 0 ? target : null;
  }

  async function prune(keep) {
    const entries = [];
    for (const name of await fs.readdir(root)) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.m4a$/.test(name)) continue;
      const target = path.join(root, name);
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isFile()) entries.push({ target, size: stat.size, modified: stat.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((first, second) => first.modified - second.modified)) {
      if (total <= maxBytes) break;
      if (entry.target === keep || pending.has(entry.target)) continue;
      if (await fs.rm(entry.target, { force: true }).then(() => true, () => false)) total -= entry.size;
    }
  }

  async function generate(source, target, revision, fragmented) {
    if (running >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    else running++;
    let temporary;
    try {
      const existing = await cached(target);
      if (existing) return existing;
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      temporary = path.join(root, `${randomUUID()}.tmp.m4a`);
      await encode(source, temporary, { fragmented });
      const stat = await fs.stat(temporary);
      if (!stat.isFile() || !stat.size) throw failure('AAC preparation produced an empty file', 503);
      if (stat.size > maxBytes) throw failure('Prepared audio exceeds the playback cache limit', 413);
      if (signature(await fs.stat(source), fragmented) !== revision) throw failure('Song changed during AAC preparation; retry playback', 409);
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, target);
      await prune(target);
      return target;
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      if (waiting.length) waiting.shift()();
      else running--;
    }
  }

  async function prepare(filePath, { fragmented = false } = {}) {
    if (mediaType(filePath) !== 'audio') throw failure('AAC compatibility is available for audio files only', 400);
    const source = await fs.realpath(filePath);
    const stat = await fs.stat(source);
    if (!stat.isFile() || !stat.size) throw failure('Song not found', 404);
    const revision = signature(stat, fragmented);
    const target = path.join(root, `${hash(source)}-${revision}.m4a`);
    const existing = await cached(target);
    if (existing) return existing;
    if (pending.has(target)) return pending.get(target);
    if (pending.size >= maxPending) throw failure('AAC preparation is busy; retry shortly', 429);
    const operation = generate(source, target, revision, fragmented);
    pending.set(target, operation);
    try { return await operation; }
    finally { if (pending.get(target) === operation) pending.delete(target); }
  }

  return { prepare };
}

const compatibilityAudio = createCompatibilityAudioCache();

export function createMediaStreamHandler(resolveFile, cache = compatibilityAudio) {
  return async (req, res) => {
    try {
      const format = req.query.format;
      if (format !== undefined && format !== 'aac') throw failure('Unsupported playback format', 400);
      if (req.query.mse !== undefined && (req.query.mse !== '1' || format !== 'aac')) throw failure('Invalid MediaSource format', 400);
      const source = await resolveFile(req);
      let target = source;
      if (format === 'aac') {
        target = await cache.prepare(source, { fragmented: req.query.mse === '1' });
        if (await resolveFile(req) !== source) throw failure('Song changed during AAC preparation; retry playback', 409);
        res.type('audio/mp4');
      } else if (/\.m4v$/i.test(source)) res.type('video/mp4');
      res.set('Cache-Control', 'private, no-cache');
      res.set('X-Content-Type-Options', 'nosniff');
      res.sendFile(target, { acceptRanges: true, cacheControl: false }, (error) => {
        if (!error || res.headersSent || res.destroyed) return;
        res.status(error.statusCode || error.status || 500).end();
      });
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      if (error.statusCode === 429 || error.statusCode === 503) res.set('Retry-After', '5');
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  };
}