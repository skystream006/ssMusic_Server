import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createCompatibilityAudioCache, createMediaStreamHandler, encodeCompatibilityAudio } from '../src/audioCompatibility.js';

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-aac-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'Song.mp3');
  await fs.writeFile(source, 'original media');
  return { directory, source, root: path.join(directory, 'cache') };
}

test('AAC cache shares conversions, survives restart, and keeps stable file validators', async (context) => {
  const { source, root } = await fixture(context);
  let conversions = 0;
  const encode = async (input, output) => { conversions++; await fs.writeFile(output, await fs.readFile(input)); };
  const cache = createCompatibilityAudioCache({ root, encode });
  const targets = await Promise.all(Array.from({ length: 8 }, () => cache.prepare(source)));
  assert.equal(new Set(targets).size, 1);
  assert.equal(conversions, 1);
  const before = await fs.stat(targets[0]);
  assert.equal(await createCompatibilityAudioCache({ root, encode }).prepare(source), targets[0]);
  assert.equal(conversions, 1);
  assert.equal((await fs.stat(targets[0])).mtimeMs, before.mtimeMs);
  const fragmented = await cache.prepare(source, { fragmented: true });
  assert.notEqual(fragmented, targets[0]);
  assert.equal(await cache.prepare(source, { fragmented: true }), fragmented);
  assert.equal(conversions, 2);
  await fs.writeFile(source, 'changed original media');
  assert.notEqual(await cache.prepare(source), targets[0]);
  assert.equal(conversions, 3);
  assert.equal(await fs.readFile(source, 'utf8'), 'changed original media');
  assert.ok((await fs.readdir(root)).every((name) => !name.includes('.tmp.')));
});

test('AAC cache removes failed partial output, rejects changes during encoding, and bounds storage', async (context) => {
  const { source, root, directory } = await fixture(context);
  const failing = createCompatibilityAudioCache({ root, async encode(input, output) {
    await fs.writeFile(output, 'partial'); throw new Error('Encoder failed');
  } });
  await assert.rejects(failing.prepare(source), /Encoder failed/);
  assert.deepEqual(await fs.readdir(root), []);
  const changed = createCompatibilityAudioCache({ root, async encode(input, output) {
    await fs.writeFile(output, 'audio'); await fs.writeFile(input, 'modified while encoding');
  } });
  await assert.rejects(changed.prepare(source), { statusCode: 409 });
  assert.deepEqual(await fs.readdir(root), []);
  const cache = createCompatibilityAudioCache({ root, maxBytes: 16, async encode(input, output) { await fs.writeFile(output, '1234567890'); } });
  const first = await cache.prepare(source);
  const other = path.join(directory, 'Other.mp3'); await fs.writeFile(other, 'other');
  const second = await cache.prepare(other);
  assert.notEqual(first, second);
  assert.deepEqual(await fs.readdir(root), [path.basename(second)]);
  await assert.rejects(cache.prepare(path.join(directory, 'Movie.mp4')), { statusCode: 400 });
});

