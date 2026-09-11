// @ts-check
// Characterization tests for the dampener steps extracted out of computeSignals
// (issue #361): applyConfluenceFilter, applyMacroTrendDampener,
// applyDailyPivotDampener, compressScoreCeiling. These pin exact numeric
// behavior so the extraction from signal-engine.js's computeSignals stays
// provably behavior-preserving.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_SIGNAL_TFS,
  applyConfluenceFilter,
  applyMacroTrendDampener,
  applyDailyPivotDampener,
  compressScoreCeiling,
} = require('../src/updown/signal-engine');

const timeframesWithScores = (scores) => {
  const timeframes = {};
  for (const tf of ALL_SIGNAL_TFS) {
    timeframes[tf] = { score: scores[tf] ?? 0 };
  }
  return timeframes;
};

describe('applyConfluenceFilter (issue #361 extraction)', () => {
  it('dampens by 0.85x when 8+ timeframes agree with the composite direction (overcrowded)', () => {
    // 8 of 11 timeframes are directional (|score| > 15) and agree with the positive composite.
    const timeframes = timeframesWithScores({
      '1m': 20, '3m': 20, '5m': 20, '10m': 20, '15m': 20, '30m': 20, '1h': 20, '2h': 20,
      '4h': 0, '1d': 0, '1w': 0,
    });
    const result = applyConfluenceFilter(10, timeframes);
    assert.equal(result.confluence.agreeing, 8);
    assert.equal(result.confluence.totalDirectional, 8);
    assert.equal(result.confluence.quality, 'overcrowded');
    assert.equal(result.compositeScore, 10 * 0.85);
  });

  it('dampens by 0.95x when exactly 7 timeframes agree (moderate)', () => {
    const timeframes = timeframesWithScores({
      '1m': 20, '3m': 20, '5m': 20, '10m': 20, '15m': 20, '30m': 20, '1h': 20,
      '2h': 0, '4h': 0, '1d': 0, '1w': 0,
    });
    const result = applyConfluenceFilter(10, timeframes);
    assert.equal(result.confluence.agreeing, 7);
    assert.equal(result.confluence.quality, 'moderate');
    assert.equal(result.compositeScore, 10 * 0.95);
  });

  it('leaves the score untouched when agreement is selective (< 7)', () => {
    const timeframes = timeframesWithScores({
      '1m': 20, '3m': 20, '5m': -20, '10m': -20, '15m': 0, '30m': 0, '1h': 0,
      '2h': 0, '4h': 0, '1d': 0, '1w': 0,
    });
    const result = applyConfluenceFilter(10, timeframes);
    assert.equal(result.confluence.agreeing, 2);
    assert.equal(result.confluence.totalDirectional, 4);
    assert.equal(result.confluence.quality, 'selective');
    assert.equal(result.compositeScore, 10);
  });

  it('treats a zero composite as direction 0 so nothing agrees with it', () => {
    const timeframes = timeframesWithScores({ '1m': 20, '3m': -20 });
    const result = applyConfluenceFilter(0, timeframes);
    assert.equal(result.confluence.agreeing, 0);
    assert.equal(result.confluence.totalDirectional, 2);
    assert.equal(result.compositeScore, 0);
  });
});

describe('applyMacroTrendDampener (issue #361 extraction)', () => {
  it('applies the trend multiplier when only the 1h trend counter-signals', () => {
    const trendFilter = { trendBias: 'bullish', multiplier: 0.8 };
    const weeklyTrend = { weeklyBias: 'neutral', multiplier: 0.7 };
    assert.equal(applyMacroTrendDampener(-10, trendFilter, weeklyTrend), -10 * 0.8);
  });

  it('applies the weekly multiplier when only the weekly trend counter-signals', () => {
    const trendFilter = { trendBias: 'neutral', multiplier: 0.8 };
    const weeklyTrend = { weeklyBias: 'bearish', multiplier: 0.7 };
    assert.equal(applyMacroTrendDampener(10, trendFilter, weeklyTrend), 10 * 0.7);
  });

  it('applies only the stronger (lower) multiplier when both counter-signal, never both stacked', () => {
    const trendFilter = { trendBias: 'bullish', multiplier: 0.8 };
    const weeklyTrend = { weeklyBias: 'bullish', multiplier: 0.6 };
    const result = applyMacroTrendDampener(-10, trendFilter, weeklyTrend);
    assert.equal(result, -10 * 0.6);
    assert.notEqual(result, -10 * 0.8 * 0.6);
  });

  it('leaves the score untouched when neither trend counter-signals', () => {
    const trendFilter = { trendBias: 'bullish', multiplier: 0.8 };
    const weeklyTrend = { weeklyBias: 'bullish', multiplier: 0.6 };
    assert.equal(applyMacroTrendDampener(10, trendFilter, weeklyTrend), 10);
  });
});

