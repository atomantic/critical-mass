// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCandleAggregator } = require('../src/candle-aggregator');

// issue #145 — seedCandles set buffers[tf] but never current[tf]. The seed fetch
// includes the in-progress bucket as a partial candle in the buffer; when the
// first live tick arrived, aggregation started a fresh candle for the SAME bucket
// and pushCandle appended it with no timestamp dedup — leaving two candles with
// identical timestamp at every seed/live boundary, and under-reporting the live
// candle (which only covered ticks since service start).
describe('candle-aggregator seed/live boundary (issue #145)', () => {
  // now sits 20s into the 1m bucket that starts at 300000 → in-progress bucket = 300000
  const now = 320_000;

  it('promotes the in-progress seeded bucket to current so it is not duplicated', () => {
    const agg = createCandleAggregator();
    agg.seedCandles('1m', [
      { open: 1, high: 1, low: 1, close: 1, volume: 5, timestamp: 180_000 },
      { open: 2, high: 2, low: 2, close: 2, volume: 5, timestamp: 240_000 },
      { open: 3, high: 4, low: 3, close: 3, volume: 7, timestamp: 300_000 }, // in-progress
    ], now);

    // The in-progress bucket is held in `current`, not the completed buffer.
    assert.equal(agg.getCandles('1m').length, 2);
    assert.deepEqual(agg.getCandles('1m').map(c => c.timestamp), [180_000, 240_000]);
    const cur = agg.getCurrentCandle('1m');
    assert.equal(cur.timestamp, 300_000);
    assert.equal(cur.volume, 7);
  });

  it('continues the seeded in-progress candle with live ticks (no duplicate, no under-report)', () => {
    const agg = createCandleAggregator();
    agg.seedCandles('1m', [
      { open: 1, high: 1, low: 1, close: 1, volume: 5, timestamp: 180_000 },
      { open: 2, high: 2, low: 2, close: 2, volume: 5, timestamp: 240_000 },
      { open: 3, high: 4, low: 3, close: 3, volume: 7, timestamp: 300_000 }, // in-progress
    ], now);

    // A live tick inside the in-progress bucket merges into the seeded partial.
    agg.processTick(10, 320_000, 2);
    // A tick in the next bucket finalizes the 300000 candle.
    agg.processTick(11, 360_000, 1);

    const candles = agg.getCandles('1m');
    const timestamps = candles.map(c => c.timestamp);
    // No duplicate timestamps anywhere.
    assert.equal(new Set(timestamps).size, timestamps.length);
    assert.deepEqual(timestamps, [180_000, 240_000, 300_000]);

    const boundary = candles.find(c => c.timestamp === 300_000);
    assert.equal(boundary.open, 3, 'open preserved from seed');
    assert.equal(boundary.high, 10, 'high reflects live tick');
    assert.equal(boundary.close, 10, 'close reflects live tick');
    assert.equal(boundary.volume, 9, 'volume = seed 7 + live 2 (no double count)');
  });

  it('leaves fully-completed seeds in the buffer and current null', () => {
    const agg = createCandleAggregator();
    // newest seeded candle (240000) is older than the in-progress bucket (300000)
    agg.seedCandles('1m', [
      { open: 1, high: 1, low: 1, close: 1, volume: 5, timestamp: 180_000 },
      { open: 2, high: 2, low: 2, close: 2, volume: 5, timestamp: 240_000 },
    ], now);

    assert.equal(agg.getCandles('1m').length, 2);
    assert.equal(agg.getCurrentCandle('1m'), null);

    // Live ticks for the current bucket append without duplicating.
    agg.processTick(9, 320_000, 1);
    agg.processTick(9, 360_000, 1);
    const timestamps = agg.getCandles('1m').map(c => c.timestamp);
    assert.equal(new Set(timestamps).size, timestamps.length);
    assert.deepEqual(timestamps, [180_000, 240_000, 300_000]);
  });

  it('promotes the in-progress bucket for higher timeframes too', () => {
    const agg = createCandleAggregator();
    // 5m interval = 300000; floor(320000, 300000) = 300000 (in-progress)
    agg.seedCandles('5m', [
      { open: 1, high: 2, low: 1, close: 2, volume: 10, timestamp: 0 },
      { open: 2, high: 3, low: 2, close: 3, volume: 8, timestamp: 300_000 }, // in-progress
    ], now);

    assert.deepEqual(agg.getCandles('5m').map(c => c.timestamp), [0]);
    assert.equal(agg.getCurrentCandle('5m').timestamp, 300_000);
  });

  it('does not double-count the boundary minute for a directly-seeded higher timeframe', () => {
    const agg = createCandleAggregator();
    // now=200000: in-progress 1m bucket = 180000, in-progress 5m bucket = 0 (which
    // contains the boundary 1m@180000). This is codex's reproduction scenario.
    const t = 200_000;
    // 1m seeded first (establishes the boundary, vol 7).
    agg.seedCandles('1m', [
      { open: 1, high: 1, low: 1, close: 1, volume: 5, timestamp: 120_000 },
      { open: 2, high: 2, low: 2, close: 2, volume: 7, timestamp: 180_000 }, // in-progress
    ], t);
    // 5m directly fetched: its in-progress @0 candle ALREADY includes the 1m@180000
    // partial (vol 7 of the 100). boundaryInclusive deducts it at promotion.
    agg.seedCandles('5m', [
      { open: 1, high: 3, low: 1, close: 2, volume: 100, timestamp: 0 },
    ], t, { boundaryInclusive: true });
    assert.equal(agg.getCurrentCandle('5m').volume, 93, 'seeded 5m volume minus boundary 1m (100-7)');

    // Live ticks: continue the 1m, then finalize it so it rolls up into 5m@0.
    agg.processTick(9, 200_000, 2); // 1m@180000 volume 7 -> 9
    agg.processTick(9, 240_000, 1); // finalize 1m@180000 (vol 9) -> aggregateUp into 5m@0
    // 5m@0 = 93 + 9 = 102 (NOT 109) — the boundary minute is counted once.
    assert.equal(agg.getCurrentCandle('5m').volume, 102, 'no double count: 93 + full 1m(9)');
  });

  it('keeps full boundary volume for a derived (boundary-exclusive) higher timeframe', () => {
    const agg = createCandleAggregator();
    const t = 200_000;
    agg.seedCandles('1m', [
      { open: 2, high: 2, low: 2, close: 2, volume: 7, timestamp: 180_000 },
    ], t);
    // Derived 5m built from COMPLETED 1m only, so its partial excludes the boundary
    // minute — no deduction (default boundaryInclusive=false).
    agg.seedCandles('5m', [
      { open: 1, high: 3, low: 1, close: 2, volume: 40, timestamp: 0 },
    ], t);
    assert.equal(agg.getCurrentCandle('5m').volume, 40, 'derived seed volume untouched');
  });

  it('does not destroy a live in-progress candle when a seed arrives mid-fetch', () => {
    const agg = createCandleAggregator();
    const t = 200_000; // in-progress 1m bucket = 180000
    // A live tick builds current['1m']@180000 before the (non-blocking) seed returns.
    agg.processTick(50, 200_000, 3); // open/high/close 50, volume 3
    // Seed arrives with the same in-progress bucket (an older snapshot).
    agg.seedCandles('1m', [
      { open: 1, high: 40, low: 1, close: 40, volume: 7, timestamp: 180_000 },
    ], t);
    const cur = agg.getCurrentCandle('1m');
    assert.equal(cur.timestamp, 180_000);
    assert.equal(cur.high, 50, 'live high preserved (max of live 50, seed 40)');
    assert.equal(cur.low, 1, 'seed low folded in (min of live 50, seed 1)');
    assert.equal(cur.close, 50, 'live close kept (newest)');
    assert.equal(cur.volume, 7, 'max(live 3, seed 7) — not summed (overlapping coverage)');
  });

  it('keeps a live in-progress candle when the seed carries only completed buckets', () => {
    const agg = createCandleAggregator();
    agg.processTick(50, 200_000, 3); // current['1m']@180000
    // Seed's newest (120000) is older than the in-progress bucket at now=200000.
    agg.seedCandles('1m', [
      { open: 1, high: 1, low: 1, close: 1, volume: 9, timestamp: 120_000 },
    ], 200_000);
    assert.equal(agg.getCurrentCandle('1m').timestamp, 180_000, 'live candle not cleared');
    assert.equal(agg.getCurrentCandle('1m').high, 50);
  });

  it('never emits two candles with the same timestamp via pushCandle backstop', () => {
    const agg = createCandleAggregator();
    // Defensive: even if a seed leaves an in-progress bucket in the buffer (e.g.
    // a caller bypassing the `now` promotion), aggregation must not duplicate it.
    // Seed with now=0 so nothing is promoted, then drive a tick into bucket 300000.
    agg.seedCandles('1m', [
      { open: 3, high: 4, low: 3, close: 3, volume: 7, timestamp: 300_000 },
    ], 0);
    assert.deepEqual(agg.getCandles('1m').map(c => c.timestamp), [300_000]);

    agg.processTick(10, 320_000, 2); // builds current 1m for bucket 300000
    agg.processTick(11, 360_000, 1); // finalizes bucket 300000 -> would dup without backstop

    const timestamps = agg.getCandles('1m').map(c => c.timestamp);
    assert.equal(new Set(timestamps).size, timestamps.length, 'no duplicate timestamps');
    assert.deepEqual(timestamps, [300_000]);
  });
});