test('AAC preparation limits active work and rejects excess pending requests', async (context) => {
  const { directory, source, root } = await fixture(context);
  const other = path.join(directory, 'Other.mp3');
  const extra = path.join(directory, 'Extra.mp3');
  await Promise.all([fs.writeFile(other, 'other'), fs.writeFile(extra, 'extra')]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  context.after(() => release());
  let started = 0;
  let bothStarted;
  const ready = new Promise((resolve) => { bothStarted = resolve; });
  const cache = createCompatibilityAudioCache({ root, concurrency: 2, maxPending: 2, async encode(input, output) {
    if (++started === 2) bothStarted();
    await gate;
    await fs.writeFile(output, 'prepared audio');
  } });
  const first = cache.prepare(source);
  const second = cache.prepare(other);
  await ready;
  await assert.rejects(cache.prepare(extra), { statusCode: 429 });
  assert.equal(started, 2);
  release();
  await Promise.all([first, second]);
  await cache.prepare(extra);
  assert.equal(started, 3);
});

test('media serving rechecks authorization after preparing a cached derivative', async (context) => {
  const { source, root } = await fixture(context);
  let allowed = true;
  const cache = createCompatibilityAudioCache({ root, async encode(input, output) {
    await fs.writeFile(output, 'private audio'); allowed = false;
  } });
  const app = express();
  app.get('/stream', createMediaStreamHandler(async () => {
    if (!allowed) throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    return source;
  }, cache));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/stream?format=aac`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /private audio/);
});

test('media serving preserves byte ranges, HEAD, conditional requests, and authorization', async (context) => {
  const { source, root } = await fixture(context);
  const output = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  let conversions = 0;
  let allowed = true;
  const cache = createCompatibilityAudioCache({ root, async encode(input, target) { conversions++; await fs.writeFile(target, output); } });
  const app = express();
  app.get('/stream', createMediaStreamHandler(async (req) => {
    if (!allowed || req.get('x-viewer') !== 'owner') throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    return source;
  }, cache));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/stream`;
  const headers = { 'x-viewer': 'owner' };
  assert.equal((await fetch(`${url}?format=aac`)).status, 404);
  assert.equal(conversions, 0);
  assert.equal((await fetch(`${url}?format=invalid`, { headers })).status, 400);
  assert.equal((await fetch(`${url}?mse=1`, { headers })).status, 400);
  assert.equal((await fetch(`${url}?format=aac&mse=invalid`, { headers })).status, 400);
  const prepared = await fetch(`${url}?format=aac`, { method: 'HEAD', headers });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.headers.get('content-type'), 'audio/mp4');
  assert.equal(prepared.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(prepared.headers.get('content-length')), output.length);
  const etag = prepared.headers.get('etag');
  const first = await fetch(`${url}?format=aac`, { headers: { ...headers, Range: 'bytes=0-1' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 0-1/${output.length}`);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), output.subarray(0, 2));
  const next = await fetch(`${url}?format=aac`, { headers: { ...headers, Range: 'bytes=2-9', 'If-Range': etag } });
  assert.equal(next.status, 206);
  assert.equal(next.headers.get('etag'), etag);
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), output.subarray(2, 10));
  assert.equal((await fetch(`${url}?format=aac`, { headers: { ...headers, Range: 'bytes=999-' } })).status, 416);
  assert.equal((await fetch(`${url}?format=aac`, { headers: { ...headers, 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } })).status, 304);
  assert.equal(conversions, 1);
  const fragmented = await fetch(`${url}?format=aac&mse=1`, { headers: { ...headers, Range: 'bytes=0-1' } });
  assert.equal(fragmented.status, 206);
  assert.equal(fragmented.headers.get('content-type'), 'audio/mp4');
  assert.equal(conversions, 2);
  const original = await fetch(url, { headers: { ...headers, Range: 'bytes=0-3' } });
  assert.equal(original.status, 206);
  assert.equal(await original.text(), 'orig');
  allowed = false;
  assert.equal((await fetch(`${url}?format=aac`, { headers })).status, 404);
});

test('AAC encoder creates seekable AAC-LC M4A with metadata before audio data', async (context) => {
  const { source, directory } = await fixture(context);
  const location = process.env.FFMPEG_PATH || path.resolve('runtime', 'ffmpeg', 'bin');
  const executable = /^ffmpeg(?:\.exe)?$/i.test(path.basename(location)) ? location : path.join(location, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!await fs.access(executable).then(() => true, () => false)) { context.skip('FFmpeg is not installed'); return; }
  execFileSync(executable, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', source]);
  const before = await fs.readFile(source);
  const target = path.join(directory, 'output.m4a');
  await encodeCompatibilityAudio(source, target);
  const encoded = await fs.readFile(target);
  const boxes = [];
  for (let offset = 0; offset + 8 <= encoded.length;) {
    const size = encoded.readUInt32BE(offset);
    boxes.push(encoded.toString('ascii', offset + 4, offset + 8));
    assert.ok(size >= 8);
    offset += size;
  }
  assert.ok(boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'));
  const probe = path.join(path.dirname(executable), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const result = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', target], { encoding: 'utf8' }));
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].codec_name, 'aac');
  assert.equal(result.streams[0].profile, 'LC');
  assert.deepEqual(await fs.readFile(source), before);
  const fragmented = path.join(directory, 'fragmented.m4a');
  await encodeCompatibilityAudio(source, fragmented, { fragmented: true });
  const fragments = await fs.readFile(fragmented);
  const fragmentBoxes = [];
  for (let offset = 0; offset + 8 <= fragments.length;) {
    const size = fragments.readUInt32BE(offset);
    fragmentBoxes.push(fragments.toString('ascii', offset + 4, offset + 8));
    assert.ok(size >= 8);
    offset += size;
  }
  assert.ok(fragmentBoxes.indexOf('moov') < fragmentBoxes.indexOf('moof'));
  assert.ok(fragmentBoxes.includes('moof'));
  assert.ok(fragmentBoxes.indexOf('moof') < fragmentBoxes.indexOf('mdat'));
  const fragmentedInfo = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', fragmented], { encoding: 'utf8' }));
  assert.equal(fragmentedInfo.streams[0].codec_name, 'aac');
});