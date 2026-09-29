import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import { closeDatabases, openDatabase, writeJob, writeUser } from '../src/database.js';
import { getPlaylistIds, getPlaylistTracks, individualSongsId, orderFiles, songKey, themes } from '../src/library.js';
import { addLibraryJobFiles, countLibraryFileLinks, getLibrary, getPreferences, linkLibraryJob, moveLibrarySong, moveLibraryPlaylists, mutateLibraryEntry, removeLibrarySongLink, reorderLibrarySong, setLibrary, setTheme, transferLibrarySongs } from '../src/libraryStore.js';
import { submitJobUrl } from '../frontend/src/jobSubmission.js';
import { createTestDatabase } from '../test-support/postgres.js';

const jobs = [
  { id: 'jazz', files: ['First.mp3', 'Second.mp3', 'Third.mp3', 'notes.txt'] },
  { id: 'soul', files: ['Soul.mp3'] },
  { id: 'live', files: ['Live.mp3'] }
];

let fixtureDirectory;
beforeEach(async (context) => {
  ({ directory: fixtureDirectory } = await createTestDatabase(context));
  for (const id of ['alice', 'bob']) {
    (await writeUser(openDatabase(), { id, name: id, userHandle: id, role: 'user', status: 'approved', credentials: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }
});

test('each account retains its own color and light or dark mode across database restarts', async () => {
  assert.deepEqual((await getPreferences('alice')), { theme: 'light', mode: 'light' });
  for (const theme of themes) {
    for (const mode of ['light', 'dark']) {
      assert.deepEqual((await setTheme('alice', theme.id, mode)), { theme: theme.id, mode });
      assert.deepEqual((await getPreferences('bob')), { theme: 'light', mode: 'light' });
    }
  }
  (await assert.rejects(async () => (await setTheme('alice', 'unknown')), { statusCode: 400 }));
  for (const mode of [null, '', 'unknown']) (await assert.rejects(async () => (await setTheme('alice', 'pink', mode)), { statusCode: 400 }));
  (await closeDatabases());
  assert.deepEqual((await getPreferences('alice')), { theme: 'black', mode: 'dark' });
  assert.deepEqual((await setTheme('alice', 'green')), { theme: 'green', mode: 'dark' });
  assert.deepEqual((await setTheme('alice', undefined, 'light')), { theme: 'green', mode: 'light' });
});

test('unspecified theme modes preserve established light and dark defaults', async () => {
  const database = openDatabase();
  (await database.prepare('INSERT INTO user_preferences (user_id, theme) VALUES ($1, $2)').run('alice', 'black'));
  (await database.prepare('INSERT INTO user_preferences (user_id, theme) VALUES ($1, $2)').run('bob', 'royal-purple'));
  (await closeDatabases());
  assert.deepEqual((await getPreferences('alice')), { theme: 'black', mode: 'dark' });
  assert.deepEqual((await getPreferences('bob')), { theme: 'royal-purple', mode: 'light' });
  (await openDatabase().prepare('UPDATE user_preferences SET theme = $1 WHERE user_id = $2').run('midnight', 'alice'));
  assert.deepEqual((await getPreferences('alice')), { theme: 'midnight', mode: 'dark' });
});

test('nested folders aggregate playlists and songs in saved order', async () => {
  const entries = [
    { id: 'folder-evening', type: 'folder', parentId: null, name: 'Evening' },
    { id: 'soul', type: 'playlist', parentId: 'folder-evening' },
    { id: 'folder-jazz', type: 'folder', parentId: 'folder-evening', name: 'Jazz' },
    { id: 'jazz', type: 'playlist', parentId: 'folder-jazz' },
    { id: 'live', type: 'playlist', parentId: null }
  ];
  const saved = (await setLibrary('alice', { version: 0, entries, songOrder: { jazz: ['Third.mp3', 'First.mp3'] } }, jobs));
  assert.deepEqual(getPlaylistIds(saved.entries), ['soul', 'jazz', 'live']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'folder-evening'), ['soul', 'jazz']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'folder-jazz'), ['jazz']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'soul'), ['soul']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'missing'), []);
  assert.deepEqual(orderFiles(jobs[0].files, saved.songOrder.jazz), ['Third.mp3', 'First.mp3', 'Second.mp3', 'notes.txt']);
  assert.deepEqual(orderFiles([{ name: 'First.mp3' }, { name: 'Third.mp3' }], saved.songOrder.jazz), [
    { name: 'Third.mp3' }, { name: 'First.mp3' }
  ]);
  assert.deepEqual(getPlaylistIds((await getLibrary('bob', jobs)).entries), ['jazz', 'soul', 'live']);
  (await setTheme('alice', 'green'));
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', jobs)), saved);
  assert.deepEqual((await getPreferences('alice')), { theme: 'green', mode: 'light' });
});

test('playlist reordering preserves folders and Individual Songs across reloads without changing another account', async () => {
  const single = { id: 'single', isPlaylist: false, files: ['Single.mp3'] };
  const available = [...jobs, single];
  const initial = (await linkLibraryJob('alice', single, available));
  const individual = initial.entries.find((entry) => entry.id === individualSongsId);
  const folder = { id: 'folder-favorites', type: 'folder', parentId: null, name: 'Favorites' };
  const organized = (await setLibrary('alice', { ...initial, entries: [
    folder, { id: 'jazz', type: 'playlist', parentId: folder.id },
    { id: 'soul', type: 'playlist', parentId: folder.id },
    { id: 'live', type: 'playlist', parentId: null }, individual
  ] }, available));
  const byId = new Map(organized.entries.map((entry) => [entry.id, entry]));
  const reordered = (await setLibrary('alice', { ...organized,
    entries: [individualSongsId, 'live', folder.id, 'soul', 'jazz'].map((id) => byId.get(id))
  }, available));
  (await closeDatabases());
  const restored = (await getLibrary('alice', available));
  assert.deepEqual(restored, reordered);
  assert.deepEqual(getPlaylistIds(restored.entries), [individualSongsId, 'live', 'soul', 'jazz']);
  assert.deepEqual(getPlaylistIds(restored.entries, folder.id), ['soul', 'jazz']);
  assert.equal(restored.entries[0].protected, true);
  assert.deepEqual(restored.songOrder, organized.songOrder);
  assert.deepEqual(getPlaylistIds((await getLibrary('bob', available)).entries), ['jazz', 'soul', 'live', 'single']);
  (await assert.rejects(async () => (await setLibrary('alice', organized, available)), { statusCode: 409 }));
});

