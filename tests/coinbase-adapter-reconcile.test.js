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
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
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
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    const { calls } = installFetchMock((url) => {
      assert.equal(url.pathname, '/api/v3/brokerage/orders/historical/batch');
      assert.equal(url.searchParams.get('product_ids'), 'BTC-USDC');
      return {
        has_next: false,
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
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    installFetchMock(() => ({ has_next: false, orders: [{ order_id: 'x', client_order_id: 'someone-else' }] }));

    const found = await adapter.findOrderByClientOrderId('missing', 'BTC-USDC');
    assert.equal(found, null);
  });

  it('follows encoded cursors with the product filter and normalizes a later partial order (#1731)', async () => {
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    const cursor = 'older/+?=& orders';
    const { calls } = installFetchMock((url, _opts, requests) => {
      assert.equal(url.searchParams.get('product_ids'), 'BTC-USDC');
      assert.equal(url.searchParams.get('limit'), '100');
      if (requests.length === 1) return {
        orders: Array.from({ length: 100 }, (_, i) => ({ client_order_id: `newer-${i}` })),
        has_next: true, cursor,
      };
      assert.equal(url.searchParams.get('cursor'), cursor);
      return { has_next: true, cursor: 'unused', orders: [{
        client_order_id: 'target', order_id: 'older-open', product_id: 'BTC-USDC',
        side: 'BUY', status: 'OPEN', filled_size: '0.001', filled_value: '50',
        average_filled_price: '50000', completion_percentage: '10', total_fees: '0.25',
        created_time: '2026-10-20T00:00:00Z',
      }] };
    });
    assert.deepEqual(await adapter.findOrderByClientOrderId('target', 'BTC-USDC'), {
      orderId: 'older-open', productId: 'BTC-USDC', side: 'BUY', status: 'OPEN',
      filledSize: 0.001, filledValue: 50, averageFilledPrice: 50000,
      completionPercentage: 10, totalFees: 0.25, createdTime: '2026-10-20T00:00:00Z',
    });
    assert.equal(calls.length, 2, 'a match stops scanning immediately');
  });

  it('returns null only after all no-match pages complete, including an unscoped lookup', async () => {
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    const { calls } = installFetchMock((url, _opts, requests) => {
      assert.equal(url.searchParams.has('product_ids'), false);
      return requests.length === 1
        ? { orders: [], has_next: true, cursor: 'next' }
        : { orders: [], has_next: false };
    });
    assert.equal(await adapter.findOrderByClientOrderId('missing'), null);
    assert.equal(calls.length, 2);
  });

  const incompletePages = [
    ['network failure', () => { throw networkError(); }],
    ['repeated cursor', () => ({ orders: [], has_next: true, cursor: 'next' })],
    ['missing cursor', () => ({ orders: [], has_next: true })],
    ['blank cursor', () => ({ orders: [], has_next: true, cursor: '  ' })],
    ['non-string cursor', () => ({ orders: [], has_next: true, cursor: 123 })],
    ['missing orders', () => ({ has_next: false })],
    ['invalid orders', () => ({ orders: {}, has_next: false })],
    ['invalid order row', () => ({ orders: [null], has_next: false })],
    ['missing continuation flag', () => ({ orders: [] })],
    ['invalid continuation flag', () => ({ orders: [], has_next: 'false' })],
    ['null page', () => null],
  ];
  for (const [name, secondPage] of incompletePages) {
    it(`keeps a later-page ${name} inconclusive`, async () => {
      const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
      const { calls } = installFetchMock((_url, _opts, requests) => requests.length === 1
        ? { orders: [], has_next: true, cursor: 'next' } : secondPage());
      await assert.rejects(() => adapter.findOrderByClientOrderId('missing', 'BTC-USDC'), /lookup inconclusive/);
      assert.equal(calls.length, name === 'network failure' ? 5 : 2);
    });
  }

  it('bounds a history scan to 64 pages without reporting absence', async () => {
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    const { calls } = installFetchMock((_url, _opts, requests) => ({
      orders: [], has_next: true, cursor: `page-${requests.length}`,
    }));
    await assert.rejects(() => adapter.findOrderByClientOrderId('missing'), /inconclusive: exceeded 64-page/);
    assert.equal(calls.length, 64);
  });

  it('short-circuits an empty clientOrderId without any network call', async () => {
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    let called = false;
    global.fetch = async () => { called = true; throw new Error('should not fetch'); };

    const found = await adapter.findOrderByClientOrderId('', 'BTC-USDC');
    assert.equal(found, null);
    assert.equal(called, false);
  });
});

describe('coinbase fill-drift reconciliation (issue #609)', () => {
  it('reports fills when Coinbase marks a page as continued without a cursor', async () => {
    const adapter = createCoinbaseAdapter(keysPath, { sleep: async () => {} });
    let calls = 0;
    global.fetch = async (url) => {
      calls++;
      assert.equal(new URL(url).pathname, '/api/v3/brokerage/orders/historical/fills');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          has_next: true,
          fills: [{
            trade_id: 'trade-609',
            order_id: 'order-609',
            product_id: 'BTC-USDC',
            side: 'BUY',
            price: '50000',
            size: '0.01',
            commission: '0.05',
            trade_time: '2026-09-20T00:00:00.000Z',
          }],
        }),
      };
    };

    const fills = await adapter.getReconciliationFills('BTC-USDC', Date.parse('2026-09-19T00:00:00.000Z'));

    assert.equal(calls, 1, 'cursorless response must terminate the sweep');
    assert.deepEqual(fills, [{
      tradeId: 'trade-609',
      orderId: 'order-609',
      side: 'buy',
      price: 50000,
      size: 0.01,
      quoteAmount: 500,
      fee: 0.05,
      feeCurrency: 'USDC',
      timestamp: Date.parse('2026-09-20T00:00:00.000Z'),
      liquidityIndicator: 'TAKER',
    }]);
  });
});
