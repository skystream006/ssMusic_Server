import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { replaceTranscribedFiles } from '../src/transcription.js';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const fixtureCleanups = new WeakMap();

beforeEach(async (testContext) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-job-db-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  testContext.after(async () => {
    await fixtureCleanups.get(testContext)?.();
    closeDatabases();
    return fs.rm(directory, { recursive: true, force: true });
  });
});

async function makeFakeBin(dir, name, { delayMs = 0 } = {}) {
  const scriptPath = path.join(dir, name);
  const script = `#!/bin/sh\nsleep ${delayMs / 1000}\nexit 0\n`;
  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

async function waitForJobToFinish(job) {
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await fs.stat(file).catch(() => null)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${file}`);
}

async function makeMetadataFixture(t, metadata) {
  const directory = path.dirname(process.env.DATABASE_PATH);
  const configPath = path.join(directory, 'metadata.json');
  const file = (name) => path.join(directory, name);
  await fs.writeFile(configPath, JSON.stringify(metadata));
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const directory = __dirname;
const args = process.argv.slice(2);
const metadata = args.includes('--dump-single-json');
const phase = metadata ? 'metadata' : 'download';
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify(args) + '\\n');
fs.writeFileSync(path.join(directory, phase + '-started'), '');
const deadline = Date.now() + 10000;
const timer = setInterval(() => {
  if (Date.now() > deadline) process.exit(2);
  if (!fs.existsSync(path.join(directory, phase + '-release'))) return;
  clearInterval(timer);
  if (metadata) {
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
    process.stdout.write(config.output);
    process.exitCode = config.exitCode || 0;
  } else {
    const output = args[args.indexOf('--output') + 1];
    fs.writeFileSync(path.join(path.dirname(output), 'Filename fallback.mp3'), '');
  }
}, 10);
`;
  const executable = file('yt-dlp.cjs');
  await fs.writeFile(executable, script, { mode: 0o755 });
  process.env.YTDLP_PATH = executable;
  process.env.YTDLP_OUTPUT_ROOT = directory;
  const manager = await import(`../src/jobManager.js?source-title=${encodeURIComponent(directory)}`);
  fixtureCleanups.set(t, async () => {
    await fs.writeFile(file('metadata-release'), '');
    await fs.writeFile(file('download-release'), '');
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (!manager.getJobs().some((job) => job.status === 'queued' || job.status === 'running')) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Fixture jobs did not finish');
  });
  return { manager, file, configPath };
}

for (const { label, url, isPlaylist } of [
  { label: 'playlist', url: 'https://music.youtube.com/playlist?list=abc', isPlaylist: true },
  { label: 'video', url: 'https://music.youtube.com/watch?v=abc', isPlaylist: false },
  { label: 'video with list query', url: 'https://music.youtube.com/watch?v=RTcsY6aIoEc&list=PLbMbcPGUE7ak', isPlaylist: true }
]) {
  test(`${label} source title is persisted before downloading and custom titles survive successful reruns`, {
    skip: process.platform === 'win32' && 'requires POSIX executable test fixtures'
  }, async (t) => {
    const title = 'Björk / 東京: “Live” & Soul!';
    const { manager, file, configPath } = await makeMetadataFixture(t, {
      output: JSON.stringify({ title, playlist_count: 12, entries: [{ id: 'one' }] })
    });
    const owner = { id: 'owner', role: 'user' };
    const job = await manager.createJob(url, owner);
    await waitForFile(file('metadata-started'));
    assert.equal(job.playlistTitle, null, 'creation returns before the metadata lookup completes');
    await fs.writeFile(file('metadata-release'), '');
    await waitForFile(file('download-started'));
    const stored = JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get(job.id).data);
    assert.equal(stored.status, 'running');
    assert.equal(stored.playlistTitle, title);
    assert.equal(stored.isPlaylist, isPlaylist);
    assert.equal(stored.playlistSongCount, isPlaylist ? 12 : null);
    assert.deepEqual(stored.files, []);
    if (isPlaylist) {
      const { sanitizeFolderName } = await import('../src/utils.js');
      assert.equal(stored.folderName, `${sanitizeFolderName(title)}_${job.id}`);
    } else {
      assert.match(stored.folderName, /^song_[0-9a-f-]{36}$/);
    }
    assert.equal(stored.outputDir, file(stored.folderName));
    await fs.writeFile(file('download-release'), '');
    await waitForJobToFinish(job);
    assert.equal(job.status, 'completed');
    assert.equal(job.playlistTitle, title);

    await manager.setJobTitle(job.id, 'My custom collection', owner);
    await fs.writeFile(configPath, JSON.stringify({
      output: JSON.stringify({ title: 'Changed source title', playlist_count: 15 })
    }));
    await fs.rm(file('download-started'));
    await fs.rm(file('download-release'));
    const rerun = await manager.rerunJob(job.id, owner);
    await waitForFile(file('download-started'));
    assert.equal(rerun.playlistTitle, 'My custom collection');
    assert.equal(rerun.playlistSongCount, isPlaylist ? 15 : null);
    assert.equal(rerun.folderName, stored.folderName);
    assert.equal(rerun.outputDir, stored.outputDir);
    await fs.writeFile(file('download-release'), '');
    await waitForJobToFinish(rerun);
    assert.equal(rerun.status, 'completed');
    assert.equal(manager.getJob(job.id).playlistTitle, 'My custom collection');
    assert.equal(manager.getJob(job.id).playlistTitleOverride, 'My custom collection');
    const calls = (await fs.readFile(file('calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 4);
    for (const [index, args] of calls.entries()) {
      assert.equal(args.includes('--dump-single-json'), index % 2 === 0);
      assert.ok(args.includes(isPlaylist ? '--yes-playlist' : '--no-playlist'));
      assert.ok(!args.includes(isPlaylist ? '--no-playlist' : '--yes-playlist'));
      assert.equal(args.at(-1), url);
    }
  });
}

for (const isPlaylist of [false, true]) {
  for (const { label, output, exitCode } of [
    { label: 'failed lookup', output: '', exitCode: 1 },
    { label: 'invalid JSON', output: 'not JSON' },
    { label: 'missing title', output: '{"playlist_count":12}' },
    { label: 'blank title', output: '{"title":"  "}' },
    { label: 'non-string title', output: '{"title":42}' }
  ]) {
    test(`${isPlaylist ? 'playlist' : 'video'} ${label} still downloads and falls back to the filename`, {
      skip: process.platform === 'win32' && 'requires POSIX executable test fixtures'
    }, async (t) => {
      const { manager, file } = await makeMetadataFixture(t, { output, exitCode });
      const job = await manager.createJob(isPlaylist
        ? 'https://music.youtube.com/playlist?list=fallback'
        : 'https://music.youtube.com/watch?v=fallback');
      await fs.writeFile(file('metadata-release'), '');
      await waitForFile(file('download-started'));
      assert.equal(job.playlistTitle, null);
      assert.match(job.folderName, /^song_[0-9a-f-]{36}$/);
      await fs.writeFile(file('download-release'), '');
      await waitForJobToFinish(job);
      assert.equal(job.status, 'completed');
      assert.equal(job.error, null);
      assert.equal(job.playlistTitle, 'Filename fallback');
      assert.equal(manager.getJob(job.id).playlistTitle, 'Filename fallback');
    });
  }
}

for (const isPlaylist of [false, true]) {
  test(`metadata-only ${isPlaylist ? 'playlist' : 'track'} jobs skip initial media downloads but download on rerun`, async (t) => {
    const calls = [];
    const spawnMock = t.mock.method(childProcess, 'spawn', (command, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end(JSON.stringify({ title: 'My collection', playlist_count: 12 }));
        child.emit('close', 0);
      });
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
    process.env.YTDLP_OUTPUT_ROOT = path.dirname(process.env.DATABASE_PATH);
    const manager = await import(`../src/jobManager.js?metadata-only=${isPlaylist}`);
    const owner = { id: 'owner', role: 'user' };
    const url = isPlaylist ? 'https://music.youtube.com/playlist?list=manual' : 'https://music.youtube.com/watch?v=manual';
    const job = await manager.createJob(url, owner, { metadataOnly: true });
    await waitForJobToFinish(job);
    assert.equal(job.status, 'completed');
    assert.equal(job.metadataOnly, true);
    assert.equal(job.playlistTitle, 'My collection');
    assert.equal(job.playlistSongCount, isPlaylist ? 12 : null);
    assert.ok((await fs.stat(job.outputDir)).isDirectory());
    assert.deepEqual(job.files, []);
    assert.equal(job.command, null);
    assert.match(job.output, /Media download skipped/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--skip-download'));
    assert.ok(calls[0].includes('--dump-single-json'));
    assert.ok(calls[0].includes(isPlaylist ? '--yes-playlist' : '--no-playlist'));
    assert.equal(manager.getJob(job.id).metadataOnly, true);

    if (isPlaylist) {
      const uploadPath = path.join(process.env.YTDLP_OUTPUT_ROOT, 'Upload.mp3');
      await fs.writeFile(uploadPath, 'original audio');
      const uploaded = await manager.importJobFiles({ playlistId: job.id, files: [{ name: 'My own song.mp3', path: uploadPath }] }, owner);
      assert.equal(uploaded.status, 'completed');
      assert.equal(uploaded.outputDir, job.outputDir);
      assert.deepEqual(uploaded.files, ['My own song.mp3']);
    } else {
      await fs.writeFile(path.join(job.outputDir, 'My own song.mp3'), 'original audio');
    }
    await manager.setJobTitle(job.id, 'Custom title', owner);
    const rerun = await manager.rerunJob(job.id, owner);
    await waitForJobToFinish(rerun);
    assert.equal(rerun.status, 'completed');
    assert.equal(rerun.metadataOnly, false);
    assert.equal(manager.getJob(job.id).metadataOnly, false);
    assert.equal(rerun.outputDir, job.outputDir);
    assert.equal(rerun.playlistTitle, 'Custom title');
    assert.deepEqual(rerun.files, ['My own song.mp3']);
    assert.equal(await fs.readFile(path.join(job.outputDir, 'My own song.mp3'), 'utf8'), 'original audio');
    assert.equal(calls.length, 3);
    assert.ok(calls[1].includes('--skip-download'));
    assert.ok(calls[2].includes('--extract-audio'));
    assert.ok(calls[2].includes('--no-overwrites'));
    assert.ok(!calls[2].includes('--skip-download'));
  });
}

for (const metadataOnly of [false, true]) {
  test(`video jobs preserve their format on rerun with metadataOnly=${metadataOnly}`, async (t) => {
    const calls = [];
    const spawnMock = t.mock.method(childProcess, 'spawn', (command, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.end(JSON.stringify({ title: 'My video' }));
        child.emit('close', 0);
      });
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
    process.env.YTDLP_OUTPUT_ROOT = path.dirname(process.env.DATABASE_PATH);
    const manager = await import(`../src/jobManager.js?video=${metadataOnly}`);
    const owner = { id: 'owner', role: 'user' };
    const url = 'https://www.youtube.com/watch?v=video';
    for (const downloadType of ['mp4', '', null, true, {}]) {
      await assert.rejects(manager.createJob(url, owner, { downloadType }), { statusCode: 400 });
    }
    const audio = await manager.createJob(url, owner);
    await waitForJobToFinish(audio);
    assert.equal(audio.downloadType, 'audio');
    assert.ok(calls.at(-1).includes('--extract-audio'));
    delete audio.downloadType;
    writeJob(openDatabase(), audio);
    await assert.rejects(manager.createJob(url, owner), (error) => {
      assert.equal(error.code, 'JOB_ALREADY_EXISTS');
      assert.equal(error.existingJob.id, audio.id);
      return true;
    });
    calls.length = 0;
    const job = await manager.createJob(url, owner, { downloadType: 'video', metadataOnly });
    await waitForJobToFinish(job);
    assert.equal(job.status, 'completed');
    assert.equal(manager.getJob(job.id).downloadType, 'video');
    assert.notEqual(job.outputDir, audio.outputDir);
    assert.equal(calls.length, metadataOnly ? 1 : 2);
    await assert.rejects(manager.createJob(url, owner, { downloadType: 'video' }), (error) => {
      assert.equal(error.code, 'JOB_ALREADY_EXISTS');
      assert.equal(error.existingJob.id, job.id);
      return true;
    });
    const rerun = await manager.rerunJob(job.id, owner);
    await waitForJobToFinish(rerun);
    assert.equal(rerun.downloadType, 'video');
    assert.equal(rerun.metadataOnly, false);
    assert.equal(rerun.outputDir, job.outputDir);
    for (const args of calls.filter((args) => !args.includes('--dump-single-json'))) {
      assert.equal(args[args.indexOf('--format') + 1], 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best');
      assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
      assert.equal(args[args.indexOf('--remux-video') + 1], 'mp4');
      assert.ok(!args.includes('--extract-audio'));
      assert.ok(!args.includes('--audio-format'));
      assert.ok(args.includes('--no-overwrites'));
      assert.ok(args.includes('--download-archive'));
      assert.equal(args.at(-1), url);
    }
  });
}

test('metadata-only lookup failures fail without starting a media download', async (t) => {
  const spawnMock = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stderr.end('ERROR: Unable to download webpage');
      child.emit('close', 1);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  process.env.YTDLP_OUTPUT_ROOT = path.dirname(process.env.DATABASE_PATH);
  const manager = await import('../src/jobManager.js?metadata-only-failure');
  const owner = { id: 'owner', role: 'user' };
  const url = 'https://music.youtube.com/playlist?list=failure';
  for (const metadataOnly of ['true', 1, null, {}]) {
    await assert.rejects(manager.createJob(url, owner, { metadataOnly }), { statusCode: 400 });
  }
  const job = await manager.createJob(url, owner, { metadataOnly: true });
  await waitForJobToFinish(job);
  assert.equal(job.status, 'failed');
  assert.match(job.output, /Unable to download webpage/);
  assert.equal(spawnMock.mock.callCount(), 1);
  assert.equal(manager.getJob(job.id).metadataOnly, true);
});

test('private video errors are classified as warnings', async () => {
  process.env.JOB_STORE_PATH = path.join(os.tmpdir(), `ssytdlp-classify-${Date.now()}.json`);
  const { classifyCommandOutput } = await import(`../src/jobManager.js?classify=${Date.now()}`);
  const privateOnly = classifyCommandOutput({
    stderr: 'ERROR: [youtube] abc: Private video. Sign in if you have been granted access'
  });
  const mixed = classifyCommandOutput({
    stderr: 'ERROR: [youtube] abc: Video is private\nERROR: Unable to download webpage'
  });

  assert.equal(privateOnly.hasPrivateVideoWarning, true);
  assert.equal(privateOnly.hasNonPrivateError, false);
  assert.match(privateOnly.stderr, /^WARNING:/);
  assert.equal(mixed.hasPrivateVideoWarning, true);
  assert.equal(mixed.hasNonPrivateError, true);
  assert.match(mixed.stderr, /ERROR: Unable to download webpage/);

  await fs.rm(process.env.JOB_STORE_PATH, { force: true });
});

test('unavailable video errors are warnings in either output stream without hiding other errors', async () => {
  const { classifyCommandOutput } = await import(`../src/jobManager.js?unavailable=${Date.now()}`);
  for (const stream of ['stdout', 'stderr']) {
    const output = 'ERROR: [youtube] abc: vIdEo UnAvAiLaBlE. This video has been removed';
    const unavailable = classifyCommandOutput({ [stream]: output });
    assert.equal(unavailable.hasPrivateVideoWarning, true);
    assert.equal(unavailable.hasNonPrivateError, false);
    assert.equal(unavailable[stream], output.replace('ERROR:', 'WARNING:'));

    const mixed = classifyCommandOutput({
      [stream]: `${output}\nERROR: [youtube] def: Private video\nERROR: Unable to download webpage`
    });
    assert.equal(mixed.hasPrivateVideoWarning, true);
    assert.equal(mixed.hasNonPrivateError, true);
    assert.match(mixed[stream], /ERROR: Unable to download webpage/);
    assert.match(mixed[stream], /WARNING: \[youtube\] def: Private video/);
  }
});

for (const { label, output, exitCode, status } of [
  { label: 'successful exit', output: 'ERROR: [youtube] abc: Video unavailable', exitCode: 0, status: 'partially_completed' },
  { label: 'failed exit', output: 'ERROR: [youtube] abc: Video unavailable', exitCode: 1, status: 'partially_completed' },
  { label: 'private and unavailable', output: 'ERROR: [youtube] abc: Video unavailable\nERROR: [youtube] def: Private video', exitCode: 1, status: 'partially_completed' },
  { label: 'unrelated error', output: 'ERROR: [youtube] abc: Video unavailable\nERROR: Unable to download webpage', exitCode: 1, status: 'failed' }
]) {
  test(`unavailable video job status: ${label}`, {
    skip: process.platform === 'win32' && 'requires POSIX executable test fixtures'
  }, async (t) => {
    const { manager, file } = await makeMetadataFixture(t, {
      output: JSON.stringify({ title: 'Unavailable playlist' })
    });
    await fs.writeFile(file('yt-dlp.cjs'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--dump-single-json')) {
  process.stdout.write('{"title":"Unavailable playlist"}');
} else {
  const output = args[args.indexOf('--output') + 1];
  fs.writeFileSync(path.join(path.dirname(output), 'Downloaded song.mp3'), '');
  process.stderr.write(${JSON.stringify(output)});
  process.exitCode = ${exitCode};
}
`);
    const job = await manager.createJob('https://music.youtube.com/playlist?list=unavailable');
    await waitForJobToFinish(job);
    assert.equal(job.status, status);
    assert.equal(job.error, status === 'failed' ? 'Command failed with exit code 1' : null);
    assert.equal(job.warning, status === 'failed' ? null : 'One or more private or unavailable videos were skipped.');
    assert.deepEqual(job.files, ['Downloaded song.mp3']);
    assert.match(job.output, /WARNING: \[youtube\] abc: Video unavailable/);
    assert.equal(manager.getJob(job.id).status, status);
  });
}

test('playlist metadata counts all songs independently of downloaded files', async () => {
  process.env.JOB_STORE_PATH = path.join(os.tmpdir(), `ssytdlp-metadata-${Date.now()}.json`);
  const { parsePlaylistMetadata } = await import(`../src/jobManager.js?metadata=${Date.now()}`);
  assert.deepEqual(parsePlaylistMetadata(JSON.stringify({ title: 'My playlist', playlist_count: 12, entries: [{ id: 'one' }] })), {
    playlistTitle: 'My playlist', folderName: 'My_playlist', playlistSongCount: 12
  });
  assert.equal(parsePlaylistMetadata('{"title":"Jazz / Soul: live"}').playlistTitle, 'Jazz / Soul: live');
  assert.equal(parsePlaylistMetadata('{}').playlistTitle, null);
  assert.equal(parsePlaylistMetadata(JSON.stringify({ entries: [{ id: 'one' }, null, { id: 'private' }] })).playlistSongCount, 3);
  assert.equal(parsePlaylistMetadata('{"entries":[]}').playlistSongCount, 0);
  assert.equal(parsePlaylistMetadata('{"playlist_count":0}').playlistSongCount, 0);
  for (const playlist_count of [null, -1, 1.5, '12']) {
    assert.equal(parsePlaylistMetadata(JSON.stringify({ playlist_count })).playlistSongCount, null);
  }
  assert.throws(() => parsePlaylistMetadata('not JSON'), SyntaxError);
});

test('legacy jobs receive readable titles without changing their output folders', async () => {
  const suffix = 'song_12345678-1234-1234-1234-123456789abc';
  const records = [
    { id: 'playlist', folderName: `Late_Night_Jazz_${suffix}`, files: [], expected: 'Late Night Jazz' },
    { id: 'single', folderName: suffix, files: ['A beautiful song.mp3'], expected: 'A beautiful song' },
    { id: 'empty', folderName: suffix, files: [], expected: 'Untitled playlist' }
  ];
  await fs.writeFile(process.env.JOB_STORE_PATH, JSON.stringify(records.map(({ expected, ...job }) => ({
    ...job, url: `https://music.youtube.com/watch?v=${job.id}`, status: 'completed', outputDir: `/output/${job.folderName}`
  }))));
  const manager = await import(`../src/jobManager.js?titles=${Date.now()}`);
  for (const record of records) {
    const job = manager.getJob(record.id);
    assert.equal(job.playlistTitle, record.expected);
    assert.equal(job.folderName, record.folderName);
    assert.equal(job.outputDir, `/output/${record.folderName}`);
    assert.equal(JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get(record.id).data).playlistTitle, record.expected);
  }
});

test('playlist titles are owner-editable metadata and survive reruns and reloads', async () => {
  const directory = path.dirname(process.env.DATABASE_PATH);
  process.env.YTDLP_OUTPUT_ROOT = directory;
  process.env.YTDLP_PATH = process.execPath;
  const owner = { id: 'owner', role: 'user' };
  const admin = { id: 'admin', role: 'admin' };
  const job = { id: 'rename', url: 'https://music.youtube.com/playlist?list=rename', status: 'completed',
    isPlaylist: true, playlistTitle: 'Original title', folderName: 'unchanged', outputDir: path.join(directory, 'unchanged'),
    initiatedBy: owner, contributors: [{ id: 'contributor' }], files: [], createdAt: new Date().toISOString() };
  writeJob(openDatabase(), job);
  const manager = await import(`../src/jobManager.js?rename=${Date.now()}`);
  for (const user of [null, { id: 'stranger', role: 'user' }, { id: 'contributor', role: 'user' }]) {
    await assert.rejects(manager.setJobTitle(job.id, 'Denied', user), { statusCode: 403 });
  }
  for (const title of [null, 42, '', '  ', 'a'.repeat(201), 'Bad\nTitle']) {
    await assert.rejects(manager.setJobTitle(job.id, title, owner), { statusCode: 400 });
  }
  for (const status of ['queued', 'running']) {
    writeJob(openDatabase(), { ...job, status });
    await assert.rejects(manager.setJobTitle(job.id, 'Busy', owner), { statusCode: 409 });
  }
  writeJob(openDatabase(), job);
  const renamed = await manager.setJobTitle(job.id, '  Jazz / Soul: Live  ', owner);
  assert.equal(renamed.playlistTitle, 'Jazz / Soul: Live');
  assert.equal(renamed.folderName, job.folderName);
  assert.equal(renamed.outputDir, job.outputDir);
  assert.equal(renamed.playlistTitleOverride, renamed.playlistTitle);
  await manager.setJobTitle(job.id, 'Owner collection', admin);
  const rerun = await manager.rerunJob(job.id, owner);
  await waitForJobToFinish(rerun);
  assert.equal(manager.getJob(job.id).playlistTitle, 'Owner collection');
  const reloaded = await import(`../src/jobManager.js?renamed-reload=${Date.now()}`);
  assert.equal(reloaded.getJob(job.id).playlistTitleOverride, 'Owner collection');
  assert.equal(await manager.setJobTitle('missing', 'Title', owner), null);
});

test('persisted private video failures become partially completed', async (t) => {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-private-'));
  const jobStorePath = path.join(storeRoot, 'jobs.json');
  process.env.JOB_STORE_PATH = jobStorePath;
  await fs.writeFile(jobStorePath, JSON.stringify([{
    id: 'private-video-job',
    url: 'https://music.youtube.com/watch?v=magykigZvfE',
    status: 'failed',
    error: 'Command failed with exit code 1',
    warning: null,
    playlistSongCount: 12,
    output: '[stderr]\nERROR: [youtube] magykigZvfE: Private video',
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]));

  const jobManager = await import(`../src/jobManager.js?private=${Date.now()}`);
  const job = jobManager.getJob('private-video-job');

  assert.equal(job.status, 'partially_completed');
  assert.equal(job.error, null);
  assert.equal(job.warning, 'One or more private or unavailable videos were skipped.');
  assert.equal(job.playlistSongCount, 12);

  t.after(async () => {
    await fs.rm(storeRoot, { recursive: true, force: true });
  });
});

test('persisted unavailable video failures are recovered unless unrelated errors are present', async () => {
  const records = [
    { id: 'error', status: 'failed', output: 'ERROR: [youtube] abc: Video unavailable' },
    { id: 'warning', status: 'warning', output: 'WARNING: [youtube] abc: Video unavailable' },
    { id: 'private-and-unavailable', status: 'failed', output: 'ERROR: [youtube] abc: Video unavailable\nERROR: [youtube] def: Private video' },
    { id: 'mixed', status: 'failed', output: 'WARNING: [youtube] abc: Video unavailable\nERROR: Unable to download webpage' }
  ];
  for (const record of records) {
    writeJob(openDatabase(), {
      ...record, url: `https://music.youtube.com/watch?v=${record.id}`,
      error: 'Command failed with exit code 1', files: [], createdAt: new Date().toISOString()
    });
  }
  const manager = await import(`../src/jobManager.js?persisted-unavailable=${Date.now()}`);
  for (const record of records) {
    const job = manager.getJob(record.id);
    assert.equal(job.status, record.id === 'mixed' ? 'failed' : 'partially_completed');
    assert.equal(job.error, record.id === 'mixed' ? 'Command failed with exit code 1' : null);
    if (record.id !== 'mixed') {
      assert.equal(job.warning, 'One or more private or unavailable videos were skipped.');
    }
    const stored = JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get(record.id).data);
    assert.equal(stored.status, job.status);
  }
});

test('duplicate source URLs return the previous job without creating another record', async (testContext) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-duplicate-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  process.env.YTDLP_OUTPUT_ROOT = directory;
  const url = 'https://music.youtube.com/watch?v=existing';
  await fs.writeFile(process.env.JOB_STORE_PATH, JSON.stringify([{
    id: 'previous-job', url, status: 'completed', files: [],
    initiatedBy: { id: 'alice-id', name: 'Alice' },
    createdAt: new Date().toISOString()
  }]));
  const manager = await import(`../src/jobManager.js?duplicate=${Date.now()}`);
  for (const status of ['completed', 'failed', 'partially_completed', 'queued', 'running']) {
    writeJob(openDatabase(), { ...manager.getJob('previous-job'), status });
    await assert.rejects(manager.createJob(` ${url} `, { id: 'bob-id', name: 'Bob' }), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'JOB_ALREADY_EXISTS');
      assert.equal(error.existingJob.id, 'previous-job');
      assert.equal(error.existingJob.status, status);
      return true;
    });
    assert.equal(manager.getJobs().length, 1);
    assert.deepEqual(manager.getJob('previous-job').initiatedBy, { id: 'alice-id', name: 'Alice' });
  }
});

