import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import selfsigned from 'selfsigned';
import { loadHttpsOptions } from '../src/tls.js';

test('local TLS certificates use the secondary CN, preserve both hostnames and replace legacy CNs', async (context) => {
  const keys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY', 'HTTPS_KEY_PATH', 'HTTPS_CERT_PATH', 'DOCKER_BIND_ADDRESS'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  context.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  process.env.PASSKEY_RP_ID = 'buytdlp.duckdns.org';
  process.env.PASSKEY_ORIGIN = 'https://buytdlp.duckdns.org';
  for (const key of keys.slice(2)) delete process.env[key];
  const files = new Map();
  context.mock.method(fs, 'readFile', async (file) => {
    if (!files.has(file)) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    return files.get(file);
  });
  const writes = context.mock.method(fs, 'writeFile', async (file, content) => { files.set(file, content); });
  context.mock.method(fs, 'mkdir', async () => {});
  const first = await loadHttpsOptions();
  assert.ok(new X509Certificate(first.cert).checkHost('buytdlp.duckdns.org'));
  assert.equal(new X509Certificate(first.cert).toLegacyObject().subject.CN, 'buytdlp.duckdns.org');
  process.env.PASSKEY_RP_ID_SECONDARY = '192-168-6-66.sslip.io';
  process.env.PASSKEY_ORIGIN_SECONDARY = 'https://192-168-6-66.sslip.io:4123';
  process.env.DOCKER_BIND_ADDRESS = '192.168.6.66';
  const second = await loadHttpsOptions();
  assert.notEqual(second.cert, first.cert);
  const certificate = new X509Certificate(second.cert);
  assert.ok(certificate.checkIP('192.168.6.66'));
  assert.equal(certificate.toLegacyObject().subject.CN, '192-168-6-66.sslip.io');
  for (const host of ['buytdlp.duckdns.org', '192-168-6-66.sslip.io', 'localhost']) assert.ok(certificate.checkHost(host));
  assert.equal((await loadHttpsOptions()).cert, second.cert);
  assert.equal(writes.mock.callCount(), 4);
  const legacy = await selfsigned.generate([{ name: 'commonName', value: 'buytdlp.duckdns.org' }], {
    algorithm: 'sha256', keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [
      ...['buytdlp.duckdns.org', '192-168-6-66.sslip.io', 'localhost'].map((value) => ({ type: 2, value })),
      { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }
    ] }]
  });
  files.set(path.resolve('data/tls/server-cert.pem'), legacy.cert);
  files.set(path.resolve('data/tls/server-key.pem'), legacy.private);
  const migrated = await loadHttpsOptions();
  assert.notEqual(migrated.cert, legacy.cert);
  const migratedCertificate = new X509Certificate(migrated.cert);
  assert.ok(migratedCertificate.checkIP('192.168.6.66'));
  assert.equal(migratedCertificate.toLegacyObject().subject.CN, '192-168-6-66.sslip.io');
  assert.ok(migratedCertificate.checkHost('buytdlp.duckdns.org'));
  assert.ok(migratedCertificate.checkHost('192-168-6-66.sslip.io'));
  assert.equal((await loadHttpsOptions()).cert, migrated.cert);
  assert.equal(writes.mock.callCount(), 6);
  process.env.HTTPS_KEY_PATH = 'custom-key.pem';
  process.env.HTTPS_CERT_PATH = 'custom-cert.pem';
  files.set(path.resolve('custom-key.pem'), 'custom key');
  files.set(path.resolve('custom-cert.pem'), 'custom cert');
  assert.deepEqual(await loadHttpsOptions(), { key: 'custom key', cert: 'custom cert' });
  assert.equal(writes.mock.callCount(), 6);
});