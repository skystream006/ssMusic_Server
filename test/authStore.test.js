import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabases, openDatabase } from '../src/database.js';
import { createTestDatabase } from '../test-support/postgres.js';

async function loadStore(testContext) {
  await createTestDatabase(testContext);
  return import(`../src/authStore.js?test=${crypto.randomUUID()}`);
}

const credential = (id) => ({ id, publicKey: Buffer.from(`key-${id}`), counter: 0 });

test('renaming preserves account identity and enforces normalized unique names', async (context) => {
  const store = await loadStore(context);
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const user = await store.registerUser('Listener', 'listener', credential('listener'));
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const session = await store.createSession(user.id);
  const renamed = await store.updateUser(user.id, { name: '  New   Listener  ' }, user.id);
  assert.equal(renamed.name, 'New Listener');
  assert.equal(renamed.id, user.id);
  assert.equal((await store.getSessionUser(session.token)).name, 'New Listener');
  assert.equal((await store.findCredential('listener')).user.userHandle, 'listener');
  await assert.rejects(store.updateUser(user.id, { name: 'ADMIN' }, admin.id), { statusCode: 409 });
  for (const name of ['', 'x', 'x'.repeat(65), null, 123]) {
    await assert.rejects(store.updateUser(user.id, { name }, user.id), { statusCode: 400 });
  }
  await store.updateUser(user.id, { name: 'NEW LISTENER' }, admin.id);
  assert.equal((await store.getUser(user.id)).name, 'NEW LISTENER');
});

test('Shared roles persist multiple grants and reject invalid library owners', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const owner = await store.registerUser('Owner', 'owner', credential('owner'));
  const viewer = await store.registerUser('Viewer', 'viewer', credential('viewer'));
  await store.updateUser(owner.id, { status: 'approved' }, admin.id);
  const updated = await store.updateUser(viewer.id, { status: 'approved', role: 'shared', sharedUserIds: [admin.id, owner.id] }, admin.id);
  assert.equal(updated.role, 'shared');
  assert.deepEqual(new Set(updated.sharedUserIds), new Set([admin.id, owner.id]));
  const session = await store.createSession(viewer.id);
  assert.deepEqual(new Set((await store.getSessionUser(session.token)).sharedUserIds), new Set([admin.id, owner.id]));
  for (const ids of [[viewer.id], ['missing'], 'invalid', [null]]) {
    await assert.rejects(store.updateUser(viewer.id, { sharedUserIds: ids }, admin.id), { statusCode: 400 });
  }
  await store.updateUser(owner.id, { role: 'shared' }, admin.id);
  assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, [admin.id]);
  await assert.rejects(store.updateUser(viewer.id, { sharedUserIds: [owner.id] }, admin.id), { statusCode: 400 });
  await store.updateUser(viewer.id, { role: 'user' }, admin.id);
  assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, []);
});

test('Shared registration persists its organizer without granting library access', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const viewer = await store.registerUser('Car player', 'car', credential('car'), {
    role: 'shared', organizerId: admin.id
  });
  assert.equal(viewer.role, 'shared');
  assert.equal(viewer.status, 'pending');
  assert.equal(viewer.organizerId, admin.id);
  assert.deepEqual(viewer.sharedUserIds, []);
  assert.equal((await store.getUser(viewer.id)).organizerId, admin.id);
  for (const organizerId of [undefined, 'missing', viewer.id]) {
    await assert.rejects(store.registerUser('Invalid viewer', 'invalid', credential('invalid'), {
      role: 'shared', organizerId
    }), { statusCode: 400 });
  }
});

