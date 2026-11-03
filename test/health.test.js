import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';
import { countMediaFiles, scanMediaFiles, createMediaCountMonitor, getJobStorageBytes, getSystemHealth, getTranscriptionHealth } from '../src/health.js';
import { audioExtensions, videoExtensions } from '../src/media.js';

for (const storagePath of [undefined, '/app/import-storage']) {
test(`system health reports only the ${storagePath ? 'configured host drive instead of the Docker filesystem' : 'filesystem containing the server application'}`, async (context) => {
  const previous = process.env.HEALTH_STORAGE_PATH;
  if (storagePath) process.env.HEALTH_STORAGE_PATH = storagePath;
  else delete process.env.HEALTH_STORAGE_PATH;
  context.after(() => {
    if (previous === undefined) delete process.env.HEALTH_STORAGE_PATH;
    else process.env.HEALTH_STORAGE_PATH = previous;
  });
  configureEndpoint(context, '');
  context.mock.method(si, 'currentLoad', async () => ({ currentLoad: 12 }));
  context.mock.method(si, 'mem', async () => ({ total: 100, active: 40, available: 60 }));
  context.mock.method(si, 'networkStats', async () => []);
  const allDrives = context.mock.method(si, 'fsSize', async () => [
    { size: 100_000_000, available: 50_000_000 },
    { size: 200_000_000, available: 150_000_000 }
  ]);
  const filesystem = context.mock.method(fs, 'statfs', async (directory) => {
    if (storagePath) assert.equal(directory, storagePath);
    else assert.equal(directory.href, new URL('../', import.meta.url).href);
    return { blocks: 2000, bsize: 4096, bfree: 500, bavail: 400 };
  });
  const health = await getSystemHealth();
  assert.deepEqual(health.storage, { totalBytes: 8_192_000, freeBytes: 1_638_400 });
  assert.equal(health.cpu.usagePercent, 12);
  assert.equal(filesystem.mock.callCount(), 1);
  if (storagePath) {
    context.mock.method(fs, 'statfs', async (directory) => {
      assert.equal(directory, storagePath);
      throw Object.assign(new Error('Host mount unavailable'), { code: 'ENOENT' });
    });
    await assert.rejects(getSystemHealth(), { code: 'ENOENT' });
  }
  assert.equal(allDrives.mock.callCount(), 0);
});
}

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

test('media usage groups actual song files and storage by owner without counting playlist references twice', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-media-usage-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstDirectory = path.join(directory, 'first');
  const secondDirectory = path.join(directory, 'second');
  await fs.mkdir(path.join(firstDirectory, '[NoVocals]'), { recursive: true });
  await fs.mkdir(secondDirectory);
  await fs.mkdir(path.join(firstDirectory, 'directory.mp3'));
  const fixtures = [
    ['first/Song.MP3', 10], ['first/[NoVocals]/Song.flac', 7], ['first/Video.mp4', 20],
    ['first/cover.jpg', 100], ['second/Song.mp3', 5], ['unowned.mp3', 3]
  ];
  await Promise.all(fixtures.map(([name, size]) => fs.writeFile(path.join(directory, name), Buffer.alloc(size))));
  const jobs = [
    { initiatedBy: { id: 'first' }, contributors: [{ id: 'second' }], outputDir: firstDirectory,
      files: ['Song.MP3', '[NoVocals]/Song.flac', 'Video.mp4', 'cover.jpg', 'missing.mp3', 'directory.mp3', '../unowned.mp3'] },
    { initiatedBy: { id: 'first' }, outputDir: path.join(firstDirectory, '.'), files: ['Song.MP3', 'Video.mp4'] },
    { initiatedBy: { id: 'second' }, outputDir: secondDirectory, files: ['Song.mp3', 'Song.mp3'] },
    { initiatedBy: { id: 'linked-playlist' }, outputDir: firstDirectory, files: [] },
    { initiatedBy: { id: 'pending' }, files: [] },
    { outputDir: directory, files: ['unowned.mp3'] }
  ];
  assert.deepEqual(await scanMediaFiles(jobs), {
    totalFiles: 5, totalBytes: 45,
    byUser: {
      first: { totalFiles: 3, songFiles: 2, totalBytes: 37 },
      second: { totalFiles: 1, songFiles: 1, totalBytes: 5 }
    }
  });
  assert.deepEqual(await scanMediaFiles([]), { totalFiles: 0, totalBytes: 0, byUser: {} });
});

