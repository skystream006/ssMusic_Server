import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';

const execute = promisify(execFile);
let container;
let child;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  child?.kill(signal);
});

try {
  let connectionString = process.env.TEST_POSTGRES_URL;
  if (!connectionString) {
    container = `ssytdlp-tests-${crypto.randomUUID()}`;
    const password = crypto.randomBytes(32).toString('hex');
    console.log('Starting disposable PostgreSQL test database...');
    await execute('docker', ['run', '--detach', '--rm', '--name', container,
      '--env', 'POSTGRES_DB=ssytdlp_test', '--env', `POSTGRES_PASSWORD=${password}`,
      '--publish', '127.0.0.1::5432', 'postgres:17-bookworm']);
    const { stdout } = await execute('docker', ['port', container, '5432/tcp']);
    connectionString = `postgres://postgres:${password}@${stdout.trim()}/ssytdlp_test`;
  }
  if (new URL(connectionString).pathname !== '/ssytdlp_test') throw new Error('Tests require a disposable database named ssytdlp_test.');
  for (let attempt = 0; ; attempt += 1) {
    if (interrupted) throw new Error('Tests interrupted.');
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
    try { await client.connect(); await client.query('SELECT 1'); break; }
    catch (error) {
      if (!container || attempt >= 30) throw error;
      await setTimeout(500);
    } finally { await client.end().catch(() => {}); }
  }
  child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, TEST_POSTGRES_URL: connectionString }
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Docker is required unless TEST_POSTGRES_URL is configured.' : `Test runner failed: ${error.stderr || error.message}`);
  process.exitCode = 1;
} finally {
  if (container) await execute('docker', ['stop', container]).catch(() => {});
}