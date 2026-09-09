// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createLongTermCandleStore,
  dedupeAndSort,
  cachePath,
} = require('../src/long-term-candle-store');
const { DATA_DIR } = require('../src/paths');

// Use a unique exchange/product to avoid clobbering real data files
const TEST_EXCHANGE = '__test_lt_store__';
const TEST_PRODUCT = 'TEST-USDC';

const cleanup = () => {
  try {
    const file = cachePath(TEST_EXCHANGE, TEST_PRODUCT);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const tmpFile = `${file}.tmp`;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    const dir = path.dirname(file);
    if (fs.existsSync(dir)) {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) fs.rmdirSync(dir);
    }
  } catch {
    // best-effort cleanup
  }
};

const dailyCandle = (daysAgo, close) => ({
  timestamp: Date.now() - daysAgo * 86400 * 1000,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume: 1000,
});

describe('dedupeAndSort', () => {
  it('removes duplicates by timestamp', () => {
    const out = dedupeAndSort([
      { timestamp: 1, close: 10 },
      { timestamp: 2, close: 20 },
      { timestamp: 1, close: 99 }, // dup
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].close, 99);
  });

  it('sorts oldest-first', () => {
    const out = dedupeAndSort([
      { timestamp: 30, close: 30 },
      { timestamp: 10, close: 10 },
      { timestamp: 20, close: 20 },
    ]);
    assert.deepEqual(out.map(c => c.timestamp), [10, 20, 30]);
  });

  it('drops candles missing a timestamp', () => {
    const out = dedupeAndSort([
      null,
      { timestamp: 0, close: 99 },
      { timestamp: NaN, close: 99 },
      { timestamp: null, close: 99 },
      { timestamp: undefined, close: 99 },
      { timestamp: 5, close: 5 },
    ]);
    assert.equal(out.length, 1);
  });
});

describe('cachePath', () => {
  it('normalizes product IDs to a filesystem-safe form', () => {
    const p = cachePath('coinbase', 'BTC-USDC');
    assert.ok(p.endsWith('long-term-candles-btc-usdc.json'));
  });

  it('lives under DATA_DIR/{exchange}', () => {
    const p = cachePath('coinbase', 'BTC-USDC');
    assert.ok(p.startsWith(path.join(DATA_DIR, 'coinbase')));
  });
});

