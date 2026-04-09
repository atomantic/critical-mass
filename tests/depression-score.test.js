// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDepressionScore,
  scorePercentile,
  scoreDrawdown,
  scoreZScore,
  suggestLevel,
  WEIGHTS,
  SUGGESTED_LEVEL_THRESHOLDS,
} = require('../src/depression-score');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build N daily candles with arbitrary close/high/low values.
 * @param {Array<number|{close: number, high?: number, low?: number}>} prices
 * @returns {Array<{timestamp: number, open: number, high: number, low: number, close: number, volume: number}>}
 */
const candlesFrom = (prices) =>
  prices.map((p, i) => {
    const close = typeof p === 'number' ? p : p.close;
    const high  = typeof p === 'number' ? p : (p.high ?? close);
    const low   = typeof p === 'number' ? p : (p.low  ?? close);
    return {
      timestamp: Date.now() - (prices.length - i) * 86400 * 1000,
      open: close,
      high,
      low,
      close,
      volume: 1000,
    };
  });

/** Build N flat candles around a price (helps the z-score have non-zero stdev). */
const flatishCandles = (count, base, jitter = 0.5) =>
  Array.from({ length: count }, (_, i) => {
    const close = base + Math.sin(i * 0.7) * jitter;
    return {
      timestamp: Date.now() - (count - i) * 86400 * 1000,
      open: close,
      high: close + jitter,
      low: close - jitter,
      close,
      volume: 1000,
    };
  });

// ============================================================================
// Component scorers
// ============================================================================

describe('scorePercentile', () => {
  it('returns 0 for empty closes', () => {
    const r = scorePercentile(100, []);
    assert.equal(r.score, 0);
  });

  it('returns 1.0 when price is at the period low', () => {
    const r = scorePercentile(10, [10, 20, 30, 40, 50]);
    assert.equal(r.score, 1);
  });

  it('returns 0.0 when price is at the period high', () => {
    const r = scorePercentile(50, [10, 20, 30, 40, 50]);
    assert.equal(r.score, 0);
  });

  it('returns 0.5 when price is at the midpoint', () => {
    const r = scorePercentile(30, [10, 20, 30, 40, 50]);
    assert.equal(r.score, 0.5);
  });

  it('clamps prices outside the historical range', () => {
    const above = scorePercentile(100, [10, 20, 30, 40, 50]);
    assert.equal(above.score, 0);
    const below = scorePercentile(5, [10, 20, 30, 40, 50]);
    assert.equal(below.score, 1);
  });

  it('handles a flat-line history without dividing by zero', () => {
    const r = scorePercentile(10, [10, 10, 10, 10]);
    assert.equal(r.score, 0);  // mid-percentile, not depressed
    assert.equal(r.percentile, 0.5);
  });
});

describe('scoreDrawdown', () => {
  it('returns 0 when price is at the trailing high', () => {
    const r = scoreDrawdown(100, [50, 75, 100, 90, 80]);
    assert.equal(r.score, 0);
    assert.equal(r.drawdownPct, 0);
  });

  it('returns 0.5 when price is 40% below trailing high (40/80 mapping)', () => {
    const r = scoreDrawdown(60, [100, 100, 100]);
    // 40% drawdown / 80% max = 0.5
    assert.ok(Math.abs(r.score - 0.5) < 0.001);
  });

  it('returns 1.0 (clamped) for drawdowns ≥80%', () => {
    const r = scoreDrawdown(10, [100]);
    assert.equal(r.score, 1);
  });

  it('clamps negative drawdowns (price above trailing high) to 0', () => {
    const r = scoreDrawdown(150, [100]);
    assert.equal(r.score, 0);
  });
});

describe('scoreZScore', () => {
  it('returns 0 when sample size is too small', () => {
    const r = scoreZScore(50, [50, 51, 52]);
    assert.equal(r.score, 0);
  });

  it('returns 0 when price is at or above the mean', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + (i % 10));
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const r = scoreZScore(mean, closes);
    assert.equal(r.score, 0);
  });

  it('returns >0 when price is below the mean', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + (i % 10));
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const r = scoreZScore(mean - 5, closes);
    assert.ok(r.score > 0);
    assert.ok(r.zscore < 0);
  });
});

// ============================================================================
// Composite score
// ============================================================================

describe('computeDepressionScore', () => {
  it('returns ready=false for insufficient data', () => {
    const r = computeDepressionScore(100, []);
    assert.equal(r.ready, false);
    assert.equal(r.score, 0);
  });

  it('returns ready=false when fewer than 30 candles', () => {
    const r = computeDepressionScore(100, candlesFrom([1, 2, 3, 4, 5]));
    assert.equal(r.ready, false);
  });

  it('returns ready=true with ≥30 candles', () => {
    const r = computeDepressionScore(50, flatishCandles(35, 50));
    assert.equal(r.ready, true);
    assert.equal(typeof r.score, 'number');
  });

  it('outputs a score in [0, 1]', () => {
    const r = computeDepressionScore(50, flatishCandles(100, 50));
    assert.ok(r.score >= 0 && r.score <= 1);
  });

  it('returns a high score when price is at the period low', () => {
    const candles = flatishCandles(100, 50);
    // Plug in a price well below all observed closes
    const r = computeDepressionScore(20, candles);
    assert.ok(r.score > 0.7, `expected score > 0.7, got ${r.score}`);
    assert.equal(r.suggestedLevel, 'maximum');
  });

  it('returns a low score when price is at the period high', () => {
    const candles = flatishCandles(100, 50);
    const r = computeDepressionScore(80, candles);
    assert.ok(r.score < 0.3, `expected score < 0.3, got ${r.score}`);
  });

  it('weights sum to 1.0', () => {
    const total = WEIGHTS.percentile + WEIGHTS.drawdown + WEIGHTS.zscore;
    assert.ok(Math.abs(total - 1.0) < 0.0001);
  });

  it('exposes component breakdown with weights', () => {
    const r = computeDepressionScore(50, flatishCandles(50, 50));
    assert.ok(r.components.percentile);
    assert.ok(r.components.drawdown);
    assert.ok(r.components.zscore);
    assert.equal(r.components.percentile.weight, WEIGHTS.percentile);
  });
});

// ============================================================================
// Suggested level
// ============================================================================

describe('suggestLevel', () => {
  it('returns conservative for low scores', () => {
    assert.equal(suggestLevel(0), 'conservative');
    assert.equal(suggestLevel(0.1), 'conservative');
  });

  it('returns moderate for mid-low scores', () => {
    assert.equal(suggestLevel(0.25), 'moderate');
    assert.equal(suggestLevel(0.4), 'moderate');
  });

  it('returns aggressive for mid-high scores', () => {
    assert.equal(suggestLevel(0.5), 'aggressive');
    assert.equal(suggestLevel(0.7), 'aggressive');
  });

  it('returns maximum for high scores', () => {
    assert.equal(suggestLevel(0.75), 'maximum');
    assert.equal(suggestLevel(1.0), 'maximum');
  });

  it('threshold table is monotonically descending', () => {
    for (let i = 1; i < SUGGESTED_LEVEL_THRESHOLDS.length; i++) {
      assert.ok(SUGGESTED_LEVEL_THRESHOLDS[i].min < SUGGESTED_LEVEL_THRESHOLDS[i - 1].min);
    }
  });
});
