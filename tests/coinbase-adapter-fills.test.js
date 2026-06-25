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
// getOrderFills() signs a JWT with an EC private key before calling fetch, so
// the test writes a freshly-generated prime256v1 key to a temp keys file and
// mocks global.fetch to return canned /historical/fills responses.
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

/**
 * Install a global.fetch mock that records each request and returns a canned
 * response. Accepts either:
 *   - a handler `(url, calls) => responseBody` so tests can drive cursor-based
 *     pagination off the query string, or
 *   - an array of raw fills, which is wrapped as `{ fills }` (single page).
 * @param {((url: URL, calls: URL[]) => any) | any[]} handlerOrFills
 * @returns {{calls: URL[]}}
 */
const installFetchMock = (handlerOrFills) => {
  const calls = [];
  const handler = typeof handlerOrFills === 'function'
    ? handlerOrFills
    : () => ({ fills: handlerOrFills });
  global.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const body = handler(parsed, calls);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { calls };
};

const makeFill = (tradeId, size, overrides = {}) => ({
  trade_id: String(tradeId),
  order_id: 'ORDER-1',
  product_id: 'BTC-USDC',
  side: 'BUY',
  price: '50000.00',
  size: String(size),
  size_in_quote: false,
  commission: '0.10',
  trade_time: '2026-06-24T00:00:00Z',
  liquidity_indicator: 'MAKER',
  ...overrides,
});

beforeEach(() => {
  // Generate a real EC P-256 key so the ES256 JWT signing in auth.js succeeds.
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

describe('coinbase getOrderFills pagination', () => {
  it('accumulates fills across every cursor page', async () => {
    const adapter = createCoinbaseAdapter(keysPath);

    // Three pages of 2 fills each; the final page signals end via has_next: false.
    const pages = {
      '': { fills: [makeFill(1, 0.1), makeFill(2, 0.2)], cursor: 'CUR1', has_next: true },
      'CUR1': { fills: [makeFill(3, 0.3), makeFill(4, 0.4)], cursor: 'CUR2', has_next: true },
      // Final page echoes a non-empty cursor but has_next: false — must still terminate.
      'CUR2': { fills: [makeFill(5, 0.5), makeFill(6, 0.6)], cursor: 'CUR3', has_next: false },
    };

    const { calls } = installFetchMock((url) => {
      const cursor = url.searchParams.get('cursor') || '';
      assert.equal(url.searchParams.get('order_id'), 'ORDER-1');
      assert.ok(url.searchParams.get('limit'), 'limit param must be sent');
      return pages[cursor];
    });

    const fills = await adapter.getOrderFills('ORDER-1');

    assert.equal(calls.length, 3, 'should request all three pages');
    assert.equal(fills.length, 6, 'should accumulate fills from every page');
    assert.deepEqual(fills.map(f => f.tradeId), ['1', '2', '3', '4', '5', '6']);
    // totalSize-style sum must reflect every page, not just the first.
    const totalSize = fills.reduce((sum, f) => sum + f.size, 0);
    assert.ok(Math.abs(totalSize - 2.1) < 1e-9, `expected 2.1, got ${totalSize}`);
  });

  it('returns a single page unchanged when there is no further cursor', async () => {
    const adapter = createCoinbaseAdapter(keysPath);

    const { calls } = installFetchMock(() => ({
      fills: [makeFill(1, 0.1)],
      cursor: '',
    }));

    const fills = await adapter.getOrderFills('ORDER-1');

    assert.equal(calls.length, 1, 'should stop after one page');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].size, 0.1);
  });

  it('does not loop forever when the API repeats the same cursor', async () => {
    const adapter = createCoinbaseAdapter(keysPath);

    // A stuck endpoint keeps returning the same non-empty cursor with has_next: true.
    const { calls } = installFetchMock((url) => ({
      fills: [makeFill(url.searchParams.get('cursor') ? 2 : 1, 0.1)],
      cursor: 'STUCK',
      has_next: true,
    }));

    const fills = await adapter.getOrderFills('ORDER-1');

    // First page (no cursor) → STUCK, second page (cursor=STUCK) repeats STUCK → stop.
    assert.equal(calls.length, 2, 'should break once the cursor repeats');
    assert.equal(fills.length, 2);
  });
});

describe('coinbase getOrderFills size_in_quote handling (issue #148)', () => {
  it('converts quote-denominated size to base when size_in_quote is true', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([
      {
        trade_id: 't1',
        order_id: 'o1',
        product_id: 'BTC-USDC',
        side: 'BUY',
        price: '50000',
        size: '500',        // 500 USDC notional
        size_in_quote: true, // boolean flag -> size is in quote currency
        commission: '2.5',
        trade_time: '2026-06-24T00:00:00Z',
        liquidity_indicator: 'TAKER',
      },
    ]);

    const [fill] = await adapter.getOrderFills('o1');

    // 500 USDC / 50000 = 0.01 BTC base
    assert.equal(fill.size, 0.01);
    // quote notional preserved
    assert.equal(fill.sizeInQuote, 500);
    // never NaN (the old parseFloat(true) bug)
    assert.ok(!Number.isNaN(fill.size));
    assert.ok(!Number.isNaN(fill.sizeInQuote));
  });

  it('treats size as base currency when size_in_quote is false', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([
      {
        trade_id: 't2',
        order_id: 'o2',
        product_id: 'BTC-USDC',
        side: 'SELL',
        price: '50000',
        size: '0.02',        // already base currency
        size_in_quote: false,
        commission: '1.0',
        trade_time: '2026-06-24T01:00:00Z',
        liquidity_indicator: 'MAKER',
      },
    ]);

    const [fill] = await adapter.getOrderFills('o2');

    assert.equal(fill.size, 0.02);
    // quote notional = price * base
    assert.equal(fill.sizeInQuote, 1000);
  });

  it('handles the string "true" form of size_in_quote', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock([
      {
        trade_id: 't3',
        order_id: 'o3',
        product_id: 'ETH-USDC',
        side: 'BUY',
        price: '2000',
        size: '400',
        size_in_quote: 'true',
        trade_time: '2026-06-24T02:00:00Z',
      },
    ]);

    const [fill] = await adapter.getOrderFills('o3');

    assert.equal(fill.size, 0.2); // 400 / 2000
    assert.equal(fill.sizeInQuote, 400);
  });
});
