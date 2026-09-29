import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countMediaFiles, createMediaCountMonitor, getTranscriptionHealth } from '../src/health.js';
import { audioExtensions, videoExtensions } from '../src/media.js';

test('media count includes audio and video across jobs, without counting links, missing files or non-media', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-media-count-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [...audioExtensions, ...videoExtensions].map((extension) => `File${extension.toUpperCase()}`);
  await fs.mkdir(path.join(directory, '[NoVocals]'));
  files.push('[NoVocals]/Instrumental.mp3');
  await Promise.all([...files, 'cover.jpg', 'playlist.m3u8', 'video.mp4.part', '.download-archive.txt']
    .map((name) => fs.writeFile(path.join(directory, name), 'fixture')));
  await fs.mkdir(path.join(directory, 'directory.mp3'));
  const jobs = [
    { id: 'owner', outputDir: directory, files: [...files, 'missing.mp3', 'directory.mp3', 'cover.jpg', 'playlist.m3u8', 'video.mp4.part', '.download-archive.txt'] },
    { id: 'other-owner', outputDir: path.join(directory, '.'), files },
    { id: 'linked-playlist', outputDir: directory, files: [] },
    { id: 'pending', files: [] }
  ];
  assert.equal(await countMediaFiles(jobs), files.length);
  await fs.unlink(path.join(directory, files[0]));
  assert.equal(await countMediaFiles(jobs), files.length - 1);
  assert.equal(await countMediaFiles([]), 0);
});

test('media count scans at startup and hourly, while status reads retain the last scan timestamp', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-23T10:00:00Z') });
  let count = 12;
  const scan = context.mock.fn(async () => count);
  const monitor = createMediaCountMonitor(scan);
  context.after(monitor.stop);
  assert.equal((await monitor.getStatus()).scanning, true);
  await monitor.ready;
  const initial = { totalFiles: 12, scannedAt: '2026-09-23T10:00:00.000Z', scanning: false, error: null };
  assert.deepEqual((await monitor.getStatus()), initial);
  count = 20;
  context.mock.timers.tick(3_599_999);
  for (let index = 0; index < 10; index += 1) assert.deepEqual((await monitor.getStatus()), initial);
  assert.equal(scan.mock.callCount(), 1);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(scan.mock.callCount(), 2);
  assert.deepEqual((await monitor.getStatus()), { ...initial, totalFiles: 20, scannedAt: '2026-09-23T11:00:00.000Z' });
  monitor.stop();
  context.mock.timers.tick(3_600_000);
  assert.equal(scan.mock.callCount(), 2);
});

test('media scan failures preserve the last successful count and timestamp until an hourly retry succeeds', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-23T10:00:00Z') });
  let failing = false;
  const monitor = createMediaCountMonitor(async () => {
    if (failing) throw new Error('Private filesystem path');
    return 0;
  });
  context.after(monitor.stop);
  await monitor.ready;
  const initial = (await monitor.getStatus());
  failing = true;
  context.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.deepEqual((await monitor.getStatus()), { ...initial, error: 'Media count scan failed' });
  failing = false;
  context.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.deepEqual((await monitor.getStatus()), { ...initial, scannedAt: '2026-09-23T12:00:00.000Z' });
});

test('hourly ticks never overlap a pending media count scan', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let complete;
  const scan = context.mock.fn(() => new Promise((resolve) => { complete = resolve; }));
  const monitor = createMediaCountMonitor(scan);
  context.after(monitor.stop);
  context.mock.timers.tick(7_200_000);
  assert.equal(scan.mock.callCount(), 1);
  assert.deepEqual((await monitor.getStatus()), { totalFiles: null, scannedAt: null, scanning: true, error: null });
  complete(5);
  await monitor.ready;
  assert.equal((await monitor.getStatus()).totalFiles, 5);
});

function configureEndpoint(context, endpoint = 'http://transcription:4317/api/transcribe') {
  const previous = process.env.TRANSCRIPTION_ENDPOINT;
  process.env.TRANSCRIPTION_ENDPOINT = endpoint;
  context.after(() => {
    if (previous === undefined) delete process.env.TRANSCRIPTION_ENDPOINT;
    else process.env.TRANSCRIPTION_ENDPOINT = previous;
  });
}

test('transcription health skips requests when not configured', async (context) => {
  configureEndpoint(context, ' ');
  const probe = context.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected request'));
  assert.equal((await getTranscriptionHealth()).status, 'inactive');
  assert.equal(probe.mock.callCount(), 0);
});

test('transcription health uses a bounded HEAD probe and accepts POST-only endpoints', async (context) => {
  configureEndpoint(context);
  for (const status of [200, 204, 405]) {
    const probe = context.mock.method(globalThis, 'fetch', async (endpoint, options) => {
      assert.equal(endpoint, 'http://transcription:4317/api/transcribe');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body, undefined);
      return new Response(null, { status });
    });
    assert.equal((await getTranscriptionHealth()).status, 'active');
    probe.mock.restore();
  }
});

test('transcription health treats HTTP errors and redirects as active without leaking the endpoint', async (context) => {
  configureEndpoint(context, 'http://transcription:4317/api/transcribe?token=secret');
  for (const status of [301, 401, 403, 404, 500, 503]) {
    const probe = context.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    assert.deepEqual(await getTranscriptionHealth(), {
      status: 'active', message: `Endpoint returned HTTP ${status}`
    });
    probe.mock.restore();
  }
});

test('transcription health reports network failures without throwing', async (context) => {
  configureEndpoint(context);
  context.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await getTranscriptionHealth(), {
    status: 'inactive', message: 'Unable to connect to endpoint'
  });
});

test('transcription health reports timeouts without throwing', async (context) => {
  configureEndpoint(context);
  context.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  });
  assert.deepEqual(await getTranscriptionHealth(), {
    status: 'inactive', message: 'Endpoint timed out after 2 seconds'
  });
});