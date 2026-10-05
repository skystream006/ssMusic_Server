import crypto from 'node:crypto';
import { openDatabase, readUser, writeUser, withTransaction } from './database.js';

const database = openDatabase();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    organizerId: user.organizerId ?? null,
    sharedUserIds: user.sharedUserIds || [],
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    credentialCount: user.credentials.length
  };
}

function normalizeName(name) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 64) {
    const error = new Error('Name must be between 2 and 64 characters');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

async function countApprovedAdmins(excludingUserId = null) {
  return (await database.prepare("SELECT count(*) AS count FROM users WHERE id IS DISTINCT FROM $1 AND role = 'admin' AND status = 'approved'")
    .get(excludingUserId)).count;
}

export async function listUsers() {
  return (await database.prepare(`SELECT users.id, name, role, status, organizer_id AS "organizerId", created_at AS "createdAt",
    updated_at AS "updatedAt", (SELECT count(*) FROM credentials WHERE user_id = users.id) AS "credentialCount"
    FROM users ORDER BY created_at`).all());
}

export async function listAvailableUsers() {
  return database.prepare(`SELECT id, name FROM users WHERE status = 'approved' AND role <> 'shared'
    ORDER BY lower(name), id`).all();
}

async function requireLibraryUser(userId) {
  const user = await database.prepare('SELECT id, name, role, status FROM users WHERE id = $1').get(userId);
  if (!user || user.status !== 'approved' || user.role === 'shared') {
    throw Object.assign(new Error('Approved, non-Shared user required'), { statusCode: 403 });
  }
  return user;
}

export async function listUserLinks(userId) {
  await requireLibraryUser(userId);
  return database.prepare(`SELECT users.id, users.name,
    CASE WHEN user_links.accepted_at IS NOT NULL THEN 'linked'
      WHEN user_links.requester_id = $1 THEN 'outgoing' ELSE 'incoming' END AS status
    FROM user_links JOIN users ON users.id = CASE WHEN user_links.requester_id = $1
      THEN user_links.recipient_id ELSE user_links.requester_id END
    WHERE (user_links.requester_id = $1 OR user_links.recipient_id = $1)
      AND users.status = 'approved' AND users.role <> 'shared' ORDER BY lower(users.name), users.id`).all(userId);
}

export async function requestUserLink(userId, targetId) {
  return withTransaction(database, async () => {
    await requireLibraryUser(userId);
    if (typeof targetId !== 'string' || targetId === userId) {
      throw Object.assign(new Error('Select another user to link'), { statusCode: 400 });
    }
    await requireLibraryUser(targetId);
    const existing = await database.prepare(`SELECT 1 FROM user_links
      WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)`).get(userId, targetId);
    if (existing) throw Object.assign(new Error('A link or link request already exists'), { statusCode: 409 });
    for (const id of [userId, targetId]) {
      const { count } = await database.prepare('SELECT count(*) AS count FROM user_links WHERE requester_id = $1 OR recipient_id = $1').get(id);
      if (count >= 500) throw Object.assign(new Error('User link limit reached'), { statusCode: 409 });
    }
    await database.prepare('INSERT INTO user_links (requester_id, recipient_id, created_at) VALUES ($1, $2, $3)')
      .run(userId, targetId, new Date().toISOString());
  });
}

export async function acceptUserLink(userId, requesterId) {
  return withTransaction(database, async () => {
    await requireLibraryUser(userId);
    const result = await database.prepare(`UPDATE user_links SET accepted_at = $1
      WHERE recipient_id = $2 AND requester_id = $3 AND accepted_at IS NULL`).run(new Date().toISOString(), userId, requesterId);
    if (!result.changes) throw Object.assign(new Error('Incoming link request not found'), { statusCode: 404 });
    await requireLibraryUser(requesterId);
  });
}

export async function removeUserLink(userId, targetId) {
  return withTransaction(database, async () => {
    await requireLibraryUser(userId);
    const result = await database.prepare(`DELETE FROM user_links
      WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)`).run(userId, targetId);
    if (!result.changes) return false;
    await database.prepare(`DELETE FROM library_shares USING users AS viewer WHERE viewer.id = library_shares.viewer_id
      AND ((viewer.organizer_id = $1 AND library_shares.owner_id = $2)
        OR (viewer.organizer_id = $2 AND library_shares.owner_id = $1))`).run(userId, targetId);
    return true;
  });
}

export async function listOrganizerLibraries(organizerId) {
  const organizer = await requireLibraryUser(organizerId);
  const links = await listUserLinks(organizerId);
  return [{ id: organizer.id, name: organizer.name }, ...links.filter((link) => link.status === 'linked').map(({ id, name }) => ({ id, name }))];
}

export async function listOrganizedUsers(organizerId) {
  await requireLibraryUser(organizerId);
  return database.prepare(`SELECT id, name, status,
    ARRAY(SELECT owner_id FROM library_shares WHERE viewer_id = users.id ORDER BY owner_id) AS "sharedUserIds"
    FROM users WHERE organizer_id = $1 AND role = 'shared' ORDER BY lower(name), id`).all(organizerId);
}

export async function updateOrganizedUser(organizerId, userId, sharedUserIds) {
  return withTransaction(database, async () => {
    await requireLibraryUser(organizerId);
    const user = await readUser(database, userId);
    if (!user || user.role !== 'shared' || user.organizerId !== organizerId) {
      throw Object.assign(new Error('Shared user not found for this organizer'), { statusCode: 404 });
    }
    if (!Array.isArray(sharedUserIds)) throw Object.assign(new Error('Select shared libraries'), { statusCode: 400 });
    return updateUserRecord(userId, { sharedUserIds }, organizerId);
  });
}

export async function findCredential(credentialId) {
  const record = (await database.prepare('SELECT user_id FROM credentials WHERE id = $1').get(credentialId));
  if (!record) return null;
  const user = (await readUser(database, record.user_id));
  const credential = user.credentials.find((item) => item.id === credentialId);
  return { user, credential: { ...credential, publicKey: Buffer.from(credential.publicKey, 'base64url') } };
}

export async function validateRegistrationAccount({ role = 'user', organizerId = null } = {}) {
  if (!['user', 'shared'].includes(role) || (role === 'user' && organizerId !== null)) {
    throw Object.assign(new Error('Invalid registration account type'), { statusCode: 400 });
  }
  if (role === 'shared') {
    const organizer = typeof organizerId === 'string'
      ? await database.prepare('SELECT role, status FROM users WHERE id = $1').get(organizerId) : null;
    if (!organizer || organizer.role === 'shared' || organizer.status !== 'approved') {
      throw Object.assign(new Error('Select an approved, non-Shared organizer'), { statusCode: 400 });
    }
  }
  return { role, organizerId };
}

export async function registerUser(name, userHandle, credential, account = {}) {
  return (await withTransaction(database, async () => (await registerUserRecord(name, userHandle, credential, account))));
}

async function registerUserRecord(name, userHandle, credential, account) {
  const registration = await validateRegistrationAccount(account);
  const normalizedName = normalizeName(name);
  if ((await database.prepare('SELECT 1 FROM users WHERE name_key = $1').get(normalizedName.toLowerCase()))) {
    const error = new Error('That name is already registered');
    error.statusCode = 409;
    throw error;
  }
  if ((await findCredential(credential.id))) {
    const error = new Error('That passkey is already registered');
    error.statusCode = 409;
    throw error;
  }

  const isFirstUser = (await database.prepare('SELECT count(*) AS count FROM users').get()).count === 0;
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name: normalizedName,
    userHandle,
    role: isFirstUser ? 'admin' : registration.role,
    organizerId: registration.organizerId,
    status: isFirstUser ? 'approved' : 'pending',
    credentials: [{
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports || [],
      createdAt: now,
      lastUsedAt: null
    }],
    createdAt: now,
    updatedAt: now
  };
  (await writeUser(database, user));
  return publicUser(user);
}

