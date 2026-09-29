import { getPlaylistIds, getPlaylistTracks, individualSongsId, isNoVocals, reconcileLibrary, songKey, songStem } from './library.js';
import { mediaType } from './media.js';

function hydrate(job, rows) {
  job.files = rows.map((row) => row.name);
  const metadata = rows.filter((row) => row.metadata !== '{}').map((row) => [row.name, JSON.parse(row.metadata)]);
  const transcriptions = rows.filter((row) => row.transcription).map((row) => [row.name, JSON.parse(row.transcription)]);
  if (metadata.length || Object.hasOwn(job, 'songMetadata')) job.songMetadata = { ...job.songMetadata, ...Object.fromEntries(metadata) };
  if (transcriptions.length || Object.hasOwn(job, 'transcriptions')) job.transcriptions = { ...job.transcriptions, ...Object.fromEntries(transcriptions) };
  return job;
}

export async function readPostgresJob(database, id) {
  const record = await database.prepare('SELECT data FROM jobs WHERE id = $1').get(id);
  if (!record) return undefined;
  return hydrate(JSON.parse(record.data), await database.prepare('SELECT name, metadata, transcription FROM songs WHERE job_id = $1 ORDER BY file_order').all(id));
}

export async function readPostgresJobs(database, userId) {
  const filter = userId === undefined ? '' : ' WHERE EXISTS (SELECT 1 FROM job_users WHERE job_id = jobs.id AND user_id = $1)';
  const parameters = userId === undefined ? [] : [userId];
  const records = await database.prepare(`SELECT id, data FROM jobs${filter} ORDER BY created_at DESC, id`).all(...parameters);
  const rows = await database.prepare(`SELECT songs.* FROM songs JOIN jobs ON jobs.id = songs.job_id${filter} ORDER BY job_id, file_order`).all(...parameters);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.job_id)) grouped.set(row.job_id, []);
    grouped.get(row.job_id).push(row);
  }
  return records.map((record) => hydrate(JSON.parse(record.data), grouped.get(record.id) || []));
}

async function insertRows(database, sql, rows) {
  for (let offset = 0; offset < rows.length; offset += 1000) {
    await database.prepare(sql).run(JSON.stringify(rows.slice(offset, offset + 1000)));
  }
}

export async function rebuildPostgresLibrary(database, userId) {
  if (!await database.prepare('SELECT id FROM users WHERE id = $1').get(userId)) return;
  const saved = await database.prepare('SELECT library FROM user_preferences WHERE user_id = $1').get(userId);
  const jobs = await readPostgresJobs(database, userId);
  const library = reconcileLibrary(saved ? JSON.parse(saved.library) : { entries: [], songOrder: {} }, jobs);
  const playlists = getPlaylistTracks(library, jobs);
  const playlistOrder = new Map(getPlaylistIds(library.entries).map((id, position) => [id, position]));
  await database.prepare('DELETE FROM library_entries WHERE user_id = $1').run(userId);
  await database.prepare('DELETE FROM user_songs WHERE user_id = $1').run(userId);
  await insertRows(database, `INSERT INTO library_entries (user_id, id, parent_id, entry_type, position, playlist_position, song_count, data)
    SELECT user_id, id, parent_id, entry_type, position, playlist_position, song_count, data FROM jsonb_to_recordset($1::jsonb)
    AS entry(user_id text, id text, parent_id text, entry_type text, position integer, playlist_position integer, song_count bigint, data jsonb)`,
  library.entries.map((entry, position) => ({ user_id: userId, id: entry.id, parent_id: entry.parentId,
    entry_type: entry.type, position, playlist_position: playlistOrder.get(entry.id) ?? null,
    song_count: (playlists.get(entry.id) || []).filter((track) => mediaType(track.name)).length, data: entry })));
  const unique = new Map();
  for (const id of getPlaylistIds(library.entries)) {
    const memberships = [];
    for (const [position, track] of (playlists.get(id) || []).entries()) {
      if (!mediaType(track.name)) continue;
      const record = { user_id: userId, playlist_id: id, job_id: track.jobId, name: track.name, position };
      memberships.push(record);
      if (!unique.has(songKey(track))) unique.set(songKey(track), { ...record, playlist_position: playlistOrder.get(id) });
    }
    await insertRows(database, `INSERT INTO library_memberships (user_id, playlist_id, job_id, name, position)
      SELECT user_id, playlist_id, job_id, name, position FROM jsonb_to_recordset($1::jsonb)
      AS entry(user_id text, playlist_id text, job_id text, name text, position bigint)`, memberships);
  }
  await insertRows(database, `INSERT INTO user_songs (user_id, job_id, name, playlist_id, playlist_position, position)
    SELECT user_id, job_id, name, playlist_id, playlist_position, position FROM jsonb_to_recordset($1::jsonb)
    AS entry(user_id text, job_id text, name text, playlist_id text, playlist_position integer, position bigint)`, [...unique.values()]);
  await database.prepare(`INSERT INTO user_catalog (user_id, total_songs, revision) VALUES ($1, $2, 1)
    ON CONFLICT(user_id) DO UPDATE SET total_songs = excluded.total_songs, revision = user_catalog.revision + 1`).run(userId, unique.size);
}

