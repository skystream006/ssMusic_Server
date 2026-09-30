import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPostgresDatabase } from '../src/postgres.js';
import { writeUser } from '../src/database.js';
import { deletePostgresJob, pagePostgresTracks, readPostgresJob, readPostgresLibrary, updatePostgresSong, writePostgresJob } from '../src/postgresCatalog.js';

test('PostgreSQL bindings and async transactions preserve isolation and rollback', {
  skip: !process.env.TEST_POSTGRES_URL
}, async (testContext) => {
  assert.equal(new URL(process.env.TEST_POSTGRES_URL).pathname, '/ssytdlp_test');
  const database = createPostgresDatabase(process.env.TEST_POSTGRES_URL);
  testContext.after(() => database.close());
  await database.ready;
  const name = crypto.randomUUID();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const pending = database.withTransaction(async () => {
    await database.prepare('INSERT INTO migrations (name) VALUES ($1)').run(name);
    entered.resolve();
    await release.promise;
    throw new Error('Rollback fixture');
  });
  await entered.promise;
  assert.equal(await database.prepare('SELECT name FROM migrations WHERE name = $1').get(name), undefined);
  release.resolve();
  await assert.rejects(pending, /Rollback fixture/);
  assert.equal(await database.prepare('SELECT name FROM migrations WHERE name = $1').get(name), undefined);
  await database.withTransaction(async () => {
    await database.withTransaction(async () => {
      assert.equal((await database.prepare('INSERT INTO migrations (name) VALUES ($1)').run(name)).changes, 1);
    });
  });
  assert.equal((await database.prepare('SELECT name FROM migrations WHERE name = $1').get(name)).name, name);
  assert.equal((await database.prepare('DELETE FROM migrations WHERE name = $1').run(name)).changes, 1);
});

test('PostgreSQL normalizes songs and pages searchable account-scoped catalog records', {
  skip: !process.env.TEST_POSTGRES_URL
}, async (testContext) => {
  assert.equal(new URL(process.env.TEST_POSTGRES_URL).pathname, '/ssytdlp_test');
  const database = createPostgresDatabase(process.env.TEST_POSTGRES_URL);
  const userId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  testContext.after(async () => {
    await database.prepare('DELETE FROM jobs WHERE id = $1').run(jobId);
    await database.prepare('DELETE FROM users WHERE id = $1').run(userId);
    await database.close();
  });
  const now = new Date().toISOString();
  await writeUser(database, { id: userId, name: userId, userHandle: userId, role: 'user', status: 'approved',
    credentials: [], createdAt: now, updatedAt: now });
  const files = Array.from({ length: 123 }, (_, index) => `Song ${String(index).padStart(3, '0')}.mp3`);
  const job = { id: jobId, url: 'https://example.test/playlist', status: 'completed', createdAt: now,
    initiatedBy: { id: userId }, playlistTitle: 'Catalog', files,
    songMetadata: { [files[0]]: { title: 'A 100% original', artist: 'Artist', album: 'Rare collection', performerInfo: 'Album ensemble', genre: 'Jazz', rating: 4 } },
    transcriptions: { [files[0]]: { status: 'transcribed', requestedAt: now, lyricsIncluded: true, options: { lyrics_mode: 'align', NoVocals: false } } } };
  await writePostgresJob(database, job);
  assert.deepEqual(await readPostgresJob(database, jobId), job);
  const stored = JSON.parse((await database.prepare('SELECT data FROM jobs WHERE id = $1').get(jobId)).data);
  assert.deepEqual(stored.files, []);
  assert.deepEqual(stored.songMetadata, {});
  assert.deepEqual(stored.transcriptions, {});
  const first = await pagePostgresTracks(database, userId);
  assert.equal(first.total, 123);
  assert.equal(first.files.length, 50);
  assert.equal(first.files[0].name, files[0]);
  assert.deepEqual(first.files[0].transcription, job.transcriptions[files[0]]);
  const last = await pagePostgresTracks(database, userId, { page: 999 });
  assert.equal(last.page, 3);
  assert.equal(last.files.length, 23);
  assert.equal((await pagePostgresTracks(database, userId, { entryId: jobId, pageSize: null })).files.length, 123);
  assert.deepEqual((await pagePostgresTracks(database, userId, { search: '100%' })).files.map((song) => song.name), [files[0]]);
  for (const search of ['ARTIST', 'Rare collection', 'Album ensemble', 'Jazz']) {
    assert.deepEqual((await pagePostgresTracks(database, userId, { search })).files.map((song) => song.name), [files[0]]);
  }
  assert.equal((await pagePostgresTracks(database, crypto.randomUUID())).total, 0);
  assert.equal((await readPostgresLibrary(database, userId)).songCount, 123);
  const index = await database.prepare("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'user_songs_page'").get();
  assert.match(index.indexdef, /\(user_id, playlist_position, "?position"?, job_id, name\)/);
  assert.ok(await database.prepare("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'user_songs_song'").get());
  job.updatedAt = new Date().toISOString();
  await updatePostgresSong(database, job, files[0], 'metadata', { title: 'Changed title', album: 'Changed album', rating: 2, transcriptionLocked: true });
  assert.equal((await pagePostgresTracks(database, userId, { search: 'Changed title' })).total, 1);
  assert.equal((await pagePostgresTracks(database, userId, { search: 'Changed album' })).files[0].transcriptionLocked, true);
  assert.equal((await pagePostgresTracks(database, userId, { search: 'Rare collection' })).total, 0);
  await updatePostgresSong(database, job, files[1], 'transcription', { status: 'transcribed', lyricsIncluded: false, requestedAt: now });
  const changed = await readPostgresJob(database, jobId);
  assert.deepEqual(changed.transcriptions[files[0]], job.transcriptions[files[0]]);
  assert.equal(changed.transcriptions[files[1]].lyricsIncluded, false);
  assert.equal((await readPostgresLibrary(database, userId)).songCount, 123);
  await deletePostgresJob(database, jobId);
  assert.equal((await readPostgresLibrary(database, userId)).songCount, 0);
  assert.equal((await pagePostgresTracks(database, userId)).files.length, 0);
});



