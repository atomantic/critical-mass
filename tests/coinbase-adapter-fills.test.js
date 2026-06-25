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

const installFetchMock = (fills) => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ fills }),
    };
  };
  return { calls };
};

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  keysPath = path.join(os.tmpdir(), `coinbase-test-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test', privateKey }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
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
