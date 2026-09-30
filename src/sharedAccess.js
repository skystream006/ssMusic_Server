import { openDatabase } from './database.js';

export function restrictSharedAccess(req, res, next) {
  const pathname = req.path.replace(/\/+$/, '').toLowerCase();
  const user = pathname.startsWith('/api/auth/') ? req.sessionUser || req.user : req.user;
  if (user?.role !== 'shared' || !pathname.startsWith('/api/')) return next();
  const authentication = req.method === 'POST' && ['/api/auth/logout', '/api/auth/login/options', '/api/auth/login/verify', '/api/auth/app/token'].includes(pathname);
  const reading = ['GET', 'HEAD'].includes(req.method) && (
    ['/api/auth/me', '/api/auth/pats', '/api/auth/passkeys', '/api/preferences', '/api/library', '/api/library/tracks', '/api/library/shared-users'].includes(pathname)
    || /^\/api\/jobs\/[^/]+\/(stream|download|lyrics)\/[^/]+$/.test(pathname));
  const themePreferences = req.method === 'PUT' && pathname === '/api/preferences';
  const ownUsername = req.method === 'PATCH' && pathname === '/api/auth/me';
  if (authentication || reading || themePreferences || ownUsername) return next();
  return res.status(403).json({ error: 'Shared accounts have read-only access to granted libraries' });
}

export async function sharedLibraryUsers(userId) {
  return openDatabase().prepare(`SELECT users.id, users.name FROM library_shares
    JOIN users ON users.id = library_shares.owner_id
    WHERE viewer_id = $1 AND users.status = 'approved' AND users.role <> 'shared'
    ORDER BY users.name, users.id`).all(userId);
}

export async function libraryReaderId(user, requestedId) {
  if (requestedId !== undefined && typeof requestedId !== 'string') {
    throw Object.assign(new Error('Invalid library user'), { statusCode: 400 });
  }
  if (user.role !== 'shared') {
    if (requestedId && requestedId !== user.id) throw Object.assign(new Error('Library access denied'), { statusCode: 403 });
    return user.id;
  }
  const owners = await sharedLibraryUsers(user.id);
  if (requestedId !== undefined && !owners.some((owner) => owner.id === requestedId)) {
    throw Object.assign(new Error('Library access denied'), { statusCode: 403 });
  }
  return requestedId ?? owners[0]?.id ?? null;
}

export async function canReadSharedSong(userId, jobId, name) {
  return Boolean(await openDatabase().prepare(`SELECT 1 FROM user_songs
    JOIN library_shares ON library_shares.owner_id = user_songs.user_id
    JOIN users ON users.id = library_shares.owner_id
    WHERE library_shares.viewer_id = $1 AND user_songs.job_id = $2 AND user_songs.name = $3
      AND users.status = 'approved' AND users.role <> 'shared' LIMIT 1`).get(userId, jobId, name));
}

export function sharedJobSummary(job) {
  return { id: job.id, playlistTitle: job.playlistTitle, status: job.status, songCount: job.songCount, updatedAt: job.updatedAt };
}