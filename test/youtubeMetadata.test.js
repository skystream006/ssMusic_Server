import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import NodeID3 from 'node-id3';
import { retrieveYoutubeArtwork, retrieveYoutubeMetadata } from '../src/youtubeMetadata.js';
import { readSongSourceUrl } from '../src/music.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('source URL recovery reads embedded yt-dlp and standard MP3 source tags', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-source-url-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'Song.mp3');
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  for (const tags of [
    { userDefinedText: [{ description: 'purl', value: url }] },
    { comment: { language: 'eng', text: url } },
    { audioSourceUrl: url },
    { fileUrl: url },
    { userDefinedUrl: [{ description: 'Source', url }] }
  ]) {
    await fs.writeFile(filePath, NodeID3.write(tags, Buffer.from('audio')));
    assert.equal(await readSongSourceUrl(filePath), url);
  }
  for (const tags of [{}, { comment: { language: 'eng', text: 'Not a source URL' } },
    { userDefinedText: [{ description: 'purl', value: 'http://127.0.0.1/private' }] }]) {
    await fs.writeFile(filePath, NodeID3.write(tags, Buffer.from('audio')));
    assert.equal(await readSongSourceUrl(filePath), null);
  }
});

test('oEmbed retrieves channel and thumbnail directly with bounded, nonredirecting requests', async (context) => {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1
      ? Response.json({ author_name: ' Channel artist ', thumbnail_url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' })
      : new Response(png);
  });
  const result = await retrieveYoutubeMetadata('https://youtu.be/abcdefghijk');
  assert.equal(result.artist, 'Channel artist');
  assert.deepEqual(result.image, { mime: 'image/png', imageBuffer: png });
  assert.equal(result.warning, null);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://www.youtube.com/oembed');
  assert.equal(calls[0].url.searchParams.get('url'), 'https://www.youtube.com/watch?v=abcdefghijk');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('oEmbed title lookups defer artwork until a source has been matched', async (context) => {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(new URL(url).href);
    return calls.length === 1 ? Response.json({ title: ' Original title ', author_name: 'Channel',
      thumbnail_url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }) : new Response(png);
  });
  const metadata = await retrieveYoutubeMetadata('https://youtu.be/abcdefghijk', undefined, { includeArtwork: false });
  assert.equal(metadata.title, 'Original title');
  assert.equal(metadata.artist, 'Channel');
  assert.equal(metadata.image, null);
  assert.equal(calls.length, 1);
  const artwork = await retrieveYoutubeArtwork(metadata.thumbnailUrl);
  assert.deepEqual(artwork.image, { mime: 'image/png', imageBuffer: png });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], metadata.thumbnailUrl);
});

test('oEmbed rejects invalid sources and unsafe artwork URLs without fetching them', async (context) => {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return Response.json({ author_name: 'Channel', thumbnail_url: 'http://127.0.0.1/private' });
  });
  await assert.rejects(retrieveYoutubeMetadata('https://example.com/video'), /video URL/);
  assert.equal(calls.length, 0);
  const result = await retrieveYoutubeMetadata('https://youtu.be/abcdefghijk');
  assert.equal(calls.length, 1);
  assert.equal(result.artist, 'Channel');
  assert.equal(result.image, null);
  assert.match(result.warning, /thumbnail URL/);
});

test('oEmbed reports unavailable videos and rejects oversized metadata and images', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(retrieveYoutubeMetadata('https://youtu.be/abcdefghijk'), /HTTP 404/);
  fetchMock.mock.mockImplementation(async () => new Response('x'.repeat(128 * 1024 + 1)));
  await assert.rejects(retrieveYoutubeMetadata('https://youtu.be/abcdefghijk'), /too large/);
  fetchMock.mock.mockImplementation(async (url) => new URL(url).hostname === 'www.youtube.com'
    ? Response.json({ author_name: 'Channel', thumbnail_url: 'https://i.ytimg.com/cover.jpg' })
    : new Response(png, { headers: { 'Content-Length': String(3 * 1024 * 1024 + 1) } }));
  const result = await retrieveYoutubeMetadata('https://youtu.be/abcdefghijk');
  assert.equal(result.artist, 'Channel');
  assert.equal(result.image, null);
  assert.match(result.warning, /too large/);
});