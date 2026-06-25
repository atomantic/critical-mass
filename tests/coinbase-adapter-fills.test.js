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
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

/**
 * Install a global.fetch mock that records each request and returns whatever
 * the handler produces. The handler receives the parsed URL so tests can drive
 * cursor-based pagination off the query string.
 * @param {(url: URL, calls: URL[]) => any} handler Returns the JSON response body.
 * @returns {{calls: URL[]}}
 */
const installFetchMock = (handler) => {
  const calls = [];
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

    // Three pages of 2 fills each; the final page returns an empty-string cursor.
    const pages = {
      '': { fills: [makeFill(1, 0.1), makeFill(2, 0.2)], cursor: 'CUR1' },
      'CUR1': { fills: [makeFill(3, 0.3), makeFill(4, 0.4)], cursor: 'CUR2' },
      'CUR2': { fills: [makeFill(5, 0.5), makeFill(6, 0.6)], cursor: '' },
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
});
