import NodeID3 from 'node-id3';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { songMetadataFields as metadataFields } from './library.js';

const ratingBytes = [0, 1, 64, 128, 196, 255];
const summaryCache = new Map();
const summaryFrames = ['TIT2', 'TPE1', 'TALB', 'TPE2', 'TCON', 'TYER', 'TRCK', 'TPOS', 'POPM'];
const publicMetadataFrames = [...summaryFrames, 'APIC', 'SYLT', 'USLT',
  'TT2', 'TP1', 'TAL', 'TP2', 'TCO', 'TYE', 'TRK', 'TPA', 'POP', 'PIC', 'SLT', 'ULT'];
const maxId3TagBytes = 16 * 1024 ** 2;

function synchsafeSize(bytes) {
  return bytes.length === 4 && bytes.every((byte) => byte < 128)
    ? bytes.reduce((total, byte) => total * 128 + byte, 0) : null;
}

function boundedId3TagIsSafe(buffer) {
  const version = buffer[3];
  let offset = 10;
  if (buffer[5] & 0x40) {
    if (version === 2 || buffer.length < 14) return false;
    const extendedSize = version === 3 ? buffer.readUInt32BE(10) + 4 : synchsafeSize(buffer.subarray(10, 14));
    if (extendedSize === null || extendedSize < 4 || extendedSize > buffer.length - offset) return false;
    offset += extendedSize;
  }
  const headerSize = version === 2 ? 6 : 10;
  let frames = 0;
  while (offset < buffer.length && buffer[offset] !== 0) {
    if (buffer.length - offset < headerSize || ++frames > 10_000) return false;
    const size = version === 2 ? buffer.readUIntBE(offset + 3, 3)
      : version === 3 ? buffer.readUInt32BE(offset + 4) : synchsafeSize(buffer.subarray(offset + 4, offset + 8));
    if (size === null || size > buffer.length - offset - headerSize) return false;
    // Compressed frames can expand far beyond the on-disk tag limit.
    if (version !== 2 && (buffer[offset + 9] & (version === 3 ? 0x80 : 0x08))) return false;
    offset += headerSize + size;
  }
  return true;
}

async function readBoundedId3Tags(filePath, options) {
  const file = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(10);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 10 || header.toString('ascii', 0, 3) !== 'ID3'
      || ![2, 3, 4].includes(header[3]) || header[4] !== 0) return {};
    const tagSize = synchsafeSize(header.subarray(6));
    if (tagSize === null) return {};
    const size = tagSize + 10;
    if (size > maxId3TagBytes || size > (await file.stat()).size) return {};
    const buffer = Buffer.alloc(size);
    header.copy(buffer);
    let offset = header.length;
    while (offset < size) {
      const result = await file.read(buffer, offset, size - offset, offset);
      if (!result.bytesRead) return {};
      offset += result.bytesRead;
    }
    if (!boundedId3TagIsSafe(buffer)) return {};
    try { return NodeID3.read(buffer, { ...options, noRaw: true }); }
    catch { return {}; }
  } finally { await file.close(); }
}

function songRating(tags) {
  const rating = tags.popularimeter?.rating;
  if (!Number.isInteger(rating) || rating <= 0) return 0;
  if (rating < 32) return 1;
  if (rating < 96) return 2;
  if (rating < 160) return 3;
  if (rating < 224) return 4;
  return 5;
}

export async function readSongSummary(filePath, stat) {
  if (path.extname(filePath).toLowerCase() !== '.mp3') return {};
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = summaryCache.get(filePath);
  if (cached?.signature === signature) return cached.summary;
  const file = await fs.open(filePath, 'r');
  let tags = {};
  try {
    const header = Buffer.alloc(10);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead === 10 && header.toString('ascii', 0, 3) === 'ID3' && header.subarray(6).every((byte) => byte < 128)) {
      const size = header.subarray(6).reduce((total, byte) => total * 128 + byte, 0) + 10;
      if (size <= stat.size && size <= maxId3TagBytes) {
        const buffer = Buffer.alloc(size);
        const result = await file.read(buffer, 0, size, 0);
        if (result.bytesRead === size) tags = NodeID3.read(buffer, { include: summaryFrames });
      }
    }
  } finally { await file.close(); }
  const summary = { rating: songRating(tags) };
  for (const field of metadataFields) if (typeof tags[field] === 'string') summary[field] = tags[field];
  if (summaryCache.size >= 1000) summaryCache.delete(summaryCache.keys().next().value);
  summaryCache.set(filePath, { signature, summary });
  return summary;
}

export async function readSongArtwork(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.mp3') return null;
  const { image } = await readBoundedId3Tags(filePath, { include: ['APIC', 'PIC'] });
  if (!image || !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(image.mime)
    || !Buffer.isBuffer(image.imageBuffer) || !image.imageBuffer.length
    || image.imageBuffer.length > 2 * 1024 * 1024) return null;
  const type = await fileTypeFromBuffer(image.imageBuffer).catch(() => null);
  return type?.mime === image.mime ? image : null;
}

