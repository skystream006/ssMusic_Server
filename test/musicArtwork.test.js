import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import NodeID3 from 'node-id3';
import { readSongArtwork, readSongSummary } from '../src/music.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('song artwork reads embedded covers without adding image data to song summaries', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-artwork-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.MP3');
  const image = { mime: 'image/png', type: { id: 3 }, description: 'Cover', imageBuffer: png };
  await fs.writeFile(filePath, NodeID3.write({ title: 'Song', image }, Buffer.from('audio')));
  const artwork = await readSongArtwork(filePath);
  assert.equal(artwork.mime, 'image/png');
  assert.deepEqual(artwork.imageBuffer, png);
  const summary = await readSongSummary(filePath, await fs.stat(filePath));
  assert.equal(summary.title, 'Song');
  assert.equal(summary.artwork, undefined);
});

test('song artwork ignores absent, unsupported, mismatched and oversized images', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-artwork-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  for (const image of [
    undefined,
    { mime: 'image/png', imageBuffer: Buffer.alloc(0) },
    { mime: 'image/png', imageBuffer: Buffer.from('<script>alert(1)</script>') },
    { mime: 'image/svg+xml', imageBuffer: Buffer.from('<svg/>') },
    { mime: 'image/jpeg', imageBuffer: png },
    { mime: 'image/png', imageBuffer: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]) }
  ]) {
    await fs.writeFile(filePath, NodeID3.write(image ? { image: { ...image, type: { id: 3 } } } : {}, Buffer.from('audio')));
    assert.equal(await readSongArtwork(filePath), null);
  }
  await fs.writeFile(filePath, 'untagged audio');
  assert.equal(await readSongArtwork(filePath), null);
  assert.equal(await readSongArtwork(path.join(directory, 'Song.flac')), null);
});

test('song artwork rejects malformed, compressed and excessive ID3 tags', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-artwork-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  const tags = NodeID3.create({ image: { mime: 'image/png', type: { id: 3 }, imageBuffer: png } });
  const compressed = Buffer.from(tags);
  compressed[19] |= 0x80;
  const malformed = Buffer.from(tags);
  malformed.writeUInt32BE(0xffffffff, 14);
  const oversized = Buffer.from(tags);
  oversized.set([8, 0, 0, 0], 6);
  for (const buffer of [compressed, malformed, oversized, tags.subarray(0, 12)]) {
    await fs.writeFile(filePath, buffer);
    assert.equal(await readSongArtwork(filePath), null);
  }
});
