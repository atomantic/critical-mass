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
  it('GET /api/coinbase/candles with invalid granularity returns 400, not 502', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/exchange-routes')(app, { readJSON: () => ({}) });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&granularity=NOPE`);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /granularity/i);
    } finally {
      await close(server);
    }
  });

  it('GET /api/coinbase/candles with invalid limit (abc) returns 400, not 502', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/exchange-routes')(app, { readJSON: () => ({}) });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&limit=abc`);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /limit/i);
    } finally {
      await close(server);
    }
  });

  it('GET /api/coinbase/candles with limit=0 returns 400', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/exchange-routes')(app, { readJSON: () => ({}) });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&limit=0`);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /limit/i);
    } finally {
      await close(server);
    }
  });

  it('GET /api/coinbase/candles with limit=351 (exceeds cap) returns 400', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/exchange-routes')(app, { readJSON: () => ({}) });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&limit=351`);
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /limit/i);
    } finally {
      await close(server);
    }
  });

  it('GET /api/coinbase/candles with granularity=ONE_MINUTE&limit=60 does not reject at validation layer', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/exchange-routes')(app, { readJSON: () => ({}) });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/candles?pair=BTC-USDC&granularity=ONE_MINUTE&limit=60`);
      // Should not be 400 from validation (might be 500/502 from adapter, but not 400 from validation)
      assert.notEqual(res.status, 400, 'should not reject valid granularity and limit with 400');
    } finally {
      await close(server);
    }
  });

  it('POST /api/coinbase/regime/force-regime with non-string regime returns 400, not 500', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/regime-routes')(app, {
      getIPC: () => ({ request: () => Promise.resolve({ success: true }) }),
      readJSON: () => ({ configs: {} }),
    });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/regime/force-regime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regime: 5 }),
      });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /regime/i);
    } finally {
      await close(server);
    }
  });

  it('POST /api/coinbase/regime/force-regime with object regime returns 400, not 500', async () => {
    const app = express();
    app.use(express.json());
    require('../src/routes/regime-routes')(app, {
      getIPC: () => ({ request: () => Promise.resolve({ success: true }) }),
      readJSON: () => ({ configs: {} }),
    });
    app.use((err, req, res, next) => errorMiddleware(err, req, res, next));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/coinbase/regime/force-regime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regime: {} }),
      });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /regime/i);
    } finally {
      await close(server);
    }
  });
});

process.on('exit', () => {
  for (const file of tmpFiles) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
});
