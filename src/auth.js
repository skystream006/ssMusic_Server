import 'express-async-errors';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import {
  acceptUserLink,
  addCredential,
  createPrivateAccessToken,
  createSession,
  deleteCredential,
  deletePrivateAccessToken,
  deleteSession,
  deleteUser,
  findCredential,
  getPrivateAccessTokenUser,
  getSessionUser,
  getUser,
  getUserPasskeys,
  listAvailableUsers,
  listOrganizedUsers,
  listOrganizerLibraries,
  listPrivateAccessTokens,
  listUserLinks,
  listUsers,
  registerUser,
  removeUserLink,
  requestUserLink,
  updateCredentialCounter,
  updateOrganizedUser,
  updateUser,
  validateRegistrationAccount
} from './authStore.js';

const challenges = new Map();
const challengeLifetimeMs = 5 * 60 * 1000;
const maxChallenges = 5_000;
const maxChallengesPerClient = 10;
const sessionCookie = 'ssmusic_session';
const legacySessionCookie = 'ssytdlp_session';
const appRedirectUris = new Set(['com.ssmusic.app:/oauth/callback', 'com.ssytdlp.app:/oauth/callback']);

function getAppAuthorization(body) {
  if (body?.client !== 'browser-app') return undefined;
  if (!appRedirectUris.has(body.redirectUri) || body.codeChallengeMethod !== 'S256'
    || typeof body.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge)
    || Buffer.from(body.codeChallenge, 'base64url').toString('base64url') !== body.codeChallenge
    || typeof body.state !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(body.state)) {
    throw Object.assign(new Error('Invalid app callback, state, or S256 PKCE challenge'), { statusCode: 400 });
  }
  return { redirectUri: body.redirectUri, codeChallenge: body.codeChallenge, state: body.state };
}

function getWebAuthnConfig(req) {
  const client = req.body?.client ?? 'web';
  if (!['web', 'browser-app'].includes(client)) {
    throw Object.assign(new Error('Use web passkey login or the browser-app flow'), { statusCode: 400 });
  }
  const primary = {
    rpID: process.env.PASSKEY_RP_ID || req.hostname,
    origin: process.env.PASSKEY_ORIGIN || `${req.protocol}://${req.get('host')}`
  };
  const secondary = {
    rpID: process.env.PASSKEY_RP_ID_SECONDARY,
    origin: process.env.PASSKEY_ORIGIN_SECONDARY
  };
  if (Boolean(secondary.rpID) !== Boolean(secondary.origin)) {
    throw Object.assign(new Error('Set both PASSKEY_RP_ID_SECONDARY and PASSKEY_ORIGIN_SECONDARY'), { statusCode: 500 });
  }
  const requestOrigin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
  const { rpID, origin } = secondary.origin && requestOrigin === secondary.origin ? secondary : primary;
  if (net.isIP(rpID)) {
    const error = new Error('Passkey RP ID must be a hostname, not an IP address');
    error.statusCode = 500;
    throw error;
  }
  return { rpID, origin };
}

function pruneChallenges() {
  const now = Date.now();
  for (const [requestId, challenge] of challenges) {
    if (challenge.expiresAt < now) challenges.delete(requestId);
  }
}

function rememberChallenge(data, clientId, lifetimeMs = challengeLifetimeMs) {
  pruneChallenges();
  const clientChallenges = [...challenges.values()].filter((challenge) => challenge.clientId === clientId).length;
  if (challenges.size >= maxChallenges || clientChallenges >= maxChallengesPerClient) {
    const error = new Error('Too many passkey requests. Please wait before trying again.');
    error.statusCode = 429;
    throw error;
  }
  const requestId = crypto.randomBytes(32).toString('base64url');
  challenges.set(requestId, { ...data, clientId, expiresAt: Date.now() + lifetimeMs });
  return requestId;
}

function takeChallenge(requestId, type) {
  pruneChallenges();
  const challenge = challenges.get(requestId);
  challenges.delete(requestId);
  if (!challenge || challenge.type !== type || challenge.expiresAt < Date.now()) {
    const error = new Error('The passkey request expired. Please try again.');
    error.statusCode = 400;
    throw error;
  }
  return challenge;
}

function getCookie(req, name) {
  const prefix = `${name}=`;
  const pair = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return pair ? decodeURIComponent(pair.slice(prefix.length)) : null;
}