describe('applyDailyPivotDampener (issue #361 extraction)', () => {
  // Daily candle high=110, low=90, close=100 -> P=100, R1=110, R2=120, S1=90, S2=80.
  const dailyCandle = { high: 110, low: 90, close: 100, timestamp: 1_000 };
  const candles1d = [dailyCandle];

  const aggregatorWith5m = (closes) => ({
    getCandles: (tf) => (tf === '5m' ? closes : []),
  });

  it('dampens a positive score approaching resistance (R1)', () => {
    // prevPrice already above R1 -> approach (not breakout) -> dampMultiplier 0.85
    const candleAggregator = aggregatorWith5m([{ close: 111 }, { close: 110 }]);
    const result = applyDailyPivotDampener(50, candles1d, candleAggregator, 0, null);
    assert.equal(result.pivotPoints.nearLevel, 'R1');
    assert.equal(result.pivotPoints.dampMultiplier, 0.85);
    assert.equal(result.compositeScore, 50 * 0.85);
    assert.equal(result.lastPivotDayTs, 1_000);
  });

  it('boosts (breakout multiplier) a positive score that just crossed above R1', () => {
    const candleAggregator = aggregatorWith5m([{ close: 109 }, { close: 110 }]);
    const result = applyDailyPivotDampener(50, candles1d, candleAggregator, 0, null);
    assert.equal(result.pivotPoints.nearLevel, 'R1');
    assert.equal(result.pivotPoints.dampMultiplier, 1.05);
    assert.equal(result.compositeScore, 50 * 1.05);
  });

  it('dampens a negative score approaching support (S1) and leaves a positive score untouched', () => {
    const candleAggregator = aggregatorWith5m([{ close: 89 }, { close: 90 }]);
    const negative = applyDailyPivotDampener(-50, candles1d, candleAggregator, 0, null);
    assert.equal(negative.pivotPoints.nearLevel, 'S1');
    assert.equal(negative.compositeScore, -50 * negative.pivotPoints.dampMultiplier);

    const positive = applyDailyPivotDampener(50, candles1d, candleAggregator, 0, null);
    assert.equal(positive.compositeScore, 50, 'a positive score is not dampened near support');
  });

  it('reuses cached pivots (no recompute) while the daily candle timestamp is unchanged', () => {
    const sentinelPivots = { P: 1, R1: 2, R2: 3, R3: 4, S1: 5, S2: 6, S3: 7 };
    const candleAggregator = aggregatorWith5m([]);
    const result = applyDailyPivotDampener(10, candles1d, candleAggregator, 1_000, sentinelPivots);
    assert.equal(result.cachedPivots, sentinelPivots);
    assert.equal(result.lastPivotDayTs, 1_000);
  });

  it('recomputes pivots when the daily candle rolls to a new day', () => {
    const staleSentinel = { P: 1, R1: 2, R2: 3, R3: 4, S1: 5, S2: 6, S3: 7 };
    const candleAggregator = aggregatorWith5m([]);
    const result = applyDailyPivotDampener(10, candles1d, candleAggregator, 500, staleSentinel);
    assert.notEqual(result.cachedPivots, staleSentinel);
    assert.equal(result.cachedPivots.P, 100);
    assert.equal(result.lastPivotDayTs, 1_000);
  });

  it('is a no-op when there are no daily candles', () => {
    const candleAggregator = aggregatorWith5m([{ close: 110 }]);
    const result = applyDailyPivotDampener(10, [], candleAggregator, 0, null);
    assert.equal(result.compositeScore, 10);
    assert.equal(result.pivotPoints, null);
    assert.equal(result.cachedPivots, null);
    assert.equal(result.lastPivotDayTs, 0);
  });
});

describe('compressScoreCeiling (issue #361 extraction)', () => {
  it('leaves scores at or below the threshold untouched', () => {
    assert.equal(compressScoreCeiling(50), 50);
    assert.equal(compressScoreCeiling(-50), -50);
    assert.equal(compressScoreCeiling(30), 30);
  });

  it('compresses the excess above the threshold by the given factor (default 0.5 @ 50)', () => {
    assert.equal(compressScoreCeiling(60), 55);
    assert.equal(compressScoreCeiling(-60), -55);
    assert.equal(compressScoreCeiling(70), 60);
  });

  it('honors custom threshold/factor arguments', () => {
    assert.equal(compressScoreCeiling(40, 20, 0.25), 25); // excess 20 * 0.25 = 5 -> 20+5
  });
});
