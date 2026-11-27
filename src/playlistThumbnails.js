import { entryVisibilitySql, fileVisibilitySql } from './privacy.js';

export async function* playlistThumbnailSources(database, { userId = null, playlistId = null,
  viewerId = userId, jobId = null } = {}) {
  let cursor;
  while (true) {
    const rows = await database.prepare(`SELECT entry.user_id, entry.id AS playlist_id,
      source.job_id, source.name, source.output_dir
      FROM library_entries entry
      LEFT JOIN LATERAL (
        SELECT songs.job_id, songs.name, jobs.data->>'outputDir' AS output_dir
        FROM library_memberships membership
        JOIN songs ON songs.job_id = membership.job_id AND songs.name = membership.name
        JOIN jobs ON jobs.id = songs.job_id
        WHERE membership.user_id = entry.user_id AND membership.playlist_id = entry.id
          AND (lower(songs.name) LIKE '%.mp3' OR songs.media_type = 'video')
          AND lower(songs.name) NOT LIKE '[novocals]/%'
          AND ${fileVisibilitySql('jobs', 'songs.name', 'COALESCE($3, CASE WHEN $1::text IS NULL THEN entry.user_id END)')}
        ORDER BY membership.position, songs.job_id, songs.name LIMIT 1
      ) source ON true
      WHERE entry.entry_type = 'playlist'
        AND ($1::text IS NULL OR entry.user_id = $1)
        AND ($2::text IS NULL OR entry.id = $2)
        AND ${entryVisibilitySql('entry', 'COALESCE($3, CASE WHEN $1::text IS NULL THEN entry.user_id END)')}
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM library_memberships affected
          WHERE affected.user_id = entry.user_id AND affected.playlist_id = entry.id AND affected.job_id = $4))
        AND ($5::text IS NULL OR (entry.user_id, entry.id) > ($5, $6))
      ORDER BY entry.user_id, entry.id LIMIT 100`)
      .all(userId, playlistId, viewerId, jobId, cursor?.user_id ?? null, cursor?.playlist_id ?? null);
    if (!rows.length) return;
    for (const row of rows) yield row;
    cursor = rows.at(-1);
  }
}