export async function writePostgresJob(database, job) {
  return database.withTransaction(async () => {
    const previous = await database.prepare('SELECT name FROM songs WHERE job_id = $1 ORDER BY file_order').all(job.id);
    const previousUsers = (await database.prepare('SELECT user_id FROM job_users WHERE job_id = $1').all(job.id)).map((row) => row.user_id);
    const users = [...new Set([job.initiatedBy?.id, ...(job.contributors || []).map((user) => user.id)].filter(Boolean))];
    const files = job.files || [];
    const inventoryChanged = previous.length !== files.length || previous.some((row, index) => row.name !== files[index]);
    const ownershipChanged = previousUsers.length !== users.length || users.some((id) => !previousUsers.includes(id));
    const header = { ...job, files: [] };
    const fileNames = new Set(files);
    if (header.songMetadata) header.songMetadata = Object.fromEntries(Object.entries(header.songMetadata).filter(([name]) => !fileNames.has(name)));
    if (header.transcriptions) header.transcriptions = Object.fromEntries(Object.entries(header.transcriptions).filter(([name]) => !fileNames.has(name)));
    await database.prepare(`INSERT INTO jobs (id, url, status, created_at, data, song_count) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url, status = excluded.status,
        created_at = excluded.created_at, data = excluded.data, song_count = excluded.song_count`)
      .run(job.id, job.url.trim(), job.status, job.createdAt || '', JSON.stringify(header), files.filter(mediaType).length);
    await database.prepare('DELETE FROM job_users WHERE job_id = $1').run(job.id);
    for (const userId of users) await database.prepare('INSERT INTO job_users (job_id, user_id) VALUES ($1, $2)').run(job.id, userId);
    await insertRows(database, `INSERT INTO songs (job_id, name, file_order, media_type, metadata, transcription, search_text, karaoke_stem)
      SELECT job_id, name, file_order, media_type, metadata, transcription, search_text, karaoke_stem FROM jsonb_to_recordset($1::jsonb)
      AS song(job_id text, name text, file_order integer, media_type text, metadata jsonb, transcription jsonb, search_text text, karaoke_stem text)
      ON CONFLICT(job_id, name) DO UPDATE SET file_order = excluded.file_order, media_type = excluded.media_type,
        metadata = excluded.metadata, transcription = excluded.transcription, search_text = excluded.search_text, karaoke_stem = excluded.karaoke_stem
      WHERE (songs.file_order, songs.media_type, songs.metadata, songs.transcription, songs.search_text, songs.karaoke_stem)
        IS DISTINCT FROM (excluded.file_order, excluded.media_type, excluded.metadata, excluded.transcription, excluded.search_text, excluded.karaoke_stem)`,
    files.map((name, position) => {
      const metadata = job.songMetadata?.[name] || {};
      return { job_id: job.id, name, file_order: position, media_type: mediaType(name), metadata,
        transcription: job.transcriptions?.[name] || null, karaoke_stem: isNoVocals({ name }) ? songStem(name) : null,
        search_text: `${metadata.title || ''} ${metadata.artist || ''} ${name} ${job.playlistTitle || ''}`.toLowerCase() };
    }));
    await database.prepare('DELETE FROM songs WHERE job_id = $1 AND name NOT IN (SELECT jsonb_array_elements_text($2::jsonb))').run(job.id, JSON.stringify(files));
    if (inventoryChanged || ownershipChanged) {
      for (const userId of new Set([...users, ...previousUsers])) await rebuildPostgresLibrary(database, userId);
    } else {
      await database.prepare('UPDATE user_catalog SET revision = revision + 1 WHERE user_id IN (SELECT user_id FROM job_users WHERE job_id = $1)').run(job.id);
    }
  });
}

