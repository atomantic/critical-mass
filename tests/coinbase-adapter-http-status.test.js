// @ts-check
// Pins the Coinbase REST client behavior for HTTP 429 / 5xx responses: GETs
// are retried (429/502/503/504, 2 retries, per-attempt signing — #1621) and
// then surface the final status; order POSTs are never retried (5xx is
// ambiguous, 429 definite). A change to the retry policy must update these
// deliberately.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

let keysPath;
let originalFetch;

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  keysPath = path.join(os.tmpdir(), `coinbase-http-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (keysPath && fs.existsSync(keysPath)) fs.unlinkSync(keysPath);
});

/**
 * Mock fetch to answer every request with a non-2xx status.
 * @param {number} status
 * @param {string} statusText
 * @param {object} body
 * @param {Record<string, string>} [headers]
 * @param {(url: URL) => boolean} [only] limit the failing response to matching URLs
 */
const installStatusMock = (status, statusText, body, headers = {}, only = () => true) => {
  const calls = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (!only(parsed)) throw new Error(`unexpected endpoint ${parsed.pathname}`);
    return {
      ok: false,
      status,
      statusText,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  return { calls };
};

const stubProductDetails = (adapter) => {
  adapter.getProductDetails = async () => ({
    baseIncrement: '0.00000001',
    quoteIncrement: '0.01',
    baseMinSize: '0.00001',
    quoteMinSize: '0.1',
    price: 50000,
  });
};

describe('coinbase HTTP 429 / 5xx handling on GET requests', () => {
  for (const [status, statusText, message] of [
    [429, 'Too Many Requests', 'rate limit exceeded'],
    [503, 'Service Unavailable', 'upstream unavailable'],
  ]) {
    it(`retries the GET twice on HTTP ${status}, then surfaces status/endpoint/message`, async () => {
      const delays = [];
      const adapter = createCoinbaseAdapter(keysPath, { sleep: async (ms) => { delays.push(ms); }, random: () => 0 });
      const { calls } = installStatusMock(status, statusText, { message }, { 'retry-after': '1' });

      await assert.rejects(
        () => adapter.getCurrentPrice('BTC-USDC'),
        (err) => {
          assert.equal(err.status, status);
          assert.equal(err.endpoint, 'GET /api/v3/brokerage/products/BTC-USDC');
          assert.equal(err.message, `Coinbase API ${status}: ${message}`);
          assert.equal(err.unknownOutcome, undefined);
          return true;
        },
      );
      assert.equal(calls.length, 3, 'one attempt plus HTTP_RETRY_MAX (2) retries');
      assert.deepEqual(delays, [1000, 2000], 'exponential backoff (Retry-After: 1s never lowers it)');
    });
  }

  it('falls back to statusText when the error body has no message', async () => {
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    installStatusMock(503, 'Service Unavailable', {});
    await assert.rejects(
      () => adapter.getCurrentPrice('BTC-USDC'),
      (err) => err.status === 503 && err.message === 'Coinbase API 503: Service Unavailable',
    );
  });
});

describe('coinbase HTTP 429 / 5xx handling on order POSTs', () => {
  const isOrders = (url) => url.pathname === '/api/v3/brokerage/orders';

  for (const [label, place] of [
    ['placeLimitBuy', (a) => a.placeLimitBuy('BTC-USDC', 0.001, 50000, { clientOrderId: 'coid-buy-1' })],
    ['placeLimitSell', (a) => a.placeLimitSell('BTC-USDC', 0.001, 50000, { clientOrderId: 'coid-sell-1' })],
  ]) {
    it(`${label}: 429 is a definite rejection (numeric status), attempted once`, async () => {
      const adapter = createCoinbaseAdapter(keysPath);
      stubProductDetails(adapter);
      const { calls } = installStatusMock(429, 'Too Many Requests', { message: 'slow down' }, { 'retry-after': '1' }, isOrders);

      await assert.rejects(
        () => place(adapter),
        (err) => err.status === 429 && err.unknownOutcome === undefined && err.endpoint === 'POST /api/v3/brokerage/orders'
          && /Coinbase API 429: slow down/.test(err.message),
      );
      assert.equal(calls.length, 1, 'order POST attempted exactly once');
    });

    it(`${label}: 503 is an ambiguous placement (status:unknown) carrying the client order id, attempted once`, async () => {
      const adapter = createCoinbaseAdapter(keysPath);
      stubProductDetails(adapter);
      const { calls } = installStatusMock(503, 'Service Unavailable', { message: 'down' }, {}, isOrders);

      await assert.rejects(
        () => place(adapter),
        (err) => {
          assert.equal(err.status, 'unknown');
          assert.equal(err.unknownOutcome, true);
          assert.match(err.clientOrderId, /^coid-(buy|sell)-1$/);
          assert.match(err.message, /HTTP 503/);
          assert.match(err.message, /reconcile/i);
          return true;
        },
      );
      assert.equal(calls.length, 1, 'order POST attempted exactly once');
    });
  }

  it('a non-placement POST (cancelOrder) receiving 503 is a plain definite error, not retried', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installStatusMock(503, 'Service Unavailable', { message: 'down' });
    await assert.rejects(
      () => adapter.cancelOrder('ORDER-1'),
      (err) => err.status === 503 && err.unknownOutcome === undefined && /batch_cancel/.test(err.endpoint),
    );
    assert.equal(calls.length, 1);
  });
});
