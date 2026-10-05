import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import NodeID3 from 'node-id3';
import AdmZip from 'adm-zip';
import { build as buildPlist } from 'plist';
import { fileTypeFromBuffer } from 'file-type';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';
import { readPostgresJob } from '../src/postgresCatalog.js';
import { createTestDatabase } from '../test-support/postgres.js';
import { readSongMetadata, readSongSummary, updateSongMetadata } from '../src/music.js';
import { encodeThumbnail } from '../src/artworkThumbnails.js';

test('MP3 ratings round-trip all stars and refresh cached file metadata', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-ratings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  const audio = Buffer.from('audio bytes');
  await fs.writeFile(filePath, audio);
  assert.equal((await readSongSummary(filePath, await fs.stat(filePath))).rating, 0);
  const bytes = [0, 1, 64, 128, 196, 255];
  for (const rating of [5, 4, 3, 2, 1, 0]) {
    const metadata = await updateSongMetadata(filePath, { rating });
    assert.equal(metadata.rating, rating);
    const saved = await fs.readFile(filePath);
    assert.equal(NodeID3.read(saved).popularimeter.rating, bytes[rating]);
    assert.deepEqual(NodeID3.removeTagsFromBuffer(saved), audio);
    const stat = await fs.stat(filePath);
    const summary = await readSongSummary(filePath, stat);
    assert.equal(summary.rating, rating);
    assert.equal(await readSongSummary(filePath, stat), summary);
  }
  for (const [rating, stars] of [[0, 0], [1, 1], [31, 1], [32, 2], [95, 2], [96, 3], [159, 3], [160, 4], [223, 4], [224, 5], [255, 5]]) {
    await fs.writeFile(filePath, NodeID3.write({ title: `External ${rating}`, popularimeter: { email: 'external', rating, counter: 7 } }, audio));
    const changed = new Date(Date.now() + rating * 1000);
    await fs.utimes(filePath, changed, changed);
    const summary = await readSongSummary(filePath, await fs.stat(filePath));
    assert.equal(summary.title, `External ${rating}`);
    assert.equal(summary.rating, stars);
    assert.equal((await readSongMetadata(filePath)).rating, stars);
  }
});

test('MP3 lyrics edit and clear SYLT and USLT independently without changing audio or unrelated tags', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-lyrics-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  const audio = Buffer.from('audio bytes');
  const otherFrame = { language: 'eng', timeStampFormat: 2, contentType: 2, shortText: 'Events',
    synchronisedText: [{ timeStamp: 1500, text: 'Applause' }] };
  await fs.writeFile(filePath, NodeID3.write({ title: 'Original title', artist: 'Original artist',
    comment: { language: 'eng', text: 'Keep comment' }, popularimeter: { email: 'listener', rating: 196, counter: 4 },
    unsynchronisedLyrics: { language: 'vie', shortText: 'Plain', text: 'Original text' },
    synchronisedLyrics: [{ language: 'vie', timeStampFormat: 2, contentType: 1, shortText: 'Timed',
      synchronisedText: [{ timeStamp: 1000, text: 'Original line' }] }, otherFrame]
  }, audio));
  const plain = await updateSongMetadata(filePath, { uslt: 'Edited text\n\nSecond verse' });
  assert.equal(plain.uslt, 'Edited text\n\nSecond verse');
  assert.deepEqual(plain.sylt, [{ time: 1, text: 'Original line' }]);
  const timed = await updateSongMetadata(filePath, { sylt: [{ time: 12.345, text: 'Later line' }, { time: 0, text: 'First\nline' }] });
  assert.deepEqual(timed.sylt, [{ time: 0, text: 'First\nline' }, { time: 12.345, text: 'Later line' }]);
  assert.equal(timed.uslt, plain.uslt);
  assert.equal(timed.rating, 4);
  assert.equal(timed.title, 'Original title');
  const tags = NodeID3.read(await fs.readFile(filePath));
  assert.equal(tags.synchronisedLyrics.length, 2);
  assert.deepEqual(tags.synchronisedLyrics[1], otherFrame);
  assert.equal(tags.synchronisedLyrics[0].language, 'vie');
  assert.equal(tags.synchronisedLyrics[0].shortText, 'Timed');
  assert.equal(tags.unsynchronisedLyrics.language, 'vie');
  assert.equal(tags.unsynchronisedLyrics.shortText, 'Plain');
  assert.equal(tags.comment.text, 'Keep comment');
  assert.deepEqual(NodeID3.removeTagsFromBuffer(await fs.readFile(filePath)), audio);
  const clearedTimed = await updateSongMetadata(filePath, { sylt: [] });
  assert.deepEqual(clearedTimed.sylt, []);
  assert.equal(clearedTimed.uslt, plain.uslt);
  assert.deepEqual(NodeID3.read(await fs.readFile(filePath)).synchronisedLyrics, [otherFrame]);
  assert.equal((await updateSongMetadata(filePath, { uslt: '' })).uslt, '');
  const both = await updateSongMetadata(filePath, { sylt: [{ time: 1.234, text: 'Both' }], uslt: 'Both' });
  assert.deepEqual(both.sylt, [{ time: 1.234, text: 'Both' }]);
  assert.equal(both.uslt, 'Both');
  const unchanged = await fs.readFile(filePath);
  for (const value of [{ uslt: null }, { uslt: 'bad\0text' }, { uslt: 'x'.repeat(100_001) },
    { sylt: 'text' }, { sylt: [null] }, { sylt: [{ time: '1', text: 'text' }] }, { sylt: [{ time: -1, text: 'text' }] },
    { sylt: [{ time: 4294967.296, text: 'text' }] }, { sylt: [{ time: Infinity, text: 'text' }] },
    { sylt: [{ time: 1, text: 'bad\0text' }] }, { sylt: [{ time: 1, text: 'x'.repeat(100_001) }] },
    { sylt: Array.from({ length: 10_001 }, () => ({ time: 0, text: '' })) }]) {
    await assert.rejects(updateSongMetadata(filePath, value), { statusCode: 400 });
  }
  assert.deepEqual(await fs.readFile(filePath), unchanged);
});

