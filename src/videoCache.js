import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { mediaType } from './media.js';
import { openDatabase } from './database.js';

const execute = promisify(execFile);
const retentionMs = 7 * 24 * 60 * 60_000;
const cacheDirectoryPattern = /^(?:[a-f0-9]{64}|[a-f0-9-]{36}\.tmp)$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const revision = (source, stat) => hash(`hls-480-v1:${source}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const absent = (error) => { if (error.code !== 'ENOENT') throw error; };

export async function getVideoCacheSettings(database) {
  const row = await database.prepare("SELECT value FROM job_server_state WHERE key = 'video-cache-enabled'").get();
  return { videoCacheEnabled: row?.value !== 'false' };
}

export async function setVideoCacheSettings(database, value) {
  if (typeof value !== 'boolean') throw failure('videoCacheEnabled must be a boolean', 400);
  await database.prepare(`INSERT INTO job_server_state (key, value) VALUES ('video-cache-enabled', $1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(value));
  return { videoCacheEnabled: value };
}

function executable(name) {
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const directory = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  return name === 'ffmpeg' && /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? location
    : path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
}

async function probe(source) {
  const { stdout } = await execute(executable('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'stream=index,codec_type,width,height:stream_disposition=attached_pic', '-of', 'json', source],
  { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true });
  return JSON.parse(stdout).streams;
}

export async function encodeAdaptiveVideo(source, directory) {
  const streams = await probe(source);
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video?.width || !video?.height) throw failure('This file has no playable video stream', 422);
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
  // Both outputs share frame timestamps and forced keyframes, including variable-frame-rate sources.
  const filters = `[0:${video.index}]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,split=2[low][original];`
    + '[low]scale=w=min(854\\,iw):h=min(480\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[small]';
  const args = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', source,
    '-filter_complex_threads', '1', '-filter_complex', filters];
  for (const [name, label, crf] of [['480p', 'small', '23'], ['original', 'original', '20']]) {
    await fs.mkdir(path.join(directory, name));
    args.push('-map', `[${label}]`, ...(hasAudio ? ['-map', '0:a:0'] : []),
      '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf,
      '-pix_fmt', 'yuv420p', '-threads', '2', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*4)', '-fps_mode', 'passthrough',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : []),
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(directory, name, 'segment-%06d.ts'),
      path.join(directory, name, 'index.m3u8'));
  }
  try {
    await execute(executable('ffmpeg'), args, { timeout: 60 * 60_000, maxBuffer: 256 * 1024, windowsHide: true });
  } catch (error) {
    throw failure(error.code === 'ENOENT' || error.code === 'EACCES'
      ? 'Adaptive video requires FFmpeg with libx264; check FFMPEG_PATH.'
      : 'Unable to prepare adaptive video. Retry playback or download the original file.', 503);
  }
  const variants = [];
  for (const name of ['480p', 'original']) {
    const playlist = await fs.readFile(path.join(directory, name, 'index.m3u8'), 'utf8');
    let duration = 0;
    let bandwidth = 0;
    let firstSegment;
    for (const line of playlist.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
      if (/^segment-\d+\.ts$/.test(line)) {
        firstSegment ||= line;
        const stat = await fs.stat(path.join(directory, name, line));
        if (!(duration > 0) || !stat.size) throw new Error('Invalid HLS segment');
        bandwidth = Math.max(bandwidth, Math.ceil(stat.size * 8 / duration * 1.1));
      }
    }
    if (!firstSegment || !playlist.includes('#EXT-X-ENDLIST')) throw new Error('Incomplete HLS rendition');
    const output = (await probe(path.join(directory, name, firstSegment))).find((stream) => stream.codec_type === 'video');
    variants.push({ name, bandwidth, width: output.width, height: output.height });
  }
  // BANDWIDTH ordering keeps automatic startup on the lower-bitrate rendition.
  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  await fs.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + variants.map((item) => `#EXT-X-STREAM-INF:BANDWIDTH=${item.bandwidth},RESOLUTION=${item.width}x${item.height}\n${item.name}/index.m3u8\n`).join(''));
}

