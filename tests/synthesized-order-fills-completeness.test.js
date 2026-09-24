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
const { restQueueTiming } = require('../src/adapters/base-adapter');
const { createHealthMonitor, instrumentAdapterForHealth } = require('../src/health-monitor');

let originalFetch;
let keysPaths;

beforeEach(() => {
  originalFetch = global.fetch;
  keysPaths = [];
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const keysPath of keysPaths) {
    fs.rmSync(keysPath, { force: true });
  }
});

const writeKeys = (prefix) => {
  const keysPath = path.join(os.tmpdir(), `${prefix}-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  keysPaths.push(keysPath);
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

  it('rejects instead of scanning a fallback window when the order-detail lookup fails, preserving the original status', async () => {
    installFetchMock({ orderDetailFails: true });
    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));

    await assert.rejects(adapter.getOrderFills(ORDER_ID), (err) => {
      assert.match(err.message, /order-detail lookup failed/);
      // The wrapped error must still carry the original HTTP status —
      // health-monitor's isAuthDeniedError reads err.status directly, and a
      // fresh plain Error() here would silently discard it (issue #679).
      assert.equal(err.status, 500);
      return true;
    });
  });

  it('preserves a 401 order-detail lookup failure\'s status so auth denials are still detectable (issue #679)', async () => {
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'private/get-order-detail') {
        return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => JSON.stringify({ message: 'invalid api key' }) };
      }
      throw new Error(`unexpected method ${body.method}`);
    };
    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));

    await assert.rejects(adapter.getOrderFills(ORDER_ID), (err) => {
      assert.equal(err.status, 401, 'status must survive the rethrow so isAuthDeniedError can classify it');
      assert.match(err.message, /order-detail lookup failed/);
      return true;
    });
  });

  it('retries the trade scan and succeeds once a lagging fill is indexed, instead of rejecting immediately (issue #679 follow-up)', async () => {
    // A fresh order (30 min ago) — its window fits in a single 24h bucket,
    // so exactly one private/get-trades call happens per retry attempt,
    // making "the fill appears on the Nth call" straightforward to model.
    const freshOrderCreateTime = now - 30 * 60 * 1000;
    const freshTrade = {
      trade_id: 'cdc-fresh', order_id: 'FRESH-ORDER', side: 'SELL', traded_price: '2',
      traded_quantity: '500', fees: '-0.25', fee_instrument_name: 'USDT',
      create_time: now - 60_000, taker_side: 'TAKER',
    };
    let getTradesCalls = 0;
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.method === 'private/get-order-detail') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            code: 0,
            result: {
              order_info: {
                order_id: 'FRESH-ORDER', instrument_name: 'BTC_USDT',
                create_time: freshOrderCreateTime, update_time: now,
                cumulative_quantity: '500', status: 'FILLED',
              },
            },
          }),
        };
      }
      if (body.method === 'private/get-trades') {
        getTradesCalls++;
        // The trade is not yet indexed on the first two calls — only from
        // the third call onward (i.e. after two retries).
        const data = getTradesCalls >= 3 ? [freshTrade] : [];
        return { ok: true, text: async () => JSON.stringify({ code: 0, result: { data } }) };
      }
      throw new Error(`unexpected method ${body.method}`);
    };
    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));

    const fills = await adapter.getOrderFills('FRESH-ORDER');

    assert.equal(getTradesCalls, 3, 'must have retried twice before the fill was indexed');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].tradeId, 'cdc-fresh');
  });

  it('paces day-walk pages and accounts for both pacing and retry waits', async () => {
    const requestTimes = [];
    const created = Date.now() - 2 * 24 * 60 * 60 * 1000;
    global.fetch = async (_url, options) => {
      const { method } = JSON.parse(options.body);
      if (method === 'private/get-order-detail') return {
        ok: true, text: async () => JSON.stringify({ code: 0, result: { order_info: {
          order_id: ORDER_ID, instrument_name: 'BTC_USDT', create_time: created,
          update_time: Date.now(), cumulative_quantity: '1',
        } } }),
      };
      if (method === 'private/get-trades') {
        requestTimes.push(Date.now());
        const data = requestTimes.length >= 4 ? [{
          trade_id: 'paced', order_id: ORDER_ID, traded_quantity: '1',
          traded_price: '10', create_time: Date.now(),
        }] : [];
        return { ok: true, text: async () => JSON.stringify({ code: 0, result: { data } }) };
      }
      throw new Error(`unexpected method ${method}`);
    };
    const timing = { queuedMs: 0 };
    const fills = await restQueueTiming.run(timing, () => createCryptocomAdapter(writeKeys('cryptocom')).getOrderFills(ORDER_ID));
    assert.equal(fills.length, 1);
    assert.ok(requestTimes.length >= 6);
    for (let i = 1; i < requestTimes.length; i++) {
      assert.ok(requestTimes[i] - requestTimes[i - 1] >= 175, 'trade pages must be paced');
    }
    assert.ok(timing.queuedMs >= 900, 'client wait must be available for health latency exclusion');

    // The health wrapper uses the same async timing store. A fresh run
    // should record network work while subtracting the deliberate waits.
    const monitor = createHealthMonitor('cryptocom', { maxLatencyMs: 500 });
    const wrapped = instrumentAdapterForHealth(createCryptocomAdapter(writeKeys('cryptocom')), monitor);
    await wrapped.getOrderFills(ORDER_ID);
    assert.ok(monitor.getState().healthChecks.avgLatencyMs < 250);
  });

  it('fails closed when a long trade walk reaches its page budget', async () => {
    const created = Date.now() - 70 * 24 * 60 * 60 * 1000;
    let pages = 0;
    global.fetch = async (_url, options) => {
      const { method } = JSON.parse(options.body);
      if (method === 'private/get-order-detail') return {
        ok: true, text: async () => JSON.stringify({ code: 0, result: { order_info: {
          order_id: ORDER_ID, instrument_name: 'BTC_USDT', create_time: created,
          update_time: Date.now(), cumulative_quantity: '1',
        } } }),
      };
      if (method === 'private/get-trades') {
        pages++;
        return { ok: true, text: async () => JSON.stringify({ code: 0, result: { data: [] } }) };
      }
      throw new Error(`unexpected method ${method}`);
    };
    await assert.rejects(createCryptocomAdapter(writeKeys('cryptocom')).getOrderFills(ORDER_ID),
      err => err.incompleteFills === true && /exceeded 64 pages/.test(err.message));
    assert.equal(pages, 64);
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

  it('retries the trade scan and succeeds once a lagging fill is indexed, instead of rejecting immediately (issue #679 follow-up)', async () => {
    const freshTrade = { tid: 9001, order_id: '888', symbol: 'ethusd', type: 'Sell', price: '2500.00', amount: '500', fee_amount: '2.5', timestampms: now - 60_000, is_maker: false };
    let mytradesCalls = 0;
    global.fetch = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint === '/v1/order/status') {
        return {
          ok: true, status: 200, statusText: 'OK',
          text: async () => JSON.stringify({ order_id: '888', symbol: 'ETHUSD', timestampms: now - 30 * 60 * 1000, executed_amount: '500' }),
        };
      }
      if (endpoint === '/v1/mytrades') {
        mytradesCalls++;
        // Not yet indexed on the first two calls — only from the third call
        // onward (i.e. after two retries).
        const trades = mytradesCalls >= 3 ? [freshTrade] : [];
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(trades) };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    const adapter = createGeminiAdapter(writeKeys('gemini'));

    const fills = await adapter.getOrderFills('888');

    assert.equal(mytradesCalls, 3, 'must have retried twice before the fill was indexed');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].tradeId, '9001');
  });

  it('accounts for short-fill retry sleep in health timing', async () => {
    const freshTrade = { tid: 9002, order_id: '889', symbol: 'ethusd', type: 'Sell', price: '2', amount: '1', timestampms: Date.now() };
    let calls = 0;
    global.fetch = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint === '/v1/order/status') return {
        ok: true, status: 200, text: async () => JSON.stringify({ order_id: '889', symbol: 'ETHUSD', timestampms: Date.now() - 60_000, executed_amount: '1' }),
      };
      if (endpoint === '/v1/mytrades') return {
        ok: true, status: 200, text: async () => JSON.stringify(++calls >= 2 ? [freshTrade] : []),
      };
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    const timing = { queuedMs: 0 };
    const fills = await restQueueTiming.run(timing, () => createGeminiAdapter(writeKeys('gemini')).getOrderFills('889'));
    assert.equal(fills.length, 1);
    assert.ok(timing.queuedMs >= 700, 'retry sleep must be available for health latency exclusion');
    const monitor = createHealthMonitor('gemini', { maxLatencyMs: 500 });
    const wrapped = instrumentAdapterForHealth(createGeminiAdapter(writeKeys('gemini')), monitor);
    await wrapped.getOrderFills('889');
    assert.ok(monitor.getState().healthChecks.avgLatencyMs < 250);
  });
});
