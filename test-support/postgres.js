import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { closeDatabases, openDatabase } from '../src/database.js';

export async function createTestDatabase(context, { beforeCleanup = async () => {} } = {}) {
  if (!process.env.TEST_POSTGRES_URL) throw new Error('Run npm test or configure TEST_POSTGRES_URL for a disposable PostgreSQL database.');
  const target = new URL(process.env.TEST_POSTGRES_URL);
  if (target.pathname !== '/ssmusic_test') throw new Error('TEST_POSTGRES_URL must use the disposable ssmusic_test database.');
  const name = `ssmusic_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-test-'));
  const previousUrl = process.env.DATABASE_URL;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    target.pathname = `/${name}`;
    process.env.DATABASE_URL = target.toString();
    const database = openDatabase();
    await database.ready;
    context.after(async () => {
      try { await beforeCleanup(); }
      finally {
        await closeDatabases();
        try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
        finally {
          await admin.end();
          await fs.rm(directory, { recursive: true, force: true });
          if (previousUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousUrl;
        }
      }
    });
    return { directory, database };
  } catch (error) {
    await closeDatabases();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    throw error;
  }
}