import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';
import { readPostgresJob } from '../src/postgresCatalog.js';
import { createTestDatabase } from '../test-support/postgres.js';

async function testSecondaryPasskeyOptions(context) {
  const envKeys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.PASSKEY_RP_ID = 'music.example.com';
  process.env.PASSKEY_ORIGIN = 'https://music.example.com';
  process.env.PASSKEY_RP_ID_SECONDARY = '192-168-6-66.sslip.io';
  process.env.PASSKEY_ORIGIN_SECONDARY = 'https://192-168-6-66.sslip.io:4123';
  const { registerAuthRoutes } = await import('../src/auth.js');
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(async () => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [origin, expectedRPID] of [
    [undefined, process.env.PASSKEY_RP_ID],
    [process.env.PASSKEY_ORIGIN, process.env.PASSKEY_RP_ID],
    [process.env.PASSKEY_ORIGIN_SECONDARY, process.env.PASSKEY_RP_ID_SECONDARY],
    ['https://192-168-6-66.sslip.io:4124', process.env.PASSKEY_RP_ID],
    ['https://untrusted.example', process.env.PASSKEY_RP_ID]
  ]) {
    for (const flow of ['register', 'login']) {
      const response = await fetch(`${base}/api/auth/${flow}/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ name: 'Local listener' })
      });
      assert.equal(response.status, 200);
      const { options, requestId } = await response.json();
      await fetch(`${base}/api/auth/${flow}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId })
      });
      assert.equal(flow === 'register' ? options.rp.id : options.rpId, expectedRPID);
    }
  }
  for (const missingKey of ['PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY']) {
    const value = process.env[missingKey];
    delete process.env[missingKey];
    const response = await fetch(`${base}/api/auth/login/options`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Set both/);
    process.env[missingKey] = value;
  }
  process.env.PASSKEY_RP_ID_SECONDARY = '192.168.6.66';
  const invalidRPID = await fetch(`${base}/api/auth/login/options`, {
    method: 'POST', headers: { Origin: process.env.PASSKEY_ORIGIN_SECONDARY }
  });
  assert.equal(invalidRPID.status, 500);
  assert.match((await invalidRPID.json()).error, /hostname, not an IP address/);
}