test('jobManager queues jobs around a maintenance update', {
  skip: process.platform === 'win32' && 'requires POSIX executable test fixtures'
}, async (t) => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-bin-'));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-out-'));

  const fakeYtDlp = await makeFakeBin(binDir, 'yt-dlp', { delayMs: 300 });
  const fakeDeno = await makeFakeBin(binDir, 'deno', { delayMs: 0 });

  process.env.YTDLP_PATH = fakeYtDlp;
  process.env.DENO_PATH = fakeDeno;
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?t=${Date.now()}`);

  const events = [];

  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc');
  events.push('job-created');

  // Wait until the job actually starts running before triggering the update.
  while (jobManager.getJob(job.id).status !== 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const updatePromise = jobManager.runMaintenanceUpdate().then(() => events.push('update-finished'));
  assert.equal(jobManager.isUpdateInProgress(), true, 'update should be pending until running job finishes');

  // A job created while the update is pending must not start until the update completes.
  const queuedJob = await jobManager.createJob('https://music.youtube.com/watch?v=def');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    jobManager.getJob(queuedJob.id).status,
    'queued',
    'new job should stay queued while update is pending/running'
  );

  await updatePromise;
  events.push('after-update-await');

  while (jobManager.getJob(job.id).status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  while (jobManager.getJob(queuedJob.id).status === 'queued') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(jobManager.isUpdateInProgress(), false);
  assert.ok(events.indexOf('update-finished') > -1);
  assert.notEqual(jobManager.getJob(queuedJob.id).status, 'queued');
  await waitForJobToFinish(job);
  await waitForJobToFinish(queuedJob);

  t.after(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

async function assertRerunPreservesOutput(t, isPlaylist) {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-rerun-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?rerun=${Date.now()}`);
  const url = isPlaylist ? 'https://music.youtube.com/playlist?list=abc' : 'https://music.youtube.com/watch?v=abc';
  const job = await jobManager.createJob(url, {
    id: 'alice-id', name: 'Alice', role: 'admin'
  });
  assert.deepEqual(job.initiatedBy, { id: 'alice-id', name: 'Alice' });
  await waitForJobToFinish(job);
  const firstOutputDir = job.outputDir;
  const firstFolderName = job.folderName;
  await fs.writeFile(path.join(firstOutputDir, 'old-output.mp3'), 'old');
  const archivePath = path.join(firstOutputDir, '.download-archive.txt');
  await fs.writeFile(archivePath, 'youtube abc\n');
  job.files = ['old-output.mp3'];
  job.playlistTitle = 'My favorite songs';
  job.playlistSongCount = 99;
  writeJob(openDatabase(), job);

  await assert.rejects(jobManager.rerunJob(job.id, { id: 'bob-id', role: 'user' }), { statusCode: 403 });
  const rerun = await jobManager.rerunJob(job.id, { id: 'bob-id', name: 'Bob', role: 'admin' });

  assert.equal(rerun.playlistSongCount, null);
  assert.deepEqual(rerun.initiatedBy, { id: 'alice-id', name: 'Alice' });
  assert.equal(rerun.id, job.id);
  assert.notEqual(rerun, job);
  assert.equal(jobManager.getJob(job.id), rerun);
  assert.equal(rerun.outputDir, firstOutputDir);
  assert.equal(rerun.folderName, firstFolderName);
  assert.equal(rerun.playlistTitle, 'My favorite songs');
  assert.deepEqual(rerun.files, ['old-output.mp3']);
  assert.equal(await jobManager.rerunJob('missing-job'), null);

  await waitForJobToFinish(rerun);
  assert.equal(await fs.readFile(path.join(firstOutputDir, 'old-output.mp3'), 'utf8'), 'old');
  assert.equal(await fs.readFile(archivePath, 'utf8'), 'youtube abc\n');
  assert.deepEqual(rerun.files, ['old-output.mp3']);
  assert.match(rerun.command, /--no-overwrites/);
  assert.ok(rerun.command.includes(`--download-archive ${archivePath.includes(' ') ? `"${archivePath}"` : archivePath}`));
  assert.match(rerun.command, /--ffmpeg-location/);
  assert.match(rerun.output, /^\[stderr\]/);
  assert.match(rerun.output, /bad option/);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
}

