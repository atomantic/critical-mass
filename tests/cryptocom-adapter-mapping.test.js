// @ts-check
// Fixture-based tests for the Crypto.com adapter's response-mapping surface:
// balances, open orders, candles, bid/ask, product details and error-code
// translation. Mirrors the structure of gemini-adapter.test.js.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

let keysPath;
let originalFetch;
let adapter;

beforeEach(() => {
  keysPath = path.join(os.tmpdir(), `cryptocom-mapping-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  originalFetch = global.fetch;
  adapter = createCryptocomAdapter(keysPath);
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
});

/**
 * Mock fetch with a fixed reply; records each call.
 * @param {any} body JSON body (stringified into text())
 * @param {{status?: number, statusText?: string}} [shape]
 */
const mockReply = (body, shape = {}) => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    const status = shape.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: shape.statusText ?? 'OK',
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return calls;
};

describe('Crypto.com getAccountBalance mapping', () => {
  const balances = (positions) => ({ code: 0, result: { data: [{ position_balances: positions }] } });

  it('maps quantity / max_withdrawal_balance into total / available / hold (case-insensitive instrument)', async () => {
    const calls = mockReply(balances([
      { instrument_name: 'BTC', quantity: '1.5', max_withdrawal_balance: '1.25' },
      { instrument_name: 'USDT', quantity: '1000', max_withdrawal_balance: '1000' },
    ]));
    const btc = await adapter.getAccountBalance('btc');
    assert.deepEqual(btc, { available: 1.25, hold: 0.25, total: 1.5 });
    assert.match(calls[0].url, /private\/user-balance$/);
    assert.equal(calls[0].body.method, 'private/user-balance');
    assert.equal(calls[0].body.api_key, 'test-api-key-123');
    assert.ok(calls[0].body.sig, 'private requests are signed');
  });

  it('treats a missing max_withdrawal_balance as fully available', async () => {
    mockReply(balances([{ instrument_name: 'USDT', quantity: '250.5' }]));
    assert.deepEqual(await adapter.getAccountBalance('USDT'), { available: 250.5, hold: 0, total: 250.5 });
  });

  it('clamps negative hold to zero', async () => {
    mockReply(balances([{ instrument_name: 'BTC', quantity: '1', max_withdrawal_balance: '1.2' }]));
    const bal = await adapter.getAccountBalance('BTC');
    assert.equal(bal.hold, 0);
    assert.equal(bal.available, 1.2);
    assert.equal(bal.total, 1);
  });

  it('returns zeros for an unknown currency or an empty account payload', async () => {
    mockReply(balances([{ instrument_name: 'BTC', quantity: '1' }]));
    assert.deepEqual(await adapter.getAccountBalance('ETH'), { available: 0, hold: 0, total: 0 });
    mockReply({ code: 0, result: { data: [] } });
    assert.deepEqual(await adapter.getAccountBalance('BTC'), { available: 0, hold: 0, total: 0 });
    mockReply({ code: 0, result: { data: [{}] } });
    assert.deepEqual(await adapter.getAccountBalance('BTC'), { available: 0, hold: 0, total: 0 });
  });
});

describe('Crypto.com getOpenOrders mapping', () => {
  it('maps open and partially filled orders, with remaining size', async () => {
    const calls = mockReply({
      code: 0,
      result: {
        data: [
          { order_id: '111', instrument_name: 'BTC_USDT', side: 'buy', quantity: '0.5', price: '60000', create_time: 1700000000000 },
          { order_id: 222, instrument_name: 'BTC_USDT', side: 'SELL', quantity: '1', cumulative_quantity: '0.4', price: '70000.5', create_time: 1700000001000 },
        ],
      },
    });
    const orders = await adapter.getOpenOrders('BTC-USDT');
    assert.equal(calls[0].body.params.instrument_name, 'BTC_USDT');
    assert.equal(orders.length, 2);
    assert.deepEqual(orders[0], {
      orderId: '111', productId: 'BTC_USDT', side: 'BUY', status: 'OPEN',
      size: 0.5, originalSize: 0.5, filledSize: 0, price: 60000,
      createdTime: new Date(1700000000000).toISOString(),
    });
    assert.equal(orders[1].orderId, '222');
    assert.equal(orders[1].side, 'SELL');
    assert.equal(orders[1].status, 'PARTIALLY_FILLED');
    assert.equal(orders[1].filledSize, 0.4);
    assert.ok(Math.abs(orders[1].size - 0.6) < 1e-12);
    assert.equal(orders[1].price, 70000.5);
  });

  it('never yields NaN or negative sizes for malformed quantities', async () => {
    mockReply({
      code: 0,
      result: { data: [{ order_id: '1', instrument_name: 'BTC_USDT', side: 'BUY', quantity: 'N/A', price: 'x' }] },
    });
    const [order] = await adapter.getOpenOrders('BTC-USDT');
    assert.equal(order.size, 0);
    assert.equal(order.originalSize, 0);
    assert.equal(order.price, 0);
  });

  it('returns an empty list when the exchange has no data', async () => {
    mockReply({ code: 0, result: {} });
    assert.deepEqual(await adapter.getOpenOrders('BTC-USDT'), []);
  });
});

describe('Crypto.com getCandles mapping', () => {
  it('maps t/o/h/l/c/v into numeric candles and sizes the request window', async () => {
    const calls = mockReply({
      code: 0,
      result: {
        data: [
          { t: 1700000000000, o: '100.5', h: '110', l: '99.25', c: '105', v: '12.5' },
          { t: 1700003600000, o: '105', h: '106', l: '104', c: '104.5', v: '3' },
        ],
      },
    });
    const start = 1700000000;
    const end = start + 3 * 3600;
    const candles = await adapter.getCandles('BTC-USDT', start, end, 'ONE_HOUR');
    assert.deepEqual(candles, [
      { timestamp: 1700000000000, open: 100.5, high: 110, low: 99.25, close: 105, volume: 12.5 },
      { timestamp: 1700003600000, open: 105, high: 106, low: 104, close: 104.5, volume: 3 },
    ]);
    const url = new URL(calls[0].url);
    assert.equal(url.pathname.endsWith('/public/get-candlestick'), true);
    assert.equal(url.searchParams.get('instrument_name'), 'BTC_USDT');
    assert.equal(url.searchParams.get('timeframe'), '1h');
    assert.equal(url.searchParams.get('start_ts'), String(start * 1000));
    assert.equal(url.searchParams.get('end_ts'), String(end * 1000));
    assert.equal(url.searchParams.get('count'), '3');
  });

  it('maps granularities, caps count at 300 and defaults unknown granularity to daily', async () => {
    const calls = mockReply({ code: 0, result: { data: [] } });
    assert.deepEqual(await adapter.getCandles('BTC-USDT', 0, 10_000_000, 'ONE_MINUTE'), []);
    assert.equal(new URL(calls[0].url).searchParams.get('timeframe'), '1m');
    assert.equal(new URL(calls[0].url).searchParams.get('count'), '300');
    await adapter.getCandles('BTC-USDT', 0, 86400 * 2, 'WEIRD');
    assert.equal(new URL(calls[1].url).searchParams.get('timeframe'), '1D');
    assert.equal(new URL(calls[1].url).searchParams.get('count'), '2');
    await adapter.getCandles('BTC-USDT', 0, 100, 'SIX_HOUR');
    assert.equal(new URL(calls[2].url).searchParams.get('timeframe'), '4h');
    assert.equal(new URL(calls[2].url).searchParams.get('count'), '1');
  });
});

describe('Crypto.com getBidAsk and getProductDetails mapping', () => {
  it('maps b to bid and k to ask, defaulting blanks to 0', async () => {
    mockReply({ code: 0, result: { data: [{ i: 'BTC_USDT', b: '60000.5', k: '60001' }] } });
    assert.deepEqual(await adapter.getBidAsk('BTC-USDT'), { bid: 60000.5, ask: 60001 });
    mockReply({ code: 0, result: { data: [{ i: 'BTC_USDT' }] } });
    assert.deepEqual(await adapter.getBidAsk('BTC-USDT'), { bid: 0, ask: 0 });
  });

  it('throws when the ticker for the instrument is absent', async () => {
    mockReply({ code: 0, result: { data: [{ i: 'ETH_USDT', b: '1', k: '2' }] } });
    await assert.rejects(() => adapter.getBidAsk('BTC-USDT'), /Ticker not found for BTC_USDT/);
  });

  it('maps instrument tick sizes and falls back to defaults when absent', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      const text = u.includes('get-instruments')
        ? { code: 0, result: { data: [{ symbol: 'BTC_USDT', qty_tick_size: 0.0001, price_tick_size: 0.5, min_quantity: 0.002 }, { symbol: 'ETH_USDT' }] } }
        : { code: 0, result: { data: [{ i: 'BTC_USDT', a: '100' }, { i: 'ETH_USDT', a: '10' }] } };
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(text) };
    };
    const btc = await adapter.getProductDetails('BTC-USDT');
    assert.deepEqual(btc, {
      baseIncrement: '0.0001', quoteIncrement: '0.5', baseMinSize: '0.002', quoteMinSize: '0.2', price: 100,
    });
    const eth = await adapter.getProductDetails('ETH-USDT');
    assert.equal(eth.baseIncrement, '0.00000001');
    assert.equal(eth.quoteIncrement, '0.01');
    assert.equal(eth.baseMinSize, '0.00001');
    await assert.rejects(() => adapter.getProductDetails('DOGE-USDT'), /Instrument not found: DOGE_USDT/);
  });
});

describe('Crypto.com error translation', () => {
  it('turns a non-zero private reply code into an Error carrying code, endpoint and responseData', async () => {
    mockReply({ code: 10002, message: 'UNAUTHORIZED' });
    await assert.rejects(
      () => adapter.getAccountBalance('BTC'),
      (err) => {
        assert.equal(err.message, 'Crypto.com API error: UNAUTHORIZED (code: 10002)');
        assert.equal(err.code, 10002);
        assert.equal(err.endpoint, 'private/user-balance');
        assert.equal(err.responseData.message, 'UNAUTHORIZED');
        assert.equal(err.orderNotFound, false);
        return true;
      },
    );
  });

  it('uses "Unknown error" when the reply carries no message', async () => {
    mockReply({ code: 50001 });
    await assert.rejects(() => adapter.getAccountBalance('BTC'), /Crypto\.com API error: Unknown error \(code: 50001\)/);
  });

  it('flags the not-found reject codes (316, 40401) as orderNotFound', async () => {
    for (const code of [316, 40401]) {
      mockReply({ code, message: 'NO_ORDER' });
      await assert.rejects(() => adapter.getOpenOrders('BTC-USDT'), (err) => err.code === code && err.orderNotFound === true);
    }
  });

  it('turns a non-zero public reply code and a non-2xx public response into plain errors', async () => {
    mockReply({ code: 10004, message: 'BAD_REQUEST' });
    await assert.rejects(() => adapter.getBidAsk('BTC-USDT'), /Crypto\.com API error: BAD_REQUEST \(code: 10004\)/);
    mockReply({}, { status: 500, statusText: 'Internal Server Error' });
    await assert.rejects(() => adapter.getBidAsk('BTC-USDT'), /Crypto\.com API 500: Internal Server Error/);
  });

  it('carries status, code and detail from a non-2xx private response', async () => {
    mockReply({ code: 40101, message: 'rate limited' }, { status: 429, statusText: 'Too Many Requests' });
    await assert.rejects(
      () => adapter.getAccountBalance('BTC'),
      (err) => {
        assert.equal(err.message, 'Crypto.com API 429: Too Many Requests (rate limited)');
        assert.equal(err.status, 429);
        assert.equal(err.code, 40101);
        assert.equal(err.orderNotFound, false);
        return true;
      },
    );
    mockReply('not json', { status: 404, statusText: 'Not Found' });
    await assert.rejects(() => adapter.getAccountBalance('BTC'), (err) => err.status === 404 && err.orderNotFound === true);
  });
});