test('job storage totals actual visible files without duplicates, missing files or escaped paths', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-job-size-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputDir = path.join(directory, 'job');
  await fs.mkdir(path.join(outputDir, '[NoVocals]'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'directory.mp3'));
  for (const [name, size] of [['Song.mp3', 10], ['Video.mp4', 20], ['[NoVocals]/Song.wav', 5], ['cover.jpg', 4]]) {
    await fs.writeFile(path.join(outputDir, name), Buffer.alloc(size));
  }
  await fs.writeFile(path.join(directory, 'outside.mp3'), Buffer.alloc(100));
  const job = { outputDir, files: ['Song.mp3', 'Video.mp4', '[NoVocals]/Song.wav', 'cover.jpg', 'Song.mp3',
    'missing.mp3', 'directory.mp3', '../outside.mp3', path.join(directory, 'outside.mp3'), null] };
  assert.equal(await getJobStorageBytes(job), 39);
  assert.equal(await getJobStorageBytes({ ...job, files: ['Video.mp4'] }), 20);
  await fs.unlink(path.join(outputDir, 'Song.mp3'));
  await fs.writeFile(path.join(outputDir, 'Video.mp4'), Buffer.alloc(25));
  assert.equal(await getJobStorageBytes(job), 34);
  assert.equal(await getJobStorageBytes({ files: ['Song.mp3'] }), 0);
  assert.equal(await getJobStorageBytes({ outputDir, files: [] }), 0);
  assert.equal(await getJobStorageBytes({ outputDir: path.join(directory, 'missing'), files: ['Song.mp3'] }), 0);
});

test('job storage rejects external symlink targets and reports inaccessible storage as unknown', async (context) => {
  const outputDir = path.resolve('job-storage');
  context.mock.method(fs, 'realpath', async (filePath) => filePath === outputDir ? outputDir : path.resolve('outside.mp3'));
  const stat = context.mock.method(fs, 'stat', async () => assert.fail('Must not inspect files outside the job'));
  assert.equal(await getJobStorageBytes({ outputDir, files: ['link.mp3'] }), 0);
  assert.equal(stat.mock.callCount(), 0);
  context.mock.method(fs, 'realpath', async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); });
  assert.equal(await getJobStorageBytes({ outputDir, files: ['Song.mp3'] }), null);
});

test('media usage scans at startup and daily, while status reads retain the last scan timestamp', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-23T10:00:00Z') });
  let usage = { totalFiles: 12, totalBytes: 100, byUser: { owner: { totalFiles: 12, songFiles: 12, totalBytes: 100 } } };
  const scan = context.mock.fn(async () => usage);
  const monitor = createMediaCountMonitor(scan);
  context.after(monitor.stop);
  assert.equal((await monitor.getStatus()).scanning, true);
  await monitor.ready;
  const initial = { ...usage, scannedAt: '2026-09-23T10:00:00.000Z', scanning: false, error: null };
  assert.deepEqual((await monitor.getStatus()), initial);
  usage = { totalFiles: 20, totalBytes: 200, byUser: { owner: { totalFiles: 20, songFiles: 20, totalBytes: 200 } } };
  context.mock.timers.tick(86_399_999);
  for (let index = 0; index < 10; index += 1) assert.deepEqual((await monitor.getStatus()), initial);
  assert.equal(scan.mock.callCount(), 1);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(scan.mock.callCount(), 2);
  assert.deepEqual((await monitor.getStatus()), { ...initial, ...usage, scannedAt: '2026-09-24T10:00:00.000Z' });
  monitor.stop();
  context.mock.timers.tick(86_400_000);
  assert.equal(scan.mock.callCount(), 2);
});

test('media scan failures preserve the last successful usage and timestamp until a daily retry succeeds', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-23T10:00:00Z') });
  let failing = false;
  const usage = { totalFiles: 2, totalBytes: 10, byUser: { owner: { totalFiles: 2, songFiles: 2, totalBytes: 10 } } };
  const monitor = createMediaCountMonitor(async () => {
    if (failing) throw new Error('Private filesystem path');
    return usage;
  });
  context.after(monitor.stop);
  await monitor.ready;
  const initial = (await monitor.getStatus());
  failing = true;
  context.mock.timers.tick(86_400_000);
  await Promise.resolve();
  assert.deepEqual((await monitor.getStatus()), { ...initial, error: 'Media count scan failed' });
  failing = false;
  context.mock.timers.tick(86_400_000);
  await Promise.resolve();
  assert.deepEqual((await monitor.getStatus()), { ...initial, scannedAt: '2026-09-25T10:00:00.000Z' });
});

test('daily ticks never overlap a pending media usage scan', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let complete;
  const scan = context.mock.fn(() => new Promise((resolve) => { complete = resolve; }));
  const monitor = createMediaCountMonitor(scan);
  context.after(monitor.stop);
  context.mock.timers.tick(172_800_000);
  assert.equal(scan.mock.callCount(), 1);
  assert.deepEqual((await monitor.getStatus()), { totalFiles: null, totalBytes: null, byUser: null, scannedAt: null, scanning: true, error: null });
  complete({ totalFiles: 5, totalBytes: 10, byUser: {} });
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