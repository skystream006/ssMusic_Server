import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import NodeID3 from 'node-id3';
import { execFileSync } from 'node:child_process';
import { readSongArtwork, readSongSummary } from '../src/music.js';
import { createThumbnailCache, encodeThumbnail } from '../src/artworkThumbnails.js';
import { createThumbnailMaintenance, thumbnailSongs } from '../src/thumbnailMaintenance.js';

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

test('thumbnail cache persists images, avoids repeated tag reads and invalidates changed or removed artwork', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnails-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  const root = path.join(directory, 'cache');
  const thumbnail = Buffer.from('RIFF0000WEBPthumbnail');
  let reads = 0;
  let encodes = 0;
  const options = { root, async readArtwork() { reads++; return { mime: 'image/png', imageBuffer: png }; },
    async encode() { encodes++; return thumbnail; } };
  await fs.writeFile(filePath, 'original');
  const cache = createThumbnailCache(options);
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.read(filePath)));
  assert.ok(results.every((result) => result.equals(thumbnail)));
  assert.equal(reads, 1);
  assert.equal(encodes, 1);
  assert.deepEqual(await createThumbnailCache(options).read(filePath), thumbnail);
  assert.equal(reads, 1, 'cache survives service recreation');
  const before = (await fs.stat(filePath)).mtime;
  await fs.writeFile(filePath, 'changed file');
  await fs.utimes(filePath, before, before);
  await cache.read(filePath);
  assert.equal(reads, 2, 'size/ctime changes invalidate even if mtime is restored');
  await cache.read(filePath, { force: true });
  assert.equal(reads, 3);
  const directories = await fs.readdir(root);
  assert.equal(directories.length, 1);
  assert.equal((await fs.readdir(path.join(root, directories[0]))).length, 1, 'old revisions are removed');
  await fs.writeFile(filePath, 'no artwork');
  const missing = createThumbnailCache({ ...options, async readArtwork() { reads++; return null; } });
  assert.equal(await missing.read(filePath), null);
  assert.equal(await missing.read(filePath), null);
  assert.equal(reads, 4, 'missing covers are cached too');
  assert.equal(await cache.read(filePath), null, 'old artwork cannot reappear after removal');
  await cache.remove(filePath);
  assert.deepEqual(await fs.readdir(root), []);
});

test('thumbnail cache discards work when a source changes and retries transient encoding failures', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnails-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  await fs.writeFile(filePath, 'original');
  let encodes = 0;
  const cache = createThumbnailCache({ root: path.join(directory, 'cache'),
    readArtwork: async () => ({}),
    async encode() {
      encodes++;
      if (encodes === 1) throw new Error('Temporary encoder failure');
      if (encodes === 2) await fs.writeFile(filePath, 'changed during encoding');
      return Buffer.from(`RIFF0000WEBP${encodes}`);
    } });
  await assert.rejects(cache.read(filePath), /Temporary encoder failure/);
  assert.deepEqual(await cache.read(filePath), Buffer.from('RIFF0000WEBP3'));
  assert.equal(encodes, 3);
  assert.deepEqual(await cache.read(filePath), Buffer.from('RIFF0000WEBP3'));
  assert.equal(encodes, 3);
});

test('thumbnail generation limits concurrent encoders to two', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnails-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  let running = 0;
  let maximum = 0;
  const cache = createThumbnailCache({ root: path.join(directory, 'cache'),
    readArtwork: async () => ({}),
    async encode() {
      maximum = Math.max(maximum, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return Buffer.from('RIFF0000WEBPthumbnail');
    } });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const file = path.join(directory, `${index}.mp3`);
    await fs.writeFile(file, 'audio');
    await cache.read(file);
  }));
  assert.equal(maximum, 2);
});

test('cached reads bypass busy encoders and survive a concurrent failed rebuild', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnails-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = ['playing.mp3', 'cached.mp3', 'uncached.mp3'].map((name) => path.join(directory, name));
  await Promise.all(files.map((file) => fs.writeFile(file, 'audio')));
  const thumbnail = Buffer.from('RIFF0000WEBPthumbnail');
  let block = false;
  let entered = 0;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const busy = new Promise((resolve) => { started = resolve; });
  const cache = createThumbnailCache({ root: path.join(directory, 'cache'),
    readArtwork: async () => ({}), async encode() {
      if (block) {
        if (++entered === 2) started();
        await gate;
        throw new Error('Encoder unavailable');
      }
      return thumbnail;
    } });
  await cache.read(files[0]);
  await cache.read(files[1]);
  block = true;
  const rebuild = cache.read(files[0], { force: true }).catch((error) => error);
  const other = cache.read(files[2]).catch((error) => error);
  await busy;
  let timeout;
  try {
    const result = await Promise.race([
      Promise.all([cache.read(files[0]), cache.read(files[1])]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cached reads waited for encoding')), 500); })
    ]);
    assert.deepEqual(result, [thumbnail, thumbnail]);
  } finally { clearTimeout(timeout); release(); }
  assert.match((await rebuild).message, /Encoder unavailable/);
  assert.match((await other).message, /Encoder unavailable/);
  assert.deepEqual(await cache.read(files[0]), thumbnail);
});