test('PostgreSQL serves authenticated library, metadata, organization and duplicate-job HTTP workflows', {
  skip: !process.env.TEST_POSTGRES_URL, timeout: 30_000
}, async (testContext) => {
  assert.equal(new URL(process.env.TEST_POSTGRES_URL).pathname, '/ssytdlp_test');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-postgres-http-'));
  const database = createPostgresDatabase(process.env.TEST_POSTGRES_URL);
  const userId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  let server;
  testContext.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await database.prepare('DELETE FROM jobs WHERE id = $1').run(jobId);
    await database.prepare('DELETE FROM users WHERE id IN ($1, $2)').run(userId, otherId);
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const tokens = new Map();
  for (const id of [userId, otherId]) {
    await writeUser(database, { id, name: id, userHandle: id, role: 'user', status: 'approved', credentials: [], createdAt: now, updatedAt: now });
    const token = crypto.randomBytes(32).toString('base64url');
    tokens.set(id, token);
    await database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)')
      .run(crypto.createHash('sha256').update(token).digest('base64url'), id, '2099-01-01');
  }
  const outputDir = path.join(directory, 'songs');
  await fs.mkdir(outputDir);
  const files = Array.from({ length: 55 }, (_, index) => `Song ${index}.mp3`);
  await Promise.all(files.map((name) => fs.writeFile(path.join(outputDir, name), 'audio fixture')));
  const job = { id: jobId, url: 'https://music.youtube.com/playlist?list=postgres-http', status: 'completed', createdAt: now,
    updatedAt: now, initiatedBy: { id: userId }, isPlaylist: true, playlistTitle: 'PostgreSQL playlist', outputDir, files,
    transcriptions: { [files[0]]: { status: 'transcribed', requestedAt: now, lyricsIncluded: true,
      options: { language: 'vi', NoVocals: false, Multilingual: false, VietLyricsFallback: true, lyrics_mode: 'align' } } } };
  await writePostgresJob(database, job);
  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))));
  const ports = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--http-port', String(ports[0]), '--https-port', String(ports[1])], {
    cwd: directory, env: { ...process.env, DATABASE_URL: process.env.TEST_POSTGRES_URL,
      LIBRARY_BACKUP_ROOT: path.join(directory, 'backups'),
      YTDLP_OUTPUT_ROOT: outputDir, YTDLP_PATH: process.execPath, TRANSCRIPTION_ENDPOINT: '',
      HTTPS_KEY_PATH: '', HTTPS_CERT_PATH: '', PASSKEY_RP_ID: 'localhost', PASSKEY_ORIGIN: `https://localhost:${ports[1]}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`PostgreSQL HTTP server exited ${code}: ${output}`)));
    server.stderr.on('data', (chunk) => { output += chunk; });
    server.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ssYTDLP HTTPS server listening')) resolve();
    });
  });
  const request = (route, { method = 'GET', body, user = userId } = {}) => new Promise((resolve, reject) => {
    const call = https.request({ hostname: '127.0.0.1', port: ports[1], path: route, method, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tokens.get(user)}` } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, text, body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      });
    });
    call.on('error', reject);
    call.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request('/api/library', { user: null })).status, 401);
  const library = await request('/api/library');
  assert.equal(library.status, 200, library.text);
  assert.equal(library.body.serverPagination, true);
  assert.equal(library.body.songCount, 55);
  assert.deepEqual(library.body.jobs[0].transcriptions, {});
  assert.equal((await request('/api/library', { user: otherId })).body.songCount, 0);
  const first = await request('/api/library/tracks');
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.files.length, 50);
  assert.deepEqual(first.body.files[0].transcription, job.transcriptions[files[0]]);
  assert.equal((await request('/api/library/tracks?page=2')).body.files.length, 5);
  assert.equal((await request(`/api/library/tracks?entryId=${jobId}`)).body.files.length, 55);
  assert.equal((await request(`/api/library/tracks?entryId=${jobId}`, { user: otherId })).status, 404);
  const metadataRoute = `/api/jobs/${jobId}/files/${encodeURIComponent(files[0])}/metadata`;
  assert.equal((await request(metadataRoute, { method: 'PATCH', body: { title: 'Denied' }, user: otherId })).status, 403);
  const metadata = await request(metadataRoute, { method: 'PATCH', body: { title: 'Fresh title', artist: 'Postgres artist', album: 'Fresh album', rating: 4,
    transcriptionLocked: true, sylt: [{ time: 1.25, text: 'Timed lyrics' }], uslt: 'Plain lyrics' } });
  assert.equal(metadata.status, 200, metadata.text);
  assert.equal(metadata.body.transcriptionLocked, true);
  assert.deepEqual(metadata.body.sylt, [{ time: 1.25, text: 'Timed lyrics' }]);
  assert.equal(metadata.body.uslt, 'Plain lyrics');
  assert.equal((await request(`${metadataRoute.replace(/metadata$/, 'transcribe')}`, { method: 'POST', body: {} })).status, 409);
  const lyricsRoute = `/api/jobs/${jobId}/lyrics/${encodeURIComponent(files[0])}`;
  const lyrics = (await request(lyricsRoute)).body;
  assert.equal(lyrics.canEdit, true);
  assert.equal(lyrics.transcriptionLocked, true);
  assert.deepEqual(lyrics.sylt, metadata.body.sylt);
  assert.equal((await request(lyricsRoute, { user: otherId })).body.canEdit, false);
  assert.equal((await request('/api/library/tracks?search=Fresh')).body.total, 1);
  assert.equal((await request('/api/library/tracks?search=Fresh%20album')).body.files[0].transcriptionLocked, true);
  assert.equal((await request(metadataRoute, { method: 'PATCH', body: { transcriptionLocked: false } })).body.transcriptionLocked, false);
  const duplicate = await request('/api/jobs', { method: 'POST', body: { url: job.url } });
  assert.equal(duplicate.status, 409, duplicate.text);
  assert.equal(duplicate.body.existingJob.id, jobId);
  const folder = await request('/api/library/entries', { method: 'POST', body: { version: library.body.version,
    action: 'create-folder', id: 'folder-postgres', name: 'PostgreSQL folder', parentId: null } });
  assert.equal(folder.status, 200, folder.text);
  assert.ok((await request('/api/library')).body.entries.some((entry) => entry.id === 'folder-postgres'));
  const restored = await request(`/api/jobs/${jobId}`);
  assert.equal(restored.body.files.length, 55);
  assert.equal(restored.body.transcriptions[files[0]].lyricsIncluded, true);
});

