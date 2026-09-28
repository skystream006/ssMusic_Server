import crypto from 'node:crypto';
import { openDatabase, readUser, writeUser } from './database.js';

const database = openDatabase();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
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

function countApprovedAdmins(excludingUserId = null) {
  return database.prepare("SELECT count(*) AS count FROM users WHERE id IS NOT ? AND role = 'admin' AND status = 'approved'")
    .get(excludingUserId).count;
}

export function listUsers() {
  return database.prepare(`SELECT users.id, name, role, status, created_at AS createdAt,
    updated_at AS updatedAt, (SELECT count(*) FROM credentials WHERE user_id = users.id) AS credentialCount
    FROM users ORDER BY created_at`).all();
}

export function findCredential(credentialId) {
  const record = database.prepare('SELECT user_id FROM credentials WHERE id = ?').get(credentialId);
  if (!record) return null;
  const user = readUser(database, record.user_id);
  const credential = user.credentials.find((item) => item.id === credentialId);
  return { user, credential: { ...credential, publicKey: Buffer.from(credential.publicKey, 'base64url') } };
}

export async function registerUser(name, userHandle, credential) {
  return database.transaction(() => registerUserRecord(name, userHandle, credential)).immediate();
}

function registerUserRecord(name, userHandle, credential) {
  const normalizedName = normalizeName(name);
  if (database.prepare('SELECT 1 FROM users WHERE name_key = ?').get(normalizedName.toLowerCase())) {
    const error = new Error('That name is already registered');
    error.statusCode = 409;
    throw error;
  }
  if (findCredential(credential.id)) {
    const error = new Error('That passkey is already registered');
    error.statusCode = 409;
    throw error;
  }

  const isFirstUser = database.prepare('SELECT count(*) AS count FROM users').get().count === 0;
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name: normalizedName,
    userHandle,
    role: isFirstUser ? 'admin' : 'user',
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
  writeUser(database, user);
  return publicUser(user);
}

export function getUserPasskeys(userId) {
  const user = readUser(database, userId);
  return user ? {
    userHandle: user.userHandle,
    credentials: user.credentials.map(({ id, transports, createdAt, lastUsedAt }) => ({ id, transports, createdAt, lastUsedAt }))
  } : null;
}

export async function addCredential(userId, credential) {
  return database.transaction(() => {
    const user = readUser(database, userId);
    if (!user || user.status !== 'approved') {
      const error = new Error('Approved user required');
      error.statusCode = 403;
      throw error;
    }
    if (findCredential(credential.id)) {
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
    writeUser(database, user);
    return publicUser(user);
  }).immediate();
}

export async function updateCredentialCounter(userId, credentialId, counter) {
  return database.transaction(() => {
    const now = new Date().toISOString();
    const result = database.prepare(`UPDATE credentials SET counter = ?, last_used_at =
      CASE WHEN (SELECT status FROM users WHERE id = ?) = 'approved' THEN ? ELSE last_used_at END
      WHERE id = ? AND user_id = ?`).run(counter, userId, now, credentialId, userId);
    if (!result.changes) return false;
    database.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(now, userId);
    return true;
  }).immediate();
}

export async function deleteCredential(userId, credentialId) {
  return database.transaction(() => {
    const user = readUser(database, userId);
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
    database.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?').run(credentialId, userId);
    user.credentials = user.credentials.filter(({ id }) => id !== credentialId);
    user.updatedAt = new Date().toISOString();
    database.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(user.updatedAt, userId);
    return publicUser(user);
  }).immediate();
}

export async function updateUser(userId, changes, actorId) {
  return database.transaction(() => updateUserRecord(userId, changes, actorId)).immediate();
}

export async function deleteUser(userId, actorId) {
  return database.transaction(() => {
    const user = readUser(database, userId);
    if (!user) return false;
    if (user.id === actorId) {
      const error = new Error('You cannot delete your own account');
      error.statusCode = 409;
      throw error;
    }
    if (user.role === 'admin' && user.status === 'approved' && countApprovedAdmins(user.id) === 0) {
      const error = new Error('At least one approved admin is required');
      error.statusCode = 409;
      throw error;
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return true;
  }).immediate();
}

function updateUserRecord(userId, changes, actorId) {
  const user = readUser(database, userId);
  if (!user) return null;
  const status = changes.status ?? user.status;
  const role = changes.role ?? user.role;
  if (!['pending', 'approved', 'revoked'].includes(status) || !['user', 'admin'].includes(role)) {
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
    && (role !== 'admin' || status !== 'approved') && countApprovedAdmins(user.id) === 0) {
    const error = new Error('At least one approved admin is required');
    error.statusCode = 409;
    throw error;
  }

  user.status = status;
  user.role = role;
  user.updatedAt = new Date().toISOString();
  if (status !== 'approved') {
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    database.prepare('DELETE FROM private_access_tokens WHERE user_id = ?').run(user.id);
  }
  writeUser(database, user);
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
  database.transaction(() => {
    database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(session.tokenHash, session.userId, session.expiresAt);
  }).immediate();
  return { token, expiresAt: session.expiresAt };
}

export function getSessionUser(token) {
  if (!token) return null;
  const session = database.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), new Date().toISOString());
  if (!session) return null;
  const user = readUser(database, session.user_id);
  if (!user || user.status !== 'approved') return null;
  return publicUser(user);
}

export async function deleteSession(token) {
  if (!token) return;
  database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function getUser(userId) {
  const user = readUser(database, userId);
  return user ? publicUser(user) : null;
}

export function listPrivateAccessTokens(userId) {
  return database.prepare(`SELECT id, name, created_at AS createdAt
    FROM private_access_tokens WHERE user_id = ? ORDER BY created_at DESC`).all(userId);
}

export async function createPrivateAccessToken(userId, name) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!normalizedName || normalizedName.length > 64) {
    const error = new Error('PAT name must be between 1 and 64 characters');
    error.statusCode = 400;
    throw error;
  }
  if (getUser(userId)?.status !== 'approved') {
    const error = new Error('Approved user required');
    error.statusCode = 403;
    throw error;
  }
  const id = crypto.randomUUID();
  const token = `ssyt_pat_${crypto.randomBytes(32).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  database.prepare(`INSERT INTO private_access_tokens (id, user_id, name, token_hash, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, userId, normalizedName, hashToken(token), createdAt);
  return { id, name: normalizedName, token, createdAt };
}

export function getPrivateAccessTokenUser(token) {
  if (typeof token !== 'string' || !/^ssyt_pat_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const record = database.prepare('SELECT user_id FROM private_access_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!record) return null;
  const user = readUser(database, record.user_id);
  if (!user || user.status !== 'approved') return null;
  return publicUser(user);
}

export async function deletePrivateAccessToken(userId, tokenId) {
  return database.prepare('DELETE FROM private_access_tokens WHERE user_id = ? AND id = ?')
    .run(userId, tokenId).changes > 0;
}