test('user links require recipient acceptance, are mutual, and survive reloads', async (context) => {
  const store = await loadStore(context);
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const owner = await store.registerUser('Owner', 'owner', credential('owner'));
  const other = await store.registerUser('Other', 'other', credential('other'));
  await assert.rejects(store.requestUserLink(admin.id, owner.id), { statusCode: 403 });
  await store.updateUser(owner.id, { status: 'approved' }, admin.id);
  await store.updateUser(other.id, { status: 'approved' }, admin.id);
  await assert.rejects(store.requestUserLink(admin.id, admin.id), { statusCode: 400 });
  await store.requestUserLink(admin.id, owner.id);
  assert.deepEqual(await store.listUserLinks(admin.id), [{ id: owner.id, name: owner.name, status: 'outgoing' }]);
  assert.deepEqual(await store.listUserLinks(owner.id), [{ id: admin.id, name: admin.name, status: 'incoming' }]);
  assert.deepEqual(await store.listOrganizerLibraries(admin.id), [{ id: admin.id, name: admin.name }]);
  await assert.rejects(store.requestUserLink(owner.id, admin.id), { statusCode: 409 });
  await assert.rejects(store.acceptUserLink(admin.id, owner.id), { statusCode: 404 });
  await assert.rejects(store.acceptUserLink(other.id, admin.id), { statusCode: 404 });
  await store.acceptUserLink(owner.id, admin.id);
  assert.equal((await store.listUserLinks(admin.id))[0].status, 'linked');
  assert.equal((await store.listUserLinks(owner.id))[0].status, 'linked');
  await closeDatabases();
  const reloaded = await import(`../src/authStore.js?links=${crypto.randomUUID()}`);
  assert.equal((await reloaded.listUserLinks(owner.id))[0].status, 'linked');
  assert.equal(await reloaded.removeUserLink(other.id, owner.id), false);
  assert.equal(await reloaded.removeUserLink(owner.id, admin.id), true);
  assert.deepEqual(await reloaded.listUserLinks(admin.id), []);
});

test('organizers manage only assigned Shared users and accepted linked libraries', async (context) => {
  const store = await loadStore(context);
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const owner = await store.registerUser('Owner', 'owner', credential('owner'));
  const other = await store.registerUser('Other', 'other', credential('other'));
  for (const user of [owner, other]) await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const viewer = await store.registerUser('Car player', 'car', credential('car'), { role: 'shared', organizerId: owner.id });
  assert.equal((await store.listOrganizedUsers(owner.id))[0].id, viewer.id);
  assert.deepEqual(await store.listOrganizedUsers(admin.id), []);
  await assert.rejects(store.updateOrganizedUser(admin.id, viewer.id, [admin.id]), { statusCode: 404 });
  await assert.rejects(store.updateOrganizedUser(owner.id, other.id, [owner.id]), { statusCode: 404 });
  await assert.rejects(store.updateOrganizedUser(owner.id, viewer.id, [other.id]), { statusCode: 403 });
  await assert.rejects(store.updateOrganizedUser(owner.id, viewer.id, null), { statusCode: 400 });
  await store.requestUserLink(owner.id, other.id);
  await assert.rejects(store.updateOrganizedUser(owner.id, viewer.id, [other.id]), { statusCode: 403 });
  await store.acceptUserLink(other.id, owner.id);
  const updated = await store.updateOrganizedUser(owner.id, viewer.id, [owner.id, other.id, other.id]);
  assert.deepEqual(new Set(updated.sharedUserIds), new Set([owner.id, other.id]));
  assert.equal(updated.status, 'pending');
  await store.updateUser(viewer.id, { status: 'approved' }, admin.id);
  await assert.rejects(store.requestUserLink(viewer.id, other.id), { statusCode: 403 });
  await assert.rejects(store.requestUserLink(owner.id, viewer.id), { statusCode: 403 });
  await store.removeUserLink(other.id, owner.id);
  assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, [owner.id]);
  await store.requestUserLink(owner.id, other.id);
  await store.acceptUserLink(other.id, owner.id);
  assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, [owner.id]);
  await store.updateOrganizedUser(owner.id, viewer.id, [other.id]);
  await store.updateUser(other.id, { status: 'revoked' }, admin.id);
  assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, []);
  assert.deepEqual(await store.listUserLinks(owner.id), []);
  await store.updateOrganizedUser(owner.id, viewer.id, [owner.id]);
  await store.updateUser(owner.id, { status: 'revoked' }, admin.id);
  assert.equal((await store.getUser(viewer.id)).organizerId, null);
  assert.deepEqual((await store.getUser(viewer.id)).sharedUserIds, []);
  await store.updateUser(viewer.id, { organizerId: admin.id, sharedUserIds: [admin.id] }, admin.id);
  assert.equal((await store.getUser(viewer.id)).organizerId, admin.id);
});

