// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCandleAggregator } = require('../src/candle-aggregator');
const { seedDerivedTimeframes } = require('../src/candle-cache');

// issue #145 — when startup seeding happens during an open higher-tf bucket, the
// in-progress source bucket is held in `current` (out of getCandles). Derivation must
// still include it, or the derived in-progress candle is missing the pre-start portion
// of the open source bucket (aggregateUp never replays it — it only rolls FUTURE 1m
// candles), so 30m/2h/4h/1w would be emitted short on volume/high/low.
describe('seedDerivedTimeframes includes the in-progress source bucket (issue #145)', () => {
  const H = 3_600_000;       // 1h
  const now = 2 * H + H / 2; // 2.5h: in-progress 1h bucket = 2H, in-progress 2h bucket = 2H

  it('derives the in-progress 2h bucket from the open 1h source bucket', () => {
    const agg = createCandleAggregator();
    // The in-progress 1m bucket at now (= floor(now,60000) = now, which floors into 1h
    // bucket 2H) so current['1m'] exists for the boundary deduction.
    agg.seedCandles('1m', [
      { open: 1, high: 1, low: 1, close: 1, volume: 7, timestamp: now },
    ], now);
    // Directly-seeded 1h: two completed buckets + the in-progress 1h@2H (boundaryInclusive,
    // so its volume is the seed 100 minus the live boundary-1m 7 = 93).
    agg.seedCandles('1h', [
      { open: 1, high: 5, low: 1, close: 4, volume: 80, timestamp: 0 },
      { open: 4, high: 6, low: 3, close: 5, volume: 90, timestamp: H },
      { open: 5, high: 9, low: 4, close: 8, volume: 100, timestamp: 2 * H }, // in-progress
    ], now, { boundaryInclusive: true });
    assert.equal(agg.getCurrentCandle('1h').volume, 93, 'sanity: 1h boundary-deducted (100-7)');

    seedDerivedTimeframes(agg, now);

    // 2h@0 completed = 1h@0 + 1h@1 = 170. In-progress 2h@2H must include the open 1h@2H
    // (93) — NOT be missing it.
    assert.deepEqual(agg.getCandles('2h').map(c => c.timestamp), [0], 'completed 2h bucket present');
    assert.equal(agg.getCandles('2h')[0].volume, 170);
    const cur2h = agg.getCurrentCandle('2h');
    assert.equal(cur2h.timestamp, 2 * H, 'in-progress 2h bucket promoted');
    assert.equal(cur2h.volume, 93, 'includes the open 1h source bucket (would be missing without the fix)');
    assert.equal(cur2h.high, 9, 'high carried from the open 1h source bucket');

    // The live boundary 1m completes and rolls its FULL volume up into both 1h@2H and
    // 2h@2H. No double count: 2h stays consistent with the 1h it derived from.
    agg.processTick(8, now, 3);          // current['1m'] 7 -> 10
    agg.processTick(8, now + 60_000, 1); // finalize the 1m -> rolls its full vol up
    assert.equal(agg.getCurrentCandle('2h').volume, 103, 'no double count: 93 + full 1m(10)');
    assert.equal(agg.getCurrentCandle('1h').volume, 103, '1h and 2h agree on the boundary roll-up');
  });
});
