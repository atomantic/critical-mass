const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { createOperatorAuth } = require('../src/operator-auth');

const OPERATOR_TOKEN = 'test-operator-token-with-at-least-32-chars';

const withServer = async (run) => {
  const app = express();
  const auth = createOperatorAuth({ operatorToken: OPERATOR_TOKEN });
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

describe('operator authentication boundary', () => {
  it('prevents unauthenticated requests from reaching provider and run handlers', async () => {
    await withServer(async ({ baseUrl, reached }) => {
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
    await withServer(async ({ baseUrl, reached }) => {
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
    await withServer(async ({ baseUrl, reached }) => {
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
