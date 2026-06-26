// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGeminiAdapter, createRestThrottle, isRetryableRateLimit } = require('../src/adapters/gemini/api');

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

  it('stitches multiple <=500-trade slices so >500-fill windows are fully reachable (issue #130)', async () => {
    // Gemini /v1/mytrades is since-lower-bound; when more than limit_trades
    // match it returns the OLDEST limit_trades at-or-after `since` (live-probed
    // 2026-06-11). So advancing `since` to the newest timestamp of each full
    // page walks forward through the whole window. The target order's fill sits
    // in the SECOND slice — only reachable if the adapter pages forward — and
    // the boundary trade (shared between slices) must be deduped by tid.
    const adapter = createGeminiAdapter(keysPath);
    const createdMs = 1750000000000;

    // Slice 0: 500 trades, oldest-first window of other-order trades.
    // 1s spacing → newest of slice 0 is createdMs + 499_000.
    const slice0 = Array.from({ length: 500 }, (_, i) =>
      makeTrade({ tid: 10000 + i, order_id: 111, symbol: 'btcusd', timestampms: createdMs + i * 1000 }));
    const boundaryMs = createdMs + 499 * 1000; // newest of slice 0
    // Slice 1 (since = boundaryMs): the boundary trade reappears (tid 10499)
    // plus the target fill and one more, all at/after boundaryMs. Partial page.
    const targetFill = makeTrade({ tid: 99999, order_id: 777, symbol: 'btcusd', timestampms: boundaryMs + 5000 });
    const slice1 = [
      makeTrade({ tid: 10499, order_id: 111, symbol: 'btcusd', timestampms: boundaryMs }), // duplicate boundary
      targetFill,
      makeTrade({ tid: 88888, order_id: 222, symbol: 'btcusd', timestampms: boundaryMs + 9000 }),
    ];

    const { calls } = installFetchMock((endpoint, payload) => {
      if (endpoint === '/v1/order/status') {
        return { order_id: 777, symbol: 'BTCUSD', timestampms: createdMs };
      }
      if (endpoint === '/v1/mytrades') {
        const sinceMs = payload.timestamp * 1000;
        // First slice requested at the creation-time bound; second at the
        // newest timestamp from slice 0.
        return sinceMs >= boundaryMs ? slice1 : slice0;
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const fills = await adapter.getOrderFills('777');

    const mt = mytradesCalls(calls);
    assert.equal(mt.length, 2, 'pages forward into a second slice after a full page');
    assert.equal(mt[0].payload.symbol, 'btcusd');
    assert.equal(mt[0].payload.timestamp, Math.floor((createdMs - 60000) / 1000));
    // Second request advances `since` to the newest second seen in slice 0.
    assert.equal(mt[1].payload.timestamp, Math.floor(boundaryMs / 1000));

    // The target fill lives in slice 1 and is only found via stitching.
    assert.equal(fills.length, 1);
    assert.equal(fills[0].tradeId, '99999');
    assert.equal(fills[0].orderId, '777');
  });

  it('terminates and warns when >500 trades share the same second (no older-than cursor)', async () => {
    // Pathological: a full page whose trades all share one timestamp. Advancing
    // `since` cannot move past it (Gemini timestamp is second-granular), so the
    // adapter must stop after re-requesting the same second once, warn, and not
    // loop forever.
    const adapter = createGeminiAdapter(keysPath);
    const createdMs = 1750000000000;
    const warnings = [];
    const origLog = console.log;
    console.log = (msg) => { if (typeof msg === 'string' && msg.includes('same second')) warnings.push(msg); };
    let fills;
    try {
      const { calls } = installFetchMock((endpoint) => {
        if (endpoint === '/v1/order/status') {
          return { order_id: 777, symbol: 'BTCUSD', timestampms: createdMs };
        }
        if (endpoint === '/v1/mytrades') {
          // 500 trades all at the same millisecond, including the target.
          const rows = Array.from({ length: 499 }, (_, i) =>
            makeTrade({ tid: 20000 + i, order_id: 111, symbol: 'btcusd', timestampms: createdMs }));
          rows.push(makeTrade({ tid: 99999, order_id: 777, symbol: 'btcusd', timestampms: createdMs }));
          return rows;
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      });

      fills = await adapter.getOrderFills('777');

      const mt = mytradesCalls(calls);
      // Two requests max: initial + one retry at the same second, then it bails.
      assert.ok(mt.length <= 2, `must not loop forever, got ${mt.length} requests`);
    } finally {
      console.log = origLog;
    }

    assert.equal(fills.length, 1);
    assert.equal(fills[0].tradeId, '99999');
    assert.equal(warnings.length, 1, 'same-second saturation must emit a visible warning');
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
    // 'Date' is mocked alongside setInterval so tick() advances the clock the
    // REST throttle reads (issue #193) — otherwise a 60s-apart heartbeat looks
    // simultaneous to the throttle and gets spaced out.
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
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
    // 'Date' is mocked alongside setInterval so tick() advances the clock the
    // REST throttle reads (issue #193) — otherwise a 60s-apart heartbeat looks
    // simultaneous to the throttle and gets spaced out.
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
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

// ---------------------------------------------------------------------------
// REST throttle + 429 retry (issue #193)
// ---------------------------------------------------------------------------

describe('createRestThrottle', () => {
  it('lets the first request through with no wait, then spaces the rest by minIntervalMs', async () => {
    const sleeps = [];
    let clock = 1000;
    const acquire = createRestThrottle({
      minIntervalMs: 200,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    await acquire(); // first slot: no prior reservation → no wait
    await acquire();
    await acquire();
    assert.deepEqual(sleeps, [200, 200]);
  });

  it('does not over-wait when callers are already naturally spaced', async () => {
    const sleeps = [];
    let clock = 0;
    const acquire = createRestThrottle({
      minIntervalMs: 200,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    await acquire();      // reserves up to t=200
    clock = 5000;         // caller idles well past the slot
    await acquire();      // already past → no wait
    assert.deepEqual(sleeps, []);
  });
});

describe('isRetryableRateLimit', () => {
  it('retries a 429 while attempts remain', () => {
    assert.equal(isRetryableRateLimit(429, 0, 2), true);
    assert.equal(isRetryableRateLimit(429, 1, 2), true);
  });
  it('stops retrying a 429 once attempts are exhausted', () => {
    assert.equal(isRetryableRateLimit(429, 2, 2), false);
  });
  it('never retries non-429 statuses (would risk double-placing on 5xx)', () => {
    assert.equal(isRetryableRateLimit(500, 0, 2), false);
    assert.equal(isRetryableRateLimit(400, 0, 2), false);
  });
});

describe('makeRestRequest 429 handling (issue #193)', () => {
  it('retries a 429 then succeeds, regenerating the payload (fresh nonce) each attempt', async () => {
    const adapter = createGeminiAdapter(keysPath);
    const nonces = [];
    const { calls } = installFetchMock((endpoint, payload, allCalls) => {
      nonces.push(payload.nonce);
      // First balances call gets rate-limited, the retry succeeds.
      if (allCalls.filter(c => c.endpoint === '/v1/balances').length === 1) {
        return { __error: true, status: 429 };
      }
      return [{ currency: 'USD', available: '100.00', amount: '100.00' }];
    });
    const bal = await adapter.getAccountBalance('USD');
    assert.equal(calls.filter(c => c.endpoint === '/v1/balances').length, 2);
    assert.equal(bal.available, 100);
    // Two attempts → two distinct, increasing nonces (no reuse).
    assert.equal(nonces.length, 2);
    assert.notEqual(nonces[0], nonces[1]);
  });

  it('gives up after RATE_LIMIT_MAX_RETRIES and throws the 429', async () => {
    const adapter = createGeminiAdapter(keysPath);
    const { calls } = installFetchMock(() => ({ __error: true, status: 429 }));
    await assert.rejects(
      () => adapter.getAccountBalance('USD'),
      (err) => err.status === 429 && /429/.test(err.message)
    );
    // 1 initial + 2 retries = 3 attempts total.
    assert.equal(calls.filter(c => c.endpoint === '/v1/balances').length, 3);
  });

  it('does NOT retry a 429 on order placement — fails fast to avoid a double-place', async () => {
    const adapter = createGeminiAdapter(keysPath);
    // Stub product details so placeLimitSell reaches the order/new call.
    adapter.getProductDetails = async () => ({
      baseIncrement: '0.00000001',
      quoteIncrement: '0.01',
      baseMinSize: '0.00001',
      quoteMinSize: '0.1',
      price: 2500,
    });
    const { calls } = installFetchMock(() => ({ __error: true, status: 429 }));
    await assert.rejects(
      () => adapter.placeLimitSell('ETH-USD', 0.5, 2500),
      (err) => err.status === 429
    );
    // Exactly one attempt: order/new opts out of 429 retry (retryRateLimit:false).
    assert.equal(calls.filter(c => c.endpoint === '/v1/order/new').length, 1);
  });
});
