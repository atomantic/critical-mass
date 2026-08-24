// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

let keysPath;
let originalFetch;

beforeEach(() => {
  keysPath = path.join(os.tmpdir(), `cryptocom-order-keys-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(keysPath, { force: true });
});

const stubProduct = (adapter) => {
  adapter.getProductDetails = async () => ({
    baseIncrement: '0.001',
    quoteIncrement: '0.01',
    baseMinSize: '0.01',
    price: 100,
  });
};

describe('Crypto.com shared limit-order placement', () => {
  it('preserves buy/sell payload differences and post-only behavior', async () => {
    const adapter = createCryptocomAdapter(keysPath);
    stubProduct(adapter);
    const params = [];
    global.fetch = async (url, options) => {
      params.push(JSON.parse(options.body).params);
      return {
        ok: true,
        text: async () => JSON.stringify({ code: 0, result: { order_id: '12345678901234567' } }),
      };
    };

    const buy = await adapter.placeLimitBuy('BTC-USD', 0.0199, 100.019);
    const sell = await adapter.placeLimitSell('BTC-USD', 0.0199, 100.019, { postOnly: false });

    assert.equal(buy.success, true);
    assert.equal(sell.success, true);
    assert.deepEqual(params.map(p => p.side), ['BUY', 'SELL']);
    assert.deepEqual(params.map(p => p.quantity), ['0.019', '0.019']);
    assert.deepEqual(params.map(p => p.price), ['100.01', '100.01']);
    assert.deepEqual(params[0].exec_inst, ['POST_ONLY']);
    assert.deepEqual(params[1].exec_inst, []);
  });

  it('rejects an undersized sell before sending it to the exchange', async () => {
    const adapter = createCryptocomAdapter(keysPath);
    stubProduct(adapter);
    let fetchCount = 0;
    global.fetch = async () => { fetchCount++; throw new Error('must not fetch'); };

    const result = await adapter.placeLimitSell('BTC-USD', 0.0099, 100);

    assert.equal(result.success, false);
    assert.match(result.errorMessage, /below minimum 0.01/);
    assert.ok(Math.abs(result.baseSize - 0.009) < 1e-12);
    assert.equal(fetchCount, 0);
  });
});
