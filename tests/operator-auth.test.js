const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  BOOTSTRAP_HEADER,
  createOperatorAuth,
  isLoopbackAddress,
  isLoopbackRequest,
  MIN_BOOTSTRAP_SECRET_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  SESSION_TTL_SECONDS,
} = require('../src/operator-auth');
const { signJwt } = require('../src/jwt');
const { readJSON, writeJSON } = require('../src/shared-utils');
const { createCorsMiddleware } = require('../src/gateway-listen');

const PASSWORD = 'gateway-password-1';
const NEW_PASSWORD = 'gateway-password-2';
const BOOTSTRAP_SECRET = 'bootstrap-secret-with-at-least-32-bytes';
const tmpFiles = [];

const tmpAuthFile = () => {
  const file = path.join(os.tmpdir(), `operator-auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(file);
  return file;
};

const seedPassword = (file, password = PASSWORD) => {
  const salt = crypto.randomBytes(16).toString('hex');
  writeJSON(file, {
    kdf: 'scrypt',
    salt,
    hash: crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex'),
    updatedAt: new Date().toISOString(),
  });
};

after(() => {
  for (const file of tmpFiles) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
});

const withServer = async (authOpts, run, { corsMiddleware = null } = {}) => {
  const app = express();
  if (corsMiddleware) app.use(corsMiddleware);
  const auth = createOperatorAuth(authOpts);
  const reached = { providers: 0, runs: 0 };
  app.use(express.json());
  auth.registerSessionRoutes(app);
  app.use('/api', auth.requireAuth);
  app.get('/api/providers', (req, res) => {
    reached.providers += 1;
    res.json({ providers: [] });
  });
  app.post('/api/runs', (req, res) => {
    reached.runs += 1;
    res.status(202).json({ runId: 'test' });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ auth, baseUrl, reached });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

describe('operator authentication bootstrap', () => {
  it('starts in a fail-closed bootstrap state when no password file exists', () => {
    assert.doesNotThrow(() => createOperatorAuth({}));
    const auth = createOperatorAuth({});
    assert.equal(auth.isRequired(), true);
    assert.equal(auth.isBootstrapping(), true);
    assert.equal(auth.hasPassword(), false);
  });

  it('blocks APIs and reports bootstrap state when no password is configured', async () => {
    await withServer({ authFile: tmpAuthFile(), readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const session = await fetch(`${baseUrl}/api/auth/session`).then((r) => r.json());
      assert.deepEqual(session, {
        authenticated: false,
        required: true,
        bootstrapRequired: true,
        bootstrapSecretRequired: false,
      });

      const providerResponse = await fetch(`${baseUrl}/api/providers`);
      const runResponse = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(providerResponse.status, 401);
      assert.equal(runResponse.status, 401);
      assert.deepEqual(reached, { providers: 0, runs: 0 });
    });
  });

  it('guards realtime upgrades while bootstrap is incomplete', async () => {
    const auth = createOperatorAuth({});
    assert.equal(await auth.authorizeUpgrade({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), false);
  });

  it('recognizes only direct loopback addresses as locally trusted', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('100.83.147.46'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.1.10'), false);

    const request = (remoteAddress, forwardedFor = '', host = 'localhost:5570', forwardedHost = '') => ({
      socket: { remoteAddress },
      get: (name) => name === 'x-forwarded-for' ? forwardedFor
        : name === 'x-forwarded-host' ? forwardedHost
          : name === 'host' ? host : '',
    });
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1')), true);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '::1, 127.0.0.1')), true);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '100.83.147.46')), false);
    assert.equal(isLoopbackRequest(request('100.83.147.46', '127.0.0.1')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '', 'critical-mass.example')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', 'evil.example:5571', 'evil.example:5571')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', 'localhost:5571', 'evil.example:5571')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', 'evil.example:5571', 'localhost:5571')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', 'localhost:5571', 'localhost:5571, evil.example:5571')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', 'evil.example:5571')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', 'localhost:5571', 'localhost:5571')), true);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1', '127.0.0.1:5571')), true);
    assert.equal(isLoopbackRequest(request('::1', '', '[::1]:5571')), true);
    const rebindingRequest = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        'x-forwarded-for': '127.0.0.1',
        'x-forwarded-host': 'evil.example:5571',
        origin: 'http://evil.example:5571',
      },
    };
    assert.equal(isLoopbackRequest(rebindingRequest), false);

    const proxied = (headers) => ({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:5570', ...headers },
    });
    assert.equal(isLoopbackRequest(proxied({})), true);
    assert.equal(isLoopbackRequest(proxied({ 'x-forwarded-for': '' })), false);
    for (const header of ['forwarded', 'via', 'x-real-ip', 'x-forwarded-proto', 'x-forwarded-port']) {
      assert.equal(isLoopbackRequest(proxied({ [header]: 'x' })), false, header);
    }

    const requestWithOrigin = (remoteAddress, host, origin) => ({
      socket: { remoteAddress },
      get: (name) => name === 'host' ? host : name === 'origin' ? origin : '',
    });
    assert.equal(isLoopbackRequest(requestWithOrigin('127.0.0.1', 'localhost:5570', 'http://localhost:5570')), true);
    assert.equal(isLoopbackRequest(requestWithOrigin('127.0.0.1', 'localhost:5570', 'https://foreign.ts.net')), false);
  });

  it('rejects short remote bootstrap secrets at startup', () => {
    assert.throws(
      () => createOperatorAuth({ bootstrapSecret: 'too-short' }),
      new RegExp(`at least ${MIN_BOOTSTRAP_SECRET_LENGTH} bytes`)
    );
  });

  it('rejects remote enrollment without the configured one-time bootstrap secret', async () => {
    await withServer({
      authFile: tmpAuthFile(),
      readJSON,
      writeJSON,
      bootstrapSecret: BOOTSTRAP_SECRET,
      isTrustedBootstrapRequest: () => false,
    }, async ({ baseUrl }) => {
      const session = await fetch(`${baseUrl}/api/auth/session`).then((r) => r.json());
      assert.equal(session.bootstrapSecretRequired, true);

      for (const headers of [
        { 'Content-Type': 'application/json' },
        { 'Content-Type': 'application/json', [BOOTSTRAP_HEADER]: 'not-the-secret' },
      ]) {
        const response = await fetch(`${baseUrl}/api/auth/password`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ password: PASSWORD }),
        });
        assert.equal(response.status, 403);
      }
    });
  });

  it('requires the generated local secret when loopback is not trusted (headerless proxy, #1328)', async () => {
    const authFile = tmpAuthFile();
    const secretFile = tmpAuthFile();
    await withServer({
      authFile,
      readJSON,
      writeJSON,
      localBootstrapSecretFile: secretFile,
      isTrustedBootstrapRequest: () => false,
    }, async ({ baseUrl }) => {
      assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
      const secret = fs.readFileSync(secretFile, 'utf8').trim();
      assert.ok(Buffer.byteLength(secret) >= MIN_BOOTSTRAP_SECRET_LENGTH);
      const session = await fetch(`${baseUrl}/api/auth/session`).then((r) => r.json());
      assert.equal(session.bootstrapSecretRequired, true);

      // Loopback socket + loopback Host, no X-Forwarded-For, no Origin, no secret.
      const put = (headers = {}) => fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal((await put()).status, 403);
      assert.equal((await put({ [BOOTSTRAP_HEADER]: 'wrong' })).status, 403);
      const enrolled = await put({ [BOOTSTRAP_HEADER]: secret });
      assert.equal(enrolled.status, 200);
      assert.doesNotMatch(await enrolled.text(), new RegExp(secret));
      assert.equal(fs.existsSync(secretFile), false);
    });
  });

  it('reuses an existing local secret file and does not open remote listening', () => {
    const secretFile = tmpAuthFile();
    const existing = 'e'.repeat(40);
    fs.writeFileSync(secretFile, existing, { mode: 0o600 });
    const auth = createOperatorAuth({ localBootstrapSecretFile: secretFile, isTrustedBootstrapRequest: () => false });
    assert.equal(fs.readFileSync(secretFile, 'utf8'), existing);
    assert.equal(auth.hasRemoteBootstrap(), false);
  });

  it('accepts a valid remote bootstrap secret once without returning it', async () => {
    const authFile = tmpAuthFile();
    const bootstrapSecretFile = tmpAuthFile();
    fs.writeFileSync(bootstrapSecretFile, BOOTSTRAP_SECRET, { mode: 0o600 });
    await withServer({
      authFile,
      readJSON,
      writeJSON,
      bootstrapSecret: BOOTSTRAP_SECRET,
      bootstrapSecretFile,
      isTrustedBootstrapRequest: () => false,
    }, async ({ baseUrl }) => {
      const enrolled = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          [BOOTSTRAP_HEADER]: BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(enrolled.status, 200);
      assert.doesNotMatch(await enrolled.text(), new RegExp(BOOTSTRAP_SECRET));
      assert.equal(fs.existsSync(bootstrapSecretFile), false);

      const cleared = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(cleared.status, 200);

      const reused = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          [BOOTSTRAP_HEADER]: BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      });
      assert.equal(reused.status, 403);
      assert.match(readJSON(authFile, null).bootstrapConsumedHash, /^[a-f0-9]{64}$/);
    });
  });

  it('rejects cross-origin bootstrap enrollment without bootstrap secret, even when CORS preflight is allowed', async () => {
    const authFile = tmpAuthFile();
    const foreignOrigin = 'https://void.taile8179.ts.net';
    const corsMiddleware = createCorsMiddleware(['http://localhost:5570', 'http://localhost:5571']);

    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      // 1. CORS preflight succeeds for allowed .ts.net origin
      const preflight = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'OPTIONS',
        headers: {
          Origin: foreignOrigin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), foreignOrigin);

      // 2. Session check from foreign origin reports bootstrapSecretRequired
      const session = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Origin: foreignOrigin },
      }).then((r) => r.json());
      assert.equal(session.bootstrapRequired, true);
      assert.equal(session.bootstrapSecretRequired, true);

      // 3. Attempt to enroll password from foreign origin without bootstrap secret fails with 403
      const enroll = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: foreignOrigin,
        },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      });
      assert.equal(enroll.status, 403);
      assert.equal(fs.existsSync(authFile), false, 'password file was not created');

      // 4. Rejected password cannot authorize protected endpoints
      const protectedRes = await fetch(`${baseUrl}/api/providers`, {
        headers: { Authorization: `Bearer ${NEW_PASSWORD}` },
      });
      assert.equal(protectedRes.status, 401);
      assert.equal(reached.providers, 0);

      // 5. Same-origin local enrollment still works
      const sameOriginEnroll = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(sameOriginEnroll.status, 200);
      assert.equal(fs.existsSync(authFile), true);

      // 6. Authorized with enrolled password
      const authorizedRes = await fetch(`${baseUrl}/api/providers`, {
        headers: { Authorization: `Bearer ${PASSWORD}` },
      });
      assert.equal(authorizedRes.status, 200);
      assert.equal(reached.providers, 1);
    }, { corsMiddleware });
  });
});

describe('operator password set from the admin panel', () => {
  it('turns on auth after PUT /api/auth/password and accepts the new password', async () => {
    const authFile = tmpAuthFile();
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const tooShort = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'short' }),
      });
      assert.equal(tooShort.status, 400);

      const set = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(set.status, 200);
      assert.ok(fs.existsSync(authFile), 'password hash is written to data file');
      const cookie = set.headers.get('set-cookie').split(';')[0];

      const blocked = await fetch(`${baseUrl}/api/providers`);
      assert.equal(blocked.status, 401);
      assert.equal(reached.providers, 0);

      const allowed = await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: cookie } });
      assert.equal(allowed.status, 200);

      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200);
    });
  });

  it('removes the password but returns the gateway to fail-closed local bootstrap', async () => {
    const authFile = tmpAuthFile();
    let removalNotified = false;
    await withServer({
      authFile,
      readJSON,
      writeJSON,
      onPasswordRemoved: () => { removalNotified = true; },
    }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cleared = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(cleared.status, 200);
      assert.deepEqual(await cleared.json(), {
        authenticated: false,
        required: true,
        bootstrapRequired: true,
      });
      assert.equal(readJSON(authFile, null).state, 'bootstrap');
      assert.equal((await fetch(`${baseUrl}/api/providers`)).status, 401);
      assert.equal(removalNotified, true);
    });
  });
});

describe('operator authentication boundary', () => {
  it('prevents unauthenticated requests from reaching provider and run handlers', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const providerResponse = await fetch(`${baseUrl}/api/providers`);
      const runResponse = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'test', prompt: 'hello' }),
      });
      assert.equal(providerResponse.status, 401);
      assert.equal(runResponse.status, 401);
      assert.deepEqual(reached, { providers: 0, runs: 0 });
    });
  });

  it('lets an authenticated browser session reach protected handlers', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const providerResponse = await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: cookie } });
      const runResponse = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'test', prompt: 'hello' }),
      });
      assert.equal(providerResponse.status, 200);
      assert.equal(runResponse.status, 202);
      assert.deepEqual(reached, { providers: 1, runs: 1 });
    });
  });

  it('persists and renews browser authentication across page and gateway reloads', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    let cookie;

    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie');
      assert.match(setCookie, new RegExp(`Max-Age=${SESSION_TTL_SECONDS}(?:;|$)`));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      cookie = setCookie.split(';')[0];
    });

    // Recreate the auth service from its persisted password record, matching a
    // gateway restart. A subsequent page-load session check stays authorized
    // and renews the durable browser cookie.
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const session = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: cookie },
      });
      assert.equal(session.status, 200);
      assert.deepEqual(await session.json(), {
        authenticated: true,
        required: true,
        bootstrapRequired: false,
        bootstrapSecretRequired: false,
      });
      assert.match(
        session.headers.get('set-cookie'),
        new RegExp(`Max-Age=${SESSION_TTL_SECONDS}(?:;|$)`)
      );

      const protectedResponse = await fetch(`${baseUrl}/api/providers`, {
        headers: { Cookie: cookie },
      });
      assert.equal(protectedResponse.status, 200);
    });
  });

  it('revokes persisted browser authentication after a password change or sign-out', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);

    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const oldCookie = login.headers.get('set-cookie').split(';')[0];

      const changed = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { Cookie: oldCookie, Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: NEW_PASSWORD, currentPassword: PASSWORD }),
      });
      assert.equal(changed.status, 200);
      const newCookie = changed.headers.get('set-cookie').split(';')[0];

      const revoked = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: oldCookie },
      });
      assert.deepEqual(await revoked.json(), {
        authenticated: false,
        required: true,
        bootstrapRequired: false,
        bootstrapSecretRequired: false,
      });

      const signedOut = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'DELETE',
        headers: { Cookie: newCookie, Origin: baseUrl },
      });
      assert.equal(signedOut.status, 204);
      assert.match(signedOut.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
    });
  });

  it('sign-out revokes a copied session cookie and sessions use a key independent of the password hash (#1583)', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    let revoked = 0;
    await withServer({ authFile, readJSON, writeJSON, onSessionsRevoked: () => { revoked += 1; } }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const saved = readJSON(authFile, null);
      assert.match(saved.sessionKey, /^[0-9a-f]{64}$/);
      assert.equal(saved.sessionEpoch, 1);
      // A token forged from the stored hash alone must not verify.
      const legacy = crypto.createHash('sha256').update(`critical-mass-session:${saved.hash}`).digest('hex');
      const forged = signJwt({ sub: 'operator', role: 'operator', ep: 1 }, legacy, {
        algorithm: 'HS256', audience: 'critical-mass', issuer: 'critical-mass', expiresIn: 60,
      });
      const probe = (c) => fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: c } }).then((r) => r.json());
      assert.equal((await probe(`critical_mass_operator=${forged}`)).authenticated, false);
      assert.equal((await probe(cookie)).authenticated, true);

      const out = await fetch(`${baseUrl}/api/auth/session`, { method: 'DELETE', headers: { Cookie: cookie, Origin: baseUrl } });
      assert.equal(out.status, 204);
      assert.equal(readJSON(authFile, null).sessionEpoch, 2);
      assert.equal(revoked, 1);
      assert.equal((await probe(cookie)).authenticated, false);
    });
  });

  it('migrates a legacy auth record to a session key once and persists it (#1583)', () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    assert.equal(readJSON(authFile, null).sessionKey, undefined);
    createOperatorAuth({ authFile, readJSON, writeJSON });
    const first = readJSON(authFile, null);
    assert.match(first.sessionKey, /^[0-9a-f]{64}$/);
    createOperatorAuth({ authFile, readJSON, writeJSON });
    assert.equal(readJSON(authFile, null).sessionKey, first.sessionKey);
  });

  it('accepts bearer auth (the panel password) and rejects cross-origin session mutations', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const bearerResponse = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(bearerResponse.status, 202);

      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const rejected = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(rejected.status, 403);
      assert.equal(reached.runs, 1);
    });
  });

  it('marks session cookies Secure when HTTPS is forwarded', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Strict/i);
      assert.match(cookie, /Secure/i);
    });
  });

  it('guards realtime upgrades with the panel password and the gateway origin', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    const auth = createOperatorAuth({ authFile, readJSON, writeJSON });
    const invoke = (headers = {}) => auth.authorizeUpgrade({ headers: { host: '127.0.0.1:5570', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(await invoke(), false);
    assert.equal(await invoke({ authorization: `Bearer ${PASSWORD}` }), true);
    assert.equal(await invoke({ authorization: `Bearer ${PASSWORD}`, origin: 'http://127.0.0.1:5570' }), true);
    // A page on another origin cannot open the bus even with valid credentials.
    assert.equal(await invoke({ authorization: `Bearer ${PASSWORD}`, origin: 'https://attacker.invalid' }), false);
  });
});

describe('operator password change CSRF and reauthentication', () => {
  it('rejects a cross-origin session-cookie password change with 403', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: NEW_PASSWORD, currentPassword: PASSWORD }),
      });
      assert.equal(response.status, 403);
    });
  });

  it('rejects a same-origin session-cookie password change with missing currentPassword', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Current password is required' });
    });
  });

  it('rejects a session-cookie password change with an incorrect currentPassword', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: NEW_PASSWORD, currentPassword: 'totally-wrong' }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Current password is incorrect' });
    });
  });

  it('allows a bearer-authenticated password change without currentPassword', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      });
      assert.equal(response.status, 200);
    });
  });

  it('rejects a cross-origin session-cookie password removal and sign-out', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const removed = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(removed.status, 403);

      const signedOut = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: 'https://attacker.invalid' },
      });
      assert.equal(signedOut.status, 403);
    });
  });
});

describe('operator password length', () => {
  it('exports the panel minimum', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.equal(MIN_BOOTSTRAP_SECRET_LENGTH, 32);
  });

  it('keeps browser sessions for 30 days', () => {
    assert.equal(SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  });
});

describe('operator authentication resource bounds', () => {
  const send = (baseUrl, route, method, body, headers = {}) => fetch(baseUrl + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  it('rejects oversized UTF-8 passwords on every mutation before invoking scrypt', async (t) => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    const hash = t.mock.method(crypto, 'scrypt', () => assert.fail('oversized password was hashed'));
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const oversized = 'é'.repeat(MAX_PASSWORD_BYTES / 2 + 1);
      for (const [route, method, body] of [
        ['/api/auth/session', 'POST', { password: oversized }],
        ['/api/auth/session', 'POST', { token: oversized }],
        ['/api/auth/password', 'PUT', { password: oversized, currentPassword: PASSWORD }],
        ['/api/auth/password', 'PUT', { password: NEW_PASSWORD, currentPassword: oversized }],
        ['/api/auth/password', 'DELETE', { password: oversized }],
      ]) {
        assert.equal((await send(baseUrl, route, method, body)).status, 400);
      }
      assert.equal(hash.mock.callCount(), 0);
    });
  });

  it('shares a five-attempt peer budget across login and bootstrap, ignores forwarded IPs, and expires it', async () => {
    let time = 1000;
    await withServer({ authFile: tmpAuthFile(), readJSON, writeJSON, now: () => time }, async ({ baseUrl }) => {
      for (let i = 0; i < 5; i++) {
        const response = await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD },
          { 'X-Forwarded-For': '192.0.2.' + i });
        assert.equal(response.status, 401);
      }
      const limited = await send(baseUrl, '/api/auth/password', 'PUT', { password: PASSWORD });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '60');
      time += 60_000;
      assert.equal((await send(baseUrl, '/api/auth/password', 'PUT', { password: PASSWORD })).status, 200);
      const login = await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD });
      assert.equal(login.status, 200);
      assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
      assert.match(login.headers.get('set-cookie'), /SameSite=Strict/i);
    });
  });

  it('does not charge successful logins against the failed-attempt budget (#1581)', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON, now: () => 0 }, async ({ baseUrl }) => {
      for (let i = 0; i < 4; i++) {
        assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: 'wrong-password' })).status, 401);
      }
      for (let i = 0; i < 10; i++) {
        assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD })).status, 200);
      }
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: 'wrong-password' })).status, 401);
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: 'wrong-password' })).status, 429);
    });
  });

  it('keys the budget on the last X-Forwarded-For hop only when the proxy is trusted (#1581)', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON, now: () => 0, trustProxy: true }, async ({ baseUrl }) => {
      const attacker = { 'X-Forwarded-For': '192.0.2.1, 10.0.0.1' };
      for (let i = 0; i < 5; i++) {
        assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: 'wrong-password' }, attacker)).status, 401);
      }
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD }, attacker)).status, 429);
      // Rotating the client-controlled first hop does not buy a fresh budget.
      const rotated = { 'X-Forwarded-For': '192.0.2.77, 10.0.0.1' };
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD }, rotated)).status, 429);
      const operator = { 'X-Forwarded-For': '192.0.2.2' };
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD }, operator)).status, 200);
      const bogus = { 'X-Forwarded-For': 'not-an-ip' };
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD }, bogus)).status, 200);
    });
  });

  it('limits wrong-password guesses before hashing and allows login after the window', async (t) => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    let time = 0;
    const hash = t.mock.method(crypto, 'scrypt');
    await withServer({ authFile, readJSON, writeJSON, now: () => time }, async ({ baseUrl }) => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: 'wrong-password' })).status, 401);
      }
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD })).status, 429);
      assert.equal((await fetch(baseUrl + '/api/providers', {
        headers: { Authorization: `Bearer ${PASSWORD}`, 'X-Forwarded-For': '192.0.2.99' },
      })).status, 429);
      assert.equal(hash.mock.callCount(), 5);
      time = 60_000;
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD })).status, 200);
      assert.equal(hash.mock.callCount(), 6);
    });
  });

  it('shares failed bearer guesses across API, session, and socket authentication', async (t) => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    let time = 0;
    const hash = t.mock.method(crypto, 'scrypt');
    await withServer({ authFile, readJSON, writeJSON, now: () => time }, async ({ auth, baseUrl }) => {
      const headers = { Authorization: 'Bearer wrong-password' };
      const socketAttempt = () => auth.authorizeUpgrade({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '192.0.2.10', authorization: 'Bearer wrong-password' },
      }).catch((error) => error);
      for (let i = 0; i < 2; i++) {
        assert.equal((await fetch(baseUrl + '/api/providers', { headers })).status, 401);
        assert.equal((await fetch(baseUrl + '/api/auth/session', { headers })).status, 200);
      }
      assert.equal(await socketAttempt(), false);
      assert.equal((await fetch(baseUrl + '/api/providers', { headers })).status, 429);
      assert.equal((await fetch(baseUrl + '/api/auth/session', { headers })).status, 429);
      assert.equal((await socketAttempt()).status, 429);
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD })).status, 429);
      assert.equal(hash.mock.callCount(), 5);
      time = 60_000;
      for (let i = 0; i < 7; i++) {
        assert.equal((await fetch(baseUrl + '/api/providers', {
          headers: { Authorization: `Bearer ${PASSWORD}` },
        })).status, 200);
      }
      assert.equal(hash.mock.callCount(), 12);
    });
  });

  it('keeps the gateway responsive during hashing and rejects overlapping KDF work without queueing', async (t) => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    const original = crypto.scrypt;
    let release;
    let started;
    const hashing = new Promise((resolve) => { started = resolve; });
    t.mock.method(crypto, 'scrypt', (...args) => {
      release = () => original(...args);
      started();
    });
    t.mock.method(crypto, 'scryptSync', () => assert.fail('request used synchronous hashing'));
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      const login = send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD });
      await hashing;
      try {
        assert.equal((await fetch(baseUrl + '/api/auth/session')).status, 200);
        assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD })).status, 429);
      } finally {
        release();
      }
      assert.equal((await login).status, 200);
    });
  });

  it('fails closed when the bounded peer table is full and recovers after expiry', async () => {
    let time = 0;
    const routes = {};
    const auth = createOperatorAuth({ now: () => time });
    auth.registerSessionRoutes({
      get() {}, put() {}, delete() {},
      post(route, ...handlers) { routes[route] = handlers; },
    });
    const limiter = routes['/api/auth/session'][1];
    let allowed = 0;
    let status;
    const res = { set() {}, status(value) { status = value; return this; }, json() {} };
    for (let i = 0; i < 1024; i++) {
      limiter({ socket: { remoteAddress: 'peer-' + i } }, res, () => allowed++);
    }
    limiter({ socket: { remoteAddress: 'new-peer' } }, res, () => allowed++);
    assert.equal(status, 429);
    assert.equal(allowed, 1024);
    time = 60_000;
    limiter({ socket: { remoteAddress: 'new-peer' } }, res, () => allowed++);
    assert.equal(allowed, 1025);
  });
});

// Real realtime-bus upgrades through Node's global WebSocket client. The
// operator check refuses the HTTP upgrade itself, so a refused client only
// sees a failed connection.
const connectOperatorSocket = (baseUrl, { cookie, token } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/realtime`, { headers });
  socket.packets = [];
  socket.addEventListener('error', () => reject(new Error('UNAUTHORIZED')));
  socket.addEventListener('message', ({ data }) => {
    const packet = String(data);
    socket.packets.push(packet);
    const frame = JSON.parse(packet);
    if (frame.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
    if (frame.t === 'open') resolve(socket);
  });
});

