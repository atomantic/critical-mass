// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { calculateRSI, calculateRSISeries, calculateBollingerBands } = require('../src/updown/indicators');

// issue #212A — a perfectly flat series (no gains, no losses) must read as neutral
// (RSI=50), not RSI=100. RSI=100 is reserved for "all gains, zero losses" — a real
// (if rare) all-up move — which flat-series data is not.
describe('calculateRSI flat-series guard (issue #212A)', () => {
  it('returns 50 (neutral) for a perfectly flat window', () => {
    const flat = new Array(20).fill(100);
    assert.equal(calculateRSI(flat), 50);
  });

  it('still returns 100 for a genuine all-gains window (no losses)', () => {
    const allGains = Array.from({ length: 20 }, (_, i) => 100 + i);
    assert.equal(calculateRSI(allGains), 100);
  });

  it('returns a normal 0-100 value for a mixed up/down window', () => {
    const closes = [100, 102, 101, 103, 104, 102, 105, 106, 104, 107, 108, 106, 109, 110, 108];
    const rsi = calculateRSI(closes, 14);
    assert.ok(rsi > 0 && rsi < 100, `expected RSI strictly between 0 and 100, got ${rsi}`);
  });
});

// issue #212B — insufficient data must be distinguishable from a real oversold (0) or
// overbought (100) reading. Returning 0 for "not enough candles yet" was scored by
// scoreRSI as extreme oversold (+80), phantom-inflating the composite score on cold start.
describe('calculateRSI insufficient-data sentinel (issue #212B)', () => {
  it('returns null (not 0) when there are fewer than period+1 closes', () => {
    assert.equal(calculateRSI([100, 101, 102], 14), null);
    assert.equal(calculateRSI([], 14), null);
    assert.equal(calculateRSI(null, 14), null);
  });
});

describe('calculateRSISeries flat-series guard (issue #212A)', () => {
  it('reports 50 (not 100) at the index where the window first warms up flat', () => {
    const flat = new Array(20).fill(100);
    const series = calculateRSISeries(flat, 14);
    assert.equal(series[14], 50);
  });

  it('continues reporting 50 across a sustained flat stretch after warm-up', () => {
    const closes = [100, 105, 95, 110, 90, 108, 92, 106, 94, 104, 96, 102, 98, 100, 100];
    // Append a long flat run after the initial warm-up window
    for (let i = 0; i < 10; i++) closes.push(100);
    const series = calculateRSISeries(closes, 14);
    assert.equal(series[series.length - 1], 50);
  });
});

// issue #212B — calculateBollingerBands must not leak percentB=0 for insufficient data;
// scoreBollinger reads percentB<0.2 as strongly oversold (+50), so a bare 0 during
// warm-up is indistinguishable from a real deep-oversold reading.
describe('calculateBollingerBands insufficient-data sentinel (issue #212B)', () => {
  it('returns percentB: null when there are fewer than `period` closes', () => {
    const bb = calculateBollingerBands([100, 101, 102], 20);
    assert.equal(bb.percentB, null);
  });

  it('returns a numeric percentB once enough closes are available', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 2);
    const bb = calculateBollingerBands(closes, 20);
    assert.equal(typeof bb.percentB, 'number');
  });
});