test('compact entry mutations preserve large libraries and promote folder children in order', async () => {
  const available = [...jobs, { id: 'large', files: Array.from({ length: 3000 }, (_, index) => `${'Long song name '.repeat(8)}${index}.mp3`) }];
  let library = (await addLibraryJobFiles('alice', { version: 0, jobId: 'jazz', playlistId: 'soul' }, available));
  library = (await setLibrary('alice', { ...library, songOrder: { large: available.at(-1).files } }, available));
  const initial = library;
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 128 * 1024);
  async function mutate(changes) {
    const body = { version: library.version, ...changes };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024);
    library = (await mutateLibraryEntry('alice', body, available));
    for (const key of ['songOrder', 'playlistSongOrder', 'songMoves', 'songAdds', 'singleJobIds']) {
      assert.deepEqual(library[key], initial[key]);
    }
    return library;
  }
  (await mutate({ action: 'create-folder', id: 'folder-parent', name: 'Parent', parentId: null }));
  (await mutate({ action: 'create-folder', id: 'folder-child', name: 'Child', parentId: 'folder-parent' }));
  (await mutate({ action: 'update-folder', id: 'folder-child', name: 'Renamed', parentId: null }));
  assert.equal(library.entries.find((entry) => entry.id === 'folder-child').name, 'Renamed');
  (await mutate({ action: 'move', id: 'folder-child', parentId: 'folder-parent', targetId: null, after: false }));
  (await mutate({ action: 'move', id: 'jazz', parentId: 'folder-parent', targetId: 'folder-child', after: false }));
  (await mutate({ action: 'move', id: 'soul', parentId: 'folder-parent', targetId: 'folder-child', after: true }));
  assert.deepEqual(library.entries.filter((entry) => entry.parentId === 'folder-parent').map((entry) => entry.id), ['jazz', 'folder-child', 'soul']);
  (await mutate({ action: 'move', id: 'folder-parent', parentId: null, targetId: 'live', after: false }));
  (await mutate({ action: 'delete-folder', id: 'folder-parent' }));
  assert.deepEqual(library.entries.map((entry) => entry.id), ['jazz', 'folder-child', 'soul', 'live', 'large']);
  assert.ok(library.entries.every((entry) => entry.parentId === null));
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', available)), library);
  assert.deepEqual((await getLibrary('bob', available)).entries.map((entry) => entry.id), ['jazz', 'soul', 'live', 'large']);
});

test('entry mutations reject invalid changes atomically and keep the tree and version constraints', async () => {
  const initial = (await setLibrary('alice', { ...(await getLibrary('alice', jobs)), entries: [
    ...(await getLibrary('alice', jobs)).entries,
    { id: 'folder-parent', type: 'folder', name: 'Parent', parentId: null },
    { id: 'folder-child', type: 'folder', name: 'Child', parentId: 'folder-parent' }
  ] }, jobs));
  for (const changes of [
    { action: 'create-folder', id: 'folder-parent', name: 'Duplicate', parentId: null },
    { action: 'create-folder', id: 'invalid', name: 'Invalid', parentId: null },
    { action: 'create-folder', id: 'folder-new', name: ' ', parentId: null },
    { action: 'create-folder', id: 'folder-new', name: 'New', parentId: 'jazz' },
    { action: 'update-folder', id: 'jazz', name: 'Not a folder', parentId: null },
    { action: 'update-folder', id: 'folder-parent', name: 'Cycle', parentId: 'folder-child' },
    { action: 'move', id: 'folder-parent', parentId: 'folder-child', targetId: null, after: false },
    { action: 'move', id: 'jazz', parentId: null, targetId: 'folder-child', after: false },
    { action: 'move', id: 'jazz', parentId: null, targetId: 'missing', after: false },
    { action: 'move', id: 'jazz', parentId: null, targetId: 'soul', after: 'true' },
    { action: 'delete-folder', id: 'jazz' }, { action: 'delete-folder', id: 'missing' },
    { action: 'unknown', id: 'jazz', parentId: null }, { action: 'delete-folder', id: 'folder-parent', version: null }
  ]) {
    (await assert.rejects(async () => (await mutateLibraryEntry('alice', { version: initial.version, ...changes }, jobs)), { statusCode: 400 }));
    assert.deepEqual((await getLibrary('alice', jobs)), initial);
  }
  (await assert.rejects(async () => (await mutateLibraryEntry('alice', { version: 0, action: 'delete-folder', id: 'folder-parent' }, jobs)), { statusCode: 409 }));
  const full = (await setLibrary('alice', { ...initial, entries: [...initial.entries,
    ...Array.from({ length: 4995 }, (_, index) => ({ id: `folder-${index}`, type: 'folder', name: `Folder ${index}`, parentId: null }))]
  }, jobs));
  assert.ok(Buffer.byteLength(JSON.stringify(full.entries)) > 128 * 1024);
  (await assert.rejects(async () => (await mutateLibraryEntry('alice', { version: full.version, action: 'create-folder', id: 'folder-overflow', name: 'Overflow', parentId: null }, jobs)), { statusCode: 400 }));
  const renamed = (await mutateLibraryEntry('alice', { version: full.version, action: 'update-folder', id: 'folder-0', name: 'Renamed', parentId: null }, jobs));
  assert.equal(renamed.entries.length, 5000);
});

