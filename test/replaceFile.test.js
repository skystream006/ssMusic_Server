import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import NodeID3 from 'node-id3';
import { writeJob } from '../src/database.js';
import { readPostgresJob, readPostgresJobs } from '../src/postgresCatalog.js';
import { createTestDatabase } from '../test-support/postgres.js';

const boundary = 'replacement-regression-boundary';
const multipartHeaders = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
function header(name = 'new.mp3', field = 'file') {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
}
function multipart(files) {
  if (!files.length) return Buffer.from(`--${boundary}--\r\n`);
  return Buffer.concat(files.flatMap(({ name, data, field }, index) => [
    ...(index ? [Buffer.from('\r\n')] : []), header(name, field), data
  ]).concat(ending));
}
function audio(tags = {}) {
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame);
  return NodeID3.write(tags, Buffer.concat([frame, frame, frame]));
}
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the test operation');
}

test('Replace File HTTP uploads preserve song identity and fail safely', { timeout: 180_000 }, async (context) => {
  let server;
  const { directory, database } = await createTestDatabase(context, { beforeCleanup: async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  } });
  const store = await import('../src/authStore.js');
  const users = {};
  const credentials = {};
  for (const name of ['Admin', 'Owner', 'Contributor', 'Other', 'Shared', 'Pending', 'Revoked']) {
    users[name] = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (!['Admin', 'Pending'].includes(name)) {
      users[name] = await store.updateUser(users[name].id, { status: 'approved' }, users.Admin.id);
    }
    const session = await store.createSession(users[name].id);
    credentials[name] = [{ Cookie: `ssytdlp_session=${session.token}` }, { Authorization: ['Bearer', session.token].join(' ') }];
    if (name !== 'Pending') {
      const pat = await store.createPrivateAccessToken(users[name].id, 'Replacement tests');
      credentials[name].push({ 'X-PAT': pat.token });
    }
  }
  await store.updateUser(users.Shared.id, { role: 'shared', sharedUserIds: [users.Owner.id] }, users.Admin.id);
  await store.updateUser(users.Revoked.id, { status: 'revoked' }, users.Admin.id);
  const outputRoot = path.join(directory, 'output');
  const songName = 'Song 100% #1.mp3';
  const noVocalsName = `[NoVocals]/${songName}`;
  const original = audio({ title: 'Old title', album: 'Old album', artist: 'Old artist',
    popularimeter: { email: 'test', rating: 255, counter: 1 },
    unsynchronisedLyrics: { language: 'eng', text: 'Old lyrics' } });
  const kept = audio({ title: 'Never replace me' });
  async function seedJob(id, { owner = users.Owner, outputDir = path.join(outputRoot, id), files = [songName, 'keep.mp3'],
    status = 'completed', contributors = [], ...extra } = {}) {
    await fs.mkdir(outputDir, { recursive: true });
    for (const name of files) {
      await fs.mkdir(path.dirname(path.join(outputDir, name)), { recursive: true });
      await fs.writeFile(path.join(outputDir, name), name === 'keep.mp3' ? kept : original);
    }
    const job = { id, url: `import:${id}`, source: 'files', isPlaylist: true, playlistTitle: id,
      status, initiatedBy: owner && { id: owner.id, name: owner.name }, contributors,
      outputDir, folderName: id, files, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra };
    await writeJob(database, job);
    return job;
  }
  const job = await seedJob('replace', { contributors: [{ id: users.Contributor.id, name: 'Contributor' }],
    files: [songName, 'keep.mp3', noVocalsName],
    songMetadata: { [songName]: { title: 'Old title', artist: 'Old artist', album: 'Old album', transcriptionLocked: true } },
    transcriptions: { [songName]: { status: 'transcribed', requestedAt: 'old', completedAt: 'old', error: 'stale',
      options: { language: 'en' }, lyricsIncluded: true, noVocalsName } } });
  const shared = await seedJob('shared-output');
  await seedJob('other-owner', { owner: users.Other, outputDir: shared.outputDir });
  await seedJob('unowned', { owner: null });
  await seedJob('busy');
  const unsafe = await seedJob('unsafe');
  const outside = path.join(directory, 'outside.mp3');
  await fs.writeFile(outside, original);
  await fs.symlink(outside, path.join(unsafe.outputDir, 'escape.mp3'));
  await fs.symlink(path.join(unsafe.outputDir, songName), path.join(unsafe.outputDir, 'alias.mp3'));
  await fs.mkdir(path.join(unsafe.outputDir, '[NoVocals]'));
  await fs.symlink(outside, path.join(unsafe.outputDir, '[NoVocals]', 'escape.mp3'));
  await fs.writeFile(path.join(unsafe.outputDir, 'unlisted.mp3'), original);
  unsafe.files.push('escape.mp3', 'alias.mp3', '[NoVocals]/escape.mp3', 'missing.mp3', 'movie.mp4');
  await writeJob(database, unsafe);
  const linkedFolder = await seedJob('linked-folder', { files: [] });
  await fs.symlink(unsafe.outputDir, path.join(linkedFolder.outputDir, '[NoVocals]'));
  await writeJob(database, { ...linkedFolder, files: [noVocalsName] });

  let transcriptionResponse;
  const transcriptionServer = http.createServer((req, res) => {
    req.resume();
    transcriptionResponse = res;
  });
  await new Promise((resolve) => transcriptionServer.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => {
    transcriptionResponse?.end();
    transcriptionServer.close(resolve);
    transcriptionServer.closeAllConnections();
  }));
  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))));
  const [httpPort, httpsPort] = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)),
    '--http-port', String(httpPort), '--https-port', String(httpsPort)], {
    cwd: directory, env: { ...process.env, YTDLP_OUTPUT_ROOT: outputRoot, YTDLP_PATH: process.execPath,
      HTTPS_KEY_PATH: '', HTTPS_CERT_PATH: '', PASSKEY_RP_ID: 'localhost', PASSKEY_ORIGIN: `https://localhost:${httpsPort}`,
      TRUST_PROXY: '', TRANSCRIPTION_ENDPOINT: `http://127.0.0.1:${transcriptionServer.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Server exited with ${code}: ${output}`)));
    server.stderr.on('data', (chunk) => { output += chunk; });
    server.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ssYTDLP HTTPS server listening')) resolve();
    });
  });
  const ca = await fs.readFile(path.join(directory, 'data', 'tls', 'server-cert.pem'));
  function request(route, method = 'GET', headers = credentials.Owner[0]) {
    let req;
    const response = new Promise((resolve, reject) => {
      req = https.request({ hostname: '127.0.0.1', port: httpsPort, path: route, method, headers, ca }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, buffer, headers: res.headers,
            body: res.headers['content-type']?.includes('application/json') ? JSON.parse(buffer.toString()) : null });
        });
      });
      req.on('error', reject);
    });
    return { req, response };
  }
  async function call(route, method = 'GET', headers = credentials.Owner[0], body) {
    const { req, response } = request(route, method, body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) });
    req.end(body);
    return response;
  }
  const route = (id = job.id, name = songName) => `/api/jobs/${id}/files/${encodeURIComponent(name)}/replace`;
  const replace = (files = [{ name: 'replacement.MP3', data: original }], headers = credentials.Owner[0], id = job.id, name = songName) =>
    call(route(id, name), 'POST', { ...headers, ...multipartHeaders }, multipart(files));
  async function assertClean(folder = job.outputDir) {
    assert.ok(!(await fs.readdir(folder)).some((name) => name.startsWith('.replace-')));
    assert.ok(!(await fs.readdir(path.join(job.outputDir, '[NoVocals]'))).some((name) => name.startsWith('.replace-')));
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, 'keep.mp3')), kept);
  }

  await context.test('requires approved authentication and owner, contributor or administrator rights', async () => {
    assert.equal((await replace(undefined, {})).status, 401);
    for (const name of ['Pending', 'Revoked', 'Other', 'Shared']) {
      for (const headers of credentials[name]) {
        const response = await replace(undefined, headers);
        assert.equal(response.status, ['Other', 'Shared'].includes(name) ? 403 : 401, JSON.stringify(response.body));
      }
    }
    for (const name of ['Owner', 'Contributor', 'Admin']) {
      for (const headers of credentials[name]) assert.equal((await replace(undefined, headers)).status, 200);
    }
    assert.equal((await replace(undefined, credentials.Owner[0], 'unowned')).status, 403);
    assert.equal((await replace(undefined, credentials.Admin[0], 'unowned')).status, 200);
    assert.equal((await replace(undefined, credentials.Owner[0], shared.id)).status, 403);
    assert.equal((await replace(undefined, credentials.Admin[0], shared.id)).status, 200);
    assert.equal((await replace(undefined, credentials.Owner[0], 'unknown')).status, 404);
    await assertClean();
  });

  await context.test('rejects missing, extra, empty, invalid and mismatched uploads without touching the original', async () => {
    const before = await fs.readFile(path.join(job.outputDir, songName));
    const beforeJob = await readPostgresJob(database, job.id);
    const invalid = [
      [],
      [{ name: 'new.mp3', data: Buffer.alloc(0) }],
      [{ name: 'new.mp3', data: Buffer.from('not audio') }],
      [{ name: 'new.wav', data: original }],
      [{ name: 'new.mp3', data: Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00', 'binary') }],
      [{ name: 'new.mp3', data: original, field: 'wrong' }],
      [{ name: 'new.mp3', data: original }, { name: 'second.mp3', data: original }]
    ];
    for (const files of invalid) {
      const response = await replace(files);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), before);
      assert.deepEqual(await readPostgresJob(database, job.id), beforeJob);
      await assertClean();
    }
    for (const body of [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nignored\r\n--${boundary}--\r\n`),
      Buffer.concat([header(), original])
    ]) assert.equal((await call(route(), 'POST', { ...credentials.Owner[0], ...multipartHeaders }, body)).status, 400);
    assert.equal((await call(route(), 'POST', { ...credentials.Owner[0], 'Content-Type': 'application/json' }, '{}')).status, 400);
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), before);
    await assertClean();
  });

  await context.test('rejects traversal, unlisted files, video and escaping or aliased symlinks', async () => {
    for (const [name, status] of [['../outside.mp3', 400], ['[NoVocals]/../outside.mp3', 400],
      ['nested/song.mp3', 400], ['C:\\song.mp3', 400], ['escape.mp3', 400], ['alias.mp3', 400],
      ['[NoVocals]/escape.mp3', 400], ['unlisted.mp3', 404], ['missing.mp3', 404], ['movie.mp4', 400]]) {
      assert.equal((await replace(undefined, credentials.Owner[0], unsafe.id, name)).status, status, name);
    }
    assert.equal((await replace(undefined, credentials.Owner[0], linkedFolder.id, noVocalsName)).status, 400);
    assert.deepEqual(await fs.readFile(outside), original);
    await assertClean(unsafe.outputDir);
  });

  await context.test('refreshes metadata, artwork, lyrics, search and stream revision while keeping all playlist links and locks', async () => {
    const { getLibrary, setLibrary } = await import('../src/libraryStore.js');
    await seedJob('extra-playlist', { files: [] });
    const jobs = await readPostgresJobs(database, users.Owner.id);
    const library = await getLibrary(users.Owner.id, jobs);
    await setLibrary(users.Owner.id, { ...library, songAdds: [...library.songAdds,
      { jobId: job.id, name: songName, playlistId: 'extra-playlist' }] }, jobs);
    const memberships = await database.prepare('SELECT * FROM library_memberships WHERE user_id = $1 ORDER BY playlist_id, name').all(users.Owner.id);
    const before = (await call(`/api/jobs/${job.id}/files`)).body.files.find((file) => file.name === songName);
    const imageBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    const replacement = audio({ title: 'Brand new replacement', artist: 'Replacement artist',
      image: { mime: 'image/png', type: { id: 3, name: 'front cover' }, imageBuffer },
      synchronisedLyrics: [{ language: 'eng', timeStampFormat: 2, contentType: 1,
        synchronisedText: [{ timeStamp: 1000, text: 'New timed line' }] }],
      unsynchronisedLyrics: { language: 'eng', text: 'New plain lyrics' } });
    const result = await replace([{ name: 'different filename.mp3', data: replacement }]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.file.name, songName);
    assert.equal(result.body.file.title, 'Brand new replacement');
    assert.equal(result.body.file.album, '');
    assert.equal(result.body.file.rating, 0);
    assert.equal(result.body.file.sizeBytes, replacement.length);
    assert.equal(result.body.file.noVocalsName, noVocalsName);
    assert.equal(result.body.file.noVocalsVersion.name, noVocalsName);
    assert.notEqual(result.body.file.streamUrl, before.streamUrl);
    assert.equal(result.body.file.downloadUrl, before.downloadUrl);
    assert.equal(result.body.metadata.title, result.body.file.title);
    assert.equal(result.body.metadata.transcriptionLocked, true);
    assert.equal(result.body.metadata.uslt, 'New plain lyrics');
    assert.deepEqual(result.body.metadata.sylt, [{ time: 1, text: 'New timed line' }]);
    assert.equal(result.body.metadata.artwork, `data:image/png;base64,${imageBuffer.toString('base64')}`);
    assert.deepEqual((await call(result.body.file.streamUrl)).buffer, replacement);
    const ranged = await call(result.body.file.streamUrl, 'GET', { ...credentials.Owner[0], Range: 'bytes=0-15' });
    assert.equal(ranged.status, 206);
    assert.deepEqual(ranged.buffer, replacement.subarray(0, 16));
    const metadata = (await call(`/api/jobs/${job.id}/lyrics/${encodeURIComponent(songName)}`)).body;
    const { canEdit, ...storedMetadata } = metadata;
    assert.equal(canEdit, true);
    assert.deepEqual(storedMetadata, result.body.metadata);
    assert.deepEqual((await call(`/api/jobs/${job.id}/files`)).body.files.find((file) => file.name === songName), result.body.file);
    const stored = await readPostgresJob(database, job.id);
    assert.deepEqual(stored.files, job.files);
    assert.deepEqual(stored.transcriptions[songName], { noVocalsName });
    assert.equal(stored.songMetadata[songName].album, '');
    assert.equal(stored.songMetadata[songName].transcriptionLocked, true);
    assert.deepEqual(await database.prepare('SELECT * FROM library_memberships WHERE user_id = $1 ORDER BY playlist_id, name').all(users.Owner.id), memberships);
    const search = await call('/api/library/tracks?search=Brand%20new%20replacement');
    assert.equal(search.status, 200);
    assert.ok(search.body.files.some((file) => file.name === songName && file.title === 'Brand new replacement'));
    await assertClean();
  });

  await context.test('returns explicit cleared metadata when untagged audio replaces a tagged song', async () => {
    const untagged = NodeID3.removeTagsFromBuffer(audio());
    const result = await replace([{ name: 'untagged.mp3', data: untagged }]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const expected = { title: path.basename(songName, '.mp3'), artist: '', album: '', performerInfo: '',
      genre: '', year: '', trackNumber: '', partOfSet: '', rating: 0, transcriptionLocked: true };
    const stored = await readPostgresJob(database, job.id);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(Object.hasOwn(result.body.file, field), true, field);
      assert.equal(result.body.file[field], value, field);
      assert.equal(result.body.metadata[field], value, field);
      assert.equal(stored.songMetadata[songName][field], value, field);
    }
    assert.equal(result.body.metadata.artwork, null);
    assert.equal(result.body.metadata.uslt, '');
    assert.deepEqual(result.body.metadata.sylt, []);
    assert.deepEqual(stored.transcriptions[songName], { noVocalsName });
    assert.deepEqual((await call(result.body.file.streamUrl)).buffer, untagged);
    await assertClean();
  });

  await context.test('advances playback revision for identical uploads even when the original mtime is in the future', async () => {
    const filePath = path.join(job.outputDir, songName);
    const unchanged = await fs.readFile(filePath);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, future, future);
    let previous = (await call(`/api/jobs/${job.id}/files`)).body.files.find((file) => file.name === songName);
    for (let i = 0; i < 2; i += 1) {
      const result = await replace([{ name: 'identical.mp3', data: unchanged }]);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.file.sizeBytes, previous.sizeBytes);
      assert.notEqual(result.body.file.streamUrl, previous.streamUrl);
      const revision = (file) => Number(new URL(file.streamUrl, 'https://localhost').searchParams.get('v'));
      assert.ok(revision(result.body.file) > revision(previous));
      assert.deepEqual(await fs.readFile(filePath), unchanged);
      previous = result.body.file;
    }
    await assertClean();
  });

  await context.test('replaces nested NoVocals audio independently without removing its original association', async () => {
    const main = await fs.readFile(path.join(job.outputDir, songName));
    const replacement = audio({ title: 'New instrumental' });
    const result = await replace([{ name: 'instrumental.mp3', data: replacement }], credentials.Owner[2], job.id, noVocalsName);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.file.name, noVocalsName);
    assert.equal(result.body.metadata.title, 'New instrumental');
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), main);
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, noVocalsName)), replacement);
    const stored = await readPostgresJob(database, job.id);
    assert.equal(stored.transcriptions[songName].noVocalsName, noVocalsName);
    assert.equal(Object.hasOwn(stored.transcriptions, noVocalsName), false);
    await assertClean();
  });

  await context.test('accepts same-format WAV audio without conversion and rejects disguised MP3 content', async () => {
    const wav = Buffer.alloc(204);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    const wavJob = await seedJob('wave', { files: ['Original.wav'],
      transcriptions: { 'Original.wav': { status: 'failed', error: 'Stale failure' } } });
    await fs.writeFile(path.join(wavJob.outputDir, 'Original.wav'), wav);
    assert.equal((await replace([{ name: 'disguised.wav', data: original }], credentials.Owner[0], 'wave', 'Original.wav')).status, 400);
    wav.writeInt16LE(100, 44);
    const result = await replace([{ name: 'different.WAV', data: wav }], credentials.Owner[0], 'wave', 'Original.wav');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.file.name, 'Original.wav');
    assert.equal(result.body.metadata.title, 'Original');
    assert.deepEqual(await fs.readFile(path.join(wavJob.outputDir, 'Original.wav')), wav);
    assert.deepEqual((await readPostgresJob(database, 'wave')).transcriptions, {});
    await assertClean(wavJob.outputDir);
  });

  await context.test('rejects queued/running jobs and an active transcription', async () => {
    for (const status of ['queued', 'running']) {
      await seedJob(status, { status });
      assert.equal((await replace(undefined, credentials.Owner[0], status)).status, 409);
    }
    const transcribing = call('/api/jobs/busy/files/keep.mp3/transcribe', 'POST',
      { ...credentials.Owner[0], 'Content-Type': 'application/json' }, '{}');
    await waitUntil(() => transcriptionResponse);
    try {
      assert.equal((await replace(undefined, credentials.Owner[0], 'busy')).status, 409);
    } finally { transcriptionResponse.writeHead(500).end(); }
    assert.equal((await transcribing).status, 502);
    assert.equal((await replace(undefined, credentials.Owner[0], 'busy')).status, 200);
  });

  await context.test('locks the job throughout upload and releases it after an aborted request', async () => {
    const before = await fs.readFile(path.join(job.outputDir, songName));
    const { req, response } = request(route(), 'POST', { ...credentials.Owner[0], ...multipartHeaders });
    const aborted = response.catch(() => null);
    req.write(header());
    req.write(original);
    await waitUntil(async () => (await fs.readdir(job.outputDir)).some((name) => name.startsWith('.replace-')));
    try {
      assert.equal((await replace()).status, 409);
      for (const [method, suffix, body = '{}'] of [
        ['PATCH', `/files/${encodeURIComponent(songName)}/metadata`, '{"title":"Blocked"}'],
        ['POST', `/files/keep.mp3/transcribe`], ['POST', '/rerun'],
        ['DELETE', `/files/${encodeURIComponent(songName)}`], ['DELETE', ''],
        ['PATCH', '/title', '{"playlistTitle":"Blocked"}'], ['PUT', '/contributors', '{"userIds":[]}']
      ]) {
        const result = await call(`/api/jobs/${job.id}${suffix}`, method,
          { ...credentials.Owner[0], 'Content-Type': 'application/json' }, body);
        assert.equal(result.status, 409, `${method} ${suffix}: ${JSON.stringify(result.body)}`);
      }
      assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), before);
    } finally { req.destroy(); }
    await aborted;
    await waitUntil(async () => !(await fs.readdir(job.outputDir)).some((name) => name.startsWith('.replace-')));
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), before);
    assert.equal((await replace()).status, 200);
    await assertClean();
  });

  await context.test('streams and rejects uploads larger than 512 MB, preserving bytes and cleaning staging', async () => {
    const before = await fs.readFile(path.join(job.outputDir, songName));
    const { req, response } = request(route(), 'POST', { ...credentials.Owner[0], ...multipartHeaders });
    req.write(header());
    const chunk = Buffer.alloc(1024 ** 2);
    for (let i = 0; i < 512; i += 1) if (!req.write(chunk)) await once(req, 'drain');
    req.end(Buffer.concat([Buffer.from('x'), ending]));
    const result = await response;
    assert.equal(result.status, 413, JSON.stringify(result.body));
    assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), before);
    await assertClean();
  });

  await context.test('serializes replacements and mutations through shared output folder aliases', async () => {
    const { req, response } = request(route(shared.id), 'POST', { ...credentials.Admin[0], ...multipartHeaders });
    const aborted = response.catch(() => null);
    req.write(header());
    req.write(original);
    await waitUntil(async () => (await fs.readdir(shared.outputDir)).some((name) => name.startsWith('.replace-')));
    try {
      assert.equal((await replace(undefined, credentials.Admin[0], 'other-owner')).status, 409);
      const result = await call(`/api/jobs/other-owner/files/${encodeURIComponent(songName)}/metadata`, 'PATCH',
        { ...credentials.Admin[0], 'Content-Type': 'application/json' }, '{"title":"Blocked"}');
      assert.equal(result.status, 409);
    } finally { req.destroy(); }
    await aborted;
    await waitUntil(async () => !(await fs.readdir(shared.outputDir)).some((name) => name.startsWith('.replace-')));
    assert.equal((await replace(undefined, credentials.Admin[0], 'other-owner')).status, 200);
    await assertClean(shared.outputDir);
  });

  await context.test('rolls back the file and metadata when database commit fails', async () => {
    const before = await fs.readFile(path.join(job.outputDir, songName));
    const beforeJob = await readPostgresJob(database, job.id);
    await database.exec(`CREATE FUNCTION fail_replacement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected replacement database failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_replacement AFTER UPDATE ON songs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.metadata->>'title' = 'Reject this replacement') EXECUTE FUNCTION fail_replacement()`);
    try {
      const result = await replace([{ name: 'new.mp3', data: audio({ title: 'Reject this replacement' }) }]);
      assert.equal(result.status, 500, JSON.stringify(result.body));
      assert.deepEqual(await fs.readFile(path.join(job.outputDir, songName)), before);
      assert.deepEqual(await readPostgresJob(database, job.id), beforeJob);
      await assertClean();
    } finally { await database.exec('DROP TRIGGER fail_replacement ON songs; DROP FUNCTION fail_replacement()'); }
    assert.equal((await replace()).status, 200);
  });

  await context.test('preserves the original on staging, validation and atomic rename failures', async (t) => {
    const manager = await import('../src/jobManager.js');
    const filePath = path.join(job.outputDir, songName);
    const before = await fs.readFile(filePath);
    const beforeJob = await readPostgresJob(database, job.id);
    for (const operation of [
      async () => { throw Object.assign(new Error('Upload write failed'), { code: 'ENOSPC' }); },
      async (staged) => { await fs.writeFile(staged, 'partial'); throw new Error('Validation failed'); }
    ]) {
      await assert.rejects(manager.replaceJobFile(job.id, songName, users.Owner, operation));
      assert.deepEqual(await fs.readFile(filePath), before);
      await assertClean();
    }
    const rename = fs.rename;
    const mock = t.mock.method(fs, 'rename', async (from, to) => {
      if (from.includes('.replace-') && path.basename(from) === songName) throw Object.assign(new Error('Rename failed'), { code: 'EIO' });
      return rename(from, to);
    });
    try {
      await assert.rejects(manager.replaceJobFile(job.id, songName, users.Owner,
        (staged) => fs.writeFile(staged, audio({ title: 'Do not save' }))), /Rename failed/);
      assert.deepEqual(await fs.readFile(filePath), before);
      assert.deepEqual(await readPostgresJob(database, job.id), beforeJob);
      await assertClean();
    } finally { mock.mock.restore(); }
    assert.ok(await manager.replaceJobFile(job.id, songName, users.Owner, (staged) => fs.writeFile(staged, before)));
  });

  await context.test('rejects replacement while another mutation is committing to the database', async (t) => {
    const manager = await import('../src/jobManager.js');
    for (const mutate of [
      () => manager.setJobTitle(job.id, 'Changed playlist', users.Owner),
      () => manager.setJobContributors(job.id, [users.Contributor.id], users.Owner),
      () => manager.setSongMetadata(job.id, songName, { rating: 2 }, users.Owner)
    ]) {
      let release;
      let committing = false;
      const gate = new Promise((resolve) => { release = resolve; });
      const transaction = database.withTransaction;
      const mock = t.mock.method(database, 'withTransaction', async (operation) => {
        committing = true;
        await gate;
        return transaction(operation);
      });
      const operation = mutate();
      try {
        await waitUntil(() => committing);
        await assert.rejects(manager.replaceJobFile(job.id, songName, users.Owner, () => assert.fail('Upload must not begin')), { statusCode: 409 });
      } finally {
        release();
        await operation;
        mock.mock.restore();
      }
      await assertClean();
    }
  });
});
