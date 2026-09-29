import { openDatabase, withTransaction } from './database.js';
import { rebuildPostgresLibrary } from './postgresCatalog.js';
import path from 'node:path';
import { getPlaylistTracks, individualSongsId, orderFiles, reconcileLibrary, songKey, themes } from './library.js';
import { isPlayableFile } from './media.js';

const removingSongs = new Set();

export function lockLibraryFile(job, name, jobs) {
  const aliases = jobs.filter((item) => item.outputDir && job.outputDir
    && path.resolve(item.outputDir, name) === path.resolve(job.outputDir, name)).map((item) => songKey({ jobId: item.id, name }));
  if (aliases.some((key) => removingSongs.has(key))) invalid('A song is being deleted. Refresh and try again.', 409);
  for (const key of aliases) removingSongs.add(key);
  return () => { for (const key of aliases) removingSongs.delete(key); };
}

function invalid(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

export async function getPreferences(userId) {
  const row = (await openDatabase().prepare('SELECT theme, theme_mode FROM user_preferences WHERE user_id = $1').get(userId));
  const theme = row?.theme || 'light';
  return { theme, mode: row?.theme_mode || (['black', 'midnight'].includes(theme) ? 'dark' : 'light') };
}

export async function setTheme(userId, theme, mode) {
  const current = (await getPreferences(userId));
  if (theme === undefined) theme = current.theme;
  if (mode === undefined) mode = current.mode;
  if (!themes.some((option) => option.id === theme)) invalid('Unknown theme');
  if (!['light', 'dark'].includes(mode)) invalid('Unknown theme mode');
  (await openDatabase().prepare(`INSERT INTO user_preferences (user_id, theme, theme_mode) VALUES ($1, $2, $3)
    ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, theme_mode = excluded.theme_mode`).run(userId, theme, mode));
  return { theme, mode };
}

export async function getLibrary(userId, jobs) {
  const row = (await openDatabase().prepare('SELECT library, library_version FROM user_preferences WHERE user_id = $1').get(userId));
  const library = row ? JSON.parse(row.library) : { entries: [], songOrder: {} };
  return { version: row?.library_version || 0, ...reconcileLibrary(library, jobs) };
}

function validateLibrary(value, jobs, current) {
  if (jobs.some((job) => job.files?.some((name) => removingSongs.has(songKey({ jobId: job.id, name }))))) {
    invalid('A song is being deleted. Refresh and try again.', 409);
  }
  if (!value || !Number.isSafeInteger(value.version) || value.version < 0
    || !Array.isArray(value.entries) || value.entries.length > 5000
    || !value.songOrder || typeof value.songOrder !== 'object' || Array.isArray(value.songOrder)) {
    invalid('Invalid music library');
  }
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const entryMap = new Map();
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || entryMap.has(entry.id)
      || !['folder', 'playlist'].includes(entry.type)
      || !(entry.parentId === null || typeof entry.parentId === 'string')) invalid('Invalid or duplicate library entry');
    const result = { id: entry.id, type: entry.type, parentId: entry.parentId };
    if (entry.type === 'folder') {
      if (!/^folder-[A-Za-z0-9_-]{1,100}$/.test(entry.id) || jobMap.has(entry.id)
        || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 120) invalid('Invalid folder');
      result.name = entry.name.trim();
    } else if (entry.id === individualSongsId) {
      if (!current.singleJobIds.length) invalid('Individual Songs is created when a song is linked');
      result.name = 'Individual Songs';
      result.protected = true;
    } else if (!jobMap.has(entry.id)) invalid('Playlist is no longer available');
    entryMap.set(entry.id, result);
    return result;
  });
  for (const entry of entries) {
    const visited = new Set([entry.id]);
    let parentId = entry.parentId;
    while (parentId !== null) {
      const parent = entryMap.get(parentId);
      if (visited.has(parentId) || parent?.type !== 'folder') invalid('Folders must form a tree without cycles');
      visited.add(parentId);
      if (visited.size > 32) invalid('Folders can be nested up to 32 levels');
      parentId = parent.parentId;
    }
  }
  const songOrder = Object.fromEntries(Object.entries(value.songOrder).map(([jobId, names]) => {
    const job = jobMap.get(jobId);
    const files = new Set(job?.files || []);
    if (!job || !Array.isArray(names) || new Set(names).size !== names.length
      || names.some((name) => typeof name !== 'string' || !isPlayableFile(name) || !files.has(name))) invalid('Invalid song order');
    return [jobId, names];
  }));
  const playlistIds = new Set(entries.filter((entry) => entry.type === 'playlist').map((entry) => entry.id));
  if (current.singleJobIds.length) playlistIds.add(individualSongsId);
  for (const id of current.singleJobIds) playlistIds.delete(id);
  const moves = value.songMoves === undefined ? current.songMoves : value.songMoves;
  if (!Array.isArray(moves)) invalid('Invalid song placements');
  const movedKeys = new Set();
  const songMoves = moves.map((track) => {
    const key = track && songKey(track);
    const job = jobMap.get(track?.jobId);
    if (!job || typeof track.name !== 'string' || !isPlayableFile(track.name) || !job.files?.includes(track.name)
      || !playlistIds.has(track.playlistId) || movedKeys.has(key)) invalid('Songs can only be moved to available playlists');
    movedKeys.add(key);
    return { jobId: track.jobId, name: track.name, playlistId: track.playlistId };
  });
  const additions = value.songAdds === undefined ? current.songAdds : value.songAdds;
  if (!Array.isArray(additions)) invalid('Invalid playlist additions');
  const addedKeys = new Set();
  const songAdds = additions.map((track) => {
    const key = track && JSON.stringify([track.playlistId, track.jobId, track.name]);
    const job = jobMap.get(track?.jobId);
    if (!job || typeof track.name !== 'string' || !isPlayableFile(track.name) || !job.files?.includes(track.name)
      || !playlistIds.has(track.playlistId) || addedKeys.has(key)) invalid('Files can only be added to available playlists');
    addedKeys.add(key);
    return { jobId: track.jobId, name: track.name, playlistId: track.playlistId };
  });
  const library = reconcileLibrary({ entries, songOrder, singleJobIds: current.singleJobIds, songMoves, songAdds, songRemovals: current.songRemovals }, jobs);
  const orders = value.playlistSongOrder === undefined ? current.playlistSongOrder : value.playlistSongOrder;
  if (!orders || typeof orders !== 'object' || Array.isArray(orders)) invalid('Invalid playlist song order');
  const playlistTracks = getPlaylistTracks(library, jobs);
  library.playlistSongOrder = Object.fromEntries(Object.entries(orders).map(([id, keys]) => {
    const allowed = new Set((playlistTracks.get(id) || []).filter((track) => isPlayableFile(track.name)).map(songKey));
    if (!playlistIds.has(id) || !Array.isArray(keys) || new Set(keys).size !== keys.length
      || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) invalid('Invalid playlist song order');
    return [id, keys];
  }));
  return library;
}

