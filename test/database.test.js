import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import Database from 'better-sqlite3';
import { closeDatabases, openDatabase, readUser, writeUser } from '../src/database.js';

beforeEach(async (testContext) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-migration-'));
  process.env.DATABASE_PATH = path.join(directory, 'app.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  testContext.after(() => {
    closeDatabases();
    return fs.rm(directory, { recursive: true, force: true });
  });
});

function legacyAuth() {
  const now = new Date().toISOString();
  return {
    users: [{
      id: 'admin-id', name: 'Admin', userHandle: 'handle', role: 'admin', status: 'approved',
      createdAt: now, updatedAt: now,
      credentials: [{ id: 'key-id', publicKey: Buffer.from('public-key').toString('base64url'), counter: 7, transports: ['internal'] }]
    }],
    sessions: [{
      tokenHash: crypto.createHash('sha256').update('test-session').digest('base64url'),
      userId: 'admin-id', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }]
  };
}

test('legacy users, passkeys, sessions and complete job records migrate once without changing source files', async () => {
  const auth = legacyAuth();
  const job = {
    id: 'finished', url: 'https://music.youtube.com/playlist?list=test', status: 'completed',
    isPlaylist: true, playlistSongCount: 12, files: ['song.mp3'], folderName: 'My playlist',
    outputDir: '/original/output/path', command: 'original command', output: 'original stdout and stderr',
    initiatedBy: { id: 'admin-id', name: 'Admin' }, createdAt: new Date().toISOString()
  };
  const jobs = [job, { ...job, id: 'old-duplicate' }, { ...job, id: 'interrupted', status: 'running' }];
  const authText = JSON.stringify(auth);
  const jobsText = JSON.stringify(jobs);
  await fs.writeFile(process.env.AUTH_STORE_PATH, authText);
  await fs.writeFile(process.env.JOB_STORE_PATH, jobsText);

  const database = openDatabase();
  assert.deepEqual(readUser(database, 'admin-id'), {
    ...auth.users[0], credentials: [{ ...auth.users[0].credentials[0], createdAt: null, lastUsedAt: null }]
  });
  assert.equal(database.prepare('SELECT count(*) AS count FROM jobs').get().count, 3);
  const store = await import(`../src/authStore.js?migration=${crypto.randomUUID()}`);
  assert.equal(store.getSessionUser('test-session').id, 'admin-id');
  assert.deepEqual(store.findCredential('key-id').credential.publicKey, Buffer.from('public-key'));
  const manager = await import(`../src/jobManager.js?migration=${crypto.randomUUID()}`);
  assert.deepEqual(manager.getJob('finished'), { ...job, playlistTitle: 'My playlist' });
  assert.equal(manager.getJob('interrupted').status, 'failed');
  assert.match(manager.getJob('interrupted').error, /interrupted/);
  assert.equal(await fs.readFile(process.env.AUTH_STORE_PATH, 'utf8'), authText);
  assert.equal(await fs.readFile(process.env.JOB_STORE_PATH, 'utf8'), jobsText);

  database.prepare('DELETE FROM jobs').run();
  database.prepare('DELETE FROM users').run();
  closeDatabases();
  const reopened = openDatabase();
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
});