test('multiple folders are created atomically in one location and retain validation', async () => {
  const initial = (await addLibraryJobFiles('alice', { version: 0, jobId: 'jazz', playlistId: 'soul' }, jobs));
  const folders = [{ id: 'folder-first', name: ' First ' }, { id: 'folder-second', name: 'Second' }];
  const value = { version: initial.version, action: 'create-folders', parentId: null, folders };
  const created = (await mutateLibraryEntry('alice', value, jobs));
  assert.equal(created.version, initial.version + 1);
  assert.deepEqual(created.entries.slice(-2), folders.map((folder) => ({ ...folder, name: folder.name.trim(), type: 'folder', parentId: null })));
  for (const key of ['songOrder', 'playlistSongOrder', 'songMoves', 'songAdds', 'singleJobIds']) assert.deepEqual(created[key], initial[key]);
  (await assert.rejects(async () => (await mutateLibraryEntry('alice', value, jobs)), { statusCode: 409 }));
  const nested = (await mutateLibraryEntry('alice', { ...value, version: created.version, parentId: 'folder-first',
    folders: [{ id: 'folder-child-one', name: 'One' }, { id: 'folder-child-two', name: 'Two' }] }, jobs));
  assert.ok(nested.entries.slice(-2).every((entry) => entry.parentId === 'folder-first'));
  const valid = { id: 'folder-valid', name: 'Valid' };
  for (const changes of [
    { folders: null }, { folders: [] }, { folders: [valid, null] }, { folders: [valid, valid] },
    { folders: [valid, folders[0]] }, { folders: [valid, { id: 'invalid', name: 'Invalid' }] },
    { folders: [valid, { id: 'folder-blank', name: ' ' }] },
    { folders: [valid, { id: 'folder-long', name: 'x'.repeat(121) }] },
    { folders: [valid], parentId: 'jazz' }, { folders: [valid], parentId: 'missing' }
  ]) {
    (await assert.rejects(async () => (await mutateLibraryEntry('alice', { ...value, version: nested.version, ...changes }, jobs)), { statusCode: 400 }));
    assert.deepEqual((await getLibrary('alice', jobs)), nested);
  }
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', jobs)), nested);
  assert.ok((await getLibrary('bob', jobs)).entries.every((entry) => entry.type !== 'folder'));
  const full = (await setLibrary('alice', { ...nested, entries: [...nested.entries,
    ...Array.from({ length: 4999 - nested.entries.length }, (_, index) => ({ id: `folder-fill-${index}`, type: 'folder', name: `Folder ${index}`, parentId: null }))]
  }, jobs));
  (await assert.rejects(async () => (await mutateLibraryEntry('alice', { ...value, version: full.version,
    folders: [valid, { id: 'folder-overflow', name: 'Overflow' }] }, jobs)), { statusCode: 400 }));
  assert.deepEqual((await getLibrary('alice', jobs)), full);
});

test('bulk playlist moves are atomic, versioned and preserve tree and song order', async () => {
  const initial = (await mutateLibraryEntry('alice', { version: 0, action: 'create-folder', id: 'folder-bulk', name: 'Bulk', parentId: null }, jobs));
  const value = { version: initial.version, ids: ['soul', 'jazz'], parentId: 'folder-bulk' };
  const moved = (await moveLibraryPlaylists('alice', value, jobs));
  assert.deepEqual(getPlaylistIds(moved.entries, 'folder-bulk'), ['jazz', 'soul']);
  assert.deepEqual(moved.songOrder, initial.songOrder);
  (await assert.rejects(async () => (await moveLibraryPlaylists('alice', value, jobs)), { statusCode: 409 }));
  for (const ids of [[], ['jazz', 'jazz'], ['missing'], [null], [42], ['folder-bulk']]) {
    (await assert.rejects(async () => (await moveLibraryPlaylists('alice', { ...value, version: moved.version, ids }, jobs)), { statusCode: 400 }));
  }
  assert.deepEqual((await getLibrary('alice', jobs)), moved);
  assert.deepEqual((await getLibrary('bob', jobs)).entries.map((entry) => entry.parentId), [null, null, null]);
});

test('bulk songs link and move only selected memberships in source order without duplicates', async () => {
  const keys = ['Third.mp3', 'First.mp3'].map((name) => songKey({ jobId: 'jazz', name }));
  const value = { version: 0, sourcePlaylistId: 'jazz', playlistId: 'soul', keys, action: 'link' };
  const linked = (await transferLibrarySongs('alice', value, jobs));
  assert.deepEqual(getPlaylistTracks(linked, jobs).get('soul').map((track) => track.name), ['Soul.mp3', 'First.mp3', 'Third.mp3']);
  assert.equal(getPlaylistTracks(linked, jobs).get('jazz').length, 4);
  const again = (await transferLibrarySongs('alice', { ...value, version: linked.version }, jobs));
  assert.equal(again.songAdds.length, 2);
  const moved = (await transferLibrarySongs('alice', { version: again.version, sourcePlaylistId: 'soul', playlistId: 'live', keys, action: 'move' }, jobs));
  assert.deepEqual(getPlaylistTracks(moved, jobs).get('soul').map((track) => track.name), ['Soul.mp3']);
  assert.deepEqual(getPlaylistTracks(moved, jobs).get('live').map((track) => track.name), ['Live.mp3', 'First.mp3', 'Third.mp3']);
  assert.equal(getPlaylistTracks(moved, jobs).get('jazz').length, 4);
  const primary = (await transferLibrarySongs('alice', { ...value, version: moved.version, action: 'move', playlistId: 'live' }, jobs));
  assert.deepEqual(getPlaylistTracks(primary, jobs).get('jazz').map((track) => track.name), ['Second.mp3', 'notes.txt']);
  assert.equal(getPlaylistTracks(primary, jobs).get('live').length, 3);
  (await assert.rejects(async () => (await transferLibrarySongs('alice', value, jobs)), { statusCode: 409 }));
  for (const changes of [{ keys: [keys[0], 'missing'] }, { playlistId: 'missing' }, { keys: [keys[0], keys[0]] }, { action: 'delete' }]) {
    (await assert.rejects(async () => (await transferLibrarySongs('alice', { ...value, version: primary.version, ...changes }, jobs)), { statusCode: 400 }));
  }
  assert.deepEqual((await getLibrary('alice', jobs)), primary);
  assert.equal(getPlaylistTracks((await getLibrary('bob', jobs)), jobs).get('jazz').length, 4);
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', jobs)), primary);
});