test('PAT HTTP lifecycle and user/admin authorization', async (context) => {
  let server;
  const { directory } = await createTestDatabase(context, { beforeCleanup: async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } });
  const store = await import('../src/authStore.js');
  const { attachUser, registerAuthRoutes, requireAuth } = await import('../src/auth.js');
  const credential = (id) => ({ id, publicKey: Buffer.from(id), counter: 0 });
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const user = await store.registerUser('Listener', 'listener', credential('listener'));
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const adminSession = await store.createSession(admin.id);
  const userSession = await store.createSession(user.id);
  const adminHeaders = { Cookie: `ssytdlp_session=${adminSession.token}` };
  const userHeaders = { Cookie: `ssytdlp_session=${userSession.token}` };
  const app = express();
  app.use(express.json(), attachUser);
  registerAuthRoutes(app);
  app.post('/protected', requireAuth, (req, res) => res.json({ userId: req.user.id }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, method = 'GET', headers = {}, body) => fetch(`${base}${url}`, {
    method, headers: { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  await context.test('admins rename users and sessions rename only their own username', async () => {
    assert.equal((await call('/api/auth/me', 'PATCH', {}, { name: 'Anonymous' })).status, 401);
    assert.equal((await call(`/api/admin/users/${admin.id}`, 'PATCH', userHeaders, { name: 'Intruder' })).status, 403);
    for (const body of [{ name: 'Changed', role: 'admin' }, { name: 'Changed', sharedUserIds: [admin.id] }, { name: 'Changed', id: admin.id }, {}]) {
      assert.equal((await call('/api/auth/me', 'PATCH', userHeaders, body)).status, 400);
    }
    assert.equal((await call('/api/auth/me', 'PATCH', userHeaders, { name: 'ADMIN' })).status, 409);
    assert.equal((await call('/api/auth/me', 'PATCH', userHeaders, { name: 'x' })).status, 400);
    const renamed = await call('/api/auth/me', 'PATCH', userHeaders, { name: '  New   Listener ' });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).user.name, 'New Listener');
    assert.equal((await (await call('/api/auth/me', 'GET', userHeaders)).json()).user.name, 'New Listener');
    const restored = await call(`/api/admin/users/${user.id}`, 'PATCH', adminHeaders, { name: 'Listener' });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).user.name, 'Listener');
    const selfAdmin = await call('/api/auth/me', 'PATCH', adminHeaders, { name: 'Admin' });
    assert.equal(selfAdmin.status, 200);
    assert.equal((await selfAdmin.json()).user.role, 'admin');
  });
  await context.test('link and organizer HTTP routes require consent and account-scoped sessions', async () => {
    const pending = await store.registerUser('Pending link', 'pending-link', credential('pending-link'));
    const viewer = await store.registerUser('Shared car', 'shared-car', credential('shared-car'), { role: 'shared', organizerId: user.id });
    await store.updateUser(viewer.id, { status: 'approved' }, admin.id);
    const viewerSession = await store.createSession(viewer.id);
    const viewerHeaders = { Cookie: `ssytdlp_session=${viewerSession.token}` };
    const userPat = await store.createPrivateAccessToken(user.id, 'Link test');
    const organizerRoute = `/api/auth/shared-users/${viewer.id}/libraries`;
    const directoryResponse = await call('/api/auth/register/users');
    assert.equal(directoryResponse.status, 200);
    assert.equal(directoryResponse.headers.get('cache-control'), 'no-store');
    const directory = (await directoryResponse.json()).users;
    assert.deepEqual(new Set(directory.map(({ id }) => id)), new Set([admin.id, user.id]));
    assert.ok(directory.every((record) => Object.keys(record).sort().join(',') === 'id,name'));
    for (const route of ['/api/auth/links', '/api/auth/shared-users']) {
      assert.equal((await call(route)).status, 401);
      assert.equal((await call(route, 'GET', { 'X-PAT': userPat.token })).status, 401);
      assert.equal((await call(route, 'GET', viewerHeaders)).status, 403);
    }
    assert.equal((await call('/api/auth/links', 'POST', userHeaders, { userId: user.id })).status, 400);
    assert.equal((await call('/api/auth/links', 'POST', userHeaders, { userId: pending.id })).status, 403);
    assert.equal((await call('/api/auth/links', 'POST', userHeaders, { userId: admin.id })).status, 201);
    assert.equal((await call(`/api/auth/links/${admin.id}/accept`, 'POST', userHeaders)).status, 404);
    assert.equal((await call(organizerRoute, 'PUT', userHeaders, { sharedUserIds: [admin.id] })).status, 403);
    assert.equal((await call(`/api/auth/links/${user.id}/accept`, 'POST', adminHeaders)).status, 200);
    const managed = await (await call('/api/auth/shared-users', 'GET', userHeaders)).json();
    assert.equal(managed.users[0].id, viewer.id);
    assert.deepEqual(managed.users[0].sharedUserIds, []);
    assert.deepEqual(new Set(managed.libraries.map(({ id }) => id)), new Set([admin.id, user.id]));
    for (const headers of [{}, { 'X-PAT': userPat.token }]) {
      assert.equal((await call(organizerRoute, 'PUT', headers, { sharedUserIds: [admin.id] })).status, 401);
    }
    assert.equal((await call(organizerRoute, 'PUT', adminHeaders, { sharedUserIds: [admin.id] })).status, 404);
    assert.equal((await call(organizerRoute, 'PUT', viewerHeaders, { sharedUserIds: [admin.id] })).status, 403);
    assert.equal((await call(organizerRoute, 'PUT', userHeaders, { sharedUserIds: [admin.id], role: 'admin' })).status, 400);
    const granted = await call(organizerRoute, 'PUT', { Authorization: `Bearer ${userSession.token}` }, { sharedUserIds: [admin.id] });
    assert.equal(granted.status, 200);
    assert.deepEqual((await granted.json()).user.sharedUserIds, [admin.id]);
    assert.equal((await call(`/api/auth/links/${admin.id}`, 'DELETE', userHeaders)).status, 204);
    assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, []);
    assert.equal((await call(`/api/auth/links/${admin.id}`, 'DELETE', userHeaders)).status, 404);
    const reassigned = await call(`/api/admin/users/${viewer.id}`, 'PATCH', adminHeaders, { organizerId: admin.id });
    assert.equal(reassigned.status, 200);
    assert.equal((await reassigned.json()).user.organizerId, admin.id);
    assert.equal((await call(organizerRoute, 'PUT', userHeaders, { sharedUserIds: [user.id] })).status, 404);
    assert.equal((await call(organizerRoute, 'PUT', adminHeaders, { sharedUserIds: [admin.id] })).status, 200);
    const accountDetails = await (await call(`/api/admin/users/${viewer.id}`, 'GET', adminHeaders)).json();
    assert.deepEqual(accountDetails.libraries, [{ id: admin.id, name: admin.name }]);
    assert.deepEqual((await (await call('/api/auth/shared-users', 'GET', adminHeaders)).json()).users[0].sharedUserIds, [admin.id]);
    for (const account of [{ role: 'admin' }, { role: 'shared' }, { role: 'shared', organizerId: pending.id },
      { role: 'shared', organizerId: viewer.id }, { role: 'user', organizerId: user.id }]) {
      assert.equal((await call('/api/auth/register/options', 'POST', {}, { name: 'Signup', ...account })).status, 400);
    }
    await store.deleteUser(viewer.id, admin.id);
    await store.deleteUser(pending.id, admin.id);
    await store.deletePrivateAccessToken(user.id, userPat.id);
  });

  const mobileSession = await store.createSession(user.id);
  const mobileHeaders = { Authorization: `Bearer ${mobileSession.token}` };
  assert.deepEqual(await (await call('/protected', 'POST', mobileHeaders)).json(), { userId: user.id });
  assert.equal((await (await call('/api/auth/me', 'GET', mobileHeaders)).json()).user.id, user.id);
  assert.equal((await call('/api/auth/pats', 'GET', mobileHeaders)).status, 200);
  assert.equal((await call('/api/admin/users', 'GET', mobileHeaders)).status, 403);
  assert.equal((await call('/protected', 'POST', { ...userHeaders, Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await call('/protected', 'POST', { ...userHeaders, Authorization: `Basic ${mobileSession.token}` })).status, 401);
  const mobileLogout = await call('/api/auth/logout', 'POST', { ...userHeaders, ...mobileHeaders });
  assert.equal(mobileLogout.status, 204);
  assert.equal(mobileLogout.headers.get('set-cookie'), null);
  assert.equal((await call('/protected', 'POST', mobileHeaders)).status, 401);
  assert.equal((await call('/protected', 'POST', userHeaders)).status, 200);
  assert.equal((await call('/api/auth/pats', 'POST', {}, { name: 'No login' })).status, 401);
  assert.equal((await call('/api/auth/pats', 'POST', userHeaders, { name: ' ' })).status, 400);
  const created = await call('/api/auth/pats', 'POST', userHeaders, { name: 'Automation' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const pat = await created.json();
  const patHeaders = { 'X-PAT': pat.token };
  assert.deepEqual(await (await call('/protected', 'POST', patHeaders)).json(), { userId: user.id });
  assert.equal((await call('/protected', 'POST', { Authorization: `Bearer ${pat.token}` })).status, 401);
  assert.equal((await call('/protected', 'POST', { ...userHeaders, 'X-PAT': 'bad' })).status, 401);
  assert.equal((await call('/api/auth/pats', 'POST', patHeaders, { name: 'Chained' })).status, 401);
  assert.equal((await call('/api/auth/api-token', 'POST', userHeaders)).status, 404);
  const listed = await (await call('/api/auth/pats', 'GET', userHeaders)).json();
  assert.deepEqual(listed.tokens, [{ id: pat.id, name: pat.name, createdAt: pat.createdAt }]);
  assert.equal((await call(`/api/auth/pats/${pat.id}`, 'DELETE', adminHeaders)).status, 404);
  assert.equal((await call(`/api/admin/users/${admin.id}`, 'GET', userHeaders)).status, 403);
  assert.equal((await call(`/api/admin/users/${user.id}/pats/${pat.id}`, 'DELETE', userHeaders)).status, 403);
  const details = await (await call(`/api/admin/users/${user.id}`, 'GET', adminHeaders)).json();
  assert.equal(details.user.id, user.id);
  assert.deepEqual(details.tokens, listed.tokens);
  assert.equal((await call(`/api/admin/users/missing`, 'GET', adminHeaders)).status, 404);
  assert.equal((await call(`/api/admin/users/${user.id}/pats/${pat.id}`, 'DELETE', adminHeaders)).status, 204);
  assert.equal((await call('/protected', 'POST', patHeaders)).status, 401);
  const second = await (await call('/api/auth/pats', 'POST', userHeaders, { name: 'Laptop' })).json();
  assert.equal((await call(`/api/auth/pats/${second.id}`, 'DELETE', userHeaders)).status, 204);
  assert.equal((await call('/protected', 'POST', { 'X-PAT': second.token })).status, 401);

  await context.test('admin user deletion removes account access, protects admins, and preserves jobs', async () => {
    const target = await store.registerUser('Delete Listener', 'delete-listener', credential('delete-listener'));
    await store.updateUser(target.id, { status: 'approved' }, admin.id);
    const session = await store.createSession(target.id);
    const mobile = await store.createSession(target.id);
    const token = await store.createPrivateAccessToken(target.id, 'Delete token');
    const adminToken = await store.createPrivateAccessToken(admin.id, 'Admin automation');
    const route = `/api/admin/users/${target.id}`;
    const database = openDatabase();
    (await database.prepare('INSERT INTO user_preferences (user_id) VALUES ($1)').run(target.id));
    (await database.prepare('INSERT INTO library_backups (user_id) VALUES ($1)').run(target.id));
    const backup = (await database.prepare('SELECT * FROM library_backups WHERE user_id = $1').get(target.id));
    const job = { id: 'retained-job', url: 'https://example.com/music', status: 'completed', initiatedBy: target };
    (await writeJob(database, job));

    assert.equal((await call(route, 'DELETE')).status, 401);
    assert.equal((await call(route, 'DELETE', userHeaders)).status, 403);
    assert.equal((await call(route, 'DELETE', { 'X-PAT': adminToken.token })).status, 401);
    assert.equal((await call(route, 'DELETE', { ...userHeaders, 'X-PAT': adminToken.token })).status, 403);
    assert.ok((await store.getUser(target.id)));
    const selfDelete = await call(`/api/admin/users/${admin.id}`, 'DELETE', adminHeaders);
    assert.equal(selfDelete.status, 409);
    assert.match((await selfDelete.json()).error, /own account/);
    await assert.rejects(store.deleteUser(admin.id, user.id), /At least one approved admin/);
    assert.ok((await store.getSessionUser(adminSession.token)));
    assert.equal((await call('/api/admin/users/missing', 'DELETE', adminHeaders)).status, 404);

    const deleted = await call(route, 'DELETE', adminHeaders);
    assert.equal(deleted.status, 204);
    assert.equal(deleted.headers.get('cache-control'), 'no-store');
    assert.equal(await deleted.text(), '');
    assert.equal((await store.getUser(target.id)), null);
    assert.equal((await store.findCredential('delete-listener')), null);
    for (const table of ['credentials', 'sessions', 'private_access_tokens', 'user_preferences']) {
      assert.equal((await database.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = $1`).get(target.id)).count, 0);
    }
    assert.deepEqual((await database.prepare('SELECT * FROM library_backups WHERE user_id = $1').get(target.id)), backup);
    for (const headers of [{ Cookie: `ssytdlp_session=${session.token}` }, { Authorization: `Bearer ${mobile.token}` }, { 'X-PAT': token.token }]) {
      assert.equal((await call('/protected', 'POST', headers)).status, 401);
    }
    assert.equal((await call(route, 'GET', adminHeaders)).status, 404);
    assert.equal((await call(route, 'DELETE', adminHeaders)).status, 404);
    assert.equal((await (await call('/api/admin/users', 'GET', adminHeaders)).json()).users.some((account) => account.id === target.id), false);
    assert.deepEqual(await readPostgresJob(database, job.id), { ...job, files: [] });
    assert.equal((await call('/protected', 'POST', userHeaders)).status, 200);

    for (const status of ['pending', 'revoked', 'approved']) {
      const account = await store.registerUser(`Delete ${status}`, status, credential(`delete-${status}`));
      await store.updateUser(account.id, { status, role: status === 'approved' ? 'admin' : 'user' }, admin.id);
      assert.equal((await call(`/api/admin/users/${account.id}`, 'DELETE', { Authorization: `Bearer ${adminSession.token}` })).status, 204);
      assert.equal((await store.getUser(account.id)), null);
    }
    const replacement = await store.registerUser('Delete Listener', 'replacement', credential('replacement'));
    assert.notEqual(replacement.id, target.id);
    assert.equal(replacement.status, 'pending');
    await store.deleteUser(replacement.id, admin.id);
    await store.deletePrivateAccessToken(admin.id, adminToken.id);
  });

  await context.test('passkey options select the configured secondary browser origin', testSecondaryPasskeyOptions);

  await context.test('approved users add multiple account-bound passkeys and log in with each', async (passkeyContext) => {
    const envKeys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY'];
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const rpID = 'music.example.com';
    const origin = `https://${rpID}`;
    process.env.PASSKEY_RP_ID = rpID;
    process.env.PASSKEY_ORIGIN = origin;
    process.env.PASSKEY_RP_ID_SECONDARY = 'local.example.com';
    process.env.PASSKEY_ORIGIN_SECONDARY = 'https://local.example.com:4123';
    passkeyContext.after(() => {
      for (const key of envKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    });

    function authenticator() {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      const credentialId = crypto.randomBytes(32);
      const id = credentialId.toString('base64url');
      const keyBytes = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      return {
        credential: { id, publicKey: keyBytes, counter: 0, transports: ['internal'] },
        register(options, registeredOrigin = origin, registeredRPID = rpID, flags = 69) {
          const idLength = Buffer.alloc(2);
          idLength.writeUInt16BE(credentialId.length);
          const authData = Buffer.concat([crypto.createHash('sha256').update(registeredRPID).digest(),
            Buffer.from([flags, 0, 0, 0, 0]), Buffer.alloc(16), idLength, credentialId, keyBytes]);
          const attestation = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
          return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
            clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: registeredOrigin })).toString('base64url'),
            attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal']
          } };
        },
        login(options, loginOrigin = origin, loginRPID = rpID) {
          const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: loginOrigin }));
          const authData = Buffer.concat([crypto.createHash('sha256').update(loginRPID).digest(), Buffer.from([5, 0, 0, 0, 0])]);
          const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), privateKey);
          return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
            clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url')
          } };
        }
      };
    }

    await passkeyContext.test('Shared passkey signup binds account type and organizer and revalidates approval', async () => {
      const key = authenticator();
      const start = await call('/api/auth/register/options', 'POST', { Origin: origin }, {
        name: 'Car passkey', role: 'shared', organizerId: user.id
      });
      assert.equal(start.status, 200);
      const attempt = await start.json();
      const body = { requestId: attempt.requestId, response: key.register(attempt.options), role: 'admin', organizerId: admin.id };
      const registered = await call('/api/auth/register/verify', 'POST', { Origin: origin }, body);
      assert.equal(registered.status, 201);
      assert.equal(registered.headers.get('set-cookie'), null);
      const { user: shared } = await registered.json();
      assert.equal(shared.role, 'shared');
      assert.equal(shared.organizerId, user.id);
      assert.equal(shared.status, 'pending');
      assert.deepEqual(shared.sharedUserIds, []);
      assert.equal((await call('/api/auth/register/verify', 'POST', { Origin: origin }, body)).status, 400);
      await store.updateUser(shared.id, { status: 'approved' }, admin.id);
      const login = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      const loggedIn = await call('/api/auth/login/verify', 'POST', { Origin: origin }, {
        requestId: login.requestId, response: key.login(login.options)
      });
      assert.equal(loggedIn.status, 200);
      assert.equal((await loggedIn.json()).user.role, 'shared');
      await store.deleteUser(shared.id, admin.id);

      const organizer = await store.registerUser('Signup organizer', 'signup-organizer', credential('signup-organizer'));
      await store.updateUser(organizer.id, { status: 'approved' }, admin.id);
      const changedKey = authenticator();
      const changed = await (await call('/api/auth/register/options', 'POST', { Origin: origin }, {
        name: 'Changed organizer', role: 'shared', organizerId: organizer.id
      })).json();
      await store.updateUser(organizer.id, { status: 'revoked' }, admin.id);
      assert.equal((await call('/api/auth/register/verify', 'POST', { Origin: origin }, {
        requestId: changed.requestId, response: changedKey.register(changed.options)
      })).status, 400);
      assert.equal(await store.findCredential(changedKey.credential.id), null);
      await store.deleteUser(organizer.id, admin.id);
    });

    const first = authenticator();
    const second = authenticator();
    const third = authenticator();
    const userHandle = crypto.randomBytes(32).toString('base64url');
    const account = await store.registerUser('Multiple Passkeys', userHandle, first.credential);
    const session = await store.createSession(account.id);
    const headers = { Cookie: `ssytdlp_session=${session.token}`, Origin: origin };
    assert.equal((await call('/api/auth/passkeys/options', 'POST', headers)).status, 401);
    assert.equal((await call('/api/auth/passkeys', 'GET', headers)).status, 401);
    assert.equal((await call(`/api/auth/passkeys/${first.credential.id}`, 'DELETE', headers)).status, 401);
    await store.updateUser(account.id, { status: 'approved' }, admin.id);
    const token = await store.createPrivateAccessToken(account.id, 'No enrollment');
    for (const unauthorized of [{}, { 'X-PAT': token.token }]) {
      assert.equal((await call('/api/auth/passkeys', 'GET', unauthorized)).status, 401);
      assert.equal((await call(`/api/auth/passkeys/${first.credential.id}`, 'DELETE', unauthorized)).status, 401);
      for (const endpoint of ['options', 'verify']) {
        assert.equal((await call(`/api/auth/passkeys/${endpoint}`, 'POST', unauthorized, {})).status, 401);
      }
    }
    assert.equal((await call('/api/auth/passkeys/options', 'POST', headers, { client: 'browser-app' })).status, 400);
    const start = async (requestHeaders = headers) => {
      const result = await call('/api/auth/passkeys/options', 'POST', requestHeaders, { userId: admin.id, name: 'Ignored name' });
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      return result.json();
    };
    const verify = (attempt, response, requestHeaders = headers) => call('/api/auth/passkeys/verify', 'POST', requestHeaders, {
      requestId: attempt.requestId, response, userId: admin.id
    });
    const originalUserCount = (await store.listUsers()).length;
    for (const key of [second, third]) {
      const attempt = await start();
      assert.equal(attempt.options.user.id, userHandle);
      assert.equal(attempt.options.user.name, account.name);
      assert.equal(attempt.options.rp.id, rpID);
      assert.equal(attempt.options.authenticatorSelection.residentKey, 'required');
      assert.equal(attempt.options.authenticatorSelection.userVerification, 'required');
      assert.deepEqual(attempt.options.excludeCredentials.map(({ id }) => id).sort(),
        [first, ...(key === third ? [second] : [])].map(({ credential: value }) => value.id).sort());
      assert.ok(attempt.options.excludeCredentials.every(({ transports }) => transports.includes('internal')));
      const response = key.register(attempt.options);
      const added = await verify(attempt, response);
      assert.equal(added.status, 201);
      assert.equal(added.headers.get('cache-control'), 'no-store');
      const result = await added.json();
      assert.equal(result.user.id, account.id);
      assert.equal(result.user.name, account.name);
      assert.equal(result.user.role, 'user');
      assert.equal(result.user.status, 'approved');
      assert.equal(result.user.credentialCount, key === second ? 2 : 3);
      assert.equal(result.user.credentials, undefined);
      assert.equal(result.passkeys.length, result.user.credentialCount);
      assert.ok(result.passkeys.some(({ id }) => id === key.credential.id));
      const enrolled = result.passkeys.find(({ id }) => id === key.credential.id);
      assert.equal(enrolled.createdAt, result.user.updatedAt);
      assert.equal(enrolled.lastUsedAt, null);
      assert.ok(Number.isFinite(Date.parse(enrolled.createdAt)));
      assert.equal((await verify(attempt, response)).status, 400);
    }
    assert.equal((await store.listUsers()).length, originalUserCount);
    for (const key of [first, second, third]) {
      const before = (await store.findCredential(key.credential.id)).credential;
      assert.equal(before.lastUsedAt, null);
      const login = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      const loginStartedAt = Date.now();
      const loggedIn = await call('/api/auth/login/verify', 'POST', { Origin: origin }, {
        requestId: login.requestId, response: key.login(login.options)
      });
      assert.equal(loggedIn.status, 200);
      assert.match(loggedIn.headers.get('set-cookie'), /ssytdlp_session=.*HttpOnly/);
      assert.equal((await loggedIn.json()).user.id, account.id);
      const after = (await store.findCredential(key.credential.id)).credential;
      assert.equal(after.createdAt, before.createdAt);
      assert.ok(Date.parse(after.lastUsedAt) >= loginStartedAt);
      assert.ok(Date.parse(after.lastUsedAt) <= Date.now());
    }

    const beforeFailedLogin = (await store.getUserPasskeys(account.id)).credentials;
    for (const invalid of ['origin', 'signature']) {
      const login = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      const response = first.login(login.options, invalid === 'origin' ? 'https://untrusted.example' : origin);
      if (invalid === 'signature') response.response.signature = second.login(login.options).response.signature;
      const denied = await call('/api/auth/login/verify', 'POST', { Origin: origin }, { requestId: login.requestId, response });
      assert.ok([400, 401].includes(denied.status));
      assert.deepEqual((await store.getUserPasskeys(account.id)).credentials, beforeFailedLogin);
    }

    const otherAccount = await start();
    assert.equal((await verify(otherAccount, authenticator().register(otherAccount.options), adminHeaders)).status, 403);
    assert.equal((await store.getUser(admin.id)).credentialCount, 1);
    for (const [badOrigin, badRPID, flags] of [['https://untrusted.example', rpID, 69], [origin, 'wrong.example.com', 69], [origin, rpID, 65]]) {
      const attempt = await start();
      assert.equal((await verify(attempt, authenticator().register(attempt.options, badOrigin, badRPID, flags))).status, 400);
    }
    const wrongChallenge = await start();
    assert.equal((await verify(wrongChallenge, authenticator().register({ challenge: 'wrong-challenge' }))).status, 400);
    const duplicate = await start();
    assert.equal((await verify(duplicate, first.register(duplicate.options))).status, 409);
    const switchedOrigin = await start();
    assert.equal((await verify(switchedOrigin, authenticator().register(switchedOrigin.options),
      { ...headers, Origin: process.env.PASSKEY_ORIGIN_SECONDARY })).status, 403);
    const wrongCeremony = await start();
    assert.equal((await call('/api/auth/register/verify', 'POST', headers, {
      requestId: wrongCeremony.requestId, response: authenticator().register(wrongCeremony.options)
    })).status, 400);
    assert.equal((await store.getUser(account.id)).credentialCount, 3);

    const secondaryHeaders = { ...headers, Origin: process.env.PASSKEY_ORIGIN_SECONDARY };
    const secondaryKey = authenticator();
    const secondaryAttempt = await start(secondaryHeaders);
    assert.equal(secondaryAttempt.options.rp.id, process.env.PASSKEY_RP_ID_SECONDARY);
    assert.equal(secondaryAttempt.options.user.id, userHandle);
    assert.equal((await verify(secondaryAttempt, secondaryKey.register(secondaryAttempt.options,
      process.env.PASSKEY_ORIGIN_SECONDARY, process.env.PASSKEY_RP_ID_SECONDARY), secondaryHeaders)).status, 201);
    const secondaryLogin = await (await call('/api/auth/login/options', 'POST', { Origin: secondaryHeaders.Origin }, {})).json();
    const secondaryLoggedIn = await call('/api/auth/login/verify', 'POST', { Origin: secondaryHeaders.Origin }, {
      requestId: secondaryLogin.requestId,
      response: secondaryKey.login(secondaryLogin.options, secondaryHeaders.Origin, process.env.PASSKEY_RP_ID_SECONDARY)
    });
    assert.equal(secondaryLoggedIn.status, 200);
    assert.equal((await secondaryLoggedIn.json()).user.id, account.id);

    await passkeyContext.test('passkey listing and deletion enforce ownership and invalidate removed keys', async (deletionContext) => {
      const listed = await call(`/api/auth/passkeys?userId=${admin.id}`, 'GET', headers);
      assert.equal(listed.status, 200);
      assert.equal(listed.headers.get('cache-control'), 'no-store');
      const listing = await listed.json();
      assert.equal(listing.user.id, account.id);
      assert.equal(listing.user.credentialCount, 4);
      assert.deepEqual(listing.passkeys.map(({ id }) => id).sort(),
        [first, second, third, secondaryKey].map(({ credential: value }) => value.id).sort());
      for (const passkey of listing.passkeys) {
        assert.deepEqual(Object.keys(passkey).sort(), ['createdAt', 'id', 'lastUsedAt', 'transports']);
        assert.deepEqual(passkey.transports, ['internal']);
        assert.ok(Number.isFinite(Date.parse(passkey.createdAt)));
        assert.ok(Date.parse(passkey.lastUsedAt) >= Date.parse(passkey.createdAt));
      }
      assert.equal(listing.user.userHandle, undefined);
      assert.equal(listing.user.credentials, undefined);
      const bearerHeaders = { Authorization: `Bearer ${session.token}` };
      assert.deepEqual(await (await call('/api/auth/passkeys', 'GET', bearerHeaders)).json(), listing);
      const mixedAuth = await (await call('/api/auth/passkeys', 'GET', { ...userHeaders, 'X-PAT': token.token })).json();
      assert.equal(mixedAuth.user.id, user.id);
      assert.deepEqual(mixedAuth.passkeys.map(({ id }) => id), ['listener']);
      assert.equal((await call('/api/auth/passkeys/admin', 'DELETE', headers)).status, 404);
      assert.equal((await call(`/api/auth/passkeys/${first.credential.id}`, 'DELETE', adminHeaders)).status, 404);
      assert.equal((await call('/api/auth/passkeys/missing', 'DELETE', headers)).status, 404);

      const deleted = await call(`/api/auth/passkeys/${second.credential.id}`, 'DELETE', bearerHeaders, { userId: admin.id });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.headers.get('cache-control'), 'no-store');
      const result = await deleted.json();
      assert.equal(result.user.id, account.id);
      assert.equal(result.user.credentialCount, 3);
      assert.equal(result.passkeys.length, 3);
      assert.equal(result.passkeys.some(({ id }) => id === second.credential.id), false);
      assert.equal((await call(`/api/auth/passkeys/${second.credential.id}`, 'DELETE', headers)).status, 404);
      const login = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      const removedLogin = await call('/api/auth/login/verify', 'POST', { Origin: origin }, {
        requestId: login.requestId, response: second.login(login.options)
      });
      assert.equal(removedLogin.status, 401);
      assert.equal(removedLogin.headers.get('set-cookie'), null);

      const pendingLogin = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      assert.equal((await call(`/api/auth/passkeys/${third.credential.id}`, 'DELETE', headers)).status, 200);
      assert.equal((await call('/api/auth/login/verify', 'POST', { Origin: origin }, {
        requestId: pendingLogin.requestId, response: third.login(pendingLogin.options)
      })).status, 401);

      const inflight = await (await call('/api/auth/login/options', 'POST', { Origin: secondaryHeaders.Origin }, {})).json();
      const originalVerify = crypto.webcrypto.subtle.verify;
      const duringVerification = deletionContext.mock.method(crypto.webcrypto.subtle, 'verify', async function (...parameters) {
        await store.deleteCredential(account.id, secondaryKey.credential.id);
        return originalVerify.apply(this, parameters);
      });
      try {
        const removedDuringVerification = await call('/api/auth/login/verify', 'POST', { Origin: secondaryHeaders.Origin }, {
          requestId: inflight.requestId,
          response: secondaryKey.login(inflight.options, secondaryHeaders.Origin, process.env.PASSKEY_RP_ID_SECONDARY)
        });
        assert.equal(duringVerification.mock.callCount(), 1);
        assert.equal(removedDuringVerification.status, 401);
        assert.equal(removedDuringVerification.headers.get('set-cookie'), null);
      } finally {
        duringVerification.mock.restore();
      }

      const finalKey = await call(`/api/auth/passkeys/${first.credential.id}`, 'DELETE', headers);
      assert.equal(finalKey.status, 409);
      assert.match((await finalKey.json()).error, /at least one passkey/);
      const remaining = await (await call('/api/auth/passkeys', 'GET', headers)).json();
      assert.deepEqual(remaining.passkeys, [listing.passkeys.find(({ id }) => id === first.credential.id)]);
      assert.equal(remaining.user.credentialCount, 1);
      const remainingLogin = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      const stillWorks = await call('/api/auth/login/verify', 'POST', { Origin: origin }, {
        requestId: remainingLogin.requestId, response: first.login(remainingLogin.options)
      });
      assert.equal(stillWorks.status, 200);
      assert.equal((await stillWorks.json()).user.id, account.id);
      assert.equal((await store.getSessionUser(session.token)).credentialCount, 1);
      assert.equal((await store.getUser(admin.id)).credentialCount, 1);
    });

    const expired = await start();
    const now = Date.now();
    const clock = passkeyContext.mock.method(Date, 'now', () => now + 6 * 60 * 1000);
    try {
      assert.equal((await verify(expired, authenticator().register(expired.options))).status, 400);
    } finally {
      clock.mock.restore();
    }
    const revoked = await start();
    await store.updateUser(account.id, { status: 'revoked' }, admin.id);
    assert.equal((await verify(revoked, authenticator().register(revoked.options))).status, 401);
    assert.equal((await call('/api/auth/passkeys', 'GET', headers)).status, 401);
    assert.equal((await call(`/api/auth/passkeys/${first.credential.id}`, 'DELETE', headers)).status, 401);
    assert.equal((await store.getUser(account.id)).credentialCount, 1);
    const lastUsedBeforeDenied = (await store.findCredential(first.credential.id)).credential.lastUsedAt;
    for (const status of ['pending', 'revoked']) {
      await store.updateUser(account.id, { status }, admin.id);
      const deniedLogin = await (await call('/api/auth/login/options', 'POST', { Origin: origin }, {})).json();
      assert.equal((await call('/api/auth/login/verify', 'POST', { Origin: origin }, {
        requestId: deniedLogin.requestId, response: first.login(deniedLogin.options)
      })).status, 403);
      assert.equal((await store.findCredential(first.credential.id)).credential.lastUsedAt, lastUsedBeforeDenied);
    }
  });

  await context.test('browser app handoff verifies passkeys and binds single-use codes to PKCE', async () => {
    const envKeys = ['PASSKEY_RP_ID', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID_SECONDARY', 'PASSKEY_ORIGIN_SECONDARY'];
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      process.env.PASSKEY_RP_ID = 'music.example.com';
      process.env.PASSKEY_ORIGIN = 'https://music.example.com';
      process.env.PASSKEY_RP_ID_SECONDARY = '192-168-6-66.sslip.io';
      process.env.PASSKEY_ORIGIN_SECONDARY = 'https://192-168-6-66.sslip.io:4123';
      assert.equal((await call('/.well-known/assetlinks.json')).status, 404);
      assert.equal((await call('/api/auth/login/options', 'POST', {}, { client: 'android' })).status, 400);
      assert.equal((await call('/api/auth/login/options', 'POST', {}, { client: 'unknown' })).status, 400);
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const appRequest = { client: 'browser-app', redirectUri: 'com.ssytdlp.app:/oauth/callback',
        state: crypto.randomBytes(32).toString('base64url'), codeChallengeMethod: 'S256',
        codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url') };
      for (const changes of [{ redirectUri: 'https://evil.example/callback' }, { redirectUri: 'javascript:alert(1)' },
        { redirectUri: `${appRequest.redirectUri}?extra=1` }, { codeChallengeMethod: 'plain' },
        { codeChallenge: 'short' }, { state: 'short' }, { state: ['invalid'] }]) {
        assert.equal((await call('/api/auth/login/options', 'POST', userHeaders, { ...appRequest, ...changes })).status, 400);
      }

      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      const credentialId = crypto.randomBytes(32).toString('base64url');
      const keyBytes = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      assert.equal((await call('/api/auth/register/options', 'POST', {}, { name: 'Newcomer', client: 'browser-app' })).status, 400);
      const register = async (name, rpID, origin) => {
        const optionsResponse = await call('/api/auth/register/options', 'POST', { Origin: origin }, { name });
        assert.equal(optionsResponse.status, 200);
        const registration = await optionsResponse.json();
        assert.equal(registration.options.rp.id, rpID);
        const registeredId = crypto.randomBytes(32);
        const idLength = Buffer.alloc(2);
        idLength.writeUInt16BE(registeredId.length);
        const registrationAuthData = Buffer.concat([
          crypto.createHash('sha256').update(rpID).digest(), Buffer.from([69, 0, 0, 0, 0]),
          Buffer.alloc(16), idLength, registeredId, keyBytes
        ]);
        const attestation = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', registrationAuthData]]));
        const registered = await call('/api/auth/register/verify', 'POST', { Origin: origin }, {
          requestId: registration.requestId,
          response: { id: registeredId.toString('base64url'), rawId: registeredId.toString('base64url'), type: 'public-key',
            clientExtensionResults: {}, response: {
              clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: registration.options.challenge, origin })).toString('base64url'),
              attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal']
            } }
        });
        assert.equal(registered.status, 201);
        assert.equal(registered.headers.get('set-cookie'), null);
        const newAccount = await registered.json();
        assert.equal(newAccount.user.status, 'pending');
        assert.equal(newAccount.session, undefined);
        return { user: newAccount.user, credentialId: registeredId.toString('base64url') };
      };
      await register('Newcomer', process.env.PASSKEY_RP_ID, process.env.PASSKEY_ORIGIN);
      const localAccount = await register('Local Newcomer', process.env.PASSKEY_RP_ID_SECONDARY, process.env.PASSKEY_ORIGIN_SECONDARY);
      await store.updateUser(localAccount.user.id, { status: 'approved' }, admin.id);
      const account = await store.registerUser('Mobile Listener', 'mobile-listener', { id: credentialId, publicKey: keyBytes, counter: 0 });
      await store.updateUser(account.id, { status: 'approved' }, admin.id);
      const start = async (appLogin = false) => {
        const result = await call('/api/auth/login/options', 'POST', {}, appLogin ? appRequest : {});
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('cache-control'), 'no-store');
        const payload = await result.json();
        assert.equal(payload.options.rpId, 'music.example.com');
        assert.equal(payload.options.userVerification, 'required');
        return payload;
      };
      const assertion = (options, origin, rpID = 'music.example.com', flags = 5, id = credentialId) => {
        const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
        const authenticatorData = Buffer.concat([crypto.createHash('sha256').update(rpID).digest(), Buffer.from([flags, 0, 0, 0, 0])]);
        const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientData).digest()]), privateKey);
        return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
          response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url') } };
      };
      const origin = process.env.PASSKEY_ORIGIN;
      const login = await start(true);
      const verifyBody = { requestId: login.requestId, response: assertion(login.options, origin), client: 'web', redirectUri: 'https://evil.example/' };
      const verified = await call('/api/auth/login/verify', 'POST', {}, verifyBody);
      assert.equal(verified.status, 200);
      assert.equal(verified.headers.get('set-cookie'), null);
      assert.equal(verified.headers.get('cache-control'), 'no-store');
      const handoff = await verified.json();
      assert.deepEqual(Object.keys(handoff), ['redirectUrl']);
      const redirect = new URL(handoff.redirectUrl);
      assert.equal(`${redirect.protocol}${redirect.pathname}`, appRequest.redirectUri);
      assert.equal(redirect.searchParams.get('state'), appRequest.state);
      assert.deepEqual([...redirect.searchParams.keys()], ['code', 'state']);
      const exchangeBody = { code: redirect.searchParams.get('code'), codeVerifier, redirectUri: appRequest.redirectUri };
      const exchanged = await call('/api/auth/app/token', 'POST', {}, exchangeBody);
      assert.equal(exchanged.status, 200);
      assert.equal(exchanged.headers.get('cache-control'), 'no-store');
      assert.equal(exchanged.headers.get('set-cookie'), null);
      const result = await exchanged.json();
      assert.equal(result.user.id, account.id);
      assert.equal(result.user.credentials, undefined);
      assert.equal(result.session.tokenType, 'Bearer');
      assert.ok(Date.parse(result.session.expiresAt) > Date.now());
      const headers = { Authorization: `Bearer ${result.session.token}` };
      assert.equal((await call('/protected', 'POST', headers)).status, 200);
      assert.equal((await call('/api/auth/app/token', 'POST', {}, exchangeBody)).status, 400);
      assert.equal((await call('/api/auth/login/verify', 'POST', {}, verifyBody)).status, 400);

      const browserLogin = await start();
      const browserVerified = await call('/api/auth/login/verify', 'POST', {}, {
        ...appRequest, requestId: browserLogin.requestId, response: assertion(browserLogin.options, origin)
      });
      assert.equal(browserVerified.status, 200);
      assert.match(browserVerified.headers.get('set-cookie'), /ssytdlp_session=.*HttpOnly/);
      const browserResult = await browserVerified.json();
      assert.equal(browserResult.session, undefined);
      assert.equal(browserResult.redirectUrl, undefined);

      const localOrigin = process.env.PASSKEY_ORIGIN_SECONDARY;
      const localRPID = process.env.PASSKEY_RP_ID_SECONDARY;
      for (const [assertedOrigin, assertedRPID, expectedStatus] of [
        [localOrigin, localRPID, 200],
        [origin, localRPID, 400],
        ['https://192-168-6-66.sslip.io:4124', localRPID, 400],
        [localOrigin, process.env.PASSKEY_RP_ID, 400]
      ]) {
        const optionsResponse = await call('/api/auth/login/options', 'POST', { Origin: localOrigin }, {});
        assert.equal(optionsResponse.status, 200);
        const attempt = await optionsResponse.json();
        assert.equal(attempt.options.rpId, localRPID);
        const verifiedAttempt = await call('/api/auth/login/verify', 'POST', { Origin: assertedOrigin }, {
          requestId: attempt.requestId,
          response: assertion(attempt.options, assertedOrigin, assertedRPID, 5, localAccount.credentialId)
        });
        assert.equal(verifiedAttempt.status, expectedStatus);
        if (expectedStatus === 200) {
          assert.equal((await verifiedAttempt.json()).user.id, localAccount.user.id);
          assert.match(verifiedAttempt.headers.get('set-cookie'), /ssytdlp_session=.*HttpOnly; Secure/);
        } else {
          assert.equal(verifiedAttempt.headers.get('set-cookie'), null);
        }
      }

      for (const [badOrigin, rpID, flags] of [
        ['android:apk-key-hash:untrusted'], ['https://evil.example'],
        [localOrigin, localRPID],
        [origin, 'wrong.example.com'], [origin, undefined, 1]
      ]) {
        const attempt = await start(true);
        const rejected = await call('/api/auth/login/verify', 'POST', {}, {
          requestId: attempt.requestId, response: assertion(attempt.options, badOrigin, rpID, flags)
        });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.headers.get('set-cookie'), null);
        assert.equal((await rejected.json()).session, undefined);
      }
      const getCode = async () => {
        const attempt = await start(true);
        const verifiedAttempt = await call('/api/auth/login/verify', 'POST', {}, {
          requestId: attempt.requestId, response: assertion(attempt.options, origin)
        });
        assert.equal(verifiedAttempt.status, 200);
        return new URL((await verifiedAttempt.json()).redirectUrl).searchParams.get('code');
      };
      for (const changes of [{ codeVerifier: crypto.randomBytes(32).toString('base64url') },
        { codeVerifier: 'short' }, { codeVerifier: undefined }, { redirectUri: 'https://evil.example' }]) {
        const code = await getCode();
        assert.equal((await call('/api/auth/app/token', 'POST', userHeaders, { ...exchangeBody, code, ...changes })).status, 400);
        assert.equal((await call('/api/auth/app/token', 'POST', {}, { ...exchangeBody, code })).status, 400);
      }
      const expiredCode = await getCode();
      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + 61_000;
        assert.equal((await call('/api/auth/app/token', 'POST', {}, { ...exchangeBody, code: expiredCode })).status, 400);
      } finally { Date.now = originalNow; }
      const revokedCode = await getCode();
      await store.updateUser(account.id, { status: 'revoked' }, admin.id);
      assert.equal((await call('/api/auth/app/token', 'POST', {}, { ...exchangeBody, code: revokedCode })).status, 403);
      for (const [status, code] of [['pending', 'ACCESS_PENDING'], ['revoked', 'ACCESS_REVOKED']]) {
        await store.updateUser(account.id, { status }, admin.id);
        assert.equal((await call('/protected', 'POST', headers)).status, 401);
        const attempt = await start(true);
        const rejected = await call('/api/auth/login/verify', 'POST', {}, {
          requestId: attempt.requestId, response: assertion(attempt.options, origin)
        });
        assert.equal(rejected.status, 403);
        assert.equal((await rejected.json()).code, code);
      }
    } finally {
      for (const key of envKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    }
  });
});