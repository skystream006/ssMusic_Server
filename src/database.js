import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const connections = new Map();

function readLegacy(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Unable to migrate ${filePath}: ${error.message}`);
  }
}

export function writeUser(database, user) {
  database.prepare(`INSERT INTO users (id, name, name_key, user_handle, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, name_key=excluded.name_key,
      user_handle=excluded.user_handle, role=excluded.role, status=excluded.status,
      updated_at=excluded.updated_at`).run(
    user.id, user.name, user.name.toLowerCase(), user.userHandle, user.role, user.status,
    user.createdAt, user.updatedAt
  );
  for (const credential of user.credentials) {
    const result = database.prepare(`INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      public_key=excluded.public_key, counter=excluded.counter, transports=excluded.transports
      WHERE credentials.user_id = excluded.user_id`).run(
      credential.id, user.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports || []),
      credential.createdAt ?? null, credential.lastUsedAt ?? null
    );
    if (!result.changes) throw new Error('A passkey cannot belong to multiple users');
  }
}

export function readUser(database, id) {
  const user = database.prepare(`SELECT id, name, user_handle AS userHandle, role, status,
    created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?`).get(id);
  if (!user) return null;
  user.credentials = database.prepare(`SELECT id, public_key AS publicKey, counter, transports,
    created_at AS createdAt, last_used_at AS lastUsedAt
    FROM credentials WHERE user_id = ?`).all(id).map((credential) => ({
    ...credential, transports: JSON.parse(credential.transports)
  }));
  return user;
}

export function writeJob(database, job) {
  database.prepare(`INSERT INTO jobs (id, url, status, created_at, data) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, status=excluded.status,
      created_at=excluded.created_at, data=excluded.data`).run(
    job.id, job.url.trim(), job.status, job.createdAt || '', JSON.stringify(job)
  );
}

function migrateLegacy(database) {
  const migrated = database.prepare('SELECT 1 FROM migrations WHERE name = ?');
  const mark = database.prepare('INSERT INTO migrations (name) VALUES (?)');
  if (!migrated.get('auth-json-v1')) {
    const source = process.env.AUTH_STORE_PATH || path.resolve('data', 'auth.json');
    const stored = readLegacy(source);
    if (stored !== undefined) {
      if (!stored || !Array.isArray(stored.users) || !Array.isArray(stored.sessions)) {
        throw new Error(`Invalid authentication data in ${source}`);
      }
      for (const user of stored.users) writeUser(database, user);
      const insertSession = database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
      for (const session of stored.sessions) {
        insertSession.run(session.tokenHash, session.userId, session.expiresAt);
      }
    }
    mark.run('auth-json-v1');
  }
  if (!migrated.get('jobs-json-v1')) {
    const source = process.env.JOB_STORE_PATH || path.resolve('data', 'jobs.json');
    const stored = readLegacy(source);
    if (stored !== undefined) {
      if (!Array.isArray(stored)) throw new Error(`Invalid job history in ${source}`);
      for (const job of stored) {
        if (!job?.id || !job.url) throw new Error(`Invalid job record in ${source}`);
        writeJob(database, job);
      }
    }
    mark.run('jobs-json-v1');
  }
}

export function openDatabase() {
  const filePath = path.resolve(process.env.DATABASE_PATH || path.join('data', 'ssytdlp.sqlite'));
  if (connections.has(filePath)) return connections.get(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new Database(filePath, { timeout: 5000 });
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('synchronous = FULL');
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          user_handle TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'revoked')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credentials (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL,
          created_at TEXT, last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        DROP TABLE IF EXISTS api_tokens;
        CREATE TABLE IF NOT EXISTS private_access_tokens (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS private_access_tokens_user ON private_access_tokens(user_id);
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          theme TEXT NOT NULL DEFAULT 'light',
          theme_mode TEXT CHECK(theme_mode IN ('light', 'dark')),
          library TEXT NOT NULL DEFAULT '{"entries":[],"songOrder":{}}' CHECK(json_valid(library)),
          library_version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
        );
        CREATE INDEX IF NOT EXISTS jobs_url ON jobs(url, created_at DESC);
        CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
        CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
        CREATE TABLE IF NOT EXISTS library_backups (
          user_id TEXT PRIMARY KEY,
          schedule TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK(json_valid(schedule)),
          next_run_at TEXT,
          latest TEXT CHECK(latest IS NULL OR json_valid(latest)),
          running INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TEXT,
          last_error TEXT
        );
      `);
      const credentialColumns = database.pragma('table_info(credentials)');
      if (!credentialColumns.some((column) => column.name === 'created_at')) {
        database.exec('ALTER TABLE credentials ADD COLUMN created_at TEXT');
      }
      if (!credentialColumns.some((column) => column.name === 'last_used_at')) {
        database.exec('ALTER TABLE credentials ADD COLUMN last_used_at TEXT');
      }
      if (!database.pragma('table_info(user_preferences)').some((column) => column.name === 'theme_mode')) {
        database.exec("ALTER TABLE user_preferences ADD COLUMN theme_mode TEXT CHECK(theme_mode IN ('light', 'dark'))");
      }
      if (database.pragma('foreign_key_list(library_backups)').some((key) => key.table === 'users')) {
        database.exec(`
          CREATE TABLE library_backups_retained (
            user_id TEXT PRIMARY KEY,
            schedule TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK(json_valid(schedule)),
            next_run_at TEXT,
            latest TEXT CHECK(latest IS NULL OR json_valid(latest)),
            running INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TEXT,
            last_error TEXT
          );
          INSERT INTO library_backups_retained (user_id, schedule, next_run_at, latest, running, last_attempt_at, last_error)
            SELECT user_id, schedule, next_run_at, latest, running, last_attempt_at, last_error FROM library_backups;
          DROP TABLE library_backups;
          ALTER TABLE library_backups_retained RENAME TO library_backups;
        `);
      }
      migrateLegacy(database);
    }).immediate();
    connections.set(filePath, database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function closeDatabases() {
  for (const database of connections.values()) database.close();
  connections.clear();
}