test('job HTTP mutations enforce owner, contributor and admin access for sessions and PATs', { timeout: 120_000 }, async (context) => {
  let server;
  const { directory } = await createTestDatabase(context, { beforeCleanup: async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  } });
  process.env.IMPORT_STORAGE_ROOT = path.join(directory, 'import-storage');
  process.env.LIBRARY_BACKUP_ROOT = path.join(directory, 'library-backups');
  await fs.mkdir(path.join(directory, 'public'));
  await fs.writeFile(path.join(directory, 'public', 'index.html'), '<!doctype html><title>Test app shell</title>');
  const store = await import('../src/authStore.js');

  const users = {};
  const credentials = {};
  const mobileHeaders = {};
  for (const name of ['Admin', 'Owner', 'Other', 'Reader']) {
    const user = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (name !== 'Admin') await store.updateUser(user.id, { status: 'approved' }, users.Admin.id);
    users[name] = user;
    const session = await store.createSession(user.id);
    const pat = await store.createPrivateAccessToken(user.id, 'HTTP test');
    credentials[name] = [{ Cookie: `ssytdlp_session=${session.token}` }, { 'X-PAT': pat.token }];
    mobileHeaders[name] = { Authorization: `Bearer ${session.token}` };
  }

  await store.updateUser(users.Reader.id, { role: 'shared', sharedUserIds: [users.Owner.id, users.Admin.id] }, users.Admin.id);

  for (const name of ['Pending', 'Revoked']) {
    users[name] = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (name === 'Revoked') await store.updateUser(users[name].id, { status: 'revoked' }, users.Admin.id);
  }

  const outputRoot = path.join(directory, 'output');
  const songName = 'Song 100% #1.mp3';
  for (const id of ['owned', 'unowned', 'shared', 'music']) {
    const outputDir = path.join(outputRoot, id);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, songName), 'song');
    await fs.writeFile(path.join(outputDir, 'keep.mp3'), 'keep');
    await fs.writeFile(path.join(outputDir, '.download-archive.txt'), 'youtube song\nyoutube keep\n');
    (await writeJob(openDatabase(), {
      id, url: `https://music.youtube.com/watch?v=${id}`, status: 'completed',
      initiatedBy: id !== 'unowned' ? { id: users.Owner.id, name: 'Owner' } : null,
      outputDir, folderName: id, files: [songName, 'keep.mp3'],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
  }
  const musicDir = path.join(outputRoot, 'music');
  await fs.mkdir(path.join(musicDir, '[NoVocals]'));
  const artwork = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const artworkBuffer = Buffer.from(artwork.split(',')[1], 'base64');
  const taggedAudio = NodeID3.write({ title: 'A song', artist: 'An artist',
    image: { mime: 'image/png', type: { id: 3 }, imageBuffer: artworkBuffer },
    popularimeter: { email: 'listener@example.com', rating: 128, counter: 12 },
    unsynchronisedLyrics: { language: 'eng', text: 'First line\nSecond line' },
    synchronisedLyrics: [{ language: 'eng', timeStampFormat: 2, contentType: 1,
      synchronisedText: [{ text: 'First line', timeStamp: 1000 }, { text: 'Second line', timeStamp: 2500 }] }]
  }, Buffer.from('audio fixture'));
  await fs.writeFile(path.join(musicDir, '[NoVocals]', songName), taggedAudio);
  const musicJob = await readPostgresJob(openDatabase(), 'music');
  const sharedTranscription = { status: 'transcribed', requestedAt: new Date().toISOString(), lyricsIncluded: true,
    options: { language: 'vi', lyrics_mode: 'align', Multilingual: false } };
  (await writeJob(openDatabase(), { ...musicJob, files: [...musicJob.files, `[NoVocals]/${songName}`],
    transcriptions: { [songName]: sharedTranscription } }));
  (await closeDatabases());

  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  })));
  const [httpPort, httpsPort] = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  const ffmpegLocation = path.resolve(process.env.FFMPEG_PATH || path.join('runtime', 'ffmpeg', 'bin'));
  const ffmpegPath = /^ffmpeg(?:\.exe)?$/i.test(path.basename(ffmpegLocation)) ? ffmpegLocation
    : path.join(ffmpegLocation, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const canConvertWav = await fs.access(ffmpegPath).then(() => true, () => false);
  const thumbnailBuffer = canConvertWav ? await encodeThumbnail({ mime: 'image/png', imageBuffer: artworkBuffer }) : null;
  async function cachedThumbnails(filePath) {
    const key = createHash('sha256').update(await fs.realpath(filePath)).digest('hex');
    const cache = path.join(directory, 'data', 'artwork-thumbnails', key);
    return Promise.all((await fs.readdir(cache)).map((name) => fs.readFile(path.join(cache, name))));
  }
  async function startServer() {
    server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)),
      '--http-port', String(httpPort), '--https-port', String(httpsPort)], {
      cwd: directory,
      env: { ...process.env, YTDLP_OUTPUT_ROOT: outputRoot, YTDLP_PATH: process.execPath, FFMPEG_PATH: ffmpegLocation,
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
  await startServer();

  const call = (route, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: httpsPort, path: route,
      method, headers: { 'Content-Type': 'application/json', ...headers }, rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        resolve({ status: response.statusCode, text, buffer, headers: response.headers,
          body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  async function waitForJob(id, headers) {
    let response;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await call(`/api/jobs/${id}`, 'GET', headers);
      assert.equal(response.status, 200, response.text);
    } while (['queued', 'running'].includes(response.body.status));
    return response;
  }
  await context.test('Shared accounts can change their own theme but keep granted libraries read-only through every authentication method', async () => {
    const ownerLibrary = await call('/api/library', 'GET', credentials.Owner[0]);
    const ownerPreferences = (await call('/api/preferences', 'GET', credentials.Owner[0])).body;
    const userPath = `/api/admin/users/${users.Reader.id}`;
    const metadataName = encodeURIComponent(`[NoVocals]/${songName}`);
    const metadataReadPath = `/api/jobs/music/lyrics/${metadataName}`;
    const ownerMetadata = (await call(metadataReadPath, 'GET', credentials.Owner[0])).body;
    for (const headers of [credentials.Reader[0], mobileHeaders.Reader]) {
      const renamed = await call('/api/auth/me', 'PATCH', headers, { name: 'Shared Reader' });
      assert.equal(renamed.status, 200, renamed.text);
      assert.equal(renamed.body.user.name, 'Shared Reader');
      assert.equal(renamed.body.user.role, 'shared');
      assert.deepEqual(new Set(renamed.body.user.sharedUserIds), new Set([users.Owner.id, users.Admin.id]));
      assert.equal((await call('/api/auth/me', 'PATCH', headers, { name: 'Escalated', role: 'admin' })).status, 400);
    }
    assert.equal((await call('/api/auth/me', 'PATCH', credentials.Reader[1], { name: 'PAT rename' })).status, 401);
    assert.deepEqual(new Set((await call(userPath, 'GET', credentials.Admin[0])).body.user.sharedUserIds), new Set([users.Owner.id, users.Admin.id]));
    for (const headers of [...credentials.Reader, mobileHeaders.Reader]) {
      assert.equal((await call('/api/health', 'GET', headers)).status, 403);
      assert.equal((await call('/api/health', 'HEAD', headers)).status, 403);
      const preferences = await call('/api/preferences', 'PUT', headers, { theme: 'royal-purple', mode: 'dark', userId: users.Owner.id });
      assert.equal(preferences.status, 200, preferences.text);
      assert.deepEqual(preferences.body, { theme: 'royal-purple', mode: 'dark' });
      assert.deepEqual((await call('/api/preferences', 'GET', headers)).body, preferences.body);
      assert.deepEqual((await call('/api/preferences', 'GET', credentials.Owner[0])).body, ownerPreferences);
      assert.equal((await call('/api/preferences', 'PUT', headers, { theme: 'invalid' })).status, 400);
      assert.equal((await call('/api/preferences', 'PUT', headers, { mode: 'invalid' })).status, 400);
      const owners = await call('/api/library/shared-users', 'GET', headers);
      assert.equal(owners.status, 200, owners.text);
      assert.deepEqual(new Set(owners.body.users.map((user) => user.id)), new Set([users.Owner.id, users.Admin.id]));
      const library = await call(`/api/library?userId=${users.Owner.id}`, 'GET', headers);
      assert.equal(library.status, 200, library.text);
      assert.deepEqual(library.body.entries, ownerLibrary.body.entries);
      assert.ok(library.body.jobs.every((job) => !('outputDir' in job) && !('url' in job)));
      const tracks = await call(`/api/library/tracks?userId=${users.Owner.id}`, 'GET', headers);
      assert.equal(tracks.status, 200, tracks.text);
      assert.ok(tracks.body.files.length > 0);
      assert.ok(tracks.body.files.every((track) => !('outputDir' in track.sourceJob)));
      assert.deepEqual(tracks.body.files.find((track) => track.jobId === 'music' && track.name === songName).transcription, sharedTranscription);
      const playlistDownload = await call(`/api/library/playlists/music/download?userId=${users.Owner.id}`, 'GET', headers);
      assert.equal(playlistDownload.status, 200, playlistDownload.text);
      assert.equal(new AdmZip(playlistDownload.buffer).getEntries().filter((entry) => entry.entryName.startsWith('Media/')).length, 3);
      assert.equal((await call(`/api/library?userId=${users.Admin.id}`, 'GET', headers)).status, 200);
      for (const route of [`/api/library?userId=${users.Other.id}`, `/api/library/tracks?userId=${users.Other.id}`,
        `/api/jobs/unowned/stream/${encodeURIComponent(songName)}`, `/api/jobs/unowned/lyrics/${encodeURIComponent(songName)}`,
        `/api/jobs/unowned/artwork/${encodeURIComponent(songName)}`,
        '/api/jobs/music/download-all', '/api/jobs', '/api/jobs/music',
        '/api/jobs/music/files', '/api/admin/users', '/api/library/export', '/api/library/export?source=latest']) {
        assert.equal((await call(route, 'GET', headers)).status, 403, route);
      }
      for (const route of ['stream', 'download', 'lyrics']) {
        const result = await call(`/api/jobs/music/${route}/${encodeURIComponent(songName)}`, 'GET', headers);
        assert.equal(result.status, 200, route);
        if (route === 'lyrics') assert.equal(result.body.canEdit, false);
      }
      const metadata = await call(metadataReadPath, 'GET', headers);
      assert.equal(metadata.status, 200, metadata.text);
      assert.equal(metadata.headers['cache-control'], 'no-store');
      assert.deepEqual(metadata.body, { ...ownerMetadata, canEdit: false });
      assert.equal(metadata.body.title, 'A song');
      assert.equal(metadata.body.artist, 'An artist');
      assert.equal(metadata.body.rating, 3);
      const cover = await call(`/api/jobs/music/artwork/${metadataName}`, 'GET', headers);
      assert.equal(cover.status, thumbnailBuffer ? 200 : 500);
      if (thumbnailBuffer) assert.deepEqual(cover.buffer, thumbnailBuffer);
      for (const method of ['GET', 'POST']) {
        assert.equal((await call('/api/admin/artwork-thumbnails', method, headers)).status, 403);
      }
      assert.equal((await call(`/api/jobs/music/files/${metadataName}/metadata`, 'PATCH', headers,
        { title: 'Not allowed', rating: 5, artwork: null, transcriptionLocked: true })).status, 403);
      assert.deepEqual(await fs.readFile(path.join(musicDir, '[NoVocals]', songName)), taggedAudio);
      const partial = await call(`/api/jobs/music/stream/${encodeURIComponent(songName)}`, 'GET', { ...headers, Range: 'bytes=0-1' });
      assert.equal(partial.status, 206);
      for (const [route, method] of [['/api/jobs', 'POST'], ['/api/jobs/music', 'DELETE'], ['/api/jobs/music/title', 'PATCH'],
        ['/api/jobs/music/contributors', 'PUT'], ['/api/jobs/music/rerun', 'POST'],
        [`/api/jobs/music/files/${encodeURIComponent(songName)}`, 'DELETE'],
        [`/api/jobs/music/files/${encodeURIComponent(songName)}/metadata`, 'PATCH'],
        [`/api/jobs/music/files/${encodeURIComponent(songName)}/transcribe`, 'POST'],
        ['/api/library', 'PUT'], ['/api/library/entries', 'POST'], ['/api/library/songs/remove', 'POST'],
        ['/api/library/songs/transfer', 'POST'], ['/api/library/backup', 'POST'],
        ['/api/auth/pats', 'POST'], ['/api/auth/passkeys/options', 'POST'], [userPath, 'PATCH']]) {
        assert.equal((await call(route, method, headers, method === 'DELETE' ? undefined : {})).status, 403, `${method} ${route}`);
      }
    }
    assert.equal((await call(userPath, 'PATCH', credentials.Admin[0], { sharedUserIds: [] })).status, 200);
    assert.equal((await call('/api/library', 'GET', credentials.Reader[0])).body.songCount, 0);
    assert.equal((await call(`/api/library/playlists/music/download?userId=${users.Owner.id}`, 'GET', credentials.Reader[0])).status, 403);
    assert.equal((await call(`/api/jobs/music/stream/${encodeURIComponent(songName)}`, 'GET', credentials.Reader[0])).status, 403);
    for (const headers of [...credentials.Reader, mobileHeaders.Reader]) {
      assert.equal((await call(metadataReadPath, 'GET', headers)).status, 403);
      assert.equal((await call(`/api/jobs/music/artwork/${metadataName}`, 'GET', headers)).status, 403);
    }
    assert.deepEqual((await call('/api/library', 'GET', credentials.Owner[0])).body, ownerLibrary.body);
    assert.equal((await call(userPath, 'DELETE', credentials.Admin[0])).status, 204);
  });
  const sharedServerExited = once(server, 'exit');
  server.kill();
  await sharedServerExited;
  await startServer();

  await context.test('accepted user links expose read-only libraries without granting mutation rights', async () => {
    const libraryRoute = `/api/library?userId=${users.Owner.id}`;
    const tracksRoute = `/api/library/tracks?userId=${users.Owner.id}`;
    const playlistRoute = `/api/library/playlists/music/download?userId=${users.Owner.id}`;
    const original = (await call('/api/library', 'GET', credentials.Owner[0])).body;
    assert.equal(original.readOnly, false);
    assert.equal((await call(libraryRoute, 'GET', credentials.Other[0])).status, 403);
    assert.equal((await call(playlistRoute, 'GET', credentials.Other[0])).status, 403);
    assert.equal((await call('/api/auth/links', 'POST', credentials.Other[0], { userId: users.Owner.id })).status, 201);
    assert.equal((await call(tracksRoute, 'GET', credentials.Other[0])).status, 403);
    assert.equal((await call(`/api/auth/links/${users.Other.id}/accept`, 'POST', mobileHeaders.Owner)).status, 200);
    let song;
    for (const headers of [...credentials.Other, mobileHeaders.Other]) {
      const owners = await call('/api/library/shared-users', 'GET', headers);
      assert.deepEqual(owners.body.users, [{ id: users.Owner.id, name: users.Owner.name }]);
      const library = await call(libraryRoute, 'GET', headers);
      assert.equal(library.status, 200, library.text);
      assert.equal(library.body.ownerId, users.Owner.id);
      assert.equal(library.body.readOnly, true);
      assert.deepEqual(library.body.entries, original.entries);
      assert.ok(library.body.jobs.every((job) => !('outputDir' in job) && !('initiatedBy' in job)));
      const tracks = await call(tracksRoute, 'GET', headers);
      assert.equal(tracks.status, 200, tracks.text);
      assert.equal(tracks.body.readOnly, true);
      song = tracks.body.files.find((file) => file.jobId === 'music' && file.name === songName);
      assert.equal(song.readOnly, true);
      assert.equal(song.libraryOwnerId, users.Owner.id);
      assert.equal(new URL(song.streamUrl, 'http://localhost').searchParams.get('userId'), users.Owner.id);
      assert.equal((await call(song.streamUrl, 'GET', headers)).status, 200);
      const playlistDownload = await call(playlistRoute, 'GET', headers);
      assert.equal(playlistDownload.status, 200, playlistDownload.text);
      const playlistZip = new AdmZip(playlistDownload.buffer);
      assert.equal(playlistZip.getEntries().filter((entry) => entry.entryName.endsWith('.m3u8')).length, 1);
      assert.equal(playlistZip.getEntries().filter((entry) => entry.entryName.startsWith('Media/')).length, 3);
      const lyrics = await call(song.lyricsUrl, 'GET', headers);
      assert.equal(lyrics.status, 200);
      assert.equal(lyrics.body.canEdit, false);
      for (const [route, method, body] of [[libraryRoute, 'PUT', original],
        ['/api/library/entries', 'POST', { userId: users.Owner.id, version: original.version, action: 'create-folder', name: 'Intrusion' }],
        ['/api/jobs/music/title', 'PATCH', { playlistTitle: 'Intrusion' }],
        [`/api/jobs/music/files/${encodeURIComponent(songName)}/metadata`, 'PATCH', { title: 'Intrusion' }]]) {
        assert.equal((await call(route, method, headers, body)).status, 403, route);
      }
      assert.equal((await call('/api/library', 'GET', headers)).body.readOnly, false);
      assert.equal((await call(`/api/library?userId=${users.Admin.id}`, 'GET', headers)).status, 403);
    }
    assert.equal((await call(`/api/library?userId=${users.Other.id}`, 'GET', credentials.Owner[0])).status, 200);
    assert.deepEqual((await call('/api/library', 'GET', credentials.Owner[0])).body, original);
    assert.equal((await call(`/api/auth/links/${users.Owner.id}`, 'DELETE', credentials.Other[0])).status, 204);
    for (const route of [libraryRoute, tracksRoute, playlistRoute, song.streamUrl, song.lyricsUrl, song.downloadUrl]) {
      assert.equal((await call(route, 'GET', credentials.Other[0])).status, 403, route);
    }
    assert.deepEqual((await call('/api/library/shared-users', 'GET', credentials.Owner[0])).body.users, []);
  });
  const linkedServerExited = once(server, 'exit');
  server.kill();
  await linkedServerExited;
  await startServer();

  for (const route of ['/', '/app-login', '/job', '/job/music', '/job/music/player']) {
    assert.equal((await call(route)).status, 200);
  }
  for (const route of ['/api/library', '/api/library/tracks', '/api/library/export?format=android', '/api/library/backup', '/api/library/export?source=latest', '/api/preferences', '/api/health']) {
    assert.equal((await call(route)).status, 401);
  }
  const mediaHealth = await call('/api/health', 'GET', credentials.Other[0]);
  assert.equal(mediaHealth.status, 200, mediaHealth.text);
  assert.equal(mediaHealth.headers['cache-control'], 'no-store');
  assert.equal(mediaHealth.body.media.totalFiles, 9);
  assert.equal(mediaHealth.body.media.scanning, false);
  assert.equal(mediaHealth.body.media.error, null);
  assert.ok(Number.isFinite(Date.parse(mediaHealth.body.media.scannedAt)));
  assert.deepEqual((await call('/api/health', 'GET', credentials.Owner[1])).body.media, mediaHealth.body.media);
  for (const route of ['/api/jobs', '/api/jobs/music/files', '/api/library', '/api/library/tracks', '/api/preferences']) {
    assert.equal((await call(route, 'GET', mobileHeaders.Owner)).status, 200);
  }
  const mobileStream = await call(`/api/jobs/owned/stream/${encodeURIComponent(songName)}`, 'GET', {
    ...mobileHeaders.Owner, Range: 'bytes=0-1'
  });
  assert.equal(mobileStream.status, 206);
  assert.equal(mobileStream.text, 'so');
  assert.equal((await call(`/api/jobs/owned/download/${encodeURIComponent(songName)}`, 'GET', mobileHeaders.Owner)).text, 'song');
  assert.equal((await call('/api/preferences', 'PUT', mobileHeaders.Owner, { theme: 'light', mode: 'light' })).status, 200);
  assert.equal((await call('/api/jobs/owned/title', 'PATCH', mobileHeaders.Other, { playlistTitle: 'Denied' })).status, 403);
  assert.equal((await call('/api/library', 'PUT', {}, {})).status, 401);
  assert.equal((await call('/api/library/links', 'POST', {}, { jobId: 'music' })).status, 401);
  assert.equal((await call('/api/library/songs/move', 'POST', {}, {})).status, 401);
  assert.equal((await call('/api/preferences', 'PUT', {}, { theme: 'black' })).status, 401);
  assert.deepEqual((await call('/api/preferences', 'PUT', credentials.Owner[0], { theme: 'royal-purple', userId: users.Other.id })).body,
    { theme: 'royal-purple', mode: 'light' });
  assert.deepEqual((await call('/api/preferences', 'PUT', credentials.Owner[1], { mode: 'dark' })).body, { theme: 'royal-purple', mode: 'dark' });
  assert.deepEqual((await call('/api/preferences', 'GET', credentials.Owner[1])).body, { theme: 'royal-purple', mode: 'dark' });
  assert.deepEqual((await call('/api/preferences', 'GET', credentials.Other[0])).body, { theme: 'midnight', mode: 'light' });
  assert.equal((await call('/api/preferences', 'PUT', credentials.Owner[0], { mode: 'invalid' })).status, 400);
  assert.equal((await call('/api/preferences', 'PUT', credentials.Owner[0], { theme: 'invalid' })).status, 400);
  const initialLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(initialLibrary.jobs.length, 3);
  assert.equal(initialLibrary.entries.some((entry) => entry.id === 'unowned'), false);
  assert.deepEqual((await call('/api/library', 'GET', credentials.Other[0])).body.jobs, []);
  assert.deepEqual((await call('/api/library', 'GET', credentials.Admin[0])).body.jobs, []);
  assert.equal((await call('/api/library/tracks?entryId=music', 'GET', credentials.Other[0])).status, 404);
  assert.equal((await call('/api/library/links', 'POST', credentials.Other[0], { jobId: 'music' })).status, 403);
  assert.equal(initialLibrary.jobs.find((job) => job.id === 'music').playlistTitle, 'music');
  assert.deepEqual(initialLibrary.jobs.find((job) => job.id === 'music').contributors, []);
  assert.deepEqual(initialLibrary.jobs.find((job) => job.id === 'music').transcriptions, {});
  const organized = {
    version: initialLibrary.version,
    entries: [
      { id: 'folder-mixes', type: 'folder', name: 'Mixes', parentId: null },
      { id: 'shared', type: 'playlist', parentId: 'folder-mixes' },
      { id: 'folder-live', type: 'folder', name: 'Live', parentId: 'folder-mixes' },
      { id: 'music', type: 'playlist', parentId: 'folder-live' },
      { id: 'owned', type: 'playlist', parentId: null }
    ],
    songOrder: { music: ['keep.mp3', songName, `[NoVocals]/${songName}`] }
  };
  const savedLibrary = await call('/api/library', 'PUT', credentials.Owner[1], organized);
  assert.equal(savedLibrary.status, 200);
  await context.test('playlist downloads stream one ordered ZIP without changing library backups', async () => {
    const route = '/api/library/playlists/music/download';
    assert.equal((await call(route)).status, 401);
    for (const headers of [...credentials.Owner, mobileHeaders.Owner]) {
      const downloaded = await call(route, 'GET', headers);
      assert.equal(downloaded.status, 200, downloaded.text);
      assert.match(downloaded.headers['content-type'], /application\/zip/);
      assert.match(downloaded.headers['content-disposition'], /attachment; filename="music\.zip"/);
      assert.equal(downloaded.headers['cache-control'], 'no-store');
      const zip = new AdmZip(downloaded.buffer);
      assert.equal(zip.getEntries().filter((entry) => entry.entryName.endsWith('.m3u8')).length, 1);
      const paths = zip.readAsText('1-music.m3u8').split('\n').filter((line) => line && !line.startsWith('#'));
      assert.equal(paths.length, 3);
      assert.equal(zip.getEntries().filter((entry) => entry.entryName.startsWith('Media/')).length, 3);
      assert.equal(zip.readAsText(paths[0]), 'keep');
      assert.equal(zip.readAsText(paths[1]), 'song');
      assert.deepEqual(zip.readFile(paths[2]), taggedAudio);
      assert.ok(zip.getEntry('IMPORT.txt'));
    }
    for (const name of ['Other', 'Admin']) {
      assert.equal((await call(route, 'GET', credentials[name][0])).status, 404);
      assert.equal((await call(`${route}?userId=${users.Owner.id}`, 'GET', credentials[name][0])).status, 403);
    }
    for (const id of ['missing', 'folder-mixes', 'unowned']) {
      const denied = await call(`/api/library/playlists/${id}/download`, 'GET', credentials.Owner[0]);
      assert.equal(denied.status, 404);
      assert.equal(denied.headers['content-disposition'], undefined);
    }
    assert.equal((await call(`${route}?userId[]=invalid`, 'GET', credentials.Owner[0])).status, 400);
    const songPath = path.join(musicDir, 'keep.mp3');
    await fs.rename(songPath, `${songPath}.missing`);
    try {
      const missing = await call(route, 'GET', credentials.Owner[0]);
      assert.equal(missing.status, 409, missing.text);
      assert.equal(missing.headers['content-disposition'], undefined);
    } finally { await fs.rename(`${songPath}.missing`, songPath); }
    assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).body.version, savedLibrary.body.version);
  });
  assert.equal((await call('/api/library/export?source=latest', 'GET', credentials.Owner[0])).status, 404);
  assert.equal((await call('/api/library/backup', 'POST', {}, { format: 'android' })).status, 401);
  assert.equal((await call('/api/library/backup/schedule', 'PUT', {}, { enabled: false })).status, 401);
  assert.equal((await call('/api/library/export?source=invalid', 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call('/api/library/export?format=invalid', 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call('/api/library/export?format=itunes', 'GET', credentials.Owner[0])).status, 400);
  for (const headers of credentials.Owner) {
    const exported = await call('/api/library/export?format=android', 'GET', headers);
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-type'], /application\/zip/);
    assert.match(exported.headers['content-disposition'], /ssMusic-android\.zip/);
    assert.equal(exported.headers['cache-control'], 'no-store');
    const zip = new AdmZip(exported.buffer);
    assert.equal(zip.getEntries().filter((entry) => entry.entryName.startsWith('Music/')).length, 7);
    const playlist = zip.readAsText('2-music.m3u8');
    const paths = playlist.split('\n').filter((line) => line && !line.startsWith('#'));
    assert.equal(paths.length, 3);
    assert.equal(zip.readAsText(paths[0]), 'keep');
    assert.equal(zip.readAsText(paths[1]), 'song');
    assert.deepEqual(zip.readFile(paths[2]), taggedAudio);
    assert.ok(zip.getEntry('IMPORT.txt'));
  }
  for (const name of ['Other', 'Admin']) {
    const exported = await call('/api/library/export?format=android', 'GET', credentials[name][0]);
    assert.equal(exported.status, 200);
    assert.deepEqual(new AdmZip(exported.buffer).getEntries().map((entry) => entry.entryName), ['IMPORT.txt']);
  }
  const itunes = await call('/api/library/export?' + new URLSearchParams({
    format: 'itunes', destination: 'C:\\Music\\My Library'
  }), 'GET', credentials.Owner[1]);
  assert.equal(itunes.status, 200);
  const itunesZip = new AdmZip(itunes.buffer);
  assert.match(itunesZip.readAsText('Library.xml'), /file:\/\/\/C:\/Music\/My%20Library\/Music\//);
  assert.match(itunesZip.readAsText('Library.xml'), /<key>Parent Persistent ID<\/key>/);
  const latest = await call('/api/library/export?source=latest', 'GET', credentials.Owner[0]);
  assert.deepEqual(latest.buffer, itunes.buffer);
  assert.match(latest.headers['content-disposition'], /ssMusic-itunes\.zip/);
  assert.equal(latest.headers['cache-control'], 'no-store');
  const schedule = await call('/api/library/backup/schedule', 'PUT', credentials.Owner[1], {
    enabled: true, frequency: 'weekly', weekday: 1, time: '04:30', format: 'android', userId: users.Other.id
  });
  assert.equal(schedule.status, 200);
  assert.equal(schedule.body.schedule.frequency, 'weekly');
  assert.equal(schedule.body.latest.format, 'itunes');
  assert.ok(schedule.body.nextRunAt);
  assert.equal((await call('/api/library/backup', 'GET', credentials.Other[0])).body.schedule.enabled, false);
  const otherBackup = await call(`/api/library/export?source=latest&userId=${users.Owner.id}`, 'GET', credentials.Other[0]);
  assert.deepEqual(new AdmZip(otherBackup.buffer).getEntries().map((entry) => entry.entryName), ['IMPORT.txt']);
  assert.equal((await call('/api/library/backup', 'POST', credentials.Owner[0], { format: 'invalid' })).status, 400);
  const startedBackup = await call('/api/library/backup', 'POST', credentials.Owner[0], { format: 'android' });
  assert.equal(startedBackup.status, 202);
  assert.equal(startedBackup.body.running, true);
  assert.deepEqual(startedBackup.body.progress,
    { stage: 'preparing', processedSongs: 0, totalSongs: null, format: 'android' });
  let backup;
  do {
    await new Promise((resolve) => setTimeout(resolve, 25));
    backup = await call('/api/library/backup', 'GET', credentials.Owner[0]);
    assert.equal(backup.status, 200);
  } while (backup.body.running);
  assert.equal(backup.body.error, null);
  assert.equal(backup.body.latest.format, 'android');
  assert.equal(backup.body.latest.songCount, 7);
  assert.equal(backup.body.progress, null);
  assert.notEqual(backup.body.latest.id, schedule.body.latest.id);
  assert.equal((await call('/api/library/backup/schedule', 'PUT', credentials.Owner[0], { enabled: false })).body.nextRunAt, null);
  assert.deepEqual((await call('/api/library', 'GET', credentials.Owner[0])).body.entries, organized.entries);
  assert.equal((await call('/api/library', 'PUT', credentials.Owner[0], organized)).status, 409);
  assert.deepEqual((await call('/api/preferences', 'GET', credentials.Owner[0])).body, { theme: 'royal-purple', mode: 'dark' });
  const folderTracks = await call('/api/library/tracks?entryId=folder-mixes', 'GET', credentials.Owner[0]);
  const karaokeVersion = folderTracks.body.files.find((file) => file.jobId === 'music' && file.name === songName).noVocalsVersion;
  assert.equal(karaokeVersion.name, `[NoVocals]/${songName}`);
  assert.equal(karaokeVersion.jobId, 'music');
  assert.ok(karaokeVersion.streamUrl);
  assert.equal(folderTracks.body.files.find((file) => file.jobId === 'shared' && file.name === songName).noVocalsVersion, undefined);
  assert.deepEqual(folderTracks.body.files.map((file) => [file.jobId, file.name]), [
    ['shared', songName], ['shared', 'keep.mp3'],
    ['music', 'keep.mp3'], ['music', songName], ['music', `[NoVocals]/${songName}`]
  ]);
  assert.deepEqual((await call('/api/jobs/music/files', 'GET', credentials.Owner[0])).body.files.map((file) => file.name), organized.songOrder.music);
  assert.deepEqual((await call('/api/jobs/music', 'GET', credentials.Owner[1])).body.files, organized.songOrder.music);
  assert.deepEqual((await call('/api/jobs/music/files', 'GET', credentials.Other[0])).body.files.map((file) => file.name),
    [songName, 'keep.mp3', `[NoVocals]/${songName}`]);
  assert.equal((await call('/api/library/tracks?entryId=folder-mixes', 'GET', credentials.Other[0])).status, 404);
  assert.equal((await call('/api/library/tracks?entryId=missing', 'GET', credentials.Owner[0])).status, 404);
  const beforePagination = once(server, 'exit');
  server.kill();
  await beforePagination;
  await startServer();
  const allTracks = (await call('/api/library/tracks', 'GET', credentials.Owner[0])).body;
  assert.equal(allTracks.page, 1);
  assert.equal(allTracks.pageSize, 50);
  assert.equal(allTracks.total, 7);
  const pageTracks = await call('/api/library/tracks?page=2&pageSize=2', 'GET', credentials.Owner[0]);
  assert.equal(pageTracks.status, 200);
  assert.equal(pageTracks.body.totalPages, 4);
  assert.deepEqual(pageTracks.body.files.map((track) => [track.jobId, track.name]), allTracks.files.slice(2, 4).map((track) => [track.jobId, track.name]));
  assert.ok(pageTracks.body.files.find((track) => track.name === songName).noVocalsVersion.streamUrl);
  const lastPage = (await call('/api/library/tracks?page=999&pageSize=2', 'GET', credentials.Owner[0])).body;
  assert.equal(lastPage.page, 4);
  assert.equal(lastPage.files.length, 1);
  const foundTracks = (await call('/api/library/tracks?search=KEEP&pageSize=1&page=2', 'GET', credentials.Owner[0])).body;
  assert.equal(foundTracks.total, 3);
  assert.equal(foundTracks.files.length, 1);
  assert.equal(foundTracks.files[0].name, 'keep.mp3');
  const noTracks = (await call('/api/library/tracks?search=not-found&page=99', 'GET', credentials.Owner[0])).body;
  assert.deepEqual(noTracks.files, []);
  assert.equal(noTracks.total, 0);
  assert.equal(noTracks.page, 1);
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'pageSize=101', 'pageSize=0', 'page=1&page=2', 'search[]=bad']) {
    assert.equal((await call(`/api/library/tracks?${query}`, 'GET', credentials.Owner[0])).status, 400);
  }
  const encodedSong = encodeURIComponent(`[NoVocals]/${songName}`);
  const streamRoute = `/api/jobs/music/stream/${encodedSong}`;
  const lyricsRoute = `/api/jobs/music/lyrics/${encodedSong}`;
  const artworkRoute = `/api/jobs/music/artwork/${encodedSong}`;
  assert.equal((await call(streamRoute)).status, 401);
  assert.equal((await call(lyricsRoute)).status, 401);
  assert.equal((await call(artworkRoute)).status, 401);
  for (const method of ['GET', 'POST']) {
    assert.equal((await call('/api/admin/artwork-thumbnails', method)).status, 401);
    assert.equal((await call('/api/admin/artwork-thumbnails', method, credentials.Owner[0])).status, 403);
  }
  const artworkTrack = allTracks.files.find((file) => file.name === `[NoVocals]/${songName}`);
  assert.equal(artworkTrack.artworkUrl, `${artworkRoute}?v=${(await fs.stat(path.join(musicDir, '[NoVocals]', songName))).mtimeMs}`);
  assert.equal(artworkTrack.artwork, undefined);
  for (const headers of [...credentials.Owner, mobileHeaders.Owner]) {
    const cover = await call(artworkTrack.artworkUrl, 'GET', headers);
    assert.equal(cover.status, thumbnailBuffer ? 200 : 500);
    if (!thumbnailBuffer) continue;
    assert.deepEqual(cover.buffer, thumbnailBuffer);
    assert.equal(cover.headers['content-type'], 'image/webp');
    assert.equal(cover.headers['cache-control'], 'private, no-cache');
    assert.equal(cover.headers['x-content-type-options'], 'nosniff');
    assert.equal((await call(artworkTrack.artworkUrl, 'GET', { ...headers, 'If-None-Match': cover.headers.etag })).status, 304);
    const head = await call(artworkTrack.artworkUrl, 'HEAD', headers);
    assert.equal(head.status, 200);
    assert.equal(head.buffer.length, 0);
  }
  assert.equal((await call('/api/jobs/music/artwork/keep.mp3', 'GET', credentials.Owner[0])).status, 404);
  assert.equal((await call('/api/jobs/music/artwork/missing.mp3', 'GET', credentials.Owner[0])).status, 404);
  assert.equal((await call('/api/jobs/music/artwork/..%2Foutside.mp3', 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call('/api/jobs/music/artwork/.download-archive.txt', 'GET', credentials.Owner[0])).status, 400);
  const streamed = await call(streamRoute, 'GET', { ...credentials.Other[0], Range: 'bytes=0-2' });
  assert.equal(streamed.status, 206);
  assert.equal(streamed.text, 'ID3');
  const lyrics = await call(lyricsRoute, 'GET', credentials.Other[1]);
  assert.equal(lyrics.status, 200);
  assert.equal(lyrics.body.title, 'A song');
  assert.equal(lyrics.body.rating, 3);
  assert.equal(allTracks.files.find((file) => file.name === `[NoVocals]/${songName}`).rating, 3);
  assert.equal(lyrics.body.uslt, 'First line\nSecond line');
  assert.deepEqual(lyrics.body.sylt, [{ time: 1, text: 'First line' }, { time: 2.5, text: 'Second line' }]);
  const metadataRoute = `/api/jobs/music/files/${encodedSong}/metadata`;
  assert.equal((await call(metadataRoute, 'PATCH', {}, { title: 'Denied' })).status, 401);
  assert.equal((await call(metadataRoute, 'PATCH', credentials.Other[0], { title: 'Denied' })).status, 403);
  for (const body of [{ title: 7 }, { artist: 'bad\u0000tag' }, { unknown: 'field' }, { artwork: 'https://example.com/image.png' },
    { artwork: 'data:image/png;base64,aW52YWxpZA==' }, { artwork: artwork.replace('image/png', 'image/jpeg') }, { title: 'x'.repeat(501) },
    { rating: -1 }, { rating: 6 }, { rating: 2.5 }, { rating: '3' }, { rating: null }]) {
    assert.equal((await call(metadataRoute, 'PATCH', credentials.Owner[0], body)).status, 400);
  }
  const edited = await call(metadataRoute, 'PATCH', credentials.Owner[0], {
    title: 'Edited song', artist: 'Edited artist', album: 'New album', performerInfo: 'Album artist',
    genre: 'Jazz', year: '2026', trackNumber: '2/9', partOfSet: '1/2', artwork, rating: 5
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, 'Edited song');
  assert.equal(edited.body.artwork, artwork);
  assert.equal(edited.body.rating, 5);
  assert.deepEqual(edited.body.sylt, lyrics.body.sylt);
  assert.equal(edited.body.uslt, lyrics.body.uslt);
  if (thumbnailBuffer) {
    assert.deepEqual(await cachedThumbnails(path.join(musicDir, '[NoVocals]', songName)), [thumbnailBuffer],
      'metadata edits generate the thumbnail before any artwork GET');
  }
  assert.equal((await call(lyricsRoute, 'GET', credentials.Owner[0])).body.performerInfo, 'Album artist');
  const changedFile = await fs.readFile(path.join(musicDir, '[NoVocals]', songName));
  assert.deepEqual(NodeID3.removeTagsFromBuffer(changedFile), NodeID3.removeTagsFromBuffer(taggedAudio));
  assert.equal(NodeID3.read(changedFile).trackNumber, '2/9');
  assert.deepEqual(NodeID3.read(changedFile).popularimeter, { email: 'listener@example.com', rating: 255, counter: 12 });
  assert.equal((await call('/api/jobs/music/files', 'GET', credentials.Owner[0])).body.files.find((file) => file.name === `[NoVocals]/${songName}`).rating, 5);
  assert.equal((await call('/api/library/tracks', 'GET', credentials.Owner[0])).body.files.find((file) => file.name === `[NoVocals]/${songName}`).rating, 5);
  const updatedArtworkTrack = (await call('/api/library/tracks', 'GET', credentials.Owner[0])).body.files.find((file) => file.name === `[NoVocals]/${songName}`);
  assert.notEqual(updatedArtworkTrack.artworkUrl, artworkTrack.artworkUrl);
  if (thumbnailBuffer) assert.deepEqual((await call(updatedArtworkTrack.artworkUrl, 'GET', credentials.Owner[0])).buffer, thumbnailBuffer);
  assert.equal((await call('/api/jobs/music/files', 'GET', credentials.Owner[0])).body.files.find((file) => file.name === `[NoVocals]/${songName}`).title, 'Edited song');
  const retainedArtwork = await call(metadataRoute, 'PATCH', credentials.Admin[1], { artist: '' });
  assert.equal(retainedArtwork.body.artist, '');
  assert.equal(retainedArtwork.body.artwork, artwork);
  assert.equal(retainedArtwork.body.rating, 5);
  const clearedRating = await call(metadataRoute, 'PATCH', credentials.Owner[1], { rating: 0 });
  assert.equal(clearedRating.body.rating, 0);
  assert.equal(clearedRating.body.artwork, artwork);
  assert.deepEqual(clearedRating.body.sylt, lyrics.body.sylt);
  assert.equal(NodeID3.read(await fs.readFile(path.join(musicDir, '[NoVocals]', songName))).popularimeter.rating, 0);
  assert.equal((await call(metadataRoute, 'PATCH', credentials.Owner[1], { artwork: null })).body.artwork, null);
  assert.deepEqual(await cachedThumbnails(path.join(musicDir, '[NoVocals]', songName)), [Buffer.alloc(0)]);
  assert.equal((await call(updatedArtworkTrack.artworkUrl, 'GET', credentials.Owner[0])).status, 404);
  assert.equal((await call('/api/jobs/music/files/..%2Foutside.mp3/metadata', 'PATCH', credentials.Owner[0], { title: 'Bad' })).status, 400);
  assert.equal((await call('/api/jobs/music/files/missing.mp3/metadata', 'PATCH', credentials.Owner[0], { title: 'Missing' })).status, 404);
  assert.equal((await call('/api/jobs/music/stream/..%2Foutside.mp3', 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call(`/api/jobs/owned/download/${encodeURIComponent(songName)}`, 'GET', credentials.Other[0])).text, 'song');
  const transcribeRoute = `/api/jobs/music/files/${encodedSong}/transcribe`;
  assert.equal((await call(transcribeRoute, 'POST')).status, 401);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Other[1])).status, 403);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[0], { lyrics: 'words', lyrics_mode: 'bad' })).status, 400);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[1], {})).status, 503);
  const lockRoute = `/api/jobs/music/files/${encodedSong}/metadata`;
  assert.equal((await call(lockRoute, 'PATCH', credentials.Owner[0], { transcriptionLocked: true })).status, 200);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[0], {})).status, 409);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[0], { NoVocalsOnly: false })).status, 409);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[0], { NoVocalsOnly: 'true' })).status, 400);
  const separationOnly = await call(transcribeRoute, 'POST', credentials.Owner[1], { NoVocalsOnly: true });
  assert.equal(separationOnly.status, 503);
  assert.match(separationOnly.body.error, /TRANSCRIPTION_ENDPOINT is not configured/);
  assert.equal((await call('/api/jobs/music/files', 'GET', credentials.Owner[0])).body.files
    .find((file) => file.name === decodeURIComponent(encodedSong)).transcriptionLocked, true);
  assert.equal((await call(lockRoute, 'PATCH', credentials.Owner[0], { transcriptionLocked: false })).status, 200);
  const contributorRoute = '/api/jobs/shared/contributors';
  assert.equal((await call(`${contributorRoute}/users`)).status, 401);
  assert.equal((await call(contributorRoute, 'PUT', {}, { userIds: [] })).status, 401);
  for (const headers of credentials.Other) {
    assert.equal((await call(`${contributorRoute}/users`, 'GET', headers)).status, 403);
    assert.equal((await call(contributorRoute, 'PUT', headers, { userIds: [users.Other.id] })).status, 403);
  }
  const available = await call(`${contributorRoute}/users`, 'GET', credentials.Owner[0]);
  assert.equal(available.status, 200);
  assert.deepEqual(available.body.users, [users.Admin, users.Other].map(({ id, name }) => ({ id, name })));
  for (const userIds of [null, 'invalid', [42], ['unknown'], [users.Owner.id], [users.Pending.id], [users.Revoked.id]]) {
    assert.equal((await call(contributorRoute, 'PUT', credentials.Owner[0], { userIds })).status, 400);
  }
  const shared = await call(contributorRoute, 'PUT', credentials.Owner[0], { userIds: [users.Other.id, users.Other.id] });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.contributors, [{ id: users.Other.id, name: 'Other' }]);
  const contributedExport = await call('/api/library/export?format=android', 'GET', credentials.Other[1]);
  assert.equal(contributedExport.status, 200);
  const contributedZip = new AdmZip(contributedExport.buffer);
  assert.equal(contributedZip.getEntries().filter((entry) => entry.entryName.endsWith('.m3u8')).length, 1);
  assert.equal(contributedZip.getEntries().filter((entry) => entry.entryName.startsWith('Music/')).length, 2);
  const contributedPlaylist = await call('/api/library/playlists/shared/download', 'GET', credentials.Other[1]);
  assert.equal(contributedPlaylist.status, 200, contributedPlaylist.text);
  assert.equal(new AdmZip(contributedPlaylist.buffer).getEntries().filter((entry) => entry.entryName.startsWith('Media/')).length, 2);
  assert.equal((await call(`/api/jobs/shared/files/${encodeURIComponent(songName)}/metadata`, 'PATCH', credentials.Other[0], { title: 'Contributor edit' })).status, 200);
  const actionLibrary = (await call('/api/library', 'GET', credentials.Other[0])).body;
  assert.deepEqual(actionLibrary.jobs.find((job) => job.id === 'shared').contributors, shared.body.contributors);
  assert.deepEqual(actionLibrary.jobs.map((job) => job.id), ['shared']);
  assert.equal((await call('/api/library/tracks?entryId=music', 'GET', credentials.Owner[0])).body.files
    .find((file) => file.name === `[NoVocals]/${songName}`).transcription.status, 'failed');
  const persistedShared = JSON.parse((await openDatabase().prepare('SELECT data FROM jobs WHERE id = $1').get('shared')).data);
  assert.deepEqual(persistedShared.contributors, shared.body.contributors);
  (await closeDatabases());
  assert.equal(shared.body.initiatedBy.id, users.Owner.id);
  const titleRoute = '/api/jobs/shared/title';
  assert.equal((await call(titleRoute, 'PATCH', {}, { playlistTitle: 'Private edit' })).status, 401);
  assert.equal((await call(titleRoute, 'PATCH', credentials.Other[0], { playlistTitle: 'Contributor edit' })).status, 403);
  assert.equal((await call(titleRoute, 'PATCH', credentials.Owner[0], { playlistTitle: ' ' })).status, 400);
  const renamed = await call(titleRoute, 'PATCH', credentials.Owner[1], { playlistTitle: 'Shared favorites' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.playlistTitle, 'Shared favorites');
  assert.equal(renamed.body.folderName, 'shared');
  for (const headers of [credentials.Owner[0], credentials.Other[0]]) {
    const renamedLibrary = await call('/api/library', 'GET', headers);
    assert.equal(renamedLibrary.status, 200);
    assert.equal(renamedLibrary.body.playlists.find((playlist) => playlist.id === 'shared').playlistTitle, 'Shared favorites');
    assert.equal(renamedLibrary.body.jobs.find((job) => job.id === 'shared').playlistTitle, 'Shared favorites');
    const renamedTracks = await call('/api/library/tracks?entryId=shared', 'GET', headers);
    assert.equal(renamedTracks.status, 200);
    assert.ok(renamedTracks.body.files.length > 0);
    assert.ok(renamedTracks.body.files.every((track) => track.playlistTitle === 'Shared favorites'));
  }
  assert.equal((await call('/api/jobs/missing/title', 'PATCH', credentials.Owner[0], { playlistTitle: 'Missing' })).status, 404);
  assert.deepEqual((await call('/api/jobs/shared', 'GET', credentials.Other[0])).body.contributors, shared.body.contributors);
  assert.deepEqual((await call('/api/jobs', 'GET', credentials.Other[0])).body.find((job) => job.id === 'shared').contributors, shared.body.contributors);
  const sharedDuplicate = await call('/api/jobs', 'POST', credentials.Other[0], { url: 'https://music.youtube.com/watch?v=shared' });
  assert.deepEqual(sharedDuplicate.body.existingJob.contributors, shared.body.contributors);
  for (const [index, headers] of credentials.Other.entries()) {
    assert.equal((await call('/api/jobs/shared', 'DELETE', headers)).status, 403);
    assert.equal((await call(contributorRoute, 'PUT', headers, { userIds: [] })).status, 403);
    assert.equal((await call(`${contributorRoute}/users`, 'GET', headers)).status, 403);
    const name = index === 0 ? songName : 'keep.mp3';
    assert.equal((await call(`/api/jobs/shared/files/${encodeURIComponent(name)}`, 'DELETE', headers)).status, 409);
    const current = (await call('/api/library', 'GET', headers)).body;
    const removed = await call('/api/library/songs/remove', 'POST', headers, {
      version: current.version, jobId: 'shared', name, playlistId: 'shared'
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.fileDeleted, false);
    assert.ok(await fs.stat(path.join(outputRoot, 'shared', name)));
    const ownerLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
    const lastLink = await call('/api/library/songs/remove', 'POST', credentials.Owner[0], {
      version: ownerLibrary.version, jobId: 'shared', name, playlistId: 'shared'
    });
    assert.equal(lastLink.status, 200);
    assert.equal(lastLink.body.fileDeleted, true);
    assert.equal(await fs.stat(path.join(outputRoot, 'shared', name)).catch(() => null), null);
    const rerun = await call('/api/jobs/shared/rerun', 'POST', headers);
    assert.equal(rerun.status, 202);
    assert.equal(rerun.body.initiatedBy.id, users.Owner.id);
    assert.equal(rerun.body.playlistTitle, 'Shared favorites');
    assert.deepEqual(rerun.body.contributors, shared.body.contributors);
    await waitForJob('shared', headers);
  }
  assert.equal((await call(contributorRoute, 'PUT', credentials.Admin[1], { userIds: [] })).status, 200);
  for (const headers of credentials.Other) {
    assert.equal((await call('/api/jobs/shared/rerun', 'POST', headers)).status, 403);
    assert.equal((await call('/api/jobs/shared/files/keep.mp3', 'DELETE', headers)).status, 403);
  }
  assert.equal((await call(contributorRoute, 'PUT', credentials.Owner[1], { userIds: [users.Other.id] })).status, 200);
  assert.equal((await call(contributorRoute, 'PUT', credentials.Owner[0], { userIds: [] })).status, 200);
  assert.equal((await call('/api/jobs/missing/contributors', 'PUT', credentials.Owner[0], { userIds: [] })).status, 404);
  assert.equal((await call('/api/jobs/missing/contributors/users', 'GET', credentials.Owner[0])).status, 404);

  const songRoute = `/api/jobs/owned/files/${encodeURIComponent(songName)}`;
  const mutations = [[songRoute, 'DELETE'], ['/api/jobs/owned/rerun', 'POST'], ['/api/jobs/owned', 'DELETE']];
  for (const [route, method] of mutations) {
    assert.equal((await call(route, method)).status, 401);
    for (const headers of credentials.Other) assert.equal((await call(route, method, headers)).status, 403);
  }
  assert.equal((await call('/api/jobs/owned', 'GET', credentials.Other[0])).status, 200);
  assert.equal((await call('/api/jobs/owned/download/keep.mp3', 'GET', credentials.Other[1])).text, 'keep');
  const duplicate = await call('/api/jobs', 'POST', credentials.Other[0], { url: 'https://music.youtube.com/watch?v=owned' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.existingJob.initiatedBy.id, users.Owner.id);
  assert.equal((await call('/api/jobs/owned/files/..%2Foutside.mp3', 'DELETE', credentials.Owner[0])).status, 400);
  assert.equal((await call('/api/jobs/owned/files/.download-archive.txt', 'DELETE', credentials.Owner[1])).status, 400);

  const deleted = await call(songRoute, 'DELETE', credentials.Owner[1]);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.files, ['keep.mp3']);
  assert.equal(deleted.body.initiatedBy.id, users.Owner.id);
  assert.deepEqual((await call('/api/jobs/owned/files', 'GET', credentials.Owner[0])).body.files.map((file) => file.name), ['keep.mp3']);
  assert.equal((await call(songRoute, 'DELETE', credentials.Owner[0])).status, 404);
  assert.equal(await fs.readFile(path.join(outputRoot, 'owned', '.download-archive.txt'), 'utf8'), 'youtube song\nyoutube keep\n');
  assert.equal((await call('/api/jobs/owned/files/keep.mp3', 'DELETE', credentials.Admin[0])).status, 200);
  assert.equal((await call('/api/jobs/unowned', 'DELETE', credentials.Owner[0])).status, 403);
  assert.equal((await call('/api/jobs/unowned', 'DELETE', credentials.Admin[1])).status, 204);

  const rerun = await call('/api/jobs/owned/rerun', 'POST', credentials.Admin[1]);
  assert.equal(rerun.status, 202);
  assert.equal(rerun.body.initiatedBy.id, users.Owner.id);
  await waitForJob('owned', credentials.Owner[0]);
  assert.equal((await call('/api/jobs/owned', 'DELETE', credentials.Owner[0])).status, 204);
  assert.equal((await call('/api/jobs/owned', 'GET', credentials.Owner[0])).status, 404);

  const single = await call('/api/jobs', 'POST', credentials.Owner[0], { url: 'https://music.youtube.com/watch?v=individual' });
  assert.equal(single.status, 202);
  assert.equal(single.body.metadataOnly, false);
  const singleId = single.body.id;
  const firstSingleLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(firstSingleLibrary.playlists.find((playlist) => playlist.id === 'individual-songs').playlistTitle, 'Individual Songs');
  assert.equal(firstSingleLibrary.entries.some((entry) => entry.id === singleId), false);
  const current = await waitForJob(singleId, credentials.Owner[0]);
  await fs.writeFile(path.join(current.body.outputDir, 'single.mp3'), 'single song');
  (await writeJob(openDatabase(), { ...current.body, files: ['single.mp3'] }));
  (await closeDatabases());
  const singlesLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(singlesLibrary.playlists.find((playlist) => playlist.id === 'individual-songs').playlistTitle, 'Individual Songs');
  assert.equal(singlesLibrary.playlists.find((playlist) => playlist.id === 'individual-songs').protected, true);
  assert.equal(singlesLibrary.entries.some((entry) => entry.id === singleId), false);
  const individualTracks = (await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Owner[0])).body.files;
  assert.equal(individualTracks[0].jobId, singleId);
  assert.equal(individualTracks[0].playlistId, 'individual-songs');
  assert.equal((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).status, 404);
  const move = { version: singlesLibrary.version, jobId: singleId, name: 'single.mp3', playlistId: 'folder-mixes' };
  assert.equal((await call('/api/library/songs/move', 'POST', credentials.Owner[0], move)).status, 400);
  assert.equal((await call('/api/library/songs/move', 'POST', credentials.Owner[1], { ...move, playlistId: 'music' })).status, 200);
  assert.equal((await call('/api/library/songs/move', 'POST', credentials.Owner[0], { ...move, playlistId: 'music' })).status, 409);
  const moved = (await call('/api/library/tracks?entryId=music', 'GET', credentials.Owner[0])).body.files.at(-1);
  assert.equal(moved.jobId, singleId);
  assert.equal(moved.playlistId, 'music');
  assert.equal((await call(moved.downloadUrl, 'GET', credentials.Owner[0])).text, 'single song');
  assert.equal((await call('/api/library/links', 'POST', credentials.Other[1], { jobId: singleId })).status, 403);
  assert.equal((await call(`/api/jobs/${singleId}/contributors`, 'PUT', credentials.Owner[0], { userIds: [users.Other.id] })).status, 200);
  const otherLink = await call('/api/library/links', 'POST', credentials.Other[1], { jobId: singleId });
  assert.equal(otherLink.status, 200);
  assert.equal(otherLink.body.selectedId, 'individual-songs');
  assert.equal((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).body.files[0].jobId, singleId);
  assert.equal((await call(`/api/jobs/${singleId}/contributors`, 'PUT', credentials.Owner[0], { userIds: [] })).status, 200);
  assert.deepEqual((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).body.files, []);
  assert.equal((await call('/api/library/links', 'POST', credentials.Owner[0], { jobId: 'missing' })).status, 404);
  assert.equal((await call(`/api/jobs/${singleId}`, 'DELETE', credentials.Owner[0])).status, 204);
  assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).body.entries.some((entry) => entry.id === 'individual-songs'), true);

  const stopped = once(server, 'exit');
  server.kill();
  await stopped;
  await startServer();

  const addFilesRoute = '/api/library/jobs/add';
  assert.equal((await call(addFilesRoute, 'POST', {}, {})).status, 401);
  assert.equal((await call(addFilesRoute, 'POST', credentials.Other[0], { jobId: 'music' })).status, 403);
  assert.equal((await call(addFilesRoute, 'POST', credentials.Admin[1], { jobId: 'music' })).status, 403);
  const beforeAdd = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  const addFiles = { version: beforeAdd.version, jobId: 'music', playlistId: 'individual-songs' };
  assert.equal((await call(addFilesRoute, 'POST', credentials.Owner[0], { ...addFiles, playlistId: 'folder-mixes' })).status, 400);
  assert.equal((await call(addFilesRoute, 'POST', credentials.Owner[0], { ...addFiles, jobId: 'missing' })).status, 404);
  const addedFiles = await call(addFilesRoute, 'POST', credentials.Owner[1], addFiles);
  assert.equal(addedFiles.status, 200);
  assert.equal(addedFiles.body.addedCount, 3);
  assert.equal((await call(addFilesRoute, 'POST', credentials.Owner[0], addFiles)).status, 409);
  const repeatAdd = await call(addFilesRoute, 'POST', credentials.Owner[0], { ...addFiles, version: addedFiles.body.version });
  assert.equal(repeatAdd.body.addedCount, 0);
  const sourceAfterAdd = (await call('/api/library/tracks?entryId=music', 'GET', credentials.Owner[0])).body.files;
  const destinationAfterAdd = (await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Owner[0])).body.files;
  assert.deepEqual(destinationAfterAdd.map((track) => [track.jobId, track.name]), sourceAfterAdd.map((track) => [track.jobId, track.name]));
  assert.ok(destinationAfterAdd.every((track) => track.playlistId === 'individual-songs'));
  const allAfterAddResult = (await call('/api/library/tracks', 'GET', credentials.Owner[0])).body;
  const allAfterAdd = allAfterAddResult.files;
  assert.equal(new Set(allAfterAdd.map((track) => JSON.stringify([track.jobId, track.name]))).size, allAfterAdd.length);
  const libraryAfterAdd = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(libraryAfterAdd.songCount, beforeAdd.songCount);
  assert.equal(libraryAfterAdd.songCount, allAfterAddResult.total);
  assert.ok(libraryAfterAdd.playlists.reduce((total, playlist) => total + playlist.songCount, 0) > libraryAfterAdd.songCount);
  assert.equal((await call('/api/jobs/music/contributors', 'PUT', credentials.Owner[0], { userIds: [users.Other.id] })).status, 200);
  const contributorLibrary = (await call('/api/library', 'GET', credentials.Other[0])).body;
  const contributorAdd = await call(addFilesRoute, 'POST', credentials.Other[1], { ...addFiles, version: contributorLibrary.version });
  assert.equal(contributorAdd.status, 200);
  assert.equal(contributorAdd.body.addedCount, 3);
  assert.equal((await call('/api/jobs/music/contributors', 'PUT', credentials.Owner[0], { userIds: [] })).status, 200);
  assert.deepEqual((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).body.files, []);

  const largeDirectory = path.join(outputRoot, 'pagination');
  await fs.mkdir(largeDirectory);
  const largeFiles = Array.from({ length: 1205 }, (_, index) => `Track ${String(index).padStart(4, '0')} ${'long filename '.repeat(7)}.mp3`);
  await Promise.all(largeFiles.map((name) => fs.writeFile(path.join(largeDirectory, name), 'audio')));
  (await writeJob(openDatabase(), { id: 'pagination', status: 'completed', isPlaylist: true, playlistTitle: 'Pagination Fixture',
    url: 'https://music.youtube.com/playlist?list=pagination-fixture',
    initiatedBy: { id: users.Owner.id, name: 'Owner' }, outputDir: largeDirectory, files: largeFiles,
    songMetadata: { [largeFiles[1204]]: { title: 'Distant title', artist: 'Beyond page one' } },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  (await closeDatabases());
  const boundedDefault = (await call('/api/library/tracks', 'GET', credentials.Owner[0])).body;
  assert.equal(boundedDefault.files.length, 50);
  assert.equal(boundedDefault.total, 1208);
  const largeFirst = (await call('/api/library/tracks?search=Pagination%20Fixture', 'GET', credentials.Owner[0])).body;
  assert.equal(largeFirst.total, 1205);
  assert.equal(largeFirst.totalPages, 25);
  assert.deepEqual(largeFirst.files.map((track) => track.name), largeFiles.slice(0, 50));
  const largeSecond = (await call('/api/library/tracks?search=Pagination%20Fixture&page=2', 'GET', credentials.Owner[1])).body;
  assert.deepEqual(largeSecond.files.map((track) => track.name), largeFiles.slice(50, 100));
  const largeLast = (await call('/api/library/tracks?search=Pagination%20Fixture&page=999', 'GET', credentials.Owner[0])).body;
  assert.equal(largeLast.page, 25);
  assert.deepEqual(largeLast.files.map((track) => track.name), largeFiles.slice(1200));
  for (const search of ['Distant title', 'Beyond page one']) {
    const found = (await call(`/api/library/tracks?${new URLSearchParams({ search })}`, 'GET', credentials.Owner[0])).body;
    assert.equal(found.total, 1);
    assert.equal(found.files[0].name, largeFiles[1204]);
  }
  assert.equal((await call('/api/library/tracks?search=Pagination%20Fixture', 'GET', credentials.Other[0])).body.total, 0);
  assert.equal((await call('/api/library/tracks?entryId=pagination', 'GET', credentials.Owner[0])).body.files.length, 1205);
  const largeLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  const oversizedOrder = { ...largeLibrary, songOrder: { ...largeLibrary.songOrder, pagination: largeFiles },
    playlistSongOrder: { ...largeLibrary.playlistSongOrder, pagination: largeFiles.map((name) => JSON.stringify(['pagination', name])) } };
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedOrder)) > 128 * 1024);
  assert.equal((await call('/api/library', 'PUT', credentials.Owner[0], oversizedOrder)).status, 413);
  const reorderRoute = '/api/library/songs/reorder';
  const reorder = { version: largeLibrary.version, playlistId: 'pagination', jobId: 'pagination', name: largeFiles[0],
    target: JSON.stringify(['pagination', largeFiles[1]]), after: true };
  assert.ok(Buffer.byteLength(JSON.stringify(reorder)) < 1024);
  assert.equal((await call(reorderRoute, 'POST', {}, reorder)).status, 401);
  const otherVersion = (await call('/api/library', 'GET', credentials.Other[0])).body.version;
  assert.equal((await call(reorderRoute, 'POST', credentials.Other[0], { ...reorder, version: otherVersion })).status, 400);
  const reordered = await call(reorderRoute, 'POST', credentials.Owner[1], reorder);
  assert.equal(reordered.status, 200, reordered.text);
  assert.deepEqual(reordered.body.songOrder.pagination, [largeFiles[1], largeFiles[0], ...largeFiles.slice(2)]);
  assert.equal((await call(reorderRoute, 'POST', credentials.Owner[0], reorder)).status, 409);
  const persistedOrder = (await call('/api/library/tracks?entryId=pagination&page=1&pageSize=2', 'GET', credentials.Owner[0])).body;
  assert.deepEqual(persistedOrder.files.map((file) => file.name), [largeFiles[1], largeFiles[0]]);
  assert.deepEqual((await call('/api/jobs/pagination', 'GET', credentials.Owner[0])).body.files, reordered.body.songOrder.pagination);
  const restored = await call(reorderRoute, 'POST', credentials.Owner[0], { ...reorder, version: reordered.body.version, after: false });
  assert.equal(restored.status, 200, restored.text);
  assert.deepEqual(restored.body.songOrder.pagination, largeFiles);
  const entryRoute = '/api/library/entries';
  let tree = restored.body;
  const newFolder = { action: 'create-folder', id: 'folder-large-import', name: 'Imported music', parentId: null };
  const oldFolderRequest = { version: tree.version, entries: [...tree.entries,
    { id: newFolder.id, type: 'folder', name: newFolder.name, parentId: null }], songOrder: tree.songOrder };
  assert.ok(Buffer.byteLength(JSON.stringify(oldFolderRequest)) > 128 * 1024);
  assert.equal((await call('/api/library', 'PUT', credentials.Owner[0], oldFolderRequest)).status, 413);
  assert.equal((await call(entryRoute, 'POST', {}, { version: tree.version, ...newFolder })).status, 401);
  assert.equal((await call(entryRoute, 'POST', credentials.Other[0], { version: otherVersion,
    action: 'move', id: 'pagination', parentId: null, targetId: null, after: false })).status, 400);
  async function changeEntry(changes, headers = credentials.Owner[0]) {
    const body = { version: tree.version, ...changes };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024);
    const result = await call(entryRoute, 'POST', headers, body);
    assert.equal(result.status, 200, result.text);
    tree = result.body;
    for (const key of ['songOrder', 'playlistSongOrder', 'songMoves', 'songAdds', 'singleJobIds']) {
      assert.deepEqual(tree[key], restored.body[key]);
    }
  }
  await changeEntry(newFolder, credentials.Owner[1]);
  assert.ok(tree.entries.some((entry) => entry.id === newFolder.id));
  assert.equal((await call(entryRoute, 'POST', credentials.Owner[0], { ...newFolder, version: restored.body.version })).status, 409);
  await changeEntry({ action: 'update-folder', id: newFolder.id, name: 'Renamed folder', parentId: 'folder-mixes' });
  await changeEntry({ action: 'create-folder', id: 'folder-nested-import', name: 'Nested', parentId: newFolder.id });
  await changeEntry({ action: 'move', id: 'pagination', parentId: newFolder.id, targetId: 'folder-nested-import', after: false });
  assert.deepEqual(tree.entries.filter((entry) => entry.parentId === newFolder.id).map((entry) => entry.id), ['pagination', 'folder-nested-import']);
  await changeEntry({ action: 'move', id: 'folder-nested-import', parentId: newFolder.id, targetId: 'pagination', after: false });
  await changeEntry({ action: 'move', id: 'folder-nested-import', parentId: newFolder.id, targetId: 'pagination', after: true });
  await changeEntry({ action: 'move', id: newFolder.id, parentId: null, targetId: 'folder-mixes', after: false });
  await changeEntry({ action: 'delete-folder', id: newFolder.id });
  assert.deepEqual(tree.entries.filter((entry) => ['pagination', 'folder-nested-import'].includes(entry.id)).map((entry) => entry.parentId), [null, null]);
  await changeEntry({ action: 'delete-folder', id: 'folder-nested-import' });
  const folderBatch = { action: 'create-folders', parentId: 'folder-mixes',
    folders: [{ id: 'folder-batch-first', name: 'First' }, { id: 'folder-batch-second', name: 'Second' }] };
  const batchVersion = tree.version;
  assert.equal((await call(entryRoute, 'POST', {}, { ...folderBatch, version: batchVersion })).status, 401);
  await changeEntry(folderBatch, credentials.Owner[1]);
  assert.equal(tree.version, batchVersion + 1);
  assert.deepEqual(tree.entries.slice(-2), folderBatch.folders.map((folder) => ({ ...folder, type: 'folder', parentId: folderBatch.parentId })));
  assert.equal((await call(entryRoute, 'POST', credentials.Owner[0], { ...folderBatch, version: batchVersion })).status, 409);
  assert.equal((await call(entryRoute, 'POST', credentials.Owner[0], { ...folderBatch, version: tree.version,
    folders: [{ id: 'folder-batch-valid', name: 'Valid' }, { id: 'folder-batch-invalid', name: ' ' }] })).status, 400);
  const reloadedTree = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(reloadedTree.version, tree.version);
  assert.deepEqual(reloadedTree.entries, tree.entries);
  assert.equal(reloadedTree.serverPagination, true);
  assert.deepEqual((await call('/api/jobs/pagination', 'GET', credentials.Owner[0])).body.files, restored.body.songOrder.pagination);
  assert.equal((await call('/api/library', 'GET', credentials.Other[0])).body.version, otherVersion);
  const bulkRestart = once(server, 'exit');
  server.kill();
  await bulkRestart;
  await startServer();
  const bulkPlaylists = { version: tree.version, ids: ['pagination', 'music'], parentId: 'folder-mixes' };
  assert.equal((await call('/api/library/playlists/move', 'POST', {}, bulkPlaylists)).status, 401);
  assert.equal((await call('/api/library/playlists/move', 'POST', credentials.Other[0], { ...bulkPlaylists, version: otherVersion })).status, 400);
  const bulkFolder = await call('/api/library/playlists/move', 'POST', credentials.Owner[0], bulkPlaylists);
  assert.equal(bulkFolder.status, 200, bulkFolder.text);
  assert.ok(bulkFolder.body.entries.filter((entry) => bulkPlaylists.ids.includes(entry.id)).every((entry) => entry.parentId === 'folder-mixes'));
  assert.equal((await call('/api/library/playlists/move', 'POST', credentials.Owner[0], bulkPlaylists)).status, 409);
  const bulkSongs = { version: bulkFolder.body.version, action: 'link', sourcePlaylistId: 'pagination', playlistId: 'music',
    keys: largeFiles.map((name) => JSON.stringify(['pagination', name])) };
  assert.ok(Buffer.byteLength(JSON.stringify(bulkSongs)) > 128 * 1024);
  assert.equal((await call('/api/library/songs/transfer', 'POST', {}, bulkSongs)).status, 401);
  assert.equal((await call('/api/library/songs/transfer', 'POST', credentials.Other[0], { ...bulkSongs, version: otherVersion })).status, 400);
  const bulkLinked = await call('/api/library/songs/transfer', 'POST', credentials.Owner[1], bulkSongs);
  assert.equal(bulkLinked.status, 200, bulkLinked.text);
  assert.equal(bulkLinked.body.songAdds.filter((track) => track.jobId === 'pagination' && track.playlistId === 'music').length, 1205);
  assert.equal((await call('/api/library/songs/transfer', 'POST', credentials.Owner[0], bulkSongs)).status, 409);
  const bulkMoved = await call('/api/library/songs/transfer', 'POST', credentials.Owner[0], {
    ...bulkSongs, version: bulkLinked.body.version, action: 'move', sourcePlaylistId: 'music', playlistId: 'pagination'
  });
  assert.equal(bulkMoved.status, 200, bulkMoved.text);
  assert.equal(bulkMoved.body.songAdds.filter((track) => track.jobId === 'pagination').length, 0);
  assert.deepEqual(bulkMoved.body.playlistSongOrder.pagination, bulkSongs.keys);
  for (const name of largeFiles.slice(1200)) {
    assert.equal((await call(`/api/jobs/pagination/files/${encodeURIComponent(name)}`, 'DELETE', credentials.Owner[0])).status, 200);
  }
  const clamped = (await call('/api/library/tracks?search=Pagination%20Fixture&page=25', 'GET', credentials.Owner[0])).body;
  assert.equal(clamped.page, 24);
  assert.equal(clamped.total, 1200);
  assert.equal(clamped.files.length, 50);
  assert.equal((await call('/api/jobs/pagination', 'DELETE', credentials.Owner[0])).status, 204);

  const metadataUrl = 'https://music.youtube.com/playlist?list=metadata-only';
  for (const metadataOnly of ['true', 1, null]) {
    const invalid = await call('/api/jobs', 'POST', credentials.Owner[0], { url: metadataUrl, metadataOnly });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /metadataOnly must be a boolean/);
  }
  const metadataJob = await call('/api/jobs', 'POST', credentials.Owner[0], { url: metadataUrl, metadataOnly: true });
  assert.equal(metadataJob.status, 202);
  assert.equal(metadataJob.body.metadataOnly, true);
  const metadataId = metadataJob.body.id;
  const metadataResult = await waitForJob(metadataId, credentials.Owner[0]);
  assert.equal(metadataResult.body.metadataOnly, true);
  assert.equal(metadataResult.body.command, null);
  assert.deepEqual(metadataResult.body.files, []);
  assert.ok((await fs.stat(metadataResult.body.outputDir)).isDirectory());
  assert.ok((await call('/api/library', 'GET', credentials.Owner[0])).body.playlists.some((playlist) => playlist.id === metadataId));
  const metadataRerun = await call(`/api/jobs/${metadataId}/rerun`, 'POST', credentials.Owner[0]);
  assert.equal(metadataRerun.status, 202);
  assert.equal(metadataRerun.body.metadataOnly, false);
  const mediaResult = await waitForJob(metadataId, credentials.Owner[0]);
  assert.match(mediaResult.body.command, /--extract-audio/);
  assert.equal(mediaResult.body.outputDir, metadataResult.body.outputDir);
  assert.equal((await call(`/api/jobs/${metadataId}`, 'DELETE', credentials.Owner[0])).status, 204);

  const videoUrl = 'https://www.youtube.com/watch?v=video&list=video-playlist';
  const invalidFormat = await call('/api/jobs', 'POST', credentials.Owner[0], { url: videoUrl, downloadType: 'unknown' });
  assert.equal(invalidFormat.status, 400);
  assert.match(invalidFormat.body.error, /downloadType/);
  assert.equal((await call('/api/jobs', 'POST', credentials.Owner[0], { url: 'https://example.com/video', downloadType: 'video' })).status, 400);
  const videoJob = await call('/api/jobs', 'POST', credentials.Owner[0], { url: videoUrl, downloadType: 'video' });
  assert.equal(videoJob.status, 202, videoJob.text);
  assert.equal(videoJob.body.downloadType, 'video');
  assert.equal(videoJob.body.isPlaylist, true);
  const videoPlaylistLink = await call('/api/library/links', 'POST', credentials.Owner[0], { jobId: videoJob.body.id });
  assert.equal(videoPlaylistLink.body.selectedId, videoJob.body.id);
  const videoResult = await waitForJob(videoJob.body.id, credentials.Owner[0]);
  assert.match(videoResult.body.command, /--merge-output-format mp4/);
  assert.doesNotMatch(videoResult.body.command, /--extract-audio/);
  assert.equal((await call('/api/jobs', 'POST', credentials.Owner[0], { url: videoUrl, downloadType: 'video' })).status, 409);
  const audioJob = await call('/api/jobs', 'POST', credentials.Owner[0], { url: videoUrl });
  assert.equal(audioJob.status, 202, audioJob.text);
  assert.equal(audioJob.body.downloadType, 'audio');
  await waitForJob(audioJob.body.id, credentials.Owner[0]);
  for (const job of [videoJob.body, audioJob.body]) {
    assert.equal((await call(`/api/jobs/${job.id}`, 'DELETE', credentials.Owner[0])).status, 204);
  }
  const shortJob = await call('/api/jobs', 'POST', credentials.Owner[0], { url: 'https://youtu.be/short-video', downloadType: 'video' });
  assert.equal(shortJob.status, 202, shortJob.text);
  assert.equal(shortJob.body.isPlaylist, false);
  const videoLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(videoLibrary.playlists.find((playlist) => playlist.id === 'individual-videos').playlistTitle, 'Individual Videos');
  assert.equal(videoLibrary.entries.some((entry) => entry.id === shortJob.body.id), false);
  const videoLink = await call('/api/library/links', 'POST', credentials.Owner[0], { jobId: shortJob.body.id });
  assert.equal(videoLink.status, 200);
  assert.equal(videoLink.body.selectedId, 'individual-videos');
  const shortResult = await waitForJob(shortJob.body.id, credentials.Owner[0]);
  await fs.writeFile(path.join(shortResult.body.outputDir, 'Single.mp4'), 'single video');
  await writeJob(openDatabase(), { ...shortResult.body, files: ['Single.mp4'] });
  await closeDatabases();
  const videoTracks = (await call('/api/library/tracks?entryId=individual-videos', 'GET', credentials.Owner[0])).body.files;
  assert.equal(videoTracks.length, 1);
  assert.equal(videoTracks[0].jobId, shortJob.body.id);
  assert.equal(videoTracks[0].playlistId, 'individual-videos');
  assert.equal(videoTracks[0].playlistTitle, 'Individual Videos');
  assert.equal((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Owner[0])).body.files.some((track) => track.jobId === shortJob.body.id), false);
  assert.equal((await call(`/api/jobs/${shortJob.body.id}`, 'DELETE', credentials.Owner[0])).status, 204);
  assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).body.entries.find((entry) => entry.id === 'individual-videos').protected, true);

  const upload = async (fields, files, headers = credentials.Owner[0]) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    for (const file of files) form.append(file.field, new Blob([file.data]), file.name);
    const multipart = new Request('http://localhost/api/jobs/import', { method: 'POST', body: form });
    return call('/api/jobs/import', 'POST', { ...headers, 'Content-Type': multipart.headers.get('content-type') }, Buffer.from(await multipart.arrayBuffer()));
  };
  const audio = Buffer.from('524946462800000057415645666d74201000000001000100401f0000803e000002001000646174610400000000000000', 'hex');
  const uploadFile = { field: 'files', name: 'Uploaded.wav', data: audio };
  const importOptions = { mode: 'files', createNew: 'true', playlistTitle: 'Uploaded playlist' };
  assert.equal((await upload(importOptions, [uploadFile], {})).status, 401);
  assert.equal((await upload(importOptions, [])).status, 400);
  const imported = await upload(importOptions, [uploadFile]);
  assert.equal(imported.status, 201, imported.text);
  const importedId = imported.body.jobs[0].id;
  assert.equal(imported.body.jobs[0].initiatedBy.id, users.Owner.id);
  assert.equal(imported.body.jobs[0].source, 'files');
  assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).body.playlists.some((playlist) => playlist.id === importedId), true);
  assert.deepEqual((await call(`/api/jobs/${importedId}/stream/Uploaded.wav`, 'GET', credentials.Owner[0])).buffer, audio);
  await context.test('admins assign browser uploads to approved users without exposing other import destinations', async () => {
    const destination = `/api/jobs/import/playlists?userId=${users.Owner.id}`;
    assert.equal((await call(destination)).status, 401);
    const own = await call(destination, 'GET', credentials.Owner[0]);
    assert.equal(own.status, 200, own.text);
    assert.ok(own.body.playlists.some((playlist) => playlist.id === importedId));
    assert.ok(own.body.playlists.every((playlist) => Object.keys(playlist).every((key) => ['id', 'playlistTitle', 'status'].includes(key))));
    for (const headers of [...credentials.Other, mobileHeaders.Other]) {
      assert.equal((await call(destination, 'GET', headers)).status, 403);
      assert.equal((await upload({ ...importOptions, userId: users.Owner.id }, [uploadFile], headers)).status, 403);
    }
    assert.equal((await call(destination, 'GET', credentials.Admin[0])).status, 200);
    for (const userId of [users.Pending.id, users.Revoked.id, 'missing']) {
      assert.equal((await call(`/api/jobs/import/playlists?userId=${userId}`, 'GET', credentials.Admin[0])).status, 400);
      assert.equal((await upload({ ...importOptions, userId }, [uploadFile], credentials.Admin[0])).status, 400);
    }
    const assigned = await upload({ ...importOptions, userId: users.Other.id }, [uploadFile], credentials.Admin[1]);
    assert.equal(assigned.status, 201, assigned.text);
    const assignedId = assigned.body.jobs[0].id;
    assert.equal(assigned.body.jobs[0].initiatedBy.id, users.Other.id);
    const targetLibrary = (await call('/api/library', 'GET', credentials.Other[0])).body;
    assert.ok(targetLibrary.entries.some((entry) => entry.id === assignedId));
    assert.equal((await call('/api/library', 'GET', credentials.Admin[0])).body.entries.some((entry) => entry.id === assignedId), false);
    const append = await upload({ mode: 'files', createNew: 'false', playlistId: assignedId, userId: users.Other.id }, [uploadFile], mobileHeaders.Admin);
    assert.equal(append.status, 201, append.text);
    assert.deepEqual(append.body.jobs[0].files, ['Uploaded.wav', 'Uploaded (2).wav']);
    assert.equal((await upload({ mode: 'files', createNew: 'false', playlistId: importedId, userId: users.Other.id }, [uploadFile], credentials.Admin[0])).status, 400);
    assert.equal((await call(`/api/jobs/${assignedId}`, 'DELETE', credentials.Admin[0])).status, 204);
  });
  const existingOptions = { mode: 'files', createNew: 'false', playlistId: importedId };
  assert.equal((await upload(existingOptions, [uploadFile], credentials.Other[0])).status, 400);
  const appended = await upload(existingOptions, [uploadFile], credentials.Owner[1]);
  assert.equal(appended.status, 201, appended.text);
  assert.deepEqual(appended.body.jobs[0].files, ['Uploaded.wav', 'Uploaded (2).wav']);
  const unicodeName = 'Caf\u00e9 \u97f3\u697d.wav';
  const unicodeImport = await upload(existingOptions, [{ ...uploadFile, name: unicodeName }]);
  assert.equal(unicodeImport.status, 201, unicodeImport.text);
  assert.equal(unicodeImport.body.jobs[0].files.at(-1), unicodeName);
  assert.equal((await call(`/api/jobs/${importedId}/rerun`, 'POST', credentials.Owner[0])).status, 400);
  assert.equal((await upload(importOptions, [{ ...uploadFile, data: Buffer.from('invalid') }])).status, 400);
  const movie = { field: 'files', name: 'Movie 100% #1.mp4', data: Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex') };
  const movieImport = await upload({ ...importOptions, playlistTitle: 'Movies' }, [movie]);
  assert.equal(movieImport.status, 201, movieImport.text);
  const movieId = movieImport.body.jobs[0].id;
  assert.equal((await upload(existingOptions, [movie])).status, 201);
  const movieFiles = await call(`/api/jobs/${importedId}/files`, 'GET', credentials.Owner[0]);
  const movieFile = movieFiles.body.files.find((file) => file.name === movie.name);
  assert.equal(movieFile.isSong, false);
  assert.equal(movieFile.isPlayable, true);
  assert.equal(movieFile.mediaType, 'video');
  assert.equal((await call(movieFile.streamUrl)).status, 401);
  const movieStream = await call(movieFile.streamUrl, 'GET', { ...credentials.Owner[0], Range: 'bytes=4-11' });
  assert.equal(movieStream.status, 206);
  assert.equal(movieStream.headers['content-type'], 'video/mp4');
  assert.equal(movieStream.headers['content-range'], `bytes 4-11/${movie.data.length}`);
  assert.deepEqual(movieStream.buffer, movie.data.subarray(4, 12));
  assert.equal((await call(movieFile.streamUrl, 'GET', { ...credentials.Owner[0], Range: 'bytes=999-' })).status, 416);
  assert.equal((await call(`/api/jobs/${importedId}/lyrics/${encodeURIComponent(movie.name)}`, 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call(`/api/jobs/${importedId}/stream/..%2Foutside.mp4`, 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await upload(existingOptions, [{ ...movie, data: audio }])).status, 400);
  const movieLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(movieLibrary.playlists.find((playlist) => playlist.id === importedId).songCount, 4);
  const movieKey = JSON.stringify([importedId, movie.name]);
  const movieOrder = await call('/api/library', 'PUT', credentials.Owner[0], { ...movieLibrary,
    songOrder: { ...movieLibrary.songOrder, [importedId]: [movie.name] },
    playlistSongOrder: { ...movieLibrary.playlistSongOrder, [importedId]: [movieKey] } });
  assert.equal(movieOrder.status, 200, movieOrder.text);
  const movieTracks = await call(`/api/library/tracks?entryId=${importedId}`, 'GET', credentials.Owner[0]);
  assert.equal(movieTracks.body.files[0].name, movie.name);
  assert.equal(movieTracks.body.files[0].mediaType, 'video');
  const movieMove = await call('/api/library/songs/move', 'POST', credentials.Owner[0], {
    version: movieOrder.body.version, jobId: importedId, name: movie.name, playlistId: movieId
  });
  assert.equal(movieMove.status, 200, movieMove.text);
  assert.equal((await call(`/api/library/tracks?entryId=${movieId}`, 'GET', credentials.Owner[0])).body.files.length, 2);
  const itunesSourceName = canConvertWav ? 'Uploaded.wav' : 'Uploaded.mp3';
  const encodedAudio = Buffer.alloc(417 * 20);
  for (let offset = 0; offset < encodedAudio.length; offset += 417) encodedAudio.writeUInt32BE(0xfffb9000, offset);
  if (!canConvertWav) context.diagnostic('FFmpeg unavailable: using MP3 for HTTP imports; WAV conversion is covered by unit mocks.');
  const xml = buildPlist({ Tracks: { 1: { 'Track ID': 1, Location: `file:///Users/me/Music/${itunesSourceName}` } },
    Playlists: [{ Name: 'iTunes favorites', 'Playlist Items': [{ 'Track ID': 1 }] },
      { Name: 'iTunes linked', 'Playlist Items': [{ 'Track ID': 1 }] }] });
  const mediaZip = new AdmZip();
  mediaZip.addFile(`Music/${itunesSourceName}`, canConvertWav ? audio : encodedAudio);
  const itunesFiles = [{ field: 'xml', name: 'Library.xml', data: xml }, { field: 'media', name: 'Media.zip', data: mediaZip.toBuffer() }];
  const assignedItunes = await upload({ mode: 'itunes', userId: users.Other.id }, itunesFiles, credentials.Admin[0]);
  assert.equal(assignedItunes.status, 201, assignedItunes.text);
  assert.ok(assignedItunes.body.jobs.every((job) => job.initiatedBy.id === users.Other.id));
  const recipientLibrary = (await call('/api/library', 'GET', credentials.Other[0])).body;
  assert.ok(assignedItunes.body.jobs.every((job) => recipientLibrary.entries.some((entry) => entry.id === job.id)));
  const assignedLogRoute = `/api/jobs/import/logs/${assignedItunes.body.importId}`;
  assert.equal((await call(assignedLogRoute, 'GET', credentials.Other[0])).status, 404);
  assert.equal((await call(assignedLogRoute, 'GET', credentials.Admin[0])).body.status, 'completed');
  for (const job of assignedItunes.body.jobs.toReversed()) {
    assert.equal((await call(`/api/jobs/${job.id}`, 'DELETE', credentials.Admin[0])).status, 204);
  }
  assert.equal((await upload({ mode: 'itunes' }, itunesFiles.slice(0, 1))).status, 400);
  const importedItunes = await upload({ mode: 'itunes' }, itunesFiles, mobileHeaders.Owner);
  assert.equal(importedItunes.status, 201, importedItunes.text);
  assert.equal(importedItunes.body.jobs[0].playlistTitle, 'iTunes favorites');
  assert.equal(importedItunes.body.jobs[0].source, 'itunes');
  assert.equal(importedItunes.body.importedFiles, 1);
  assert.deepEqual(importedItunes.body.jobs[1].files, []);
  assert.equal(importedItunes.body.jobs[1].playlistSongCount, 1);
  const importLogRoute = `/api/jobs/import/logs/${importedItunes.body.importId}`;
  assert.equal((await call(importLogRoute)).status, 401);
  for (const name of ['Other', 'Admin']) assert.equal((await call(importLogRoute, 'GET', credentials[name][0])).status, 404);
  const importLog = await call(importLogRoute, 'GET', credentials.Owner[1]);
  assert.equal(importLog.status, 200);
  assert.equal(importLog.headers['cache-control'], 'no-store');
  assert.equal(importLog.body.status, 'completed');
  assert.ok(importLog.body.entries.some((entry) => entry.message === 'Playlist imported'));
  assert.ok(importLog.body.entries.some((entry) => entry.message === 'Playlist imported' && entry.details.files === 0 && entry.details.linked === 1));
  if (canConvertWav) assert.ok(importLog.body.entries.some((entry) => entry.message === 'WAV converted to MP3'));
  assert.equal(importLog.body.entries.at(-1).message, 'Import completed');
  const itunesTracks = await call(`/api/library/tracks?entryId=${importedItunes.body.jobs[0].id}`, 'GET', credentials.Owner[0]);
  assert.equal(itunesTracks.body.files[0].name, 'Uploaded.mp3');
  const importedAudio = await call(`/api/jobs/${importedItunes.body.jobs[0].id}/stream/Uploaded.mp3`, 'GET', credentials.Owner[0]);
  assert.equal(importedAudio.status, 200);
  assert.equal((await fileTypeFromBuffer(importedAudio.buffer)).ext, 'mp3');
  const linkedId = importedItunes.body.jobs[1].id;
  const linkedTracks = await call(`/api/library/tracks?entryId=${linkedId}`, 'GET', credentials.Owner[0]);
  assert.equal(linkedTracks.body.files.length, 1);
  assert.equal(linkedTracks.body.files[0].jobId, importedItunes.body.jobs[0].id);
  assert.equal(linkedTracks.body.files[0].streamUrl, itunesTracks.body.files[0].streamUrl);
  const importedLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  const removePrimary = await call('/api/library/songs/remove', 'POST', credentials.Owner[0], {
    version: importedLibrary.version, jobId: importedItunes.body.jobs[0].id, name: 'Uploaded.mp3', playlistId: importedItunes.body.jobs[0].id
  });
  assert.equal(removePrimary.status, 200, removePrimary.text);
  assert.equal(removePrimary.body.fileDeleted, false);
  assert.deepEqual((await call(linkedTracks.body.files[0].streamUrl, 'GET', credentials.Owner[0])).buffer, importedAudio.buffer);
  const removeLast = await call('/api/library/songs/remove', 'POST', credentials.Owner[0], {
    version: removePrimary.body.version, jobId: importedItunes.body.jobs[0].id, name: 'Uploaded.mp3', playlistId: linkedId
  });
  assert.equal(removeLast.status, 200, removeLast.text);
  assert.equal(removeLast.body.fileDeleted, true);
  assert.equal((await call(linkedTracks.body.files[0].streamUrl, 'GET', credentials.Owner[0])).status, 404);
  assert.equal((await call('/api/jobs/import/local')).status, 401);
  assert.equal((await call('/api/jobs/import/local', 'GET', credentials.Owner[0])).status, 403);
  assert.deepEqual((await call('/api/jobs/import/local', 'GET', credentials.Admin[0])).body, { xmlFiles: [], zipFiles: [] });
  await fs.mkdir(process.env.IMPORT_STORAGE_ROOT);
  const localXmlName = 'Library \u97f3\u697d.XML';
  const localZipName = 'iTunes media.ZIP';
  const localXmlPath = path.join(process.env.IMPORT_STORAGE_ROOT, localXmlName);
  const localZipPath = path.join(process.env.IMPORT_STORAGE_ROOT, localZipName);
  const originalZip = mediaZip.toBuffer();
  await fs.writeFile(localXmlPath, xml);
  await fs.writeFile(localZipPath, originalZip);
  await fs.writeFile(path.join(process.env.IMPORT_STORAGE_ROOT, 'ignored.txt'), 'not a library');
  await fs.mkdir(path.join(process.env.IMPORT_STORAGE_ROOT, 'folder.zip'));
  const localListing = await call('/api/jobs/import/local', 'GET', credentials.Admin[1]);
  assert.equal(localListing.status, 200);
  assert.deepEqual(localListing.body, { xmlFiles: [{ name: localXmlName, size: Buffer.byteLength(xml) }], zipFiles: [{ name: localZipName, size: originalZip.length }] });
  const localOptions = { mode: 'itunes', source: 'local', xmlName: localXmlName, zipName: localZipName, userId: users.Owner.id };
  assert.equal((await call('/api/jobs/import', 'POST', {}, localOptions)).status, 401);
  for (const headers of [...credentials.Owner, mobileHeaders.Owner]) {
    assert.equal((await call('/api/jobs/import/local', 'GET', headers)).status, 403);
    assert.equal((await call('/api/jobs/import/local', 'HEAD', headers)).status, 403);
    assert.equal((await call('/api/jobs/import?background=true', 'POST', headers, localOptions)).status, 403);
  }
  for (const zipName of ['../outside.zip', '..\\outside.zip', '/tmp/outside.zip', 'C:\\outside.zip', 'folder.zip', localXmlName]) {
    assert.equal((await call('/api/jobs/import', 'POST', credentials.Admin[0], { ...localOptions, zipName })).status, 400);
  }
  assert.equal((await call('/api/jobs/import', 'POST', credentials.Admin[0], { ...localOptions, xmlName: '' })).status, 400);
  const missingImport = await call('/api/jobs/import', 'POST', credentials.Admin[0], { ...localOptions, zipName: 'deleted.zip' });
  assert.equal(missingImport.status, 404);
  const failedLog = await call(`/api/jobs/import/logs/${missingImport.body.importId}`, 'GET', credentials.Admin[0]);
  assert.equal(failedLog.body.status, 'failed');
  assert.ok(failedLog.body.entries.some((entry) => entry.level === 'error' && entry.stage === 'receive'));
  assert.equal(failedLog.text.includes('stack'), false);
  assert.equal(failedLog.text.includes(directory.replaceAll('\\', '\\\\')), false);
  const localImportId = '12345678-1234-1234-1234-123456789abc';
  assert.equal((await call('/api/jobs/import?importId=invalid', 'POST', mobileHeaders.Admin, localOptions)).status, 400);
  const localImport = await call(`/api/jobs/import?importId=${localImportId}`, 'POST', mobileHeaders.Admin, localOptions);
  assert.equal(localImport.status, 201, localImport.text);
  assert.equal(localImport.body.importId, localImportId);
  const localLog = await call(`/api/jobs/import/logs/${localImportId}`, 'GET', mobileHeaders.Admin);
  assert.equal(localLog.body.entries[0].details.source, 'local');
  assert.ok(localLog.body.entries.some((entry) => entry.details.ownerId === users.Owner.id));
  assert.equal((await call(`/api/jobs/import/logs/${localImportId}`, 'GET', credentials.Owner[0])).status, 404);
  assert.equal((await call(`/api/jobs/import/logs/${missingImport.body.importId}`, 'GET', credentials.Admin[0])).status, 404);
  assert.equal(localImport.body.importedFiles, 1);
  assert.equal(localImport.body.jobs[0].initiatedBy.id, users.Owner.id);
  assert.equal(localImport.body.jobs[0].playlistTitle, 'iTunes favorites');
  assert.deepEqual((await call(`/api/jobs/${localImport.body.jobs[0].id}/stream/Uploaded.mp3`, 'GET', credentials.Owner[0])).buffer, importedAudio.buffer);
  const completedStorage = path.join(directory, 'import-storage-completed');
  assert.equal(await fs.readFile(path.join(completedStorage, localXmlName), 'utf8'), xml);
  assert.deepEqual(await fs.readFile(path.join(completedStorage, localZipName)), originalZip);
  assert.deepEqual((await call('/api/jobs/import/local', 'GET', credentials.Admin[0])).body, { xmlFiles: [], zipFiles: [] });
  const manyFiles = Array.from({ length: 1001 }, (_, index) => ({ ...uploadFile, name: `Track ${index}.wav` }));
  const boundaryUpload = await upload({ ...importOptions, mode: 'invalid', userId: users.Other.id }, manyFiles.slice(0, 1000), credentials.Admin[0]);
  assert.equal(boundaryUpload.status, 400, boundaryUpload.text);
  assert.match(boundaryUpload.body.error, /Choose files, or upload both/);
  const bulkImport = await upload({ ...importOptions, playlistTitle: 'Large import' }, manyFiles);
  assert.equal(bulkImport.status, 413, bulkImport.text);
  const oversizedXml = await upload({ mode: 'itunes' }, [{ ...itunesFiles[0], data: ' '.repeat(20 * 1024 ** 2 + 1) }, itunesFiles[1]]);
  assert.equal(oversizedXml.status, 413, oversizedXml.text);
  assert.equal((await upload(importOptions, [uploadFile])).status, 201);
  await fs.writeFile(localXmlPath, xml.replace('</plist>', `${' '.repeat(21 * 1024 ** 2)}</plist>`));
  await fs.writeFile(localZipPath, originalZip);
  const largeLocalImport = await call('/api/jobs/import?background=true', 'POST', credentials.Admin[0], localOptions);
  assert.equal(largeLocalImport.status, 202, largeLocalImport.text);
  assert.equal(largeLocalImport.body.status, 'running');
  const progressRoute = `/api/jobs/import/logs/${largeLocalImport.body.importId}`;
  assert.equal((await call(progressRoute, 'GET', credentials.Other[0])).status, 404);
  let progress;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call(progressRoute, 'GET', credentials.Admin[0]);
    assert.equal(response.status, 200, response.text);
    progress = response.body;
    if (progress.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(progress.status, 'completed');
  assert.equal(progress.result.importedFiles, 1);
  assert.equal(progress.result.jobs[0].playlistTitle, 'iTunes favorites');
  assert.deepEqual(Object.keys(progress.result.jobs[0]).sort(), ['id', 'playlistTitle']);
  await context.test('uploads pre-generate thumbnail files and administrators can rebuild all indexed songs', async () => {
    if (thumbnailBuffer) {
      const cacheRoot = path.join(directory, 'data', 'artwork-thumbnails');
      const beforeCache = (await fs.readdir(cacheRoot, { recursive: true })).sort();
      const database = openDatabase();
      await database.exec(`CREATE FUNCTION fail_thumbnail_import() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Injected import database failure'; END $$;
        CREATE CONSTRAINT TRIGGER fail_thumbnail_import AFTER INSERT ON jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.data->>'playlistTitle' = 'Reject thumbnail import') EXECUTE FUNCTION fail_thumbnail_import()`);
      try {
        const rejected = await upload({ ...importOptions, playlistTitle: 'Reject thumbnail import' },
          [{ ...uploadFile, name: 'Cover.mp3', data: NodeID3.update({
            image: { mime: 'image/png', type: { id: 3 }, imageBuffer: artworkBuffer }
          }, importedAudio.buffer) }]);
        assert.equal(rejected.status, 500);
        assert.deepEqual((await fs.readdir(cacheRoot, { recursive: true })).sort(), beforeCache,
          'failed imports do not leave thumbnail caches behind');
      } finally {
        await database.exec('DROP TRIGGER fail_thumbnail_import ON jobs; DROP FUNCTION fail_thumbnail_import()');
      }
      const uploaded = await upload({ ...importOptions, playlistTitle: 'Thumbnail upload' },
        [{ ...uploadFile, name: 'Cover.mp3', data: NodeID3.update({
          image: { mime: 'image/png', type: { id: 3 }, imageBuffer: artworkBuffer }
        }, importedAudio.buffer) }]);
      assert.equal(uploaded.status, 201, uploaded.text);
      const uploadedJob = (await call(`/api/jobs/${uploaded.body.jobs[0].id}`, 'GET', credentials.Owner[0])).body;
      assert.deepEqual(await cachedThumbnails(path.join(uploadedJob.outputDir, 'Cover.mp3')), [thumbnailBuffer]);
    }
    await fs.rm(path.join(directory, 'data', 'artwork-thumbnails'), { recursive: true, force: true });
    const initial = await call('/api/admin/artwork-thumbnails', 'GET', credentials.Admin[0]);
    assert.equal(initial.status, 200);
    assert.equal(initial.headers['cache-control'], 'no-store');
    assert.equal(initial.body.running, false);
    const started = await call('/api/admin/artwork-thumbnails', 'POST', credentials.Admin[1]);
    assert.equal(started.status, 202);
    let state = started.body;
    while (state.running) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await call('/api/admin/artwork-thumbnails', 'GET', credentials.Admin[1]);
      assert.equal(status.status, 200);
      state = status.body;
    }
    assert.ok(state.processed > 0);
    assert.equal(state.processed, state.generated + state.missing + state.failed);
    assert.equal(state.failed, 0);
    assert.ok(state.completedAt);
    if (thumbnailBuffer) assert.ok(state.generated > 0);
    assert.ok((await fs.readdir(path.join(directory, 'data', 'artwork-thumbnails'))).length > 0);
  });
  await context.test('artwork requests have a separate limit and cannot exhaust playback or library access', async () => {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
    await startServer();
    const missingCover = '/api/jobs/missing/artwork/missing.mp3';
    for (let index = 0; index < 600; index++) {
      assert.equal((await call(missingCover, 'GET', credentials.Owner[0])).status, 404);
    }
    assert.equal((await call(missingCover, 'GET', credentials.Owner[0])).status, 429);
    assert.equal((await call(missingCover, 'HEAD', credentials.Owner[0])).status, 429);
    assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).status, 200);
    const stream = await call(`/api/jobs/${localImport.body.jobs[0].id}/stream/Uploaded.mp3`, 'GET',
      { ...credentials.Owner[0], Range: 'bytes=0-1' });
    assert.equal(stream.status, 206);
  });
});