function sessionCookieOptions(req, expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || process.env.PASSKEY_ORIGIN?.startsWith('https://'),
    expires: new Date(expiresAt),
    path: '/'
  };
}

function getSessionToken(req) {
  if (req.headers.authorization !== undefined) {
    return /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization)?.[1] || null;
  }
  return getCookie(req, sessionCookie) ?? getCookie(req, legacySessionCookie);
}

async function issueSession(req, res, user) {
  const session = await createSession(user.id);
  res.cookie(sessionCookie, session.token, sessionCookieOptions(req, session.expiresAt));
}

function sendError(res, error) {
  return res.status(error.statusCode || 400).json({ error: error.message });
}

export async function attachUser(req, _res, next) {
  req.sessionUser = (await getSessionUser(getSessionToken(req)));
  req.user = req.headers['x-pat'] !== undefined
    ? (await getPrivateAccessTokenUser(req.headers['x-pat']))
    : req.sessionUser;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Passkey session (cookie or Bearer) or valid X-PAT required' });
  return next();
}

function requireSession(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.sessionUser) return res.status(401).json({ error: 'Passkey login required' });
  req.user = req.sessionUser;
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Passkey login required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  return next();
}

const noLimit = (_req, _res, next) => next();

export function registerAuthRoutes(app, limiters = {}, getMediaUsage = () => null) {
  const registrationOptionsLimiter = limiters.registrationOptions || noLimit;
  const registrationVerifyLimiter = limiters.registrationVerify || noLimit;
  const loginOptionsLimiter = limiters.loginOptions || noLimit;
  const loginVerifyLimiter = limiters.loginVerify || noLimit;

  app.use('/api/auth', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.post('/api/auth/app/token', loginVerifyLimiter, async (req, res) => {
    try {
      const authorization = takeChallenge(req.body?.code, 'app-authorization');
      const verifier = req.body?.codeVerifier;
      if (req.body?.redirectUri !== authorization.redirectUri
        || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        || crypto.createHash('sha256').update(verifier).digest('base64url') !== authorization.codeChallenge) {
        return res.status(400).json({ error: 'Invalid authorization code or PKCE verifier' });
      }
      const user = (await getUser(authorization.userId));
      if (!user || user.status !== 'approved' || user.updatedAt !== authorization.userUpdatedAt) {
        return res.status(403).json({ error: 'Account access changed. Please log in again.' });
      }
      const session = await createSession(user.id);
      return res.json({ user, session: { ...session, tokenType: 'Bearer' } });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Passkey login required' });
    return res.json({ user: req.user });
  });

  app.patch('/api/auth/me', requireSession, async (req, res) => {
    try {
      if (typeof req.body?.name !== 'string' || Object.keys(req.body).some((key) => key !== 'name')) {
        return res.status(400).json({ error: 'Only a username may be changed here' });
      }
      const user = await updateUser(req.user.id, { name: req.body.name }, req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ user });
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/auth/pats', requireSession, async (req, res) => {
    return res.json({ tokens: (await listPrivateAccessTokens(req.user.id)) });
  });

  app.post('/api/auth/pats', requireSession, async (req, res) => {
    try {
      return res.status(201).json(await createPrivateAccessToken(req.user.id, req.body?.name));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/auth/pats/:tokenId', requireSession, async (req, res) => {
    try {
      if (!await deletePrivateAccessToken(req.user.id, req.params.tokenId)) {
        return res.status(404).json({ error: 'PAT not found' });
      }
      return res.status(204).end();
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/auth/register/users', registrationOptionsLimiter, async (_req, res) => {
    return res.json({ users: await listAvailableUsers() });
  });

  app.get('/api/auth/links', requireSession, async (req, res) => {
    try {
      const links = await listUserLinks(req.user.id);
      return res.json({ links, users: (await listAvailableUsers()).filter((user) => user.id !== req.user.id) });
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/auth/links', requireSession, async (req, res) => {
    try {
      await requestUserLink(req.user.id, req.body?.userId);
      return res.status(201).json({ links: await listUserLinks(req.user.id) });
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/auth/links/:id/accept', requireSession, async (req, res) => {
    try {
      await acceptUserLink(req.user.id, req.params.id);
      return res.json({ links: await listUserLinks(req.user.id) });
    } catch (error) { return sendError(res, error); }
  });

  app.delete('/api/auth/links/:id', requireSession, async (req, res) => {
    try {
      if (!await removeUserLink(req.user.id, req.params.id)) return res.status(404).json({ error: 'User link not found' });
      return res.status(204).end();
    } catch (error) { return sendError(res, error); }
  });

  app.get('/api/auth/shared-users', requireSession, async (req, res) => {
    try {
      return res.json({ users: await listOrganizedUsers(req.user.id), libraries: await listOrganizerLibraries(req.user.id) });
    } catch (error) { return sendError(res, error); }
  });

  app.put('/api/auth/shared-users/:id/libraries', requireSession, async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).some((key) => key !== 'sharedUserIds')) {
        return res.status(400).json({ error: 'Only shared library access may be changed here' });
      }
      return res.json({ user: await updateOrganizedUser(req.user.id, req.params.id, req.body.sharedUserIds) });
    } catch (error) { return sendError(res, error); }
  });

  app.post('/api/auth/register/options', registrationOptionsLimiter, async (req, res) => {
    try {
      if (req.body?.client && req.body.client !== 'web') {
        return res.status(400).json({ error: 'Register in the web UI before signing in to the app' });
      }
      const name = String(req.body?.name || '').trim();
      if (name.length < 2 || name.length > 64) {
        return res.status(400).json({ error: 'Name must be between 2 and 64 characters' });
      }
      const account = await validateRegistrationAccount({ role: req.body?.role, organizerId: req.body?.organizerId });
      const userHandle = crypto.randomBytes(32);
      const { rpID, origin } = getWebAuthnConfig(req);
      const options = await generateRegistrationOptions({
        rpName: 'ssMusic',
        rpID,
        userName: name,
        userDisplayName: name,
        userID: userHandle,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        }
      });
      const requestId = rememberChallenge({
        type: 'registration',
        challenge: options.challenge,
        name,
        account,
        userHandle: userHandle.toString('base64url'),
        rpID,
        origin
      }, req.ip);
      return res.json({ requestId, options });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/auth/passkeys', requireSession, async (req, res) => {
    return res.json({ user: req.user, passkeys: (await getUserPasskeys(req.user.id)).credentials });
  });

  app.delete('/api/auth/passkeys/:credentialId', requireSession, async (req, res) => {
    try {
      const user = await deleteCredential(req.user.id, req.params.credentialId);
      if (!user) return res.status(404).json({ error: 'Passkey not found' });
      return res.json({ user, passkeys: (await getUserPasskeys(user.id)).credentials });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/passkeys/options', requireSession, registrationOptionsLimiter, async (req, res) => {
    try {
      if (req.body?.client && req.body.client !== 'web') {
        return res.status(400).json({ error: 'Add passkeys in the web UI' });
      }
      const { userHandle, credentials } = (await getUserPasskeys(req.user.id));
      const { rpID, origin } = getWebAuthnConfig(req);
      const options = await generateRegistrationOptions({
        rpName: 'ssMusic',
        rpID,
        userName: req.user.name,
        userDisplayName: req.user.name,
        userID: Buffer.from(userHandle, 'base64url'),
        excludeCredentials: credentials.map(({ id, transports }) => ({ id, transports })),
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        }
      });
      const requestId = rememberChallenge({
        type: 'additional-passkey',
        challenge: options.challenge,
        userId: req.user.id,
        rpID,
        origin
      }, req.ip);
      return res.json({ requestId, options });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/passkeys/verify', requireSession, registrationVerifyLimiter, async (req, res) => {
    try {
      const challenge = takeChallenge(req.body?.requestId, 'additional-passkey');
      const { rpID, origin } = getWebAuthnConfig(req);
      if (challenge.userId !== req.user.id || challenge.rpID !== rpID || challenge.origin !== origin) {
        return res.status(403).json({ error: 'This passkey request belongs to a different account or origin' });
      }
      const verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Passkey registration could not be verified' });
      }
      const user = await addCredential(req.user.id, verification.registrationInfo.credential);
      return res.status(201).json({ user, passkeys: (await getUserPasskeys(user.id)).credentials });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/register/verify', registrationVerifyLimiter, async (req, res) => {
    try {
      const challenge = takeChallenge(req.body?.requestId, 'registration');
      const verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Passkey registration could not be verified' });
      }
      const user = await registerUser(
        challenge.name,
        challenge.userHandle,
        verification.registrationInfo.credential,
        challenge.account
      );
      if (user.status === 'approved') await issueSession(req, res, user);
      return res.status(201).json({ user });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/login/options', loginOptionsLimiter, async (req, res) => {
    try {
      const { rpID, origin } = getWebAuthnConfig(req);
      const appAuthorization = getAppAuthorization(req.body);
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required'
      });
      const requestId = rememberChallenge({
        type: 'authentication',
        challenge: options.challenge,
        rpID,
        origin,
        appAuthorization
      }, req.ip);
      return res.json({ requestId, options });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/login/verify', loginVerifyLimiter, async (req, res) => {
    try {
      const challenge = takeChallenge(req.body?.requestId, 'authentication');
      const match = (await findCredential(req.body?.response?.id));
      if (!match) return res.status(401).json({ error: 'Passkey is not registered on this server' });
      const verification = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: match.credential,
        requireUserVerification: true
      });
      if (!verification.verified) {
        return res.status(401).json({ error: 'Passkey login could not be verified' });
      }
      const updated = await updateCredentialCounter(
        match.user.id,
        match.credential.id,
        verification.authenticationInfo.newCounter
      );
      if (!updated) return res.status(401).json({ error: 'Passkey is no longer registered on this server' });
      if (match.user.status === 'pending') {
        return res.status(403).json({ error: 'Your access request is waiting for administrator approval', code: 'ACCESS_PENDING' });
      }
      if (match.user.status !== 'approved') {
        return res.status(403).json({ error: 'Your access has been revoked', code: 'ACCESS_REVOKED' });
      }
      const user = (await getUser(match.user.id));
      if (challenge.appAuthorization) {
        const code = rememberChallenge({
          type: 'app-authorization',
          ...challenge.appAuthorization,
          userId: user.id,
          userUpdatedAt: user.updatedAt
        }, req.ip, 60_000);
        const redirect = new URL(challenge.appAuthorization.redirectUri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', challenge.appAuthorization.state);
        return res.json({ redirectUrl: redirect.href });
      }
      await issueSession(req, res, user);
      return res.json({ user });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = getSessionToken(req);
    await deleteSession(token);
    if (req.headers.authorization === undefined) {
      const legacyToken = getCookie(req, legacySessionCookie);
      if (legacyToken && legacyToken !== token) await deleteSession(legacyToken);
      res.clearCookie(sessionCookie, { path: '/' });
      res.clearCookie(legacySessionCookie, { path: '/' });
    }
    return res.status(204).end();
  });

  app.get('/api/admin/users', requireAdmin, async (_req, res) => {
    const users = await listUsers();
    const usage = getMediaUsage();
    res.set('Cache-Control', 'no-store');
    res.json({
      users: users.map((user) => ({
        ...user,
        mediaUsage: usage?.byUser
          ? usage.byUser[user.id] ?? { totalFiles: 0, songFiles: 0, totalBytes: 0 }
          : null
      })),
      mediaScan: usage ? { scannedAt: usage.scannedAt, scanning: usage.scanning, error: usage.error } : null
    });
  });

  app.get('/api/admin/users/:id', requireSession, requireAdmin, async (req, res) => {
    const user = (await getUser(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const libraries = user.role === 'shared' ? await (user.organizerId ? listOrganizerLibraries(user.organizerId) : listAvailableUsers()) : [];
    return res.json({ user, tokens: (await listPrivateAccessTokens(user.id)), libraries });
  });

  app.delete('/api/admin/users/:id', requireSession, requireAdmin, async (req, res) => {
    try {
      if (!await deleteUser(req.params.id, req.user.id)) {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.status(204).end();
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/admin/users/:id/pats/:tokenId', requireSession, requireAdmin, async (req, res) => {
    try {
      if (!await deletePrivateAccessToken(req.params.id, req.params.tokenId)) {
        return res.status(404).json({ error: 'PAT not found' });
      }
      return res.status(204).end();
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const user = await updateUser(req.params.id, {
        status: req.body?.status,
        role: req.body?.role,
        name: req.body?.name,
        organizerId: req.body?.organizerId,
        sharedUserIds: req.body?.sharedUserIds
      }, req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const libraries = user.role === 'shared' ? await (user.organizerId ? listOrganizerLibraries(user.organizerId) : listAvailableUsers()) : [];
      return res.json({ user, libraries });
    } catch (error) {
      return sendError(res, error);
    }
  });
}