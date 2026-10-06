import { timingSafeEqual } from 'node:crypto';
import { openDatabase } from './database.js';
import { normalizeSearchText, songMetadataFields } from './library.js';
import { songVisibilitySql, stemSql } from './privacy.js';

export function attachSearchKey(req, res, next) {
  const supplied = req.headers['x-api-key'];
  if (supplied === undefined) return next();
  res.set('Cache-Control', 'no-store');
  const expected = process.env.SEARCH_API_KEY;
  const actualBytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
  const expectedBytes = Buffer.from(expected || '');
  if (!expected || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return res.status(401).json({ error: 'Valid X-API-Key required' });
  }
  const pathname = req.path.replace(/\/+$/, '').toLowerCase();
  const allowed = ['/api/songs/search', '/api/libraries', '/api/library', '/api/library/tracks'].includes(pathname)
    || /^\/api\/jobs\/[^/]+\/(stream|download|artwork|lyrics)\/[^/]+$/.test(pathname);
  if (!['GET', 'HEAD'].includes(req.method) || !allowed) {
    return res.status(403).json({ error: 'Search API keys have read-only catalog and media access' });
  }
  if (['/api/library', '/api/library/tracks'].includes(pathname)
    && (typeof req.query.userId !== 'string' || !req.query.userId)) {
    return res.status(400).json({ error: 'A library userId is required' });
  }
  req.searchKey = true;
  req.user = { id: null, role: 'catalog' };
  return next();
}

export function requireSearchKey(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.searchKey) return res.status(401).json({ error: 'Valid X-API-Key required' });
  return next();
}

export async function searchSongs(req, res) {
  const positiveInteger = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (req.query.NoVocalsOnly !== undefined && !['', 'true', 'false', '1', '0'].includes(req.query.NoVocalsOnly)) {
    return res.status(400).json({ error: 'NoVocalsOnly must be true, false, 1, 0, or a bare flag' });
  }
  if ((req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200))
    || (req.query.page !== undefined && !positiveInteger(req.query.page))
    || (req.query.pageSize !== undefined && (!positiveInteger(req.query.pageSize) || Number(req.query.pageSize) > 100))) {
    return res.status(400).json({ error: 'Invalid search or pagination' });
  }
  const noVocalsOnly = ['', 'true', '1'].includes(req.query.NoVocalsOnly);
  const search = normalizeSearchText((req.query.q || '').trim()).replace(/[\\%_]/g, '\\$&');
  const pageSize = Number(req.query.pageSize || 50);
  const database = openDatabase();
  const directMatches = `SELECT songs.job_id, songs.name, songs.media_type, songs.transcription
    FROM songs JOIN jobs ON jobs.id = songs.job_id
    WHERE songs.media_type IN ('audio', 'video') AND ${songVisibilitySql('NULL')}
      AND songs.search_text LIKE $1 ESCAPE '\\'`;
  const matchingSongs = search ? `WITH matches AS (${directMatches})
    SELECT job_id, name FROM matches
    UNION
    SELECT songs.job_id, songs.name FROM matches original
    JOIN songs ON songs.job_id = original.job_id
      AND (songs.name = original.transcription->>'noVocalsName' OR songs.karaoke_stem = ${stemSql('original.name')})
    JOIN jobs ON jobs.id = songs.job_id
    WHERE original.media_type = 'audio' AND lower(original.name) NOT LIKE '[novocals]/%'
      AND songs.media_type = 'audio' AND lower(songs.name) LIKE '[novocals]/%'
      AND ${songVisibilitySql('NULL')}` : directMatches;
  const from = `FROM (${matchingSongs}) matched
    JOIN songs ON songs.job_id = matched.job_id AND songs.name = matched.name
    JOIN jobs ON jobs.id = songs.job_id
    WHERE (NOT $2::boolean OR (songs.media_type = 'audio' AND lower(songs.name) LIKE '[novocals]/%'))`;
  const parameters = [`%${search}%`, noVocalsOnly];
  const { total } = await database.prepare(`SELECT count(*) AS total ${from}`).get(...parameters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Number(req.query.page || 1), totalPages);
  const rows = await database.prepare(`SELECT songs.job_id, songs.name, songs.media_type, songs.metadata,
    jobs.data->>'playlistTitle' AS playlist_title ${from}
    ORDER BY songs.job_id, songs.file_order, songs.name LIMIT $3 OFFSET $4`)
    .all(...parameters, pageSize, (page - 1) * pageSize);
  const files = rows.map((row) => {
    const metadata = JSON.parse(row.metadata);
    const base = `/api/jobs/${encodeURIComponent(row.job_id)}`;
    const name = encodeURIComponent(row.name);
    return {
      ...Object.fromEntries([...songMetadataFields, 'rating'].filter((field) => metadata[field] !== undefined).map((field) => [field, metadata[field]])),
      jobId: row.job_id, name: row.name, playlistTitle: row.playlist_title, readOnly: true,
      streamUrl: `${base}/stream/${name}`, downloadUrl: `${base}/download/${name}`,
      artworkUrl: `${base}/artwork/${name}${row.media_type === 'audio' ? '?fallback=1' : ''}`,
      lyricsUrl: `${base}/lyrics/${name}`
    };
  });
  return res.json({ files, page, pageSize, total, totalPages });
}
