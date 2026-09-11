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
const { readJSON, writeJSON } = require('../src/shared-utils');

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

const withServer = async (authOpts, run) => {
  const app = express();
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

  it('guards Socket.IO while bootstrap is incomplete', async () => {
    const auth = createOperatorAuth({});
    const error = await new Promise((resolve) => {
      auth.socketMiddleware({ handshake: { headers: {}, auth: {} } }, (err) => resolve(err));
    });
    assert.equal(error?.data?.code, 'UNAUTHORIZED');
  });

  it('recognizes only direct loopback addresses as locally trusted', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('100.83.147.46'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.1.10'), false);

    const request = (remoteAddress, forwardedFor = '', host = 'localhost:5570') => ({
      socket: { remoteAddress },
      get: (name) => name === 'x-forwarded-for' ? forwardedFor : name === 'host' ? host : '',
    });
    assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1')), true);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '::1, 127.0.0.1')), true);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '100.83.147.46')), false);
    assert.equal(isLoopbackRequest(request('100.83.147.46', '127.0.0.1')), false);
    assert.equal(isLoopbackRequest(request('127.0.0.1', '', 'critical-mass.example')), false);
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

  it('guards Socket.IO handshakes with the panel password', async () => {
    const authFile = tmpAuthFile();
    seedPassword(authFile);
    const auth = createOperatorAuth({ authFile, readJSON, writeJSON });
    const invoke = (headers = {}, handshakeAuth = {}) => new Promise((resolve) => {
      auth.socketMiddleware({ handshake: { headers, auth: handshakeAuth } }, (error) => resolve(error));
    });
    assert.equal((await invoke())?.data?.code, 'UNAUTHORIZED');
    assert.equal(await invoke({}, { token: PASSWORD }), undefined);
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
      assert.equal(hash.mock.callCount(), 5);
      time = 60_000;
      assert.equal((await send(baseUrl, '/api/auth/session', 'POST', { password: PASSWORD })).status, 200);
      assert.equal(hash.mock.callCount(), 6);
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
