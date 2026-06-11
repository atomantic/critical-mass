// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGeminiAdapter } = require('../src/adapters/gemini/api');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let keysPath;
let originalFetch;

/**
 * Install a global.fetch mock that decodes the Gemini X-GEMINI-PAYLOAD header
 * so tests can assert on the exact request params sent to each endpoint.
 * @param {(endpoint: string, payload: Object, call: {endpoint: string, payload: Object}[]) => any} handler
 *   Returns the response body (object or raw JSON string). Return
 *   `{ __error: true, status }` to simulate an HTTP error.
 * @returns {{calls: Array<{endpoint: string, payload: Object}>}}
 */
const installFetchMock = (handler) => {
  const calls = [];
  global.fetch = async (url, opts) => {
    const endpoint = new URL(url).pathname;
    const payloadB64 = opts.headers['X-GEMINI-PAYLOAD'];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    calls.push({ endpoint, payload });
    const body = handler(endpoint, payload, calls);
    if (body && body.__error) {
      return {
        ok: false,
        status: body.status || 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ reason: 'simulated error' }),
      };
    }
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: true, status: 200, statusText: 'OK', text: async () => raw };
  };
  return { calls };
};

const mytradesCalls = (calls) => calls.filter(c => c.endpoint === '/v1/mytrades');
const heartbeatCalls = (calls) => calls.filter(c => c.endpoint === '/v1/heartbeat');

const makeTrade = (overrides = {}) => ({
  tid: 1000,
  order_id: 555,
  symbol: 'ethusd',
  type: 'Buy',
  price: '2500.00',
  amount: '0.5',
  fee_amount: '1.25',
  timestampms: 1750000000000,
  is_maker: true,
  ...overrides,
});

