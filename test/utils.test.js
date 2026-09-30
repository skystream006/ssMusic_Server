import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaylistUrl, isYouTubeMusicUrl, isYouTubeUrl, normalizeJobUrl, sanitizeFolderName } from '../src/utils.js';

test('accepts YouTube video, short, mobile and music links only over HTTP or HTTPS', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']) {
    assert.equal(isYouTubeUrl(`https://${host}/watch?v=abc`), true);
    assert.equal(isYouTubeUrl(`http://${host}/watch?v=abc`), true);
  }
  for (const url of ['not a URL', 'https://example.com', 'https://youtube.com.example.com/watch?v=abc',
    'https://youtube.com@example.com/watch?v=abc', 'ftp://youtube.com/video', 'file://youtube.com/video',
    'https://user:password@youtube.com/watch?v=abc']) {
    assert.equal(isYouTubeUrl(url), false, url);
  }
});

test('validates YouTube Music URL host', () => {
  assert.equal(isYouTubeMusicUrl('https://music.youtube.com/watch?v=abc'), true);
  assert.equal(isYouTubeMusicUrl('https://youtube.com/watch?v=abc'), false);
});

test('detects playlist URLs by list query parameter regardless of path', () => {
  assert.equal(isPlaylistUrl('https://music.youtube.com/playlist?list=PL12345'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=RTcsY6aIoEc&list=PLbMbcPGUE7ak'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?list=PL12345&v=abc'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/?list=PL12345'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PL12345'), true);
  assert.equal(isPlaylistUrl('https://youtube.com/watch?v=abc&list=PL12345'), true);
  assert.equal(isPlaylistUrl('https://youtu.be/abc?list=PL12345'), true);
});

test('does not detect playlists without a list query parameter or a valid YouTube host', () => {
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=abc'), false);
  assert.equal(isPlaylistUrl('https://music.youtube.com/playlist'), false);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=abc#list=PL12345'), false);
  assert.equal(isPlaylistUrl('https://example.com/watch?v=abc&list=PL12345'), false);
  assert.equal(isPlaylistUrl('https://youtu.be/abc'), false);
  assert.equal(isPlaylistUrl('not a URL'), false);
});

test('sanitizes folder names for output directories', () => {
  assert.equal(sanitizeFolderName('My Playlist Name'), 'My_Playlist_Name');
  assert.equal(sanitizeFolderName('  bad:/\\name  '), 'bad_name');
});

test('job URLs with a list parameter become canonical YouTube Music playlist URLs', () => {
  for (const url of [
    'https://music.youtube.com/watch?v=cMoRYP8EDUk&list=PLbMbcPGUE7ak',
    ' https://www.youtube.com/watch?list=PLbMbcPGUE7ak&v=other&index=3#fragment ',
    'http://youtu.be/other?si=tracking&list=PLbMbcPGUE7ak',
    'https://music.youtube.com/playlist?list=PLbMbcPGUE7ak'
  ]) {
    assert.equal(normalizeJobUrl(url), 'https://music.youtube.com/playlist?list=PLbMbcPGUE7ak');
  }
  assert.equal(normalizeJobUrl('https://youtube.com/watch?list=PL%2B123&v=abc'), 'https://music.youtube.com/playlist?list=PL%2B123');
  for (const url of ['https://music.youtube.com/watch?v=abc', 'https://youtu.be/abc?si=tracking',
    'https://music.youtube.com/watch?v=abc#list=PL123', 'https://example.com/watch?list=PL123', 'not a URL']) {
    assert.equal(normalizeJobUrl(` ${url} `), url);
  }
});
