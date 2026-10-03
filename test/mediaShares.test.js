import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import NodeID3 from 'node-id3';
import { openDatabase, writeJob } from '../src/database.js';
import { readPostgresJob } from '../src/postgresCatalog.js';
import { readSongMetadata, readSongSummary } from '../src/music.js';
import { createTestDatabase } from '../test-support/postgres.js';

test('song shares are persistent, narrowly scoped, read-only public capabilities', { timeout: 120_000 }, async (context) => {
  let server;
  async function stopServer() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
  const { directory } = await createTestDatabase(context, { beforeCleanup: stopServer });
  const database = openDatabase();
  const store = await import('../src/authStore.js');
  const users = {};
  const credentials = {};
  for (const name of ['Admin', 'Owner', 'Contributor', 'Other', 'Reader', 'Pending', 'Revoked', 'Deleted']) {
    let user = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (!['Admin', 'Pending'].includes(name)) {
      user = await store.updateUser(user.id, { status: name === 'Revoked' ? 'revoked' : 'approved' }, users.Admin.id);
    }
    users[name] = user;
    const session = await store.createSession(user.id);
    credentials[name] = [{ Cookie: `ssytdlp_session=${session.token}` }, { Authorization: ['Bearer', session.token].join(' ') }];
    if (user.status === 'approved') {
      const pat = await store.createPrivateAccessToken(user.id, 'Song sharing tests');
      credentials[name].push({ 'X-PAT': pat.token });
    }
  }
  await store.updateUser(users.Reader.id, { role: 'shared', sharedUserIds: [users.Owner.id] }, users.Admin.id);
  const outputRoot = path.join(directory, 'output');
  const songName = 'Song 100% #1.mp3';
  const nestedName = `[NoVocals]/${songName}`;
  const audio = NodeID3.write({
    title: 'Shared song', artist: 'An artist', album: 'An album', performerInfo: 'Album artist',
    genre: 'Rock', year: '2026', trackNumber: '2/8', partOfSet: '1/2',
    popularimeter: { email: 'listener@example.com', rating: 196, counter: 1 },
    image: { mime: 'image/png', type: { id: 3, name: 'front cover' }, description: 'Cover',
      imageBuffer: Buffer.from('iVBORw0KGgo=', 'base64') },
    unsynchronisedLyrics: { language: 'eng', text: 'First line\nSecond line' },
    synchronisedLyrics: [{ language: 'eng', timeStampFormat: 2, contentType: 1,
      synchronisedText: [{ text: 'First line', timeStamp: 1000 }, { text: 'Second line', timeStamp: 2500 }] }]
  }, Buffer.from('audio fixture bytes'));
  async function seedJob(id, owner = users.Owner, files = [songName], contributors = []) {
    const outputDir = path.join(outputRoot, id);
    await fs.mkdir(outputDir, { recursive: true });
    for (const name of files) {
      await fs.mkdir(path.dirname(path.join(outputDir, name)), { recursive: true });
      await fs.writeFile(path.join(outputDir, name), name.endsWith('.mp3') ? audio : 'non-mp3 fixture');
    }
    const job = { id, url: `import:${id}`, source: 'files', status: 'completed', playlistTitle: `Private ${id}`,
      initiatedBy: owner && { id: owner.id, name: owner.name }, contributors,
      outputDir, folderName: id, files, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      output: 'Private process logs', command: ['private', 'arguments'] };
    await writeJob(database, job);
    return job;
  }
  const job = await seedJob('shared-song', users.Owner,
    [songName, nestedName, 'Other.mp3', 'Track.flac', 'metadata.json', 'movie.mp4', 'missing.mp3', 'directory.mp3'],
    [{ id: users.Contributor.id, name: users.Contributor.name }]);
  await fs.unlink(path.join(job.outputDir, 'missing.mp3'));
  await fs.unlink(path.join(job.outputDir, 'directory.mp3'));
  await fs.mkdir(path.join(job.outputDir, 'directory.mp3'));
  await fs.writeFile(path.join(job.outputDir, 'unlisted.mp3'), audio);
  await seedJob('unowned', null);
  await seedJob('delete-song');
  await seedJob('delete-job');
  await seedJob('deleted-creator', users.Deleted);
  await fs.mkdir(path.join(directory, 'public'));
  await fs.writeFile(path.join(directory, 'public', 'index.html'), '<!doctype html><title>Share test shell</title>');
  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  })));
  const [httpPort, httpsPort] = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  async function startServer() {
    server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)),
      '--http-port', String(httpPort), '--https-port', String(httpsPort)], {
      cwd: directory,
      env: { ...process.env, YTDLP_OUTPUT_ROOT: outputRoot, YTDLP_PATH: process.execPath,
        IMPORT_STORAGE_ROOT: path.join(directory, 'imports'), LIBRARY_BACKUP_ROOT: path.join(directory, 'backups'),
        HTTPS_KEY_PATH: '', HTTPS_CERT_PATH: '', PASSKEY_RP_ID: 'localhost',
        PASSKEY_ORIGIN: `https://localhost:${httpsPort}`, TRUST_PROXY: '', TRANSCRIPTION_ENDPOINT: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      let output = '';
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Test server exited with ${code}: ${output}`)));
      server.stderr.on('data', (chunk) => { output += chunk; });
      server.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ssYTDLP HTTPS server listening')) resolve();
      });
    });
  }
  const call = (route, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const request = https.request({ hostname: '127.0.0.1', port: httpsPort, path: route,
      method, headers: { 'Content-Type': 'application/json',
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...headers },
      rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        resolve({ status: response.statusCode, text, buffer, headers: response.headers,
          body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
  const createPath = (id = job.id, name = songName) => `/api/jobs/${id}/files/${encodeURIComponent(name)}/share`;
  async function share(headers = credentials.Owner[0], id = job.id, name = songName) {
    const response = await call(createPath(id, name), 'POST', headers);
    assert.equal(response.status, 201, response.text);
    assert.deepEqual(Object.keys(response.body), ['url']);
    assert.match(response.body.url, /^\/share\/[A-Za-z0-9_-]{43}$/);
    return response.body.url.slice('/share/'.length);
  }
  const mediaPath = (token) => `/api/public/media/${token}`;
  const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  function privacyHeaders(response) {
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
    assert.ok(response.headers['content-security-policy']);
  }
  async function unavailable(token) {
    for (const suffix of ['', '/stream', '/download']) {
      const response = await call(`${mediaPath(token)}${suffix}`);
      assert.equal(response.status, 404, response.text);
      assert.deepEqual(response.body, { error: 'Shared song not found' });
      privacyHeaders(response);
    }
  }
  await startServer();
  let ownerToken;
  let contributorToken;
  let adminToken;
  await context.test('only approved owners, contributors and admins can create links using sessions or PATs', async () => {
    for (const headers of [{}, ...credentials.Pending, ...credentials.Revoked]) {
      assert.equal((await call(createPath(), 'POST', headers)).status, 401);
    }
    for (const headers of [...credentials.Other, ...credentials.Reader]) {
      assert.equal((await call(createPath(), 'POST', headers)).status, 403);
    }
    for (const name of ['Owner', 'Contributor', 'Admin']) {
      for (const headers of credentials[name]) await share(headers);
    }
    ownerToken = await share();
    contributorToken = await share(credentials.Contributor[0]);
    adminToken = await share(credentials.Admin[0], 'unowned');
    assert.equal((await call(createPath('unowned'), 'POST', credentials.Owner[0])).status, 403);
    for (const name of ['metadata.json', 'movie.mp4', 'unlisted.mp3', 'missing.mp3', 'directory.mp3',
      '../Other.mp3', 'bad\\path.mp3', '.download-archive.txt', 'bad\0.mp3']) {
      const response = await call(createPath(job.id, name), 'POST', credentials.Owner[0]);
      assert.equal(response.status, 404, response.text);
      assert.deepEqual(response.body, { error: 'Shared song not found' });
    }
    assert.equal((await call(createPath('absent'), 'POST', credentials.Owner[0])).status, 404);
  });
  await context.test('opaque 32-byte tokens are stored only as hashes and survive a server restart', async () => {
    const rows = await database.prepare('SELECT * FROM media_shares').all();
    assert.equal(new Set(rows.map((row) => row.token_hash)).size, rows.length);
    const row = rows.find((item) => item.token_hash === hash(ownerToken));
    assert.deepEqual(row, { token_hash: hash(ownerToken), job_id: job.id, name: songName, creator_id: users.Owner.id });
    assert.equal(Buffer.from(ownerToken, 'base64url').length, 32);
    assert.ok(!JSON.stringify(rows).includes(ownerToken));
    await stopServer();
    await startServer();
    assert.equal((await call(mediaPath(ownerToken))).status, 200);
  });
  await context.test('only admins can list and revoke shared links without deleting media or other links', async () => {
    const token = await share();
    const endpoint = '/api/admin/media-shares';
    for (const headers of [{}, ...credentials.Owner, ...credentials.Contributor, ...credentials.Reader, ...credentials.Pending]) {
      for (const [route, method] of [[endpoint, 'GET'], [`${endpoint}/${hash(token)}`, 'DELETE']]) {
        assert.ok([401, 403].includes((await call(route, method, headers)).status));
      }
    }
    const listing = await call(endpoint, 'GET', credentials.Admin[0]);
    assert.equal(listing.status, 200, listing.text);
    privacyHeaders(listing);
    const row = listing.body.shares.find((item) => item.id === hash(token));
    assert.deepEqual(row, { id: hash(token), jobId: job.id, name: songName,
      creatorName: users.Owner.name, creatorId: users.Owner.id, playlistTitle: job.playlistTitle });
    assert.equal(listing.body.total, (await database.prepare('SELECT * FROM media_shares').all()).length);
    assert.ok(!listing.text.includes(token));
    assert.equal((await call(`${endpoint}?page=0`, 'GET', credentials.Admin[0])).status, 400);
    const deleted = await call(`${endpoint}/${hash(token)}`, 'DELETE', credentials.Admin[0]);
    assert.equal(deleted.status, 204, deleted.text);
    await unavailable(token);
    assert.equal((await call(mediaPath(ownerToken))).status, 200);
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), audio);
    assert.equal((await call(`${endpoint}/${hash(token)}`, 'DELETE', credentials.Admin[0])).status, 404);
    assert.equal((await call(`${endpoint}/invalid`, 'DELETE', credentials.Admin[0])).status, 404);
    assert.equal((await call('/admin/shared-links', 'GET', credentials.Admin[0])).status, 200);
    const seededHashes = Array.from({ length: 55 }, (_, index) => hash(`pagination-${index}`));
    for (const tokenHash of seededHashes) {
      await database.prepare('INSERT INTO media_shares (token_hash, job_id, name, creator_id) VALUES ($1, $2, $3, $4)')
        .run(tokenHash, job.id, songName, users.Owner.id);
    }
    const first = (await call(endpoint, 'GET', credentials.Admin[0])).body;
    const last = (await call(`${endpoint}?page=999`, 'GET', credentials.Admin[0])).body;
    assert.equal(first.shares.length, 50);
    assert.equal(last.page, 2);
    assert.equal(last.totalPages, 2);
    assert.equal(new Set([...first.shares, ...last.shares].map((item) => item.id)).size, first.total);
    for (const tokenHash of seededHashes) await database.prepare('DELETE FROM media_shares WHERE token_hash = $1').run(tokenHash);
    const clamped = (await call(`${endpoint}?page=2`, 'GET', credentials.Admin[0])).body;
    assert.equal(clamped.page, 1);
    assert.equal(clamped.totalPages, 1);
  });
  await context.test('public metadata is a flat allowlist and ignores missing, expired, malformed or shared authentication', async () => {
    await database.prepare('UPDATE sessions SET expires_at = $1 WHERE user_id = $2')
      .run('2000-01-01T00:00:00.000Z', users.Other.id);
    const expected = { ...await readSongMetadata(path.join(job.outputDir, songName)),
      name: songName, sizeBytes: audio.length, streamUrl: `${mediaPath(ownerToken)}/stream`,
      downloadUrl: `${mediaPath(ownerToken)}/download` };
    assert.equal(expected.rating, 4);
    assert.ok(expected.artwork.startsWith('data:image/png;base64,'));
    assert.deepEqual(expected.sylt, [{ time: 1, text: 'First line' }, { time: 2.5, text: 'Second line' }]);
    for (const headers of [{}, credentials.Other[0], credentials.Reader[0],
      { Cookie: 'ssytdlp_session=%broken' }, { Authorization: ['Bearer', 'invalid'].join(' '), 'X-PAT': 'invalid' }]) {
      const response = await call(mediaPath(ownerToken), 'GET', headers);
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(response.body, expected);
      privacyHeaders(response);
      assert.ok(response.headers.ratelimit);
      assert.equal(response.headers['set-cookie'], undefined);
      const page = await call(`/share/${ownerToken}`, 'GET', headers);
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /Share test shell/);
      privacyHeaders(page);
    }
    const flacToken = await share(credentials.Owner[0], job.id, 'Track.flac');
    const flac = (await call(mediaPath(flacToken))).body;
    assert.equal(flac.title, 'Track');
    assert.equal(flac.artist, '');
    assert.deepEqual(flac.sylt, []);
    assert.equal(flac.artwork, null);
  });
  await context.test('streaming, ranges, HEAD and attachment downloads work for nested song names', async () => {
    const token = await share(credentials.Owner[0], job.id, nestedName);
    const metadata = await call(mediaPath(token));
    assert.equal(metadata.body.name, songName);
    for (const action of ['stream', 'download']) {
      const route = `${mediaPath(token)}/${action}`;
      const full = await call(route);
      assert.equal(full.status, 200, full.text);
      assert.deepEqual(full.buffer, audio);
      assert.match(full.headers['content-type'], /^audio\/mpeg/);
      privacyHeaders(full);
      const head = await call(route, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.buffer.length, 0);
      assert.equal(Number(head.headers['content-length']), audio.length);
      privacyHeaders(head);
      const partial = await call(route, 'GET', { Range: 'bytes=5-14' });
      assert.equal(partial.status, 206, partial.text);
      assert.equal(partial.headers['accept-ranges'], 'bytes');
      assert.equal(partial.headers['content-range'], `bytes 5-14/${audio.length}`);
      assert.deepEqual(partial.buffer, audio.subarray(5, 15));
      privacyHeaders(partial);
      if (action === 'download') {
        assert.match(full.headers['content-disposition'], /attachment/);
        assert.ok(full.headers['content-disposition'].includes(songName));
        assert.ok(!full.headers['content-disposition'].includes('[NoVocals]'));
      }
    }
    const suffix = await call(`${mediaPath(token)}/stream`, 'GET', { Range: 'bytes=-4' });
    assert.deepEqual(suffix.buffer, audio.subarray(-4));
    const invalidRange = await call(`${mediaPath(token)}/stream`, 'GET', { Range: `bytes=${audio.length + 1}-` });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers['content-range'], `bytes */${audio.length}`);
    privacyHeaders(invalidRange);
    const head = await call(mediaPath(token), 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.buffer.length, 0);
  });
  await context.test('invalid tokens and non-allowlisted routes fail generically without enabling private API access', async () => {
    for (const token of ['short', 'A'.repeat(42), 'A'.repeat(43), `${ownerToken}=`,
      `${ownerToken.slice(0, -1)}!`, `${ownerToken[0] === 'A' ? 'B' : 'A'}${ownerToken.slice(1)}`,
      '%00', '%E0%A4%A']) await unavailable(token);
    assert.equal((await call('/api/public/media')).status, 404);
    assert.equal((await call('/api/public')).status, 404);
    const metadata = await call(`${mediaPath(ownerToken)}?jobId=unowned&name=Other.mp3`);
    assert.equal(metadata.body.name, songName);
    for (const suffix of ['/metadata', '/files', '/jobs', '/stream/Other.mp3', '/download-all']) {
      assert.equal((await call(`${mediaPath(ownerToken)}${suffix}`)).status, 404);
    }
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await call(mediaPath(ownerToken), method, {}, '{invalid-json');
      assert.equal(response.status, 404, `${method}: ${response.text}`);
      privacyHeaders(response);
    }
    for (const headers of [{ Authorization: ['Bearer', ownerToken].join(' ') }, { 'X-PAT': ownerToken },
      { Cookie: `ssytdlp_session=${ownerToken}` }]) {
      for (const route of ['/api/jobs', '/api/library', '/api/preferences', '/api/health',
        '/api/admin/users', `/api/jobs/${job.id}/stream/${encodeURIComponent(songName)}`]) {
        assert.equal((await call(route, 'GET', headers)).status, 401, route);
      }
      assert.equal((await call(createPath(), 'POST', headers)).status, 401);
      assert.equal((await call(`/api/jobs/${job.id}`, 'DELETE', headers)).status, 401);
    }
    assert.equal((await call(`/api/jobs?token=${ownerToken}`)).status, 401);
    assert.equal((await call(`/api/jobs/${job.id}/download-all?share=${ownerToken}`)).status, 401);
  });
  await context.test('links recheck creator approval, shared role and current owner/contributor/admin permission', async () => {
    for (const status of ['pending', 'revoked']) {
      await database.prepare('UPDATE users SET status = $1 WHERE id = $2').run(status, users.Owner.id);
      await unavailable(ownerToken);
    }
    await database.prepare("UPDATE users SET status = 'approved', role = 'shared' WHERE id = $1").run(users.Owner.id);
    await unavailable(ownerToken);
    await database.prepare("UPDATE users SET role = 'user' WHERE id = $1").run(users.Owner.id);
    const current = await readPostgresJob(database, job.id);
    await writeJob(database, { ...current, contributors: [] });
    await unavailable(contributorToken);
    await writeJob(database, { ...current, initiatedBy: { id: users.Other.id, name: 'Other' } });
    await unavailable(ownerToken);
    await writeJob(database, current);
    assert.equal((await call(mediaPath(adminToken))).status, 200);
    await database.prepare("UPDATE users SET role = 'user' WHERE id = $1").run(users.Admin.id);
    await unavailable(adminToken);
    await database.prepare("UPDATE users SET role = 'admin' WHERE id = $1").run(users.Admin.id);
  });
  await context.test('file, job and creator deletion cascade links and do not resurrect old tokens', async () => {
    for (const id of ['delete-song', 'delete-job']) {
      const token = await share(credentials.Owner[0], id);
      const route = id === 'delete-song' ? `/api/jobs/${id}/files/${encodeURIComponent(songName)}` : `/api/jobs/${id}`;
      const response = await call(route, 'DELETE', credentials.Owner[0]);
      assert.equal(response.status, id === 'delete-song' ? 200 : 204, response.text);
      assert.equal(await database.prepare('SELECT 1 FROM media_shares WHERE token_hash = $1').get(hash(token)), undefined);
      await unavailable(token);
      await seedJob(id);
      await unavailable(token);
    }
    const token = await share(credentials.Deleted[0], 'deleted-creator');
    await database.prepare('DELETE FROM users WHERE id = $1').run(users.Deleted.id);
    assert.equal(await database.prepare('SELECT 1 FROM media_shares WHERE token_hash = $1').get(hash(token)), undefined);
    await unavailable(token);
    const original = path.join(job.outputDir, songName);
    await fs.rename(original, `${original}.hidden`);
    await unavailable(ownerToken);
    await fs.rename(`${original}.hidden`, original);
  });
  await context.test('symbolic links and changed on-disk paths cannot expose other files', async () => {
    const outside = path.join(directory, 'outside.mp3');
    await fs.writeFile(outside, 'Private bytes outside the job');
    for (const [name, target] of [['outside.mp3', outside], ['alias.mp3', path.join(job.outputDir, songName)]]) {
      await fs.symlink(target, path.join(job.outputDir, name));
      const current = await readPostgresJob(database, job.id);
      await writeJob(database, { ...current, files: [...current.files, name] });
      assert.equal((await call(createPath(job.id, name), 'POST', credentials.Owner[0])).status, 404);
    }
    const original = path.join(job.outputDir, songName);
    await fs.rename(original, `${original}.hidden`);
    await fs.symlink(outside, original);
    await unavailable(ownerToken);
    await fs.unlink(original);
    await fs.rename(`${original}.hidden`, original);
    const nestedToken = await share(credentials.Owner[0], job.id, nestedName);
    const nestedDirectory = path.join(job.outputDir, '[NoVocals]');
    await fs.rename(nestedDirectory, `${nestedDirectory}.hidden`);
    await fs.symlink(`${nestedDirectory}.hidden`, nestedDirectory);
    await unavailable(nestedToken);
    assert.equal((await call(createPath(job.id, nestedName), 'POST', credentials.Owner[0])).status, 404);
    await fs.unlink(nestedDirectory);
    await fs.rename(`${nestedDirectory}.hidden`, nestedDirectory);
    await fs.rename(job.outputDir, `${job.outputDir}.hidden`);
    await fs.symlink(`${job.outputDir}.hidden`, job.outputDir);
    await unavailable(ownerToken);
    assert.equal((await call(createPath(), 'POST', credentials.Owner[0])).status, 404);
    await fs.unlink(job.outputDir);
    await fs.rename(`${job.outputDir}.hidden`, job.outputDir);
  });
  await context.test('song summaries retain normal tags when excluded artwork is validly compressed', async () => {
    const image = NodeID3.read(audio).image;
    const imageBody = NodeID3.create({ image }).subarray(20);
    const compressed = deflateSync(imageBody);
    const frame = Buffer.alloc(14 + compressed.length);
    frame.write('APIC');
    frame.writeUInt32BE(4 + compressed.length, 4);
    frame[9] = 0x80;
    frame.writeUInt32BE(imageBody.length, 10);
    compressed.copy(frame, 14);
    const tags = NodeID3.create({ title: 'Compressed artwork', artist: 'Summary artist' });
    const header = Buffer.from(tags.subarray(0, 10));
    const frames = Buffer.concat([tags.subarray(10), frame]);
    for (let index = 0; index < 4; index += 1) header[6 + index] = (frames.length >>> (21 - index * 7)) & 0x7f;
    const filePath = path.join(directory, 'Compressed-summary.mp3');
    await fs.writeFile(filePath, Buffer.concat([header, frames, Buffer.from('audio fixture')]));
    assert.equal((await readSongMetadata(filePath)).artwork, `data:${image.mime};base64,${image.imageBuffer.toString('base64')}`);
    assert.deepEqual(await readSongSummary(filePath, await fs.stat(filePath)),
      { title: 'Compressed artwork', artist: 'Summary artist', rating: 0 });
    const publicMetadata = await readSongMetadata(filePath, { bounded: true });
    assert.equal(publicMetadata.title, 'Compressed-summary');
    assert.equal(publicMetadata.artwork, null);
  });
  await context.test('public metadata reads bounded tags rather than large audio and rejects unsafe tag sizes', async (subtest) => {
    await stopServer();
    await startServer();
    const names = ['Large.mp3', 'Oversized.mp3', 'Truncated.mp3', 'Untagged.mp3', 'Compressed.mp3', 'Invalid.mp3'];
    const largeJob = await seedJob('bounded-metadata', users.Owner, names);
    const largeSize = 512 * 1024 ** 2;
    const file = (name) => path.join(largeJob.outputDir, name);
    await fs.truncate(file('Large.mp3'), largeSize);
    const header = Buffer.from('ID3\x03\x00\x00\x08\x00\x00\x00', 'latin1');
    await fs.writeFile(file('Oversized.mp3'), header);
    await fs.truncate(file('Oversized.mp3'), largeSize);
    await fs.writeFile(file('Truncated.mp3'), audio.subarray(0, 10));
    await fs.writeFile(file('Untagged.mp3'), 'Audio without an ID3 tag');
    await fs.truncate(file('Untagged.mp3'), largeSize);
    const compressed = Buffer.from(audio);
    compressed[19] |= 0x80;
    await fs.writeFile(file('Compressed.mp3'), compressed);
    const invalid = Buffer.from(audio);
    invalid[3] = 9;
    await fs.writeFile(file('Invalid.mp3'), invalid);
    const expected = await readSongMetadata(path.join(job.outputDir, songName));
    const defaults = await readSongMetadata(path.join(job.outputDir, 'Track.flac'));
    const originalOpen = fs.open;
    const reads = [];
    const openMock = subtest.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      subtest.mock.method(handle, 'read', (...readArgs) => {
        reads.push(readArgs[2]);
        return read(...readArgs);
      });
      return handle;
    });
    const tagSize = audio.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0) + 10;
    assert.deepEqual(await readSongMetadata(file('Large.mp3'), { bounded: true }), expected);
    assert.equal(reads.reduce((sum, size) => sum + size, 0), tagSize);
    for (const name of names.slice(1)) {
      reads.length = 0;
      const metadata = await readSongMetadata(file(name), { bounded: true });
      assert.deepEqual(metadata, { ...defaults, title: path.basename(name, '.mp3') });
      assert.equal(reads.reduce((sum, size) => sum + size, 0), name === 'Compressed.mp3' ? tagSize : 10);
    }
    openMock.mock.restore();
    for (const name of names) {
      const token = await share(credentials.Owner[0], largeJob.id, name);
      const response = await call(mediaPath(token));
      assert.equal(response.status, 200, response.text);
      const metadata = name === 'Large.mp3' ? expected : { ...defaults, title: path.basename(name, '.mp3') };
      assert.deepEqual(response.body, { ...metadata, name, sizeBytes: (await fs.stat(file(name))).size,
        streamUrl: `${mediaPath(token)}/stream`, downloadUrl: `${mediaPath(token)}/download` });
      privacyHeaders(response);
      const head = await call(mediaPath(token), 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.buffer.length, 0);
      privacyHeaders(head);
    }
  });
  await context.test('public metadata limits concurrent GET and HEAD work and releases slots after completion', async () => {
    const locked = Promise.withResolvers();
    const unlock = Promise.withResolvers();
    const transaction = database.withTransaction(async () => {
      await database.exec('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
      locked.resolve();
      await unlock.promise;
    });
    const pending = [];
    try {
      await Promise.race([locked.promise, transaction]);
      for (const method of ['GET', 'HEAD', 'GET', 'HEAD']) pending.push(call(mediaPath(ownerToken), method));
      let waiting = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        waiting = (await database.prepare(`SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%FROM media_shares shares%'`).get()).count;
        if (waiting === 4) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, 4);
      for (const method of ['GET', 'HEAD']) {
        let timer;
        try {
          const busy = await Promise.race([call(mediaPath(ownerToken), method),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Metadata overload request was queued instead of rejected')), 2000);
            })]);
          assert.equal(busy.status, 503);
          assert.equal(busy.headers['retry-after'], '1');
          privacyHeaders(busy);
          if (method === 'GET') assert.deepEqual(busy.body, { error: 'Shared song metadata is busy. Please retry.' });
          else assert.equal(busy.buffer.length, 0);
        } finally { clearTimeout(timer); }
      }
    } finally {
      unlock.resolve();
      await transaction;
      await Promise.all(pending);
    }
    for (const response of await Promise.all(pending)) assert.equal(response.status, 200, response.text);
    assert.equal((await call(mediaPath(ownerToken))).status, 200);
    await unavailable('invalid');
    assert.equal((await call(mediaPath(ownerToken))).status, 200);
  });
});
