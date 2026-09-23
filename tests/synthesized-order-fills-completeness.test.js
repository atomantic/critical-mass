// @ts-check
// ---------------------------------------------------------------------------
// Regression coverage for issue #679: Crypto.com and Gemini have no
// per-order fills endpoint, so getOrderFills() synthesizes fills from a
// trade-history scan. Several paths could return an INCOMPLETE fill set with
// no error — a GTC body TP resting longer than the old 7-day Crypto.com
// lookback cap, an order-detail/status lookup blip that fell back to a
// short scan, or the two never cross-checking the filled total they
// returned against the exchange's own cumulative_quantity/executed_amount.
//
// Both adapters must now:
//   1. Bound the trade scan by the order's own create_time (no artificial
//      lookback cap for Crypto.com).
//   2. Rethrow when the order-detail/status lookup fails, rather than
//      degrading to a short fallback scan.
//   3. Reject with `{ incompleteFills: true }` when the matched fill total
//      falls short of the order's own filled quantity.
// ---------------------------------------------------------------------------
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

const writeKeys = (prefix) => {
  const keysPath = path.join(os.tmpdir(), `${prefix}-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  return keysPath;
};

// ---------------------------------------------------------------------------
// Crypto.com
// ---------------------------------------------------------------------------

describe('Crypto.com getOrderFills completeness (issue #679)', () => {
  const NS_PER_MS = 1_000_000n;
  const ORDER_ID = 'ORDER-1';
  const now = Date.now();
  const createTime = now - 10 * 24 * 60 * 60 * 1000; // order created 10 days ago
  // Offset well clear of any 24h bucket boundary the adapter's backward walk
  // might land on.
  const oldTradeTime = now - 9 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000; // ~9d ago
  const recentTradeTime = now - 2 * 60 * 60 * 1000; // 2h ago

  const oldTrade = {
    trade_id: 'cdc-old', order_id: ORDER_ID, side: 'SELL', traded_price: '2',
    traded_quantity: '1000', fees: '-0.5', fee_instrument_name: 'USDT',
    create_time: oldTradeTime, taker_side: 'MAKER',
  };
  const recentTrade = {
    trade_id: 'cdc-recent', order_id: ORDER_ID, side: 'SELL', traded_price: '2',
    traded_quantity: '500', fees: '-0.25', fee_instrument_name: 'USDT',
    create_time: recentTradeTime, taker_side: 'TAKER',
  };

  /**
   * @param {Object} [opts]
   * @param {any[]} [opts.trades] - trade pool served by private/get-trades
   * @param {boolean} [opts.orderDetailFails] - simulate a failed order-detail lookup
   */
  const installFetchMock = ({ trades = [oldTrade, recentTrade], orderDetailFails = false } = {}) => {
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'private/get-order-detail') {
        if (orderDetailFails) {
          return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => JSON.stringify({ message: 'boom' }) };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({
            code: 0,
            result: {
              order_info: {
                order_id: ORDER_ID,
                instrument_name: 'BTC_USDT',
                create_time: createTime,
                update_time: now,
                cumulative_quantity: '1500',
                status: 'FILLED',
              },
            },
          }),
        };
      }
      if (body.method === 'private/get-trades') {
        const startNs = BigInt(body.params.start_time);
        const endNs = BigInt(body.params.end_time);
        const data = trades.filter((t) => {
          const ts = BigInt(t.create_time) * NS_PER_MS;
          return ts > startNs && ts <= endNs;
        });
        return { ok: true, text: async () => JSON.stringify({ code: 0, result: { data } }) };
      }
      throw new Error(`unexpected method ${body.method}`);
    };
  };

  it('returns every fill for a GTC order resting well past the old 7-day lookback cap', async () => {
    installFetchMock();
    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));

    const fills = await adapter.getOrderFills(ORDER_ID);

    assert.equal(fills.length, 2);
    const totalSize = fills.reduce((sum, f) => sum + f.size, 0);
    assert.ok(Math.abs(totalSize - 1500) < 1e-9);
    assert.deepEqual(fills.map((f) => f.tradeId).sort(), ['cdc-old', 'cdc-recent']);
  });

  it('rejects with incompleteFills when a fill is missing from the trade scan', async () => {
    // Drop the 9d-old fill — the scan only turns up 500 of the order's 1500.
    installFetchMock({ trades: [recentTrade] });
    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));

    await assert.rejects(adapter.getOrderFills(ORDER_ID), (err) => {
      assert.match(err.message, /fills incomplete for ORDER-1: 500 of 1500/);
      assert.equal(err.incompleteFills, true);
      return true;
    });
  });

  it('rejects instead of scanning a fallback window when the order-detail lookup fails', async () => {
    installFetchMock({ orderDetailFails: true });
    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));

    await assert.rejects(adapter.getOrderFills(ORDER_ID), /order-detail lookup failed/);
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe('Gemini getOrderFills completeness (issue #679)', () => {
  const ORDER_ID = '777';
  const now = Date.now();
  const createdMs = now - 10 * 24 * 60 * 60 * 1000;

  const oldTrade = {
    tid: 8001, order_id: ORDER_ID, symbol: 'ethusd', type: 'Sell', price: '2500.00',
    amount: '1000', fee_amount: '5', timestampms: now - 9 * 24 * 60 * 60 * 1000, is_maker: true,
  };
  const recentTrade = {
    tid: 8002, order_id: ORDER_ID, symbol: 'ethusd', type: 'Sell', price: '2500.00',
    amount: '500', fee_amount: '2.5', timestampms: now - 2 * 60 * 60 * 1000, is_maker: false,
  };

  /**
   * @param {Object} [opts]
   * @param {any[]} [opts.trades] - trades served by /v1/mytrades
   * @param {boolean} [opts.orderStatusFails] - simulate a failed order/status lookup
   */
  const installFetchMock = ({ trades = [oldTrade, recentTrade], orderStatusFails = false } = {}) => {
    global.fetch = async (url, opts) => {
      const endpoint = new URL(url).pathname;
      if (endpoint === '/v1/order/status') {
        if (orderStatusFails) {
          return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => JSON.stringify({ reason: 'boom' }) };
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          text: async () => JSON.stringify({ order_id: ORDER_ID, symbol: 'ETHUSD', timestampms: createdMs, executed_amount: '1500' }),
        };
      }
      if (endpoint === '/v1/mytrades') {
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(trades) };
      }
      throw new Error(`unexpected endpoint ${endpoint} (headers: ${JSON.stringify(opts.headers)})`);
    };
  };

  it('returns every fill for an order whose trades span many days', async () => {
    installFetchMock();
    const adapter = createGeminiAdapter(writeKeys('gemini'));

    const fills = await adapter.getOrderFills(ORDER_ID);

    assert.equal(fills.length, 2);
    const totalSize = fills.reduce((sum, f) => sum + f.size, 0);
    assert.ok(Math.abs(totalSize - 1500) < 1e-9);
    assert.deepEqual(fills.map((f) => f.tradeId).sort(), ['8001', '8002']);
  });

  it('rejects with incompleteFills when a fill is missing from /v1/mytrades', async () => {
    installFetchMock({ trades: [recentTrade] });
    const adapter = createGeminiAdapter(writeKeys('gemini'));

    await assert.rejects(adapter.getOrderFills(ORDER_ID), (err) => {
      assert.match(err.message, /fills incomplete for 777: 500 of 1500/);
      assert.equal(err.incompleteFills, true);
      return true;
    });
  });

  it('rejects instead of scanning a fallback window when the order/status lookup fails', async () => {
    installFetchMock({ orderStatusFails: true });
    const adapter = createGeminiAdapter(writeKeys('gemini'));

    await assert.rejects(adapter.getOrderFills(ORDER_ID), /order-status lookup failed/);
  });
});