export async function updateSongMetadata(filePath, value) {
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (path.extname(filePath).toLowerCase() !== '.mp3') invalid('Metadata editing is supported for MP3 files');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).length || Object.keys(value).some((key) => ![...metadataFields, 'artwork', 'rating', 'sylt', 'uslt'].includes(key))) invalid('Invalid song metadata');
  if (Object.hasOwn(value, 'rating') && (!Number.isInteger(value.rating) || value.rating < 0 || value.rating > 5)) invalid('Rating must be an integer from 0 to 5');
  if (Object.hasOwn(value, 'uslt') && (typeof value.uslt !== 'string' || value.uslt.length > 100_000 || value.uslt.includes('\0'))) {
    invalid('USLT lyrics must contain at most 100,000 characters without null characters');
  }
  if (Object.hasOwn(value, 'sylt') && (!Array.isArray(value.sylt) || value.sylt.length > 10_000
    || value.sylt.some((line) => !line || typeof line !== 'object' || Array.isArray(line)
      || !Number.isFinite(line.time) || line.time < 0 || line.time > 4294967.295
      || typeof line.text !== 'string' || line.text.includes('\0'))
    || value.sylt.reduce((length, line) => length + line.text.length, 0) > 100_000)) {
    invalid('SYLT lyrics require valid timestamps, at most 10,000 lines and 100,000 characters without null characters');
  }
  const updates = {};
  for (const field of metadataFields) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== 'string' || value[field].length > 500 || /[\x00-\x1f\x7f]/.test(value[field])) invalid(`Invalid ${field}`);
    updates[field] = value[field].trim();
  }
  if (Object.hasOwn(value, 'artwork')) {
    if (value.artwork === null) updates.image = null;
    else {
      if (typeof value.artwork !== 'string' || value.artwork.length > 2800000) invalid('Artwork must be at most 2 MB');
      const match = value.artwork.match(/^data:(image\/(?:jpeg|png|webp|avif));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) invalid('Artwork must be a JPEG, PNG, WebP or AVIF image');
      const imageBuffer = Buffer.from(match[2], 'base64');
      if (!imageBuffer.length || imageBuffer.length > 2 * 1024 * 1024 || imageBuffer.toString('base64') !== match[2]) invalid('Invalid artwork data or size');
      const type = await fileTypeFromBuffer(imageBuffer).catch(() => null);
      if (type?.mime !== match[1]) invalid('Artwork content does not match its image type');
      updates.image = { mime: type.mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer };
    }
  }
  const original = await fs.readFile(filePath);
  const tags = NodeID3.read(original);
  if (Object.hasOwn(value, 'rating')) {
    const popularity = tags.popularimeter;
    updates.popularimeter = { email: popularity?.email || 'Windows Media Player 9 Series',
      counter: popularity?.counter || 0, rating: ratingBytes[value.rating] };
  }
  if (Object.hasOwn(value, 'uslt')) {
    updates.unsynchronisedLyrics = value.uslt ? { ...tags.unsynchronisedLyrics,
      language: tags.unsynchronisedLyrics?.language || 'eng', text: value.uslt } : null;
  }
  if (Object.hasOwn(value, 'sylt')) {
    const frames = [...(tags.synchronisedLyrics || [])];
    const selected = frames.findIndex((frame) => frame.timeStampFormat === 2 && frame.contentType === 1);
    if (value.sylt.length) {
      const frame = { ...frames[selected], language: frames[selected]?.language || tags.unsynchronisedLyrics?.language || 'eng',
        timeStampFormat: 2, contentType: 1, synchronisedText: value.sylt.map((line) => ({
          timeStamp: Math.round(line.time * 1000), text: line.text
        })).sort((first, second) => first.timeStamp - second.timeStamp) };
      if (selected === -1) frames.push(frame);
      else frames[selected] = frame;
    } else if (selected !== -1) frames.splice(selected, 1);
    updates.synchronisedLyrics = frames;
  }
  const result = NodeID3.update(updates, original, Object.hasOwn(value, 'sylt') ? { exclude: ['SYLT'] } : {});
  if (!Buffer.isBuffer(result)) throw new Error('Unable to update song metadata');
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, result, { flag: 'wx', mode: (await fs.stat(filePath)).mode });
    await fs.rename(temporary, filePath);
    summaryCache.delete(filePath);
  } finally { await fs.rm(temporary, { force: true }); }
  return readSongMetadata(filePath);
}

export async function readSongMetadata(filePath, { bounded = false } = {}) {
  const tags = path.extname(filePath).toLowerCase() === '.mp3'
    ? bounded
      ? await readBoundedId3Tags(filePath, { include: publicMetadataFrames })
      : await NodeID3.Promise.read(filePath)
    : {};
  const frame = tags.synchronisedLyrics?.find((lyrics) => lyrics.timeStampFormat === 2 && lyrics.contentType === 1);
  const sylt = (frame?.synchronisedText || [])
    .filter((line) => Number.isFinite(line.timeStamp) && line.timeStamp >= 0 && typeof line.text === 'string')
    .map((line) => ({ time: line.timeStamp / 1000, text: line.text }))
    .sort((first, second) => first.time - second.time);
  const image = tags.image;
  const artwork = image && ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(image.mime)
    && image.imageBuffer?.length <= 2 * 1024 * 1024
    ? `data:${image.mime};base64,${image.imageBuffer.toString('base64')}` : null;
  return {
    title: tags.title || path.basename(filePath, path.extname(filePath)),
    artist: tags.artist || '',
    album: tags.album || '',
    performerInfo: tags.performerInfo || '',
    genre: tags.genre || '',
    year: tags.year || '',
    trackNumber: tags.trackNumber || '',
    partOfSet: tags.partOfSet || '',
    rating: songRating(tags),
    artwork,
    sylt,
    uslt: tags.unsynchronisedLyrics?.text || ''
  };
}