test('unlinking preserves other memberships and accounts until the final link', async () => {
  const available = jobs.map((job) => ({ ...job, initiatedBy: { id: 'alice' }, contributors: [{ id: 'bob' }] }));
  const track = { jobId: 'jazz', name: 'First.mp3' };
  let library = (await transferLibrarySongs('alice', { version: 0, sourcePlaylistId: 'jazz', playlistId: 'soul', action: 'link', keys: [songKey(track)] }, available));
  assert.equal((await countLibraryFileLinks(available[0], track.name, available)), 3);
  assert.equal((await removeLibrarySongLink('alice', { ...track, version: library.version, playlistId: 'jazz' }, available, available)), true);
  library = (await getLibrary('alice', available));
  assert.equal(getPlaylistTracks(library, available).get('jazz').some((item) => item.name === track.name), false);
  assert.equal(getPlaylistTracks(library, available).get('soul').some((item) => item.name === track.name), true);
  const saved = (await setLibrary('alice', { ...library, songRemovals: [] }, available));
  assert.equal(saved.songRemovals.length, 1);
  assert.equal((await removeLibrarySongLink('alice', { ...track, version: saved.version, playlistId: 'soul' }, available, available)), true);
  (await closeDatabases());
  assert.equal([...getPlaylistTracks((await getLibrary('alice', available)), available).values()].flat().some((item) => songKey(item) === songKey(track)), false);
  assert.equal((await countLibraryFileLinks(available[0], track.name, available)), 1);
  assert.equal((await removeLibrarySongLink('bob', { ...track, version: 0, playlistId: 'jazz' }, available, available)), false);
  assert.equal((await getLibrary('bob', available)).version, 0);
  (await assert.rejects(async () => (await removeLibrarySongLink('alice', { ...track, version: 0, playlistId: 'jazz' }, available, available)), { statusCode: 409 }));
  const relinked = (await addLibraryJobFiles('alice', { version: (await getLibrary('alice', available)).version, jobId: 'jazz', playlistId: 'jazz' }, available));
  assert.equal(getPlaylistTracks(relinked, available).get('jazz').filter((item) => songKey(item) === songKey(track)).length, 1);
  const moved = (await moveLibrarySong('alice', { ...track, version: relinked.version, sourcePlaylistId: 'jazz', playlistId: 'live' }, available));
  const movedAgain = (await transferLibrarySongs('alice', { version: moved.version, sourcePlaylistId: 'live', playlistId: 'soul', action: 'move', keys: [songKey(track)] }, available));
  const memberships = [...getPlaylistTracks(movedAgain, available).values()].flat().filter((item) => songKey(item) === songKey(track));
  assert.deepEqual(memberships.map((item) => item.playlistId), ['soul']);
});

test('bulk transfers keep mixed source identities and preserve an existing destination membership', async () => {
  const available = jobs.map((job) => ({ ...job, files: ['Same.mp3'] }));
  const jazzKey = songKey({ jobId: 'jazz', name: 'Same.mp3' });
  const soulKey = songKey({ jobId: 'soul', name: 'Same.mp3' });
  const linked = (await transferLibrarySongs('alice', { version: 0, sourcePlaylistId: 'jazz', playlistId: 'soul', action: 'link', keys: [jazzKey] }, available));
  const moved = (await transferLibrarySongs('alice', { version: linked.version, sourcePlaylistId: 'soul', playlistId: 'jazz', action: 'move', keys: [jazzKey, soulKey] }, available));
  const memberships = getPlaylistTracks(moved, available);
  assert.deepEqual(memberships.get('soul'), []);
  assert.deepEqual(memberships.get('jazz').map(songKey), [jazzKey, soulKey]);
  assert.equal(moved.songAdds.length, 0);
});

