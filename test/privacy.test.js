import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import NodeID3 from 'node-id3';
import { writeJob, writeUser } from '../src/database.js';
import { createPostgresDatabase } from '../src/postgres.js';
import { pagePostgresTracks, postgresPageJobs, readPostgresJob, readPostgresLibrary, readPostgresJobs } from '../src/postgresCatalog.js';
import { canReadAllFiles, canReadFile, canReadJob, fileVisibilitySql, visibleJob } from '../src/privacy.js';
import { addLibraryJobFiles, getLibrary, linkLibraryJob, setLibrary, setLibraryPlaylistPrivacy } from '../src/libraryStore.js';
import { canReadSharedSong } from '../src/sharedAccess.js';
import { createTestDatabase } from '../test-support/postgres.js';

test('privacy defaults public and permits only the owning user, never an administrator override', () => {
  const job = { id: 'job', initiatedBy: { id: 'owner' }, contributors: [{ id: 'contributor' }],
    files: ['Public.mp3', 'Secret.mp3', '[NoVocals]/Different.mp3'],
    privateFiles: ['Secret.mp3'], output: 'Secret.mp3', command: ['Secret.mp3'], logs: ['Secret.mp3'],
    error: 'Secret.mp3', warning: 'Secret.mp3',
    songMetadata: { 'Public.mp3': { title: 'Public' }, 'Secret.mp3': { title: 'Secret' } },
    transcriptions: { 'Secret.mp3': { noVocalsName: '[NoVocals]/Different.mp3', status: 'sent' } } };
  assert.equal(canReadJob(job, null), true);
  for (const user of [null, { id: 'contributor' }, { id: 'admin', role: 'admin' }, { id: 'linked' }, { id: 'shared', role: 'shared' }]) {
    assert.equal(canReadFile(job, 'Public.mp3', user), true);
    assert.equal(canReadFile(job, 'Secret.mp3', user), false);
    assert.equal(canReadFile(job, '[NoVocals]/Different.mp3', user), false);
    const visible = visibleJob(job, user);
    assert.deepEqual(visible.files, ['Public.mp3']);
    assert.deepEqual(visible.privateFiles, []);
    assert.deepEqual(Object.keys(visible.songMetadata), ['Public.mp3']);
    assert.deepEqual(visible.transcriptions, {});
    assert.equal(visible.transcriptionPending, false);
    assert.doesNotMatch(JSON.stringify(visible), /Secret|Different/);
    assert.equal(canReadJob({ ...job, private: true }, user), false);
    assert.equal(visibleJob({ ...job, private: true }, user), null);
  }
  assert.equal(canReadAllFiles(job, { id: 'owner' }), true);
  assert.equal(canReadFile({ private: true }, 'Secret.mp3', { role: 'admin' }), false);
  assert.equal(canReadJob({ private: true }, {}), false);
  const clone = visibleJob(job, { id: 'owner' });
  clone.songMetadata['Secret.mp3'].title = 'Changed';
  assert.equal(job.songMetadata['Secret.mp3'].title, 'Secret');
});

