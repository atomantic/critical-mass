// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

let originalFetch;
let originalDateNow;
let tempDir;

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  originalFetch = global.fetch;
  originalDateNow = Date.now;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliation-contract-'));
});

afterEach(() => {
  global.fetch = originalFetch;
  Date.now = originalDateNow;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const writeKeys = (exchange) => {
  const keysPath = path.join(tempDir, `${exchange}.json`);
  if (exchange === 'coinbase') {
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  } else {
    fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key', apiSecret: 'test-api-secret' }));
  }
  return keysPath;
};

const cases = [
  {
    name: 'coinbase',
    pair: 'ETH-USDC',
    create: createCoinbaseAdapter,
    response: {
      fills: [{
        trade_id: 'cb-trade', order_id: 'cb-order', side: 'BUY', price: '2000',
        size: '400', size_in_quote: true, commission: '1.25',
        trade_time: '2026-08-23T00:00:00.000Z', liquidity_indicator: 'MAKER',
      }],
      has_next: false,
    },
    expected: {
      tradeId: 'cb-trade', orderId: 'cb-order', side: 'buy', price: 2000,
      size: 0.2, quoteAmount: 400, fee: 1.25, feeCurrency: 'USDC',
      timestamp: Date.parse('2026-08-23T00:00:00.000Z'), liquidityIndicator: 'MAKER',
    },
  },
  {
    name: 'gemini',
    pair: 'ETHUSD',
    create: createGeminiAdapter,
    response: [{
      tid: 'gem-trade', order_id: 'gem-order', type: 'Sell', price: '2000', amount: '0.2',
      fee_amount: '1.50', fee_currency: 'USD', timestampms: Date.parse('2026-08-23T00:00:00.000Z'),
      is_maker: false,
    }],
    expected: {
      tradeId: 'gem-trade', orderId: 'gem-order', side: 'sell', price: 2000,
      size: 0.2, quoteAmount: 400, fee: 1.5, feeCurrency: 'USD',
      timestamp: Date.parse('2026-08-23T00:00:00.000Z'), liquidityIndicator: 'TAKER',
    },
  },
  {
    name: 'cryptocom',
    pair: 'CRO-USDT',
    create: createCryptocomAdapter,
    response: { code: 0, result: { data: [{
      trade_id: 'cdc-trade', order_id: 'cdc-order', side: 'BUY', traded_price: '0.08',
      traded_quantity: '5000', fees: '-2.5', fee_instrument_name: 'USDT',
      create_time: Date.parse('2026-08-23T00:00:00.000Z'), taker_side: 'MAKER',
    }] } },
    expected: {
      tradeId: 'cdc-trade', orderId: 'cdc-order', side: 'buy', price: 0.08,
      size: 5000, quoteAmount: 400, fee: 2.5, feeCurrency: 'USDT',
      timestamp: Date.parse('2026-08-23T00:00:00.000Z'), liquidityIndicator: 'MAKER',
    },
  },
];

describe('adapter fill reconciliation contract (issue #252)', () => {
  for (const testCase of cases) {
    it(`${testCase.name} advertises support and returns normalized fills`, async () => {
      const calls = [];
      global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return jsonResponse(testCase.response);
      };

      const adapter = testCase.create(writeKeys(testCase.name));
      assert.equal(adapter.capabilities.fillReconciliation, true);

      const fills = await adapter.getReconciliationFills(testCase.pair, Date.now() - 1000);
      assert.deepEqual(fills, [testCase.expected]);
      assert.equal(calls.length, 1);

      if (testCase.name === 'coinbase') assert.match(calls[0].url, /product_id=ETH-USDC/);
      if (testCase.name === 'gemini') {
        const payload = JSON.parse(Buffer.from(calls[0].options.headers['X-GEMINI-PAYLOAD'], 'base64').toString());
        assert.equal(payload.symbol, 'ethusd');
      }
      if (testCase.name === 'cryptocom') {
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.params.instrument_name, 'CRO_USDT');
      }
    });
  }

  it('coinbase follows more than 50 cursors without silently truncating', async () => {
    let page = 0;
    global.fetch = async () => {
      page++;
      return jsonResponse({
        fills: [{
          trade_id: `trade-${page}`, order_id: `order-${page}`, side: 'BUY',
          price: '1', size: '1', commission: '0', trade_time: '2026-08-23T00:00:00Z',
        }],
        cursor: page < 51 ? `cursor-${page}` : '',
        has_next: page < 51,
      });
    };

    const adapter = createCoinbaseAdapter(writeKeys('coinbase'));
    const fills = await adapter.getReconciliationFills('BTC-USDC', Date.now() - 1000);
    assert.equal(page, 51);
    assert.equal(fills.length, 51);
  });

  it('coinbase rejects a repeated cursor instead of returning incomplete fills', async () => {
    let page = 0;
    global.fetch = async () => {
      page++;
      return jsonResponse({
        fills: [],
        cursor: 'stuck-cursor',
        has_next: true,
      });
    };

    const adapter = createCoinbaseAdapter(writeKeys('coinbase'));
    await assert.rejects(
      adapter.getReconciliationFills('BTC-USDC', Date.now() - 1000),
      /cursor repeated/,
    );
    assert.equal(page, 2);
  });

  it('cryptocom splits saturated windows until every response is below the API cap', async () => {
    const now = Date.parse('2026-08-23T02:00:00.000Z');
    Date.now = () => now;
    let call = 0;
    global.fetch = async (_url, options = {}) => {
      call++;
      const body = JSON.parse(options.body);
      const spanNs = BigInt(body.params.end_time) - BigInt(body.params.start_time);
      const hourNs = 60n * 60n * 1000n * 1_000_000n;
      const data = spanNs >= hourNs
        ? Array.from({ length: 100 }, (_, index) => ({ trade_id: `saturated-${call}-${index}` }))
        : [{
          trade_id: `trade-${body.params.start_time}`, order_id: `order-${call}`, side: 'SELL',
          traded_price: '2', traded_quantity: '3', fees: '-0.25', fee_instrument_name: 'USDT',
          create_time: now, taker_side: 'TAKER',
        }];
      return jsonResponse({ code: 0, result: { data } });
    };

    const adapter = createCryptocomAdapter(writeKeys('cryptocom'));
    const fills = await adapter.getReconciliationFills('CRO-USDT', now - 2 * 60 * 60 * 1000);
    assert.ok(call > 2, 'the saturated range should be subdivided');
    assert.ok(fills.length > 1);
    assert.ok(fills.every(fill => fill.fee === 0.25));
  });
});
