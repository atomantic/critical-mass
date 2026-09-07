// @ts-check
//
// Issue #316 — adapter status-normalization contract for partial-sell freezing.
//
// `cancelPartialFillOrder` only lets the engine stop tracking a partially
// filled sell (and therefore resize/replace its body) once it has AUTHORITATIVE
// terminal evidence: a terminal `getOrder` status AND absence from the
// `getOpenOrders` snapshot. That contract is only as good as each adapter's
// raw-payload → canonical-status mapping, which the engine-level tests stub out
// entirely (they hand the helper an already-normalized status).
//
// These tests drive the REAL Coinbase and Gemini adapters from raw exchange
// payloads through the real helper, so a mapping regression on either exchange
// fails here instead of stranding a live order in production.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { cancelPartialFillOrder } = require('../src/regime-engine');

const PRODUCT_ID = 'BTC-USD';
const ORDER_ID = 'tp-partial-1';

let originalFetch;
let coinbaseKeysPath;
let geminiKeysPath;

beforeEach(() => {
  originalFetch = global.fetch;
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  coinbaseKeysPath = path.join(os.tmpdir(), `cb-status-keys-${suffix}.json`);
  geminiKeysPath = path.join(os.tmpdir(), `gm-status-keys-${suffix}.json`);
  fs.writeFileSync(coinbaseKeysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  fs.writeFileSync(geminiKeysPath, JSON.stringify({ apiKey: 'test-api-key', apiSecret: 'test-api-secret' }));
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(coinbaseKeysPath, { force: true });
  fs.rmSync(geminiKeysPath, { force: true });
});

// ---------------------------------------------------------------------------
// Fixture adapters — real adapter code, mocked transport, raw exchange payloads
// ---------------------------------------------------------------------------

/**
 * Build a Coinbase adapter whose transport returns the given raw payloads.
 * @param {{order: Object, openOrders?: Object[], cancelThrows?: boolean}} fixture
 */
const coinbaseFixture = ({ order, openOrders = [], cancelThrows = false }) => {
  global.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    if (pathname === '/api/v3/brokerage/orders/batch_cancel') {
      if (cancelThrows) throw Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' });
      return json({ results: [{ success: true, order_id: ORDER_ID }] });
    }
    if (pathname.startsWith('/api/v3/brokerage/orders/historical/batch')) {
      return json({ orders: openOrders });
    }
    if (pathname.startsWith('/api/v3/brokerage/orders/historical/')) {
      return json({ order });
    }
    throw new Error(`unexpected coinbase endpoint ${pathname} (${opts.method || 'GET'})`);
  };
  return createCoinbaseAdapter(coinbaseKeysPath);
};

/**
 * Build a Gemini adapter whose transport returns the given raw payloads.
 * @param {{order: Object, openOrders?: Object[], cancelThrows?: boolean}} fixture
 */
const geminiFixture = ({ order, openOrders = [], cancelThrows = false }) => {
  global.fetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/v1/order/cancel') {
      if (cancelThrows) throw Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' });
      return json({ is_cancelled: true });
    }
    if (pathname === '/v1/order/status') return json(order);
    if (pathname === '/v1/orders') return json(openOrders);
    throw new Error(`unexpected gemini endpoint ${pathname}`);
  };
  return createGeminiAdapter(geminiKeysPath);
};

const json = (body) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Raw Gemini /v1/order/status row. */
const geminiOrder = (overrides = {}) => ({
  order_id: ORDER_ID,
  symbol: 'btcusd',
  side: 'sell',
  original_amount: '0.009',
  executed_amount: '0.003',
  avg_execution_price: '51000',
  timestampms: 1750000000000,
  is_live: false,
  is_cancelled: false,
  ...overrides,
});

/** Raw Gemini /v1/orders row (live orders only). */
const geminiOpenOrder = (overrides = {}) => ({
  order_id: ORDER_ID,
  symbol: 'btcusd',
  side: 'sell',
  executed_amount: '0.003',
  timestampms: 1750000000000,
  is_live: true,
  ...overrides,
});

/** Raw Coinbase historical-order row. */
const coinbaseOrder = (overrides = {}) => ({
  order_id: ORDER_ID,
  product_id: PRODUCT_ID,
  side: 'SELL',
  status: 'OPEN',
  filled_size: '0.003',
  filled_value: '153',
  average_filled_price: '51000',
  completion_percentage: '33.33',
  total_fees: '0.15',
  created_time: '2026-09-01T00:00:00Z',
  ...overrides,
});

const freeze = (adapter) =>
  cancelPartialFillOrder({ adapter, exchange: adapter.name, pair: PRODUCT_ID, log: () => {} }, ORDER_ID);

// ---------------------------------------------------------------------------

