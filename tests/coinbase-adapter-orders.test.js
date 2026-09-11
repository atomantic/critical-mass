// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

// ---------------------------------------------------------------------------
// Test harness
//
// The adapter signs a JWT with an EC private key before calling fetch, so the
// test writes a freshly-generated prime256v1 key to a temp keys file and mocks
// global.fetch. Unlike the fills harness, this one can also simulate a network
// error (fetch throws) to exercise the retry/idempotency gate (issue #199).
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

/**
 * Mock global.fetch. `handler(url, calls)` returns a response body (wrapped as
 * ok:200), or may throw to simulate a network failure.
 * @param {(url: URL, calls: URL[]) => any} handler
 * @returns {{calls: URL[]}}
 */
const installFetchMock = (handler) => {
  const calls = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const body = handler(parsed, calls); // may throw
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { calls };
};

const networkError = (msg = 'socket disconnected', code = 'ECONNRESET') =>
  Object.assign(new Error(msg), { code });

// Lets any already-queued microtasks (e.g. a stubbed getProductDetails()
// resolving) drain before advancing mock timers — `mock.timers.tick()` is
// synchronous and does not itself flush the microtask queue, so a request
// path with an extra `await` before it reaches `setTimeout` (placeLimitBuy/
// placeLimitSell first await getProductDetails) needs this or the abort
// timer for that attempt may not be registered yet when tick() runs.
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Mock global.fetch with a response whose body-read (`.json()`) never settles
 * on its own — it hangs until the request's AbortSignal fires, mirroring a
 * real stalled/reset connection during body consumption. Real Node fetch
 * aborts an in-flight body read when its signal fires (used by the Gemini and
 * Crypto.com adapters' body reads, which the fix mirrors — issue #428); this
 * mock reproduces exactly that observable behavior without a live socket.
 * `signal.aborted` is checked synchronously so it also settles correctly if
 * the timer already fired before `.json()` is even called.
 * @param {{ok?: boolean, status?: number, statusText?: string}} [shape]
 * @returns {{calls: URL[]}}
 */
const installStallingBodyFetchMock = (shape = {}) => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(new URL(url));
    const signal = options.signal;
    const stall = () => new Promise((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    return {
      ok: shape.ok !== false,
      status: shape.status || 200,
      statusText: shape.statusText || 'OK',
      json: stall,
    };
  };
  return { calls };
};

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  keysPath = path.join(os.tmpdir(), `coinbase-test-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (keysPath && fs.existsSync(keysPath)) fs.unlinkSync(keysPath);
});

// ---------------------------------------------------------------------------
// #199 — order-placement POSTs are not blind-retried on a network error
// ---------------------------------------------------------------------------

describe('coinbase order-placement network-error handling (issue #199)', () => {
  it('does NOT retry a market-buy POST on a network error and surfaces status:unknown', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installFetchMock(() => { throw networkError(); });

    await assert.rejects(
      () => adapter.placeMarketBuy('BTC-USDC', 100),
      (err) => err.status === 'unknown' && err.unknownOutcome === true && /reconcile/i.test(err.message)
    );
    // Exactly one attempt — no blind retry that could double-place.
    assert.equal(calls.length, 1, 'order POST must be attempted exactly once');
  });

  it('does NOT retry a limit-buy POST on a network error (status:unknown)', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    // Stub product details so placeLimitBuy reaches the order POST.
    adapter.getProductDetails = async () => ({
      baseIncrement: '0.00000001',
      quoteIncrement: '0.01',
      baseMinSize: '0.00001',
      quoteMinSize: '0.1',
      price: 50000,
    });
    let orderPosts = 0;
    global.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v3/brokerage/orders') {
        orderPosts++;
        throw networkError('ETIMEDOUT', 'ETIMEDOUT');
      }
      throw new Error(`unexpected endpoint ${parsed.pathname}`);
    };

    await assert.rejects(
      () => adapter.placeLimitBuy('BTC-USDC', 0.001, 50000),
      (err) => err.status === 'unknown' && err.unknownOutcome === true
    );
    assert.equal(orderPosts, 1, 'order POST must be attempted exactly once');
  });

  it('a non-order POST (batch_cancel) is not retried and reports a plain network error', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installFetchMock(() => { throw networkError(); });

    await assert.rejects(
      () => adapter.cancelOrder('ORDER-1'),
      (err) => err.status === 'network' && err.unknownOutcome === undefined
    );
    assert.equal(calls.length, 1, 'cancel POST must not be blind-retried');
  });

  it('still retries an idempotent GET on a transient network error', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    let attempts = 0;
    global.fetch = async (url) => {
      attempts++;
      if (attempts === 1) throw networkError();
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ price: '50000' }) };
    };

    const price = await adapter.getCurrentPrice('BTC-USDC');
    assert.equal(price, 50000);
    assert.equal(attempts, 2, 'GET should retry once and then succeed');
  });
});

// ---------------------------------------------------------------------------
// #428 — the abort deadline stays armed through the body read (not just the
// header phase), so a stalled/reset body on either a 2xx or non-2xx response
// is bounded by the same per-attempt timeout instead of hanging forever.
// ---------------------------------------------------------------------------

describe('coinbase response-body boundary within timeout (issue #428)', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it('aborts a stalled 2xx placement body read at the per-attempt deadline and surfaces unknownOutcome', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installStallingBodyFetchMock();

    const pending = assert.rejects(
      () => adapter.placeMarketBuy('BTC-USDC', 100),
      (err) => {
        assert.equal(err.status, 'unknown');
        assert.equal(err.unknownOutcome, true);
        assert.match(err.message, /undecodable response/);
        return true;
      }
    );

    mock.timers.tick(30000);
    await pending;

    assert.equal(calls.length, 1, 'order POST must be attempted exactly once even though the body stalled');
  });

  it('aborts a stalled 2xx placement body read on a limit sell and preserves the request client_order_id', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = createCoinbaseAdapter(keysPath);
    adapter.getProductDetails = async () => ({
      baseIncrement: '0.00000001',
      quoteIncrement: '0.01',
      baseMinSize: '0.00001',
      quoteMinSize: '0.1',
      price: 50000,
    });
    let sentClientOrderId = null;
    global.fetch = async (url, options) => {
      sentClientOrderId = JSON.parse(options.body).client_order_id;
      const signal = options.signal;
      return {
        ok: true, status: 200, statusText: 'OK',
        json: () => new Promise((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      };
    };

    const pending = assert.rejects(
      () => adapter.placeLimitSell('BTC-USDC', 0.001, 50000),
      (err) => err.unknownOutcome === true && err.clientOrderId === sentClientOrderId
    );

    await flushMicrotasks(); // let the stubbed getProductDetails() resolve first
    mock.timers.tick(30000);
    await pending;
  });

  it('aborts a stalled error-body read on a non-2xx rejection at the same deadline and keeps it a definitive (non-ambiguous) rejection', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = createCoinbaseAdapter(keysPath);
    installStallingBodyFetchMock({ ok: false, status: 400, statusText: 'Bad Request' });

    const pending = assert.rejects(
      () => adapter.placeMarketBuy('BTC-USDC', 100),
      (err) => err.status === 400 && err.unknownOutcome === undefined
    );

    mock.timers.tick(30000);
    await pending;
  });

  it('retries a GET whose success body read stalls, honoring the existing retry ceiling', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = createCoinbaseAdapter(keysPath);
    let attempts = 0;
    global.fetch = async (url, options) => {
      attempts++;
      if (attempts === 1) {
        const signal = options.signal;
        return {
          ok: true, status: 200, statusText: 'OK',
          json: () => new Promise((_resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        };
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ price: '50000' }) };
    };

    const pending = (async () => {
      const price = await adapter.getCurrentPrice('BTC-USDC');
      assert.equal(price, 50000);
    })();

    // First tick trips the stalled attempt's abort deadline; the retry loop
    // then schedules its own backoff delay (a separate mocked timer) before
    // the second attempt fires, so drain in small steps rather than one tick.
    for (let elapsed = 0; elapsed < 32000; elapsed += 1000) {
      mock.timers.tick(1000);
      await Promise.resolve();
    }
    await pending;

    assert.equal(attempts, 2, 'a stalled GET body read must retry exactly once before succeeding');
  });

  it('does not blind-retry a stalled placement POST body read into a second order (single attempt)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const adapter = createCoinbaseAdapter(keysPath);
    adapter.getProductDetails = async () => ({
      baseIncrement: '0.00000001',
      quoteIncrement: '0.01',
      baseMinSize: '0.00001',
      quoteMinSize: '0.1',
      price: 50000,
    });
    let orderPosts = 0;
    global.fetch = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v3/brokerage/orders') {
        orderPosts++;
        const signal = options.signal;
        return {
          ok: true, status: 200, statusText: 'OK',
          json: () => new Promise((_resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        };
      }
      throw new Error(`unexpected endpoint ${parsed.pathname}`);
    };

    const pending = assert.rejects(() => adapter.placeLimitBuy('BTC-USDC', 0.001, 50000));
    await flushMicrotasks(); // let the stubbed getProductDetails() resolve first
    mock.timers.tick(30000);
    await pending;

    assert.equal(orderPosts, 1, 'a stalled placement body read must never trigger a second placement POST');
  });
});