async function writeLibrary(userId, library, version) {
  (await openDatabase().prepare(`INSERT INTO user_preferences (user_id, library, library_version) VALUES ($1, $2, $3)
    ON CONFLICT(user_id) DO UPDATE SET library = excluded.library, library_version = excluded.library_version`)
    .run(userId, JSON.stringify(library), version));
  await rebuildPostgresLibrary(openDatabase(), userId);
}

export async function linkLibraryJob(userId, job, jobs) {
  const database = openDatabase();
  return (await withTransaction(database, async () => {
    const { version, ...current } = (await getLibrary(userId, jobs));
    if (job.isPlaylist === false && !current.singleJobIds.includes(job.id)) {
      current.singleJobIds.push(job.id);
      (await writeLibrary(userId, reconcileLibrary(current, jobs), version + 1));
    }
    return (await getLibrary(userId, jobs));
  }));
}

export async function setLibrary(userId, value, jobs) {
  const database = openDatabase();
  return (await withTransaction(database, async () => {
    const current = (await getLibrary(userId, jobs));
    const library = validateLibrary(value, jobs, current);
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    (await writeLibrary(userId, library, current.version + 1));
    return (await getLibrary(userId, jobs));
  }));
}

export async function mutateLibraryEntry(userId, value, jobs) {
  const database = openDatabase();
  return (await withTransaction(database, async () => {
    const current = (await getLibrary(userId, jobs));
    if (!value || !Number.isSafeInteger(value.version) || value.version < 0) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    if (value.action !== 'create-folders' && typeof value.id !== 'string') invalid('Invalid library entry');
    const entry = current.entries.find((item) => item.id === value.id);
    let entries;
    if (value.action === 'delete-folder') {
      if (entry?.type !== 'folder') invalid('Folder is no longer available');
      const children = current.entries.filter((item) => item.parentId === entry.id)
        .map((item) => ({ ...item, parentId: entry.parentId }));
      entries = current.entries.filter((item) => item.parentId !== entry.id);
      entries.splice(entries.findIndex((item) => item.id === entry.id), 1, ...children);
    } else {
      if (!(value.parentId === null || typeof value.parentId === 'string')) invalid('Invalid parent folder');
      if (value.parentId !== null && !current.entries.some((item) => item.id === value.parentId && item.type === 'folder')) {
        invalid('Parent folder is no longer available');
      }
      if (value.action === 'create-folders') {
        if (!Array.isArray(value.folders) || !value.folders.length
          || current.entries.length + value.folders.length > 5000) invalid('Invalid folder selection or library entry limit exceeded');
        entries = [...current.entries, ...value.folders.map((folder) => ({
          id: folder?.id, type: 'folder', name: folder?.name, parentId: value.parentId
        }))];
      } else if (value.action === 'create-folder') {
        if (entry) invalid('Library entry already exists');
        entries = [...current.entries, { id: value.id, type: 'folder', name: value.name, parentId: value.parentId }];
      } else if (value.action === 'update-folder') {
        if (entry?.type !== 'folder') invalid('Folder is no longer available');
        entries = current.entries.map((item) => item.id === entry.id ? { ...item, name: value.name, parentId: value.parentId } : item);
      } else if (value.action === 'move') {
        if (!entry) invalid('Library entry is no longer available');
        if (!(value.targetId === null || typeof value.targetId === 'string') || typeof value.after !== 'boolean') {
          invalid('Invalid library entry position');
        }
        const target = current.entries.find((item) => item.id === value.targetId);
        if (value.targetId !== null && (!target || target.parentId !== value.parentId || target.id === entry.id)) {
          invalid('Target entry is no longer in the destination folder');
        }
        entries = current.entries.filter((item) => item.id !== entry.id);
        const position = target ? entries.findIndex((item) => item.id === target.id) + (value.after ? 1 : 0) : entries.length;
        entries.splice(position, 0, { ...entry, parentId: value.parentId });
        if (entries.every((item, index) => item.id === current.entries[index].id && item.parentId === current.entries[index].parentId)) {
          return current;
        }
      } else invalid('Invalid library entry action');
    }
    return (await setLibrary(userId, { ...current, entries }, jobs));
  }));
}

