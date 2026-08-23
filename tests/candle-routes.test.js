// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const registerCandleRoutes = require('../src/routes/candle-routes');

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

describe('GET /api/candles/:candleExchange', () => {
  it('serves Gemini candles already accepted by the shared cache', () => {
    let handler;
    const expected = [{ timestamp: 1, close: 123 }];
    registerCandleRoutes({ get: (_path, fn) => { handler = fn; } }, {
      candleCache: {
        getCandles: (exchange, timeframe) => exchange === 'gemini' && timeframe === '1m' ? expected : [],
        getAllCandles: () => ({}),
      },
    });
    const res = createRes();
    handler({ params: { candleExchange: 'gemini' }, query: { tf: '1m' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, candles: expected });
  });
});