test('file removal retains linked audio, rolls back failures and blocks links during final deletion', async (context) => {
  const outputDir = path.join(fixtureDirectory, 'audio');
  await fs.mkdir(outputDir);
  const name = 'First.mp3';
  const filePath = path.join(outputDir, name);
  await fs.writeFile(filePath, 'original audio');
  const available = jobs.map((job) => ({ ...job, outputDir: job.id === 'jazz' ? outputDir : null,
    url: `https://music.youtube.com/playlist?list=${job.id}`, playlistTitle: job.id,
    status: 'completed', initiatedBy: { id: 'alice' }, createdAt: new Date().toISOString() }));
  for (const job of available) (await writeJob(openDatabase(), job));
  const manager = await import(`../src/jobManager.js?library-delete=${Date.now()}`);
  const owner = { id: 'alice', role: 'user' };
  const key = songKey({ jobId: 'jazz', name });
  const linked = (await transferLibrarySongs('alice', { version: 0, action: 'link', sourcePlaylistId: 'jazz', playlistId: 'soul', keys: [key] }, available));
  await assert.rejects(manager.deleteJobFile('jazz', name, owner), { statusCode: 409 });
  await assert.rejects(manager.deleteJobFile('jazz', name, { id: 'bob', role: 'user' }, { version: 0, playlistId: 'jazz' }), { statusCode: 403 });
  const removed = await manager.deleteJobFile('jazz', name, owner, { version: linked.version, playlistId: 'jazz' });
  assert.equal(removed.fileDeleted, false);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'original audio');
  const current = (await getLibrary('alice', available));
  await assert.rejects(manager.deleteJobFile('jazz', name, owner, { version: linked.version, playlistId: 'soul' }), { statusCode: 409 });
  const originalUnlink = fs.unlink;
  const failure = context.mock.method(fs, 'unlink', async () => { throw Object.assign(new Error('File is locked'), { code: 'EACCES' }); });
  await assert.rejects(manager.deleteJobFile('jazz', name, owner, { version: current.version, playlistId: 'soul' }), { code: 'EACCES' });
  failure.mock.restore();
  assert.deepEqual((await getLibrary('alice', available)), current);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'original audio');
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const delayed = context.mock.method(fs, 'unlink', async (target) => { started(); await gate; return originalUnlink(target); });
  const deletion = manager.deleteJobFile('jazz', name, owner, { version: current.version, playlistId: 'soul' });
  await entered;
  try {
    (await assert.rejects(async () => (await transferLibrarySongs('alice', { version: current.version, action: 'link', sourcePlaylistId: 'soul', playlistId: 'live', keys: [key] }, available)), { statusCode: 409 }));
  } finally { release(); }
  assert.equal((await deletion).fileDeleted, true);
  delayed.mock.restore();
  assert.equal(await fs.stat(filePath).catch(() => null), null);
  assert.equal((await manager.getJob('jazz')).files.includes(name), false);
});

test('compact song reordering handles large playlists, preserves hidden songs and persists per account', async () => {
  const files = Array.from({ length: 3000 }, (_, index) => `Track ${index} ${'long filename '.repeat(8)}.mp3`);
  const available = [...jobs, { id: 'large', files }];
  const initial = (await setLibrary('alice', { ...(await getLibrary('alice', available)), songOrder: { large: files, soul: ['Soul.mp3'] } }, available));
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 128 * 1024);
  const move = { version: initial.version, playlistId: 'large', jobId: 'large', name: files[0],
    target: songKey({ jobId: 'large', name: files[2] }), after: true };
  assert.ok(Buffer.byteLength(JSON.stringify(move)) < 1024);
  const saved = (await reorderLibrarySong('alice', move, available));
  assert.equal(saved.version, initial.version + 1);
  assert.deepEqual(saved.songOrder.large, [files[1], files[2], files[0], ...files.slice(3)]);
  assert.deepEqual(saved.songOrder.soul, initial.songOrder.soul);
  assert.deepEqual(saved.entries, initial.entries);
  assert.deepEqual(getPlaylistTracks(saved, available).get('large').map((track) => track.name), saved.songOrder.large);
  assert.deepEqual(getPlaylistTracks((await getLibrary('bob', available)), available).get('large').map((track) => track.name), files);
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', available)), saved);
  const restored = (await reorderLibrarySong('alice', { ...move, version: saved.version,
    target: songKey({ jobId: 'large', name: files[1] }), after: false }, available));
  assert.deepEqual(restored.songOrder.large, files);
  assert.deepEqual(available.at(-1).files, files);
});

test('compact reorders support mixed source playlists and reject invalid or stale mutations', async () => {
  const single = { id: 'single', isPlaylist: false, files: ['Single.mp3'] };
  const available = [...jobs, single];
  let library = (await linkLibraryJob('alice', single, available));
  library = (await moveLibrarySong('alice', { version: library.version, jobId: 'jazz', name: 'First.mp3', playlistId: individualSongsId }, available));
  const move = { version: library.version, playlistId: individualSongsId, jobId: 'jazz', name: 'First.mp3',
    target: songKey({ jobId: 'single', name: 'Single.mp3' }), after: false };
  const saved = (await reorderLibrarySong('alice', move, available));
  assert.deepEqual(getPlaylistTracks(saved, available).get(individualSongsId).map((track) => track.name), ['First.mp3', 'Single.mp3']);
  assert.deepEqual(saved.songMoves, library.songMoves);
  assert.deepEqual(saved.singleJobIds, library.singleJobIds);
  (await assert.rejects(async () => (await reorderLibrarySong('alice', move, available)), { statusCode: 409 }));
  for (const changes of [{ version: null }, { playlistId: 'missing' }, { jobId: 'other' }, { name: 'notes.txt' },
    { target: songKey({ jobId: 'soul', name: 'Soul.mp3' }) }, { target: null }, { after: 'true' }]) {
    (await assert.rejects(async () => (await reorderLibrarySong('alice', { ...move, version: saved.version, ...changes }, available)), { statusCode: 400 }));
  }
  assert.deepEqual((await getLibrary('alice', available)), saved);
  assert.deepEqual((await reorderLibrarySong('alice', { ...move, version: saved.version, target: songKey(move) }, available)), saved);
});

test('library reconciles new and deleted jobs and songs without changing saved order', async () => {
  const initial = (await getLibrary('alice', jobs));
  (await setLibrary('alice', { ...initial, entries: [...initial.entries].reverse(), songOrder: { jazz: ['Third.mp3', 'First.mp3'] } }, jobs));
  const changed = [{ ...jobs[0], files: ['First.mp3', 'New.mp3'] }, jobs[2], { id: 'new', files: [] }];
  const reconciled = (await getLibrary('alice', changed));
  assert.deepEqual(getPlaylistIds(reconciled.entries), ['live', 'jazz', 'new']);
  assert.deepEqual(reconciled.songOrder.jazz, ['First.mp3']);
  assert.deepEqual(orderFiles(changed[0].files, reconciled.songOrder.jazz), ['First.mp3', 'New.mp3']);
});