function selectedItems(items, keys, keyFor) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 5000 || new Set(keys).size !== keys.length
    || keys.some((key) => typeof key !== 'string')) invalid('Invalid selection');
  const selected = new Set(keys);
  const result = items.filter((item) => selected.has(keyFor(item)));
  if (result.length !== keys.length) invalid('Selected items are no longer available');
  return result;
}

export async function moveLibraryPlaylists(userId, value, jobs) {
  return (await withTransaction(openDatabase(), async () => {
    const current = (await getLibrary(userId, jobs));
    if (!Number.isSafeInteger(value?.version) || value.version < 0) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    if (!(value.parentId === null || current.entries.some((entry) => entry.id === value.parentId && entry.type === 'folder'))) {
      invalid('Destination folder is no longer available');
    }
    const selected = selectedItems(current.entries, value.ids, (entry) => entry.id);
    if (selected.some((entry) => entry.type !== 'playlist')) invalid('Select playlists only');
    const ids = new Set(selected.map((entry) => entry.id));
    const entries = [...current.entries.filter((entry) => !ids.has(entry.id)),
      ...selected.map((entry) => ({ ...entry, parentId: value.parentId }))];
    return (await setLibrary(userId, { ...current, entries }, jobs));
  }));
}

export async function transferLibrarySongs(userId, value, jobs) {
  return (await withTransaction(openDatabase(), async () => {
    const current = (await getLibrary(userId, jobs));
    if (!Number.isSafeInteger(value?.version) || value.version < 0) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    if (!['move', 'link'].includes(value.action)) invalid('Choose move or link');
    const playlists = getPlaylistTracks(current, jobs);
    if (!playlists.has(value.sourcePlaylistId) || !playlists.has(value.playlistId)) invalid('Playlist is no longer available');
    const selected = selectedItems(playlists.get(value.sourcePlaylistId).filter((track) => isPlayableFile(track.name)), value.keys, songKey);
    if (value.sourcePlaylistId === value.playlistId) return current;
    const destination = playlists.get(value.playlistId).filter((track) => isPlayableFile(track.name)).map(songKey);
    const existing = new Set(destination);
    const selectedKeys = new Set(selected.map(songKey));
    const moves = new Map(current.songMoves.map((track) => [songKey(track), track.playlistId]));
    const removed = new Set(current.songRemovals.map(songKey));
    const primary = new Set(selected.filter((track) => !removed.has(songKey(track)) && (moves.get(songKey(track))
      || (current.singleJobIds.includes(track.jobId) ? individualSongsId : track.jobId)) === value.sourcePlaylistId).map(songKey));
    const placements = selected.map((track) => ({ jobId: track.jobId, name: track.name, playlistId: value.playlistId }));
    const moving = value.action === 'move';
    const songMoves = moving ? [...current.songMoves.filter((track) => !primary.has(songKey(track))),
      ...placements.filter((track) => primary.has(songKey(track)))] : current.songMoves;
    const songAdds = [...current.songAdds.filter((track) => !moving || !selectedKeys.has(songKey(track))
      || (track.playlistId !== value.sourcePlaylistId && !(primary.has(songKey(track)) && track.playlistId === value.playlistId))),
      ...placements.filter((track) => !existing.has(songKey(track)) && (!moving || !primary.has(songKey(track))))];
    return (await setLibrary(userId, { ...current, songMoves, songAdds, playlistSongOrder: { ...current.playlistSongOrder,
      ...(moving ? { [value.sourcePlaylistId]: (current.playlistSongOrder[value.sourcePlaylistId] || []).filter((key) => !selectedKeys.has(key)) } : {}),
      [value.playlistId]: [...destination, ...selected.map(songKey).filter((key) => !existing.has(key))]
    } }, jobs));
  }));
}