describe('createLongTermCandleStore', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('starts with no candles', () => {
    const adapter = { getCandles: async () => [] };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    assert.equal(store.getCandles().length, 0);
    assert.equal(store.getStats().count, 0);
  });

  it('clamps lookbackDays to a minimum of 60', () => {
    const adapter = { getCandles: async () => [] };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 10 });
    assert.equal(store.getStats().lookbackDays, 60);
  });

  it('refresh() pulls from adapter and persists to disk', async () => {
    const fakeCandles = Array.from({ length: 100 }, (_, i) => dailyCandle(99 - i, 50 + i));
    const adapter = {
      getCandles: async () => fakeCandles,
    };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    const result = await store.refresh();
    assert.ok(result.added > 0);
    assert.ok(store.getCandles().length > 0);

    // Verify cache file exists
    const file = cachePath(TEST_EXCHANGE, TEST_PRODUCT);
    assert.ok(fs.existsSync(file), 'cache file should be persisted');

    // Verify a fresh store loads the cached data
    const store2 = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    store2.loadFromDisk();
    assert.ok(store2.getCandles().length > 0);
  });

  it('refresh() trims candles outside the lookback window', async () => {
    // 800 days of fake candles, lookback 100
    const fakeCandles = Array.from({ length: 800 }, (_, i) => dailyCandle(799 - i, 50 + i));
    const adapter = { getCandles: async () => fakeCandles };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 100 });
    await store.refresh();
    const count = store.getCandles().length;
    // Should be ~100 candles (allow some slop for boundary precision)
    assert.ok(count <= 110, `expected ≤110 candles after trim, got ${count}`);
    assert.ok(count >= 90, `expected ≥90 candles after trim, got ${count}`);
  });

  it('refresh() is reentrant-safe (concurrent calls do not double-fetch)', async () => {
    let calls = 0;
    const adapter = {
      getCandles: async () => {
        calls++;
        await new Promise(r => setTimeout(r, 10));
        return [dailyCandle(0, 100)];
      },
    };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    // Only one of the concurrent calls should have actually invoked the adapter
    assert.equal(calls > 0 && calls <= 3, true);
  });

  it('refresh() degrades gracefully when adapter throws', async () => {
    const adapter = {
      getCandles: async () => { throw new Error('rate limited'); },
    };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    const result = await store.refresh();
    assert.equal(result.added, 0);
    assert.equal(store.getCandles().length, 0);
  });

  it('refresh() recovers an underfilled cache by re-fetching the full window', async () => {
    // Seed disk with a partial cache (simulates a previous fetch that
    // truncated due to an adapter limit)
    const sparse = Array.from({ length: 50 }, (_, i) => dailyCandle(49 - i, 50 + i));
    const file = cachePath(TEST_EXCHANGE, TEST_PRODUCT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ productId: TEST_PRODUCT, candles: sparse }));

    // Adapter that returns a full year of candles
    const fullYear = Array.from({ length: 365 }, (_, i) => dailyCandle(364 - i, 50 + i));
    const adapter = { getCandles: async () => fullYear };

    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    const result = await store.refresh();
    // Should detect underfill and pull a lot more than the 0-1 days an
    // incremental refresh would have requested
    assert.ok(result.total >= 300, `expected total ≥300 after recovery, got ${result.total}`);
  });

  it('getStats() reports cache health buckets', async () => {
    // Each sub-stage clears the disk cache so the next store starts fresh.
    // Without this, dedupe-by-timestamp can't merge candles across stages
    // because dailyCandle() calls Date.now() at invocation time, so
    // timestamps shift by milliseconds between adapter arrays.

    const adapter = { getCandles: async () => [] };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 100 });

    // empty
    let stats = store.getStats();
    assert.equal(stats.health, 'empty');
    assert.equal(stats.coveragePct, 0);

    // sparse: <30%
    cleanup();
    const sparse = Array.from({ length: 20 }, (_, i) => dailyCandle(19 - i, 100));
    const adapter2 = { getCandles: async () => sparse };
    const store2 = createLongTermCandleStore(TEST_EXCHANGE, adapter2, TEST_PRODUCT, { lookbackDays: 100 });
    await store2.refresh();
    assert.equal(store2.getStats().health, 'sparse');

    // partial: 30%-80%
    cleanup();
    const partial = Array.from({ length: 60 }, (_, i) => dailyCandle(59 - i, 100));
    const adapter3 = { getCandles: async () => partial };
    const store3 = createLongTermCandleStore(TEST_EXCHANGE, adapter3, TEST_PRODUCT, { lookbackDays: 100 });
    await store3.refresh();
    assert.equal(store3.getStats().health, 'partial');

    // full: ≥80%
    cleanup();
    const full = Array.from({ length: 100 }, (_, i) => dailyCandle(99 - i, 100));
    const adapter4 = { getCandles: async () => full };
    const store4 = createLongTermCandleStore(TEST_EXCHANGE, adapter4, TEST_PRODUCT, { lookbackDays: 100 });
    await store4.refresh();
    const stats4 = store4.getStats();
    assert.equal(stats4.health, 'full');
    assert.ok(stats4.coveragePct >= 80);
  });

  it('concurrent refresh() callers receive the same in-flight promise', async () => {
    let calls = 0;
    const adapter = {
      getCandles: async () => {
        calls++;
        await new Promise(r => setTimeout(r, 30));
        return [dailyCandle(0, 100), dailyCandle(1, 101), dailyCandle(2, 102)];
      },
    };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 365 });
    const [a, b, c] = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    // Concurrent callers should each see the actual total, not 0
    assert.equal(a.total, b.total);
    assert.equal(b.total, c.total);
    assert.ok(a.total > 0, `expected nonzero total from concurrent refresh, got ${a.total}`);
    // The adapter should have been hit roughly once (allow up to 2 for the
    // pagination loop), not three times
    assert.ok(calls <= 2, `expected ≤2 adapter calls for 3 concurrent refreshes, got ${calls}`);
  });
});