beforeEach(() => {
  keysPath = path.join(os.tmpdir(), `gemini-test-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
});

// ---------------------------------------------------------------------------
// getOrderFills — symbol + timestamp bound (issue #100)
// ---------------------------------------------------------------------------

describe('gemini getOrderFills', () => {
  it('passes the order\'s own symbol and a creation-time bound to /v1/mytrades (not hardcoded btcusd)', async () => {
    const adapter = createGeminiAdapter(keysPath);
    const createdMs = Date.now() - 3 * 60 * 60 * 1000; // 3h-old order
    const { calls } = installFetchMock((endpoint) => {
      if (endpoint === '/v1/order/status') {
        return { order_id: 555, symbol: 'ETHUSD', timestampms: createdMs };
      }
      if (endpoint === '/v1/mytrades') {
        return [
          makeTrade({ tid: 1, order_id: 555 }),
          makeTrade({ tid: 2, order_id: 999 }), // different order — filtered out
        ];
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const fills = await adapter.getOrderFills('555');

    const mt = mytradesCalls(calls);
    assert.equal(mt.length, 1);
    assert.equal(mt[0].payload.symbol, 'ethusd');
    assert.equal(mt[0].payload.limit_trades, 500);
    // Timestamp bound: order creation minus 60s pad, in seconds
    assert.equal(mt[0].payload.timestamp, Math.floor((createdMs - 60000) / 1000));

    assert.equal(fills.length, 1);
    assert.equal(fills[0].orderId, '555');
    assert.equal(fills[0].side, 'BUY');
    assert.equal(fills[0].netFee, 1.25);
    assert.equal(fills[0].liquidityIndicator, 'MAKER');
  });

  it('fetches a single newest-since page (Gemini has no older-than cursor) and warns on a full-page cap', async () => {
    // Gemini's /v1/mytrades is since-lower-bound + newest-first with no
    // older-than cursor (live-verified), so a forward-advancing cursor would
    // ask for NEWER trades and never reach the order's older fills. The adapter
    // therefore makes exactly ONE mytrades request bounded by the order's
    // creation, and logs a truncation warning when a full page comes back.
    const adapter = createGeminiAdapter(keysPath);
    const createdMs = 1750000000000;
    const warnings = [];
    const origLog = console.log;
    console.log = (msg) => { if (typeof msg === 'string' && msg.includes('page cap')) warnings.push(msg); };
    let fills;
    try {
      const { calls } = installFetchMock((endpoint) => {
        if (endpoint === '/v1/order/status') {
          return { order_id: 777, symbol: 'BTCUSD', timestampms: createdMs };
        }
        if (endpoint === '/v1/mytrades') {
          // A full 500-trade page: 499 other-order trades + the target fill.
          const rows = Array.from({ length: 499 }, (_, i) =>
            makeTrade({ tid: 10000 + i, order_id: 111, symbol: 'btcusd', timestampms: createdMs + i * 1000 }));
          rows.push(makeTrade({ tid: 99999, order_id: 777, symbol: 'btcusd', timestampms: createdMs + 600000 }));
          return rows;
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      });

      fills = await adapter.getOrderFills('777');

      const mt = mytradesCalls(calls);
      assert.equal(mt.length, 1, 'exactly one mytrades request — no forward pagination');
      assert.equal(mt[0].payload.symbol, 'btcusd');
      assert.equal(mt[0].payload.timestamp, Math.floor((createdMs - 60000) / 1000));
    } finally {
      console.log = origLog;
    }

    // The target fill is found within the single page, and a truncation warning fired.
    assert.equal(fills.length, 1);
    assert.equal(fills[0].tradeId, '99999');
    assert.equal(fills[0].orderId, '777');
    assert.equal(warnings.length, 1, 'full-page cap must emit a visible truncation warning');
  });

  it('preserves order_id/tid exceeding MAX_SAFE_INTEGER as exact strings', async () => {
    const adapter = createGeminiAdapter(keysPath);
    const bigOrderId = '9223372036854775807';
    const bigTid = '9223372036854775901';
    installFetchMock((endpoint) => {
      if (endpoint === '/v1/order/status') {
        // Raw JSON with unquoted big ints — the string-guard must preserve them
        return `{"order_id":${bigOrderId},"symbol":"ETHUSD","timestampms":1750000000000}`;
      }
      if (endpoint === '/v1/mytrades') {
        return `[{"tid":${bigTid},"order_id":${bigOrderId},"symbol":"ethusd","type":"Sell","price":"2500.00","amount":"0.5","fee_amount":"1.25","timestampms":1750000001000,"is_maker":false}]`;
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const fills = await adapter.getOrderFills(bigOrderId);

    assert.equal(fills.length, 1);
    assert.equal(fills[0].orderId, bigOrderId);
    assert.equal(fills[0].tradeId, bigTid);
  });

  it('falls back to a 1h all-symbol scan when the order-status lookup fails', async () => {
    const adapter = createGeminiAdapter(keysPath);
    const before = Date.now();
    const { calls } = installFetchMock((endpoint) => {
      if (endpoint === '/v1/order/status') {
        return { __error: true, status: 400 };
      }
      if (endpoint === '/v1/mytrades') {
        return [makeTrade({ tid: 5, order_id: 555 })];
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const fills = await adapter.getOrderFills('555');

    const mt = mytradesCalls(calls);
    assert.equal(mt.length, 1);
    assert.equal(mt[0].payload.symbol, undefined); // no hardcoded btcusd
    // Bound ~ now - 1h (in seconds)
    const expectedMin = Math.floor((before - 60 * 60 * 1000) / 1000);
    assert.ok(mt[0].payload.timestamp >= expectedMin);
    assert.ok(mt[0].payload.timestamp <= Math.floor(Date.now() / 1000));

    assert.equal(fills.length, 1);
    assert.equal(fills[0].orderId, '555');
  });
});

// ---------------------------------------------------------------------------
// Heartbeat refcount (issue #101)
// ---------------------------------------------------------------------------

describe('gemini heartbeat refcount', () => {
  it('keeps the heartbeat alive until the last owner stops', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const adapter = createGeminiAdapter(keysPath);
    const { calls } = installFetchMock(() => ({ result: 'ok' }));

    adapter.startHeartbeat('gemini/BTC-USD');
    adapter.startHeartbeat('gemini/ETH-USD');
    assert.equal(heartbeatCalls(calls).length, 1); // immediate send on first arm only

    // Fund A stops — fund B still needs the heartbeat
    adapter.stopHeartbeat('gemini/BTC-USD');
    mock.timers.tick(60000);
    assert.equal(heartbeatCalls(calls).length, 2); // still ticking

    // Last fund stops — timer cleared
    adapter.stopHeartbeat('gemini/ETH-USD');
    mock.timers.tick(60000 * 5);
    assert.equal(heartbeatCalls(calls).length, 2); // no further sends

    mock.timers.reset();
  });

  it('is idempotent per owner: double-start does not require double-stop', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const adapter = createGeminiAdapter(keysPath);
    const { calls } = installFetchMock(() => ({ result: 'ok' }));

    adapter.startHeartbeat('gemini/BTC-USD');
    adapter.startHeartbeat('gemini/BTC-USD'); // duplicate start from same engine
    adapter.stopHeartbeat('gemini/BTC-USD'); // single stop fully releases

    mock.timers.tick(60000 * 5);
    assert.equal(heartbeatCalls(calls).length, 1); // only the immediate send

    // Double-stop is harmless
    adapter.stopHeartbeat('gemini/BTC-USD');

    // A later restart re-arms the timer
    adapter.startHeartbeat('gemini/BTC-USD');
    assert.equal(heartbeatCalls(calls).length, 2);
    mock.timers.tick(60000);
    assert.equal(heartbeatCalls(calls).length, 3);
    adapter.stopHeartbeat('gemini/BTC-USD');

    mock.timers.reset();
  });
});
