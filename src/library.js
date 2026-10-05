export const themes = [
  { id: 'midnight', name: 'Midnight blue', color: '#5f7ff0' },
  { id: 'royal-purple', name: 'Royal purple', color: '#7139c6' },
  { id: 'gold', name: 'Gold', color: '#a77a0a' },
  { id: 'green', name: 'Green', color: '#227452' },
  { id: 'pink', name: 'Pink', color: '#bf3d78' },
  { id: 'black', name: 'Black', color: '#202124' }
];

export function orderFiles(files, order = []) {
  const positions = new Map(order.map((name, index) => [name, index]));
  const position = (file) => positions.get(typeof file === 'string' ? file : file.name) ?? Number.MAX_SAFE_INTEGER;
  return [...files].sort((first, second) => position(first) - position(second));
}

export const individualSongsId = 'individual-songs';
export const individualVideosId = 'individual-videos';
export const individualPlaylistNames = {
  [individualSongsId]: 'Individual Songs',
  [individualVideosId]: 'Individual Videos'
};

export function individualPlaylistId(job) {
  return job.downloadType === 'video' ? individualVideosId : individualSongsId;
}

export function jobPlaylistId(library, job) {
  return library.singleJobIds?.includes(job.id) ? individualPlaylistId(job) : job.id;
}

export const songMetadataFields = ['title', 'artist', 'album', 'performerInfo', 'genre', 'year', 'trackNumber', 'partOfSet'];

export function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\u0111/g, 'd');
}

export function songSearchText(track) {
  return normalizeSearchText([...songMetadataFields, 'name', 'playlistTitle'].map((field) => track[field])
    .filter((value) => typeof value === 'string' && value).join(' '));
}

export function songKey(track) {
  return JSON.stringify([track.jobId, track.name]);
}

export function isNoVocals(track) {
  return track.name.toLowerCase().startsWith('[novocals]/');
}

export function songStem(name) {
  return name.split('/').at(-1).replace(/\.[^.]+$/, '').replace(/(?:\[no[ _-]?vocals\]|[ _-]+no[ _-]?vocals)/gi, '').trim().toLowerCase();
}

export function countDownloadedFiles(files) {
  return (files || []).filter((file) => !isNoVocals(typeof file === 'string' ? { name: file } : file)).length;
}

export function findNoVocals(track, tracks) {
  if (!track || isNoVocals(track)) return null;
  const candidates = tracks.filter((candidate) => candidate.jobId === track.jobId && isNoVocals(candidate));
  if (track.noVocalsName) return candidates.find((candidate) => candidate.name === track.noVocalsName) || null;
  const matches = candidates.filter((candidate) => songStem(candidate.name) === songStem(track.name));
  return matches.length === 1 ? matches[0] : null;
}

export function getPlaylistTracks(library, jobs) {
  const playlists = new Map(library.entries.filter((entry) => entry.type === 'playlist').map((entry) => [entry.id, []]));
  const singles = new Set(library.singleJobIds || []);
  const removed = new Set((library.songRemovals || []).map(songKey));
  const moves = new Map((library.songMoves || []).map((track) => [songKey(track), track.playlistId]));
  const additions = new Map();
  for (const track of library.songAdds || []) {
    const key = songKey(track);
    if (!additions.has(key)) additions.set(key, new Set());
    additions.get(key).add(track.playlistId);
  }
  for (const job of jobs) {
    for (const name of orderFiles(job.files || [], library.songOrder[job.id])) {
      const track = { jobId: job.id, name };
      const playlistId = moves.get(songKey(track)) || (singles.has(job.id) ? individualPlaylistId(job) : job.id);
      if (!removed.has(songKey(track))) playlists.get(playlistId)?.push({ ...track, playlistId });
      for (const addedId of additions.get(songKey(track)) || []) {
        if (addedId !== playlistId || removed.has(songKey(track))) playlists.get(addedId)?.push({ ...track, playlistId: addedId });
      }
    }
  }
  for (const [id, tracks] of playlists) {
    const positions = new Map((library.playlistSongOrder?.[id] || []).map((key, index) => [key, index]));
    tracks.sort((first, second) => (positions.get(songKey(first)) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(songKey(second)) ?? Number.MAX_SAFE_INTEGER));
  }
  return playlists;
}

