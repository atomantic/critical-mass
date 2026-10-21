// @ts-check
/**
 * When portos-ai-toolkit cannot be imported, the AI pages must get an
 * actionable 503 instead of falling through to the API catch-all's 404.
 */
const { it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const mountAiRoutes = require('../src/routes/ai-routes');

it('answers the AI toolkit routes with an actionable 503 when the toolkit fails to load', async () => {
  const app = express();
  await mountAiRoutes(app, { io: null }, { loadToolkit: () => Promise.reject(new Error('Cannot find package')) });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const address = /** @type {import('net').AddressInfo} */ (server.address());
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of ['/api/providers', '/api/runs/abc']) {
      const res = await fetch(`${base}${route}`);
      assert.equal(res.status, 503, route);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /AI toolkit failed to load/);
    }
    assert.equal((await fetch(`${base}/api/other`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
