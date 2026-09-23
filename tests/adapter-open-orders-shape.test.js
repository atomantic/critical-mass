// @ts-check
// Regression test for issue #684: getOpenOrders() returned a different shape
// on each exchange adapter, so Gemini's orphan-sell detector (which gates on
// `o.size > 0`) could never fire (`undefined > 0` is false), and Coinbase
// reported a partially-filled order at its ORIGINAL size instead of what's
// still remaining on the book.
//
// All three adapters must now report `size` as the REMAINING unfilled base
// quantity, plus `originalSize` (what the order was placed for) and `price`.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createCoinbaseAdapter } = require('../src/adapters/coinbase/api');
const { createGeminiAdapter } = require('../src/adapters/gemini/api');
const { createCryptocomAdapter } = require('../src/adapters/cryptocom/api');

// One partially-filled sell shared by every adapter's fixture: originally
// placed for 1.0, 0.25 filled so far, limit price 100 — remaining 0.75.
const ORIGINAL = 1;
const FILLED = 0.25;
const PRICE = 100;
const REMAINING = ORIGINAL - FILLED;

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('adapter getOpenOrders() shape parity (issue #684)', () => {
  it('Coinbase reports the remaining unfilled size, plus originalSize and price', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keysPath = path.join(os.tmpdir(), `coinbase-open-orders-shape-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
    try {
      const adapter = createCoinbaseAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          orders: [{
            order_id: 'CB-1',
            product_id: 'BTC-USDC',
            side: 'SELL',
            status: 'OPEN',
            filled_size: String(FILLED),
            created_time: '2026-01-01T00:00:00Z',
            order_configuration: {
              limit_limit_gtc: { base_size: String(ORIGINAL), limit_price: String(PRICE) },
            },
          }],
        }),
      });

      const orders = await adapter.getOpenOrders('BTC-USDC');
      assert.equal(orders.length, 1);
      assert.equal(orders[0].side, 'SELL');
      assert.equal(orders[0].size, REMAINING);
      assert.equal(orders[0].originalSize, ORIGINAL);
      assert.equal(orders[0].price, PRICE);
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });

  it('Coinbase clamps size at zero instead of going negative when an unrecognized order_configuration leaves originalSize at its 0 fallback', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keysPath = path.join(os.tmpdir(), `coinbase-open-orders-shape-clamp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ name: 'organizations/test/apiKeys/test-key', privateKey }));
    try {
      const adapter = createCoinbaseAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          orders: [{
            order_id: 'CB-2',
            product_id: 'BTC-USDC',
            side: 'SELL',
            status: 'OPEN',
            filled_size: String(FILLED), // nonzero filled...
            created_time: '2026-01-01T00:00:00Z',
            order_configuration: {}, // ...but no recognized shape, so originalSize falls back to 0
          }],
        }),
      });

      const orders = await adapter.getOpenOrders('BTC-USDC');
      assert.equal(orders.length, 1);
      assert.equal(orders[0].originalSize, 0);
      assert.equal(orders[0].size, 0, 'size must clamp at 0, not go negative (0 - FILLED)');
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });

  it('Gemini reports the remaining unfilled size, plus originalSize and price', async () => {
    const keysPath = path.join(os.tmpdir(), `gemini-open-orders-shape-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
    try {
      const adapter = createGeminiAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{
          order_id: 555,
          symbol: 'btcusd',
          side: 'sell',
          is_live: true,
          executed_amount: String(FILLED),
          original_amount: String(ORIGINAL),
          remaining_amount: String(REMAINING),
          price: String(PRICE),
          timestampms: 1750000000000,
        }]),
      });

      const orders = await adapter.getOpenOrders('BTC-USD');
      assert.equal(orders.length, 1);
      assert.equal(orders[0].side, 'SELL');
      assert.equal(orders[0].size, REMAINING);
      assert.equal(orders[0].originalSize, ORIGINAL);
      assert.equal(orders[0].price, PRICE);
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });

  it('Gemini falls back to original_amount - executed_amount when remaining_amount is absent', async () => {
    const keysPath = path.join(os.tmpdir(), `gemini-open-orders-shape-fallback-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
    try {
      const adapter = createGeminiAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{
          order_id: 556,
          symbol: 'btcusd',
          side: 'sell',
          is_live: true,
          executed_amount: String(FILLED),
          original_amount: String(ORIGINAL),
          price: String(PRICE),
          timestampms: 1750000000000,
        }]),
      });

      const orders = await adapter.getOpenOrders('BTC-USD');
      assert.equal(orders.length, 1);
      assert.equal(orders[0].size, REMAINING);
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });

  it('Gemini never yields NaN for size when remaining/original/executed amounts are all absent (would silently defeat the orphan-sell `o.size > 0` gate exactly like the original undefined bug)', async () => {
    const keysPath = path.join(os.tmpdir(), `gemini-open-orders-shape-nan-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
    try {
      const adapter = createGeminiAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{
          order_id: 557,
          symbol: 'btcusd',
          side: 'sell',
          is_live: true,
          timestampms: 1750000000000,
        }]),
      });

      const orders = await adapter.getOpenOrders('BTC-USD');
      assert.equal(orders.length, 1);
      assert.ok(Number.isFinite(orders[0].size), `size must be a finite number, got ${orders[0].size}`);
      assert.equal(orders[0].size, 0);
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });

  it('Gemini falls back to original_amount - executed_amount when remaining_amount is present but unparseable', async () => {
    const keysPath = path.join(os.tmpdir(), `gemini-open-orders-shape-malformed-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
    try {
      const adapter = createGeminiAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([{
          order_id: 558,
          symbol: 'btcusd',
          side: 'sell',
          is_live: true,
          executed_amount: String(FILLED),
          original_amount: String(ORIGINAL),
          remaining_amount: '', // present but unparseable — must not defeat the o.size > 0 gate via NaN
          price: String(PRICE),
          timestampms: 1750000000000,
        }]),
      });

      const orders = await adapter.getOpenOrders('BTC-USD');
      assert.equal(orders.length, 1);
      assert.ok(Number.isFinite(orders[0].size), `size must be a finite number, got ${orders[0].size}`);
      assert.equal(orders[0].size, REMAINING);
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });

  it('Crypto.com reports the remaining unfilled size, plus originalSize and price', async () => {
    const keysPath = path.join(os.tmpdir(), `cryptocom-open-orders-shape-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(keysPath, JSON.stringify({ apiKey: 'test-api-key-123', apiSecret: 'test-api-secret-456' }));
    try {
      const adapter = createCryptocomAdapter(keysPath);
      global.fetch = async () => ({
        ok: true,
        text: async () => JSON.stringify({
          code: 0,
          result: {
            data: [{
              order_id: 'CDC-1',
              instrument_name: 'BTC_USD',
              side: 'SELL',
              quantity: String(ORIGINAL),
              cumulative_quantity: String(FILLED),
              price: String(PRICE),
              create_time: 1750000000000,
            }],
          },
        }),
      });

      const orders = await adapter.getOpenOrders('BTC-USD');
      assert.equal(orders.length, 1);
      assert.equal(orders[0].side, 'SELL');
      assert.equal(orders[0].size, REMAINING);
      assert.equal(orders[0].originalSize, ORIGINAL);
      assert.equal(orders[0].price, PRICE);
    } finally {
      fs.rmSync(keysPath, { force: true });
    }
  });
});
