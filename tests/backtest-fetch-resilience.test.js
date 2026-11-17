// @ts-check
/**
 * #1500 — transient exchange failures must not discard usable data or hold a
 * simulation slot: a failed incremental top-up serves the cached prices marked
 * stale, a full fetch stops after consecutive failed batches, and an optimizer
 * interval without data is skipped (and named) instead of aborting the run.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const adapters = require('../src/adapters');

const DAY = 24 * 60 * 60 * 1000;
const EXCHANGE = 'gemini';
const PRODUCT = 'BTCUSD';
const ENGINE_PATH = require.resolve('../src/backtest-engine');
const OPTIMIZER_PATH = require.resolve('../src/optimizer-engine');

const dailyRow = (day) => ({
  date: new Date(day * DAY).toISOString(),
  timestamp: day * DAY,
  open: 100 + day, high: 102 + day, low: 98 + day, close: 100 + day,
  highOfDay: 102 + day, lowOfDay: 98 + day,
});

describe('#1500 candle fetch resilience', () => {
  let tmpRoot;
  let originalGetExchangeDataDir;
  let originalGetAdapter;
  let getCandles;
  let engine;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fetch-resilience-'));
    originalGetExchangeDataDir = migration.getExchangeDataDir;
    originalGetAdapter = adapters.getAdapter;
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpRoot, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    adapters.getAdapter = () => ({ getCandles: (...args) => getCandles(...args) });
    delete require.cache[ENGINE_PATH];
    delete require.cache[OPTIMIZER_PATH];
    engine = require('../src/backtest-engine');
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    adapters.getAdapter = originalGetAdapter;
    delete require.cache[ENGINE_PATH];
    delete require.cache[OPTIMIZER_PATH];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const seedDaily = (firstDay, lastDay) => {
    const prices = [];
    for (let d = firstDay; d <= lastDay; d++) prices.push(dailyRow(d));
    const file = engine.getCacheFile('daily', EXCHANGE, PRODUCT);
    engine.writePriceCache(file, { intervalType: 'daily', exchange: EXCHANGE, productId: PRODUCT, prices });
    return prices;
  };

  it('returns cached prices marked stale when the incremental fetch rejects', async (t) => {
    const seeded = seedDaily(40, 98);
    t.mock.timers.enable({ apis: ['Date'], now: 100 * DAY + 1000 });
    getCandles = async () => { throw new Error('ETIMEDOUT'); };

    const freshness = {};
    const result = await engine.getPriceData(30, 'daily', EXCHANGE, { productId: PRODUCT, freshness });

    assert.equal(result.length, 30);
    assert.equal(result[result.length - 1].timestamp, seeded[seeded.length - 1].timestamp);
    assert.equal(freshness.stale, true);
    assert.match(freshness.staleReason, /ETIMEDOUT/);
  });

  it('does not mark fresh data stale', async (t) => {
    seedDaily(40, 98);
    t.mock.timers.enable({ apis: ['Date'], now: 100 * DAY + 1000 });
    getCandles = async () => [];
    const freshness = {};
    await engine.getPriceData(30, 'daily', EXCHANGE, { productId: PRODUCT, freshness });
    assert.equal(freshness.stale, undefined);
  });

  it('stops a Coinbase full fetch after the consecutive-failure limit', async () => {
    let calls = 0;
    getCandles = async () => { calls++; throw new Error('Coinbase API error (503): Service Unavailable'); };
    // 1000 10min intervals = 2000 raw candles = 7 batches if it never stopped early.
    const out = await engine.fetchPriceData(1000, '10min', 'coinbase', 'BTC-USDC');
    assert.deepEqual(out, []);
    assert.equal(calls, engine.MAX_CONSECUTIVE_FETCH_FAILURES);
  });

  it('does not add a backtest-level 429 backoff on top of the Coinbase adapter retry', async () => {
    let calls = 0;
    getCandles = async () => { calls++; throw Object.assign(new Error('Coinbase API error (429): rate limit'), { status: 429 }); };
    const started = Date.now();
    // Default backoff is 2s x failure count (6s total); the adapter owns Coinbase retries so none is added here.
    const out = await engine.fetchPriceData(2000, 'daily', 'coinbase', 'BTC-USDC');
    assert.deepEqual(out, []);
    assert.equal(calls, engine.MAX_CONSECUTIVE_FETCH_FAILURES);
    assert.ok(Date.now() - started < 1500, 'no extra rate-limit sleep for Coinbase');
  });

  it('fetches Coinbase candles through the adapter and returns the same aggregated rows', async (t) => {
    const intervalMs = 3600 * 1000;
    const base = 1700000000000 - (1700000000000 % intervalMs);
    const raw = [0, 1, 2].map(i => ({
      timestamp: base + i * intervalMs, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 5,
    }));
    t.mock.timers.enable({ apis: ['Date'], now: base + 10 * intervalMs });
    const seen = [];
    getCandles = async (productId, start, end, granularity) => { seen.push({ productId, start, end, granularity }); return raw; };

    const out = await engine.fetchPriceData(3, '1hour', 'coinbase', 'BTC-USDC');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].productId, 'BTC-USDC');
    assert.equal(seen[0].granularity, 'ONE_HOUR');
    assert.equal(seen[0].end - seen[0].start, 3 * 3600);
    assert.deepEqual(out.map(r => [r.timestamp, r.open, r.high, r.low, r.close]),
      raw.map(c => [c.timestamp, c.open, c.high, c.low, c.close]));
  });

  it('backs off and retries on 429 before giving up', async () => {
    let calls = 0;
    getCandles = async () => { calls++; throw new Error('Gemini API error (429): rate limit'); };
    const out = await engine.fetchPriceData(2000, 'daily', EXCHANGE, PRODUCT, { rateLimitBackoffMs: 1 });
    assert.deepEqual(out, []);
    assert.equal(calls, engine.MAX_CONSECUTIVE_FETCH_FAILURES);
  });

  it('honours the overall deadline', async () => {
    let calls = 0;
    getCandles = async () => { calls++; return [{ timestamp: Date.now(), open: 1, high: 1, low: 1, close: 1, volume: 1 }]; };
    await engine.fetchPriceData(10, 'daily', EXCHANGE, PRODUCT, { deadlineMs: -1 });
    assert.equal(calls, 0);
  });

  it('optimizer skips an interval with no data and names it', async (t) => {
    seedDaily(0, 400);
    getCandles = async () => { throw new Error('exchange down'); };
    const { runOptimizer } = require('../src/optimizer-engine');

    const out = await runOptimizer({
      fundSize: 10000, exchange: EXCHANGE, productId: PRODUCT,
      intervals: ['daily', '4hour'], markups: [2], periods: ['30D'],
    });

    assert.ok(out.results.length > 0);
    assert.ok(out.results.every(r => r.params.intervalType === 'daily'));
    assert.equal(out.skippedIntervals.length, 1);
    assert.equal(out.skippedIntervals[0].intervalType, '4hour');
    assert.equal(out.totalCombinations, out.results.length);
  });

  it('optimizer throws a descriptive error when every interval is empty', async () => {
    getCandles = async () => { throw new Error('exchange down'); };
    const { runOptimizer } = require('../src/optimizer-engine');
    await assert.rejects(
      runOptimizer({ exchange: EXCHANGE, productId: PRODUCT, intervals: ['4hour'], markups: [2], periods: ['30D'] }),
      /4hour/
    );
  });
});