export async function getUserPasskeys(userId) {
  const user = (await readUser(database, userId));
  return user ? {
    userHandle: user.userHandle,
    credentials: user.credentials.map(({ id, transports, createdAt, lastUsedAt }) => ({ id, transports, createdAt, lastUsedAt }))
  } : null;
}

export async function addCredential(userId, credential) {
  return (await withTransaction(database, async () => {
    const user = (await readUser(database, userId));
    if (!user || user.status !== 'approved') {
      const error = new Error('Approved user required');
      error.statusCode = 403;
      throw error;
    }
    if ((await findCredential(credential.id))) {
      const error = new Error('That passkey is already registered');
      error.statusCode = 409;
      throw error;
    }
    const now = new Date().toISOString();
    user.credentials.push({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports || [],
      createdAt: now,
      lastUsedAt: null
    });
    user.updatedAt = now;
    (await writeUser(database, user));
    return publicUser(user);
  }));
}

export async function updateCredentialCounter(userId, credentialId, counter) {
  return (await withTransaction(database, async () => {
    const now = new Date().toISOString();
    const result = (await database.prepare(`UPDATE credentials SET counter = $1, last_used_at =
      CASE WHEN (SELECT status FROM users WHERE id = $2) = 'approved' THEN $3 ELSE last_used_at END
      WHERE id = $4 AND user_id = $5`).run(counter, userId, now, credentialId, userId));
    if (!result.changes) return false;
    (await database.prepare('UPDATE users SET updated_at = $1 WHERE id = $2').run(now, userId));
    return true;
  }));
}

