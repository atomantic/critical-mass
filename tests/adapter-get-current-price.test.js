// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

// getCurrentPrice feeds safety gates (DCA maxBuyPrice, post-only sell
// adjustment) whose comparisons are false for NaN/0, so a blank ticker must
// throw rather than return a value that silently bypasses them.

let tempDir;
let originalFetch;
let coinbase;
let gemini;
let cryptocom;

const okJson = (body) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-price-'));
  originalFetch = global.fetch;

  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cbKeys = path.join(tempDir, 'coinbase.json');
  fs.writeFileSync(cbKeys, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
  const stdKeys = path.join(tempDir, 'std.json');
  fs.writeFileSync(stdKeys, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));

  coinbase = createCoinbaseAdapter(cbKeys);
  gemini = createGeminiAdapter(stdKeys);
  cryptocom = createCryptocomAdapter(stdKeys);
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Coinbase getCurrentPrice', () => {
  it('returns a valid price', async () => {
    global.fetch = async () => okJson({ price: '50000.5' });
    assert.equal(await coinbase.getCurrentPrice('BTC-USDC'), 50000.5);
  });

  for (const [label, body] of [['empty payload', {}], ['blank price', { price: '' }], ['zero price', { price: '0' }], ['negative price', { price: '-1' }], ['null payload', null]]) {
    it(`throws on ${label}`, async () => {
      global.fetch = async () => okJson(body);
      await assert.rejects(() => coinbase.getCurrentPrice('BTC-USDC'), { code: 'PRICE_UNAVAILABLE', message: /^Price temporarily unavailable from coinbase for BTC-USDC/ });
    });
  }
});

describe('Gemini getCurrentPrice', () => {
  it('returns a valid price', async () => {
    global.fetch = async () => okJson({ last: '2500.25' });
    assert.equal(await gemini.getCurrentPrice('ETH-USD'), 2500.25);
  });

  for (const [label, body] of [['empty payload', {}], ['blank last', { last: '' }], ['zero last', { last: '0.00' }], ['non-numeric last', { last: 'n/a' }]]) {
    it(`throws on ${label}`, async () => {
      global.fetch = async () => okJson(body);
      await assert.rejects(() => gemini.getCurrentPrice('ETH-USD'), { code: 'PRICE_UNAVAILABLE', message: /^Price temporarily unavailable from gemini for ETH-USD/ });
    });
  }
});

describe('Crypto.com getCurrentPrice', () => {
  const tickers = (t) => okJson({ code: 0, result: { data: [{ i: 'BTC_USDT', ...t }] } });

  it('returns the last price, falling back to bid when blank', async () => {
    global.fetch = async () => tickers({ a: '61000.5', b: '60000' });
    assert.equal(await cryptocom.getCurrentPrice('BTC-USDT'), 61000.5);
    global.fetch = async () => tickers({ b: '60000' });
    assert.equal(await cryptocom.getCurrentPrice('BTC-USDT'), 60000);
  });

  for (const [label, t] of [['no price fields', {}], ['blank price fields', { a: '', b: '' }], ['zero price', { a: '0', b: '0' }]]) {
    it(`throws on ${label} instead of returning 0`, async () => {
      global.fetch = async () => tickers(t);
      await assert.rejects(() => cryptocom.getCurrentPrice('BTC-USDT'), { code: 'PRICE_UNAVAILABLE', message: /^Price temporarily unavailable from cryptocom for BTC-USDT/ });
    });
  }
});

// getProductDetails reports an unusable ticker as price:null (limit placements
// only need the increments); the one caller that prices off it, placeMarketBuy,
// must then refuse with PRICE_UNAVAILABLE without touching the order endpoint.
describe('Gemini getProductDetails / placeMarketBuy with an unusable ticker', () => {
  const route = (ticker, orderCalls) => async (url) => {
    const u = String(url);
    if (u.includes('/v1/symbols/details/')) {
      return okJson({ tick_size: 0.0001, quote_increment: 0.01, min_order_size: '0.001' });
    }
    if (u.includes('/v1/pubticker/')) return okJson(ticker);
    if (u.includes('/v1/order/new')) { orderCalls.push(u); return okJson({}); }
    throw new Error(`unexpected endpoint ${u}`);
  };

  it('returns the increments and a numeric price when the ticker is usable', async () => {
    global.fetch = route({ last: '2500.25' }, []);
    const details = await gemini.getProductDetails('ETH-USD');
    assert.equal(details.price, 2500.25);
    assert.equal(details.baseIncrement, '0.0001');
    assert.equal(details.baseMinSize, '0.001');
  });

  for (const [label, ticker] of [['blank last', { last: '' }], ['zero last', { last: '0.00' }]]) {
    it(`returns price:null instead of throwing on ${label}, and placeMarketBuy throws PRICE_UNAVAILABLE`, async () => {
      const orderCalls = [];
      global.fetch = route(ticker, orderCalls);
      const details = await gemini.getProductDetails('ETH-USD');
      assert.equal(details.price, null);
      assert.equal(details.baseIncrement, '0.0001');
      assert.equal(details.quoteIncrement, '0.01');

      await assert.rejects(() => gemini.placeMarketBuy('ETH-USD', 100), { code: 'PRICE_UNAVAILABLE' });
      assert.deepEqual(orderCalls, [], 'no order may be sent without a price');
    });
  }
});

describe('Crypto.com getProductDetails / placeMarketBuy with an unusable ticker', () => {
  const route = (ticker, orderCalls) => async (url) => {
    const u = String(url);
    if (u.includes('public/get-instruments')) {
      return okJson({ code: 0, result: { data: [{ symbol: 'BTC_USDT', qty_tick_size: '0.0001', price_tick_size: '0.1', min_quantity: '0.001' }] } });
    }
    if (u.includes('public/get-tickers')) return okJson({ code: 0, result: { data: [{ i: 'BTC_USDT', ...ticker }] } });
    if (u.includes('private/create-order')) { orderCalls.push(u); return okJson({ code: 0, result: { order_id: '1' } }); }
    throw new Error(`unexpected endpoint ${u}`);
  };

  it('returns the increments and a numeric price when the ticker is usable', async () => {
    global.fetch = route({ a: '61000.5' }, []);
    const details = await cryptocom.getProductDetails('BTC-USDT');
    assert.equal(details.price, 61000.5);
    assert.equal(details.baseIncrement, '0.0001');
    assert.equal(details.quoteIncrement, '0.1');
    assert.equal(details.baseMinSize, '0.001');
  });

  for (const [label, ticker] of [['no price fields', {}], ['zero price', { a: '0', b: '0' }]]) {
    it(`returns price:null instead of throwing on ${label}, and placeMarketBuy throws PRICE_UNAVAILABLE`, async () => {
      const orderCalls = [];
      global.fetch = route(ticker, orderCalls);
      const details = await cryptocom.getProductDetails('BTC-USDT');
      assert.equal(details.price, null);
      assert.equal(details.baseIncrement, '0.0001');
      assert.equal(details.quoteIncrement, '0.1');

      await assert.rejects(() => cryptocom.placeMarketBuy('BTC-USDT', 100), { code: 'PRICE_UNAVAILABLE' });
      assert.deepEqual(orderCalls, [], 'no order may be sent without a price');
    });
  }

  it('still propagates a non-price failure from the ticker lookup', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('public/get-instruments')) return okJson({ code: 0, result: { data: [{ symbol: 'BTC_USDT' }] } });
      return okJson({ code: 0, result: { data: [] } });
    };
    await assert.rejects(() => cryptocom.getProductDetails('BTC-USDT'), /Ticker not found/);
  });
});
