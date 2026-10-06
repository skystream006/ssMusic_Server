import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { readSongArtwork } from './music.js';
import { mediaType } from './media.js';

const thumbnailVersion = '192-avif-v1';
const maxThumbnailBytes = 64 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const signature = (stat) => hash(`${thumbnailVersion}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
const isAvif = async (buffer) => buffer.length > 0 && buffer.length <= maxThumbnailBytes
  && (await fileTypeFromBuffer(buffer).catch(() => null))?.mime === 'image/avif';
let audioFallback;

async function encodeThumbnailSource(inputArguments, imageBuffer, video = false) {
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const directory = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  const executable = path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnail-'));
  const target = path.join(temporary, 'thumbnail.avif');
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(executable, ['-nostdin', '-v', 'error', '-max_alloc', '33554432',
        ...inputArguments,
        '-vf', ['scale=192:192:force_original_aspect_ratio=decrease', ...(video ? ['thumbnail=30'] : []),
          'pad=192:192:(ow-iw)/2:(oh-ih)/2:color=0x00000000'].join(','),
        '-frames:v', '1', '-threads', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-cpu-used', '8',
        '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', '-f', 'avif', target],
      { encoding: 'buffer', timeout: 15_000, maxBuffer: maxThumbnailBytes, windowsHide: true }, (error) => {
        if (error) return reject(new Error(error.code === 'ENOENT' || error.code === 'EACCES'
          ? 'Thumbnail generation requires FFmpeg; check FFMPEG_PATH.'
          : 'FFmpeg could not generate the artwork thumbnail.'));
        resolve();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(imageBuffer);
    });
    if ((await fs.stat(target)).size > maxThumbnailBytes) throw new Error('Invalid artwork thumbnail output');
    const output = await fs.readFile(target);
    if (!await isAvif(output)) throw new Error('Invalid artwork thumbnail output');
    return output;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function encodeThumbnail(image) {
  const format = { 'image/jpeg': 'mjpeg', 'image/png': 'png', 'image/webp': 'webp' }[image.mime];
  if (!format && image.mime !== 'image/avif') throw new Error('Unsupported artwork image');
  const input = image.mime === 'image/avif'
    ? ['-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0']
    : ['-f', 'image2pipe', '-c:v', format];
  return encodeThumbnailSource(['-protocol_whitelist', 'pipe', ...input,
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
    return cached && (!cached.length || await isAvif(cached)) ? cached : null;
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
        const target = path.join(directory, `${revision}.avif`);
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
          if (/^[a-f0-9]{64}\.(?:avif|webp)$/.test(name) && name !== path.basename(target)) {
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
      const cached = await readCached(path.join(root, hash(realPath), `${revision}.avif`));
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
    audioFallback ??= fs.readFile(new URL('./assets/audio-thumbnail.avif', import.meta.url));
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