test('PostgreSQL pages a million indexed song records without materializing the catalog in Node', {
  skip: !process.env.TEST_POSTGRES_URL || process.env.TEST_POSTGRES_SCALE !== '1', timeout: 180_000
}, async (testContext) => {
  assert.equal(new URL(process.env.TEST_POSTGRES_URL).pathname, '/ssytdlp_test');
  const database = createPostgresDatabase(process.env.TEST_POSTGRES_URL);
  const userId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  testContext.after(async () => {
    try {
      await database.prepare('DELETE FROM users WHERE id = $1').run(userId);
      await database.prepare('DELETE FROM jobs WHERE id = $1').run(jobId);
    } finally { await database.close(); }
  });
  const now = new Date().toISOString();
  await writeUser(database, { id: userId, name: userId, userHandle: userId, role: 'user', status: 'approved', credentials: [], createdAt: now, updatedAt: now });
  await writePostgresJob(database, { id: jobId, url: 'https://example.test/scale', status: 'completed', createdAt: now,
    initiatedBy: { id: userId }, playlistTitle: 'Scale', files: [] });
  await database.prepare(`INSERT INTO songs (job_id, name, file_order, media_type, search_text)
    SELECT $1, 'Track ' || lpad(sequence::text, 7, '0') || '.mp3', sequence, 'audio',
      'track ' || lpad(sequence::text, 7, '0') FROM generate_series(1, 1000000) sequence`).run(jobId);
  await database.prepare(`INSERT INTO user_songs (user_id, job_id, name, playlist_id, playlist_position, position)
    SELECT $1, job_id, name, job_id, 0, file_order FROM songs WHERE job_id = $2`).run(userId, jobId);
  await database.prepare('UPDATE user_catalog SET total_songs = 1000000 WHERE user_id = $1').run(userId);
  await database.exec('ANALYZE songs; ANALYZE user_songs');
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const first = await pagePostgresTracks(database, userId);
  const firstMilliseconds = performance.now() - started;
  assert.equal(first.files.length, 50);
  assert.equal(first.total, 1_000_000);
  assert.equal(first.files[0].name, 'Track 0000001.mp3');
  const searchStarted = performance.now();
  const search = await pagePostgresTracks(database, userId, { search: '0999999' });
  assert.equal(search.total, 1);
  assert.equal(search.files[0].name, 'Track 0999999.mp3');
  const searchMilliseconds = performance.now() - searchStarted;
  const lastStarted = performance.now();
  const last = await pagePostgresTracks(database, userId, { page: 20_000 });
  assert.equal(last.files.at(-1).name, 'Track 1000000.mp3');
  const plan = await database.prepare('EXPLAIN SELECT * FROM user_songs WHERE user_id = $1 ORDER BY playlist_position, position, job_id, name LIMIT 50').all(userId);
  assert.ok(plan.some((row) => /user_songs_page/.test(row['QUERY PLAN'])));
  testContext.diagnostic(JSON.stringify({ rows: 1_000_000, firstPageMs: Math.round(firstMilliseconds),
    searchMs: Math.round(searchMilliseconds), lastPageMs: Math.round(performance.now() - lastStarted),
    heapGrowthMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024) }));
});