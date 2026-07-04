// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');

// ---------------------------------------------------------------------------
// #226 — reconcile an ambiguous 'unknown' order-POST outcome by client_order_id
//
// Two adapter-level building blocks the order-manager reconcile path relies on:
//   1. the 'unknown' error carries the deterministic client_order_id we sent;
//   2. findOrderByClientOrderId() locates that order on the exchange (or null).
// Harness mirrors coinbase-adapter-orders.test.js (real EC key, mocked fetch).
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

const installFetchMock = (handler) => {
  const calls = [];
  global.fetch = async (url, opts) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const body = handler(parsed, opts, calls); // may throw
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

describe('coinbase unknown-outcome reconciliation (issue #226)', () => {
  it('attaches the submitted client_order_id to the unknown-outcome error', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    let sentClientOrderId;
    global.fetch = async (url, opts) => {
      sentClientOrderId = JSON.parse(opts.body).client_order_id;
      throw networkError();
    };

    await assert.rejects(
      () => adapter.placeMarketBuy('BTC-USDC', 100),
      (err) => err.status === 'unknown'
        && err.unknownOutcome === true
        && typeof err.clientOrderId === 'string'
        && err.clientOrderId === sentClientOrderId
    );
  });

  it('finds an order by client_order_id and normalizes it like getOrder', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    const { calls } = installFetchMock((url) => {
      assert.equal(url.pathname, '/api/v3/brokerage/orders/historical/batch');
      assert.equal(url.searchParams.get('product_ids'), 'BTC-USDC');
      return {
        orders: [
          { order_id: 'other', client_order_id: 'nope', status: 'OPEN' },
          {
            order_id: 'real-1',
            client_order_id: 'coid-123',
            product_id: 'BTC-USDC',
            side: 'BUY',
            status: 'FILLED',
            filled_size: '0.01',
            filled_value: '500',
            average_filled_price: '50000',
            completion_percentage: '100',
          },
        ],
      };
    });

    const found = await adapter.findOrderByClientOrderId('coid-123', 'BTC-USDC');
    assert.equal(found.orderId, 'real-1');
    assert.equal(found.status, 'FILLED');
    assert.equal(found.filledSize, 0.01);
    assert.equal(found.filledValue, 500);
    assert.equal(found.averageFilledPrice, 50000);
    assert.equal(calls.length, 1);
  });

  it('returns null when no order carries the client_order_id', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    installFetchMock(() => ({ orders: [{ order_id: 'x', client_order_id: 'someone-else' }] }));

    const found = await adapter.findOrderByClientOrderId('missing', 'BTC-USDC');
    assert.equal(found, null);
  });

  it('short-circuits an empty clientOrderId without any network call', async () => {
    const adapter = createCoinbaseAdapter(keysPath);
    let called = false;
    global.fetch = async () => { called = true; throw new Error('should not fetch'); };

    const found = await adapter.findOrderByClientOrderId('', 'BTC-USDC');
    assert.equal(found, null);
    assert.equal(called, false);
  });
});
