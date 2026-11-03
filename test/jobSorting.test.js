import assert from 'node:assert/strict';
import test from 'node:test';
import { jobSortColumns, sortJobs } from '../frontend/src/jobSorting.js';

const jobs = [
  { id: 'ten', playlistTitle: 'album 10', isPlaylist: true, status: 'running', createdAt: '2026-09-18T12:00:00Z', playlistSongCount: 10, files: Array.from({ length: 10 }, (_, index) => `Song ${index}.mp3`), totalSizeBytes: 10_000, initiatedBy: { name: 'Zoe' } },
  { id: 'two', playlistTitle: 'Album 2', isPlaylist: true, status: 'completed', createdAt: '2026-09-18T14:00:00+03:00', playlistSongCount: 2, files: ['One.mp3', 'Two.mp3', '[NoVocals]/One.mp3'], totalSizeBytes: 200, initiatedBy: { name: 'alice' } },
  { id: 'one', playlistTitle: 'Album 1', isPlaylist: false, status: 'failed', createdAt: '2026-09-19T12:00:00Z', files: ['One.mp3'], totalSizeBytes: 1024, initiatedBy: { name: 'Bob' } }
];
const ids = (result) => result.map((job) => job.id);

test('jobs default to newest first without mutating their source', () => {
  const original = structuredClone(jobs);
  assert.deepEqual(ids(sortJobs(jobs)), ['one', 'ten', 'two']);
  assert.deepEqual(jobs, original);
  assert.equal(sortJobs(jobs)[0], jobs[2]);
});

const ascending = {
  title: ['one', 'two', 'ten'],
  format: ['ten', 'two', 'one'],
  status: ['two', 'one', 'ten'],
  created: ['two', 'ten', 'one'],
  songs: ['one', 'two', 'ten'],
  files: ['one', 'two', 'ten'],
  size: ['two', 'one', 'ten'],
  initiator: ['two', 'one', 'ten']
};
const descending = { format: ['one', 'ten', 'two'] };

for (const { key } of jobSortColumns) {
  test(`jobs sort ${key} in both directions with stable ties`, () => {
    assert.deepEqual(ids(sortJobs(jobs, key, 'asc')), ascending[key]);
    assert.deepEqual(ids(sortJobs(jobs, key, 'desc')), descending[key] || [...ascending[key]].reverse());
  });
}

test('unknown song counts, storage sizes and invalid dates stay last in both directions', () => {
  const records = [
    { id: 'missing', isPlaylist: true },
    { id: 'invalid', isPlaylist: true, createdAt: 'invalid', playlistSongCount: null, totalSizeBytes: null },
    { id: 'zero', isPlaylist: true, createdAt: '1970-01-01T00:00:00Z', playlistSongCount: 0, totalSizeBytes: 0 },
    { id: 'track', createdAt: '2026-09-18T12:00:00Z', totalSizeBytes: 1 }
  ];
  for (const key of ['songs', 'created', 'size']) {
    assert.deepEqual(ids(sortJobs(records, key, 'asc')), ['zero', 'track', 'missing', 'invalid']);
    assert.deepEqual(ids(sortJobs(records, key, 'desc')), ['track', 'zero', 'missing', 'invalid']);
  }
});

test('sorting handles empty lists, display fallbacks and repeated polling results', () => {
  assert.deepEqual(sortJobs([]), []);
  assert.deepEqual(ids(sortJobs([{ id: 'missing' }, jobs[0]], 'title', 'asc')), ['ten', 'missing']);
  assert.deepEqual(ids(sortJobs([{ id: 'missing' }, jobs[0]], 'initiator', 'asc')), ['missing', 'ten']);
  assert.deepEqual(ids(sortJobs([{ id: 'missing' }, jobs[0]], 'files', 'asc')), ['missing', 'ten']);
  assert.deepEqual(ids(sortJobs(structuredClone(jobs), 'title', 'asc')), ascending.title);
  assert.deepEqual(ids(sortJobs([jobs[0], { ...jobs[0], id: 'tie', playlistTitle: 'ALBUM 10' }], 'title', 'desc')), ['ten', 'tie']);
});