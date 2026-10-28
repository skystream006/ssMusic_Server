import assert from 'node:assert/strict';
import test from 'node:test';
import { countDownloadedFiles } from '../src/library.js';
import { sortJobs } from '../frontend/src/jobSorting.js';

test('job detail files sort by creation date newest first without changing playlist order', () => {
  const files = [
    { name: 'Unknown.mp3' },
    { name: 'Older.mp3', createdAt: '2026-10-27T12:00:00Z' },
    { name: 'Newest.mp3', createdAt: '2026-10-28T12:00:00Z' },
    { name: 'Same time.mp3', createdAt: '2026-10-28T12:00:00Z' },
    { name: 'Invalid.mp3', createdAt: 'invalid' }
  ];
  const original = structuredClone(files);
  assert.deepEqual(sortJobs(files, 'created', 'desc').map((file) => file.name), [
    'Newest.mp3', 'Same time.mp3', 'Older.mp3', 'Unknown.mp3', 'Invalid.mp3'
  ]);
  assert.deepEqual(files, original);
});

test('downloaded count excludes NoVocals paths from job filenames and file details', () => {
  const names = ['Song.mp3', 'Other.flac', '[NoVocals]/Song.mp3', '[novocals]/Other.flac'];
  const files = names.map((name) => ({ name, isSong: true }));
  assert.equal(countDownloadedFiles(names), 2);
  assert.equal(countDownloadedFiles(files), 2);
  assert.equal(names.length, 4);
  assert.equal(files.length, 4);
});

test('downloaded count is zero for absent files or only NoVocals files', () => {
  for (const files of [undefined, null, [], ['[NoVocals]/Song.mp3'], [{ name: '[NoVocals]/Song.mp3' }]]) {
    assert.equal(countDownloadedFiles(files), 0);
  }
});

test('downloaded count preserves ordinary files including names mentioning NoVocals', () => {
  assert.equal(countDownloadedFiles(['Song.mp3', 'notes.txt', 'Song [NoVocals].mp3']), 3);
});
