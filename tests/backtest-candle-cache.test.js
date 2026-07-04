// @ts-check
/**
 * #206  in-progress candles were persisted and the completed replacement was
 *       dedupe-dropped, so a partial boundary candle won forever.
 * #213A incremental refresh of aggregated interval types aggregated by array
 *       index (offset-sensitive) instead of wall-clock time bucket.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { aggregateCandles, isCompleteBucket, upsertCandles } = require('../src/backtest-engine');

const FIVE_MIN = 5 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const raw = (ts, o) => ({ timestamp: ts, open: o.open, high: o.high, low: o.low, close: o.close, volume: o.v ?? 1 });

describe('#213A aggregateCandles buckets by wall-clock time, not array index', () => {
  it('pairs 5-min candles into aligned 10-min buckets', () => {
    const candles = [
      raw(0 * FIVE_MIN, { open: 10, high: 12, low: 9, close: 11 }),
      raw(1 * FIVE_MIN, { open: 11, high: 15, low: 10, close: 14 }),
      raw(2 * FIVE_MIN, { open: 14, high: 16, low: 13, close: 15 }),
      raw(3 * FIVE_MIN, { open: 15, high: 18, low: 12, close: 17 }),
    ];
    const out = aggregateCandles(candles, TEN_MIN);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(c => c.timestamp), [0, TEN_MIN]);
    // Bucket 0 aggregates the :00 and :05 candles.
    assert.equal(out[0].open, 10);
    assert.equal(out[0].high, 15);
    assert.equal(out[0].low, 9);
    assert.equal(out[0].close, 14);
  });

  it('is offset-independent: a shifted start does not re-pair buckets by index', () => {
    // Start at :05. Index-pairing would group (:05,:10),(:15,:20). Wall-clock
    // bucketing keeps :05 in bucket 0, (:10,:15) in bucket 1, :20 in bucket 2.
    const candles = [
      raw(1 * FIVE_MIN, { open: 1, high: 2, low: 1, close: 2 }),
      raw(2 * FIVE_MIN, { open: 2, high: 3, low: 2, close: 3 }),
      raw(3 * FIVE_MIN, { open: 3, high: 4, low: 3, close: 4 }),
      raw(4 * FIVE_MIN, { open: 4, high: 5, low: 4, close: 5 }),
    ];
    const out = aggregateCandles(candles, TEN_MIN);
    assert.deepEqual(out.map(c => c.timestamp), [0, TEN_MIN, 2 * TEN_MIN]);
  });

  it('factor-1 intervals (aligned) pass through one candle per bucket', () => {
    const candles = [
      raw(0, { open: 1, high: 2, low: 1, close: 2 }),
      raw(HOUR, { open: 2, high: 3, low: 2, close: 3 }),
    ];
    const out = aggregateCandles(candles, HOUR);
    assert.deepEqual(out.map(c => c.timestamp), [0, HOUR]);
  });
});

describe('#206 in-progress candles are not persisted and completed replacements win', () => {
  it('isCompleteBucket excludes a bucket whose end is after now', () => {
    const now = 10 * HOUR;
    assert.equal(isCompleteBucket(9 * HOUR, HOUR, now), true, 'bucket [9h,10h) ends at now → complete');
    assert.equal(isCompleteBucket(9.5 * HOUR, HOUR, now), false, 'bucket ending after now → in progress');
    assert.equal(isCompleteBucket(10 * HOUR, HOUR, now), false, 'bucket starting at now → in progress');
  });

  it('upsertCandles REPLACES a stale partial with the completed same-timestamp candle', () => {
    const partial = [
      { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: HOUR, open: 2, high: 2, low: 2, close: 2, volume: 1 }, // partial boundary bucket
    ];
    const completed = [
      { timestamp: HOUR, open: 2, high: 9, low: 1, close: 8, volume: 50 }, // same ts, full range
    ];
    const merged = upsertCandles(partial, completed);
    assert.equal(merged.length, 2, 'no duplicate timestamps');
    const boundary = merged.find(c => c.timestamp === HOUR);
    assert.equal(boundary.high, 9, 'completed candle must overwrite the partial');
    assert.equal(boundary.volume, 50);
  });

  it('dropping in-progress buckets keeps only completed history', () => {
    const now = 3 * HOUR + 1; // bucket [2h,3h) complete; [3h,4h) not
    const candles = [0, HOUR, 2 * HOUR, 3 * HOUR].map(ts => ({ timestamp: ts, high: 1, low: 1, close: 1 }));
    const complete = candles.filter(c => isCompleteBucket(c.timestamp, HOUR, now));
    assert.deepEqual(complete.map(c => c.timestamp), [0, HOUR, 2 * HOUR]);
  });
});