test('cache removal after source deletion waits for any outstanding thumbnail publication', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-thumbnails-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  const root = path.join(directory, 'cache');
  await fs.writeFile(filePath, 'audio');
  let release;
  let publicationReady;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { publicationReady = resolve; });
  const rename = fs.rename;
  context.mock.method(fs, 'rename', async (...args) => {
    publicationReady();
    await gate;
    return rename(...args);
  });
  const cache = createThumbnailCache({ root, readArtwork: async () => ({}),
    encode: async () => Buffer.from('RIFF0000WEBPthumbnail') });
  const generating = cache.read(filePath);
  await ready;
  await fs.unlink(filePath);
  const removing = cache.remove(filePath);
  release();
  await generating;
  await removing;
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(cache.read(filePath), { code: 'ENOENT' });
});

test('FFmpeg encodes bounded 96px WebP thumbnails without modifying original artwork', async (context) => {
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const bin = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  try { await fs.access(path.join(bin, `ffmpeg${suffix}`)); }
  catch { context.skip('FFmpeg runtime is not installed'); return; }
  const source = execFileSync(path.join(bin, `ffmpeg${suffix}`), ['-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc=size=640x360', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
  const original = Buffer.from(source);
  const thumbnail = await encodeThumbnail({ mime: 'image/png', imageBuffer: source });
  const probe = JSON.parse(execFileSync(path.join(bin, `ffprobe${suffix}`), ['-v', 'error',
    '-show_entries', 'stream=codec_name,width,height', '-of', 'json', 'pipe:0'], { input: thumbnail }));
  assert.deepEqual(probe.streams, [{ codec_name: 'webp', width: 96, height: 96 }]);
  assert.ok(thumbnail.length < source.length);
  assert.ok(thumbnail.length <= 64 * 1024);
  assert.deepEqual(source, original);
  await assert.rejects(encodeThumbnail({ mime: 'image/png', imageBuffer: Buffer.from('broken') }), /could not generate|Invalid artwork/);
});

test('thumbnail maintenance is single-flight, reports progress, continues after errors and can run again', async (context) => {
  context.mock.method(console, 'warn', () => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = [];
  const maintenance = createThumbnailMaintenance({
    async *songs() { await gate; yield 'cover'; yield 'missing'; yield 'broken'; },
    resolveFile: async (song) => song,
    async generate(song, value) {
      options.push(value);
      if (song === 'broken') throw new Error('Invalid image');
      return song === 'cover' ? Buffer.from('thumbnail') : null;
    }
  });
  assert.equal(maintenance.status().running, false);
  assert.equal(maintenance.start().running, true);
  assert.throws(() => maintenance.start(), { statusCode: 409 });
  release();
  await maintenance.wait();
  const state = maintenance.status();
  assert.equal(state.running, false);
  assert.equal(state.processed, 3);
  assert.equal(state.generated, 1);
  assert.equal(state.missing, 1);
  assert.equal(state.failed, 1);
  assert.ok(state.startedAt && state.completedAt && state.error);
  assert.ok(options.every((value) => value.force === true));
  maintenance.start();
  await maintenance.wait();
  assert.equal(maintenance.status().processed, 3);
});

test('thumbnail maintenance releases its running state after catalog errors', async (context) => {
  context.mock.method(console, 'warn', () => {});
  const maintenance = createThumbnailMaintenance({
    async *songs() { throw new Error('Database unavailable'); }, resolveFile() {}
  });
  maintenance.start();
  await maintenance.wait();
  assert.equal(maintenance.status().running, false);
  assert.match(maintenance.status().error, /could not finish/);
});

test('thumbnail catalog iteration uses bounded keyset batches rather than loading all jobs', async () => {
  const calls = [];
  const database = { prepare(sql) {
    assert.match(sql, /LIMIT 100/);
    assert.match(sql, /lower\(songs.name\) LIKE '%\.mp3'/);
    return { async all(...cursor) {
      calls.push(cursor);
      return calls.length === 1 ? [{ job_id: 'first', name: 'A.mp3' }, { job_id: 'second', name: 'B.mp3' }] : [];
    } };
  } };
  const rows = [];
  for await (const row of thumbnailSongs(database)) rows.push(row);
  assert.equal(rows.length, 2);
  assert.deepEqual(calls, [[null, null], ['second', 'B.mp3']]);
});
