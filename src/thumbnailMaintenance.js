import { readSongThumbnail } from './artworkThumbnails.js';

export async function* thumbnailSongs(database) {
  let cursor;
  while (true) {
    const rows = await database.prepare(`SELECT songs.job_id, songs.name, jobs.data->>'outputDir' AS output_dir
      FROM songs JOIN jobs ON jobs.id = songs.job_id
      WHERE lower(songs.name) LIKE '%.mp3'
        AND ($1::text IS NULL OR (songs.job_id, songs.name) > ($1, $2))
      ORDER BY songs.job_id, songs.name LIMIT 100`).all(cursor?.job_id ?? null, cursor?.name ?? null);
    if (!rows.length) return;
    for (const row of rows) yield row;
    cursor = rows.at(-1);
  }
}

export function createThumbnailMaintenance({ songs, resolveFile, generate = readSongThumbnail }) {
  let state = { running: false, processed: 0, generated: 0, missing: 0, failed: 0,
    startedAt: null, completedAt: null, error: null };
  let operation = Promise.resolve();

  async function run() {
    try {
      for await (const song of songs()) {
        try {
          const filePath = await resolveFile(song);
          const thumbnail = await generate(filePath, { force: true });
          state[thumbnail ? 'generated' : 'missing'] += 1;
        } catch (error) {
          if (error.code === 'ENOENT') state.missing += 1;
          else {
            state.failed += 1;
            state.error = 'Some thumbnails failed. Check the server logs and FFmpeg configuration, then retry.';
            console.warn(`Artwork thumbnail regeneration failed: ${error.message}`);
          }
        } finally { state.processed += 1; }
      }
    } catch (error) {
      state.error = 'Thumbnail regeneration could not finish. Check the server logs and retry.';
      console.warn(`Artwork thumbnail regeneration stopped: ${error.message}`);
    } finally {
      state.running = false;
      state.completedAt = new Date().toISOString();
    }
  }

  return {
    status: () => ({ ...state }),
    start() {
      if (state.running) throw Object.assign(new Error('Thumbnail regeneration is already running'), { statusCode: 409 });
      state = { running: true, processed: 0, generated: 0, missing: 0, failed: 0,
        startedAt: new Date().toISOString(), completedAt: null, error: null };
      operation = run();
      return { ...state };
    },
    wait: () => operation
  };
}
