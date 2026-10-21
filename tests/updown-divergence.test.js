// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findSwings, detectDivergence, detectMACDDivergence } = require('../src/updown/divergence');

// Build a 20-bar series: `base` everywhere, with explicit overrides at given indices.
/** @param {number} base @param {Record<number, number>} overrides @param {number} [len=20] */
const series = (base, overrides, len = 20) => {
  const out = new Array(len).fill(base);
  for (const [idx, val] of Object.entries(overrides)) out[Number(idx)] = val;
  return out;
};

describe('findSwings', () => {
  it('detects strict swing highs and lows using the given order', () => {
    // [1,3,2,5,4] with order=1: highs at 1 (3) and 3 (5), low at 2 (2)
    const { highs, lows } = findSwings([1, 3, 2, 5, 4], 1);
    assert.deepEqual(highs, [{ index: 1, value: 3 }, { index: 3, value: 5 }]);
    assert.deepEqual(lows, [{ index: 2, value: 2 }]);
  });

  it('returns no swings for flat or too-short input', () => {
    assert.deepEqual(findSwings(new Array(20).fill(7)), { highs: [], lows: [] });
    assert.deepEqual(findSwings([1, 2, 3], 3), { highs: [], lows: [] });
    assert.deepEqual(findSwings(null), { highs: [], lows: [] });
  });

  it('does not treat equal neighbours as strict swings', () => {
    // Plateau at the peak: values[i] <= neighbour rejects it as a high
    const { highs } = findSwings([1, 5, 5, 1, 1, 1, 1], 1);
    assert.deepEqual(highs, []);
  });
});

describe('detectDivergence (price vs RSI)', () => {
  it('detects bearish divergence: price higher high, indicator lower high', () => {
    // Price peaks: 105 @5, 110 @14 (higher high). RSI peaks: 60 @5, 55 @14 (lower high).
    const closes = series(100, { 5: 105, 14: 110 });
    const rsi = series(50, { 5: 60, 14: 55 });
    const result = detectDivergence(closes, rsi);
    assert.equal(result.type, 'bearish');
    // priceDelta = 5/105, indDelta = 5/60, strength = (1/21 + 1/12) * 5 = 55/84
    assert.ok(Math.abs(result.strength - 55 / 84) < 1e-9, `strength ${result.strength}`);
  });

  it('detects bullish divergence: price lower low, indicator higher low', () => {
    // Price troughs: 95 @5, 90 @14 (lower low). RSI troughs: 40 @5, 45 @14 (higher low).
    const closes = series(100, { 5: 95, 14: 90 });
    const rsi = series(50, { 5: 40, 14: 45 });
    const result = detectDivergence(closes, rsi);
    assert.equal(result.type, 'bullish');
    // priceDelta = 5/95, indDelta = 5/40, strength = (1/19 + 1/8) * 5 = 135/152
    assert.ok(Math.abs(result.strength - 135 / 152) < 1e-9, `strength ${result.strength}`);
  });

  it('returns none when price and indicator agree (both higher highs)', () => {
    const closes = series(100, { 5: 105, 14: 110 });
    const rsi = series(50, { 5: 55, 14: 60 });
    assert.deepEqual(detectDivergence(closes, rsi), { type: 'none', strength: 0 });
  });

  it('returns none on equal price pivots (no strict higher high)', () => {
    const closes = series(100, { 5: 105, 14: 105 });
    const rsi = series(50, { 5: 60, 14: 55 });
    assert.deepEqual(detectDivergence(closes, rsi), { type: 'none', strength: 0 });
  });

  it('returns none on equal indicator pivots (no strict lower high)', () => {
    const closes = series(100, { 5: 105, 14: 110 });
    const rsi = series(50, { 5: 60, 14: 60 });
    assert.deepEqual(detectDivergence(closes, rsi), { type: 'none', strength: 0 });
  });

  it('returns none on flat series and on insufficient data', () => {
    assert.deepEqual(detectDivergence(series(100, {}), series(50, {})), { type: 'none', strength: 0 });
    assert.deepEqual(detectDivergence(series(100, {}, 10), series(50, {}, 10)), { type: 'none', strength: 0 });
    assert.deepEqual(detectDivergence(null, null), { type: 'none', strength: 0 });
    assert.deepEqual(detectDivergence([], []), { type: 'none', strength: 0 });
  });

  it('only analyses the last `lookback` bars', () => {
    // Divergence pattern (peaks at 5 and 14) sits before the last-20-bar window (indices 20..39) -> ignored
    const closes = series(100, { 5: 105, 14: 110 }, 40);
    const rsi = series(50, { 5: 60, 14: 55 }, 40);
    assert.equal(detectDivergence(closes, rsi, 20).type, 'none');
    assert.equal(detectDivergence(closes, rsi, 40).type, 'bearish');
  });

  it('caps strength at 1', () => {
    // Price 100 -> 200 (+100%), indicator 100 -> 1 (~-99%): raw score well above 1
    const closes = series(100, { 5: 150, 14: 200 });
    const rsi = series(0, { 5: 100, 14: 1 });
    const result = detectDivergence(closes, rsi);
    assert.equal(result.type, 'bearish');
    assert.equal(result.strength, 1);
  });

  it('uses zero indicator delta when the first indicator pivot is ~0 (no divide-by-zero)', () => {
    // ih[0] = 0 triggers the epsilon guard: indDelta = 0, strength = 5 * (5/105)
    const closes = series(100, { 5: 105, 14: 110 });
    const rsi = series(-50, { 5: 0, 14: -5 });
    const result = detectDivergence(closes, rsi);
    assert.equal(result.type, 'bearish');
    assert.ok(Number.isFinite(result.strength));
    assert.ok(Math.abs(result.strength - 25 / 105) < 1e-9, `strength ${result.strength}`);
  });
});

describe('detectMACDDivergence (price vs histogram)', () => {
  it('detects bearish histogram divergence with a fully warmed-up window', () => {
    const closes = series(100, { 5: 105, 14: 110 });
    const hist = series(50, { 5: 60, 14: 55 });
    assert.equal(detectMACDDivergence(closes, hist).type, 'bearish');
  });

  it('detects bullish histogram divergence on negative histogram values', () => {
    const closes = series(100, { 5: 95, 14: 90 });
    const hist = series(-50, { 5: -60, 14: -55 });
    assert.equal(detectMACDDivergence(closes, hist).type, 'bullish');
  });

  it('suppresses output when more than half the window is zero (warm-up guard)', () => {
    const closes = series(100, { 5: 105, 14: 110 });
    // 12 leading zeros in the 20-bar window -> only 8 non-zero, below the 10 required
    const hist = series(50, { 5: 60, 14: 55 });
    for (let i = 0; i < 12; i++) hist[i] = 0;
    assert.deepEqual(detectMACDDivergence(closes, hist), { type: 'none', strength: 0 });
  });

  it('returns none on insufficient or missing data', () => {
    assert.deepEqual(detectMACDDivergence(series(100, {}, 10), series(50, {}, 10)), { type: 'none', strength: 0 });
    assert.deepEqual(detectMACDDivergence(null, null), { type: 'none', strength: 0 });
  });
});
