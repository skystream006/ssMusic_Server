import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

export function createPostgresDatabase(connection = process.env.DATABASE_URL || {
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE
}) {
  const settings = typeof connection === 'string' ? { connectionString: connection } : connection;
  const pool = new pg.Pool({
    ...settings, types: { getTypeParser(oid, format) {
      if (oid === 20) return Number;
      if (oid === 114 || oid === 3802) return (value) => value;
      return pg.types.getTypeParser(oid, format);
    } },
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    connectionTimeoutMillis: 30_000
  });
  pool.on('error', (error) => console.error('PostgreSQL connection failed:', error.message));
  const context = new AsyncLocalStorage();
  async function transaction(operation, lock) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(735916, $1)', [lock]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  const ready = transaction(async (client) => {
    await client.query(await readFile(new URL('./postgresSchema.sql', import.meta.url), 'utf8'));
  }, 0);
  ready.catch(() => {});
  async function query(sql, parameters = []) {
    await ready;
    return (context.getStore() || pool).query(sql, parameters);
  }
  return {
    ready,
    prepare(sql) {
      return {
        async all(...parameters) { return (await query(sql, parameters)).rows; },
        async get(...parameters) { return (await query(sql, parameters)).rows[0]; },
        async run(...parameters) { return { changes: (await query(sql, parameters)).rowCount }; }
      };
    },
    async exec(sql) { await query(sql); },
    async withTransaction(operation) {
      await ready;
      if (context.getStore()) return operation();
      return transaction((client) => context.run(client, operation), 1);
    },
    async close() { await ready.catch(() => {}); await pool.end(); }
  };
}