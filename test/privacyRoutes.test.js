import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import AdmZip from 'adm-zip';
import NodeID3 from 'node-id3';
import { writeJob } from '../src/database.js';
import { createTestDatabase } from '../test-support/postgres.js';

test('privacy and search keys enforce owner-only access through HTTP', { timeout: 120_000 }, async (context) => {
  let server;
  let certificate;
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
  const { directory, database } = await createTestDatabase(context, { beforeCleanup: stop });
  const store = await import('../src/authStore.js');
  const users = {};
  const headers = {};
  for (const name of ['Admin', 'Owner', 'Contributor', 'Linked', 'Reader']) {
    const user = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (name !== 'Admin') await store.updateUser(user.id, { status: 'approved' }, users.Admin.id);
    users[name] = user;
    headers[name] = { 'X-PAT': (await store.createPrivateAccessToken(user.id, 'Privacy tests')).token };
  }
  await store.updateUser(users.Reader.id, { role: 'shared', sharedUserIds: [users.Owner.id] }, users.Admin.id);
  await store.requestUserLink(users.Linked.id, users.Owner.id);
  await store.acceptUserLink(users.Owner.id, users.Linked.id);
  const key = randomBytes(32).toString('hex');
  const keyHeaders = { 'X-API-Key': key };
  const outputRoot = path.join(directory, 'output');
  for (const id of ['playlist', 'other']) {
    const outputDir = path.join(outputRoot, id);
    await fs.mkdir(outputDir, { recursive: true });
    const files = id === 'playlist' ? ['open.mp3', 'secret-file.mp3', '[NoVocals]/secret-file.mp3', 'clip.mp4'] : ['elsewhere.mp3'];
    await fs.mkdir(path.join(outputDir, '[NoVocals]'), { recursive: true });
    for (const name of files) await fs.writeFile(path.join(outputDir, name), name === 'open.mp3'
      ? NodeID3.write({ title: 'A 100% song', artist: 'Test Artist' }, Buffer.from(`audio:${name}`)) : `audio:${name}`);
    await writeJob(database, { id, url: `https://music.youtube.com/playlist?list=${id}`, status: 'completed',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isPlaylist: true,
      initiatedBy: { id: users[id === 'playlist' ? 'Owner' : 'Linked'].id },
      contributors: id === 'playlist' ? [{ id: users.Contributor.id }] : [],
      outputDir, files, playlistTitle: id === 'playlist' ? 'Owner playlist' : 'Other library',
      output: 'Downloaded secret-file.mp3', songMetadata: { 'open.mp3': { title: 'A 100% song', artist: 'Test Artist' } } });
  }
  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))));
  const [httpPort, httpsPort] = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  async function start(searchKey = key) {
    server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)),
      '--http-port', String(httpPort), '--https-port', String(httpsPort)], {
      cwd: directory, env: { ...process.env, SEARCH_API_KEY: searchKey, YTDLP_OUTPUT_ROOT: outputRoot,
        LIBRARY_BACKUP_ROOT: path.join(directory, 'backups'), HTTPS_KEY_PATH: '', HTTPS_CERT_PATH: '',
        PASSKEY_RP_ID: 'localhost', PASSKEY_ORIGIN: `https://localhost:${httpsPort}`, TRUST_PROXY: '', TRANSCRIPTION_ENDPOINT: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      let output = '';
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Server exited with ${code}: ${output}`)));
      server.stderr.on('data', (chunk) => { output += chunk; });
      server.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ssMusic HTTPS server listening')) resolve();
      });
    });
    certificate = await fs.readFile(path.join(directory, 'data', 'tls', 'server-cert.pem'));
  }
  function call(route, auth = headers.Owner, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: '127.0.0.1', port: httpsPort, path: route, method,
        headers: { 'Content-Type': 'application/json', ...auth }, ca: certificate }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString();
          resolve({ status: response.statusCode, text, buffer, headers: response.headers,
            body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
        });
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  await start();

  await context.test('keys are header-only, read-only, bounded and independent of user credentials', async () => {
    for (const auth of [{}, headers.Owner, { 'X-API-Key': 'wrong' }, { 'X-PAT': key }]) {
      assert.equal((await call('/api/songs/search', auth)).status, 401);
    }
    assert.equal((await call(`/api/songs/search?key=${key}`, {})).status, 401);
    for (const route of ['/api/auth/me', '/api/jobs', '/api/library/export', '/api/admin/media-shares']) {
      assert.equal((await call(route, { ...headers.Admin, ...keyHeaders })).status, 403, route);
    }
    assert.equal((await call('/api/jobs/playlist/privacy', { ...headers.Owner, ...keyHeaders }, 'PATCH', { private: true })).status, 403);
    for (const query of ['page=0', 'pageSize=101', 'page=1.5', 'q[]=x', `q=${'a'.repeat(201)}`]) {
      assert.equal((await call(`/api/songs/search?${query}`, keyHeaders)).status, 400, query);
    }
    const result = await call('/api/songs/search?pageSize=1&page=2', keyHeaders);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.total, 5);
    assert.equal(result.body.files.length, 1);
    assert.equal(result.body.page, 2);
    const literal = await call('/api/songs/search?q=100%25', keyHeaders);
    assert.deepEqual(literal.body.files.map((file) => file.name), ['open.mp3']);
    assert.ok((await call('/api/libraries', keyHeaders)).body.users.some((user) => user.id === users.Linked.id));
    assert.equal((await call('/api/library', keyHeaders)).status, 400);
    assert.equal((await call(`/api/library?userId=${users.Linked.id}`, keyHeaders)).status, 200);
    assert.equal((await call('/api/jobs/playlist/stream/clip.mp4', keyHeaders)).status, 200);
    assert.equal((await call('/api/jobs/playlist/lyrics/open.mp3', keyHeaders)).body.canEdit, false);
    assert.equal((await call('/api/jobs/playlist/stream/open.mp3', { ...keyHeaders, Range: 'bytes=0-4' })).status, 206);
  });

  await context.test('search includes videos with media URLs and pagination while respecting file privacy', async () => {
    const search = await call('/api/songs/search?q=clip', keyHeaders);
    assert.equal(search.status, 200, search.text);
    assert.equal(search.body.total, 1);
    assert.deepEqual(search.body.files.map((file) => file.name), ['clip.mp4']);
    const [video] = search.body.files;
    assert.equal(video.jobId, 'playlist');
    assert.equal(video.readOnly, true);
    assert.equal(video.streamUrl, '/api/jobs/playlist/stream/clip.mp4');
    assert.equal(video.downloadUrl, '/api/jobs/playlist/download/clip.mp4');
    assert.equal(video.artworkUrl, null);
    assert.equal((await call(video.streamUrl, keyHeaders)).status, 200);
    assert.equal((await call(video.downloadUrl, keyHeaders)).status, 200);
    const paginated = await call('/api/songs/search?pageSize=1&page=5', keyHeaders);
    assert.equal(paginated.status, 200, paginated.text);
    assert.equal(paginated.body.total, 5);
    assert.equal(paginated.body.totalPages, 5);
    assert.equal(paginated.body.page, 5);
    assert.deepEqual(paginated.body.files.map((file) => file.name), ['clip.mp4']);
    assert.equal((await call('/api/jobs/playlist/files/clip.mp4/privacy', headers.Owner, 'PATCH', { private: true })).status, 200);
    const hidden = await call('/api/songs/search?q=clip', keyHeaders);
    assert.equal(hidden.status, 200, hidden.text);
    assert.equal(hidden.body.total, 0);
    assert.deepEqual(hidden.body.files, []);
    assert.equal((await call('/api/jobs/playlist/files/clip.mp4/privacy', headers.Owner, 'PATCH', { private: false })).status, 200);
    assert.deepEqual((await call('/api/songs/search?q=clip', keyHeaders)).body.files.map((file) => file.name), ['clip.mp4']);
  });

  let share;
  await context.test('only owners set file privacy; contributors, linked users, admins and public tokens lose access', async () => {
    const response = await call('/api/jobs/playlist/files/secret-file.mp3/share', headers.Owner, 'POST');
    assert.equal(response.status, 201, response.text);
    share = response.body.url.split('/').at(-1);
    for (const name of ['Admin', 'Contributor', 'Linked', 'Reader']) {
      assert.equal((await call('/api/jobs/playlist/files/secret-file.mp3/privacy', headers[name], 'PATCH', { private: true })).status, 403);
    }
    assert.equal((await call('/api/jobs/playlist/files/secret-file.mp3/privacy', headers.Owner, 'PATCH', { private: 'true' })).status, 400);
    const changed = await call('/api/jobs/playlist/files/secret-file.mp3/privacy', headers.Owner, 'PATCH', { private: true });
    assert.equal(changed.status, 200, changed.text);
    for (const auth of [headers.Admin, headers.Contributor, headers.Linked, headers.Reader, keyHeaders]) {
      for (const action of ['stream', 'download', 'lyrics', 'artwork']) {
        const denied = await call(`/api/jobs/playlist/${action}/secret-file.mp3`, auth);
        assert.ok([403, 404].includes(denied.status), `${action}: ${denied.status}`);
      }
      assert.ok([403, 404].includes((await call('/api/jobs/playlist/stream/%5BNoVocals%5D%2Fsecret-file.mp3', auth)).status));
    }
    assert.equal((await call('/api/jobs/playlist/stream/secret-file.mp3')).status, 200);
    assert.equal((await call('/api/jobs/playlist/stream/secret-file.mp3', keyHeaders, 'HEAD')).status, 404);
    assert.equal((await call(`/api/public/media/${share}`, {})).status, 404);
    assert.equal((await call(`/api/public/media/${share}/download`, {})).status, 404);
    assert.ok([403, 404].includes((await call('/api/jobs/playlist/files/secret-file.mp3/share', headers.Owner, 'POST')).status));
    const summary = await call('/api/jobs/playlist', headers.Contributor);
    assert.equal(summary.status, 200);
    assert.ok(!summary.text.includes('secret-file.mp3'), summary.text);
    for (const route of ['/api/jobs/playlist/files', `/api/library/tracks?userId=${users.Owner.id}`]) {
      const result = await call(route, headers.Linked);
      assert.equal(result.status, 200, result.text);
      assert.ok(!result.text.includes('secret-file.mp3'), result.text);
    }
    const search = await call('/api/songs/search', keyHeaders);
    assert.equal(search.body.total, 3);
    assert.ok(!search.text.includes('secret-file.mp3'), search.text);
    const own = await call('/api/library/tracks', headers.Contributor);
    assert.ok(!own.text.includes('secret-file.mp3'), own.text);
    const download = await call(`/api/library/playlists/playlist/download?userId=${users.Owner.id}`, headers.Linked);
    assert.equal(download.status, 200, download.text);
    assert.ok(!new AdmZip(download.buffer).getEntries().some((entry) => entry.entryName.includes('secret-file')));
    for (const [route, method, body] of [
      ['/api/jobs/playlist/files/secret-file.mp3/metadata', 'PATCH', { title: 'changed' }],
      ['/api/jobs/playlist/files/secret-file.mp3', 'DELETE'],
      ['/api/jobs/playlist/rerun', 'POST']
    ]) assert.equal((await call(route, headers.Contributor, method, body)).status, 403, route);
  });

  await context.test('playlist privacy hides all source media and survives restart', async () => {
    for (const name of ['Admin', 'Contributor']) {
      assert.equal((await call('/api/jobs/playlist/privacy', headers[name], 'PATCH', { private: true })).status, 403);
    }
    const changed = await call('/api/library/playlists/playlist/privacy', headers.Owner, 'PATCH', { private: true });
    assert.equal(changed.status, 200, changed.text);
    for (const auth of [headers.Admin, headers.Contributor, headers.Linked, keyHeaders]) {
      assert.equal((await call('/api/jobs/playlist/stream/open.mp3', auth)).status, 404);
    }
    assert.equal((await call('/api/jobs/playlist', headers.Contributor)).status, 404);
    assert.equal((await call('/api/jobs/playlist/download-all', headers.Admin)).status, 404);
    const library = await call(`/api/library?userId=${users.Owner.id}`, headers.Linked);
    assert.deepEqual(library.body.playlists, []);
    assert.equal(library.body.songCount, 0);
    assert.equal((await call('/api/library/tracks', headers.Contributor)).body.total, 0);
    assert.equal((await call('/api/songs/search', keyHeaders)).body.total, 1);
    assert.equal((await call('/api/jobs/playlist/stream/open.mp3')).status, 200);
    await stop();
    await start();
    assert.equal((await call('/api/jobs/playlist')).body.private, true);
    assert.equal((await call('/api/jobs/playlist/stream/open.mp3', keyHeaders)).status, 404);
    assert.equal((await call('/api/jobs/playlist/privacy', headers.Owner, 'PATCH', { private: false })).status, 200);
    assert.equal((await call('/api/songs/search', keyHeaders)).body.total, 3);
    assert.equal((await call('/api/jobs/playlist/files/secret-file.mp3/privacy', headers.Owner, 'PATCH', { private: false })).status, 200);
    assert.equal((await call('/api/songs/search', keyHeaders)).body.total, 5);
  });

  await context.test('retained companions stay private after deleting their original and owners can make them public', async () => {
    const companions = ['[NoVocals]/different.mp3', '[NoVocals]/original.mp3', '[NoVocals]/original [No Vocals].mp3'];
    for (const [index, companion] of companions.entries()) {
      const id = `retained-${index}`;
      const outputDir = path.join(outputRoot, id);
      await fs.mkdir(path.join(outputDir, '[NoVocals]'), { recursive: true });
      for (const name of ['original.mp3', companion]) await fs.writeFile(path.join(outputDir, name), 'audio');
      await writeJob(database, { id, url: `import:${id}`, status: 'completed',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), initiatedBy: { id: users.Owner.id },
        outputDir, files: ['original.mp3', companion], privateFiles: ['original.mp3'],
        transcriptions: index === 0 ? { 'original.mp3': { noVocalsName: companion } } : {} });
      assert.equal((await call(`/api/jobs/${id}/files/original.mp3`, headers.Owner, 'DELETE')).status, 200);
      const stream = `/api/jobs/${id}/stream/${encodeURIComponent(companion)}`;
      assert.equal((await call(stream, keyHeaders)).status, 404);
      assert.equal((await call(stream)).status, 200);
      assert.deepEqual((await call(`/api/jobs/${id}`)).body.privateFiles, [companion]);
      const privacy = `/api/jobs/${id}/files/${encodeURIComponent(companion)}/privacy`;
      assert.equal((await call(privacy, headers.Admin, 'PATCH', { private: false })).status, 403);
      assert.equal((await call(privacy, headers.Owner, 'PATCH', { private: false })).status, 200);
      assert.equal((await call(stream, keyHeaders)).status, 200);
    }
  });

  await context.test('alias-only companions retain the original owner privacy after deleting the original', async () => {
    for (const aliasOwner of ['Owner', 'Linked']) {
      const sourceId = `alias-source-${aliasOwner}`;
      const aliasId = `alias-companion-${aliasOwner}`;
      const outputDir = path.join(outputRoot, sourceId);
      const companion = '[NoVocals]/original.mp3';
      await fs.mkdir(path.join(outputDir, '[NoVocals]'), { recursive: true });
      for (const name of ['original.mp3', companion]) await fs.writeFile(path.join(outputDir, name), 'audio');
      const source = { id: sourceId, url: `import:${sourceId}`, status: 'completed',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), initiatedBy: { id: users.Owner.id },
        outputDir, files: ['original.mp3'], privateFiles: ['original.mp3'] };
      await writeJob(database, source);
      await writeJob(database, { ...source, id: aliasId, url: `import:${aliasId}`,
        initiatedBy: { id: users[aliasOwner].id }, contributors: [{ id: users.Owner.id }],
        files: [companion], privateFiles: [] });
      const stream = `/api/jobs/${aliasId}/stream/${encodeURIComponent(companion)}`;
      assert.equal((await call(stream, keyHeaders)).status, 404);
      assert.equal((await call(`/api/jobs/${sourceId}/files/original.mp3`, headers.Owner, 'DELETE')).status, 200);
      assert.equal((await call(stream, keyHeaders)).status, 404);
      assert.equal((await call(stream, headers.Linked)).status, 404);
      assert.equal((await call(stream)).status, 200);
      assert.deepEqual((await call(`/api/jobs/${sourceId}`)).body.privateFiles, [companion]);
      const privacy = `/api/jobs/${sourceId}/files/${encodeURIComponent(companion)}/privacy`;
      for (const auth of [headers.Admin, headers.Linked]) {
        assert.equal((await call(privacy, auth, 'PATCH', { private: false })).status, 403);
      }
      assert.equal((await call(privacy, headers.Owner, 'PATCH', { private: true })).status, 404);
      assert.equal((await call(privacy, headers.Owner, 'PATCH', { private: false })).status, 200);
      assert.equal((await call(stream, keyHeaders)).status, 200);
    }
  });

  await context.test('an unset key disables access, including formerly valid credentials', async () => {
    await stop();
    await start('');
    assert.equal((await call('/api/songs/search', keyHeaders)).status, 401);
    assert.equal((await call('/api/jobs/playlist/stream/open.mp3', keyHeaders)).status, 401);
  });
});