export function getPlaylistIds(entries, selectedId = null) {
  if (selectedId !== null) {
    const selected = entries.find((entry) => entry.id === selectedId);
    if (!selected) return [];
    if (selected.type === 'playlist') return [selected.id];
  }
  const children = new Map();
  for (const entry of entries) {
    if (!children.has(entry.parentId)) children.set(entry.parentId, []);
    children.get(entry.parentId).push(entry);
  }
  const visit = (parentId) => (children.get(parentId) || []).flatMap((entry) => (
    entry.type === 'playlist' ? [entry.id] : visit(entry.id)
  ));
  return visit(selectedId);
}

export function reconcileLibrary(library, jobs) {
  const jobIds = new Set(jobs.map((job) => job.id));
  const singleJobIds = library.singleJobIds || [];
  const singles = new Set(singleJobIds);
  const singleVideoJobIds = [...new Set([...(library.singleVideoJobIds || []),
    ...jobs.filter((job) => singles.has(job.id) && job.downloadType === 'video').map((job) => job.id)])];
  const videoSingles = new Set(singleVideoJobIds);
  const individualIds = new Set([
    ...(singleJobIds.some((id) => !videoSingles.has(id)) || library.entries.some((entry) => entry.id === individualSongsId)
      ? [individualSongsId] : []),
    ...(videoSingles.size ? [individualVideosId] : [])
  ]);
  const entries = library.entries.filter((entry) => entry.type === 'folder'
    || (Object.hasOwn(individualPlaylistNames, entry.id) ? individualIds.has(entry.id) : jobIds.has(entry.id) && !singles.has(entry.id)))
    .map((entry) => individualIds.has(entry.id) ? { ...entry, name: individualPlaylistNames[entry.id], protected: true } : entry);
  const included = new Set(entries.map((entry) => entry.id));
  for (const job of jobs) {
    if (!included.has(job.id) && !singles.has(job.id)) entries.push({ id: job.id, type: 'playlist', parentId: null });
  }
  for (const id of individualIds) {
    if (!included.has(id)) entries.push({ id, type: 'playlist', parentId: null, name: individualPlaylistNames[id], protected: true });
  }
  const songOrder = Object.fromEntries(jobs.filter((job) => Object.hasOwn(library.songOrder, job.id)).map((job) => {
    const files = new Set(job.files || []);
    return [job.id, library.songOrder[job.id].filter((name) => files.has(name))];
  }));
  const files = new Map(jobs.map((job) => [job.id, new Set(job.files || [])]));
  const playlistIds = new Set(entries.filter((entry) => entry.type === 'playlist').map((entry) => entry.id));
  const songMoves = (library.songMoves || []).filter((track) => files.get(track.jobId)?.has(track.name) && playlistIds.has(track.playlistId));
  const songAdds = (library.songAdds || []).filter((track) => files.get(track.jobId)?.has(track.name) && playlistIds.has(track.playlistId));
  const songRemovals = (library.songRemovals || []).filter((track) => files.get(track.jobId)?.has(track.name));
  const result = { entries, songOrder, singleJobIds, singleVideoJobIds, songMoves, songAdds, songRemovals, playlistSongOrder: {} };
  const playlistTracks = getPlaylistTracks(result, jobs);
  result.playlistSongOrder = Object.fromEntries(Object.entries(library.playlistSongOrder || {}).filter(([id]) => playlistIds.has(id)).map(([id, order]) => {
    const keys = new Set(playlistTracks.get(id).map(songKey));
    return [id, order.filter((key) => keys.has(key))];
  }));
  return result;
}