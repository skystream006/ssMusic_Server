import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createVideoCache, encodeAdaptiveVideo, serveAdaptiveVideo } from '../src/videoCache.js';

const week = 7 * 24 * 60 * 60_000;

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-hls-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'Video.mp4');
  await fs.writeFile(source, 'original video');
  return { directory, source, root: path.join(directory, '.cache') };
}

async function fakeEncode(_source, target) {
  for (const name of ['480p', 'original']) {
    await fs.mkdir(path.join(target, name));
    await fs.writeFile(path.join(target, name, 'index.m3u8'), '#EXTM3U\n#EXTINF:4,\nsegment-000000.ts\n#EXT-X-ENDLIST\n');
    await fs.writeFile(path.join(target, name, 'segment-000000.ts'), 'video segment');
  }
  await fs.writeFile(path.join(target, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n480p/index.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=4000000\noriginal/index.m3u8\n');
}

async function prepare(cache, source) {
  const entry = await cache.acquire(source);
  try { if (!entry.ready) await entry.done; return entry; }
  finally { entry.release(); }
}

test('HLS cache deduplicates generation, survives restarts, invalidates replacements, and never modifies originals', async (context) => {
  const { source, root } = await fixture(context);
  let encodes = 0;
  const encode = async (...args) => { encodes++; await fakeEncode(...args); };
  const cache = createVideoCache({ root, encode });
  const entries = await Promise.all(Array.from({ length: 5 }, () => prepare(cache, source)));
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 1);
  assert.equal(encodes, 1);
  const restored = await createVideoCache({ root, encode }).acquire(source);
  assert.equal(restored.ready, true);
  restored.release();
  assert.equal(encodes, 1);
  assert.equal(await fs.readFile(source, 'utf8'), 'original video');
  await fs.writeFile(source, 'replaced original video');
  assert.notEqual((await prepare(cache, source)).key, entries[0].key);
  assert.equal(encodes, 2);
});

test('disabling caching blocks cached reads and queued conversions while preserving reusable files', async (context) => {
  const { source, directory, root } = await fixture(context);
  let enabled = true;
  let encodes = 0;
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const cache = createVideoCache({ root, isEnabled: async () => enabled, async encode(input, output) {
    encodes++;
    started.resolve();
    await gate.promise;
    await fakeEncode(input, output);
  } });
  context.mock.method(console, 'error', () => {});
  const first = await cache.acquire(source);
  await started.promise;
  const other = path.join(directory, 'Other.mp4');
  await fs.writeFile(other, 'other');
  const queued = await cache.acquire(other);
  const rejected = assert.rejects(queued.done, { statusCode: 409 });
  enabled = false;
  gate.resolve();
  await first.done;
  await rejected;
  first.release();
  queued.release();
  assert.equal(encodes, 1);
  await assert.rejects(cache.acquire(source), { statusCode: 409 });
  assert.ok(await fs.stat(first.directory));
  enabled = true;
  const restored = await cache.acquire(source);
  assert.equal(restored.ready, true);
  restored.release();
  assert.equal(encodes, 1);
});

test('disabled HLS responses preserve public scopes and still authorize without accessing the cache', async (context) => {
  const { source, root } = await fixture(context);
  const cache = createVideoCache({ root, isEnabled: async () => false,
    encode: () => { throw new Error('Must not encode'); } });
  let allowed = true;
  const app = express();
  const router = express.Router();
  router.get('/media/token/stream', async (req, res) => {
    try {
      await serveAdaptiveVideo(req, res, async () => {
        if (!allowed) throw Object.assign(new Error('Revoked'), { statusCode: 404 });
        return source;
      }, cache);
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  app.use('/api/public', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/public/media/token/stream?format=hls&userId=owner&v=123&asset=old`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), {
    status: 'disabled', streamUrl: '/api/public/media/token/stream?userId=owner&v=123'
  });
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  allowed = false;
  assert.equal((await fetch(url)).status, 404);
});

test('cache misses immediately play originals while one background encode runs, including with a busy queue', async (context) => {
  const { source, directory, root } = await fixture(context);
  const other = path.join(directory, 'Other.mp4');
  await fs.writeFile(other, 'other video');
  const gate = Promise.withResolvers();
  let encodes = 0;
  const cache = createVideoCache({ root, maxPending: 1, async encode(input, output) {
    encodes++;
    await gate.promise;
    await fakeEncode(input, output);
  } });
  const errors = [];
  context.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  let allowed = true;
  const app = express();
  app.get('/stream', async (req, res) => {
    try {
      await serveAdaptiveVideo(req, res, async () => {
        if (!allowed) throw Object.assign(new Error('Revoked'), { statusCode: 404 });
        return req.query.other ? other : source;
      }, cache);
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/stream?format=hls&userId=owner`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'original', streamUrl: '/stream?userId=owner' });
    }
    const busy = await fetch(`${url}&other=1`, { signal: AbortSignal.timeout(2000) });
    assert.equal(busy.status, 200);
    assert.deepEqual(await busy.json(), { status: 'original', streamUrl: '/stream?userId=owner&other=1' });
    assert.match(errors.join('\n'), /Video preparation is busy/);
    assert.equal(encodes, 1);
    assert.equal((await cache.getStatus()).preparing, 1);
    allowed = false;
    assert.equal((await fetch(url)).status, 404);
  } finally {
    gate.resolve();
    await prepare(cache, source);
  }
  allowed = true;
  const cached = await fetch(url);
  assert.equal(cached.status, 200);
  assert.match(cached.headers.get('content-type'), /mpegurl/);
  assert.match(await cached.text(), /#EXTM3U/);
  assert.equal(encodes, 1);
});

test('seven-day inactivity is persisted, refreshed by reads, and cleanup protects active requests', async (context) => {
  const { source, root } = await fixture(context);
  let time = Date.now();
  const cache = createVideoCache({ root, encode: fakeEncode, now: () => time });
  const initial = await prepare(cache, source);
  time += 6 * 24 * 60 * 60_000;
  const read = await cache.acquire(source);
  read.release();
  time += 2 * 24 * 60 * 60_000;
  const restarted = createVideoCache({ root, encode: fakeEncode, now: () => time });
  await restarted.prune();
  assert.ok(await fs.stat(initial.directory));
  const held = await restarted.acquire(source);
  time += week;
  await restarted.prune();
  assert.ok(await fs.stat(initial.directory));
  held.release();
  await restarted.prune();
  await assert.rejects(fs.stat(initial.directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(source, 'utf8'), 'original video');
});

test('generation is serialized and bounded; failed output is removed and can be retried', async (context) => {
  const { source, directory, root } = await fixture(context);
  const other = path.join(directory, 'Other.mp4');
  const extra = path.join(directory, 'Extra.mp4');
  await Promise.all([fs.writeFile(other, 'other'), fs.writeFile(extra, 'extra')]);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let running = 0;
  let count = 0;
  const cache = createVideoCache({ root, maxPending: 2, async encode(input, output) {
    assert.equal(++running, 1);
    if (++count === 1) { started.resolve(); await gate.promise; }
    await fakeEncode(input, output);
    running--;
  } });
  const first = await cache.acquire(source);
  await started.promise;
  const second = await cache.acquire(other);
  await assert.rejects(cache.acquire(extra), { statusCode: 429 });
  gate.resolve();
  await Promise.all([first.done, second.done]);
  first.release(); second.release();
  assert.equal(count, 2);
  context.mock.method(console, 'error', () => {});
  const failingRoot = path.join(directory, 'failed');
  let fail = true;
  const failing = createVideoCache({ root: failingRoot, async encode(input, output) {
    if (fail) { await fs.writeFile(path.join(output, 'partial.ts'), 'partial'); throw new Error('Encoder failed'); }
    await fakeEncode(input, output);
  } });
  await assert.rejects(prepare(failing, source), /Encoder failed/);
  assert.deepEqual(await fs.readdir(failingRoot), []);
  const fallback = await failing.acquire(source, { background: true });
  assert.equal(fallback.ready, false);
  assert.match(fallback.error.message, /Encoder failed/);
  fallback.release();
  await assert.rejects(prepare(failing, source), /Encoder failed/);
  await assert.rejects(failing.acquire(source), /Encoder failed/);
  fail = false;
  await prepare(failing, source);
});

test('cache health measures renditions and temporary files without refreshing playback inactivity', async (context) => {
  const { source, root } = await fixture(context);
  let time = Date.now();
  const cache = createVideoCache({ root, encode: fakeEncode, now: () => time });
  assert.deepEqual(await cache.getStatus(), {
    totalVideos: 0, totalBytes: 0, temporaryBytes: 0, preparing: 0, scannedAt: new Date(time).toISOString()
  });
  const entry = await prepare(cache, source);
  const lastPlayback = (await fs.stat(entry.directory)).mtimeMs;
  const completedBytes = (await fs.readFile(path.join(entry.directory, 'master.m3u8'))).length
    + 2 * ((await fs.readFile(path.join(entry.directory, '480p', 'index.m3u8'))).length + Buffer.byteLength('video segment'));
  const temporary = path.join(root, '11111111-1111-4111-8111-111111111111.tmp');
  await fs.mkdir(temporary);
  await fs.writeFile(path.join(temporary, 'partial.ts'), Buffer.alloc(17));
  await fs.mkdir(path.join(root, 'unrelated'));
  await fs.writeFile(path.join(root, 'unrelated', 'ignore.bin'), Buffer.alloc(100));
  await fs.writeFile(path.join(root, 'unrelated.bin'), Buffer.alloc(100));
  const status = await cache.getStatus();
  assert.deepEqual(status, {
    totalVideos: 1, totalBytes: completedBytes + 17, temporaryBytes: 17, preparing: 0,
    scannedAt: new Date(time).toISOString()
  });
  await fs.writeFile(path.join(temporary, 'partial.ts'), Buffer.alloc(25));
  assert.deepEqual(await cache.getStatus(), status);
  time += 30_000;
  assert.equal((await cache.getStatus()).totalBytes, completedBytes + 25);
  assert.equal((await fs.stat(entry.directory)).mtimeMs, lastPlayback);
  time += week;
  await cache.prune();
  assert.equal((await cache.getStatus()).totalVideos, 0);
  assert.equal((await cache.getStatus()).totalBytes, 0);
});

test('cache health exposes pending work and reports filesystem errors instead of empty success', async (context) => {
  const { source, root } = await fixture(context);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const cache = createVideoCache({ root, async encode(input, output) {
    await fs.writeFile(path.join(output, 'partial.ts'), Buffer.alloc(11));
    started.resolve();
    await gate.promise;
    await fakeEncode(input, output);
  } });
  const entry = await cache.acquire(source);
  await started.promise;
  const status = await cache.getStatus();
  assert.equal(status.preparing, 1);
  assert.equal(status.totalVideos, 0);
  assert.equal(status.totalBytes, 11);
  assert.equal(status.temporaryBytes, 11);
  gate.resolve();
  await entry.done;
  entry.release();
  assert.equal((await cache.getStatus()).preparing, 0);
  assert.equal((await cache.getStatus()).totalVideos, 1);
  context.mock.method(fs, 'readdir', async () => { throw Object.assign(new Error('Cache unavailable'), { code: 'EACCES' }); });
  await assert.rejects(createVideoCache({ root }).getStatus(), { code: 'EACCES' });
});

test('source changes during generation cannot publish stale renditions', async (context) => {
  const { source, root } = await fixture(context);
  context.mock.method(console, 'error', () => {});
  const cache = createVideoCache({ root, async encode(input, output) {
    await fakeEncode(input, output);
    await fs.writeFile(input, 'replacement during encoding');
  } });
  await assert.rejects(prepare(cache, source), { statusCode: 409 });
  assert.deepEqual(await fs.readdir(root), []);
});

test('HLS manifests retain scoped URLs; all segments reauthorize, support HEAD/ranges and reject traversal/stale revisions', async (context) => {
  const { source, root } = await fixture(context);
  const cache = createVideoCache({ root, encode: fakeEncode });
  let allowed = true;
  let resolutions = 0;
  const app = express();
  const router = express.Router();
  router.get('/media/token/stream', async (req, res) => {
    try {
      await serveAdaptiveVideo(req, res, async () => {
        resolutions++;
        if (!allowed) throw Object.assign(new Error('Revoked'), { statusCode: 404 });
        return source;
      }, cache);
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  app.use('/api/public', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/public/media/token/stream?format=hls&userId=owner&v=123`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    status: 'original', streamUrl: '/api/public/media/token/stream?userId=owner&v=123'
  });
  await prepare(cache, source);
  const master = await fetch(url);
  assert.equal(master.headers.get('cache-control'), 'private, no-store');
  const variants = (await master.text()).split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(variants.length, 2);
  for (const variant of variants) {
    assert.ok(variant.startsWith('/api/public/media/token/stream?'));
    assert.equal(new URL(variant, origin).searchParams.get('userId'), 'owner');
    assert.equal(new URL(variant, origin).searchParams.get('v'), '123');
  }
  const playlist = await fetch(new URL(variants[0], origin));
  const segment = (await playlist.text()).split('\n').find((line) => line && !line.startsWith('#'));
  const segmentURL = new URL(segment, origin);
  assert.match(segmentURL.searchParams.get('asset'), /\/480p\/segment-000000.ts$/);
  const head = await fetch(segmentURL, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp2t');
  const range = await fetch(segmentURL, { headers: { Range: 'bytes=0-4' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'video');
  assert.ok(resolutions >= 8);
  allowed = false;
  assert.equal((await fetch(segmentURL)).status, 404);
  allowed = true;
  const invalid = new URL(url);
  invalid.searchParams.set('asset', '../master.m3u8');
  assert.equal((await fetch(invalid)).status, 400);
  await fs.writeFile(source, 'new original revision');
  assert.equal((await fetch(segmentURL)).status, 409);
  await prepare(cache, source);
});

test('authorization is checked again after cached video preparation', async (context) => {
  const { source, root } = await fixture(context);
  const cache = createVideoCache({ root, encode: fakeEncode });
  await prepare(cache, source);
  const app = express();
  let checks = 0;
  app.get('/stream', async (req, res) => {
    try {
      await serveAdaptiveVideo(req, res, async () => {
        if (++checks > 1) throw Object.assign(new Error('Revoked'), { statusCode: 404 });
        return source;
      }, cache);
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/stream?format=hls`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /EXTM3U/);
});

test('FFmpeg produces actual aligned 480p and original-resolution HLS with no upscaling or required audio track', async (context) => {
  const { directory } = await fixture(context);
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const bin = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
  const ffmpeg = path.join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = path.join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!await fs.stat(ffmpeg).catch((error) => { if (error.code !== 'ENOENT') throw error; })) {
    context.skip('FFmpeg is not installed'); return;
  }
  for (const [size, audio, expected, sar = '1', original = size.split('x').map(Number)] of [
    ['1280x720', true, [854, 480]], ['320x240', false, [320, 240]],
    ['360x640', false, [270, 480]], ['720x576', false, [640, 480], '16/15', [768, 576]]
  ]) {
    const source = path.join(directory, `${size}.mp4`);
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=8.5`,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8.5'] : []),
      '-vf', `setsar=${sar}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), source]);
    const output = path.join(directory, `encoded-${size}`);
    await fs.mkdir(output);
    await encodeAdaptiveVideo(source, output);
    const master = await fs.readFile(path.join(output, 'master.m3u8'), 'utf8');
    assert.match(master, /#EXT-X-INDEPENDENT-SEGMENTS/);
    assert.match(master, new RegExp(`RESOLUTION=${expected[0]}x${expected[1]}`));
    const durations = [];
    for (const variant of ['480p', 'original']) {
      const manifest = await fs.readFile(path.join(output, variant, 'index.m3u8'), 'utf8');
      assert.match(manifest, /#EXT-X-ENDLIST/);
      durations.push([...manifest.matchAll(/#EXTINF:([\d.]+)/g)].map((match) => Number(match[1])));
      const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json',
        path.join(output, variant, 'segment-000000.ts')], { encoding: 'utf8' }));
      const video = info.streams.find((stream) => stream.codec_type === 'video');
      assert.equal(video.codec_name, 'h264');
      assert.deepEqual([video.width, video.height], variant === '480p' ? expected : original);
      assert.equal(info.streams.some((stream) => stream.codec_name === 'aac'), audio);
      const frames = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
        '-read_intervals', '%+#1', '-show_entries', 'frame=key_frame', '-of', 'json',
        path.join(output, variant, 'segment-000001.ts')], { encoding: 'utf8' }));
      assert.equal(frames.frames[0].key_frame, 1);
    }
    assert.deepEqual(durations[0], durations[1]);
    assert.ok(durations[0].length >= 3);
  }
});