export function createVideoCache({ root = path.resolve('data', 'playback-video'), encode = encodeAdaptiveVideo,
  now = Date.now, inactivityMs = retentionMs, maxPending = 8, isEnabled = async () => true } = {}) {
  const pending = new Map();
  const readers = new Map();
  let tail = Promise.resolve();
  let pruning;
  let usage;
  let usageScan;

  async function scanUsage() {
    async function bytesIn(directory) {
      let bytes = 0;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => { absent(error); return []; });
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) bytes += await bytesIn(target);
        else if (entry.isFile()) {
          const stat = await fs.lstat(target).catch(absent);
          if (stat?.isFile()) bytes += stat.size;
        }
      }
      return bytes;
    }
    let totalVideos = 0;
    let totalBytes = 0;
    let temporaryBytes = 0;
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => { absent(error); return []; });
    for (const entry of entries) {
      if (!entry.isDirectory() || !cacheDirectoryPattern.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const bytes = await bytesIn(directory);
      totalBytes += bytes;
      if (entry.name.endsWith('.tmp')) temporaryBytes += bytes;
      else {
        const master = await fs.lstat(path.join(directory, 'master.m3u8')).catch(absent);
        if (master?.isFile() && master.size) totalVideos++;
      }
    }
    return { totalVideos, totalBytes, temporaryBytes, scannedAt: new Date(now()).toISOString() };
  }

  async function getStatus() {
    if (!usage || now() - Date.parse(usage.scannedAt) >= 30_000) {
      usageScan ||= scanUsage().then((result) => { usage = result; }).finally(() => { usageScan = null; });
      await usageScan;
    }
    return { ...usage, preparing: [...pending.values()].filter((entry) => !entry.error).length };
  }

  async function prune() {
    if (pruning) return pruning;
    pruning = (async () => {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => { absent(error); return []; });
      for (const entry of entries) {
        if (!entry.isDirectory() || !cacheDirectoryPattern.test(entry.name)) continue;
        const target = path.join(root, entry.name);
        const stat = await fs.stat(target).catch(absent);
        if (stat && now() - stat.mtimeMs >= inactivityMs && !pending.has(entry.name) && !readers.has(entry.name)) {
          await fs.rm(target, { recursive: true, force: true });
          usage = null;
        }
      }
    })().finally(() => { pruning = null; });
    return pruning;
  }

  async function acquire(filePath, { background = false } = {}) {
    if (!await isEnabled()) throw failure('Video caching is disabled by an administrator', 409);
    if (mediaType(filePath) !== 'video') throw failure('Adaptive streaming is available for video files only', 400);
    const source = await fs.realpath(filePath);
    const stat = await fs.stat(source);
    if (!stat.isFile() || !stat.size) throw failure('Video not found', 404);
    const key = revision(source, stat);
    readers.set(key, (readers.get(key) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = readers.get(key) - 1;
      if (count) readers.set(key, count);
      else readers.delete(key);
    };
    try {
      const directory = path.join(root, key);
      const master = await fs.stat(path.join(directory, 'master.m3u8')).catch(absent);
      if (master?.isFile() && master.size) {
        const time = new Date(now());
        await fs.utimes(directory, time, time);
        return { key, directory, ready: true, release };
      }
      let entry = pending.get(key);
      if (entry?.error) {
        pending.delete(key);
        if (background) return { key, directory, ready: false, error: entry.error, release };
        throw entry.error;
      }
      if (!entry) {
        if (pending.size >= maxPending) {
          const error = failure('Video preparation is busy; retry shortly', 429);
          if (background) return { key, directory, ready: false, error, release };
          throw error;
        }
        entry = {};
        pending.set(key, entry);
        entry.done = tail.then(async () => {
          if (!await isEnabled()) throw failure('Video caching is disabled by an administrator', 409);
          await fs.mkdir(root, { recursive: true, mode: 0o700 });
          const temporary = path.join(root, `${randomUUID()}.tmp`);
          await fs.mkdir(temporary, { mode: 0o700 });
          try {
            await encode(source, temporary);
            const master = await fs.stat(path.join(temporary, 'master.m3u8'));
            if (!master.isFile() || !master.size) throw failure('Video preparation produced no playlist', 503);
            if (revision(source, await fs.stat(source)) !== key) throw failure('Video changed during preparation; retry playback', 409);
            const time = new Date(now());
            await fs.utimes(temporary, time, time);
            await fs.rename(temporary, directory);
          } finally {
            await fs.rm(temporary, { recursive: true, force: true });
            usage = null;
          }
          pending.delete(key);
        });
        tail = entry.done.catch((error) => {
          entry.error = error;
          console.error('Adaptive video preparation:', error.message);
          // Failed entries must not permanently consume every queue slot.
          const timer = setTimeout(() => { if (pending.get(key) === entry) pending.delete(key); }, 60_000);
          timer.unref();
        });
      }
      return { key, directory, ready: false, done: entry.done, release };
    } catch (error) { release(); throw error; }
  }
  return { acquire, prune, getStatus, isEnabled };
}

