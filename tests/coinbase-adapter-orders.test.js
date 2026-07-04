// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
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