test('song reruns preserve the job folder, songs and download archive', (testContext) =>
  assertRerunPreservesOutput(testContext, false));

test('playlist reruns preserve the job folder, songs and download archive', (testContext) =>
  assertRerunPreservesOutput(testContext, true));

test('deleting a finished job removes its record and output', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-delete-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = path.join(outputRoot, 'missing-yt-dlp');
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?delete=${Date.now()}`);
  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc');
  await waitForJobToFinish(job);
  const jobOutputDir = job.outputDir;

  await assert.rejects(jobManager.deleteJob(job.id), { statusCode: 403 });
  await assert.rejects(jobManager.deleteJob(job.id, { id: 'other', role: 'user' }), { statusCode: 403 });
  assert.equal(await jobManager.deleteJob(job.id, { id: 'admin', role: 'admin' }), true);
  assert.equal(jobManager.getJob(job.id), undefined);
  await assert.rejects(fs.access(jobOutputDir));
  assert.equal(await jobManager.deleteJob('missing-job'), false);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

test('individual song removal enforces ownership, validates paths and preserves the archive', async (testContext) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-song-delete-'));
  testContext.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  const manager = await import(`../src/jobManager.js?song-delete=${Date.now()}`);
  const owner = { id: 'owner', name: 'Owner', role: 'user' };
  const admin = { id: 'admin', role: 'admin' };
  const job = await manager.createJob('https://music.youtube.com/watch?v=songs', owner);
  await waitForJobToFinish(job);
  const songName = 'Song 100% #1.mp3';
  const archivePath = path.join(job.outputDir, '.download-archive.txt');
  await fs.writeFile(archivePath, 'youtube first\nyoutube second\n');
  await fs.writeFile(path.join(job.outputDir, songName), 'first');
  await fs.writeFile(path.join(job.outputDir, 'second.mp3'), 'second');
  job.files = [songName, 'second.mp3', 'missing.mp3'];
  writeJob(openDatabase(), job);

  for (const user of [null, { id: 'stranger', role: 'user' }]) {
    await assert.rejects(manager.deleteJobFile(job.id, songName, user), { statusCode: 403 });
    await assert.rejects(manager.deleteJob(job.id, user), { statusCode: 403 });
    await assert.rejects(manager.rerunJob(job.id, user), { statusCode: 403 });
  }
  assert.equal(await fs.readFile(path.join(job.outputDir, songName), 'utf8'), 'first');
  for (const status of ['queued', 'running']) {
    writeJob(openDatabase(), { ...job, status });
    for (const user of [owner, admin]) {
      await assert.rejects(manager.deleteJobFile(job.id, songName, user), { statusCode: 409 });
      await assert.rejects(manager.deleteJob(job.id, user), { statusCode: 409 });
      await assert.rejects(manager.rerunJob(job.id, user), { statusCode: 409 });
      await assert.rejects(manager.setJobContributors(job.id, [], user), { statusCode: 409 });
      await assert.rejects(manager.setSongMetadata(job.id, songName, { title: 'Busy' }, user), { statusCode: 409 });
    }
  }
  writeJob(openDatabase(), job);
  for (const name of ['../outside.mp3', '..\\outside.mp3', '/outside.mp3', 'song.mp3:stream', '.download-archive.txt', '', '\0']) {
    await assert.rejects(manager.deleteJobFile(job.id, name, owner), { statusCode: 400 });
  }
  await assert.rejects(manager.deleteJobFile(job.id, 'unknown.mp3', owner), { statusCode: 404 });
  assert.equal(await manager.deleteJobFile('unknown', songName, owner), null);

  const removal = manager.deleteJobFile(job.id, songName, owner);
  await assert.rejects(manager.setSongMetadata(job.id, 'second.mp3', { title: 'Busy' }, owner), { statusCode: 409 });
  await assert.rejects(manager.setJobContributors(job.id, [], owner), { statusCode: 409 });
  await assert.rejects(manager.rerunJob(job.id, owner), { statusCode: 409 });
  await assert.rejects(manager.deleteJob(job.id, admin), { statusCode: 409 });
  const updated = await removal;
  assert.deepEqual(updated.files, ['second.mp3', 'missing.mp3']);
  assert.deepEqual(updated.initiatedBy, { id: owner.id, name: owner.name });
  await assert.rejects(fs.access(path.join(job.outputDir, songName)));
  assert.equal(await fs.readFile(path.join(job.outputDir, 'second.mp3'), 'utf8'), 'second');
  await manager.deleteJobFile(job.id, 'second.mp3', admin);
  await manager.deleteJobFile(job.id, 'missing.mp3', owner);
  assert.deepEqual(manager.getJob(job.id).files, []);
  assert.equal(await fs.readFile(archivePath, 'utf8'), 'youtube first\nyoutube second\n');

  const rerun = await manager.rerunJob(job.id, owner);
  await waitForJobToFinish(rerun);
  assert.deepEqual(manager.getJob(job.id).files, []);
  assert.equal(await manager.deleteJob(job.id, owner), true);
});

test('legacy folders shared with another owner require an administrator to modify', async (testContext) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-shared-'));
  testContext.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  const manager = await import(`../src/jobManager.js?shared=${Date.now()}`);
  const folder = path.join(outputRoot, 'shared');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'song.mp3'), 'song');
  const job = {
    id: 'shared-one', url: 'https://music.youtube.com/watch?v=one', status: 'completed',
    outputDir: folder, files: ['song.mp3'], initiatedBy: { id: 'owner' }, createdAt: new Date().toISOString()
  };
  writeJob(openDatabase(), job);
  writeJob(openDatabase(), { ...job, id: 'shared-two', url: 'https://music.youtube.com/watch?v=two', initiatedBy: { id: 'other' } });
  const owner = { id: 'owner', role: 'user' };
  await assert.rejects(manager.rerunJob(job.id, owner), { statusCode: 403 });
  await assert.rejects(manager.deleteJob(job.id, owner), { statusCode: 403 });
  await assert.rejects(manager.deleteJobFile(job.id, 'song.mp3', owner), { statusCode: 403 });
  await assert.rejects(manager.setSongMetadata(job.id, 'song.mp3', { title: 'Denied' }, owner), { statusCode: 403 });
  await manager.deleteJobFile(job.id, 'song.mp3', { id: 'admin', role: 'admin' });
  await assert.rejects(fs.access(path.join(folder, 'song.mp3')));
});

test('transcription options validate output flags and force Vietnamese for fallback', async () => {
  const { validateTranscriptionOptions } = await import('../src/transcription.js');
  assert.deepEqual(validateTranscriptionOptions(), {});
  assert.deepEqual(validateTranscriptionOptions({ NoVocals: false, VietLyricsFallback: false, Multilingual: false }), {
    NoVocals: false, VietLyricsFallback: false, Multilingual: false
  });
  assert.deepEqual(validateTranscriptionOptions({ NoVocals: true, VietLyricsFallback: true, Multilingual: true, language: 'en' }), {
    NoVocals: true, VietLyricsFallback: true, Multilingual: true, language: 'vi'
  });
  assert.deepEqual(validateTranscriptionOptions({ VietLyricsFallback: true }), { VietLyricsFallback: true, language: 'vi' });
  assert.deepEqual(validateTranscriptionOptions({ VietLyricsFallback: false, language: 'ja' }), {
    VietLyricsFallback: false, language: 'ja'
  });
  for (const key of ['NoVocals', 'VietLyricsFallback', 'Multilingual']) {
    for (const value of ['true', 'false', 0, 1, null, {}, []]) {
      assert.throws(() => validateTranscriptionOptions({ [key]: value }), { statusCode: 400 });
    }
  }
});

test('transcription options are forwarded as multipart fields without losing false values', async (testContext) => {
  const { requestTranscription } = await import('../src/transcription.js');
  const filePath = path.join(path.dirname(process.env.DATABASE_PATH), 'options.wav');
  await fs.writeFile(filePath, 'test upload');
  const previousEndpoint = process.env.TRANSCRIPTION_ENDPOINT;
  process.env.TRANSCRIPTION_ENDPOINT = 'http://transcriber.test/api/transcribe';
  testContext.after(() => {
    if (previousEndpoint === undefined) delete process.env.TRANSCRIPTION_ENDPOINT;
    else process.env.TRANSCRIPTION_ENDPOINT = previousEndpoint;
  });
  let payload;
  testContext.mock.method(globalThis, 'fetch', async (endpoint, request) => {
    assert.equal(endpoint, process.env.TRANSCRIPTION_ENDPOINT);
    assert.equal(request.method, 'POST');
    payload = await new Response(request.body).formData();
    return new Response(null, { status: 503 });
  });
  for (const enabled of [true, false]) {
    await assert.rejects(requestTranscription(filePath, {
      NoVocals: enabled, VietLyricsFallback: enabled, Multilingual: enabled, language: 'en', lyrics: ' Words ', lyrics_mode: 'align'
    }), /HTTP 503/);
    assert.equal(payload.get('NoVocals'), String(enabled));
    assert.equal(payload.get('VietLyricsFallback'), String(enabled));
    assert.equal(payload.get('Multilingual'), String(enabled));
    assert.equal(payload.get('language'), enabled ? 'vi' : 'en');
    assert.equal(payload.get('lyrics'), 'Words');
    assert.equal(payload.get('lyrics_mode'), 'align');
    assert.equal(payload.get('file').name, 'options.wav');
  }
  await assert.rejects(requestTranscription(filePath), /HTTP 503/);
  assert.equal(payload.has('NoVocals'), false);
  assert.equal(payload.has('VietLyricsFallback'), false);
  assert.equal(payload.has('Multilingual'), false);
  assert.equal(payload.has('language'), false);
});

function makeTranscriptionAudio() {
  const audio = Buffer.alloc(48);
  audio.write('RIFF');
  audio.writeUInt32LE(40, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(4, 40);
  return audio;
}

test('transcription persists settings without lyrics across retranscriptions and reloads', async (testContext) => {
  const outputDir = path.join(path.dirname(process.env.DATABASE_PATH), 'lyrics-status');
  await fs.mkdir(outputDir);
  const songName = 'Song.wav';
  const audio = makeTranscriptionAudio();
  await fs.writeFile(path.join(outputDir, songName), audio);
  const manager = await import(`../src/jobManager.js?lyrics-status=${Date.now()}`);
  const owner = { id: 'owner', role: 'user' };
  const job = { id: 'lyrics-status', url: 'https://music.youtube.com/watch?v=lyrics', status: 'completed',
    outputDir, files: [songName], initiatedBy: owner, createdAt: new Date().toISOString() };
  writeJob(openDatabase(), job);
  const previousEndpoint = process.env.TRANSCRIPTION_ENDPOINT;
  process.env.TRANSCRIPTION_ENDPOINT = 'http://transcriber.test/api/transcribe';
  testContext.after(() => {
    if (previousEndpoint === undefined) delete process.env.TRANSCRIPTION_ENDPOINT;
    else process.env.TRANSCRIPTION_ENDPOINT = previousEndpoint;
  });
  const readTranscription = () => JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get(job.id).data).transcriptions[songName];
  let expectedOptions;
  let expectedLyricsIncluded;
  let responseStatus = 200;
  testContext.mock.method(globalThis, 'fetch', async () => {
    const sent = readTranscription();
    assert.equal(sent.status, 'sent');
    assert.equal(sent.lyricsIncluded, expectedLyricsIncluded);
    assert.deepEqual(sent.options, expectedOptions);
    assert.doesNotMatch(JSON.stringify(sent), /Known words|Private input/);
    return new Response(audio, { status: responseStatus });
  });
  for (const mode of [undefined, 'align', undefined, 'prompt', 'correct']) {
    expectedLyricsIncluded = Boolean(mode);
    expectedOptions = {
      Multilingual: Boolean(mode), NoVocals: false, VietLyricsFallback: Boolean(mode),
      language: mode ? 'vi' : 'en', ...(mode ? { lyrics_mode: mode } : {})
    };
    const options = { ...expectedOptions, language: 'en', ...(mode ? { lyrics: 'Known words' } : {}), privateNotes: 'Private input' };
    await manager.transcribeJobFile(job.id, songName, options, owner);
    const completed = readTranscription();
    assert.equal(completed.status, 'transcribed');
    assert.equal(completed.lyricsIncluded, expectedLyricsIncluded);
    assert.deepEqual(completed.options, expectedOptions);
    assert.doesNotMatch(JSON.stringify(completed), /Known words|Private input/);
  }
  const restarted = await import(`../src/jobManager.js?lyrics-status-restart=${Date.now()}`);
  assert.equal(restarted.getJob(job.id).transcriptions[songName].lyricsIncluded, true);
  assert.deepEqual(restarted.getJob(job.id).transcriptions[songName].options, expectedOptions);
  responseStatus = 503;
  expectedLyricsIncluded = false;
  expectedOptions = { Multilingual: false, NoVocals: true, VietLyricsFallback: false };
  await assert.rejects(manager.transcribeJobFile(job.id, songName, expectedOptions, owner), /HTTP 503/);
  const failed = readTranscription();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lyricsIncluded, false);
  assert.deepEqual(failed.options, expectedOptions);
  assert.doesNotMatch(JSON.stringify(failed), /Known words|Private input/);
});

test('transcription sends multipart lyrics, replaces audio and persists NoVocals safely', async (testContext) => {
  const directory = path.dirname(process.env.DATABASE_PATH);
  const outputDir = path.join(directory, 'songs');
  await fs.mkdir(outputDir);
  const songName = 'Song 100% #1.wav';
  const audio = makeTranscriptionAudio();
  await fs.writeFile(path.join(outputDir, songName), audio);
  const manager = await import(`../src/jobManager.js?transcribe=${Date.now()}`);
  const owner = { id: 'owner', role: 'user' };
  const job = { id: 'transcribe', url: 'https://music.youtube.com/watch?v=transcribe', status: 'completed',
    outputDir, files: [songName], initiatedBy: owner, contributors: [{ id: 'contributor' }], createdAt: new Date().toISOString() };
  writeJob(openDatabase(), job);
  let payload;
  let responseData = audio;
  let responseStatus = 200;
  let releaseRequest;
  let receivedRequest;
  const received = new Promise((resolve) => { receivedRequest = resolve; });
  let gate = new Promise((resolve) => { releaseRequest = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    payload = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
    receivedRequest();
    await gate;
    res.writeHead(responseStatus);
    res.end(responseData);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousEndpoint = process.env.TRANSCRIPTION_ENDPOINT;
  process.env.TRANSCRIPTION_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  testContext.after(() => {
    if (previousEndpoint === undefined) delete process.env.TRANSCRIPTION_ENDPOINT;
    else process.env.TRANSCRIPTION_ENDPOINT = previousEndpoint;
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(manager.transcribeJobFile(job.id, songName, {}, { id: 'stranger' }), { statusCode: 403 });
  await assert.rejects(manager.transcribeJobFile(job.id, '../song.wav', {}, owner), { statusCode: 400 });
  await assert.rejects(manager.transcribeJobFile(job.id, songName, { lyrics: 'words' }, owner), { statusCode: 400 });
  for (const language of ['', 'Vietnamese', 'zz', null, 42]) {
    await assert.rejects(manager.transcribeJobFile(job.id, songName, { language }, owner), { statusCode: 400 });
  }
  const pending = manager.transcribeJobFile(job.id, songName, { lyrics: ' Known words ', lyrics_mode: 'align', language: 'vi' }, owner);
  await received;
  const sent = manager.getJob(job.id).transcriptions[songName];
  assert.equal(sent.status, 'sent');
  assert.ok(Number.isFinite(Date.parse(sent.requestedAt)));
  assert.equal(sent.completedAt, undefined);
  await assert.rejects(manager.deleteJob(job.id, owner), { statusCode: 409 });
  await assert.rejects(manager.rerunJob(job.id, owner), { statusCode: 409 });
  await assert.rejects(manager.deleteJobFile(job.id, songName, owner), { statusCode: 409 });
  await assert.rejects(manager.transcribeJobFile(job.id, songName, {}, owner), { statusCode: 409 });
  releaseRequest();
  await pending;
  const transcribed = manager.getJob(job.id).transcriptions[songName];
  assert.equal(transcribed.status, 'transcribed');
  assert.equal(transcribed.lyricsIncluded, true);
  assert.equal(transcribed.requestedAt, sent.requestedAt);
  assert.ok(Date.parse(transcribed.completedAt) >= Date.parse(sent.requestedAt));
  gate = Promise.resolve();
  assert.equal(payload.get('file').name, songName);
  assert.deepEqual(Buffer.from(await payload.get('file').arrayBuffer()), audio);
  assert.equal(payload.get('lyrics'), 'Known words');
  assert.equal(payload.get('lyrics_mode'), 'align');
  assert.equal(payload.get('language'), 'vi');
  const zip = new AdmZip();
  const updated = Buffer.from(audio);
  updated[44] = 1;
  zip.addFile(`songs/${songName}`, updated);
  zip.addFile('songs/instrumental.wav', audio);
  responseData = zip.toBuffer();
  await manager.transcribeJobFile(job.id, songName, {}, { id: 'contributor' });
  assert.equal(manager.getJob(job.id).transcriptions[songName].lyricsIncluded, false);
  assert.equal(payload.has('lyrics'), false);
  assert.equal(payload.has('lyrics_mode'), false);
  assert.equal(payload.has('language'), false);
  assert.deepEqual(await fs.readFile(path.join(outputDir, songName)), updated);
  assert.deepEqual(await fs.readFile(path.join(outputDir, '[NoVocals]', 'instrumental.wav')), audio);
  assert.deepEqual(manager.getJob(job.id).files, [songName, '[NoVocals]/instrumental.wav']);
  assert.equal(manager.getJob(job.id).transcriptions[songName].noVocalsName, '[NoVocals]/instrumental.wav');
  const missingSong = new AdmZip();
  missingSong.addFile('other.wav', audio);
  const duplicateSong = new AdmZip();
  duplicateSong.addFile(`first/${songName}`, audio);
  duplicateSong.addFile(`second/${songName}`, audio);
  const unsafeSong = new AdmZip();
  unsafeSong.addFile(songName, audio);
  unsafeSong.addFile('unsafe:stream.wav', audio);
  for (const invalid of [Buffer.from('{"error":"not audio"}'), missingSong.toBuffer(), duplicateSong.toBuffer(), unsafeSong.toBuffer()]) {
    responseData = invalid;
    await assert.rejects(manager.transcribeJobFile(job.id, songName, {}, owner), { statusCode: 502 });
    assert.deepEqual(await fs.readFile(path.join(outputDir, songName)), updated);
  }
  responseStatus = 500;
  await assert.rejects(manager.transcribeJobFile(job.id, songName, {}, owner), { statusCode: 502 });
  const failed = manager.getJob(job.id).transcriptions[songName];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /HTTP 500/);
  assert.ok(Number.isFinite(Date.parse(failed.completedAt)));
  responseStatus = 200;
  responseData = audio;
  await manager.transcribeJobFile(job.id, songName, { language: 'ja' }, owner);
  assert.equal(payload.get('language'), 'ja');
  assert.equal(payload.has('lyrics'), false);
  assert.equal(payload.has('lyrics_mode'), false);
  for (const lyrics_mode of ['prompt', 'correct']) {
    await manager.transcribeJobFile(job.id, songName, { lyrics: 'Words', lyrics_mode }, owner);
    assert.equal(manager.getJob(job.id).transcriptions[songName].lyricsIncluded, true);
    assert.equal(payload.get('lyrics_mode'), lyrics_mode);
  }
  const rollbackJob = manager.getJob(job.id);
  await assert.rejects(replaceTranscribedFiles(rollbackJob, songName, [
    { name: songName, data: updated, original: true },
    { name: 'new-accompaniment.wav', data: updated, original: false }
  ], async () => { throw new Error('Persistence failed'); }), /Persistence failed/);
  assert.deepEqual(await fs.readFile(path.join(outputDir, songName)), audio);
  await assert.rejects(fs.access(path.join(outputDir, '[NoVocals]', 'new-accompaniment.wav')));
  assert.deepEqual(rollbackJob.files, [songName, '[NoVocals]/instrumental.wav']);
  assert.equal((await fs.readdir(outputDir)).some((name) => name.startsWith('.transcription-')), false);
  let firstReceived;
  const firstRequest = new Promise((resolve) => { firstReceived = resolve; });
  receivedRequest = firstReceived;
  gate = new Promise((resolve) => { releaseRequest = resolve; });
  const firstPending = manager.transcribeJobFile(job.id, songName, {}, owner);
  await firstRequest;
  const accompanimentName = '[NoVocals]/instrumental.wav';
  const secondPending = manager.transcribeJobFile(job.id, accompanimentName, {}, owner);
  assert.equal(manager.getJob(job.id).transcriptions[accompanimentName].status, 'sent');
  await assert.rejects(manager.transcribeJobFile(job.id, accompanimentName, {}, owner), { statusCode: 409 });
  let secondReceived;
  const secondRequest = new Promise((resolve) => { secondReceived = resolve; });
  receivedRequest = secondReceived;
  releaseRequest();
  gate = new Promise((resolve) => { releaseRequest = resolve; });
  await firstPending;
  await secondRequest;
  assert.equal(manager.getJob(job.id).transcriptions[songName].status, 'transcribed');
  assert.equal(manager.getJob(job.id).transcriptions[accompanimentName].status, 'sent');
  const unrelatedNames = ['delete-one.wav', 'delete-two.wav'];
  for (const name of unrelatedNames) await fs.writeFile(path.join(outputDir, name), audio);
  const stored = manager.getJob(job.id);
  stored.files.push(...unrelatedNames);
  writeJob(openDatabase(), stored);
  await assert.rejects(manager.deleteJobFile(job.id, accompanimentName, owner), { statusCode: 409 });
  const firstDelete = manager.deleteJobFile(job.id, unrelatedNames[0], owner);
  await assert.rejects(manager.deleteJobFile(job.id, unrelatedNames[0], owner), { statusCode: 409 });
  await assert.rejects(manager.transcribeJobFile(job.id, unrelatedNames[0], {}, owner), { statusCode: 409 });
  const secondDelete = manager.deleteJobFile(job.id, unrelatedNames[1], owner);
  await Promise.all([firstDelete, secondDelete]);
  for (const name of unrelatedNames) {
    await assert.rejects(fs.access(path.join(outputDir, name)));
    assert.equal(manager.getJob(job.id).files.includes(name), false);
  }
  assert.equal(manager.getJob(job.id).transcriptions[accompanimentName].status, 'sent');
  await assert.rejects(manager.deleteJob(job.id, owner), { statusCode: 409 });
  releaseRequest();
  await secondPending;
  gate = Promise.resolve();
  assert.equal(manager.getJob(job.id).transcriptions[songName].status, 'transcribed');
  assert.equal(manager.getJob(job.id).transcriptions[accompanimentName].status, 'transcribed');
  process.env.YTDLP_PATH = process.execPath;
  const rerun = await manager.rerunJob(job.id, owner);
  await waitForJobToFinish(rerun);
  assert.deepEqual(new Set(manager.getJob(job.id).files), new Set([songName, '[NoVocals]/instrumental.wav']));
  await manager.transcribeJobFile(job.id, '[NoVocals]/instrumental.wav', {}, owner);
  await manager.deleteJobFile(job.id, '[NoVocals]/instrumental.wav', owner);
  assert.deepEqual(manager.getJob(job.id).files, [songName]);
  assert.equal(manager.getJob(job.id).transcriptions['[NoVocals]/instrumental.wav'], undefined);
  assert.equal(manager.getJob(job.id).transcriptions[songName].status, 'transcribed');
  const persistedJob = manager.getJob(job.id);
  persistedJob.status = 'completed';
  persistedJob.transcriptions[songName] = { status: 'sent', requestedAt: sent.requestedAt };
  writeJob(openDatabase(), persistedJob);
  const restarted = await import(`../src/jobManager.js?transcription-restart=${Date.now()}`);
  const interrupted = restarted.getJob(job.id).transcriptions[songName];
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.requestedAt, sent.requestedAt);
  assert.match(interrupted.error, /server restart/);
  assert.ok(Number.isFinite(Date.parse(interrupted.completedAt)));
});

test('job history is restored after a manager restart', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-persist-'));
  const jobStorePath = path.join(outputRoot, 'jobs.json');
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  process.env.JOB_STORE_PATH = jobStorePath;

  const firstManager = await import(`../src/jobManager.js?persist-write=${Date.now()}`);
  const createdJob = await firstManager.createJob('https://music.youtube.com/watch?v=persist', {
    id: 'alice-id', name: 'Alice'
  });
  await waitForJobToFinish(createdJob);

  while (true) {
    const storedJob = openDatabase().prepare('SELECT status FROM jobs WHERE id = ?').get(createdJob.id);
    if (storedJob?.status === createdJob.status) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  closeDatabases();
  const secondManager = await import(`../src/jobManager.js?persist-read=${Date.now()}`);
  const restoredJob = secondManager.getJob(createdJob.id);

  assert.equal(restoredJob.id, createdJob.id);
  assert.equal(restoredJob.url, createdJob.url);
  assert.deepEqual(restoredJob.initiatedBy, { id: 'alice-id', name: 'Alice' });
  assert.equal(restoredJob.status, createdJob.status);
  assert.equal(restoredJob.command, createdJob.command);
  assert.equal(restoredJob.output, createdJob.output);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});