const sendEvent = (socket, event, payload) => socket.send(JSON.stringify({ t: 'event', e: event, p: payload }));

const socketEvent = (socket, name) => new Promise((resolve) => {
  const onMessage = ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.t !== 'event' || frame.e !== name) return;
    socket.removeEventListener('message', onMessage);
    resolve(frame.p);
  };
  socket.addEventListener('message', onMessage);
});

const withSocketGateway = async (run, { failPersistence = false } = {}) => {
  const { createRealtimeBus } = require('../src/realtime-bus');
  const { EventEmitter } = require('node:events');
  const { createLogStreamRegistry, registerLogStreamHandlers, disconnectLogStream } = require('../src/log-stream-manager');
  const authFile = tmpAuthFile();
  seedPassword(authFile);
  const app = express();
  const servers = [http.createServer(app), http.createServer(app)];
  let auth = null;
  const io = createRealtimeBus({ httpServer: servers[0], authorize: (req) => auth.authorizeUpgrade(req) });
  io.attach(servers[1]);
  const registry = createLogStreamRegistry();
  const children = [];
  let changes = 0;
  let now = Date.now();
  auth = createOperatorAuth({
    now: () => now,
    authFile, readJSON,
    writeJSON: (...args) => {
      if (failPersistence) throw new Error('test persistence failure');
      writeJSON(...args);
    },
    onPasswordChanged: () => {
      changes += 1;
      const saved = readJSON(authFile);
      assert.equal(saved.hash, crypto.scryptSync(NEW_PASSWORD, Buffer.from(saved.salt, 'hex'), 32).toString('hex'));
      io.disconnectSockets();
    },
  });
  app.use(express.json());
  auth.registerSessionRoutes(app);
  app.get('/api/protected', auth.requireAuth, (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  io.on('connection', (socket) => {
    socket.on('disconnect', () => disconnectLogStream({ socket, registry, log: () => {} }));
    registerLogStreamHandlers({
      socket, registry, log: () => {}, allowedProcesses: new Set(['critical-mass']),
      spawnFn: (command, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; };
        child.args = args;
        children.push(child);
        return child;
      },
    });
  });
  const clients = [];
  try {
    for (const server of servers) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const urls = servers.map((server) => `http://127.0.0.1:${server.address().port}`);
    const connect = async (index, credentials) => {
      const client = await connectOperatorSocket(urls[index], credentials);
      clients.push(client);
      return client;
    };
    await run({ urls, connect, io, registry, children, authFile, changes: () => changes, expireAttempts: () => { now += 60_001; } });
  } finally {
    for (const client of clients) client.close();
    await Promise.all([io.close(), ...servers.map((server) => new Promise((resolve) => server.close(resolve)))]);
  }
};

describe('operator realtime upgrade origin boundary', () => {
  it('checks session origins on realtime upgrades', async (t) => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    await withServer({ authFile, readJSON, writeJSON }, async ({ auth, baseUrl }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const host = new URL(baseUrl).host;
      const devHost = 'localhost:5571';
      const tailscaleHost = 'gateway.example.ts.net:5570';
      const cases = [
        { name: 'rejects a same-site sibling port', headers: { host, origin: 'http://127.0.0.1:3000' }, allowed: false },
        { name: 'accepts the production page origin', headers: { host, origin: baseUrl }, allowed: true },
        { name: 'accepts the Vite forwarded page host', headers: { host, origin: `http://${devHost}`, 'x-forwarded-host': devHost }, allowed: true },
        { name: 'accepts a forwarded Tailscale page host', headers: { host, origin: `https://${tailscaleHost}`, 'x-forwarded-host': `${tailscaleHost}, internal:5570` }, allowed: true },
        { name: 'rejects a mismatch against the forwarded host', headers: { host, origin: baseUrl, 'x-forwarded-host': devHost }, allowed: false },
        { name: 'rejects a malformed origin', headers: { host, origin: 'null' }, allowed: false },
        { name: 'rejects a foreign origin even with bearer credentials', headers: { host, origin: 'https://attacker.invalid', authorization: `Bearer ${PASSWORD}` }, allowed: false, bearerOnly: true },
        { name: 'accepts a session without an Origin header', headers: { host }, allowed: true },
      ];
      for (const { name, headers, allowed, bearerOnly } of cases) {
        await t.test(name, async () => {
          const req = { headers: bearerOnly ? headers : { cookie, ...headers }, socket: { remoteAddress: '127.0.0.1' } };
          assert.equal(await auth.authorizeUpgrade(req), allowed);
        });
      }
    });
  });
});