test('deleting an organizer clears delegated grants without deleting Shared users', async (context) => {
  const store = await loadStore(context);
  const admin = await store.registerUser('Admin', 'admin', credential('admin'));
  const owner = await store.registerUser('Owner', 'owner', credential('owner'));
  await store.updateUser(owner.id, { status: 'approved' }, admin.id);
  await store.requestUserLink(owner.id, admin.id);
  await store.acceptUserLink(admin.id, owner.id);
  const viewer = await store.registerUser('Car player', 'car', credential('car'), { role: 'shared', organizerId: owner.id });
  await store.updateOrganizedUser(owner.id, viewer.id, [admin.id]);
  await store.deleteUser(owner.id, admin.id);
  const remaining = await store.getUser(viewer.id);
  assert.equal(remaining.organizerId, null);
  assert.deepEqual(remaining.sharedUserIds, []);
  assert.deepEqual(await store.listUserLinks(admin.id), []);
});

test('duplicate credentials and names are rejected and credential updates persist', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Alice', 'alice-handle', credential('alice-key'));
  await assert.rejects(store.registerUser('alice', 'other-handle', credential('other-key')), /name is already registered/);
  await assert.rejects(store.registerUser('Other', 'other-handle', credential('alice-key')), /passkey is already registered/);
  assert.equal(await store.updateCredentialCounter(admin.id, 'alice-key', 42), true);
  assert.equal(await store.updateCredentialCounter('missing', 'alice-key', 99), false);
  const session = await store.createSession(admin.id);
  await store.deleteSession(session.token);
  (await closeDatabases());
  const reloaded = await import(`../src/authStore.js?counter=${crypto.randomUUID()}`);
  assert.equal((await reloaded.findCredential('alice-key')).credential.counter, 42);
  assert.equal((await reloaded.getSessionUser(session.token)), null);
  assert.equal((await reloaded.listUsers()).length, 1);
});

test('additional passkeys preserve the account and all credentials across reloads', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  await assert.rejects(store.addCredential(user.id, credential('pending-key')), /Approved user required/);
  await assert.rejects(store.addCredential('missing', credential('missing-key')), /Approved user required/);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  await store.updateCredentialCounter(user.id, 'listener-key', 42);
  const session = await store.createSession(user.id);
  const added = await store.addCredential(user.id, { ...credential('backup-key'), transports: ['usb'] });

  assert.equal(added.id, user.id);
  assert.equal(added.name, user.name);
  assert.equal(added.role, 'user');
  assert.equal(added.status, 'approved');
  assert.equal(added.credentialCount, 2);
  assert.equal(added.credentials, undefined);
  assert.equal(added.userHandle, undefined);
  assert.equal((await store.getSessionUser(session.token)).credentialCount, 2);
  const passkeys = (await store.getUserPasskeys(user.id));
  assert.equal(passkeys.userHandle, 'listener-handle');
  assert.deepEqual(passkeys.credentials.map(({ id, transports }) => ({ id, transports })),
    [{ id: 'listener-key', transports: [] }, { id: 'backup-key', transports: ['usb'] }]);
  assert.equal((await store.getUserPasskeys('missing')), null);
  await assert.rejects(store.addCredential(user.id, credential('backup-key')), /passkey is already registered/);
  await assert.rejects(store.addCredential(admin.id, credential('backup-key')), /passkey is already registered/);
  await assert.rejects(store.addCredential(user.id, credential('admin-key')), /passkey is already registered/);
  assert.equal((await store.listUsers()).length, 2);

  (await closeDatabases());
  const reloaded = await import(`../src/authStore.js?passkeys=${crypto.randomUUID()}`);
  for (const id of ['listener-key', 'backup-key']) {
    const match = (await reloaded.findCredential(id));
    assert.equal(match.user.id, user.id);
    assert.equal(match.user.userHandle, 'listener-handle');
    assert.deepEqual(match.credential.publicKey, credential(id).publicKey);
  }
  assert.equal((await reloaded.findCredential('listener-key')).credential.counter, 42);
  assert.deepEqual((await reloaded.findCredential('backup-key')).credential.transports, ['usb']);
  assert.equal((await reloaded.getSessionUser(session.token)).credentialCount, 2);
  await reloaded.updateUser(user.id, { status: 'revoked' }, admin.id);
  await assert.rejects(reloaded.addCredential(user.id, credential('revoked-key')), /Approved user required/);
  assert.equal((await reloaded.getUser(user.id)).credentialCount, 2);
});

