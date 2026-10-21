// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createCandleCache } = require('../src/candle-cache');

const FAST = { maxRetries: 2, retryIntervalMs: 1, backgroundInitialMs: 5, backgroundMaxMs: 20 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
};

/** Crypto.com-shaped OK response with two candles. */
const okResponse = () => {
  const now = Date.now();
  return {
    ok: true,
    json: async () => ({ result: { data: [
      { t: now - 120_000, o: '100', h: '104', l: '98', c: '101', v: '7' },
      { t: now - 60_000, o: '101', h: '105', l: '99', c: '103', v: '8' },
    ] } }),
  };
};
const isCryptocom = (url) => String(url).includes('api.crypto.com');
const tfOf = (url) => new URL(String(url)).searchParams.get('timeframe');

describe('candle seed retry', () => {
  // The cache's timers are unref'd; a ref'd handle keeps the test runner's loop alive while they run.
  let keepAlive;
  beforeEach(() => { keepAlive = setInterval(() => {}, 1000); });
  afterEach(() => { clearInterval(keepAlive); mock.restoreAll(); });

  it('keeps retrying in the background after the boot attempts are exhausted', async () => {
    let cryptocomCalls = 0;
    let failing = true;
    mock.method(global, 'fetch', async (url) => {
      if (!isCryptocom(url)) return { ok: false, status: 503, json: async () => null };
      cryptocomCalls++;
      if (failing) return { ok: false, status: 503, json: async () => null };
      return okResponse();
    });
    const cache = createCandleCache(FAST);
    try {
      await cache.seedAll();
      assert.equal(cache.getCandles('cryptocom', '1h').length, 0, 'boot attempts all failed');
      failing = false;
      await waitFor(() => cache.getCandles('cryptocom', '1h').length > 0);
      assert.ok(cache.getCandles('cryptocom', '1h').length > 0, 'background retry seeded the buffer');
    } finally {
      cache.stop();
    }
  });

  it('retries only the timeframes that came back empty', async () => {
    const calls = {};
    let failOneHour = true;
    mock.method(global, 'fetch', async (url) => {
      if (!isCryptocom(url)) return { ok: false, status: 503, json: async () => null };
      const tf = tfOf(url);
      calls[tf] = (calls[tf] || 0) + 1;
      if (tf === '1h' && failOneHour) return { ok: false, status: 503, json: async () => null };
      return okResponse();
    });
    const cache = createCandleCache(FAST);
    try {
      await cache.seedAll();
      assert.equal(cache.getCandles('cryptocom', '1h').length, 0);
      assert.ok(cache.getCandles('cryptocom', '1m').length > 0);
      failOneHour = false;
      await waitFor(() => cache.getCandles('cryptocom', '1h').length > 0);
      assert.ok(cache.getCandles('cryptocom', '1h').length > 0, 'failed timeframe was retried');
      assert.equal(calls['1m'], 1, 'successful timeframe was not re-fetched');
      assert.equal(calls['1D'], 1);
    } finally {
      cache.stop();
    }
  });

  it('stop() cancels pending background retries', async () => {
    let calls = 0;
    mock.method(global, 'fetch', async (url) => {
      if (isCryptocom(url)) calls++;
      return { ok: false, status: 503, json: async () => null };
    });
    const cache = createCandleCache(FAST);
    await cache.seedAll();
    cache.stop();
    const before = calls;
    await sleep(60);
    assert.equal(calls, before, 'no fetches after stop()');
  });

  it('invalidate() cancels old retries and does not leave timers holding the process', async () => {
    mock.method(global, 'fetch', async () => ({ ok: false, status: 503, json: async () => null }));
    const cache = createCandleCache(FAST);
    await cache.seedAll();
    await cache.invalidate({ reseed: false });
    let calls = 0;
    mock.method(global, 'fetch', async () => { calls++; return { ok: false, status: 503, json: async () => null }; });
    await sleep(60);
    assert.equal(calls, 0, 'retries from before invalidate are dropped');
    cache.stop();
  });
});
