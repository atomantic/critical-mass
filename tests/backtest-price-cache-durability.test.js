// @ts-check
/**
 * The backtest price cache (`data/<exchange>/<product>-price-cache-<interval>.json`)
 * is the only copy of candle history older than the exchange's retention
 * window: Gemini and Crypto.com stop serving candles past a bounded lookback,
 * and the default backup excludes `*-price-cache*.json`. Two paths used to
 * destroy that history:
 *
 *  - a request for a longer range than the cache held ("need older data")
 *    REPLACED the cache with the full refetch, which carries only what the
 *    exchange still serves (or a gap where a batch request failed);
 *  - `writePriceCache` was a plain `writeFileSync`, so a crash or full disk
 *    mid-write left a truncated file that `readPriceCache` reads as "no
 *    cache", and the next full refetch could not rebuild the lost depth.
 *
 * Fund-data resolution is bound to a tmp root through the
 * `migration.getExchangeDataDir` seam and the Gemini adapter is stubbed, both
 * BEFORE backtest-engine is loaded, because it destructures both at require
 * time.
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

const dailyRow = (day) => ({
  date: new Date(day * DAY).toISOString(),
  timestamp: day * DAY,
  open: day, high: day + 1, low: day - 1, close: day,
  highOfDay: day + 1, lowOfDay: day - 1,
});

describe('backtest price cache never loses accumulated history', () => {
  let tmpRoot;
  let originalGetExchangeDataDir;
  let originalGetAdapter;
  let getCandles;
  let engine;
  let cacheFile;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-price-cache-durability-'));
    originalGetExchangeDataDir = migration.getExchangeDataDir;
    originalGetAdapter = adapters.getAdapter;
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpRoot, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    adapters.getAdapter = () => ({ getCandles: (...args) => getCandles(...args) });
    delete require.cache[ENGINE_PATH];
    engine = require('../src/backtest-engine');
    cacheFile = engine.getCacheFile('daily', EXCHANGE, PRODUCT);
  });

  afterEach(() => {
    migration.getExchangeDataDir = originalGetExchangeDataDir;
    adapters.getAdapter = originalGetAdapter;
    delete require.cache[ENGINE_PATH];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const seedCache = (firstDay, lastDay) => {
    const prices = [];
    for (let d = firstDay; d <= lastDay; d++) prices.push(dailyRow(d));
    engine.writePriceCache(cacheFile, { intervalType: 'daily', exchange: EXCHANGE, productId: PRODUCT, prices });
    return prices;
  };

  it('merges a full refetch into the cache instead of replacing it with the exchange retention window', async (t) => {
    // Cache holds days 40..98, accumulated incrementally over months.
    const seeded = seedCache(40, 98);
    const now = 100 * DAY + 1000; // bucket [99d,100d) is complete
    t.mock.timers.enable({ apis: ['Date'], now });

    // The exchange only serves the last 20 days (days 80..99).
    const retentionStartDay = 80;
    getCandles = async (_productId, startSec, endSec) => {
      const out = [];
      for (let d = retentionStartDay; d * DAY < endSec * 1000; d++) {
        if (d * DAY >= startSec * 1000) out.push({ timestamp: d * DAY, open: d, high: d + 1, low: d - 1, close: d, volume: 1 });
      }
      return out;
    };

    // Asking for 90 days forces the "need older data" full refetch.
    const result = await engine.getPriceData(90, 'daily', EXCHANGE, { productId: PRODUCT });

    const persisted = engine.readPriceCache(cacheFile);
    assert.equal(persisted[0].timestamp, 40 * DAY, 'history older than the retention window must survive');
    assert.equal(persisted[persisted.length - 1].timestamp, 99 * DAY, 'the newly completed bucket is appended');
    assert.equal(persisted.length, 60, 'days 40..99 with no duplicates');
    assert.equal(result.length, 60);
    assert.deepEqual(result.slice(0, seeded.length - 19).map(c => c.timestamp), seeded.slice(0, seeded.length - 19).map(c => c.timestamp));
  });

  it('keeps the cache untouched when the exchange is unreachable during a full refetch', async (t) => {
    const seeded = seedCache(40, 98);
    const before = fs.readFileSync(cacheFile, 'utf8');
    t.mock.timers.enable({ apis: ['Date'], now: 100 * DAY + 1000 });
    getCandles = async () => { throw new Error('503 Service Unavailable'); };

    const result = await engine.getPriceData(90, 'daily', EXCHANGE, { productId: PRODUCT });

    assert.deepEqual(engine.readPriceCache(cacheFile).map(c => c.timestamp), seeded.map(c => c.timestamp));
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).intervals, seeded.length);
    assert.equal(result.length, seeded.length, 'the caller still gets the cached history');
    assert.notEqual(before, '', 'sanity: the seeded file was non-empty');
  });

  it('writePriceCache is atomic: a failed write leaves the previous file intact and no temp file', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root ignores directory permissions' : false }, () => {
    const seeded = seedCache(1, 3);
    const dir = path.dirname(cacheFile);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(cacheFile)], 'a successful write leaves no temp file behind');

    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(() => engine.writePriceCache(cacheFile, { intervalType: 'daily', exchange: EXCHANGE, productId: PRODUCT, prices: [dailyRow(9)] }));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.deepEqual(engine.readPriceCache(cacheFile).map(c => c.timestamp), seeded.map(c => c.timestamp));
    assert.deepEqual(fs.readdirSync(dir), [path.basename(cacheFile)]);
  });
});
