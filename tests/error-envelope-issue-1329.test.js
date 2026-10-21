// @ts-check
/**
 * Regression tests for issue #1329 — UpDown trade-store failures are forwarded
 * to the shared error middleware (src/error-middleware.js) via next(err) rather
 * than answering 500 with the raw message, which embedded the trades file path.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerUpdownRoutes = require('../src/routes/updown-routes');

const createFakeApp = () => {
  const handlers = {};
  const register = (method) => (route, handler) => {
    handlers[`${method} ${route}`] = handler;
  };
  return {
    handlers,
    get: register('GET'),
    put: register('PUT'),
    patch: register('PATCH'),
    post: register('POST'),
    delete: register('DELETE'),
  };
};

describe('UpDown trade store failures reach the error middleware (#1329)', () => {
  it('GET /api/updown/trades forwards a corrupt-file error to next() and does not answer 500 itself', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-1329-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'updown-trades.json'), '{"trades": [{"id": 1, "cost": 50, "returnAmount"');
      const app = createFakeApp();
      registerUpdownRoutes(app, {
        updownService: { getTradeContext: () => ({}) },
        candleCache: { getAllCandles: () => [] },
        readJSON: (filepath, def) => {
          if (!fs.existsSync(filepath)) return def;
          return JSON.parse(fs.readFileSync(filepath, 'utf8'));
        },
        DATA_DIR: tmpDir,
        writeJSON: () => {},
      });

      let responded = null;
      /** @type {unknown[]} */
      const forwarded = [];
      const res = { status() { responded = true; return this; }, json() { responded = true; return this; } };
      await app.handlers['GET /api/updown/trades']({ body: {}, params: {}, query: {} }, res, (err) => forwarded.push(err));

      assert.equal(forwarded.length, 1, 'error should be passed to next()');
      assert.ok(forwarded[0] instanceof Error);
      assert.equal(responded, null, 'route must not write its own 500 response');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