export async function readPostgresLibrary(database, userId) {
  const preferences = await database.prepare('SELECT library_version FROM user_preferences WHERE user_id = $1').get(userId);
  const catalog = await database.prepare('SELECT total_songs, revision FROM user_catalog WHERE user_id = $1').get(userId);
  const entryRows = await database.prepare('SELECT data, id, song_count FROM library_entries WHERE user_id = $1 ORDER BY position, id').all(userId);
  const entries = entryRows.map((row) => JSON.parse(row.data));
  const jobs = (await database.prepare(`SELECT jobs.data - 'output' - 'command' AS data, jobs.song_count,
    EXISTS (SELECT 1 FROM songs WHERE job_id = jobs.id AND transcription->>'status' = 'sent') AS pending
    FROM jobs JOIN library_entries ON library_entries.id = jobs.id WHERE library_entries.user_id = $1`).all(userId))
    .map((row) => {
      const job = JSON.parse(row.data);
      return { ...job, contributors: job.contributors || [], transcriptions: {}, songCount: row.song_count, transcriptionPending: row.pending };
    });
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const counts = new Map(entryRows.map((row) => [row.id, row.song_count]));
  return { version: preferences?.library_version || 0, catalogRevision: catalog?.revision || 0, serverPagination: true, entries, songOrder: {}, jobs,
    songCount: catalog?.total_songs || 0,
    playlists: entries.filter((entry) => entry.type === 'playlist').map((entry) => ({ id: entry.id,
      jobId: jobMap.has(entry.id) ? entry.id : null, playlistTitle: entry.name || jobMap.get(entry.id)?.playlistTitle,
      protected: Boolean(entry.protected), status: jobMap.get(entry.id)?.status || 'completed',
      initiatedBy: jobMap.get(entry.id)?.initiatedBy, contributors: jobMap.get(entry.id)?.contributors || [],
      updatedAt: jobMap.get(entry.id)?.updatedAt, songCount: counts.get(entry.id) || 0 })) };
}

