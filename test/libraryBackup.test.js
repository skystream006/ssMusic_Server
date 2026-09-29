import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { closeDatabases, openDatabase, writeUser } from '../src/database.js';
import { createLibraryBackupService, nextBackupTime } from '../src/libraryBackup.js';
import { writeLibraryExport } from '../src/libraryExport.js';
import { createTestDatabase } from '../test-support/postgres.js';

async function fixture(context) {
  const { directory: root, database } = await createTestDatabase(context);
  for (const id of ['owner', 'other', 'revoked']) (await writeUser(database, { id, name: id, userHandle: id, role: 'user',
    status: id === 'revoked' ? 'revoked' : 'approved', createdAt: '2026-01-01', updatedAt: '2026-01-01', credentials: [] }));
  const options = { database, root: path.join(root, 'backups'),
    loadLibrary: async () => ({ library: { entries: [], songOrder: {} }, jobs: [] }) };
  return { root, database, options, service: (await createLibraryBackupService(options)) };
}

test('backup schedules compute the next daily or weekly time in UTC', () => {
  const now = new Date('2026-09-21T03:00:00Z');
  assert.equal(nextBackupTime({ frequency: 'daily', time: '03:00' }, now), '2026-09-22T03:00:00.000Z');
  assert.equal(nextBackupTime({ frequency: 'daily', time: '04:00' }, now), '2026-09-21T04:00:00.000Z');
  assert.equal(nextBackupTime({ frequency: 'weekly', time: '03:00', weekday: 1 }, now), '2026-09-28T03:00:00.000Z');
  assert.equal(nextBackupTime({ frequency: 'weekly', time: '02:00', weekday: 0 }, now), '2026-09-27T02:00:00.000Z');
});

test('latest backup is replaced across formats, private to each user and retained on failure', async (context) => {
  const { service, options } = await fixture(context);
  await assert.rejects(() => service.openLatest('owner'), { statusCode: 404 });
  const first = await service.start('owner', { format: 'android' });
  assert.equal(first.songCount, 0);
  const download = await service.openLatest('owner');
  const original = await download.handle.readFile();
  assert.ok(new AdmZip(original).getEntry('IMPORT.txt'));
  assert.equal((await service.getStatus('other')).latest, null);
  await assert.rejects(() => service.openLatest('other'), { statusCode: 404 });
  const second = await service.start('owner', { format: 'itunes', destination: '/Music' });
  assert.notEqual(second.id, first.id);
  const retained = Buffer.alloc(original.length);
  await download.handle.read(retained, 0, retained.length, 0);
  assert.deepEqual(retained, original);
  const secondDownload = await service.openLatest('owner');
  assert.ok(new AdmZip(await secondDownload.handle.readFile()).getEntry('Library.xml'));
  await secondDownload.release();
  await download.release();
  const folders = await fs.readdir(options.root);
  const archives = (await Promise.all(folders.map((folder) => fs.readdir(path.join(options.root, folder))))).flat();
  assert.deepEqual(archives, [`${second.id}.zip`]);
  const broken = (await createLibraryBackupService({ ...options, writeArchive: async (target) => {
    await fs.writeFile(target, 'partial'); throw new Error('disk full');
  } }));
  await assert.rejects(() => broken.start('owner', { format: 'android' }), /disk full/);
  assert.deepEqual((await broken.getStatus('owner')).latest, second);
  assert.match((await broken.getStatus('owner')).error, /server storage/);
  assert.equal((await broken.getStatus('owner')).progress, null);
  assert.deepEqual((await fs.readdir(path.join(options.root, folders[0]))), [`${second.id}.zip`]);
  await assert.rejects(() => service.start('revoked', { format: 'android' }), { statusCode: 403 });
});

test('overlapping exports are rejected while an archive is being written', async (context) => {
  const { options } = await fixture(context);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = (await createLibraryBackupService({ ...options, writeArchive: async (...args) => {
    await gate; await writeLibraryExport(...args);
  } }));
  const completion = service.start('owner', { format: 'android' });
  assert.equal((await service.getStatus('owner')).running, true);
  assert.throws(() => service.start('owner', { format: 'android' }), { statusCode: 409 });
  release();
  await completion;
  assert.equal((await service.getStatus('owner')).running, false);
});

