import { openDatabase } from './database.js';
import { entryVisibilitySql, fileVisibilitySql, visibleJob } from './privacy.js';

export function restrictSharedAccess(req, res, next) {
  const pathname = req.path.replace(/\/+$/, '').toLowerCase();
  const user = pathname.startsWith('/api/auth/') ? req.sessionUser || req.user : req.user;
  if (user && !['GET', 'HEAD'].includes(req.method)) {
    const targets = pathname === '/api/library' || pathname.startsWith('/api/library/')
      ? [req.query.userId, pathname.startsWith('/api/library/backup') ? undefined : req.body?.userId]
      : pathname.startsWith('/api/jobs/') ? [req.query.userId] : [];
    if (targets.some((id) => id !== undefined && id !== user.id)) {
      return res.status(403).json({ error: 'Linked libraries are read-only' });
    }
  }
  if (user?.role !== 'shared' || !pathname.startsWith('/api/')) return next();
  const authentication = req.method === 'POST' && ['/api/auth/logout', '/api/auth/login/options', '/api/auth/login/verify', '/api/auth/app/token'].includes(pathname);
  const reading = ['GET', 'HEAD'].includes(req.method) && (
    ['/api/auth/me', '/api/auth/pats', '/api/auth/passkeys', '/api/preferences', '/api/library', '/api/library/tracks', '/api/library/shared-users'].includes(pathname)
    || /^\/api\/library\/playlists\/[^/]+\/download$/.test(pathname)
    || /^\/api\/jobs\/[^/]+\/(stream|download|lyrics|artwork)\/[^/]+$/.test(pathname));
  const themePreferences = req.method === 'PUT' && pathname === '/api/preferences';
  const ownUsername = req.method === 'PATCH' && pathname === '/api/auth/me';
  if (authentication || reading || themePreferences || ownUsername) return next();
  return res.status(403).json({ error: 'Shared accounts have read-only access to granted libraries' });
}

export async function sharedLibraryUsers(userId) {
  return openDatabase().prepare(`SELECT owners.id, owners.name FROM users AS owners
    WHERE owners.status = 'approved' AND owners.role <> 'shared' AND owners.id IN (
      SELECT owner_id FROM library_shares JOIN users AS viewer ON viewer.id = viewer_id
        WHERE viewer_id = $1 AND viewer.role = 'shared' AND viewer.status = 'approved'
      UNION
      SELECT CASE WHEN requester_id = $1 THEN recipient_id ELSE requester_id END FROM user_links
        JOIN users AS viewer ON viewer.id = $1 AND viewer.role <> 'shared' AND viewer.status = 'approved'
        WHERE (requester_id = $1 OR recipient_id = $1) AND accepted_at IS NOT NULL
    ) ORDER BY lower(owners.name), owners.id`).all(userId);
}

export async function libraryReaderId(user, requestedId) {
  if (requestedId !== undefined && typeof requestedId !== 'string') {
    throw Object.assign(new Error('Invalid library user'), { statusCode: 400 });
  }
  if (user.role === 'catalog') {
    const owner = requestedId && await openDatabase().prepare(
      "SELECT id FROM users WHERE id = $1 AND status = 'approved' AND role <> 'shared'"
    ).get(requestedId);
    if (!owner) throw Object.assign(new Error('Library not found'), { statusCode: 404 });
    return owner.id;
  }
  if (user.role !== 'shared' && (requestedId === undefined || requestedId === user.id)) return user.id;
  const owners = await sharedLibraryUsers(user.id);
  if (requestedId !== undefined && !owners.some((owner) => owner.id === requestedId)) {
    throw Object.assign(new Error('Library access denied'), { statusCode: 403 });
  }
  return requestedId ?? owners[0]?.id ?? null;
}

export async function canReadLibrarySong(user, ownerId, jobId, name) {
  const readerId = await libraryReaderId(user, ownerId);
  return Boolean(await openDatabase().prepare(`SELECT 1 FROM library_memberships membership
    JOIN library_entries entry ON entry.user_id = membership.user_id AND entry.id = membership.playlist_id
    JOIN songs ON songs.job_id = membership.job_id AND songs.name = membership.name
    JOIN jobs ON jobs.id = songs.job_id
    WHERE membership.user_id = $1 AND songs.job_id = $2 AND songs.name = $3
      AND ${entryVisibilitySql('entry', '$4')} AND ${fileVisibilitySql('jobs', 'songs.name', '$4')} LIMIT 1`)
    .get(readerId, jobId, name, user.id));
}

export function readOnlyLibraryFile(file, ownerId) {
  const scopedUrl = (value) => {
    if (!value) return value;
    const url = new URL(value, 'http://localhost');
    url.searchParams.set('userId', ownerId);
    return `${url.pathname}${url.search}`;
  };
  return { ...file, libraryOwnerId: ownerId, readOnly: true,
    streamUrl: scopedUrl(file.streamUrl), downloadUrl: scopedUrl(file.downloadUrl), artworkUrl: scopedUrl(file.artworkUrl),
    lyricsUrl: scopedUrl(`/api/jobs/${encodeURIComponent(file.jobId)}/lyrics/${encodeURIComponent(file.name)}`) };
}

export async function canReadSharedSong(userId, jobId, name) {
  return Boolean(await openDatabase().prepare(`SELECT 1 FROM library_memberships membership
    JOIN library_entries entry ON entry.user_id = membership.user_id AND entry.id = membership.playlist_id
    JOIN songs ON songs.job_id = membership.job_id AND songs.name = membership.name
    JOIN jobs ON jobs.id = songs.job_id
    JOIN library_shares ON library_shares.owner_id = membership.user_id
    JOIN users ON users.id = library_shares.owner_id
    WHERE library_shares.viewer_id = $1 AND songs.job_id = $2 AND songs.name = $3
      AND ${entryVisibilitySql('entry', '$1')} AND ${fileVisibilitySql('jobs', 'songs.name', '$1')}
      AND users.status = 'approved' AND users.role <> 'shared' LIMIT 1`).get(userId, jobId, name));
}

export function sharedJobSummary(job, user = null) {
  job = visibleJob(job, user);
  if (!job) return null;
  return { id: job.id, playlistTitle: job.playlistTitle, status: job.status, songCount: job.songCount, updatedAt: job.updatedAt };
}