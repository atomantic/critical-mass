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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliation-contract-'));
});

afterEach(() => {
  global.fetch = originalFetch;
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
      traded_quantity: '5000', fee: '2.5', fee_currency: 'USDT',
      create_time: Date.parse('2026-08-23T00:00:00.000Z'), liquidity_indicator: 'MAKER',
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
});
