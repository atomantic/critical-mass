// @ts-check
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createCandleCache } = require('../src/candle-cache');

describe('Gemini public candle seeding', () => {
  afterEach(() => mock.restoreAll());

  it('seedAll fetches supported Gemini intervals and stores normalized candles', async () => {
    const calls = [];
    mock.method(global, 'fetch', async (url) => {
      calls.push(String(url));
      const now = Date.now();
      if (String(url).includes('api.gemini.com')) {
        return {
          ok: true,
          json: async () => [
            [now - 60_000, '101', '105', '99', '103', '8.5'],
            [now - 120_000, '100', '104', '98', '101', '7.25'],
          ],
        };
      }
      if (String(url).includes('api.crypto.com')) {
        return {
          ok: true,
          json: async () => ({ result: { data: [
            { t: now - 120_000, o: '100', h: '104', l: '98', c: '101', v: '7.25' },
          ] } }),
        };
      }
      return {
        ok: true,
        json: async () => [[Math.floor((now - 120_000) / 1000), 98, 104, 100, 101, 7.25]],
      };
    });

    const cache = createCandleCache();
    await cache.seedAll();

    const candles = cache.getCandles('gemini', '1m');
    assert.ok(candles.length > 0, 'Gemini should have a completed normalized 1m seed');
    assert.deepStrictEqual(
      Object.keys(candles[0]).sort(),
      ['close', 'high', 'low', 'open', 'timestamp', 'volume'].sort(),
    );
    for (const value of Object.values(candles[0])) assert.equal(Number.isFinite(value), true);
    assert.ok(calls.some(url => url.endsWith('/candles/btcusd/1hr')));
    assert.ok(calls.some(url => url.endsWith('/candles/btcusd/1day')));
  });
});
