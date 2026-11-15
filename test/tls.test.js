import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import selfsigned from 'selfsigned';
import { loadHttpsOptions } from '../src/tls.js';

test('local TLS certificates preserve the default CN and serve a separate tertiary CN through SNI', async (context) => {
  const keys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY', 'PASSKEY_RP_ID_TERTIARY', 'PASSKEY_ORIGIN_TERTIARY', 'HTTPS_KEY_PATH', 'HTTPS_CERT_PATH', 'DOCKER_BIND_ADDRESS'];
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
  process.env.PASSKEY_RP_ID_TERTIARY = 'third.example.com';
  process.env.PASSKEY_ORIGIN_TERTIARY = 'https://player.third.example.com:4123';
  const third = await loadHttpsOptions();
  assert.notEqual(third.cert, migrated.cert);
  const thirdCertificate = new X509Certificate(third.cert);
  for (const host of ['buytdlp.duckdns.org', '192-168-6-66.sslip.io', 'third.example.com', 'player.third.example.com']) {
    assert.ok(thirdCertificate.checkHost(host));
  }
  assert.equal(thirdCertificate.toLegacyObject().subject.CN, '192-168-6-66.sslip.io');
  const tertiaryCertPath = path.resolve('data', 'tls', 'server-tertiary-cert.pem');
  const tertiaryCertificate = new X509Certificate(files.get(tertiaryCertPath));
  assert.equal(tertiaryCertificate.toLegacyObject().subject.CN, 'third.example.com');
  assert.ok(tertiaryCertificate.checkHost('third.example.com'));
  assert.ok(tertiaryCertificate.checkHost('player.third.example.com'));
  const reused = await loadHttpsOptions();
  assert.equal(reused.cert, third.cert);
  assert.equal(new X509Certificate(files.get(tertiaryCertPath)).fingerprint256, tertiaryCertificate.fingerprint256);
  assert.equal(writes.mock.callCount(), 10);

  const server = https.createServer(reused, (_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const peerCertificate = (servername) => new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1', port: server.address().port, servername, rejectUnauthorized: false
      }, () => {
        const peer = socket.getPeerCertificate();
        socket.destroy();
        resolve(peer);
      });
      socket.once('error', reject);
    });
    for (const servername of ['third.example.com', 'player.third.example.com', 'PLAYER.THIRD.EXAMPLE.COM']) {
      const peer = await peerCertificate(servername);
      assert.equal(peer.subject.CN, 'third.example.com');
      assert.equal(peer.fingerprint256, tertiaryCertificate.fingerprint256);
    }
    for (const servername of ['buytdlp.duckdns.org', '192-168-6-66.sslip.io', 'unknown.example.com', undefined]) {
      assert.equal((await peerCertificate(servername)).subject.CN, '192-168-6-66.sslip.io');
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  files.set(tertiaryCertPath, third.cert);
  const repaired = await loadHttpsOptions();
  assert.equal(repaired.cert, third.cert);
  assert.equal(new X509Certificate(files.get(tertiaryCertPath)).toLegacyObject().subject.CN, 'third.example.com');
  assert.equal(writes.mock.callCount(), 12);
  process.env.HTTPS_KEY_PATH = 'custom-key.pem';
  process.env.HTTPS_CERT_PATH = 'custom-cert.pem';
  files.set(path.resolve('custom-key.pem'), 'custom key');
  files.set(path.resolve('custom-cert.pem'), 'custom cert');
  assert.deepEqual(await loadHttpsOptions(), { key: 'custom key', cert: 'custom cert' });
  assert.equal(writes.mock.callCount(), 12);
});