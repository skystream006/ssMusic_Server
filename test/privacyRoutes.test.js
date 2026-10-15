import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import AdmZip from 'adm-zip';
import NodeID3 from 'node-id3';
import { fileTypeFromBuffer } from 'file-type';
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
  const ffmpegLocation = path.resolve(process.env.FFMPEG_PATH || path.join('runtime', 'ffmpeg', 'bin'));
  const ffmpegPath = /^ffmpeg(?:\.exe)?$/i.test(path.basename(ffmpegLocation)) ? ffmpegLocation
    : path.join(ffmpegLocation, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const canGenerateVideo = await fs.access(ffmpegPath).then(() => true, () => false);
  for (const id of ['playlist', 'other']) {
    const outputDir = path.join(outputRoot, id);
    await fs.mkdir(outputDir, { recursive: true });
    const files = id === 'playlist' ? ['open.mp3', 'secret-file.mp3', '[NoVocals]/secret-file.mp3', 'clip.mp4'] : ['elsewhere.mp3'];
    await fs.mkdir(path.join(outputDir, '[NoVocals]'), { recursive: true });
    for (const name of files) await fs.writeFile(path.join(outputDir, name), name === 'open.mp3'
      ? NodeID3.write({ title: 'A 100% song', artist: 'Test Artist',
        unsynchronisedLyrics: { language: 'eng', text: 'Private lyric payload' },
        synchronisedLyrics: [{ language: 'eng', timeStampFormat: 2, contentType: 1,
          synchronisedText: [{ timeStamp: 1000, text: 'Timed lyric payload' }] }]
      }, Buffer.from(`audio:${name}`)) : `audio:${name}`);
    await writeJob(database, { id, url: `https://music.youtube.com/playlist?list=${id}`, status: 'completed',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isPlaylist: true,
      initiatedBy: { id: users[id === 'playlist' ? 'Owner' : 'Linked'].id },
      contributors: id === 'playlist' ? [{ id: users.Contributor.id }] : [],
      outputDir, files, playlistTitle: id === 'playlist' ? 'Owner playlist' : 'Other library',
      output: 'Downloaded secret-file.mp3', songMetadata: { 'open.mp3': { title: 'A 100% song', artist: 'Test Artist' } } });
  }
  if (canGenerateVideo) {
    execFileSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=5',
      '-frames:v', '1', '-c:v', 'mpeg4', '-threads', '1', path.join(outputRoot, 'playlist', 'clip.mp4')]);
  }
  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))));
  const [httpPort, httpsPort] = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  async function start(searchKey = key) {
    server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)),
      '--http-port', String(httpPort), '--https-port', String(httpsPort)], {
      cwd: directory, env: { ...process.env, SEARCH_API_KEY: searchKey, YTDLP_OUTPUT_ROOT: outputRoot, FFMPEG_PATH: ffmpegLocation,
        YTDLP_PATH: path.join(directory, 'missing-test-ytdlp'),
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
    for (const query of ['page=0', 'pageSize=101', 'page=1.5', 'q[]=x', `q=${'a'.repeat(201)}`,
      'NoVocalsOnly=maybe', 'NoVocalsOnly[]=true', 'NoVocalsOnly[enabled]=1', 'NoVocalsOnly=true&NoVocalsOnly=false']) {
      assert.equal((await call(`/api/songs/search?${query}`, keyHeaders)).status, 400, query);
    }
    const result = await call('/api/songs/search?pageSize=1&page=2', keyHeaders);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.total, 5);
    assert.equal(result.body.files.length, 1);
    assert.equal(result.body.page, 2);
    const literal = await call('/api/songs/search?q=100%25', keyHeaders);
    assert.deepEqual(literal.body.files.map((file) => file.name), ['open.mp3']);
    assert.ok(literal.body.files.every((file) => !Object.hasOwn(file, 'sylt') && !Object.hasOwn(file, 'uslt')));
    const metadataUrl = literal.body.files[0].metadataUrl;
    assert.equal(metadataUrl, '/api/jobs/playlist/files/open.mp3/metadata');
    const metadata = await call(metadataUrl, keyHeaders);
    assert.equal(metadata.status, 200, metadata.text);
    assert.equal(metadata.headers['cache-control'], 'no-store');
    assert.equal(metadata.body.title, 'A 100% song');
    assert.equal(metadata.body.canEdit, false);
    assert.equal(Object.hasOwn(metadata.body, 'sylt'), false);
    assert.equal(Object.hasOwn(metadata.body, 'uslt'), false);
    const head = await call(metadataUrl, keyHeaders, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.buffer.length, 0);
    assert.equal((await call(metadataUrl, {})).status, 401);
    assert.equal((await call(metadataUrl, { 'X-API-Key': 'wrong' })).status, 401);
    assert.equal((await call(metadataUrl, keyHeaders, 'PATCH', { rating: 5 })).status, 403);
    for (const route of [`${metadataUrl}/extra`, '/api/jobs/playlist/files/open.mp3', '/api/jobs/playlist/files/open.mp3/privacy']) {
      assert.equal((await call(route, keyHeaders)).status, 403, route);
    }
    const lyrics = (await call('/api/jobs/playlist/lyrics/open.mp3', keyHeaders)).body;
    assert.equal(lyrics.uslt, 'Private lyric payload');
    assert.deepEqual(lyrics.sylt, [{ time: 1, text: 'Timed lyric payload' }]);
    assert.ok((await call('/api/libraries', keyHeaders)).body.users.some((user) => user.id === users.Linked.id));
    assert.equal((await call('/api/library', keyHeaders)).status, 400);
    assert.equal((await call(`/api/library?userId=${users.Linked.id}`, keyHeaders)).status, 200);
    assert.equal((await call('/api/jobs/playlist/stream/clip.mp4', keyHeaders)).status, 200);
    assert.equal((await call('/api/jobs/playlist/lyrics/open.mp3', keyHeaders)).body.canEdit, false);
    assert.equal((await call('/api/jobs/playlist/stream/open.mp3', { ...keyHeaders, Range: 'bytes=0-4' })).status, 206);
  });

  await context.test('NoVocalsOnly returns only accompaniment audio and keeps mixed results as the default', async () => {
    for (const flag of ['', '&NoVocalsOnly=false', '&NoVocalsOnly=0']) {
      const result = await call(`/api/songs/search?q=secret-file${flag}`, keyHeaders);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.total, 2);
      assert.deepEqual(result.body.files.map((file) => file.name), ['secret-file.mp3', '[NoVocals]/secret-file.mp3']);
    }
    for (const flag of ['NoVocalsOnly', 'NoVocalsOnly=true', 'NoVocalsOnly=1']) {
      const result = await call(`/api/songs/search?q=secret-file&${flag}`, keyHeaders);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.total, 1);
      assert.deepEqual(result.body.files.map((file) => file.name), ['[NoVocals]/secret-file.mp3']);
    }
    const all = await call('/api/songs/search?NoVocalsOnly=true', keyHeaders);
    assert.equal(all.status, 200, all.text);
    assert.equal(all.body.total, 1);
    const [song] = all.body.files;
    assert.equal(song.name, '[NoVocals]/secret-file.mp3');
    for (const url of ['streamUrl', 'downloadUrl', 'lyricsUrl', 'metadataUrl', 'artworkUrl']) {
      assert.equal((await call(song[url], keyHeaders)).status, 200, url);
    }
    const video = await call('/api/songs/search?q=clip&NoVocalsOnly=true', keyHeaders);
    assert.equal(video.body.total, 0);
    assert.deepEqual(video.body.files, []);
  });

  await context.test('song title searches include public NoVocals companions even when their own tags do not match', async (subcontext) => {
    const jobId = 'companion-search';
    const otherJobId = 'unrelated-companion-search';
    subcontext.after(async () => {
      for (const id of [jobId, otherJobId]) await call(`/api/jobs/${id}`, headers.Owner, 'DELETE');
    });
    const title = 'N\u1ebfu Ph\u1ea3i Gi\u1eef Cho Em';
    const originalName = 'Recording.mp3';
    const stemName = '[NoVocals]/[NoVocals] Recording.mp3';
    const linkedName = '[NoVocals]/instrumental.mp3';
    const files = [originalName, stemName, linkedName, '[NoVocals]/unrelated.mp3'];
    const sourceJob = { id: jobId, url: `import:${jobId}`, status: 'completed', isPlaylist: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), initiatedBy: { id: users.Owner.id },
      outputDir: path.join(outputRoot, jobId), files, playlistTitle: 'Companion lookup',
      songMetadata: { [originalName]: { title, artist: 'Distinct companion artist' } },
      transcriptions: { [originalName]: { status: 'transcribed', noVocalsName: linkedName } } };
    for (const job of [sourceJob, { ...sourceJob, id: otherJobId, url: `import:${otherJobId}`,
      outputDir: path.join(outputRoot, otherJobId), files: [stemName], songMetadata: {}, transcriptions: {} }]) {
      await fs.mkdir(path.join(job.outputDir, '[NoVocals]'), { recursive: true });
      for (const name of job.files) await fs.writeFile(path.join(job.outputDir, name), `audio:${name}`);
      await writeJob(database, job);
    }
    for (const query of [title, title.normalize('NFD'), 'neu phai giu cho em', 'Distinct companion artist']) {
      const result = await call(`/api/songs/search?${new URLSearchParams({ q: query })}`, keyHeaders);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.total, 3, query);
      assert.deepEqual(result.body.files.map((file) => [file.jobId, file.name]), files.slice(0, 3).map((name) => [jobId, name]));
      const onlyCompanions = await call(`/api/songs/search?${new URLSearchParams({ q: query, NoVocalsOnly: true })}`, keyHeaders);
      assert.equal(onlyCompanions.status, 200, onlyCompanions.text);
      assert.equal(onlyCompanions.body.total, 2);
      assert.deepEqual(onlyCompanions.body.files.map((file) => [file.jobId, file.name]), [[jobId, stemName], [jobId, linkedName]]);
    }
    const companionPage = await call(`/api/songs/search?${new URLSearchParams({ q: title, NoVocalsOnly: true, pageSize: 1, page: 99 })}`, keyHeaders);
    assert.equal(companionPage.body.total, 2);
    assert.equal(companionPage.body.totalPages, 2);
    assert.equal(companionPage.body.page, 2);
    assert.deepEqual(companionPage.body.files.map((file) => file.name), [linkedName]);
    const paged = await call(`/api/songs/search?${new URLSearchParams({ q: title, pageSize: 1, page: 3 })}`, keyHeaders);
    assert.equal(paged.body.totalPages, 3);
    assert.equal(paged.body.page, 3);
    assert.equal(paged.body.files[0].name, linkedName);
    for (const url of ['streamUrl', 'downloadUrl', 'lyricsUrl', 'metadataUrl', 'artworkUrl']) {
      assert.equal((await call(paged.body.files[0][url], keyHeaders)).status, 200, url);
    }
    await writeJob(database, { ...sourceJob, songMetadata: { ...sourceJob.songMetadata, [linkedName]: { title } } });
    assert.equal((await call('/api/songs/search?q=neu%20phai%20giu%20cho%20em', keyHeaders)).body.total, 3);
    assert.equal((await call('/api/songs/search?q=neu%20phai%20giu%20cho%20em&NoVocalsOnly=true', keyHeaders)).body.total, 2);
    assert.equal((await call(`/api/jobs/${jobId}/files/${encodeURIComponent(linkedName)}/privacy`, headers.Owner, 'PATCH', { private: true })).status, 200);
    const hiddenCompanion = await call('/api/songs/search?q=neu%20phai%20giu%20cho%20em', keyHeaders);
    assert.deepEqual(hiddenCompanion.body.files.map((file) => file.name), [originalName, stemName]);
    assert.deepEqual((await call('/api/songs/search?q=neu%20phai%20giu%20cho%20em&NoVocalsOnly=true', keyHeaders)).body.files.map((file) => file.name), [stemName]);
    assert.equal((await call(`/api/jobs/${jobId}/files/${originalName}/privacy`, headers.Owner, 'PATCH', { private: true })).status, 200);
    assert.equal((await call('/api/songs/search?q=neu%20phai%20giu%20cho%20em', keyHeaders)).body.total, 0);
    assert.equal((await call('/api/songs/search?q=neu%20phai%20giu%20cho%20em&NoVocalsOnly=true', keyHeaders)).body.total, 0);
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
    assert.equal(video.artworkUrl, '/api/jobs/playlist/artwork/clip.mp4');
    assert.equal((await call(video.artworkUrl, {})).status, 401);
    assert.equal((await call(video.artworkUrl, { 'X-API-Key': 'wrong' })).status, 401);
    if (canGenerateVideo) {
      const thumbnail = await call(video.artworkUrl, keyHeaders);
      assert.equal(thumbnail.status, 200, thumbnail.text);
      assert.match(thumbnail.headers['content-type'], /^image\/avif/);
      assert.equal((await fileTypeFromBuffer(thumbnail.buffer)).mime, 'image/avif');
      assert.ok(thumbnail.buffer.length <= 64 * 1024);
      assert.deepEqual((await call(video.artworkUrl, keyHeaders)).buffer, thumbnail.buffer);
      const head = await call(video.artworkUrl, keyHeaders, 'HEAD');
      assert.equal(head.status, 200);
      assert.match(head.headers['content-type'], /^image\/avif/);
      assert.equal(head.buffer.length, 0);
    }
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
    for (const auth of [keyHeaders, headers.Admin, headers.Contributor, headers.Linked, headers.Reader]) {
      for (const method of ['GET', 'HEAD']) {
        assert.ok([403, 404].includes((await call(video.artworkUrl, auth, method)).status));
      }
    }
    if (canGenerateVideo) assert.equal((await call(video.artworkUrl, headers.Owner)).status, 200);
    assert.equal((await call('/api/jobs/playlist/files/clip.mp4/privacy', headers.Owner, 'PATCH', { private: false })).status, 200);
    assert.deepEqual((await call('/api/songs/search?q=clip', keyHeaders)).body.files.map((file) => file.name), ['clip.mp4']);
    if (canGenerateVideo) assert.equal((await call(video.artworkUrl, keyHeaders)).status, 200);
  });

  await context.test('deleting a video job removes its generated thumbnail cache', { skip: !canGenerateVideo }, async () => {
    const outputDir = path.join(outputRoot, 'video-thumbnail-cleanup');
    const filePath = path.join(outputDir, 'Preview.mp4');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.copyFile(path.join(outputRoot, 'playlist', 'clip.mp4'), filePath);
    await writeJob(database, { id: 'video-thumbnail-cleanup', url: 'import:video-thumbnail-cleanup', status: 'completed',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isPlaylist: true,
      initiatedBy: { id: users.Owner.id }, outputDir, files: ['Preview.mp4'], playlistTitle: 'Video thumbnail cleanup' });
    assert.equal((await call('/api/jobs/video-thumbnail-cleanup/artwork/Preview.mp4', keyHeaders)).status, 200);
    const cache = path.join(directory, 'data', 'artwork-thumbnails', createHash('sha256').update(await fs.realpath(filePath)).digest('hex'));
    assert.ok((await fs.readdir(cache)).some((name) => name.endsWith('.avif')));
    assert.equal((await call('/api/jobs/video-thumbnail-cleanup', headers.Owner, 'DELETE')).status, 204);
    await assert.rejects(fs.access(cache), { code: 'ENOENT' });
  });

  await context.test('accentless song search upgrades existing indexes and provides protected audio thumbnails', async (subcontext) => {
    const jobId = 'accent-search';
    subcontext.after(async () => { await call(`/api/jobs/${jobId}`, headers.Owner, 'DELETE'); });
    const title = 'Y\u00eau \u0110\u1eebng S\u1ee3 \u0110au';
    const outputDir = path.join(outputRoot, jobId);
    await fs.mkdir(outputDir, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(outputDir, 'Covered.MP3'), NodeID3.write({ title,
      image: { mime: 'image/png', type: { id: 3 }, imageBuffer: png } }, Buffer.from('audio fixture')));
    await fs.writeFile(path.join(outputDir, 'Uncovered.mp3'), 'audio without art');
    await fs.writeFile(path.join(outputDir, 'Other.flac'), 'audio fixture');
    await writeJob(database, { id: jobId, url: `import:${jobId}`, status: 'completed', isPlaylist: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), initiatedBy: { id: users.Owner.id },
      outputDir, files: ['Covered.MP3', 'Uncovered.mp3', 'Other.flac'], playlistTitle: 'Accent fixture', songMetadata: { 'Covered.MP3': { title } } });
    await database.prepare('UPDATE songs SET search_text = $1 WHERE job_id = $2 AND name = $3')
      .run(`${title.toLowerCase()} accent fixture covered.mp3`, jobId, 'Covered.MP3');
    await database.prepare('DELETE FROM migrations WHERE name = $1').run('song-search-normalization-v1');
    await stop();
    await start();
    for (const query of ['yeu dung so dau', title, title.toUpperCase(), title.normalize('NFD')]) {
      const response = await call(`/api/songs/search?${new URLSearchParams({ q: query })}`, keyHeaders);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.total, 1);
      assert.equal(response.body.files[0].title, title);
      assert.equal(response.body.files[0].artworkUrl, `/api/jobs/${jobId}/artwork/Covered.MP3?fallback=1`);
    }
    const librarySearch = await call(`/api/library/tracks?${new URLSearchParams({ userId: users.Owner.id, search: 'yeu dung so dau' })}`, keyHeaders);
    assert.equal(librarySearch.status, 200, librarySearch.text);
    assert.equal(librarySearch.body.files[0].title, title);
    const results = (await call('/api/songs/search?q=accent%20fixture', keyHeaders)).body.files;
    assert.equal(results.length, 3);
    const fallback = await fs.readFile(new URL('../src/assets/audio-thumbnail.avif', import.meta.url));
    for (const song of results) {
      assert.ok(song.artworkUrl.endsWith('?fallback=1'));
      if (song.name === 'Covered.MP3' && !canGenerateVideo) continue;
      const thumbnail = await call(song.artworkUrl, keyHeaders);
      assert.equal(thumbnail.status, 200, thumbnail.text);
      assert.match(thumbnail.headers['content-type'], /^image\/avif/);
      if (song.name === 'Covered.MP3') assert.notDeepEqual(thumbnail.buffer, fallback);
      else assert.deepEqual(thumbnail.buffer, fallback);
      assert.equal((await call(song.artworkUrl, keyHeaders, 'HEAD')).status, 200);
      assert.equal((await call(song.artworkUrl, {})).status, 401);
    }
    assert.equal((await call(`/api/jobs/${jobId}/artwork/Uncovered.mp3`, keyHeaders)).status, 404);
    assert.equal((await call(`/api/jobs/${jobId}/files/Uncovered.mp3/privacy`, headers.Owner, 'PATCH', { private: true })).status, 200);
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await call(`/api/jobs/${jobId}/artwork/Uncovered.mp3?fallback=1`, keyHeaders, method)).status, 404);
    }
    const hidden = await call('/api/songs/search?q=uncovered', keyHeaders);
    assert.equal(hidden.body.total, 0);
    await stop();
    await start();
    assert.equal((await call('/api/songs/search?q=yeu%20dung%20so%20dau', keyHeaders)).body.total, 1);
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
    for (const name of ['secret-file.mp3', '[NoVocals]/secret-file.mp3']) {
      assert.equal((await call(`/api/jobs/playlist/files/${encodeURIComponent(name)}/metadata`, headers.Reader, 'PATCH', { rating: 5 })).status, 403);
    }
    for (const auth of [headers.Admin, headers.Contributor, headers.Linked, headers.Reader, keyHeaders]) {
      for (const name of ['secret-file.mp3', '[NoVocals]/secret-file.mp3']) {
        for (const method of ['GET', 'HEAD']) {
          const denied = await call(`/api/jobs/playlist/files/${encodeURIComponent(name)}/metadata`, auth, method);
          assert.ok([403, 404].includes(denied.status), `${method} metadata: ${denied.status}`);
        }
      }
      for (const action of ['stream', 'download', 'lyrics', 'artwork']) {
        const denied = await call(`/api/jobs/playlist/${action}/secret-file.mp3`, auth);
        assert.ok([403, 404].includes(denied.status), `${action}: ${denied.status}`);
      }
      assert.ok([403, 404].includes((await call('/api/jobs/playlist/stream/%5BNoVocals%5D%2Fsecret-file.mp3', auth)).status));
    }
    assert.equal((await call('/api/jobs/playlist/stream/secret-file.mp3')).status, 200);
    assert.equal((await call('/api/jobs/playlist/files/secret-file.mp3/metadata')).status, 200);
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
    assert.equal((await call('/api/jobs/playlist/files/open.mp3/metadata', headers.Reader, 'PATCH', { rating: 5 })).status, 403);
    for (const auth of [headers.Admin, headers.Contributor, headers.Linked, keyHeaders]) {
      assert.equal((await call('/api/jobs/playlist/stream/open.mp3', auth)).status, 404);
      assert.equal((await call('/api/jobs/playlist/files/open.mp3/metadata', auth)).status, 404);
    }
    assert.equal((await call('/api/jobs/playlist/files/open.mp3/metadata', headers.Reader)).status, 403);
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

  await context.test('KaraokeParty video submissions authenticate, deduplicate, and return only public playable links', async () => {
    const route = '/api/karaoke/jobs';
    const videoURL = 'https://youtu.be/cMoRYP8EDUk?si=tracking';
    for (const auth of [{}, headers.Admin, { 'X-API-Key': 'wrong' }]) {
      assert.equal((await call(route, auth, 'POST', { videoURL })).status, 401);
    }
    for (const videoURL of [null, {}, 'https://example.com/watch?v=cMoRYP8EDUk', 'https://youtube.com/playlist?list=abc']) {
      assert.equal((await call(route, keyHeaders, 'POST', { videoURL })).status, 400);
    }
    const owner = (await store.listUsers()).find((user) => user.name === 'KaraokeParty');
    assert.equal(owner.status, 'approved');
    assert.equal(owner.role, 'ExtServer');
    assert.equal(owner.credentialCount, 0);
    const results = await Promise.all([videoURL, 'https://www.youtube.com/watch?v=cMoRYP8EDUk&list=abc'].map((videoURL) =>
      call(route, { ...headers.Admin, ...keyHeaders }, 'POST', { videoURL, userId: users.Admin.id, downloadType: 'audio' })));
    assert.equal(results.filter((result) => result.body.duplicate === false).length, 1, JSON.stringify(results));
    assert.equal(results[0].body.jobId, results[1].body.jobId);
    assert.equal(results.find((result) => !result.body.duplicate).status, 202);
    const jobId = results[0].body.jobId;
    const stored = JSON.parse((await database.prepare('SELECT data FROM jobs WHERE id = $1').get(jobId)).data);
    assert.equal(stored.initiatedBy.id, owner.id);
    assert.equal(stored.downloadType, 'video');
    assert.equal(stored.url, 'https://www.youtube.com/watch?v=cMoRYP8EDUk');
    assert.equal(stored.isPlaylist, false);
    const pending = await call(`/api/karaoke/jobs/${jobId}`, keyHeaders);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.ready, false);
    assert.equal(pending.body.playUrl, null);
    assert.equal(pending.body.playerUrl, null);
    assert.equal((await call(`/api/library?userId=${owner.id}`, keyHeaders)).status, 200);
    assert.equal((await call(`/api/karaoke/jobs/${jobId}`, headers.Admin)).status, 401);
    assert.equal((await call(`/api/jobs/${jobId}`, keyHeaders)).status, 403);
    assert.equal((await call('/api/jobs', keyHeaders, 'POST', { url: videoURL })).status, 403);
    const existingId = 'legacy-karaoke-video';
    const outputDir = path.join(outputRoot, existingId);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'Party clip.mp4'), 'video');
    const existing = { id: existingId, url: 'https://m.youtube.com/watch?v=%52TcsY6aIoEc&t=42',
      downloadType: 'video', isPlaylist: false, status: 'completed', outputDir, files: ['Party clip.mp4'],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), initiatedBy: { id: users.Owner.id } };
    await writeJob(database, existing);
    const duplicate = await call(route, keyHeaders, 'POST', { videoURL: 'https://youtu.be/RTcsY6aIoEc' });
    assert.equal(duplicate.status, 200, duplicate.text);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.ready, true);
    assert.equal(duplicate.body.jobId, existingId);
    assert.equal(duplicate.body.playUrl, `/api/jobs/${existingId}/stream/Party%20clip.mp4`);
    assert.equal((await call(duplicate.body.playUrl, keyHeaders)).status, 200);
    for (const playlistId of ['party-one', 'party-two', 'party-one']) {
      const added = await call(route, keyHeaders, 'POST', { videoURL: 'https://youtu.be/RTcsY6aIoEc', playlistId });
      assert.equal(added.status, 200, added.text);
      assert.equal(added.body.playlistId, playlistId);
      assert.equal(added.body.action, 'add');
    }
    const references = await database.prepare('SELECT playlist_id FROM karaoke_playlist_jobs WHERE job_id = $1 ORDER BY playlist_id').all(existingId);
    assert.deepEqual(references.map((reference) => reference.playlist_id), ['', 'party-one', 'party-two']);
    await fs.unlink(path.join(outputDir, 'Party clip.mp4'));
    const missing = await call(duplicate.body.statusUrl, keyHeaders);
    assert.equal(missing.body.ready, false);
    assert.equal(missing.body.playUrl, null);
    await fs.writeFile(path.join(outputDir, 'Party clip.mp4'), 'video');
    await writeJob(database, { ...existing, private: true });
    const hidden = await call(route, keyHeaders, 'POST', { videoURL: 'https://youtube.com/shorts/RTcsY6aIoEc' });
    assert.equal(hidden.status, 409);
    assert.equal(hidden.body.playUrl, undefined);
    assert.equal((await call(duplicate.body.statusUrl, keyHeaders)).status, 404);
    await store.updateUser(owner.id, { status: 'revoked' }, users.Admin.id);
    assert.equal((await call(route, keyHeaders, 'POST', { videoURL })).status, 403);
    await store.updateUser(owner.id, { status: 'approved' }, users.Admin.id);
  });

  await context.test('KaraokeParty add/remove tracks playlist references durably and deletes only the final owned video', async () => {
    const route = '/api/karaoke/jobs';
    const videoURL = 'https://youtu.be/9bZkp7q19f0';
    const owner = (await store.listUsers()).find((user) => user.name === 'KaraokeParty');
    const outputDir = path.join(outputRoot, 'tracked-video');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'Tracked.mp4'), 'video');
    const job = { id: 'tracked-video', url: videoURL, downloadType: 'video', isPlaylist: false, status: 'completed',
      outputDir, files: ['Tracked.mp4'], initiatedBy: { id: owner.id }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await writeJob(database, job);
    for (const body of [{ action: 'unknown' }, { action: null }, { action: 'remove' },
      { playlistId: '' }, { playlistId: {} }, { playlistId: 1 }, { playlistId: 'x'.repeat(201) },
      { playlistId: 'bad\nvalue' }, { videoUrl: 'https://youtu.be/cMoRYP8EDUk' }]) {
      assert.equal((await call(route, keyHeaders, 'POST', { videoURL, ...body })).status, 400);
    }
    const adds = await Promise.all(['list-a', 'list-b', 'list-a'].map((playlistId) =>
      call(route, keyHeaders, 'POST', { action: 'Add', videoUrl: videoURL, playlistId })));
    for (const added of adds) { assert.equal(added.status, 200, added.text); assert.equal(added.body.jobId, job.id); }
    assert.equal(adds.at(-1).body.playlistCount, 2);
    await stop();
    await start();
    assert.equal((await call(`/api/karaoke/jobs/${job.id}`, keyHeaders)).body.playlistCount, 2);
    const remove = (playlistId) => call(route, keyHeaders, 'POST', { action: 'Remove', videoURL, playlistId });
    const first = await remove('list-a');
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.removed, true);
    assert.equal(first.body.videoDeleted, false);
    assert.equal(first.body.playlistCount, 1);
    assert.equal((await fs.stat(path.join(outputDir, 'Tracked.mp4'))).isFile(), true);
    const repeated = await remove('list-a');
    assert.equal(repeated.body.removed, false);
    assert.equal(repeated.body.playlistCount, 1);
    const last = await remove('list-b');
    assert.equal(last.status, 200, last.text);
    assert.equal(last.body.videoDeleted, true);
    assert.equal(last.body.playlistCount, 0);
    assert.equal(await database.prepare('SELECT id FROM jobs WHERE id = $1').get(job.id), undefined);
    assert.equal(await fs.stat(outputDir).catch(() => null), null);
    assert.equal((await remove('list-b')).body.removed, false);
    await writeJob(database, { ...job, outputDir: null, files: [], status: 'running' });
    await call(route, keyHeaders, 'POST', { videoURL, playlistId: 'busy' });
    assert.equal((await remove('busy')).status, 409);
    assert.equal((await database.prepare('SELECT count(*) AS count FROM karaoke_playlist_jobs WHERE job_id = $1').get(job.id)).count, 1);
    await writeJob(database, { ...job, initiatedBy: { id: users.Owner.id }, outputDir: null, files: [] });
    const foreign = await remove('busy');
    assert.equal(foreign.status, 200, foreign.text);
    assert.equal(foreign.body.videoDeleted, false);
    assert.equal(foreign.body.retainedReason, 'other_owner');
    assert.ok(await database.prepare('SELECT id FROM jobs WHERE id = $1').get(job.id));
    await writeJob(database, { ...job, outputDir: null, files: [] });
    await call(route, keyHeaders, 'POST', { videoURL });
    await call(route, keyHeaders, 'POST', { videoURL, playlistId: 'legacy-use' });
    const legacy = await remove('legacy-use');
    assert.equal(legacy.body.videoDeleted, false);
    assert.equal(legacy.body.playlistCount, 1);
    await database.prepare('DELETE FROM karaoke_playlist_jobs WHERE job_id = $1').run(job.id);
    await writeJob(database, { ...job, outputDir: null, files: [], contributors: [{ id: users.Owner.id }] });
    await call(route, keyHeaders, 'POST', { videoURL, playlistId: 'shared-use' });
    const shared = await remove('shared-use');
    assert.equal(shared.status, 200, shared.text);
    assert.equal(shared.body.videoDeleted, false);
    assert.equal(shared.body.playlistCount, 0);
    assert.equal(shared.body.retainedReason, 'library_references');
    await database.prepare('DELETE FROM jobs WHERE id = $1').run(job.id);
  });

  await context.test('KaraokeParty reference migration protects existing jobs without duplicating legacy references', async () => {
    const owner = (await store.listUsers()).find((user) => user.name === 'KaraokeParty');
    const jobId = 'legacy-untracked-video';
    await writeJob(database, { id: jobId, url: 'https://youtu.be/3JZ_D3ELwOQ', downloadType: 'video', isPlaylist: false,
      status: 'completed', files: [], initiatedBy: { id: owner.id }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await database.prepare("DELETE FROM migrations WHERE name = 'karaoke-playlist-references-v1'").run();
    await stop();
    await start();
    assert.deepEqual(await database.prepare('SELECT playlist_id FROM karaoke_playlist_jobs WHERE job_id = $1').all(jobId), [{ playlist_id: '' }]);
    const body = { videoUrl: 'https://youtube.com/watch?v=3JZ_D3ELwOQ', playlistId: 'migrated-list' };
    assert.equal((await call('/api/karaoke/jobs', keyHeaders, 'POST', { ...body, action: 'add' })).body.playlistCount, 2);
    const removed = await call('/api/karaoke/jobs', keyHeaders, 'POST', { ...body, action: 'remove' });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.playlistCount, 1);
    assert.equal(removed.body.videoDeleted, false);
    await stop();
    await start();
    assert.equal((await call(`/api/karaoke/jobs/${jobId}`, keyHeaders)).body.playlistCount, 1);
    await database.prepare('DELETE FROM jobs WHERE id = $1').run(jobId);
  });

  await context.test('an unset key disables access, including formerly valid credentials', async () => {
    await stop();
    await start('');
    assert.equal((await call('/api/songs/search', keyHeaders)).status, 401);
    assert.equal((await call('/api/jobs/playlist/stream/open.mp3', keyHeaders)).status, 401);
    assert.equal((await call('/api/karaoke/jobs', keyHeaders, 'POST', { videoURL: 'https://youtu.be/cMoRYP8EDUk' })).status, 401);
  });
});