test('privacy survives persistence, filters SQL before paging and protects aliases, companions and shares', { timeout: 120_000 }, async (context) => {
  const { database, directory } = await createTestDatabase(context);
  const now = new Date().toISOString();
  const owner = { id: 'owner', role: 'user', status: 'approved', name: 'Owner' };
  const contributor = { id: 'contributor', role: 'user', status: 'approved', name: 'Contributor' };
  const admin = { id: 'admin', role: 'admin', status: 'approved', name: 'Admin' };
  const shared = { id: 'shared', role: 'shared', status: 'approved', name: 'Shared' };
  for (const user of [owner, contributor, admin, shared]) {
    await writeUser(database, { ...user, userHandle: user.id, credentials: [], createdAt: now, updatedAt: now });
  }
  await database.prepare('INSERT INTO library_shares (owner_id, viewer_id) VALUES ($1, $2)').run(owner.id, shared.id);
  const outputRoot = path.join(directory, 'output');
  await fs.mkdir(outputRoot);
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  const manager = await import(`../src/jobManager.js?privacy=${encodeURIComponent(directory)}`);
  const files = ['Secret.mp3', '[NoVocals]/Different.mp3', 'Public.mp3', '[NoVocals]/Public.mp3'];
  const outputDir = path.join(outputRoot, 'source');
  await fs.mkdir(path.join(outputDir, '[NoVocals]'), { recursive: true });
  const audio = NodeID3.write({ title: 'Fixture' }, Buffer.from('audio fixture'));
  for (const name of files) await fs.writeFile(path.join(outputDir, name), audio);
  const source = { id: 'source', url: 'https://music.youtube.com/playlist?list=privacy', isPlaylist: true,
    status: 'completed', initiatedBy: owner, contributors: [contributor], outputDir,
    playlistTitle: 'Source', files, createdAt: now, updatedAt: now,
    transcriptions: { 'Secret.mp3': { noVocalsName: files[1] } } };
  await writeJob(database, source);
  const destination = { ...source, id: 'destination', url: 'import:destination', outputDir: null, files: [],
    transcriptions: {}, playlistTitle: 'Destination' };
  await writeJob(database, destination);
  let jobs = await readPostgresJobs(database, owner.id);
  let library = await getLibrary(owner.id, jobs);
  await addLibraryJobFiles(owner.id, { version: library.version, jobId: source.id, playlistId: destination.id }, jobs);
  const initialMemberships = (await database.prepare('SELECT count(*) AS count FROM library_memberships').get()).count;

  const { createMediaShare, publicMediaRouter } = await import('../src/mediaShares.js');
  const app = express();
  app.use('/api/public', publicMediaRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const share = async (name) => {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await createMediaShare({ user: owner, params: { id: source.id, name } }, response);
    return response;
  };
  const token = await share('Secret.mp3');
  assert.equal(token.statusCode, 201);
  const publicUrl = `http://127.0.0.1:${server.address().port}/api/public/media/${token.body.url.split('/').at(-1)}/stream`;
  assert.equal((await fetch(publicUrl)).status, 200);

  await context.test('only owners can set boolean privacy and public media tokens stop working', async () => {
    for (const user of [contributor, admin, shared, null]) {
      await assert.rejects(manager.setJobPrivacy(source.id, true, user), { statusCode: 403 });
      await assert.rejects(manager.setJobFilePrivacy(source.id, 'Secret.mp3', true, user), { statusCode: 403 });
    }
    for (const value of ['true', 1, null, undefined]) {
      await assert.rejects(manager.setJobPrivacy(source.id, value, owner), { statusCode: 400 });
      await assert.rejects(manager.setJobFilePrivacy(source.id, 'Secret.mp3', value, owner), { statusCode: 400 });
    }
    await Promise.all([
      manager.setJobFilePrivacy(source.id, 'Secret.mp3', true, owner),
      manager.setJobFilePrivacy(source.id, 'Public.mp3', true, owner)
    ]);
    assert.deepEqual((await manager.getJob(source.id)).privateFiles.sort(), ['Public.mp3', 'Secret.mp3']);
    await manager.setJobFilePrivacy(source.id, 'Public.mp3', false, owner);
    assert.equal((await fetch(publicUrl)).status, 404);
    assert.equal((await share('Secret.mp3')).statusCode, 404);
    assert.equal((await share(files[1])).statusCode, 404);
    assert.equal(await canReadSharedSong(shared.id, source.id, 'Secret.mp3'), false);
    assert.equal(await canReadSharedSong(shared.id, source.id, 'Public.mp3'), true);
    const restarted = createPostgresDatabase(process.env.DATABASE_URL);
    try { assert.deepEqual((await readPostgresJob(restarted, source.id)).privateFiles, ['Secret.mp3']); }
    finally { await restarted.close(); }
  });

  await context.test('SQL counts, searches, alternate playlist memberships and companions honor file privacy', async () => {
    for (const viewerId of [contributor.id, admin.id, shared.id]) {
      const page = await pagePostgresTracks(database, owner.id, { viewerId, pageSize: 1 });
      assert.equal(page.total, 2);
      assert.equal(page.files.length, 1);
      assert.equal(page.files[0].name, 'Public.mp3');
      assert.equal((await pagePostgresTracks(database, owner.id, { viewerId, search: 'Secret' })).total, 0);
      assert.equal((await pagePostgresTracks(database, owner.id, { viewerId, entryId: destination.id })).total, 2);
      const summary = await readPostgresLibrary(database, owner.id, viewerId);
      assert.equal(summary.songCount, 2);
      assert.ok(summary.playlists.every((playlist) => playlist.songCount === 2));
      const hydrated = await postgresPageJobs(database, page.files, viewerId);
      assert.deepEqual(hydrated.get(source.id).files, ['Public.mp3', '[NoVocals]/Public.mp3']);
    }
    assert.equal((await pagePostgresTracks(database, contributor.id)).total, 2);
    assert.equal((await pagePostgresTracks(database, owner.id)).total, 4);
    const rows = await database.prepare(`SELECT songs.name FROM songs JOIN jobs ON jobs.id = songs.job_id
      WHERE ${fileVisibilitySql('jobs', 'songs.name', '$1')} ORDER BY songs.name`).all(admin.id);
    assert.deepEqual(rows.map((row) => row.name).sort(), ['Public.mp3', '[NoVocals]/Public.mp3'].sort());
    assert.equal((await database.prepare('SELECT count(*) AS count FROM library_memberships').get()).count, initialMemberships);
  });

  await context.test('nonowners cannot mutate private files or whole jobs but unrelated public edits remain allowed', async () => {
    for (const user of [admin, contributor]) {
      await assert.rejects(manager.setSongMetadata(source.id, 'Secret.mp3', { title: 'Blocked' }, user), { statusCode: 403 });
      await assert.rejects(manager.deleteJobFile(source.id, 'Secret.mp3', user), { statusCode: 403 });
      await assert.rejects(manager.transcribeJobFile(source.id, 'Secret.mp3', {}, user), { statusCode: 403 });
      await assert.rejects(manager.rerunJob(source.id, user), { statusCode: 403 });
      await assert.rejects(manager.deleteJob(source.id, user), { statusCode: 403 });
      await assert.rejects(manager.setJobContributors(source.id, [], user), { statusCode: 403 });
      assert.equal((await manager.setSongMetadata(source.id, 'Public.mp3', { title: 'Still public' }, user)).title, 'Still public');
    }
    await manager.setJobPrivacy(source.id, true, owner);
    assert.equal((await pagePostgresTracks(database, contributor.id)).total, 0);
    assert.equal((await readPostgresLibrary(database, owner.id, admin.id)).jobs.some((job) => job.id === source.id), false);
    await manager.setJobPrivacy(source.id, false, owner);
    await manager.setJobFilePrivacy(source.id, 'Secret.mp3', false, owner);
    assert.equal((await pagePostgresTracks(database, contributor.id)).total, 4);
    assert.equal((await fetch(publicUrl)).status, 200);
  });

  await context.test('same-output aliases cannot bypass another owner or an explicitly named companion', async () => {
    await writeJob(database, { ...source, id: 'alias', url: 'import:alias', initiatedBy: admin, contributors: [],
      outputDir: `${outputDir}/../source` });
    await manager.setJobFilePrivacy(source.id, 'Secret.mp3', true, owner);
    const alias = await manager.getJob('alias');
    assert.equal(alias.outputDir, outputDir);
    assert.equal(canReadFile(alias, 'Secret.mp3', admin), false);
    assert.equal(canReadFile(alias, files[1], admin), false);
    assert.equal(canReadFile(alias, 'Public.mp3', admin), true);
    await assert.rejects(manager.deleteJob('alias', admin), { statusCode: 403 });
    await assert.rejects(manager.replaceJobFile('alias', 'Secret.mp3', admin, () => assert.fail('Must not receive a file')), { statusCode: 403 });
    assert.equal((await pagePostgresTracks(database, admin.id)).total, 2);
    await manager.setJobPrivacy(source.id, true, owner);
    assert.equal((await pagePostgresTracks(database, admin.id)).total, 0);
    await manager.setJobPrivacy(source.id, false, owner);
    await manager.setJobFilePrivacy(source.id, 'Secret.mp3', false, owner);
  });

  await context.test('synthetic privacy hides only that library membership and survives organization saves', async () => {
    const single = { ...source, id: 'single', url: 'import:single', isPlaylist: false, outputDir: null,
      files: ['Single.mp3'], transcriptions: {}, contributors: [] };
    await writeJob(database, single);
    jobs = await readPostgresJobs(database, owner.id);
    await linkLibraryJob(owner.id, single, jobs);
    await assert.rejects(setLibraryPlaylistPrivacy(owner.id, 'individual-songs', 'true', jobs), { statusCode: 400 });
    await setLibraryPlaylistPrivacy(owner.id, 'individual-songs', true, jobs);
    library = await getLibrary(owner.id, jobs);
    assert.equal(library.entries.find((entry) => entry.id === 'individual-songs').private, true);
    await setLibrary(owner.id, { ...library, entries: library.entries.map(({ private: _privacy, ...entry }) => entry) }, jobs);
    assert.equal((await getLibrary(owner.id, jobs)).entries.find((entry) => entry.id === 'individual-songs').private, true);
    assert.equal((await readPostgresLibrary(database, owner.id, contributor.id)).entries.some((entry) => entry.id === 'individual-songs'), false);
    assert.equal((await pagePostgresTracks(database, owner.id, { viewerId: contributor.id, search: 'Single' })).total, 0);
    await setLibraryPlaylistPrivacy(owner.id, 'individual-songs', false, jobs);
    assert.equal((await pagePostgresTracks(database, owner.id, { viewerId: contributor.id, search: 'Single' })).total, 1);
  });
});