test('passkey deletion is account-scoped, preserves the final key, and persists', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  await assert.rejects(store.deleteCredential(user.id, 'listener-key'), /Approved user required/);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  await store.addCredential(user.id, { ...credential('backup-key'), transports: ['usb'] });
  await store.updateCredentialCounter(user.id, 'backup-key', 42);
  const session = await store.createSession(user.id);

  assert.equal(await store.deleteCredential(admin.id, 'listener-key'), null);
  assert.equal(await store.deleteCredential(user.id, 'admin-key'), null);
  assert.equal(await store.deleteCredential(user.id, 'missing'), null);
  assert.equal(await store.deleteCredential('missing', 'listener-key'), null);
  const updated = await store.deleteCredential(user.id, 'listener-key');
  assert.equal(updated.id, user.id);
  assert.equal(updated.role, 'user');
  assert.equal(updated.status, 'approved');
  assert.equal(updated.credentialCount, 1);
  assert.equal(updated.credentials, undefined);
  assert.equal((await store.findCredential('listener-key')), null);
  assert.equal((await store.getSessionUser(session.token)).credentialCount, 1);
  assert.deepEqual((await store.getUserPasskeys(user.id)).credentials.map(({ id, transports }) => ({ id, transports })),
    [{ id: 'backup-key', transports: ['usb'] }]);
  await assert.rejects(store.deleteCredential(user.id, 'backup-key'), { statusCode: 409 });
  await assert.rejects(store.deleteCredential(admin.id, 'admin-key'), /at least one passkey/);
  assert.equal(await store.deleteCredential(user.id, 'listener-key'), null);
  assert.equal(await store.updateCredentialCounter(user.id, 'listener-key', 99), false);

  await store.addCredential(user.id, credential('third-key'));
  const deletions = await Promise.allSettled([
    store.deleteCredential(user.id, 'third-key'), store.deleteCredential(user.id, 'backup-key')
  ]);
  assert.deepEqual(deletions.map(({ status }) => status), ['fulfilled', 'rejected']);
  assert.equal(deletions[1].reason.statusCode, 409);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  (await closeDatabases());
  const reloaded = await import(`../src/authStore.js?deleted=${crypto.randomUUID()}`);
  assert.equal((await reloaded.findCredential('listener-key')), null);
  assert.equal((await reloaded.findCredential('third-key')), null);
  assert.equal((await reloaded.findCredential('backup-key')).credential.counter, 42);
  assert.equal((await reloaded.getSessionUser(session.token)).credentialCount, 1);
  assert.equal((await reloaded.getUser(admin.id)).credentialCount, 1);
  assert.equal((await reloaded.listUsers()).length, 2);
});

test('passkey dates track enrollment and approved use independently across reloads', async (testContext) => {
  const store = await loadStore(testContext);
  const createdAt = '2026-09-27T12:00:00.000Z';
  testContext.mock.timers.enable({ apis: ['Date'], now: new Date(createdAt) });
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  const initial = { id: 'listener-key', transports: [], createdAt, lastUsedAt: null };
  assert.deepEqual((await store.getUserPasskeys(user.id)).credentials, [initial]);
  await store.updateCredentialCounter(user.id, 'listener-key', 1);
  assert.equal((await store.findCredential('listener-key')).credential.lastUsedAt, null);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);

  testContext.mock.timers.tick(60_000);
  const added = await store.addCredential(user.id, credential('backup-key'));
  assert.deepEqual((await store.getUserPasskeys(user.id)).credentials, [initial,
    { id: 'backup-key', transports: [], createdAt: '2026-09-27T12:01:00.000Z', lastUsedAt: null }]);
  assert.equal(added.updatedAt, '2026-09-27T12:01:00.000Z');
  testContext.mock.timers.tick(60_000);
  assert.equal(await store.updateCredentialCounter(user.id, 'listener-key', 2), true);
  assert.equal((await store.findCredential('listener-key')).credential.lastUsedAt, '2026-09-27T12:02:00.000Z');
  assert.equal((await store.findCredential('backup-key')).credential.lastUsedAt, null);
  assert.equal((await store.findCredential('admin-key')).credential.lastUsedAt, null);
  testContext.mock.timers.tick(60_000);
  await store.updateCredentialCounter(user.id, 'listener-key', 3);
  const expected = { ...initial, lastUsedAt: '2026-09-27T12:03:00.000Z' };
  assert.deepEqual((await store.getUserPasskeys(user.id)).credentials[0], expected);
  assert.equal(await store.updateCredentialCounter(admin.id, 'listener-key', 99), false);
  await store.updateUser(user.id, { status: 'revoked' }, admin.id);
  testContext.mock.timers.tick(60_000);
  await store.updateCredentialCounter(user.id, 'listener-key', 4);
  assert.deepEqual((await store.getUserPasskeys(user.id)).credentials[0], expected);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  await store.deleteCredential(user.id, 'backup-key');
  (await closeDatabases());

  const reloaded = await import(`../src/authStore.js?dates=${crypto.randomUUID()}`);
  assert.deepEqual((await reloaded.getUserPasskeys(user.id)).credentials, [expected]);
  assert.equal((await reloaded.findCredential('listener-key')).credential.counter, 4);
});

