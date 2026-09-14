// @ts-check
/**
 * Regression tests for issue #530 — route rejections must reach the caller
 * as JSON (never Express's built-in HTML final handler, which leaks a stack
 * trace and the install's filesystem path), and the pre-auth rate-limit
 * path (src/operator-auth.js) must return JSON with a Retry-After header.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { errorMiddleware } = require('../src/error-middleware');
const { asyncRoute } = require('../src/routes/route-utils');
const { createOperatorAuth } = require('../src/operator-auth');
const { readJSON, writeJSON } = require('../src/shared-utils');

const PASSWORD = 'gateway-password-1';

const tmpFiles = [];
const tmpAuthFile = () => {
  const file = path.join(os.tmpdir(), `route-error-handling-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
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

const listen = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const close = (server) => new Promise((resolve) => server.close(resolve));

const withNodeEnv = async (value, run) => {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
};

// Real app-shaped registration: a throwing dependency wrapped with the
// asyncRoute helper (src/routes/route-utils.js), same as the 14 handlers
// fixed by #530, feeding the same error middleware server.js registers.
const buildThrowingApp = (buildError) => {
  const app = express();
  app.get('/api/boom', asyncRoute(async () => {
    throw buildError();
  }));
  app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
  return app;
};

describe('route error handling (issue #530)', () => {
  it('returns application/json with a { success: false, error } body when a route dependency throws, regardless of NODE_ENV', async () => {
    for (const nodeEnv of [undefined, 'development', 'production']) {
      await withNodeEnv(nodeEnv, async () => {
        const app = buildThrowingApp(() => new Error(
          `adapter exploded at /Users/operator/critical-mass/src/adapters/coinbase/api.js:83`
        ));
        const { server, baseUrl } = await listen(app);
        try {
          const res = await fetch(`${baseUrl}/api/boom`);
          assert.equal(res.status, 500, `status for NODE_ENV=${nodeEnv}`);
          assert.match(res.headers.get('content-type') || '', /application\/json/);
          const body = await res.json();
          assert.deepStrictEqual(body, { success: false, error: 'Internal server error — see engine logs' });
          // Never a stack frame, a node_modules reference, or a filesystem path.
          assert.doesNotMatch(body.error, / at /);
          assert.doesNotMatch(body.error, /node_modules/);
          assert.doesNotMatch(body.error, /\//);
          assert.doesNotMatch(body.error, /\\/);
        } finally {
          await close(server);
        }
      });
    }
  });

  it('relays the thrown message for a client error (status < 500) instead of masking it', async () => {
    const app = buildThrowingApp(() => Object.assign(new Error('intentId is required'), { status: 400 }));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/boom`);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      assert.deepStrictEqual(await res.json(), { success: false, error: 'intentId is required' });
    } finally {
      await close(server);
    }
  });

  it('falls back to 500 when an adapter sets a non-numeric err.status (e.g. "network"/"unknown")', async () => {
    const app = buildThrowingApp(() => Object.assign(new Error('Coinbase API network error: socket hang up'), { status: 'network' }));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/boom`);
      assert.equal(res.status, 500);
      assert.deepStrictEqual(await res.json(), { success: false, error: 'Internal server error — see engine logs' });
    } finally {
      await close(server);
    }
  });

  it('copies err.headers onto the response (e.g. Retry-After) before responding', async () => {
    const app = buildThrowingApp(() => Object.assign(new Error('busy'), { status: 429, headers: { 'Retry-After': '1' } }));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/boom`);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '1');
      assert.deepStrictEqual(await res.json(), { success: false, error: 'busy' });
    } finally {
      await close(server);
    }
  });

  it('does not double-respond when headers are already sent (delegates to next(err))', async () => {
    const app = express();
    app.get('/api/partial', asyncRoute(async (req, res) => {
      res.status(200).json({ success: true });
      throw new Error('failure after response already sent');
    }));
    // Express's default final handler will receive this via `next(err)` since
    // headersSent is true — verifying errorMiddleware doesn't itself crash by
    // calling res.status()/res.json() a second time.
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/partial`);
      assert.equal(res.status, 200);
      assert.deepStrictEqual(await res.json(), { success: true });
    } finally {
      await close(server);
    }
  });

  it('asyncRoute forwards a rejected/thrown handler to next(err) instead of hanging or throwing unhandled', async () => {
    const errors = [];
    const next = (err) => errors.push(err);
    const handler = asyncRoute(async () => {
      throw new Error('boom');
    });
    handler({}, {}, next);
    // Let the microtask queue flush the rejection into next().
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'boom');
  });

  describe('pre-auth rate-limit path (requireAuth / operator-auth.js)', () => {
    it('returns 429 JSON with a Retry-After header when requireAuth hits a busy KDF, instead of an unhandled rejection or HTML', async () => {
      const authFile = tmpAuthFile();
      seedPassword(authFile);
      const original = crypto.scrypt;
      let release;
      let started;
      const hashing = new Promise((resolve) => { started = resolve; });
      const scryptMock = (...args) => {
        release = () => original(...args);
        started();
      };
      const realScrypt = crypto.scrypt;
      crypto.scrypt = scryptMock;

      const auth = createOperatorAuth({ authFile, readJSON, writeJSON });
      const app = express();
      app.use(express.json());
      auth.registerSessionRoutes(app);
      app.use('/api', auth.requireAuth);
      app.get('/api/protected', (req, res) => res.json({ success: true }));
      app.use((err, req, res, next) => errorMiddleware(err, req, res, next));

      const { server, baseUrl } = await listen(app);
      try {
        // First Bearer-authenticated request starts hashing and hangs there;
        // the second reaches requireAuth's unguarded `await authenticate()`
        // while hashBusy is true — this must forward to the JSON error
        // middleware (Express 5 auto-catches the rejected async middleware),
        // not fall through to the built-in HTML handler.
        const first = fetch(`${baseUrl}/api/protected`, { headers: { Authorization: `Bearer ${PASSWORD}` } });
        await hashing;
        try {
          const second = await fetch(`${baseUrl}/api/protected`, { headers: { Authorization: `Bearer ${PASSWORD}` } });
          assert.equal(second.status, 429);
          assert.match(second.headers.get('content-type') || '', /application\/json/);
          assert.equal(second.headers.get('retry-after'), '1');
          const body = await second.json();
          assert.equal(body.success, false);
          assert.equal(typeof body.error, 'string');
          assert.doesNotMatch(body.error, /</); // no HTML markup leaked
        } finally {
          release();
        }
        assert.equal((await first).status, 200);
      } finally {
        crypto.scrypt = realScrypt;
        await close(server);
      }
    });
  });
});

describe('malformed request bodies and query params return 400 (issue #570)', () => {
  // Mount one real route module on a throwaway express app behind the JSON error
  // middleware, so an unguarded `req.body` surfaces the way it does in production
  // (Express 5 leaves `req.body` undefined when no JSON body is sent).
  const withRoutes = async (moduleName, deps, run) => {
    const app = express();
    app.use(express.json());
    require(`../src/routes/${moduleName}`)(app, deps);
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      await run(baseUrl);
    } finally {
      await close(server);
    }
  };

  const exchangeDeps = { readJSON: () => ({}) };
  const updownDeps = {
    updownService: { setPosition: () => {}, setContract: () => {}, getState: () => ({}) },
    candleCache: {},
    readJSON: () => ({}),
    writeJSON: () => {},
    DATA_DIR: os.tmpdir(),
  };
  const legacyDeps = { parseTSV: () => [], calculateCostBasis: () => ({}), getNextTradeInfo: () => ({}) };

  const expect400 = async (res, pattern) => {
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, pattern);
  };

  describe('GET /api/:exchange/candles query validation', () => {
    for (const [label, query, pattern] of [
      ['invalid granularity', 'granularity=NOPE', /granularity/i],
      ['non-numeric limit', 'limit=abc', /limit/i],
      ['limit=0', 'limit=0', /limit/i],
      ['limit above the 350 cap', 'limit=351', /limit/i],
    ]) {
      it(`${label} returns 400, not 502`, async () => {
        await withRoutes('exchange-routes', exchangeDeps, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&${query}`);
          await expect400(res, pattern);
        });
      });
    }

    it('the granularity+limit the dashboard sends is not rejected', async () => {
      await withRoutes('exchange-routes', exchangeDeps, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&granularity=ONE_MINUTE&limit=60`);
        assert.notEqual(res.status, 400, 'valid granularity and limit must reach the adapter');
      });
    });
  });

  describe('GET /api/updown/scorecard-analysis date validation', () => {
    for (const [label, query] of [
      ['unparseable from', 'from=garbage'],
      ['unparseable to', 'to=not-a-date'],
      ['well-formed but impossible from', 'from=2026-13-45'],
    ]) {
      it(`${label} returns 400, not 500`, async () => {
        await withRoutes('updown-routes', updownDeps, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/api/updown/scorecard-analysis?${query}`);
          await expect400(res, /from|to/i);
        });
      });
    }
  });

  describe('POST /api/:exchange/regime/force-regime regime typing', () => {
    for (const [label, payload] of [
      ['a numeric regime', { regime: 5 }],
      ['an object regime', { regime: {} }],
    ]) {
      it(`${label} returns 400, not 500`, async () => {
        await withRoutes('regime-routes', {}, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/api/coinbase/regime/force-regime?pair=BTC-USDC`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          await expect400(res, /regime/i);
        });
      });
    }
  });

  describe('an absent or non-JSON body never reaches the error boundary', () => {
    // `req.body` is genuinely `undefined` for both shapes below — no
    // `body: {}` harness default can stand in for them (that is what let this
    // whole class of 500 ship unnoticed).
    const bodylessRequests = [
      ['no body at all', {}],
      ['a non-JSON Content-Type', { headers: { 'Content-Type': 'text/plain' }, body: 'not json' }],
    ];

    /** Endpoints whose own required-field check should now produce its documented 400. */
    const documented400 = [
      ['keys-routes', {}, 'POST', '/api/coinbase/keys', /required/i],
      ['keys-routes', {}, 'PUT', '/api/coinbase/keys', /required/i],
      ['regime-routes', {}, 'POST', '/api/coinbase/regime/force-regime?pair=BTC-USDC', /regime/i],
      ['regime-routes', {}, 'POST', '/api/coinbase/regime/dismiss-fills?pair=BTC-USDC', /orderIds/i],
      ['updown-routes', updownDeps, 'PUT', '/api/updown/position', /required/i],
      ['updown-routes', updownDeps, 'POST', '/api/updown/trades', /required/i],
    ];

    for (const [moduleName, deps, method, route, pattern] of documented400) {
      for (const [shape, init] of bodylessRequests) {
        it(`${method} ${route.split('?')[0]} with ${shape} returns its documented 400`, async () => {
          const routeDeps = moduleName === 'keys-routes' ? { writeJSON: () => {} } : deps;
          await withRoutes(moduleName, routeDeps, async (baseUrl) => {
            const res = await fetch(`${baseUrl}${route}`, { method, ...init });
            await expect400(res, pattern);
          });
        });
      }
    }

    /**
     * These two have no documented 400 for an empty body — a body with neither
     * toggle is a no-op today (tightening that is issue #569). What must never
     * happen is the TypeError-driven 500.
     */
    const neverFivexx = [
      ['exchange-routes', exchangeDeps, 'PATCH', '/api/coinbase/config?pair=BTC-USDC'],
      ['legacy-routes', legacyDeps, 'PATCH', '/api/config'],
      ['updown-routes', updownDeps, 'PUT', '/api/updown/contract'],
    ];

    for (const [moduleName, deps, method, route] of neverFivexx) {
      for (const [shape, init] of bodylessRequests) {
        it(`${method} ${route.split('?')[0]} with ${shape} never returns 5xx`, async () => {
          await withRoutes(moduleName, deps, async (baseUrl) => {
            const res = await fetch(`${baseUrl}${route}`, { method, ...init });
            assert.ok(res.status < 500, `expected a client-side status, got ${res.status}`);
            assert.match(res.headers.get('content-type') || '', /application\/json/);
          });
        });
      }
    }
  });
});