export async function reorderLibrarySong(userId, value, jobs) {
  const database = openDatabase();
  return (await withTransaction(database, async () => {
    const current = (await getLibrary(userId, jobs));
    if (!value || !Number.isSafeInteger(value.version) || value.version < 0) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    if (typeof value.jobId !== 'string' || typeof value.name !== 'string'
      || typeof value.target !== 'string' || typeof value.after !== 'boolean') invalid('Invalid song reorder');
    const tracks = getPlaylistTracks(current, jobs).get(value.playlistId)?.filter((track) => isPlayableFile(track.name));
    if (!tracks) invalid('Songs can only be reordered in available playlists');
    const from = tracks.findIndex((track) => songKey(track) === songKey(value));
    const target = tracks.findIndex((track) => songKey(track) === value.target);
    if (from < 0 || target < 0) invalid('Song is no longer in the playlist');
    if (from === target) return current;
    const [moved] = tracks.splice(from, 1);
    const destination = tracks.findIndex((track) => songKey(track) === value.target) + (value.after ? 1 : 0);
    tracks.splice(destination, 0, moved);
    const byJob = new Map();
    for (const track of tracks) {
      if (!byJob.has(track.jobId)) byJob.set(track.jobId, []);
      byJob.get(track.jobId).push(track.name);
    }
    const songOrder = { ...current.songOrder };
    for (const [jobId, names] of byJob) {
      const reordered = new Set(names);
      songOrder[jobId] = [...names, ...(songOrder[jobId] || []).filter((name) => !reordered.has(name))];
    }
    return (await setLibrary(userId, { ...current, songOrder,
      playlistSongOrder: { ...current.playlistSongOrder, [value.playlistId]: tracks.map(songKey) }
    }, jobs));
  }));
}

export async function moveLibrarySong(userId, value, jobs) {
  const database = openDatabase();
  return (await withTransaction(database, async () => {
    const current = (await getLibrary(userId, jobs));
    if (!value || !Number.isSafeInteger(value.version)) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    if (!current.entries.some((entry) => entry.id === value.playlistId && entry.type === 'playlist')) {
      invalid('Songs can only be moved to available playlists');
    }
    const job = jobs.find((item) => item.id === value.jobId);
    if (!job || typeof value.name !== 'string' || !isPlayableFile(value.name) || !job.files?.includes(value.name)) invalid('Song is no longer available');
    const key = songKey(value);
    const primaryId = current.songRemovals.some((track) => songKey(track) === key) ? null
      : current.songMoves.find((track) => songKey(track) === key)?.playlistId || (current.singleJobIds.includes(job.id) ? individualSongsId : job.id);
    const sourceId = value.sourcePlaylistId ?? primaryId;
    const playlists = getPlaylistTracks(current, jobs);
    if (!playlists.get(sourceId)?.some((track) => songKey(track) === key)) invalid('Song is no longer in the source playlist');
    if (sourceId === value.playlistId) return current;
    const destination = playlists.get(value.playlistId).filter((track) => isPlayableFile(track.name)).map(songKey);
    const placement = { jobId: value.jobId, name: value.name, playlistId: value.playlistId };
    const songAdds = current.songAdds.filter((track) => songKey(track) !== key
      || (track.playlistId !== sourceId && (sourceId !== primaryId || track.playlistId !== value.playlistId)));
    const songMoves = sourceId === primaryId
      ? [...current.songMoves.filter((track) => songKey(track) !== key), placement] : current.songMoves;
    if (sourceId !== primaryId && !destination.includes(key)) songAdds.push(placement);
    const playlistSongOrder = { ...current.playlistSongOrder,
      [sourceId]: (current.playlistSongOrder[sourceId] || []).filter((item) => item !== key),
      [value.playlistId]: destination.includes(key) ? destination : [...destination, key]
    };
    return (await setLibrary(userId, { ...current, songMoves, songAdds, playlistSongOrder }, jobs));
  }));
}

