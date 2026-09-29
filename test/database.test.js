import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { closeDatabases, openDatabase, readUser, writeUser, withTransaction } from '../src/database.js';
import { createTestDatabase } from '../test-support/postgres.js';

beforeEach(createTestDatabase);

function userRecord() {
  const now = new Date().toISOString();
  return {
    id: 'admin-id', name: 'Admin', userHandle: 'handle', role: 'admin', status: 'approved',
    createdAt: now, updatedAt: now,
    credentials: [{ id: 'key-id', publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 7, transports: ['internal'], createdAt: now, lastUsedAt: null }]
  };
}

test('async transactions roll back and isolate queries outside the transaction', async () => {
  const database = openDatabase();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const pending = withTransaction(database, async () => {
    await database.prepare('INSERT INTO migrations (name) VALUES ($1)').run('uncommitted');
    entered.resolve();
    await release.promise;
    throw new Error('Rollback fixture');
  });
  await entered.promise;
  const outside = Promise.resolve((await database.prepare('SELECT name FROM migrations WHERE name = $1').get('uncommitted')));
  release.resolve();
  await assert.rejects(pending, /Rollback fixture/);
  assert.equal(await outside, undefined);
  await withTransaction(database, async () => {
    await database.prepare('INSERT INTO migrations (name) VALUES ($1)').run('committed');
    await withTransaction(database, async () => {
      assert.equal((await database.prepare('SELECT name FROM migrations WHERE name = $1').get('committed')).name, 'committed');
    });
  });
  assert.equal((await database.prepare('SELECT name FROM migrations WHERE name = $1').get('committed')).name, 'committed');
});

test('PostgreSQL credentials and sessions retain identity across reconnects', async () => {
  const database = openDatabase();
  const user = userRecord();
  await writeUser(database, user);
  await database.prepare('INSERT INTO sessions VALUES ($1, $2, $3)').run('session-hash', user.id, '2099-01-01');
  await database.prepare('UPDATE credentials SET last_used_at = $1 WHERE id = $2').run('2026-09-28T15:00:00.000Z', 'key-id');
  await writeUser(database, user);
  await closeDatabases();
  const reopened = openDatabase();
  assert.deepEqual(await readUser(reopened, user.id), {
    ...user, credentials: [{ ...user.credentials[0], lastUsedAt: '2026-09-28T15:00:00.000Z' }]
  });
  assert.equal((await reopened.prepare('SELECT user_id FROM sessions WHERE token_hash = $1').get('session-hash')).user_id, user.id);
});

test('PostgreSQL constraints protect credentials and roll back conflicting account writes', async () => {
  const database = openDatabase();
  const user = userRecord();
  await writeUser(database, user);
  await assert.rejects(database.prepare('INSERT INTO sessions VALUES ($1, $2, $3)').run('hash', 'missing', '2099-01-01'), { code: '23503' });
  await assert.rejects(database.prepare('INSERT INTO credentials (id, user_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5)')
    .run('key-id', user.id, 'other', 0, '[]'), { code: '23505' });
  await assert.rejects(withTransaction(database, () => writeUser(database, { ...user, id: 'other', name: 'Other' })), /passkey cannot belong to multiple users/);
  assert.equal(await readUser(database, 'other'), null);
  const indexes = await database.prepare("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'jobs'").all();
  assert.ok(indexes.some((row) => row.indexname === 'jobs_url'));
});

test('PostgreSQL retains backup records after account deletion and reconnect', async () => {
  const database = openDatabase();
  const user = userRecord();
  await writeUser(database, user);
  await database.prepare('INSERT INTO sessions VALUES ($1, $2, $3)').run('session-hash', user.id, '2099-01-01');
  const latest = { id: 'archive-id', sizeBytes: 123, format: 'android' };
  await database.prepare('INSERT INTO library_backups (user_id, latest) VALUES ($1, $2)').run(user.id, JSON.stringify(latest));
  await assert.rejects(database.prepare("UPDATE library_backups SET latest = 'invalid JSON'").run(), { code: '22P02' });
  await database.prepare('DELETE FROM users WHERE id = $1').run(user.id);
  assert.equal((await database.prepare('SELECT count(*) AS count FROM credentials').get()).count, 0);
  assert.equal((await database.prepare('SELECT count(*) AS count FROM sessions').get()).count, 0);
  await closeDatabases();
  assert.deepEqual(JSON.parse((await openDatabase().prepare('SELECT latest FROM library_backups WHERE user_id = $1').get(user.id)).latest), latest);
});
