// @ts-check
/**
 * Route tests for issue #534 — POST /api/updown/restart must verify PM2
 * manages the process before responding success, and log the outcome.
 */
const { describe, it } = require('node:test');
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
  it('responds 202 when PM2 pre-flight check succeeds', async () => {
    // `mock.method` proxies the original function, so the mock still exposes
    // real `exec`'s `util.promisify.custom` — `promisify(exec)` in the route
    // would call through to the host's pm2 and the assertion would only hold
    // on a machine that happens to have it installed. Assign a plain stub,
    // which has no custom symbol, so promisify wraps the stub itself.
    const childProcess = require('child_process');
    const realExec = childProcess.exec;
    const commands = [];
    childProcess.exec = (cmd, callback) => {
      commands.push(cmd);
      callback(null, cmd.includes('pm2 describe') ? '{"name": "critical-mass"}' : 'restarted', '');
    };

    try {
      // Clear cache and load routes with the stubbed exec
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
      assert.ok(commands.some(cmd => cmd.includes('pm2 describe')), 'pre-flight check ran through the stub');
    } finally {
      childProcess.exec = realExec;
      delete require.cache[require.resolve('../src/routes/updown-routes')];
    }
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