test('malformed legacy history rolls back auth migration and can be retried', async () => {
  await fs.writeFile(process.env.AUTH_STORE_PATH, JSON.stringify(legacyAuth()));
  await fs.writeFile(process.env.JOB_STORE_PATH, '{broken JSON');
  assert.throws(() => openDatabase(), /Unable to migrate/);
  const inspection = new Database(process.env.DATABASE_PATH);
  try {
    assert.equal(inspection.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, 0);
  } finally {
    inspection.close();
  }
  await fs.writeFile(process.env.JOB_STORE_PATH, '[]');
  const database = openDatabase();
  assert.equal(database.prepare('SELECT count(*) AS count FROM users').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM migrations').get().count, 2);
});

test('migration rejects a passkey assigned to multiple users without partial import', async () => {
  const auth = legacyAuth();
  auth.users.push({ ...auth.users[0], id: 'other-id', name: 'Other', userHandle: 'other-handle' });
  await fs.writeFile(process.env.AUTH_STORE_PATH, JSON.stringify(auth));
  assert.throws(() => openDatabase(), /passkey cannot belong to multiple users/);
  await fs.writeFile(process.env.AUTH_STORE_PATH, JSON.stringify(legacyAuth()));
  const database = openDatabase();
  assert.equal(database.prepare('SELECT count(*) AS count FROM users').get().count, 1);
});

test('database constraints and indexes protect credential and session identity', async () => {
  await fs.writeFile(process.env.AUTH_STORE_PATH, JSON.stringify(legacyAuth()));
  const database = openDatabase();
  assert.throws(() => database.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('hash', 'missing-user', '2099-01-01'), /FOREIGN KEY/);
  assert.throws(() => database.prepare('INSERT INTO credentials (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)')
    .run('key-id', 'admin-id', 'other', 0, '[]'), /UNIQUE/);
  const plan = database.prepare('EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE url = ? ORDER BY created_at DESC LIMIT 1').all('url');
  assert.ok(plan.some((row) => row.detail.includes('jobs_url')));
  assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
});

test('credential date migration preserves existing passkeys and sessions without fabricating history', async () => {
  await fs.writeFile(process.env.AUTH_STORE_PATH, JSON.stringify(legacyAuth()));
  const database = openDatabase();
  database.exec('ALTER TABLE credentials DROP COLUMN created_at; ALTER TABLE credentials DROP COLUMN last_used_at');
  const original = database.prepare('SELECT * FROM credentials').get();
  const session = database.prepare('SELECT * FROM sessions').get();
  closeDatabases();

  const migrated = openDatabase();
  assert.deepEqual(migrated.prepare('SELECT * FROM credentials').get(), {
    ...original, created_at: null, last_used_at: null
  });
  assert.deepEqual(migrated.prepare('SELECT * FROM sessions').get(), session);
  assert.equal(readUser(migrated, 'admin-id').credentials[0].createdAt, null);
  assert.equal(readUser(migrated, 'admin-id').credentials[0].lastUsedAt, null);
  const createdAt = '2026-09-27T13:00:00.000Z';
  const lastUsedAt = '2026-09-28T14:30:00.000Z';
  const user = readUser(migrated, 'admin-id');
  user.credentials.push({ ...user.credentials[0], id: 'dated-key', createdAt, lastUsedAt });
  writeUser(migrated, user);
  const stale = readUser(migrated, user.id);
  migrated.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run('2026-09-28T15:00:00.000Z', 'dated-key');
  writeUser(migrated, stale);
  closeDatabases();

  const reopened = openDatabase();
  const dated = readUser(reopened, user.id).credentials.find(({ id }) => id === 'dated-key');
  assert.equal(dated.createdAt, createdAt);
  assert.equal(dated.lastUsedAt, '2026-09-28T15:00:00.000Z');
  assert.equal(readUser(reopened, user.id).credentials.find(({ id }) => id === 'key-id').createdAt, null);
  assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
});

test('existing backup tables migrate without losing records and retain them after account deletion and restart', async () => {
  await fs.writeFile(process.env.AUTH_STORE_PATH, JSON.stringify(legacyAuth()));
  const database = openDatabase();
  database.exec(`
    DROP TABLE library_backups;
    CREATE TABLE library_backups (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      schedule TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK(json_valid(schedule)),
      next_run_at TEXT,
      latest TEXT CHECK(latest IS NULL OR json_valid(latest)),
      running INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT
    );
  `);
  const backup = {
    user_id: 'admin-id',
    schedule: JSON.stringify({ enabled: true, frequency: 'daily', time: '03:00', format: 'android' }),
    next_run_at: '2026-09-24T03:00:00.000Z',
    latest: JSON.stringify({ id: crypto.randomUUID(), format: 'android', createdAt: '2026-09-23T03:00:00.000Z', sizeBytes: 123 }),
    running: 1,
    last_attempt_at: '2026-09-23T03:00:00.000Z',
    last_error: 'Previous error'
  };
  database.prepare(`INSERT INTO library_backups (user_id, schedule, next_run_at, latest, running, last_attempt_at, last_error)
    VALUES (@user_id, @schedule, @next_run_at, @latest, @running, @last_attempt_at, @last_error)`).run(backup);
  closeDatabases();

  const migrated = openDatabase();
  assert.deepEqual(migrated.prepare('SELECT * FROM library_backups').get(), backup);
  assert.deepEqual(migrated.pragma('foreign_key_list(library_backups)'), []);
  assert.throws(() => migrated.prepare("UPDATE library_backups SET latest = 'invalid JSON'").run(), /CHECK/);
  migrated.prepare('DELETE FROM users WHERE id = ?').run('admin-id');
  assert.equal(migrated.prepare('SELECT count(*) AS count FROM credentials').get().count, 0);
  assert.equal(migrated.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
  assert.deepEqual(migrated.prepare('SELECT * FROM library_backups').get(), backup);
  assert.deepEqual(migrated.pragma('foreign_key_check'), []);
  closeDatabases();

  const reopened = openDatabase();
  assert.deepEqual(reopened.prepare('SELECT * FROM library_backups').get(), backup);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
});