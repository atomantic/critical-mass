// @ts-check
/**
 * Depression Score
 *
 * Long-term "how cheap is this asset" signal for Phase 1 of the
 * auto-aggressiveness feature. Composite of three components:
 *
 *   1. Percentile of close in trailing range (60% weight)
 *      - Robust to trend; doesn't chase price down like an MA
 *      - 0.0 = at the period high, 1.0 = at the period low
 *
 *   2. Drawdown from trailing high (30% weight)
 *      - Intuitive cap at 0% (peak), naturally bounded
 *      - 0.0 = at peak, 1.0 = down 80%+ from peak
 *
 *   3. Z-score below 200d mean (10% weight)
 *      - Statistical sanity check
 *      - 0.0 = at or above mean, 1.0 = ≥2σ below mean
 *
 * Output is a single 0..1 score where 1.0 = "maximally depressed".
 *
 * @typedef {import('./types').Candle} Candle
 */

const { clamp } = require('./volatility-utils');

/**
 * Component weights — must sum to 1.0
 */
const WEIGHTS = {
  percentile: 0.60,
  drawdown:   0.30,
  zscore:     0.10,
};

/**
 * Drawdown depth that maps to a 1.0 component score.
 * 80% drawdown = 1.0 (matches CRO's current ~92% drawdown territory).
 */
const MAX_DRAWDOWN_PCT = 80;

/**
 * Standard deviations below mean that maps to a 1.0 component score.
 */
const MAX_Z_SIGMA = 2;

/**
 * Discrete aggressiveness levels with their depression-score thresholds.
 * Used to derive a "suggested level" badge for the dashboard.
 *
 * Tuned so that:
 *  - depressed assets (CRO at -90% from ATH) → maximum
 *  - mid-range assets → moderate/aggressive
 *  - frothy assets (near ATH) → conservative
 */
const SUGGESTED_LEVEL_THRESHOLDS = [
  { level: 'maximum',     min: 0.75 },
  { level: 'aggressive',  min: 0.50 },
  { level: 'moderate',    min: 0.25 },
  { level: 'conservative', min: 0.0 },
];

/**
 * Suggest an aggressiveness level for a given depression score.
 * @param {number} score - Depression score in [0, 1]
 * @returns {string} One of: conservative, moderate, aggressive, maximum
 */
const suggestLevel = (score) => {
  for (const t of SUGGESTED_LEVEL_THRESHOLDS) {
    if (score >= t.min) return t.level;
  }
  return 'conservative';
};

/**
 * Compute the percentile-of-range component.
 * Returns 1.0 when current price is at the period low, 0.0 at the period high.
 * @param {number} price
 * @param {number[]} closes - Trailing daily closes (oldest-first)
 * @returns {{score: number, percentile: number, low: number, high: number}}
 */
const scorePercentile = (price, closes) => {
  if (!closes.length || price <= 0) {
    return { score: 0, percentile: 0, low: 0, high: 0 };
  }
  let low = closes[0];
  let high = closes[0];
  for (const c of closes) {
    if (c < low) low = c;
    if (c > high) high = c;
  }
  const range = high - low;
  if (range <= 0) {
    return { score: 0, percentile: 0.5, low, high };
  }
  // Where current sits in the range, 0..1 (low=0, high=1)
  const positionInRange = clamp((price - low) / range, 0, 1);
  // Invert: depression score is 1.0 at the low
  const percentileFromLow = 1 - positionInRange;
  return { score: percentileFromLow, percentile: percentileFromLow, low, high };
};

/**
 * Compute the drawdown-from-high component.
 * Returns 1.0 when price is ≥80% below the trailing high, 0.0 when at the high.
 * @param {number} price
 * @param {number[]} highs - Trailing daily highs (oldest-first)
 * @returns {{score: number, drawdownPct: number, periodHigh: number}}
 */