test('backup progress counts unique archived songs, excludes documents and movies, and persists the completed total', async (context) => {
  const { root, options } = await fixture(context);
  const files = ['first.mp3', 'second.mp3', 'movie.mp4'];
  await Promise.all(files.map((name) => fs.writeFile(path.join(root, name), 'media')));
  const library = { entries: [{ id: 'playlist', type: 'playlist', parentId: null },
    { id: 'linked', type: 'playlist', parentId: null }], songOrder: {},
    songAdds: [{ jobId: 'playlist', name: 'first.mp3', playlistId: 'linked' }] };
  const jobs = [{ id: 'playlist', isPlaylist: true, outputDir: root, files, playlistTitle: 'Songs' },
    { id: 'linked', isPlaylist: true, outputDir: root, files: [], playlistTitle: 'Linked songs' }];
  const snapshots = [];
  const archivedCounts = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = (await createLibraryBackupService({ ...options,
    loadLibrary: async () => { await gate; return { library, jobs }; },
    writeArchive: async (target, prepared, onProgress) => {
      snapshots.push((await service.getStatus('owner')).progress);
      onProgress(1);
      snapshots.push((await service.getStatus('owner')).progress);
      await writeLibraryExport(target, prepared, (processedSongs) => {
        archivedCounts.push(processedSongs);
        onProgress(processedSongs);
      });
      snapshots.push((await service.getStatus('owner')).progress);
    }
  }));
  const completion = service.start('owner', { format: 'android' });
  assert.deepEqual((await service.getStatus('owner')).progress,
    { stage: 'preparing', processedSongs: 0, totalSongs: null, format: 'android' });
  assert.equal((await service.getStatus('other')).progress, null);
  release();
  const latest = await completion;
  assert.deepEqual(archivedCounts, [1, 2]);
  assert.deepEqual(snapshots.map(({ processedSongs, totalSongs, stage }) => ({ processedSongs, totalSongs, stage })), [
    { processedSongs: 0, totalSongs: 2, stage: 'archiving' },
    { processedSongs: 1, totalSongs: 2, stage: 'archiving' },
    { processedSongs: 2, totalSongs: 2, stage: 'archiving' }
  ]);
  assert.equal((await service.getStatus('owner')).progress, null);
  assert.equal((await service.getStatus('owner')).running, false);
  assert.equal(latest.songCount, 2);
  assert.equal((await (await createLibraryBackupService(options)).getStatus('owner')).latest.songCount, 2);
  const failing = (await createLibraryBackupService({ ...options, loadLibrary: async () => ({ library, jobs }),
    writeArchive: async (target, prepared, onProgress) => {
      onProgress(1);
      assert.deepEqual((await failing.getStatus('owner')).progress,
        { stage: 'archiving', processedSongs: 1, totalSongs: 2, format: 'android' });
      throw new Error('disk full');
    }
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = failing.start('owner', { format: 'android' });
    assert.deepEqual((await failing.getStatus('owner')).progress,
      { stage: 'preparing', processedSongs: 0, totalSongs: null, format: 'android' });
    await assert.rejects(failed, /disk full/);
    assert.equal((await failing.getStatus('owner')).running, false);
    assert.equal((await failing.getStatus('owner')).progress, null);
    assert.deepEqual((await failing.getStatus('owner')).latest, latest);
  }
});

test('deleting an account retains its saved archive through download cleanup, an in-flight replacement and restart', async (context) => {
  const { service, options, database } = await fixture(context);
  const latest = await service.start('owner', { format: 'android' });
  const download = await service.openLatest('owner');
  const original = await download.handle.readFile();
  let releaseWrite;
  let startedWrite;
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const started = new Promise((resolve) => { startedWrite = resolve; });
  let time = new Date('2026-09-21T02:00:00Z');
  const replacing = (await createLibraryBackupService({ ...options, now: () => time, writeArchive: async (...args) => {
    startedWrite();
    await gate;
    await writeLibraryExport(...args);
  } }));
  (await replacing.saveSchedule('owner', { enabled: true, frequency: 'daily', time: '03:00', format: 'android' }));
  const completion = replacing.start('owner', { format: 'android' });
  const rejected = assert.rejects(completion, { statusCode: 403 });
  try {
    await started;
    (await database.prepare('DELETE FROM users WHERE id = $1').run('owner'));
    assert.deepEqual((await replacing.getStatus('owner')).latest, latest);
  } finally {
    releaseWrite();
    await rejected;
    await download.release();
  }

  time = new Date('2026-09-24T12:00:00Z');
  const retained = (await replacing.getStatus('owner'));
  await replacing.runDue();
  assert.deepEqual((await replacing.getStatus('owner')), retained);
  const folders = await fs.readdir(options.root);
  const folder = path.join(options.root, folders[0]);
  assert.deepEqual(await fs.readdir(folder), [`${latest.id}.zip`]);
  assert.deepEqual(await fs.readFile(path.join(folder, `${latest.id}.zip`)), original);
  await assert.rejects(() => replacing.start('owner', { format: 'android' }), { statusCode: 403 });
  await assert.rejects(() => replacing.openLatest('owner'), { statusCode: 403 });
  await assert.rejects(() => replacing.openLatest('other'), { statusCode: 404 });
  (await closeDatabases());
  const restarted = (await createLibraryBackupService({ ...options, database: openDatabase(), now: () => time }));
  await restarted.runDue();
  assert.deepEqual((await restarted.getStatus('owner')), retained);
  assert.deepEqual(await fs.readFile(path.join(folder, `${latest.id}.zip`)), original);
});

test('scheduled backups persist, catch up once after downtime and skip disabled or revoked users', async (context) => {
  const { options, database } = await fixture(context);
  let time = new Date('2026-09-21T02:00:00Z');
  let service = (await createLibraryBackupService({ ...options, now: () => time }));
  const schedule = { enabled: true, frequency: 'daily', time: '03:00', format: 'android' };
  (await service.saveSchedule('owner', schedule));
  (await service.saveSchedule('other', schedule));
  service = (await createLibraryBackupService({ ...options, now: () => time }));
  assert.equal((await service.getStatus('owner')).nextRunAt, '2026-09-21T03:00:00.000Z');
  time = new Date('2026-09-24T12:00:00Z');
  (await database.prepare("UPDATE users SET status = 'revoked' WHERE id = 'other'").run());
  await service.runDue();
  const completed = (await service.getStatus('owner'));
  assert.equal(completed.latest.format, 'android');
  assert.equal(completed.nextRunAt, '2026-09-25T03:00:00.000Z');
  assert.equal((await service.getStatus('other')).latest, null);
  await service.runDue();
  assert.equal((await service.getStatus('owner')).latest.id, completed.latest.id);
  (await service.saveSchedule('owner', { enabled: false }));
  time = new Date('2026-10-01T12:00:00Z');
  await service.runDue();
  assert.equal((await service.getStatus('owner')).latest.id, completed.latest.id);
  assert.equal((await service.getStatus('owner')).nextRunAt, null);
  assert.equal((await service.getStatus('owner')).schedule.format, 'android');
});

test('schedule validation rejects invalid times, formats, weekdays and iTunes destinations', async (context) => {
  const { service } = await fixture(context);
  const valid = { enabled: true, frequency: 'weekly', weekday: 1, time: '03:00', format: 'itunes', destination: 'C:\\Music' };
  for (const value of [{}, { ...valid, enabled: 'true' }, { ...valid, frequency: 'hourly' }, { ...valid, time: '24:00' },
    { ...valid, weekday: 7 }, { ...valid, weekday: 1.5 }, { ...valid, format: 'zip' }, { ...valid, destination: '../Music' }]) {
    (await assert.rejects(async () => (await service.saveSchedule('owner', value)), { statusCode: 400 }));
  }
  assert.equal((await service.saveSchedule('owner', valid)).schedule.destination, 'C:/Music');
});

test('scheduled failures retain the previous backup and interrupted state recovers after restart', async (context) => {
  const { service, options, database } = await fixture(context);
  const latest = await service.start('owner', { format: 'android' });
  let time = new Date('2026-09-21T02:00:00Z');
  const failing = (await createLibraryBackupService({ ...options, now: () => time, writeArchive: async () => { throw new Error('Disk unavailable'); } }));
  (await failing.saveSchedule('owner', { enabled: true, frequency: 'daily', time: '03:00', format: 'android' }));
  time = new Date('2026-09-21T04:00:00Z');
  await failing.runDue();
  assert.equal((await failing.getStatus('owner')).latest.id, latest.id);
  assert.equal((await failing.getStatus('owner')).running, false);
  assert.equal((await failing.getStatus('owner')).nextRunAt, '2026-09-22T03:00:00.000Z');
  assert.match((await failing.getStatus('owner')).error, /server storage/);
  (await database.prepare('UPDATE library_backups SET running = 1 WHERE user_id = $1').run('owner'));
  (await closeDatabases());
  const restarted = (await createLibraryBackupService({ ...options, database: openDatabase() }));
  assert.equal((await restarted.getStatus('owner')).running, false);
  assert.match((await restarted.getStatus('owner')).error, /interrupted/);
  const download = await restarted.openLatest('owner');
  assert.equal(download.latest.id, latest.id);
  await download.release();
  const folders = await fs.readdir(options.root);
  await fs.rm(path.join(options.root, folders[0], `${latest.id}.zip`));
  await assert.rejects(() => restarted.openLatest('owner'), { statusCode: 404 });
});