// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCandleCache } = require('../src/candle-cache');

// issue #161 — exchange ticker `volume24h` is the rolling 24-hour total, not the
// per-tick increment. candle-cache.processTick must feed the aggregator the DELTA
// since the previous tick (clamped to >= 0), or every tick adds the whole 24h volume
// and live candle volumes balloon into a meaningless sum of snapshots.
describe('candle-cache feeds incremental volume, not the rolling 24h total (issue #161)', () => {
  const T0 = 1_700_000_000_000; // fixed 1m bucket start (divisible by 60_000)

  const vol = (cache, ex) => cache.getAggregator(ex).getCurrentCandle('1m').volume;

  it('the first tick contributes 0 incremental volume (no baseline yet)', () => {
    const cache = createCandleCache();
    cache.processTick('coinbase', 100, T0, 5000);
    assert.equal(vol(cache, 'coinbase'), 0, 'first tick has no baseline -> 0');
  });

  it('subsequent ticks add only the delta of the 24h volume', () => {
    const cache = createCandleCache();
    cache.processTick('coinbase', 100, T0, 5000);       // baseline
    cache.processTick('coinbase', 101, T0 + 1000, 5030); // +30
    cache.processTick('coinbase', 102, T0 + 2000, 5045); // +15
    assert.equal(vol(cache, 'coinbase'), 45, 'candle volume = sum of deltas, not 5000+...');
  });

  it('clamps a shrinking 24h window (day rollover / reconnect) to 0, never negative', () => {
    const cache = createCandleCache();
    cache.processTick('coinbase', 100, T0, 5000);
    cache.processTick('coinbase', 101, T0 + 1000, 4800); // window shed older trades
    assert.equal(vol(cache, 'coinbase'), 0, 'negative delta clamps to 0');
  });

  it('tracks the baseline independently per exchange', () => {
    const cache = createCandleCache();
    cache.processTick('coinbase', 100, T0, 5000);
    cache.processTick('cryptocom', 50, T0, 9000);
    cache.processTick('coinbase', 101, T0 + 1000, 5010);  // +10
    cache.processTick('cryptocom', 51, T0 + 1000, 9025);  // +25
    assert.equal(vol(cache, 'coinbase'), 10);
    assert.equal(vol(cache, 'cryptocom'), 25);
  });

  it('an exchange that always reports volume24h: 0 (Gemini L2) contributes 0 live volume', () => {
    const cache = createCandleCache();
    cache.processTick('gemini', 100, T0, 0);
    cache.processTick('gemini', 101, T0 + 1000, 0);
    cache.processTick('gemini', 102, T0 + 2000, 0);
    assert.equal(vol(cache, 'gemini'), 0, 'no usable ticker volume -> 0, not corruption');
  });
});
