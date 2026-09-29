import { createPostgresDatabase } from './postgres.js';
import { writePostgresJob } from './postgresCatalog.js';

const connections = new Map();

export function withTransaction(database, operation) {
  return database.withTransaction(operation);
}

function userStatements(user) {
  return [{ sql: `INSERT INTO users (id, name, name_key, user_handle, role, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, name_key=excluded.name_key,
      user_handle=excluded.user_handle, role=excluded.role, status=excluded.status,
      updated_at=excluded.updated_at`, values: [
    user.id, user.name, user.name.toLowerCase(), user.userHandle, user.role, user.status,
    user.createdAt, user.updatedAt
  ] }, ...user.credentials.map((credential) => ({ credential: true, sql: `INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at, last_used_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(id) DO UPDATE SET
      public_key=excluded.public_key, counter=excluded.counter, transports=excluded.transports
      WHERE credentials.user_id = excluded.user_id`, values: [
      credential.id, user.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports || []),
      credential.createdAt ?? null, credential.lastUsedAt ?? null
  ] }))];
}

export async function writeUser(database, user) {
  for (const statement of userStatements(user)) {
    const result = await database.prepare(statement.sql).run(...statement.values);
    if (statement.credential && !result.changes) throw new Error('A passkey cannot belong to multiple users');
  }
}

export async function readUser(database, id) {
  const user = await database.prepare(`SELECT id, name, user_handle AS "userHandle", role, status,
    created_at AS "createdAt", updated_at AS "updatedAt" FROM users WHERE id = $1`).get(id);
  if (!user) return null;
  user.credentials = (await database.prepare(`SELECT id, public_key AS "publicKey", counter, transports,
    created_at AS "createdAt", last_used_at AS "lastUsedAt"
    FROM credentials WHERE user_id = $1`).all(id)).map((credential) => ({
    ...credential, transports: JSON.parse(credential.transports)
  }));
  return user;
}

export async function writeJob(database, job) {
  return writePostgresJob(database, job);
}

export function openDatabase() {
  const key = process.env.DATABASE_URL || JSON.stringify([process.env.PGHOST, process.env.PGPORT, process.env.PGDATABASE, process.env.PGUSER]);
  if (!connections.has(key)) connections.set(key, createPostgresDatabase());
  return connections.get(key);
}

export function closeDatabases() {
  const closing = [...connections.values()].map((database) => database.close());
  connections.clear();
  return Promise.all(closing);
}