const scoreDrawdown = (price, highs) => {
  if (!highs.length || price <= 0) {
    return { score: 0, drawdownPct: 0, periodHigh: 0 };
  }
  let periodHigh = highs[0];
  for (const h of highs) {
    if (h > periodHigh) periodHigh = h;
  }
  if (periodHigh <= 0) {
    return { score: 0, drawdownPct: 0, periodHigh: 0 };
  }
  const drawdownPct = ((periodHigh - price) / periodHigh) * 100;
  const score = clamp(drawdownPct / MAX_DRAWDOWN_PCT, 0, 1);
  return { score, drawdownPct, periodHigh };
};

/**
 * Compute the z-score component.
 * Returns 1.0 when price is ≥2σ below the trailing mean, 0.0 when at or above mean.
 * @param {number} price
 * @param {number[]} closes - Trailing daily closes
 * @returns {{score: number, zscore: number, mean: number, stdev: number}}
 */
const scoreZScore = (price, closes) => {
  if (closes.length < 30 || price <= 0) {
    return { score: 0, zscore: 0, mean: 0, stdev: 0 };
  }
  const mean = closes.reduce((sum, c) => sum + c, 0) / closes.length;
  const variance = closes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / closes.length;
  const stdev = Math.sqrt(variance);
  if (stdev <= 0) {
    return { score: 0, zscore: 0, mean, stdev: 0 };
  }
  const zscore = (price - mean) / stdev;
  // Negative z-score = price below mean = depressed
  const depressionStrength = Math.max(0, -zscore);
  const score = clamp(depressionStrength / MAX_Z_SIGMA, 0, 1);
  return { score, zscore, mean, stdev };
};

/**
 * Compute the composite depression score from a daily candle history.
 *
 * @param {number} currentPrice
 * @param {Candle[]} candles - Daily candles, oldest-first
 * @returns {{
 *   score: number,
 *   suggestedLevel: string,
 *   components: {
 *     percentile: {score: number, percentile: number, low: number, high: number, weight: number},
 *     drawdown: {score: number, drawdownPct: number, periodHigh: number, weight: number},
 *     zscore: {score: number, zscore: number, mean: number, stdev: number, weight: number},
 *   },
 *   sampleSize: number,
 *   ready: boolean,
 * }}
 */
const computeDepressionScore = (currentPrice, candles) => {
  // Need at least 30 candles for the z-score component to be meaningful
  const ready = Array.isArray(candles) && candles.length >= 30 && currentPrice > 0;

  if (!ready) {
    return {
      score: 0,
      suggestedLevel: 'conservative',
      components: {
        percentile: { score: 0, percentile: 0, low: 0, high: 0, weight: WEIGHTS.percentile },
        drawdown:   { score: 0, drawdownPct: 0, periodHigh: 0, weight: WEIGHTS.drawdown },
        zscore:     { score: 0, zscore: 0, mean: 0, stdev: 0, weight: WEIGHTS.zscore },
      },
      sampleSize: candles?.length || 0,
      ready: false,
    };
  }

  const closes = candles.map(c => c.close).filter(c => c > 0);
  const highs  = candles.map(c => c.high  || c.close).filter(c => c > 0);

  const percentile = scorePercentile(currentPrice, closes);
  const drawdown   = scoreDrawdown(currentPrice, highs);
  const zscore     = scoreZScore(currentPrice, closes);

  const composite = clamp(
    percentile.score * WEIGHTS.percentile +
    drawdown.score   * WEIGHTS.drawdown +
    zscore.score     * WEIGHTS.zscore,
    0,
    1
  );

  return {
    score: composite,
    suggestedLevel: suggestLevel(composite),
    components: {
      percentile: { ...percentile, weight: WEIGHTS.percentile },
      drawdown:   { ...drawdown,   weight: WEIGHTS.drawdown },
      zscore:     { ...zscore,     weight: WEIGHTS.zscore },
    },
    sampleSize: closes.length,
    ready: true,
  };
};

module.exports = {
  computeDepressionScore,
  // Exported for testing
  scorePercentile,
  scoreDrawdown,
  scoreZScore,
  suggestLevel,
  WEIGHTS,
  SUGGESTED_LEVEL_THRESHOLDS,
};