test('individual links share one permanent personal playlist, even after every source job is deleted', async () => {
  const first = { id: 'single-one', isPlaylist: false, files: ['First.mp3'] };
  const second = { id: 'single-two', isPlaylist: false, files: [] };
  const available = [...jobs, first, second];
  assert.equal((await getLibrary('alice', available)).entries.some((entry) => entry.id === individualSongsId), false);
  const linked = (await linkLibraryJob('alice', first, available));
  assert.equal(linked.entries.filter((entry) => entry.id === individualSongsId).length, 1);
  assert.equal(linked.entries.find((entry) => entry.id === individualSongsId).name, 'Individual Songs');
  assert.equal(linked.entries.find((entry) => entry.id === individualSongsId).protected, true);
  assert.equal(linked.entries.some((entry) => entry.id === first.id), false);
  assert.deepEqual((await linkLibraryJob('alice', first, available)), linked);
  const both = (await linkLibraryJob('alice', second, available));
  assert.equal(both.entries.find((entry) => entry.id === individualSongsId).name, 'Individual Songs');
  const downloaded = available.map((job) => job.id === second.id ? { ...job, files: ['Second.mp3'] } : job);
  assert.deepEqual(getPlaylistTracks((await getLibrary('alice', downloaded)), downloaded).get(individualSongsId).map((track) => track.name), ['First.mp3', 'Second.mp3']);
  assert.equal((await getLibrary('bob', available)).entries.some((entry) => entry.id === individualSongsId), false);
  const removed = (await setLibrary('alice', { ...both, entries: both.entries.filter((entry) => entry.id !== individualSongsId), singleJobIds: [] }, available));
  assert.equal(removed.entries.some((entry) => entry.id === individualSongsId), true);
  (await closeDatabases());
  const empty = (await getLibrary('alice', jobs));
  assert.equal(empty.entries.find((entry) => entry.id === individualSongsId).name, 'Individual Songs');
  assert.equal(empty.entries.find((entry) => entry.id === individualSongsId).protected, true);
  assert.deepEqual(getPlaylistTracks(empty, jobs).get(individualSongsId), []);
});

test('songs move between personal playlists without losing source identity or leaking to other users', async () => {
  const single = { id: 'single', isPlaylist: false, files: ['First.mp3'] };
  const available = [...jobs, single];
  let library = (await linkLibraryJob('alice', single, available));
  library = (await moveLibrarySong('alice', { version: library.version, jobId: single.id, name: 'First.mp3', playlistId: 'jazz' }, available));
  assert.deepEqual(getPlaylistTracks(library, available).get(individualSongsId), []);
  const jazz = getPlaylistTracks(library, available).get('jazz');
  assert.equal(jazz.filter((track) => track.name === 'First.mp3').length, 2);
  assert.deepEqual(jazz.filter((track) => track.name === 'First.mp3').map((track) => track.jobId), ['jazz', 'single']);
  const reordered = [...jazz].filter((track) => track.name !== 'notes.txt').reverse().map(songKey);
  library = (await setLibrary('alice', { ...library, playlistSongOrder: { jazz: reordered } }, available));
  assert.equal(getPlaylistTracks(library, available).get('jazz')[0].jobId, 'single');
  library = (await moveLibrarySong('alice', { version: library.version, jobId: 'jazz', name: 'Third.mp3', playlistId: 'soul' }, available));
  assert.equal(getPlaylistTracks(library, available).get('jazz').some((track) => track.name === 'Third.mp3'), false);
  assert.equal(getPlaylistTracks(library, available).get('soul').at(-1).jobId, 'jazz');
  assert.equal(getPlaylistTracks((await getLibrary('bob', available)), available).get('jazz').some((track) => track.name === 'Third.mp3'), true);
  assert.deepEqual(jobs[0].files, ['First.mp3', 'Second.mp3', 'Third.mp3', 'notes.txt']);
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', available)), library);
  const deletedTarget = available.filter((job) => job.id !== 'soul');
  assert.equal(getPlaylistTracks((await getLibrary('alice', deletedTarget)), deletedTarget).get('jazz').some((track) => track.name === 'Third.mp3'), true);
});

test('song moves reject folders, unavailable songs and stale versions', async () => {
  const library = (await setLibrary('alice', { ...(await getLibrary('alice', jobs)), entries: [
    ...(await getLibrary('alice', jobs)).entries, { id: 'folder-target', name: 'Folder', type: 'folder', parentId: null }
  ] }, jobs));
  const move = { version: library.version, jobId: 'jazz', name: 'First.mp3', playlistId: 'soul' };
  for (const changes of [{ playlistId: 'folder-target' }, { playlistId: 'missing' }, { name: '../outside.mp3' }, { name: 'notes.txt' }, { jobId: 'missing' }]) {
    (await assert.rejects(async () => (await moveLibrarySong('alice', { ...move, ...changes }, jobs)), { statusCode: 400 }));
  }
  (await assert.rejects(async () => (await moveLibrarySong('alice', { ...move, version: 0 }, jobs)), { statusCode: 409 }));
  (await assert.rejects(async () => (await setLibrary('alice', { ...library, songMoves: [{ ...move, playlistId: 'folder-target' }] }, jobs)), { statusCode: 400 }));
  (await assert.rejects(async () => (await setLibrary('alice', { ...library, playlistSongOrder: { soul: [songKey(move)] } }, jobs)), { statusCode: 400 }));
  assert.deepEqual((await getLibrary('alice', jobs)), library);
});

