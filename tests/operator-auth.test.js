const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  createOperatorAuth,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_SECONDS,
} = require('../src/operator-auth');
const { readJSON, writeJSON } = require('../src/shared-utils');

const PASSWORD = 'gateway-password-1';
const NEW_PASSWORD = 'gateway-password-2';
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
  await run({ auth, baseUrl, reached });
  await new Promise((resolve) => server.close(resolve));
};

describe('operator authentication is off by default', () => {
  it('does not throw when no password file exists', () => {
    assert.doesNotThrow(() => createOperatorAuth({}));
    assert.equal(createOperatorAuth({}).isRequired(), false);
  });

  it('lets unauthenticated requests through when no password is configured', async () => {
    await withServer({ authFile: tmpAuthFile(), readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const session = await fetch(`${baseUrl}/api/auth/session`).then((r) => r.json());
      assert.equal(session.required, false);
      assert.equal(session.authenticated, true);

      const providerResponse = await fetch(`${baseUrl}/api/providers`);
      const runResponse = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(providerResponse.status, 200);
      assert.equal(runResponse.status, 202);
      assert.deepEqual(reached, { providers: 1, runs: 1 });
    });
  });

  it('does not guard Socket.IO when auth is off', async () => {
    const auth = createOperatorAuth({});
    const error = await new Promise((resolve) => {
      auth.socketMiddleware({ handshake: { headers: {}, auth: {} } }, (err) => resolve(err));
    });
    assert.equal(error, undefined);
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

  it('clears the panel password from disk and opens the gateway again', async () => {
    const authFile = tmpAuthFile();
    await withServer({ authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
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
      assert.equal((await cleared.json()).required, false);
      assert.equal(fs.existsSync(authFile), false);
      assert.equal((await fetch(`${baseUrl}/api/providers`)).status, 200);
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
      assert.deepEqual(await session.json(), { authenticated: true, required: true });
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
        body: JSON.stringify({ password: NEW_PASSWORD }),
      });
      assert.equal(changed.status, 200);
      const newCookie = changed.headers.get('set-cookie').split(';')[0];

      const revoked = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: oldCookie },
      });
      assert.deepEqual(await revoked.json(), { authenticated: false, required: true });

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

describe('operator password length', () => {
  it('exports the panel minimum', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
  });

  it('keeps browser sessions for 30 days', () => {
    assert.equal(SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  });
});