export async function deleteCredential(userId, credentialId) {
  return (await withTransaction(database, async () => {
    const user = (await readUser(database, userId));
    if (!user || !user.credentials.some(({ id }) => id === credentialId)) return null;
    if (user.status !== 'approved') {
      const error = new Error('Approved user required');
      error.statusCode = 403;
      throw error;
    }
    if (user.credentials.length <= 1) {
      const error = new Error('You must keep at least one passkey');
      error.statusCode = 409;
      throw error;
    }
    (await database.prepare('DELETE FROM credentials WHERE id = $1 AND user_id = $2').run(credentialId, userId));
    user.credentials = user.credentials.filter(({ id }) => id !== credentialId);
    user.updatedAt = new Date().toISOString();
    (await database.prepare('UPDATE users SET updated_at = $1 WHERE id = $2').run(user.updatedAt, userId));
    return publicUser(user);
  }));
}

export async function updateUser(userId, changes, actorId) {
  return (await withTransaction(database, async () => (await updateUserRecord(userId, changes, actorId))));
}

export async function deleteUser(userId, actorId) {
  return (await withTransaction(database, async () => {
    const user = (await readUser(database, userId));
    if (!user) return false;
    if (user.id === actorId) {
      const error = new Error('You cannot delete your own account');
      error.statusCode = 409;
      throw error;
    }
    if (user.role === 'admin' && user.status === 'approved' && (await countApprovedAdmins(user.id)) === 0) {
      const error = new Error('At least one approved admin is required');
      error.statusCode = 409;
      throw error;
    }
    await database.prepare('DELETE FROM library_shares WHERE viewer_id IN (SELECT id FROM users WHERE organizer_id = $1)').run(user.id);
    (await database.prepare('DELETE FROM users WHERE id = $1').run(user.id));
    return true;
  }));
}

