import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import * as plist from 'plist';
import { fileTypeFromFile } from 'file-type';
import { audioExtensions, isPlayableFile, mediaAccept, mediaType, videoExtensions } from '../src/media.js';
import { isSongFile } from '../src/transcription.js';
import { getPlaylistTracks, songKey } from '../src/library.js';
import { createTestDatabase } from '../test-support/postgres.js';

test('playable media distinguishes movies from audio and non-media filenames', () => {
  for (const extension of videoExtensions) {
    assert.equal(mediaType(`Movies/Clip${extension.toUpperCase()}`), 'video');
    assert.equal(isPlayableFile(`Clip${extension}`), true);
  }
  assert.ok(audioExtensions.includes('.mp2'));
  assert.ok(mediaAccept.split(',').includes('.mp2'));
  for (const extension of audioExtensions) {
    for (const name of [`Music/Song${extension}`, `[NoVocals]/Song${extension.toUpperCase()}`]) {
      assert.equal(mediaType(name), 'audio');
      assert.equal(isPlayableFile(name), true);
      assert.equal(isSongFile(name), true);
    }
  }
  for (const name of ['mp4', '.mp4', '.mp2', 'song.mp2.txt', 'movie.mp4.txt', 'playlist.xml', 'movie.avi', undefined]) {
    assert.equal(isPlayableFile(name), false);
    assert.equal(isSongFile(name), false);
  }
});