test('first registered user is an approved admin and later users are pending', async (testContext) => {
  const store = await loadStore(testContext);
  const first = await store.registerUser('Alice', 'alice-handle', credential('alice-key'));
  const second = await store.registerUser('Bob', 'bob-handle', credential('bob-key'));

  assert.equal(first.role, 'admin');
  assert.equal(first.status, 'approved');
  assert.equal(second.role, 'user');
  assert.equal(second.status, 'pending');
});

test('admins can approve users and revoked users lose their sessions', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const session = await store.createSession(user.id);

  assert.equal((await store.getSessionUser(session.token))?.id, user.id);
  await store.updateUser(user.id, { status: 'revoked' }, admin.id);
  assert.equal((await store.getSessionUser(session.token)), null);
});

test('the last approved admin cannot be demoted or revoked', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));

  await assert.rejects(
    store.updateUser(admin.id, { role: 'user' }, admin.id),
    /At least one approved admin is required/
  );
});

test('approved user sessions survive an authentication store reload', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const session = await store.createSession(admin.id);
  (await closeDatabases());
  const reloadedStore = await import(`../src/authStore.js?reload=${crypto.randomUUID()}`);

  assert.equal((await reloadedStore.getSessionUser(session.token))?.id, admin.id);
  assert.equal((await reloadedStore.getSessionUser('not-a-session')), null);
});

test('named PATs coexist, hide secrets in listings and enforce ownership on deletion', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const first = await store.createPrivateAccessToken(admin.id, ' Laptop ');
  const second = await store.createPrivateAccessToken(admin.id, 'Automation');
  assert.equal(first.name, 'Laptop');
  assert.equal((await store.getPrivateAccessTokenUser(first.token))?.id, admin.id);
  assert.equal((await store.getPrivateAccessTokenUser(second.token))?.id, admin.id);
  const stored = (await openDatabase().prepare('SELECT * FROM private_access_tokens WHERE id = $1').get(second.id));
  assert.equal(JSON.stringify(stored).includes(second.token), false);
  assert.equal(typeof stored.token_hash, 'string');
  assert.equal((await store.listPrivateAccessTokens(admin.id)).length, 2);
  for (const token of (await store.listPrivateAccessTokens(admin.id))) {
    assert.deepEqual(Object.keys(token).sort(), ['createdAt', 'id', 'name']);
  }
  assert.equal(await store.deletePrivateAccessToken('other-user', first.id), false);
  assert.equal(await store.deletePrivateAccessToken(admin.id, first.id), true);
  assert.equal((await store.getPrivateAccessTokenUser(first.token)), null);
  assert.equal((await store.getPrivateAccessTokenUser(second.token))?.id, admin.id);
  (await closeDatabases());
  const reloaded = await import(`../src/authStore.js?reload=${crypto.randomUUID()}`);
  assert.equal((await reloaded.getPrivateAccessTokenUser(second.token))?.id, admin.id);
  assert.equal((await reloaded.getPrivateAccessTokenUser('not-a-token')), null);
});

test('PAT names and approval are required and revocation survives reapproval', async (testContext) => {
  const store = await loadStore(testContext);
  const admin = await store.registerUser('Admin', 'admin-handle', credential('admin-key'));
  const user = await store.registerUser('Listener', 'listener-handle', credential('listener-key'));
  await assert.rejects(store.createPrivateAccessToken(user.id, 'Pending'), /Approved user required/);
  for (const name of ['', ' ', 'a'.repeat(65), {}, undefined]) {
    await assert.rejects(store.createPrivateAccessToken(admin.id, name), /PAT name/);
  }
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  const pat = await store.createPrivateAccessToken(user.id, 'Automation');

  await store.updateUser(user.id, { status: 'revoked' }, admin.id);
  assert.equal((await store.getPrivateAccessTokenUser(pat.token)), null);
  await store.updateUser(user.id, { status: 'approved' }, admin.id);
  assert.equal((await store.getPrivateAccessTokenUser(pat.token)), null);
  assert.deepEqual((await store.listPrivateAccessTokens(user.id)), []);
});