export async function addLibraryJobFiles(userId, value, jobs) {
  const database = openDatabase();
  return (await withTransaction(database, async () => {
    const current = (await getLibrary(userId, jobs));
    if (!value || !Number.isSafeInteger(value.version)) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    const playlists = getPlaylistTracks(current, jobs);
    if (!playlists.has(value.playlistId)) invalid('Files can only be added to available playlists');
    const job = jobs.find((item) => item.id === value.jobId);
    if (!job) invalid('Job is no longer available', 404);
    const files = orderFiles(job.files || [], current.songOrder[job.id]).filter(isPlayableFile);
    if (!files.length) invalid('This job has no media files to add');
    const destination = playlists.get(value.playlistId).filter((track) => isPlayableFile(track.name)).map(songKey);
    const existing = new Set(destination);
    const additions = files.map((name) => ({ jobId: job.id, name, playlistId: value.playlistId }))
      .filter((track) => !existing.has(songKey(track)));
    if (!additions.length) return { ...current, addedCount: 0 };
    const library = (await setLibrary(userId, { ...current,
      songAdds: [...current.songAdds, ...additions],
      playlistSongOrder: { ...current.playlistSongOrder, [value.playlistId]: [...destination, ...additions.map(songKey)] }
    }, jobs));
    return { ...library, addedCount: additions.length };
  }));
}

export async function countLibraryFileLinks(job, name, jobs) {
  let count = 0;
  const aliases = new Set(jobs.filter((item) => item.id === job.id || (item.outputDir && job.outputDir
    && path.resolve(item.outputDir, name) === path.resolve(job.outputDir, name))).map((item) => item.id));
  for (const { id } of (await openDatabase().prepare('SELECT id FROM users').all())) {
    const available = jobs.filter((item) => item.initiatedBy?.id === id || item.contributors?.some((user) => user.id === id));
    if (!available.some((item) => aliases.has(item.id))) continue;
    const library = (await getLibrary(id, available));
    for (const tracks of getPlaylistTracks(library, available).values()) {
      count += tracks.filter((track) => aliases.has(track.jobId) && track.name === name).length;
    }
  }
  return count;
}

export async function removeLibrarySongLink(userId, value, jobs, allJobs) {
  return (await withTransaction(openDatabase(), async () => {
    const current = (await getLibrary(userId, jobs));
    if (!Number.isSafeInteger(value?.version) || value.version < 0) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    const key = songKey(value);
    if (removingSongs.has(key)) invalid('A song is being deleted. Refresh and try again.', 409);
    const tracks = getPlaylistTracks(current, jobs).get(value.playlistId);
    if (!tracks?.some((track) => songKey(track) === key)) invalid('Song is no longer in the playlist');
    const job = jobs.find((item) => item.id === value.jobId);
    if ((await countLibraryFileLinks(job, value.name, allJobs)) <= 1) return false;
    const primaryId = current.songMoves.find((track) => songKey(track) === key)?.playlistId
      || (current.singleJobIds.includes(job.id) ? individualSongsId : job.id);
    const songRemovals = [...current.songRemovals];
    if (primaryId === value.playlistId && !songRemovals.some((track) => songKey(track) === key)) {
      songRemovals.push({ jobId: value.jobId, name: value.name });
    }
    const library = reconcileLibrary({ ...current, songRemovals,
      songAdds: current.songAdds.filter((track) => !(songKey(track) === key && track.playlistId === value.playlistId)),
      playlistSongOrder: { ...current.playlistSongOrder,
        [value.playlistId]: (current.playlistSongOrder[value.playlistId] || []).filter((item) => item !== key) }
    }, jobs);
    (await writeLibrary(userId, library, current.version + 1));
    return true;
  }));
}