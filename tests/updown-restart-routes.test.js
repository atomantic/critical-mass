// @ts-check
/**
 * Route tests for issue #534 — POST /api/updown/restart must verify PM2
 * manages the process before responding success, and log the outcome.
 */
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

/** Minimal express-like app that captures route handlers. */
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

/** Minimal res stub capturing the JSON payload and status code. */
const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const invoke = async (app, key, req = {}) => {
  const res = createRes();
  await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
  return res;
};

describe('POST /api/updown/restart validates PM2 process (issue #534)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('responds 202 when PM2 pre-flight check succeeds', async () => {
    // Mock exec to succeed for pm2 describe
    const childProcess = require('child_process');
    const callLog = [];
    mock.method(childProcess, 'exec', (cmd, callback) => {
      callLog.push({ cmd, type: 'exec_called' });
      if (cmd.includes('pm2 describe')) {
        callback(null, '{"name": "critical-mass"}', '');
      } else if (cmd.includes('pm2 restart')) {
        callback(null, 'restarted', '');
      }
    });

    // Clear cache and load routes with the mocked exec
    delete require.cache[require.resolve('../src/routes/updown-routes')];
    const registerUpdownRoutes = require('../src/routes/updown-routes');
    const app = createFakeApp();
    registerUpdownRoutes(app, {
      updownService: { getTradeContext: () => ({}) },
      candleCache: { getAllCandles: () => [] },
      readJSON: () => ({ trades: [], nextId: 1 }),
      writeJSON: () => {},
      DATA_DIR: '/tmp/updown-test',
    });

    const res = await invoke(app, 'POST /api/updown/restart');
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'Restarting...');
  });

  it('responds 503 when PM2 pre-flight check fails (even with real PM2)', async () => {
    // Don't mock - this test verifies the behavior when PM2 is actually not available
    // by using a non-existent process name
    const oldEnv = process.env.PM2_PROCESS_NAME;
    process.env.PM2_PROCESS_NAME = 'definitely-does-not-exist-' + Date.now();

    try {
      delete require.cache[require.resolve('../src/routes/updown-routes')];
      const registerUpdownRoutes = require('../src/routes/updown-routes');
      const app = createFakeApp();
      registerUpdownRoutes(app, {
        updownService: { getTradeContext: () => ({}) },
        candleCache: { getAllCandles: () => [] },
        readJSON: () => ({ trades: [], nextId: 1 }),
        writeJSON: () => {},
        DATA_DIR: '/tmp/updown-test',
      });

      const res = await invoke(app, 'POST /api/updown/restart');
      // This should return 503 when PM2 doesn't manage the non-existent process
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.success, false);
      assert(res.body.error);
    } finally {
      if (oldEnv === undefined) {
        delete process.env.PM2_PROCESS_NAME;
      } else {
        process.env.PM2_PROCESS_NAME = oldEnv;
      }
    }
  });
});
