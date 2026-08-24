const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createOperatorAuth, MIN_PASSWORD_LENGTH } = require('../src/operator-auth');
const { readJSON, writeJSON } = require('../src/shared-utils');

const OPERATOR_TOKEN = 'test-operator-token-with-at-least-32-chars';
const tmpFiles = [];

const tmpAuthFile = () => {
  const file = path.join(os.tmpdir(), `operator-auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(file);
  return file;
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
  it('does not throw when OPERATOR_TOKEN is missing', () => {
    assert.doesNotThrow(() => createOperatorAuth({ operatorToken: '' }));
    assert.equal(createOperatorAuth({ operatorToken: '' }).isRequired(), false);
  });

  it('lets unauthenticated requests through when no password is configured', async () => {
    await withServer({ operatorToken: '' }, async ({ baseUrl, reached }) => {
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
    const auth = createOperatorAuth({ operatorToken: '' });
    const error = await new Promise((resolve) => {
      auth.socketMiddleware({ handshake: { headers: {}, auth: {} } }, (err) => resolve(err));
    });
    assert.equal(error, undefined);
  });
});

describe('operator password set from the admin panel', () => {
  it('turns on auth after PUT /api/auth/password and accepts the new password', async () => {
    const authFile = tmpAuthFile();
    await withServer({ operatorToken: '', authFile, readJSON, writeJSON }, async ({ baseUrl, reached }) => {
      const tooShort = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'short' }),
      });
      assert.equal(tooShort.status, 400);

      const set = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'gateway-password-1' }),
      });
      assert.equal(set.status, 200);
      const cookie = set.headers.get('set-cookie').split(';')[0];

      const blocked = await fetch(`${baseUrl}/api/providers`);
      assert.equal(blocked.status, 401);
      assert.equal(reached.providers, 0);

      const allowed = await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: cookie } });
      assert.equal(allowed.status, 200);

      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'gateway-password-1' }),
      });
      assert.equal(login.status, 200);
    });
  });

  it('clears the panel password and opens the gateway again', async () => {
    const authFile = tmpAuthFile();
    await withServer({ operatorToken: '', authFile, readJSON, writeJSON }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/api/auth/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'gateway-password-1' }),
      });
      const cleared = await fetch(`${baseUrl}/api/auth/password`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'gateway-password-1' }),
      });
      assert.equal(cleared.status, 200);
      assert.equal((await cleared.json()).required, false);
      assert.equal((await fetch(`${baseUrl}/api/providers`)).status, 200);
    });
  });
});

describe('operator authentication boundary', () => {
  it('prevents unauthenticated requests from reaching provider and run handlers', async () => {
    await withServer({ operatorToken: OPERATOR_TOKEN }, async ({ baseUrl, reached }) => {
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
    await withServer({ operatorToken: OPERATOR_TOKEN }, async ({ baseUrl, reached }) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: OPERATOR_TOKEN }),
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

  it('accepts bearer auth and rejects cross-origin session mutations', async () => {
    await withServer({ operatorToken: OPERATOR_TOKEN }, async ({ baseUrl, reached }) => {
      const bearerResponse = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(bearerResponse.status, 202);

      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: OPERATOR_TOKEN }),
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

  it('guards Socket.IO handshakes with the same credentials', async () => {
    const auth = createOperatorAuth({ operatorToken: OPERATOR_TOKEN });
    const invoke = (headers = {}, handshakeAuth = {}) => new Promise((resolve) => {
      auth.socketMiddleware({ handshake: { headers, auth: handshakeAuth } }, (error) => resolve(error));
    });
    assert.equal((await invoke())?.data?.code, 'UNAUTHORIZED');
    assert.equal(await invoke({}, { token: OPERATOR_TOKEN }), undefined);
  });
});

describe('operator password length', () => {
  it('exports the panel minimum', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
  });
});
