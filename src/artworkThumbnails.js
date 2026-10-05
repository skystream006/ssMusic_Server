import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSongArtwork } from './music.js';
import { mediaType } from './media.js';

const thumbnailVersion = '96-webp-v1';
const maxThumbnailBytes = 64 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const signature = (stat) => hash(`${thumbnailVersion}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
const isWebp = (buffer) => buffer.length >= 12 && buffer.length <= maxThumbnailBytes
  && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
let audioFallback;

function encodeThumbnailSource(inputArguments, imageBuffer, video = false) {
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const directory = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  const executable = path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-nostdin', '-v', 'error', '-max_alloc', '33554432',
      ...inputArguments,
      '-vf', ['scale=96:96:force_original_aspect_ratio=decrease', ...(video ? ['thumbnail=30'] : []),
        'pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000'].join(','),
      '-frames:v', '1', '-threads', '1', '-c:v', 'libwebp', '-quality', '70', '-compression_level', '4',
      '-f', 'webp', 'pipe:1'], { encoding: 'buffer', timeout: 15_000, maxBuffer: maxThumbnailBytes, windowsHide: true },
    (error, output) => {
      if (error) return reject(new Error(error.code === 'ENOENT' || error.code === 'EACCES'
        ? 'Thumbnail generation requires FFmpeg; check FFMPEG_PATH.'
        : 'FFmpeg could not generate the artwork thumbnail.'));
      if (!isWebp(output)) return reject(new Error('Invalid artwork thumbnail output'));
      resolve(output);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(imageBuffer);
  });
}

export function encodeThumbnail(image) {
  const format = { 'image/jpeg': 'mjpeg', 'image/png': 'png', 'image/webp': 'webp' }[image.mime];
  if (!format) throw new Error('Unsupported artwork image');
  return encodeThumbnailSource(['-protocol_whitelist', 'pipe', '-f', 'image2pipe', '-c:v', format,
    '-max_pixels', '16777216', '-threads', '1', '-i', 'pipe:0'], image.imageBuffer);
}

export function encodeVideoThumbnail(filePath) {
  const format = { '.mp4': 'mov', '.m4v': 'mov', '.mov': 'mov', '.webm': 'matroska', '.ogv': 'ogg' }[path.extname(filePath).toLowerCase()];
  if (!format) throw new Error('Unsupported thumbnail video');
  return encodeThumbnailSource(['-protocol_whitelist', 'file,pipe', '-f', format,
    ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-probesize', '1048576', '-analyzeduration', '1000000', '-max_pixels', '16777216', '-threads', '1',
    '-i', path.resolve(filePath), '-map', '0:v:0', '-an', '-sn', '-dn'], undefined, true);
}

export function createThumbnailCache({ root = path.resolve('data', 'artwork-thumbnails'),
  readArtwork = readSongArtwork, encode = encodeThumbnail, encodeVideo = encodeVideoThumbnail } = {}) {
  const pending = new Map();
  const waiting = [];
  let running = 0;

  async function readCached(target) {
    const cached = await fs.readFile(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    return cached && (!cached.length || isWebp(cached)) ? cached : null;
  }

  async function generate(filePath, force) {
    if (running >= 2) await new Promise((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      const directory = path.join(root, hash(filePath));
      for (let attempt = 0; attempt < 3; attempt++) {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return null;
        const revision = signature(stat);
        const target = path.join(directory, `${revision}.webp`);
        if (!force) {
          const cached = await readCached(target);
          if (cached) return cached.length ? cached : null;
        }
        let thumbnail;
        if (mediaType(filePath) === 'video') thumbnail = await encodeVideo(filePath);
        else {
          const image = await readArtwork(filePath);
          thumbnail = image ? await encode(image) : Buffer.alloc(0);
        }
        if (signature(await fs.stat(filePath)) !== revision) continue;
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, `${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, thumbnail, { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, target);
        } finally { await fs.rm(temporary, { force: true }); }
        for (const name of await fs.readdir(directory)) {
          if (/^[a-f0-9]{64}\.webp$/.test(name) && name !== path.basename(target)) {
            await fs.rm(path.join(directory, name), { force: true });
          }
        }
        return thumbnail.length ? thumbnail : null;
      }
      throw new Error('Song changed during thumbnail generation; retry later.');
    } finally {
      if (waiting.length) waiting.shift()();
      else running -= 1;
    }
  }

  async function readSource(filePath, { force = false } = {}) {
    if (!/\.mp3$/i.test(filePath) && mediaType(filePath) !== 'video') return null;
    const realPath = await fs.realpath(filePath);
    if (!force) {
      const revision = signature(await fs.stat(realPath));
      const cached = await readCached(path.join(root, hash(realPath), `${revision}.webp`));
      if (cached) return cached.length ? cached : null;
    }
    const existing = pending.get(realPath);
    if (existing) {
      await existing;
      return readSource(realPath, { force });
    }
    const operation = generate(realPath, force);
    pending.set(realPath, operation);
    try { return await operation; }
    finally { if (pending.get(realPath) === operation) pending.delete(realPath); }
  }

  async function read(filePath, options = {}) {
    const thumbnail = await readSource(filePath, options);
    if (thumbnail || options.fallback !== true || mediaType(filePath) !== 'audio') return thumbnail;
    audioFallback ??= fs.readFile(new URL('./assets/audio-thumbnail.webp', import.meta.url));
    return audioFallback;
  }

  async function remove(filePath) {
    const realPath = await fs.realpath(filePath).catch(() => path.resolve(filePath));
    await pending.get(realPath)?.catch(() => {});
    await fs.rm(path.join(root, hash(realPath)), { recursive: true, force: true });
  }

  return { read, remove };
}

const thumbnails = createThumbnailCache();
export const readSongThumbnail = (filePath, options) => thumbnails.read(filePath, options);

export async function refreshSongThumbnail(filePath) {
  try { await readSongThumbnail(filePath); }
  catch (error) { console.warn(`Unable to refresh album artwork thumbnail: ${error.message}`); }
}

export async function removeSongThumbnail(filePath) {
  try { await thumbnails.remove(filePath); }
  catch (error) { console.warn(`Unable to remove album artwork thumbnail: ${error.message}`); }
}