test('all job media can be added atomically without removing source tracks or duplicating destination tracks', async () => {
  const available = [{ ...jobs[0], files: [...jobs[0].files, 'Movie.mp4'] }, ...jobs.slice(1)];
  const initial = (await setLibrary('alice', { ...(await getLibrary('alice', available)), songOrder: { jazz: ['Third.mp3', 'First.mp3'] } }, available));
  const result = (await addLibraryJobFiles('alice', { version: initial.version, jobId: 'jazz', playlistId: 'soul' }, available));
  assert.equal(result.addedCount, 4);
  assert.equal(result.version, initial.version + 1);
  const tracks = getPlaylistTracks(result, available);
  assert.equal(tracks.get('jazz').length, 5);
  assert.deepEqual(tracks.get('soul').map((track) => track.name), ['Soul.mp3', 'Third.mp3', 'First.mp3', 'Second.mp3', 'Movie.mp4']);
  assert.deepEqual(getPlaylistTracks((await getLibrary('bob', available)), available).get('soul').map((track) => track.name), ['Soul.mp3']);
  const repeat = (await addLibraryJobFiles('alice', { version: result.version, jobId: 'jazz', playlistId: 'soul' }, available));
  assert.equal(repeat.addedCount, 0);
  assert.equal(repeat.version, result.version);
  const saved = (await setLibrary('alice', { version: result.version, entries: result.entries, songOrder: result.songOrder }, available));
  (await closeDatabases());
  assert.deepEqual((await getLibrary('alice', available)), saved);
  assert.equal((await getLibrary('alice', available.map((job) => job.id === 'jazz' ? { ...job, files: ['Movie.mp4'] } : job))).songAdds.length, 1);
  assert.equal((await getLibrary('alice', available.filter((job) => job.id !== 'soul'))).songAdds.length, 0);
});

test('libraries retain more than 5000 song links across saves and later edits', async () => {
  const files = Array.from({ length: 5001 }, (_, index) => `Song ${index}.mp3`);
  const available = [{ id: 'large', files }, ...jobs];
  const added = (await addLibraryJobFiles('alice', { version: 0, jobId: 'large', playlistId: 'soul' }, available));
  assert.equal(added.addedCount, files.length);
  assert.equal(added.songAdds.length, files.length);
  (await closeDatabases());
  const reloaded = (await getLibrary('alice', available));
  assert.deepEqual(reloaded.songAdds, added.songAdds);
  assert.deepEqual(getPlaylistTracks(reloaded, available).get('soul').map((track) => track.name), ['Soul.mp3', ...files]);
  const saved = (await setLibrary('alice', { version: reloaded.version, entries: reloaded.entries, songOrder: reloaded.songOrder }, available));
  const expanded = (await addLibraryJobFiles('alice', { version: saved.version, jobId: 'jazz', playlistId: 'soul' }, available));
  assert.equal(expanded.songAdds.length, files.length + 3);
  (await assert.rejects(async () => (await setLibrary('alice', saved, available)), { statusCode: 409 }));
  (await assert.rejects(async () => (await setLibrary('alice', { ...expanded, songAdds: [...expanded.songAdds, expanded.songAdds[0]] }, available)), { statusCode: 400 }));
  assert.deepEqual((await getLibrary('alice', available)).songAdds, expanded.songAdds);
  assert.deepEqual((await getLibrary('bob', available)).songAdds, []);
});

test('moving an added entry preserves other memberships and never duplicates a destination entry', async () => {
  let library = (await addLibraryJobFiles('alice', { version: 0, jobId: 'jazz', playlistId: 'soul' }, jobs));
  const move = { jobId: 'jazz', name: 'First.mp3', sourcePlaylistId: 'soul', playlistId: 'live' };
  library = (await moveLibrarySong('alice', { ...move, version: library.version }, jobs));
  const contains = (id) => getPlaylistTracks(library, jobs).get(id).filter((track) => track.jobId === 'jazz' && track.name === 'First.mp3').length;
  assert.equal(contains('jazz'), 1);
  assert.equal(contains('soul'), 0);
  assert.equal(contains('live'), 1);
  (await assert.rejects(async () => (await moveLibrarySong('alice', { ...move, version: library.version }, jobs)), { statusCode: 400 }));
  library = (await moveLibrarySong('alice', { ...move, version: library.version, sourcePlaylistId: 'jazz' }, jobs));
  assert.equal(contains('jazz'), 0);
  assert.equal(contains('live'), 1);
  assert.equal(library.songAdds.some((track) => track.name === 'First.mp3'), false);
  library = (await addLibraryJobFiles('alice', { version: library.version, jobId: 'jazz', playlistId: 'soul' }, jobs));
  library = (await moveLibrarySong('alice', { ...move, version: library.version }, jobs));
  assert.equal(contains('soul'), 0);
  assert.equal(contains('live'), 1);
});

test('bulk additions reject stale versions, folders, unavailable jobs and empty jobs without partial writes', async () => {
  const available = [...jobs, { id: 'empty', files: ['notes.txt'] }];
  const initial = (await setLibrary('alice', { ...(await getLibrary('alice', available)), entries: [
    ...(await getLibrary('alice', available)).entries, { id: 'folder-target', type: 'folder', name: 'Folder', parentId: null }
  ] }, available));
  const value = { version: initial.version, jobId: 'jazz', playlistId: 'soul' };
  for (const changes of [{ playlistId: 'folder-target' }, { playlistId: 'missing' }, { jobId: 'empty' }, { version: null }]) {
    (await assert.rejects(async () => (await addLibraryJobFiles('alice', { ...value, ...changes }, available)), { statusCode: 400 }));
  }
  (await assert.rejects(async () => (await addLibraryJobFiles('alice', { ...value, jobId: 'missing' }, available)), { statusCode: 404 }));
  (await assert.rejects(async () => (await addLibraryJobFiles('alice', { ...value, version: 0 }, available)), { statusCode: 409 }));
  for (const songAdds of [null, [{ jobId: 'jazz', name: 'notes.txt', playlistId: 'soul' }], [{ jobId: 'jazz', name: 'First.mp3', playlistId: 'folder-target' }]]) {
    (await assert.rejects(async () => (await setLibrary('alice', { ...initial, songAdds }, available)), { statusCode: 400 }));
  }
  assert.deepEqual((await getLibrary('alice', available)), initial);
});

