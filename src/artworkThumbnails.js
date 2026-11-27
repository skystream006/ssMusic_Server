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
const sourceKey = (source) => Array.isArray(source) ? source[0] : source;
const sourceRevision = async (source) => Array.isArray(source)
  ? hash(`192-collage-v1:${JSON.stringify(await Promise.all(source.map(async (filePath) => [
    filePath, signature(await fs.stat(filePath))
  ])))}`)
  : signature(await fs.stat(source));
const isAvif = async (buffer) => buffer.length > 0 && buffer.length <= maxThumbnailBytes
  && (await fileTypeFromBuffer(buffer).catch(() => null))?.mime === 'image/avif';
let audioFallback;

async function encodeThumbnailSource(inputArguments, imageBuffer, video = false, complexFilter = null) {
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const directory = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  const executable = path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnail-'));
  const target = path.join(temporary, 'thumbnail.avif');
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(executable, ['-nostdin', '-v', 'error', '-max_alloc', '33554432',
        ...inputArguments,
        ...(complexFilter ? ['-filter_complex_threads', '1', '-filter_complex', complexFilter, '-map', '[collage]']
          : ['-vf', ['scale=192:192:force_original_aspect_ratio=decrease', ...(video ? ['thumbnail=30'] : []),
            'pad=192:192:(ow-iw)/2:(oh-ih)/2:color=0x00000000'].join(',')]),
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

export async function readDownloadedArtwork(filePath) {
  const directory = path.join(path.dirname(filePath), '.thumbnails');
  const stem = path.basename(filePath, path.extname(filePath));
  for (const extension of ['.avif', '.webp', '.jpg', '.jpeg', '.png']) {
    const source = await fs.realpath(path.join(directory, `${stem}${extension}`)).catch(() => null);
    if (!source || path.dirname(source) !== directory) continue;
    const handle = await fs.open(source, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size || stat.size > 3 * 1024 * 1024) continue;
      const imageBuffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(imageBuffer, 0, imageBuffer.length, 0);
      if (bytesRead !== imageBuffer.length) continue;
      const type = await fileTypeFromBuffer(imageBuffer).catch(() => null);
      if (['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type?.mime)) {
        return { mime: type.mime, imageBuffer };
      }
    } finally { await handle.close(); }
  }
  return null;
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
      const directory = path.join(root, hash(sourceKey(filePath)));
      for (let attempt = 0; attempt < 3; attempt++) {
        const stat = await fs.stat(sourceKey(filePath));
        if (!stat.isFile()) return null;
        const revision = await sourceRevision(filePath);
        const target = path.join(directory, `${revision}.avif`);
        if (!force) {
          const cached = await readCached(target);
          if (cached) return cached.length ? cached : null;
        }
        let thumbnail;
        if (Array.isArray(filePath)) {
          thumbnail = await encode(await readArtwork(filePath));
        } else if (mediaType(filePath) === 'video') {
          const image = await readDownloadedArtwork(filePath).catch(() => null);
          if (image) {
            try { thumbnail = await encode(image); }
            catch {}
          }
          if (!thumbnail) thumbnail = await encodeVideo(filePath);
        } else {
          const image = await readArtwork(filePath);
          thumbnail = image ? await encode(image) : Buffer.alloc(0);
        }
        if (await sourceRevision(filePath) !== revision) continue;
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
    if (Array.isArray(filePath)) {
      if (!filePath.length) return null;
      if (filePath.length > 4 || filePath.some((source) => typeof source !== 'string' || !mediaType(source))) {
        throw new Error('Playlist thumbnails require one to four media files');
      }
    } else if (!/\.mp3$/i.test(filePath) && mediaType(filePath) !== 'video') return null;
    const realPath = Array.isArray(filePath)
      ? await Promise.all(filePath.map((source) => fs.realpath(source))) : await fs.realpath(filePath);
    const key = sourceKey(realPath);
    if (!force) {
      const revision = await sourceRevision(realPath);
      const cached = await readCached(path.join(root, hash(key), `${revision}.avif`));
      if (cached) return cached.length ? cached : null;
    }
    const existing = pending.get(key);
    if (existing) {
      await existing;
      return readSource(realPath, { force });
    }
    const operation = generate(realPath, force);
    pending.set(key, operation);
    try { return await operation; }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  }

  async function read(filePath, options = {}) {
    const thumbnail = await readSource(filePath, options);
    if (thumbnail || options.fallback !== true || Array.isArray(filePath) || mediaType(filePath) !== 'audio') return thumbnail;
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

export async function encodePlaylistThumbnail(images) {
  if (!Array.isArray(images) || !images.length || images.length > 4) {
    throw new Error('Playlist thumbnails require one to four images');
  }
  if (images.length === 1) return encodeThumbnail(images[0]);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-collage-'));
  try {
    const inputs = [];
    const tiles = images.length === 2 ? [[96, 192, 0, 0], [96, 192, 96, 0]]
      : images.length === 3 ? [[96, 192, 0, 0], [96, 96, 96, 0], [96, 96, 96, 96]]
        : [[96, 96, 0, 0], [96, 96, 96, 0], [96, 96, 0, 96], [96, 96, 96, 96]];
    for (const [index, image] of images.entries()) {
      if (image.mime !== 'image/avif' || !await isAvif(image.imageBuffer)) throw new Error('Invalid playlist source thumbnail');
      const input = path.join(temporary, `${index}.avif`);
      await fs.writeFile(input, image.imageBuffer, { flag: 'wx', mode: 0o600 });
      inputs.push('-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0',
        '-max_pixels', '16777216', '-threads', '1', '-i', input);
    }
    const filters = tiles.map(([width, height], index) =>
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[t${index}]`);
    filters.push(`${tiles.map((_, index) => `[t${index}]`).join('')}xstack=inputs=${images.length}:layout=${
      tiles.map(([, , x, y]) => `${x}_${y}`).join('|')}:shortest=1[collage]`);
    return await encodeThumbnailSource(inputs, undefined, false, filters.join(';'));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

const playlistImage = async (filePath) => ({
  mime: 'image/avif', imageBuffer: await readSongThumbnail(filePath, { fallback: true })
});
const playlistThumbnails = createThumbnailCache({
  root: path.resolve('data', 'playlist-thumbnails'),
  readArtwork: (filePaths) => Promise.all(filePaths.map(playlistImage)),
  encode: encodePlaylistThumbnail,
});
export const readPlaylistThumbnail = (filePaths, options) => playlistThumbnails.read(filePaths, options);

export async function refreshSongThumbnail(filePath, options) {
  try { await readSongThumbnail(filePath, options); }
  catch (error) { console.warn(`Unable to refresh album artwork thumbnail: ${error.message}`); }
}

export async function removeSongThumbnail(filePath) {
  try {
    await thumbnails.remove(filePath);
    await playlistThumbnails.remove(filePath);
  }
  catch (error) { console.warn(`Unable to remove album artwork thumbnail: ${error.message}`); }
}