test('music imports validate media, preserve playlists and enforce ownership', async (context) => {
  const { directory } = await createTestDatabase(context);
  process.env.YTDLP_OUTPUT_ROOT = path.join(directory, 'output');
  const imports = await import('../src/libraryImport.js');
  const manager = await import('../src/jobManager.js');
  const { getLibrary, linkLibraryJob } = await import('../src/libraryStore.js');
  const { registerUser } = await import('../src/authStore.js');
  const owner = await registerUser('Owner', 'Owner', { id: 'owner', publicKey: Buffer.from('owner'), counter: 0 });
  async function countUpload(fieldname, megabytes, extraBytes = 0, request = { importBytes: 0 }) {
    const chunk = Buffer.alloc(1024 ** 2);
    function* chunks() {
      for (let index = 0; index < megabytes; index++) yield chunk;
      if (extraBytes) yield Buffer.alloc(extraBytes);
    }
    await pipeline(Readable.from(chunks()), imports.createImportUploadCounter(request, fieldname),
      new Writable({ write(_chunk, _encoding, done) { done(); } }));
  }
  for (const [fieldname, megabytes] of [['xml', 20], ['files', 512], ['media', 2048]]) {
    await countUpload(fieldname, megabytes);
    await assert.rejects(countUpload(fieldname, megabytes, 1), { statusCode: 413 });
  }
  const aggregate = { importBytes: 2 * 1024 ** 3 - 1 };
  await countUpload('files', 0, 1, aggregate);
  await assert.rejects(countUpload('media', 0, 1, aggregate), { statusCode: 413 });
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
  const file = { name: 'Song.wav', path: path.join(directory, 'audio'), size: audio.length };
  await fs.writeFile(file.path, audio);

  await context.test('unrecognized audio is probed with bounded, format-matched validation', async (probeContext) => {
    const frame = Buffer.alloc(417);
    Buffer.from('fffb9000', 'hex').copy(frame);
    const frames = Buffer.concat(Array.from({ length: 20 }, () => frame));
    const padded = Buffer.concat([Buffer.alloc(4096), frames]);
    const mp3 = { name: 'Padded.mp3', path: path.join(directory, 'padded-mp3') };
    await fs.writeFile(mp3.path, padded);
    const audioStream = { index: 0, codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 };
    let metadata = { format: { format_name: 'mp3' }, streams: [audioStream] };
    let probeError;
    const probe = probeContext.mock.method(childProcess, 'execFile', (executable, args, options, done) => {
      assert.equal(path.basename(executable), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      assert.equal(args.at(-1), mp3.path);
      assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
      assert.equal(args[args.indexOf('-format_whitelist') + 1], 'mp3,wav,flac,mov,aac,ogg,asf');
      assert.equal(options.timeout, 15000);
      assert.equal(options.maxBuffer, 64 * 1024);
      done(probeError, JSON.stringify(metadata));
    });
    const validated = await imports.validateImportAudio(mp3);
    assert.equal(validated.size, padded.length);
    assert.equal(probe.mock.callCount(), 1);
    await imports.validateImportAudio(file);
    await assert.rejects(imports.validateImportAudio({ ...file, name: 'wrong.mp3' }), /detected WAV, expected MP3/);
    assert.equal(probe.mock.callCount(), 1);

    for (const frames of [undefined, [], [{ media_type: 'audio', stream_index: 0, nb_samples: 0 }],
      [{ media_type: 'video', stream_index: 0, nb_samples: 1024 }], [{ media_type: 'audio', stream_index: 1, nb_samples: 1024 }]]) {
      metadata.frames = frames;
      await assert.rejects(imports.validateImportAudio(mp3, { requireProbe: true }), /ffprobe could not confirm MP3 audio/);
    }
    metadata.frames = [{ media_type: 'audio', stream_index: 0, nb_samples: 1024 }];
    assert.equal((await imports.validateImportAudio(mp3, { requireProbe: true })).size, padded.length);
    const strictArguments = probe.mock.calls.at(-1).arguments[1];
    assert.equal(strictArguments[strictArguments.indexOf('-read_intervals') + 1], '%+#64');
    assert.ok(strictArguments.includes('-show_frames'));
    assert.match(strictArguments[strictArguments.indexOf('-show_entries') + 1], /frame=media_type,stream_index,nb_samples/);
    delete metadata.frames;
    assert.equal((await imports.validateImportAudio(mp3)).size, padded.length);
    assert.ok(!probe.mock.calls.at(-1).arguments[1].includes('-show_frames'));

    metadata.streams.push({ codec_type: 'video', disposition: { attached_pic: 1 } });
    assert.equal((await imports.validateImportAudio(mp3)).size, padded.length);
    for (const invalid of [
      { format: { format_name: 'wav' }, streams: [audioStream] },
      { format: { format_name: 'mp3' }, streams: [] },
      { format: { format_name: 'mp3' }, streams: [{ ...audioStream, codec_name: 'mp2' }] },
      { format: { format_name: 'mp3' }, streams: [{ ...audioStream, sample_rate: '0' }] },
      { format: { format_name: 'mp3' }, streams: [audioStream, { codec_type: 'video' }] }
    ]) {
      metadata = invalid;
      await assert.rejects(imports.validateImportAudio(mp3), /ffprobe could not confirm MP3 audio/);
    }
    probeError = Object.assign(new Error('Probe failed'), { killed: true });
    await assert.rejects(imports.validateImportAudio(mp3), { statusCode: 400 });
    probeError = Object.assign(new Error('Missing executable'), { code: 'ENOENT' });
    await assert.rejects(imports.validateImportAudio(mp3), { statusCode: 400, message: /ffprobe is unavailable/ });
    await fs.writeFile(mp3.path, Buffer.alloc(0));
    await assert.rejects(imports.validateImportAudio(mp3), /Empty audio file/);
  });

  const result = await imports.importUploadedFiles([file], { createNew: 'true', playlistTitle: 'Local music' }, owner);
  const job = result.jobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.source, 'files');
  assert.equal((await getLibrary(owner.id, (await manager.getJobs()))).entries[0].id, job.id);
  assert.deepEqual(await fs.readFile(path.join(job.outputDir, job.files[0])), audio);
  await assert.rejects(imports.importUploadedFiles([file], { createNew: 'false', playlistId: job.id }, { id: 'other' }), /existing playlists/);
  await assert.rejects(manager.importJobFiles({ files: [file], playlistId: job.id }, { id: 'other' }), { statusCode: 403 });
  const appended = await imports.importUploadedFiles([file], { createNew: 'false', playlistId: job.id }, owner);
  assert.deepEqual(appended.jobs[0].files, ['Song.wav', 'Song (2).wav']);
  await assert.rejects(manager.rerunJob(job.id, owner), /cannot be rerun/);
  await assert.rejects(imports.importUploadedFiles([file], { createNew: 'true', playlistTitle: ' ' }, owner), /Playlist name/);
  await assert.rejects(imports.importUploadedFiles([{ ...file, name: 'wrong.mp3' }], { createNew: 'true', playlistTitle: 'Invalid' }, owner), /mismatched audio/);
  await assert.rejects(imports.importUploadedFiles([], { createNew: 'true', playlistTitle: 'Empty' }, owner), /Select audio/);
  await assert.rejects(manager.importJobFiles({ files: [file, { name: 'Missing.wav', path: path.join(directory, 'missing') }], playlistId: job.id }, owner));
  assert.deepEqual((await fs.readdir(job.outputDir)).sort(), ['Song (2).wav', 'Song.wav']);
  const single = await manager.importJobFiles({ files: [file], playlistTitle: 'Single', individual: true }, owner);
  (await linkLibraryJob(owner.id, single, (await manager.getJobs())));
  const singles = await imports.importUploadedFiles([file], { createNew: 'false', playlistId: 'individual-songs' }, owner);
  assert.ok((await getLibrary(owner.id, (await manager.getJobs()))).singleJobIds.includes(singles.jobs[0].id));

  await context.test('real FFmpeg preserves MP2 and MP3 audio and converts detected WAVs in iTunes imports', async (probeContext) => {
    const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
    const bin = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? path.dirname(location) : location;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const ffmpeg = path.join(bin, `ffmpeg${suffix}`);
    try {
      await fs.access(ffmpeg);
      await fs.access(path.join(bin, `ffprobe${suffix}`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      probeContext.skip('FFmpeg runtime is not installed');
      return;
    }
    const mp3Path = path.join(directory, 'generated.mp3');
    await promisify(childProcess.execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '0.2', '-c:a', 'libmp3lame', '-id3v2_version', '0', '-write_xing', '0', mp3Path], { timeout: 15000 });
    const mp2Path = path.join(directory, 'generated.mp2');
    await promisify(childProcess.execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '0.2', '-c:a', 'mp2', '-b:a', '192k', mp2Path], { timeout: 15000 });
    const mp2Bytes = await fs.readFile(mp2Path);
    const mp2File = { name: 'Layer II.MP2', path: mp2Path };
    assert.equal((await imports.validateImportAudio(mp2File)).size, mp2Bytes.length);
    assert.equal((await imports.validateImportAudio(mp2File, { requireProbe: true })).size, mp2Bytes.length);
    await assert.rejects(imports.validateImportAudio({ name: 'Renamed.mp2', path: mp3Path }), /expected MP2/);
    await assert.rejects(imports.validateImportAudio({ name: 'Renamed.mp3', path: mp2Path }), /expected MP3/);
    const mp2Upload = await imports.importUploadedFiles([mp2File], { createNew: 'true', playlistTitle: 'MPEG Layer II' }, owner);
    assert.deepEqual(mp2Upload.jobs[0].files, ['Layer II.mp2']);
    assert.equal(mp2Upload.jobs[0].playlistSongCount, 1);
    assert.deepEqual(await fs.readFile(path.join(mp2Upload.jobs[0].outputDir, 'Layer II.mp2')), mp2Bytes);
    const paddedMp2 = Buffer.concat([Buffer.alloc(4096), mp2Bytes]);
    await fs.writeFile(mp2Path, paddedMp2);
    assert.equal((await imports.validateImportAudio(mp2File, { requireProbe: true })).size, paddedMp2.length);
    const mp2Zip = new AdmZip();
    mp2Zip.addFile('Music/Layer II.mp2', paddedMp2);
    const mp2ZipPath = path.join(directory, 'mp2.zip');
    await fs.writeFile(mp2ZipPath, mp2Zip.toBuffer());
    const mp2Media = await imports.extractImportMedia(mp2ZipPath, directory);
    const mp2Xml = plist.build({ Tracks: { 1: { 'Track ID': 1, Location: 'file:///Music/Layer%20II.mp2' } } });
    const mp2Itunes = await imports.importItunesLibrary(mp2Xml, mp2Media, owner);
    assert.equal(mp2Itunes.importedFiles, 1);
    assert.deepEqual(await fs.readFile(path.join(mp2Itunes.jobs[0].outputDir, mp2Itunes.jobs[0].files[0])), paddedMp2);
    const mislabeledZip = new AdmZip();
    mislabeledZip.addFile('Music/Single.MP3', mp2Bytes);
    mislabeledZip.addFile('Music/Single.mp2', paddedMp2);
    mislabeledZip.addFile('Music/Padded.mp3', paddedMp2);
    const mislabeledZipPath = path.join(directory, 'mislabeled-mp2.zip');
    await fs.writeFile(mislabeledZipPath, mislabeledZip.toBuffer());
    const correctionLogs = [];
    const mislabeledMedia = await imports.extractImportMedia(mislabeledZipPath, directory, {
      report: (stage, message, details) => correctionLogs.push({ stage, message, ...details })
    });
    const mislabeledXml = plist.build({ Tracks: {
      1: { 'Track ID': 1, Location: 'file:///Music/Single.MP3' },
      2: { 'Track ID': 2, Location: 'file:///Music/Single.mp2' },
      3: { 'Track ID': 3, Location: 'file:///Music/Padded.mp3' }
    }, Playlists: [
      { Name: 'Corrected MP2', 'Playlist Items': [{ 'Track ID': 1 }, { 'Track ID': 2 }, { 'Track ID': 3 }] },
      { Name: 'Linked MP2', 'Playlist Items': [{ 'Track ID': 1 }] }
    ] });
    const correctedMp2 = await imports.importItunesLibrary(mislabeledXml, mislabeledMedia, owner);
    assert.equal(correctedMp2.importedFiles, 3);
    assert.deepEqual(correctedMp2.jobs[0].files, ['Single.mp2', 'Single (2).mp2', 'Padded.mp2']);
    assert.deepEqual(correctedMp2.jobs[1].files, []);
    assert.deepEqual(await fs.readFile(path.join(correctedMp2.jobs[0].outputDir, 'Single.mp2')), mp2Bytes);
    assert.deepEqual(await fs.readFile(path.join(correctedMp2.jobs[0].outputDir, 'Padded.mp2')), paddedMp2);
    const correctedJobs = await manager.getJobs();
    const correctedLibrary = await getLibrary(owner.id, correctedJobs);
    assert.deepEqual(getPlaylistTracks(correctedLibrary, correctedJobs).get(correctedMp2.jobs[1].id),
      [{ jobId: correctedMp2.jobs[0].id, name: 'Single.mp2', playlistId: correctedMp2.jobs[1].id }]);
    assert.equal(correctionLogs.filter((entry) => entry.message === 'Corrected MP2 audio with an MP3 filename').length, 2);
    assert.deepEqual(new AdmZip(mislabeledZipPath).readFile('Music/Single.MP3'), mp2Bytes);
    const padded = Buffer.concat([Buffer.alloc(4096), await fs.readFile(mp3Path)]);
    await fs.writeFile(mp3Path, padded);
    assert.equal(await fileTypeFromFile(mp3Path), undefined);
    assert.equal((await imports.validateImportAudio({ name: 'Padded.mp3', path: mp3Path })).size, padded.length);
    const zip = new AdmZip();
    zip.addFile('Music/Padded.mp3', padded);
    const zipPath = path.join(directory, 'padded.zip');
    await fs.writeFile(zipPath, zip.toBuffer());
    const media = await imports.extractImportMedia(zipPath, directory);
    const xml = plist.build({ Tracks: { 1: { 'Track ID': 1, Location: 'file:///Music/Padded.mp3' } } });
    const result = await imports.importItunesLibrary(xml, media, owner);
    assert.equal(result.importedFiles, 1);
    assert.deepEqual(await fs.readFile(path.join(result.jobs[0].outputDir, result.jobs[0].files[0])), padded);
    const wavPath = path.join(directory, 'generated.wav');
    await promisify(childProcess.execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '0.2', '-metadata', 'title=Imported WAV', wavPath], { timeout: 15000 });
    const wav = await fs.readFile(wavPath);
    zip.addFile('Music/Converted.wav', wav);
    zip.addFile('Music/Mislabeled.mp3', wav);
    zip.addFile('Music/Converted.mp3', padded);
    await fs.writeFile(zipPath, zip.toBuffer());
    const conversionLogs = [];
    const report = (stage, message, details) => conversionLogs.push({ stage, message, ...details });
    const wavXml = plist.build({ Tracks: {
      1: { 'Track ID': 1, Location: 'file:///Music/Converted.wav' },
      2: { 'Track ID': 2, Location: 'file:///Music/Mislabeled.mp3' },
      3: { 'Track ID': 3, Location: 'file:///Music/Padded.mp3' },
      4: { 'Track ID': 4, Location: 'file:///Music/Converted.mp3' }
    }, Playlists: [
      { Name: 'Converted', 'Playlist Items': [{ 'Track ID': 1 }, { 'Track ID': 2 }, { 'Track ID': 3 }, { 'Track ID': 4 }] },
      { Name: 'Shared', 'Playlist Items': [{ 'Track ID': 1 }] }
    ] });
    const wavMedia = await imports.extractImportMedia(zipPath, directory, { report });
    const beforeConversion = (await fs.readdir(directory)).sort();
    const converted = await imports.importItunesLibrary(wavXml, wavMedia, owner, { report });
    assert.equal(converted.importedFiles, 4);
    assert.deepEqual(converted.jobs[0].files, ['Converted.mp3', 'Mislabeled.mp3', 'Padded.mp3', 'Converted (2).mp3']);
    assert.deepEqual(converted.jobs[1].files, []);
    assert.equal(converted.jobs[1].playlistSongCount, 1);
    const convertedLibrary = (await getLibrary(owner.id, (await manager.getJobs())));
    assert.deepEqual(getPlaylistTracks(convertedLibrary, (await manager.getJobs())).get(converted.jobs[1].id),
      [{ jobId: converted.jobs[0].id, name: 'Converted.mp3', playlistId: converted.jobs[1].id }]);
    assert.deepEqual((await getLibrary(owner.id, (await manager.getJobs()))).songOrder[converted.jobs[0].id], converted.jobs[0].files);
    for (const name of ['Converted.mp3', 'Mislabeled.mp3']) {
      const output = path.join(converted.jobs[0].outputDir, name);
      assert.equal((await fileTypeFromFile(output)).ext, 'mp3');
      const { stdout } = await promisify(childProcess.execFile)(path.join(bin, `ffprobe${suffix}`),
        ['-v', 'error', '-show_entries', 'stream=codec_name:format_tags=title', '-of', 'json', output]);
      const metadata = JSON.parse(stdout);
      assert.equal(metadata.streams[0].codec_name, 'mp3');
      assert.equal(metadata.format.tags.title, 'Imported WAV');
    }
    assert.deepEqual(await fs.readFile(path.join(converted.jobs[0].outputDir, 'Padded.mp3')), padded);
    assert.deepEqual(await fs.readFile(path.join(converted.jobs[0].outputDir, 'Converted (2).mp3')), padded);
    assert.deepEqual((await fs.readdir(directory)).sort(), beforeConversion);
    assert.deepEqual(new AdmZip(zipPath).readFile('Music/Converted.wav'), wav);
    assert.equal(conversionLogs.filter((entry) => entry.message === 'WAV converted to MP3').length, 2);
    await fs.writeFile(mp3Path, 'This is not an audio file.');
    await assert.rejects(imports.validateImportAudio({ name: 'Invalid.mp3', path: mp3Path }), /ffprobe could not confirm MP3 audio/);
  });

  const encodedAudio = Buffer.alloc(417 * 20);
  for (let offset = 0; offset < encodedAudio.length; offset += 417) encodedAudio.writeUInt32BE(0xfffb9000, offset);
  const execFile = childProcess.execFile;
  const encoder = context.mock.method(childProcess, 'execFile', (executable, args, options, done) => {
    if (!/^ffmpeg(?:\.exe)?$/i.test(path.basename(executable))) return execFile(executable, args, options, done);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-format_whitelist') + 1], 'wav');
    assert.equal(args[args.indexOf('-c:a') + 1], 'libmp3lame');
    assert.equal(options.timeout, 5 * 60 * 1000);
    fs.writeFile(args.at(-1), encodedAudio).then(() => done(null), done);
  });

  const movie = { name: 'Movie.MP4', path: path.join(directory, 'movie') };
  const video = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  await fs.writeFile(movie.path, video);
  const movies = await imports.importUploadedFiles([movie], { createNew: 'true', playlistTitle: 'Movies' }, owner);
  assert.deepEqual(movies.jobs[0].files, ['Movie.mp4']);
  assert.equal(movies.jobs[0].playlistSongCount, 1);
  const singleVideo = await manager.importJobFiles({ files: [movie], playlistTitle: 'Single video', individual: true, downloadType: 'video' }, owner);
  await linkLibraryJob(owner.id, singleVideo, await manager.getJobs());
  const importedVideo = await imports.importUploadedFiles([movie], { createNew: 'false', playlistId: 'individual-videos' }, owner);
  assert.equal(importedVideo.jobs[0].downloadType, 'video');
  const videoJobs = await manager.getJobs();
  const videoTracks = getPlaylistTracks(await getLibrary(owner.id, videoJobs), videoJobs);
  assert.equal(videoTracks.get('individual-videos').some((track) => track.jobId === importedVideo.jobs[0].id), true);
  assert.equal(videoTracks.get('individual-songs').some((track) => track.jobId === importedVideo.jobs[0].id), false);
  const mixed = await imports.importUploadedFiles([movie], { createNew: 'false', playlistId: job.id }, owner);
  assert.deepEqual(mixed.jobs[0].files, ['Song.wav', 'Song (2).wav', 'Movie.mp4']);
  assert.equal(mixed.jobs[0].playlistSongCount, 3);
  assert.deepEqual(await fs.readFile(path.join(job.outputDir, 'Movie.mp4')), video);
  await assert.rejects(imports.validateImportMedia({ ...file, name: 'fake.mp4' }), /mismatched video/);
  await assert.rejects(imports.validateImportMedia({ ...movie, name: 'fake.webm' }), /mismatched video/);
  await assert.rejects(imports.validateImportAudio(movie), /Unsupported audio/);
  await assert.rejects(manager.transcribeJobFile(job.id, 'Movie.mp4', {}, owner), { statusCode: 400 });

  const zip = new AdmZip();
  zip.addFile('Media/Artist/Album/Song.wav', audio);
  zip.addFile('Media/Artist/Album/Second.wav', audio);
  zip.addFile('Library.xml', Buffer.from('ignored'));
  const zipPath = path.join(directory, 'media.zip');
  await fs.writeFile(zipPath, zip.toBuffer());
  const logs = [];
  const report = (stage, message, details = {}, level = 'info') => logs.push({ stage, message, ...details, level });
  const media = await imports.extractImportMedia(zipPath, directory, { report });
  assert.equal(media.length, 2);
  assert.ok(logs.some((entry) => entry.message === 'Extracting media ZIP'));
  assert.ok(logs.some((entry) => entry.message === 'Media ZIP extracted' && entry.files === 2 && entry.skipped === 1));
  const document = { Tracks: {
    1: { 'Track ID': 1, Name: 'Song', Location: 'file://localhost/C:/Music/Artist/Album/Song.wav' },
    2: { 'Track ID': 2, Name: 'Second', Location: 'file:///Users/me/Music/Artist/Album/Second.wav' }
  }, Playlists: [
    { Name: 'Library', Master: true, 'Playlist Items': [{ 'Track ID': 1 }, { 'Track ID': 2 }] },
    { Name: 'Favorites', 'Playlist Items': [{ 'Track ID': 2 }, { 'Track ID': 1 }] },
    { Name: 'Shared song', 'Playlist Items': [{ 'Track ID': 1 }] }
  ] };
  const xml = plist.build(document);
  const storage = path.join(directory, 'import-storage');
  process.env.IMPORT_STORAGE_ROOT = storage;
  assert.deepEqual(await imports.listLocalImportFiles(), { xmlFiles: [], zipFiles: [] });
  await fs.mkdir(storage);
  await fs.writeFile(path.join(storage, 'Library.XML'), xml);
  await fs.copyFile(zipPath, path.join(storage, 'Media.zip'));
  await fs.writeFile(path.join(storage, 'ignored.txt'), 'ignored');
  await fs.mkdir(path.join(storage, 'folder.zip'));
  const localFiles = await imports.listLocalImportFiles();
  assert.deepEqual(localFiles.xmlFiles.map((item) => item.name), ['Library.XML']);
  assert.deepEqual(localFiles.zipFiles.map((item) => item.name), ['Media.zip']);
  assert.equal(localFiles.xmlFiles[0].size, Buffer.byteLength(xml));
  assert.equal((await imports.resolveLocalImportFile('Media.zip', '.zip')).path, path.join(await fs.realpath(storage), 'Media.zip'));
  for (const name of ['../media.zip', '..\\media.zip', '/media.zip', 'C:\\media.zip', 'Media.zip:stream', 'Library.XML', 'folder.zip']) {
    await assert.rejects(imports.resolveLocalImportFile(name, '.zip'), { statusCode: 400 });
  }
  await assert.rejects(imports.resolveLocalImportFile('missing.zip', '.zip'), { statusCode: 404 });
  const originalLstat = fs.lstat;
  const symlinkMock = context.mock.method(fs, 'lstat', async (...args) => {
    const stat = await originalLstat(...args);
    stat.isSymbolicLink = () => true;
    return stat;
  });
  try { await assert.rejects(imports.resolveLocalImportFile('Media.zip', '.zip'), { statusCode: 400 }); }
  finally { symlinkMock.mock.restore(); }
  const plans = imports.parseItunesImport(xml, media);
  assert.deepEqual(plans.map((plan) => plan.playlistTitle), ['Favorites', 'Shared song']);
  assert.deepEqual(plans[0].files.map((track) => track.name), ['Second.wav', 'Song.wav']);
  const largeXml = xml.replace('</plist>', `${' '.repeat(21 * 1024 ** 2)}</plist>`);
  assert.throws(() => imports.parseItunesImport(largeXml, media), { statusCode: 413 });
  assert.deepEqual(imports.parseItunesImport(largeXml, media, { local: true }), plans);
  const largeMedia = media.map((track) => ({ ...track, size: 5 * 1024 ** 3 }));
  assert.throws(() => imports.parseItunesImport(xml, largeMedia), { statusCode: 413 });
  assert.equal(imports.parseItunesImport(xml, largeMedia, { local: true }).length, 2);
  assert.equal(imports.parseItunesImport(xml, media.map((track) => ({ ...track, size: 1.5 * 1024 ** 3 }))).length, 2);
  const manyTracks = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [index + 1,
    { 'Track ID': index + 1, Location: document.Tracks[1].Location }]));
  const manyPlaylists = Array.from({ length: 501 }, (_, index) => ({ Name: `Playlist ${index}`, 'Playlist Items': [{ 'Track ID': index + 1 }] }));
  const manyTracksXml = plist.build({ Tracks: manyTracks, Playlists: manyPlaylists });
  assert.throws(() => imports.parseItunesImport(manyTracksXml, media), { statusCode: 413 });
  const repeatedPlaylistsXml = plist.build({ Tracks: document.Tracks,
    Playlists: Array.from({ length: 501 }, () => document.Playlists[1]) });
  assert.throws(() => imports.parseItunesImport(repeatedPlaylistsXml, media), { statusCode: 413 });
  assert.equal(imports.parseItunesImport(repeatedPlaylistsXml, media, { local: true }).length, 501);
  const largePlans = imports.parseItunesImport(manyTracksXml, media, { local: true });
  assert.equal(largePlans.length, 502);
  assert.equal(largePlans.reduce((total, plan) => total + plan.files.length, 0), 2001);
  const originalStat = fs.stat;
  const statMock = context.mock.method(fs, 'stat', async (...args) => {
    const stat = await originalStat(...args);
    if (args[0] === file.path) stat.size = 3 * 1024 ** 3;
    return stat;
  });
  try {
    await assert.rejects(imports.validateImportAudio(file), { statusCode: 413 });
    assert.equal((await imports.validateImportAudio(file, { local: true })).size, 3 * 1024 ** 3);
  }
  finally { statMock.mock.restore(); }
  const imported = await imports.importItunesLibrary(xml, media, owner, { report });
  assert.equal(imported.importedFiles, 2);
  assert.equal(encoder.mock.callCount(), 2);
  assert.equal(imported.jobs[0].source, 'itunes');
  assert.deepEqual((await getLibrary(owner.id, (await manager.getJobs()))).songOrder[imported.jobs[0].id], ['Second.mp3', 'Song.mp3']);
  assert.deepEqual(imported.jobs[1].files, []);
  assert.deepEqual(await fs.readdir(imported.jobs[1].outputDir), []);
  assert.equal(imported.jobs[1].playlistSongCount, 1);
  const importedLibrary = (await getLibrary(owner.id, (await manager.getJobs())));
  assert.deepEqual(getPlaylistTracks(importedLibrary, (await manager.getJobs())).get(imported.jobs[1].id),
    [{ jobId: imported.jobs[0].id, name: 'Song.mp3', playlistId: imported.jobs[1].id }]);
  assert.deepEqual(importedLibrary.playlistSongOrder[imported.jobs[1].id],
    [songKey({ jobId: imported.jobs[0].id, name: 'Song.mp3' })]);
  assert.equal(logs.filter((entry) => entry.message === 'Playlist imported').length, 2);
  assert.ok(logs.some((entry) => entry.message === 'Library tracks matched' && entry.matched === 2));
  assert.equal(logs.at(-1).stage, 'save');

  await context.test('linked iTunes imports preserve mixed order, collisions, distinct files and unique export media', async (linkedContext) => {
    const sourceFiles = [
      { name: 'Music/First/Song.mp3', path: path.join(directory, 'first-shared'), size: encodedAudio.length },
      { name: 'Music/Second/Song.mp3', path: path.join(directory, 'second-shared'), size: encodedAudio.length },
      { name: 'Music/Movie.mp4', path: movie.path, size: video.length },
      { name: 'Music/Unused.mp3', path: path.join(directory, 'unassigned'), size: encodedAudio.length }
    ];
    for (const source of sourceFiles.filter((source) => source.path !== movie.path)) await fs.writeFile(source.path, encodedAudio);
    const sharedXml = plist.build({ Tracks: {
      1: { 'Track ID': 1, Location: 'file:///Music/First/Song.mp3' },
      2: { 'Track ID': 2, Location: 'file:///Music/Second/Song.mp3' },
      3: { 'Track ID': 3, Location: 'file:///Music/First/Song.mp3' },
      4: { 'Track ID': 4, Location: 'file:///Music/Movie.mp4' },
      5: { 'Track ID': 5, Location: 'file:///Music/Unused.mp3' }
    }, Playlists: [
      { Name: 'Sources', 'Playlist Items': [{ 'Track ID': 1 }, { 'Track ID': 2 }] },
      { Name: 'Mixed', 'Playlist Items': [{ 'Track ID': 4 }, { 'Track ID': 2 }, { 'Track ID': 1 }] },
      { Name: 'Links only', 'Playlist Items': [{ 'Track ID': 2 }, { 'Track ID': 1 }, { 'Track ID': 3 }] }
    ] });
    const shared = await imports.importItunesLibrary(sharedXml, sourceFiles, owner);
    const [source, mixed, linked, remaining] = shared.jobs;
    assert.equal(shared.importedFiles, 4);
    assert.deepEqual(shared.jobs.map((job) => job.files), [['Song.mp3', 'Song (2).mp3'], ['Movie.mp4'], [], ['Unused.mp3']]);
    assert.deepEqual(shared.jobs.map((job) => job.playlistSongCount), [2, 3, 2, 1]);
    assert.equal(remaining.playlistTitle, 'iTunes Library');
    const saved = (await getLibrary(owner.id, (await manager.getJobs())));
    const tracks = getPlaylistTracks(saved, (await manager.getJobs()));
    const firstSong = songKey({ jobId: source.id, name: 'Song.mp3' });
    const secondSong = songKey({ jobId: source.id, name: 'Song (2).mp3' });
    assert.deepEqual(tracks.get(mixed.id).map(songKey), [songKey({ jobId: mixed.id, name: 'Movie.mp4' }), secondSong, firstSong]);
    assert.deepEqual(tracks.get(linked.id).map(songKey), [secondSong, firstSong]);
    assert.deepEqual(saved.playlistSongOrder[linked.id], [secondSong, firstSong]);
    const { prepareLibraryExport, exportOptions } = await import('../src/libraryExport.js');
    const ids = new Set(shared.jobs.map((job) => job.id));
    const exported = await prepareLibraryExport({ ...saved, entries: saved.entries.filter((entry) => ids.has(entry.id)) },
      shared.jobs, exportOptions('android'));
    assert.equal(exported.files.length, 3);
    const linkedPlaylist = exported.documents.find((document) => document.content.includes('#PLAYLIST:Links only\n'));
    const exportedPaths = linkedPlaylist.content.split('\n').filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(exportedPaths, ['Song (2).mp3', 'Song.mp3'].map((name) =>
      exported.files.find((file) => file.filePath === path.join(source.outputDir, name)).archivePath));
    assert.deepEqual((await getLibrary(owner.id, (await manager.getJobs()))).songAdds, saved.songAdds);
    for (const failureStage of ['copy', 'complete']) {
      await linkedContext.test(`failed ${failureStage} rolls back files and links`, async (rollback) => {
        const beforeJobs = (await manager.getJobs()).map((job) => job.id).sort();
        const beforeFolders = (await fs.readdir(process.env.YTDLP_OUTPUT_ROOT)).sort();
        const beforeLibrary = (await getLibrary(owner.id, (await manager.getJobs())));
        const copyFile = fs.copyFile;
        if (failureStage === 'copy') rollback.mock.method(fs, 'copyFile', async (...args) => {
          if (args[0] === movie.path) throw new Error('Copy failed');
          return copyFile(...args);
        });
        await assert.rejects(imports.importItunesLibrary(sharedXml, sourceFiles, owner, {
          complete: async () => { throw new Error('Archive failed'); }
        }), failureStage === 'copy' ? /Copy failed/ : /Archive failed/);
        assert.deepEqual((await manager.getJobs()).map((job) => job.id).sort(), beforeJobs);
        assert.deepEqual((await fs.readdir(process.env.YTDLP_OUTPUT_ROOT)).sort(), beforeFolders);
        const afterLibrary = (await getLibrary(owner.id, (await manager.getJobs())));
        for (const key of ['entries', 'songAdds', 'songOrder', 'playlistSongOrder']) assert.deepEqual(afterLibrary[key], beforeLibrary[key]);
      });
    }
  });

  await context.test('uploaded and local imports preserve more than 5000 song links', async () => {
    const sharedMedia = Array.from({ length: 101 }, (_, index) => ({
      name: `Music/Linked ${index}.mp3`, path: path.join(directory, `linked-${index}.mp3`), size: encodedAudio.length
    }));
    await Promise.all(sharedMedia.map((file) => fs.writeFile(file.path, encodedAudio)));
    const repeatedXml = plist.build({
      Tracks: Object.fromEntries(sharedMedia.map((file, index) => [index + 1, { 'Track ID': index + 1, Location: `file:///${file.name}` }])),
      Playlists: Array.from({ length: 51 }, (_, index) => ({ Name: `Linked playlist ${index}`,
        'Playlist Items': sharedMedia.map((_file, trackIndex) => ({ 'Track ID': trackIndex + 1 })) }))
    });
    const beforeConversions = encoder.mock.callCount();
    for (const local of [false, true]) {
      const before = (await getLibrary(owner.id, (await manager.getJobs())));
      const imported = await imports.importItunesLibrary(repeatedXml, sharedMedia, owner, { local });
      assert.equal(imported.importedFiles, 101);
      assert.equal(imported.jobs.length, 51);
      assert.equal(imported.jobs[0].files.length, 101);
      assert.ok(imported.jobs.slice(1).every((job) => job.files.length === 0));
      const saved = (await getLibrary(owner.id, (await manager.getJobs())));
      assert.equal(saved.songAdds.length, before.songAdds.length + 5050);
      const tracks = getPlaylistTracks(saved, (await manager.getJobs()));
      const expected = imported.jobs[0].files.map((name) => songKey({ jobId: imported.jobs[0].id, name }));
      for (const job of imported.jobs) {
        assert.deepEqual(saved.playlistSongOrder[job.id], expected);
        assert.deepEqual(tracks.get(job.id).map(songKey), expected);
      }
    }
    assert.equal(encoder.mock.callCount(), beforeConversions);
  });

  await context.test('WAV conversion failures remove temporary outputs without creating playlists', async (conversionContext) => {
    const beforeFiles = (await fs.readdir(directory)).sort();
    const beforeJobs = (await manager.getJobs()).map((job) => job.id).sort();
    for (const error of [Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      Object.assign(new Error('Timed out'), { killed: true }), new Error('Encoding failed')]) {
      let calls = 0;
      const failedEncoder = conversionContext.mock.method(childProcess, 'execFile', (_executable, args, _options, done) => {
        calls += 1;
        fs.writeFile(args.at(-1), calls === 1 ? encodedAudio : Buffer.from('partial'))
          .then(() => done(calls === 1 ? null : error), done);
      });
      await assert.rejects(imports.importItunesLibrary(xml, media, owner), /Unable to convert WAV to MP3/);
      failedEncoder.mock.restore();
      assert.deepEqual((await fs.readdir(directory)).sort(), beforeFiles);
      assert.deepEqual((await manager.getJobs()).map((job) => job.id).sort(), beforeJobs);
    }
  });

  assert.throws(() => imports.parseItunesImport(xml, media.slice(1), { report }), /Missing or ambiguous/);
  assert.equal(logs.at(-1).message, 'No media file matches this track');
  assert.equal(logs.at(-1).level, 'error');
  assert.equal(logs.at(-1).trackId, '2');
  assert.throws(() => imports.parseItunesImport('<not-plist/>', media), /Invalid iTunes/);
  assert.throws(() => imports.parseItunesImport('<!DOCTYPE plist [<!ENTITY name "bad">]><plist/>', media), /entity declarations/);
  const ambiguous = [...media, { ...media[0], name: 'Other/Artist/Album/Song.wav' }];
  assert.throws(() => imports.parseItunesImport(xml, ambiguous, { report }), /Missing or ambiguous/);
  assert.equal(logs.at(-1).message, 'Multiple media files match this track');
  assert.equal(logs.at(-1).trackId, '1');
  const ungrouped = imports.parseItunesImport(plist.build({ Tracks: document.Tracks }), media);
  assert.equal(ungrouped[0].playlistTitle, 'iTunes Library');
  const encoded = plist.build({ Tracks: { 1: { 'Track ID': 1, Location: 'file:///Music/A%20song%20%231.wav' } } });
  assert.equal(imports.parseItunesImport(encoded, [{ ...file, name: 'A song #1.wav' }])[0].files[0].name, 'A song #1.wav');
  const deepZip = new AdmZip();
  deepZip.addFile(`${'folder/'.repeat(33)}Song.wav`, audio);
  await fs.writeFile(zipPath, deepZip.toBuffer());
  await assert.rejects(imports.extractImportMedia(zipPath, directory, { report }), /unsafe/);
  assert.equal(logs.at(-1).message, 'Media ZIP extraction failed');
  assert.equal(logs.at(-1).entry, `${'folder/'.repeat(33)}Song.wav`);
  const linkedZip = new AdmZip();
  linkedZip.addFile('Link.wav', audio);
  linkedZip.getEntry('Link.wav').attr = 0xa1ff0000;
  await fs.writeFile(zipPath, linkedZip.toBuffer());
  await assert.rejects(imports.extractImportMedia(zipPath, directory), /unsafe/);
  await fs.writeFile(zipPath, 'not a zip');
  await assert.rejects(imports.extractImportMedia(zipPath, directory), /Invalid media ZIP/);
  const largeZip = new AdmZip();
  for (let index = 0; index < 2001; index++) largeZip.addFile(`Music/Track ${index}.wav`, audio);
  for (let index = 0; index < 8000; index++) largeZip.addFile(`Ignored/${index}/`, Buffer.alloc(0));
  await fs.writeFile(zipPath, largeZip.toBuffer());
  await assert.rejects(imports.extractImportMedia(zipPath, directory), { statusCode: 413 });
  const extracted = await imports.extractImportMedia(zipPath, directory, { local: true });
  assert.equal(extracted.length, 2001);

  await context.test('request diagnostics expose live owner-only progress and keep internal errors server-side', async (diagnostics) => {
    const serverLogs = [];
    diagnostics.mock.method(console, 'info', (line) => serverLogs.push(JSON.parse(line.slice('[library-import] '.length))));
    diagnostics.mock.method(console, 'error', (line) => serverLogs.push(JSON.parse(line.slice('[library-import] '.length))));
    const importId = '12345678-1234-1234-1234-123456789abc';
    const request = { user: owner, query: { importId }, is: (type) => type === 'application/json',
      body: { mode: 'itunes', source: 'local', xmlName: 'Library.XML', zipName: 'Media.zip' } };
    let response;
    const reply = { status(status) { this.statusCode = status; return this; }, json(body) { response = body; } };
    const readFile = fs.readFile;
    let liveProgress;
    const readMock = diagnostics.mock.method(fs, 'readFile', async (...args) => {
      if (path.basename(args[0]) === 'Library.XML') {
        const progress = imports.getImportProgress(owner.id, importId);
        liveProgress = { status: progress.status, stage: progress.entries.at(-1).stage };
        assert.equal(imports.getImportProgress('other', importId), null);
      }
      return readFile(...args);
    });
    await imports.handleLibraryImport(request, reply);
    assert.equal(reply.statusCode, 201);
    assert.equal(response.importId, importId);
    assert.deepEqual(liveProgress, { status: 'running', stage: 'read' });
    const completed = imports.getImportProgress(owner.id, importId);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, { importedFiles: response.importedFiles,
      jobs: response.jobs.map((job) => ({ id: job.id, playlistTitle: job.playlistTitle })) });
    assert.equal(completed.entries.at(-1).message, 'Import completed');
    const completedStorage = path.join(directory, 'import-storage-completed');
    assert.equal(await readFile(path.join(completedStorage, 'Library.XML'), 'utf8'), xml);
    assert.equal((await fs.stat(path.join(completedStorage, 'Media.zip'))).size, localFiles.zipFiles[0].size);
    assert.deepEqual(await imports.listLocalImportFiles(), { xmlFiles: [], zipFiles: [] });
    assert.ok(serverLogs.every((entry) => entry.importId === importId && entry.userId === owner.id
      && Number.isFinite(Date.parse(entry.time)) && entry.elapsedMs >= 0));
    readMock.mock.restore();
    await diagnostics.test('background local import acknowledges before processing and reports completion after cleanup', async (background) => {
      await fs.copyFile(path.join(completedStorage, 'Library.XML'), path.join(storage, 'Library.XML'));
      await fs.copyFile(path.join(completedStorage, 'Media.zip'), path.join(storage, 'Media.zip'));
      let releaseRead;
      let readStarted;
      const started = new Promise((resolve) => { readStarted = resolve; });
      const wait = new Promise((resolve) => { releaseRead = resolve; });
      background.mock.method(fs, 'readFile', async (...args) => {
        if (path.basename(args[0]) === 'Library.XML') {
          readStarted();
          await wait;
        }
        return readFile(...args);
      });
      const replies = [];
      const backgroundReply = { status(status) { this.statusCode = status; return this; },
        json(body) { replies.push({ status: this.statusCode, body }); } };
      const pending = imports.handleLibraryImport({ ...request, query: { importId, background: 'true' } }, backgroundReply);
      try {
        await started;
        assert.deepEqual(replies, [{ status: 202, body: { importId, status: 'running' } }]);
        const running = imports.getImportProgress(owner.id, importId);
        assert.equal(running.status, 'running');
        assert.equal(running.result, undefined);
        assert.equal(imports.getImportProgress('other', importId), null);
        await imports.handleLibraryImport(request, reply);
        assert.equal(reply.statusCode, 409);
        await imports.handleLibraryImport({ ...request, user: { id: 'another-user', name: 'Other' } }, reply);
        assert.equal(reply.statusCode, 409);
        assert.match(response.error, /already being imported/);
      } finally { releaseRead(); await pending; }
      assert.equal(replies.length, 1);
      const finished = imports.getImportProgress(owner.id, importId);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.result.importedFiles, 2);
      assert.ok(finished.result.jobs.every((job) => Object.keys(job).sort().join(',') === 'id,playlistTitle'));
      assert.equal(finished.entries.at(-2).stage, 'cleanup');
      assert.equal((await fs.readdir(completedStorage)).length, 4);
      assert.equal(await readFile(path.join(completedStorage, 'Library.XML'), 'utf8'), xml);
      assert.deepEqual(await imports.listLocalImportFiles(), { xmlFiles: [], zipFiles: [] });
    });
    await fs.copyFile(path.join(completedStorage, 'Library.XML'), path.join(storage, 'Library.XML'));
    await fs.copyFile(path.join(completedStorage, 'Media.zip'), path.join(storage, 'Media.zip'));
    for (const operation of ['copyFile', 'unlink']) {
      await diagnostics.test(`archive ${operation} failures restore sources and roll back imported playlists`, async (archive) => {
        const beforeJobs = (await manager.getJobs()).map((job) => job.id).sort();
        const beforeArchived = (await fs.readdir(completedStorage)).sort();
        const original = fs[operation];
        archive.mock.method(fs, operation, async (...args) => {
          const target = operation === 'copyFile' ? args[1] : args[0];
          if (path.extname(target) === '.zip') throw Object.assign(new Error('Archive unavailable'), { code: 'EACCES' });
          return original(...args);
        });
        await imports.handleLibraryImport(request, reply);
        assert.equal(reply.statusCode, 500);
        assert.deepEqual((await manager.getJobs()).map((job) => job.id).sort(), beforeJobs);
        assert.deepEqual((await fs.readdir(completedStorage)).sort(), beforeArchived);
        assert.equal(await fs.readFile(path.join(storage, 'Library.XML'), 'utf8'), xml);
        assert.equal((await fs.stat(path.join(storage, 'Media.zip'))).size, localFiles.zipFiles[0].size);
      });
    }
    const failureMock = diagnostics.mock.method(fs, 'readFile', async (...args) => {
      if (path.basename(args[0]) === 'Library.XML') throw new Error('Private filesystem detail');
      return readFile(...args);
    });
    await imports.handleLibraryImport({ ...request, query: {} }, reply);
    assert.equal(reply.statusCode, 500);
    assert.equal(response.error, 'Unable to import music');
    assert.equal(imports.getImportProgress(owner.id, importId), null);
    const failed = imports.getImportProgress(owner.id, response.importId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Unable to import music');
    assert.equal(JSON.stringify(failed).includes('Private filesystem detail'), false);
    assert.equal((await imports.listLocalImportFiles()).xmlFiles.length, 1);
    assert.equal((await imports.listLocalImportFiles()).zipFiles.length, 1);
    assert.ok(serverLogs.some((entry) => entry.stage === 'read' && entry.level === 'error'
      && entry.error === 'Private filesystem detail' && entry.stack.includes('Private filesystem detail')));
    const backgroundReplies = [];
    await imports.handleLibraryImport({ ...request, query: { importId, background: 'true' } }, {
      status(status) { this.statusCode = status; return this; },
      json(body) { backgroundReplies.push({ status: this.statusCode, body }); }
    });
    assert.deepEqual(backgroundReplies, [{ status: 202, body: { importId, status: 'running' } }]);
    const backgroundFailure = imports.getImportProgress(owner.id, importId);
    assert.equal(backgroundFailure.status, 'failed');
    assert.equal(backgroundFailure.error, 'Unable to import music');
    assert.equal(JSON.stringify(backgroundFailure).includes('Private filesystem detail'), false);
    failureMock.mock.restore();
    diagnostics.mock.method(Date, 'now', () => backgroundFailure.finishedAt + 60 * 60 * 1000 + 1);
    assert.equal(imports.getImportProgress(owner.id, importId), null);
  });
});