export async function pagePostgresTracks(database, userId, { entryId = null, page = 1, pageSize = 50, search = '' } = {}) {
  const entries = (await database.prepare('SELECT data FROM library_entries WHERE user_id = $1 ORDER BY position, id').all(userId)).map((row) => JSON.parse(row.data));
  if (entryId !== null && !entries.some((entry) => entry.id === entryId)) throw Object.assign(new Error('Library selection not found'), { statusCode: 404 });
  const selected = getPlaylistIds(entries, entryId);
  const source = entryId === null ? 'SELECT * FROM user_songs WHERE user_id = $1' : `SELECT DISTINCT ON (membership.job_id, membership.name)
    membership.*, entry.playlist_position FROM library_memberships membership
    JOIN library_entries entry ON entry.user_id = membership.user_id AND entry.id = membership.playlist_id
    WHERE membership.user_id = $1 AND membership.playlist_id IN (SELECT jsonb_array_elements_text($2::jsonb))
    ORDER BY membership.job_id, membership.name, entry.playlist_position, membership.position`;
  const parameters = entryId === null ? [userId] : [userId, JSON.stringify(selected)];
  const filter = search ? `WHERE songs.search_text LIKE $${parameters.length + 1} ESCAPE '\\'` : '';
  if (search) parameters.push(`%${search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  const from = `FROM (${source}) membership JOIN songs ON songs.job_id = membership.job_id AND songs.name = membership.name`;
  const count = !search && entryId === null
    ? (await database.prepare('SELECT total_songs AS count FROM user_catalog WHERE user_id = $1').get(userId))?.count || 0
    : (await database.prepare(`SELECT count(*) AS count ${from} ${filter}`).get(...parameters)).count;
  const totalPages = pageSize === null ? 1 : Math.max(1, Math.ceil(count / pageSize));
  const selectedPage = Math.min(page, totalPages);
  const orderedPage = `SELECT membership.* ${search ? `${from} ${filter}` : `FROM (${source}) membership`}
    ORDER BY membership.playlist_position, membership.position, membership.job_id, membership.name LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`;
  const rows = await database.prepare(`SELECT membership.*, songs.metadata, songs.transcription,
    jobs.data - 'output' - 'command' AS job_data,
    EXISTS (SELECT 1 FROM songs pending WHERE pending.job_id = jobs.id AND pending.transcription->>'status' = 'sent') AS transcription_pending
    FROM (${orderedPage}) membership JOIN songs ON songs.job_id = membership.job_id AND songs.name = membership.name
    JOIN jobs ON jobs.id = songs.job_id
    ORDER BY membership.playlist_position, membership.position, membership.job_id, membership.name`)
    .all(...parameters, pageSize, pageSize === null ? 0 : (selectedPage - 1) * pageSize);
  const version = (await database.prepare('SELECT library_version FROM user_preferences WHERE user_id = $1').get(userId))?.library_version || 0;
  return { version, page: selectedPage, pageSize, total: count, totalPages, files: rows.map((row) => {
    const job = JSON.parse(row.job_data);
    return { ...JSON.parse(row.metadata), jobId: row.job_id, name: row.name, playlistId: row.playlist_id,
      playlistTitle: row.playlist_id === individualSongsId ? 'Individual Songs' : job.playlistTitle,
      transcription: row.transcription ? JSON.parse(row.transcription) : null, sourceJob: { ...job, transcriptionPending: row.transcription_pending } };
  }) };
}

export async function updatePostgresSong(database, job, name, field, value) {
  if (!['metadata', 'transcription'].includes(field)) throw new Error('Unsupported song update');
  await database.withTransaction(async () => {
    const result = field === 'metadata'
      ? await database.prepare(`UPDATE songs SET metadata = $1, search_text = lower($2) WHERE job_id = $3 AND name = $4`)
        .run(JSON.stringify(value), `${value.title || ''} ${value.artist || ''} ${name} ${job.playlistTitle || ''}`, job.id, name)
      : await database.prepare('UPDATE songs SET transcription = $1 WHERE job_id = $2 AND name = $3').run(JSON.stringify(value), job.id, name);
    if (!result.changes) throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    await database.prepare("UPDATE jobs SET data = jsonb_set(data, '{updatedAt}', $1::jsonb) WHERE id = $2").run(JSON.stringify(job.updatedAt), job.id);
    await database.prepare('UPDATE user_catalog SET revision = revision + 1 WHERE user_id IN (SELECT user_id FROM job_users WHERE job_id = $1)').run(job.id);
  });
}

export async function deletePostgresJob(database, id) {
  await database.withTransaction(async () => {
    const users = await database.prepare('SELECT user_id FROM job_users WHERE job_id = $1').all(id);
    await database.prepare('DELETE FROM jobs WHERE id = $1').run(id);
    for (const { user_id: userId } of users) await rebuildPostgresLibrary(database, userId);
  });
}

export async function postgresPageJobs(database, tracks) {
  const jobs = new Map();
  for (const track of tracks) {
    if (!jobs.has(track.jobId)) jobs.set(track.jobId, { ...track.sourceJob, files: [], songMetadata: {}, transcriptions: {} });
    const job = jobs.get(track.jobId);
    job.files.push(track.name);
    job.songMetadata[track.name] = { title: track.title, artist: track.artist, album: track.album, rating: track.rating };
    if (track.transcription) job.transcriptions[track.name] = track.transcription;
  }
  for (const job of jobs.values()) {
    const named = Object.values(job.transcriptions).map((record) => record.noVocalsName).filter(Boolean);
    const companions = await database.prepare(`SELECT name FROM songs WHERE job_id = $1 AND
      (karaoke_stem IN (SELECT jsonb_array_elements_text($2::jsonb)) OR name IN (SELECT jsonb_array_elements_text($3::jsonb)))`)
      .all(job.id, JSON.stringify(job.files.map(songStem)), JSON.stringify(named));
    job.files = [...new Set([...job.files, ...companions.map((row) => row.name)])];
  }
  return jobs;
}