async function updateUserRecord(userId, changes, actorId) {
  const user = (await readUser(database, userId));
  if (!user) return null;
  const status = changes.status ?? user.status;
  const role = changes.role ?? user.role;
  if (changes.name !== undefined) {
    if (typeof changes.name !== 'string') throw Object.assign(new Error('Username must be text'), { statusCode: 400 });
    const name = normalizeName(changes.name);
    if (await database.prepare('SELECT 1 FROM users WHERE name_key = $1 AND id <> $2').get(name.toLowerCase(), user.id)) {
      throw Object.assign(new Error('That name is already registered'), { statusCode: 409 });
    }
    user.name = name;
  }
  if (!['pending', 'approved', 'revoked'].includes(status) || !['user', 'admin', 'shared'].includes(role)) {
    const error = new Error('Invalid user role or access status');
    error.statusCode = 400;
    throw error;
  }
  if (user.id === actorId && status !== 'approved') {
    const error = new Error('You cannot revoke your own access');
    error.statusCode = 409;
    throw error;
  }
  if (user.role === 'admin' && user.status === 'approved'
    && (role !== 'admin' || status !== 'approved') && (await countApprovedAdmins(user.id)) === 0) {
    const error = new Error('At least one approved admin is required');
    error.statusCode = 409;
    throw error;
  }

  const organizerId = role === 'shared' ? (changes.organizerId === undefined ? user.organizerId : changes.organizerId) : null;
  if (changes.organizerId !== undefined && changes.organizerId !== null && role !== 'shared') {
    throw Object.assign(new Error('Only Shared accounts have an organizer'), { statusCode: 400 });
  }
  if (organizerId !== null) {
    if (organizerId === user.id) throw Object.assign(new Error('A Shared user cannot organize itself'), { statusCode: 400 });
    await validateRegistrationAccount({ role: 'shared', organizerId });
  }
  const sharedUserIds = changes.sharedUserIds === undefined
    ? (organizerId !== user.organizerId ? [] : user.sharedUserIds) : changes.sharedUserIds;
  if (!Array.isArray(sharedUserIds) || sharedUserIds.length > 500
    || sharedUserIds.some((id) => typeof id !== 'string' || id === user.id)
    || (changes.sharedUserIds !== undefined && role !== 'shared' && sharedUserIds.length)) {
    throw Object.assign(new Error('Invalid shared library users'), { statusCode: 400 });
  }
  const grants = role === 'shared' ? [...new Set(sharedUserIds)] : [];
  const availableIds = organizerId ? new Set((await listOrganizerLibraries(organizerId)).map(({ id }) => id)) : null;
  for (const id of grants) {
    const owner = await database.prepare('SELECT role, status FROM users WHERE id = $1').get(id);
    if (!owner || owner.role === 'shared' || owner.status !== 'approved') {
      throw Object.assign(new Error('Select approved, non-Shared library users'), { statusCode: 400 });
    }
    if (availableIds && !availableIds.has(id)) {
      throw Object.assign(new Error('Select the organizer or an accepted linked library'), { statusCode: 403 });
    }
  }
  await database.prepare('DELETE FROM library_shares WHERE viewer_id = $1').run(user.id);
  for (const id of grants) await database.prepare('INSERT INTO library_shares (viewer_id, owner_id) VALUES ($1, $2)').run(user.id, id);
  if (role === 'shared' || status !== 'approved') {
    await database.prepare('DELETE FROM library_shares WHERE owner_id = $1 OR viewer_id IN (SELECT id FROM users WHERE organizer_id = $1)').run(user.id);
    await database.prepare('DELETE FROM user_links WHERE requester_id = $1 OR recipient_id = $1').run(user.id);
    await database.prepare('UPDATE users SET organizer_id = NULL WHERE organizer_id = $1').run(user.id);
  }
  user.sharedUserIds = grants;
  user.organizerId = organizerId;
  user.status = status;
  user.role = role;
  user.updatedAt = new Date().toISOString();
  if (status !== 'approved') {
    (await database.prepare('DELETE FROM sessions WHERE user_id = $1').run(user.id));
    (await database.prepare('DELETE FROM private_access_tokens WHERE user_id = $1').run(user.id));
  }
  (await writeUser(database, user));
  return publicUser(user);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const session = {
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  (await withTransaction(database, async () => {
    (await database.prepare('DELETE FROM sessions WHERE expires_at <= $1').run(new Date().toISOString()));
    (await database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)')
      .run(session.tokenHash, session.userId, session.expiresAt));
  }));
  return { token, expiresAt: session.expiresAt };
}

export async function getSessionUser(token) {
  if (!token) return null;
  const session = (await database.prepare('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > $2')
    .get(hashToken(token), new Date().toISOString()));
  if (!session) return null;
  const user = (await readUser(database, session.user_id));
  if (!user || user.status !== 'approved') return null;
  return publicUser(user);
}

export async function deleteSession(token) {
  if (!token) return;
  (await database.prepare('DELETE FROM sessions WHERE token_hash = $1').run(hashToken(token)));
}

export async function getUser(userId) {
  const user = (await readUser(database, userId));
  return user ? publicUser(user) : null;
}

export async function listPrivateAccessTokens(userId) {
  return (await database.prepare(`SELECT id, name, created_at AS "createdAt"
    FROM private_access_tokens WHERE user_id = $1 ORDER BY created_at DESC`).all(userId));
}

export async function createPrivateAccessToken(userId, name) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!normalizedName || normalizedName.length > 64) {
    const error = new Error('PAT name must be between 1 and 64 characters');
    error.statusCode = 400;
    throw error;
  }
  if ((await getUser(userId))?.status !== 'approved') {
    const error = new Error('Approved user required');
    error.statusCode = 403;
    throw error;
  }
  const id = crypto.randomUUID();
  const token = `ssyt_pat_${crypto.randomBytes(32).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  (await database.prepare(`INSERT INTO private_access_tokens (id, user_id, name, token_hash, created_at)
    VALUES ($1, $2, $3, $4, $5)`).run(id, userId, normalizedName, hashToken(token), createdAt));
  return { id, name: normalizedName, token, createdAt };
}

export async function getPrivateAccessTokenUser(token) {
  if (typeof token !== 'string' || !/^ssyt_pat_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const record = (await database.prepare('SELECT user_id FROM private_access_tokens WHERE token_hash = $1').get(hashToken(token)));
  if (!record) return null;
  const user = (await readUser(database, record.user_id));
  if (!user || user.status !== 'approved') return null;
  return publicUser(user);
}

export async function deletePrivateAccessToken(userId, tokenId) {
  return (await database.prepare('DELETE FROM private_access_tokens WHERE user_id = $1 AND id = $2')
    .run(userId, tokenId)).changes > 0;
}