describe('established operator socket revocation', () => {
  it('revokes every listener, cleans log streams and permits only replacement credentials', { timeout: 10000 }, async () => {
    await withSocketGateway(async ({ urls, connect, io, registry, children, authFile, changes, expireAttempts }) => {
      const login = await fetch(`${urls[0]}/api/auth/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const clients = [await connect(0, { cookie }), await connect(1, { token: PASSWORD })];
      for (const client of clients) {
        const subscribed = socketEvent(client, 'logs:subscribed');
        sendEvent(client, 'logs:subscribe', { processName: 'critical-mass' });
        await subscribed;
      }
      const originalRecord = readJSON(authFile);
      for (const [body, status, origin] of [
        [{ password: NEW_PASSWORD, currentPassword: 'incorrect' }, 401],
        [{ password: 'short', currentPassword: PASSWORD }, 400],
        [{ password: NEW_PASSWORD, currentPassword: PASSWORD }, 403, 'https://other.invalid'],
      ]) {
        const response = await fetch(`${urls[0]}/api/auth/password`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, status);
        assert.equal(changes(), 0);
        assert.deepEqual(readJSON(authFile), originalRecord);
        assert.equal(io.sockets.size, 2);
        assert.ok(children.every((child) => !child.killed));
        const delivered = socketEvent(clients[0], 'trade:event');
        io.emit('trade:event', { valid: true });
        assert.deepEqual(await delivered, { valid: true });
      }
      const closed = clients.map((client) => new Promise((resolve) => client.addEventListener('close', resolve, { once: true })));
      const response = await fetch(`${urls[0]}/api/auth/password`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ password: NEW_PASSWORD, currentPassword: PASSWORD }),
      });
      assert.equal(response.status, 200);
      assert.equal(changes(), 1);
      assert.notDeepEqual(readJSON(authFile), originalRecord);
      // Cleanup is synchronous and complete before the HTTP success response.
      assert.equal(io.sockets.size, 0);
      assert.deepEqual([...registry.entries()], []);
      assert.ok(children.every((child) => child.killed));
      await Promise.all(closed);
      const packetCounts = clients.map((client) => client.packets.length);
      io.emit('trade:event', { revoked: true });
      for (const child of children) child.stdout.emit('data', Buffer.from('private log\n'));
      for (const client of clients) {
        // A closed transport cannot dispatch another PM2 subscribe or flush
        // (a closed global WebSocket drops sends silently).
        assert.equal(client.readyState, WebSocket.CLOSED);
        sendEvent(client, 'logs:flush', { processName: 'critical-mass' });
        sendEvent(client, 'logs:subscribe', { processName: 'critical-mass' });
      }
      assert.equal(children.length, 2);
      assert.deepEqual(clients.map((client) => client.packets.length), packetCounts);
      assert.equal((await fetch(`${urls[0]}/api/protected`, { headers: { Cookie: cookie } })).status, 401);
      expireAttempts(); // Separate credential rejection from the shared guess budget.
      await assert.rejects(connect(0, { cookie }), /UNAUTHORIZED/);
      await assert.rejects(connect(1, { token: PASSWORD }), /UNAUTHORIZED/);
      const newCookie = response.headers.get('set-cookie').split(';')[0];
      await connect(0, { cookie: newCookie });
      await connect(1, { token: NEW_PASSWORD });
      assert.equal(io.sockets.size, 2);
    });
  });

  it('preserves credentials and connections if persistence fails', { timeout: 10000 }, async () => {
    await withSocketGateway(async ({ urls, connect, io, authFile, changes }) => {
      const client = await connect(0, { token: PASSWORD });
      const originalRecord = readJSON(authFile);
      const response = await fetch(`${urls[0]}/api/auth/password`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASSWORD}` },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      });
      assert.equal(response.status, 500);
      assert.equal(changes(), 0);
      assert.deepEqual(readJSON(authFile), originalRecord);
      assert.equal((await fetch(`${urls[0]}/api/protected`, { headers: { Authorization: `Bearer ${PASSWORD}` } })).status, 200);
      const delivered = socketEvent(client, 'trade:event');
      io.emit('trade:event', { valid: true });
      assert.deepEqual(await delivered, { valid: true });
    }, { failPersistence: true });
  });
});