export const videoCache = createVideoCache({
  isEnabled: async () => (await getVideoCacheSettings(openDatabase())).videoCacheEnabled
});

export function startVideoCacheMaintenance() {
  const clean = () => videoCache.prune().catch((error) => console.error('Video cache cleanup:', error.message));
  clean();
  const timer = setInterval(clean, 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function serveAdaptiveVideo(req, res, resolveFile, cache = videoCache) {
  const source = await resolveFile(req);
  const serveOriginal = (status) => {
    const query = new URLSearchParams(req.originalUrl.split('?')[1] || '');
    query.delete('format');
    query.delete('asset');
    const search = query.toString();
    res.set('Cache-Control', 'private, no-store');
    return res.json({ status, streamUrl: `${req.baseUrl}${req.path}${search ? `?${search}` : ''}` });
  };
  if (!await cache.isEnabled()) {
    if (mediaType(source) !== 'video') throw failure('Adaptive streaming is available for video files only', 400);
    return serveOriginal('disabled');
  }
  const entry = await cache.acquire(source, { background: req.query.asset === undefined });
  res.once('finish', entry.release);
  res.once('close', entry.release);
  try {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    const asset = req.query.asset;
    if (asset !== undefined && (typeof asset !== 'string'
      || !/^[a-f0-9]{64}\/(?:master\.m3u8|(?:480p|original)\/(?:index\.m3u8|segment-\d{6,}\.ts))$/.test(asset))) {
      throw failure('Invalid video segment', 400);
    }
    if (asset && !asset.startsWith(`${entry.key}/`)) throw failure('Video changed; reload playback', 409);
    if (!entry.ready) {
      if (asset === undefined) {
        if (entry.error) console.error('Background video preparation:', entry.error.message);
        return serveOriginal('original');
      }
      res.set('Retry-After', '2');
      return res.status(202).json({ status: 'preparing', message: 'Preparing adaptive video...' });
    }
    if (await resolveFile(req) !== source) throw failure('Video changed during playback preparation', 409);
    const name = asset ? asset.slice(entry.key.length + 1) : 'master.m3u8';
    const target = path.join(entry.directory, ...name.split('/'));
    if (name.endsWith('.m3u8')) {
      const playlist = await fs.readFile(target, 'utf8');
      const prefix = name.includes('/') ? `${name.split('/')[0]}/` : '';
      const body = playlist.split('\n').map((line) => {
        if (!line || line.startsWith('#')) return line;
        const query = new URLSearchParams(req.originalUrl.split('?')[1] || '');
        query.set('format', 'hls');
        query.set('asset', `${entry.key}/${prefix}${line.trim()}`);
        return `${req.baseUrl}${req.path}?${query}`;
      }).join('\n');
      return res.type('application/vnd.apple.mpegurl').send(body);
    }
    res.type('video/mp2t');
    return res.sendFile(name, { root: entry.directory, cacheControl: false, dotfiles: 'deny' }, (error) => {
      if (!error || res.headersSent || res.destroyed) return;
      res.status(error.statusCode || error.status || 500).end();
    });
  } catch (error) { entry.release(); throw error; }
}