describe('#316 partial-sell freeze — Coinbase status normalization', () => {
  it('retains tracking while the partially filled sell is still OPEN on the book', async () => {
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'OPEN' }),
      openOrders: [coinbaseOrder({ status: 'OPEN' })],
    }));
    assert.equal(result.cancelled, false);
  });

  it('confirms a CANCELLED partial that has left the open-order snapshot', async () => {
    const result = await freeze(coinbaseFixture({ order: coinbaseOrder({ status: 'CANCELLED' }) }));
    assert.equal(result.cancelled, true);
    assert.equal(result.order.status, 'CANCELLED');
    // The caller reprotects only the remainder, so the partial size must survive.
    assert.equal(result.order.filledSize, 0.003);
  });

  it('confirms the cancel/fully-filled race so the cycle closes on the final fills', async () => {
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'FILLED', filled_size: '0.009', completion_percentage: '100' }),
    }));
    assert.equal(result.cancelled, true);
    assert.equal(result.order.filledSize, 0.009);
  });

  it('accepts completion_percentage 100 before status flips to FILLED (issue #107 window)', async () => {
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'OPEN', filled_size: '0.009', completion_percentage: '100' }),
    }));
    assert.equal(result.cancelled, true);
  });

  it('retains tracking on CANCEL_QUEUED — the cancel is accepted but not yet terminal', async () => {
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'CANCEL_QUEUED' }),
      openOrders: [],
    }));
    assert.equal(result.cancelled, false);
  });

  it('rejects a terminal status that the open-order snapshot contradicts', async () => {
    // Coinbase's historical-order endpoint is eventually consistent and can read
    // CANCELLED while the order is genuinely live (the 0824cc36 incident).
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'CANCELLED' }),
      openOrders: [coinbaseOrder({ status: 'OPEN' })],
    }));
    assert.equal(result.cancelled, false);
  });

  it('confirms terminal status even when the cancel request itself failed', async () => {
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'CANCELLED' }),
      cancelThrows: true,
    }));
    assert.equal(result.cancelled, true);
    assert.equal(result.error, undefined);
  });

  it('retains tracking and surfaces the error when the cancel fails and the order is still open', async () => {
    const result = await freeze(coinbaseFixture({
      order: coinbaseOrder({ status: 'OPEN' }),
      openOrders: [coinbaseOrder({ status: 'OPEN' })],
      cancelThrows: true,
    }));
    assert.equal(result.cancelled, false);
    assert.match(result.error.message, /socket disconnected/);
  });
});

describe('#316 partial-sell freeze — Gemini status normalization', () => {
  it('retains tracking while the partially filled sell is still live', async () => {
    const result = await freeze(geminiFixture({
      order: geminiOrder({ is_live: true }),
      openOrders: [geminiOpenOrder()],
    }));
    assert.equal(result.cancelled, false);
  });

  it('confirms a cancelled partial and preserves its executed amount', async () => {
    const result = await freeze(geminiFixture({ order: geminiOrder({ is_cancelled: true }) }));
    assert.equal(result.cancelled, true);
    assert.equal(result.order.status, 'CANCELLED');
    assert.equal(result.order.filledSize, 0.003);
  });

  it('confirms the cancel/fully-filled race', async () => {
    const result = await freeze(geminiFixture({
      order: geminiOrder({ executed_amount: '0.009' }),
    }));
    assert.equal(result.cancelled, true);
    assert.equal(result.order.status, 'FILLED');
    assert.equal(result.order.filledSize, 0.009);
  });

  // Regression: an off-book order that Gemini does not flag `is_cancelled` used
  // to normalize to 'UNKNOWN'. 'UNKNOWN' is not terminal, so the helper could
  // never confirm it — handleOrderFill threw on every reconcile tick forever,
  // the partial fill was never ingested, and the body was never reprotected.
  it('treats an off-book, not-explicitly-cancelled order as terminal (not UNKNOWN)', async () => {
    const result = await freeze(geminiFixture({
      order: geminiOrder({ is_live: false, is_cancelled: false }),
    }));
    assert.equal(result.cancelled, true);
    assert.equal(result.order.status, 'EXPIRED');
    assert.equal(result.order.filledSize, 0.003);
  });

  it('still defers to the open-order snapshot when an off-book read is stale', async () => {
    const result = await freeze(geminiFixture({
      order: geminiOrder({ is_live: false, is_cancelled: false }),
      openOrders: [geminiOpenOrder()],
    }));
    assert.equal(result.cancelled, false);
  });

  // Regression: `executed_amount >= original_amount` read as `0 >= 0` when the
  // size fields were missing, reporting a FILLED order with filledSize 0 — a
  // false terminal fill the reconcile loop would have acted on.
  it('does not report FILLED when the size fields are missing', async () => {
    const result = await freeze(geminiFixture({
      order: geminiOrder({ original_amount: undefined, executed_amount: undefined }),
    }));
    assert.equal(result.order.status, 'EXPIRED');
    assert.equal(result.order.filledSize, 0);
  });

  it('confirms terminal status even when the cancel request itself failed', async () => {
    const result = await freeze(geminiFixture({
      order: geminiOrder({ is_cancelled: true }),
      cancelThrows: true,
    }));
    assert.equal(result.cancelled, true);
    assert.equal(result.error, undefined);
  });

  it('retains tracking when the open-order lookup fails outright', async () => {
    global.fetch = async (url) => {
      const { pathname } = new URL(url);
      if (pathname === '/v1/order/cancel') return json({ is_cancelled: true });
      if (pathname === '/v1/order/status') return json(geminiOrder({ is_cancelled: true }));
      throw new Error('gemini /v1/orders unavailable');
    };
    const result = await freeze(createGeminiAdapter(geminiKeysPath));
    assert.equal(result.cancelled, false);
    assert.match(result.error.message, /unavailable/);
  });
});