test('invalid library trees and song orders cannot overwrite saved data', async () => {
  const initial = (await getLibrary('alice', jobs));
  const folder = { id: 'folder-one', type: 'folder', parentId: null, name: 'One' };
  const invalidValues = [
    null,
    { ...initial, version: -1 },
    { ...initial, entries: [initial.entries[0], initial.entries[0]] },
    { ...initial, entries: [{ ...folder, parentId: folder.id }] },
    { ...initial, entries: [{ ...folder, parentId: 'folder-two' }, { ...folder, id: 'folder-two', parentId: folder.id }] },
    { ...initial, entries: [{ ...folder, parentId: 'jazz' }, ...initial.entries] },
    { ...initial, entries: [{ ...folder, name: ' ' }] },
    { ...initial, entries: [{ id: 'unknown', type: 'playlist', parentId: null }] },
    { ...initial, songOrder: { jazz: ['First.mp3', 'First.mp3'] } },
    { ...initial, songOrder: { jazz: ['../outside.mp3'] } },
    { ...initial, songOrder: { jazz: ['notes.txt'] } },
    { ...initial, songOrder: { unknown: [] } }
  ];
  for (const value of invalidValues) {
    (await assert.rejects(async () => (await setLibrary('alice', value, jobs)), { statusCode: 400 }));
    assert.deepEqual((await getLibrary('alice', jobs)), initial);
  }
  const deeplyNested = Array.from({ length: 33 }, (_, index) => ({
    id: `folder-${index}`, type: 'folder', name: 'Nested', parentId: index ? `folder-${index - 1}` : null
  }));
  (await assert.rejects(async () => (await setLibrary('alice', { ...initial, entries: deeplyNested }, jobs)), { statusCode: 400 }));
});

test('playlist and job submission share creation, duplicate, cancellation and permission behavior', async () => {
  const user = { id: 'alice', role: 'user' };
  const job = { id: 'existing', status: 'completed', initiatedBy: user, contributors: [] };
  let calls = [];
  const create = async (url, options) => { calls.push([url, options]); return job; };
  const created = await submitJobUrl(' https://music.youtube.com/watch?v=one ', { user, request: create, confirm: async () => assert.fail('No confirmation needed') });
  assert.deepEqual(created, { job, created: true });
  assert.equal(JSON.parse(calls[0][1].body).url, 'https://music.youtube.com/watch?v=one');
  for (const library of [false, true]) {
    for (const accepted of [false, true]) {
      calls = [];
      const duplicate = async (url) => {
        calls.push(url);
        if (url === '/api/jobs') throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: job });
        return job;
      };
      const result = await submitJobUrl('url', { request: duplicate, user, library, confirm: async (options) => {
        assert.equal(options.action, 'rerun'); return accepted;
      } });
      assert.deepEqual(result, accepted ? { job, created: false } : null);
      assert.deepEqual(calls, accepted ? ['/api/jobs', '/api/jobs/existing/rerun'] : ['/api/jobs']);
    }
  }
  for (const previous of [{ ...job, status: 'running' }, { ...job, status: 'running', initiatedBy: { id: 'bob' }, contributors: [user] }]) {
    const result = await submitJobUrl('url', { user, library: true, request: async (url) => {
      assert.equal(url, '/api/jobs');
      throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: previous });
    }, confirm: async (options) => { assert.equal(options.action, 'open'); assert.equal(options.label, 'Add Playlist'); return true; } });
    assert.equal(result.job, previous);
  }
  for (const role of ['user', 'admin']) {
    await assert.rejects(submitJobUrl('url', { user: { ...user, role }, library: true, request: async () => {
      throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: { ...job, initiatedBy: { id: 'bob' } } });
    }, confirm: async () => assert.fail('An unrelated playlist must not be offered') }), /contributor/);
  }
  await assert.rejects(submitJobUrl('bad', { user, request: async () => { throw new Error('Invalid URL'); } }), /Invalid URL/);
});

test('metadata-only submission applies to creation and leaves duplicate reruns as media downloads', async () => {
  const user = { id: 'alice', role: 'user' };
  const job = { id: 'existing', status: 'completed', initiatedBy: user, contributors: [] };
  for (const metadataOnly of [undefined, false, true]) {
    const result = await submitJobUrl(' https://music.youtube.com/playlist?list=manual ', {
      user, metadataOnly, confirm: async () => assert.fail('No confirmation needed'),
      request: async (url, options) => {
        assert.equal(url, '/api/jobs');
        assert.deepEqual(JSON.parse(options.body), { url: 'https://music.youtube.com/playlist?list=manual', metadataOnly: metadataOnly === true });
        return job;
      }
    });
    assert.deepEqual(result, { job, created: true });
  }
  const calls = [];
  const result = await submitJobUrl('url', {
    user, metadataOnly: true,
    request: async (url, options) => {
      calls.push([url, options]);
      if (url === '/api/jobs') throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: job });
      assert.deepEqual(options, { method: 'POST' });
      return job;
    },
    confirm: async (options) => {
      assert.equal(options.action, 'rerun');
      assert.match(options.message, /downloading missing ones/);
      return true;
    }
  });
  assert.deepEqual(result, { job, created: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], '/api/jobs/existing/rerun');
});

test('stale saves are rejected and deleting an account removes its preferences', async () => {
  const initial = (await getLibrary('alice', jobs));
  const saved = (await setLibrary('alice', initial, jobs));
  assert.equal(saved.version, 1);
  (await assert.rejects(async () => (await setLibrary('alice', initial, jobs)), { statusCode: 409 }));
  assert.deepEqual((await getLibrary('alice', jobs)), saved);
  (await openDatabase().prepare('DELETE FROM users WHERE id = $1').run('alice'));
  assert.equal((await openDatabase().prepare('SELECT count(*) AS count FROM user_preferences').get()).count, 0);
});