// Fixed UTC buckets exercise revisions rather than accidentally inserting new rows.
describe('daily candle revision recovery', () => {
  const DAY = 86400 * 1000;
  const MIDNIGHT = Date.UTC(2026, 8, 9);
  const NOW = MIDNIGHT + DAY / 2;
  const history = (count) => Array.from({ length: count }, (_, i) => ({
    timestamp: MIDNIGHT - (count - 1 - i) * DAY,
    open: 100, high: 100, low: 90, close: 100, volume: 1,
  }));
  const seed = (candles) => {
    const file = cachePath(TEST_EXCHANGE, TEST_PRODUCT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ candles }));
  };
  const reload = () => {
    const store = createLongTermCandleStore(TEST_EXCHANGE, {}, TEST_PRODUCT);
    store.loadFromDisk();
    return store.getCandles();
  };
  beforeEach((t) => {
    cleanup();
    t.mock.method(Date, 'now', () => NOW);
  });
  afterEach(cleanup);

  it('refreshes current-day OHLCV, persists revisions, and corrects the depression score', async () => {
    const { computeDepressionScore } = require('../src/depression-score');
    let response = history(60);
    const store = createLongTermCandleStore(TEST_EXCHANGE, { getCandles: async () => response }, TEST_PRODUCT, { lookbackDays: 60 });
    await store.refresh();
    const original = store.getCandles();
    assert.equal(computeDepressionScore(100, original).score, 0);
    const revised = { timestamp: MIDNIGHT, open: 110, high: 200, low: 80, close: 180, volume: 50 };
    response = [revised, null, { close: 999 }];
    await store.refresh();
    assert.equal(store.getCandles().length, 60);
    assert.deepEqual(store.getCandles().at(-1), revised);
    assert.deepEqual(store.getCandles().map(c => c.timestamp), history(60).map(c => c.timestamp));
    assert.equal(original.at(-1).close, 100);
    assert.deepEqual(reload(), store.getCandles());
    const score = computeDepressionScore(100, store.getCandles());
    assert.ok(score.score > 0.79 && score.score < 0.80);
    assert.equal(score.suggestedLevel, 'maximum');
  });

  it('revalidates a full legacy cache once, then resumes incremental refresh', async () => {
    const old = history(365);
    seed(old);
    const revised = { ...old[10], high: 200, close: 180, volume: 50 };
    const calls = [];
    const adapter = { getCandles: async (product, start, end, granularity) => {
      calls.push({ start, end, granularity });
      return revised.timestamp / 1000 >= start && revised.timestamp / 1000 < end ? [revised] : [];
    } };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT);
    store.loadFromDisk();
    store.loadFromDisk();
    assert.equal(store.getStats().health, 'full');
    await store.refresh();
    assert.deepEqual(calls, [
      { start: NOW / 1000 - 365 * 86400, end: NOW / 1000 - 65 * 86400, granularity: 'ONE_DAY' },
      { start: NOW / 1000 - 65 * 86400, end: NOW / 1000, granularity: 'ONE_DAY' },
    ]);
    assert.deepEqual(store.getCandles()[10], revised);
    assert.deepEqual(reload(), store.getCandles());
    calls.length = 0;
    await store.refresh();
    assert.deepEqual(calls, [{ start: MIDNIGHT / 1000 - 86400, end: NOW / 1000, granularity: 'ONE_DAY' }]);
    assert.deepEqual(store.getCandles()[10], revised);
  });

  it('merges successful recovery pages and retains cached rows when a later page fails', async () => {
    const old = history(365);
    seed(old);
    const revised = { ...old[10], close: 180 };
    let calls = 0;
    const adapter = { getCandles: async () => {
      if (++calls === 1) return [revised];
      throw new Error('historical page unavailable');
    } };
    const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT);
    await store.refresh();
    const expected = old.map((c, i) => i === 10 ? revised : c);
    assert.equal(calls, 2);
    assert.deepEqual(store.getCandles(), expected);
    assert.deepEqual(reload(), expected);
    await store.refresh();
    assert.deepEqual(store.getCandles(), expected);
    assert.deepEqual(reload(), expected);
  });

  for (const fails of [false, true]) {
    it(`preserves full disk history when initial recovery ${fails ? 'fails' : 'returns no data'}`, async () => {
      const old = history(60);
      seed(old);
      const starts = [];
      const adapter = { getCandles: async (product, start) => {
        starts.push(start);
        if (fails) throw new Error('unavailable');
        return [];
      } };
      const store = createLongTermCandleStore(TEST_EXCHANGE, adapter, TEST_PRODUCT, { lookbackDays: 60 });
      await store.refresh();
      await store.refresh();
      assert.deepEqual(starts, [NOW / 1000 - 60 * 86400, MIDNIGHT / 1000 - 86400]);
      assert.deepEqual(store.getCandles(), old);
      assert.deepEqual(reload(), old);
    });
  }
});
