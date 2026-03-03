// @ts-check
/**
 * Pivot Points (Support/Resistance)
 *
 * Classic pivot point calculation from daily candle data.
 * Computes P, R1-R3, S1-S3 levels and provides a dampening
 * multiplier when price is near key levels.
 */

/**
 * Calculate classic pivot points from a daily candle
 * @param {{high: number, low: number, close: number}} dailyCandle
 * @returns {{P: number, R1: number, R2: number, R3: number, S1: number, S2: number, S3: number}}
 */
const calculatePivotPoints = (dailyCandle) => {
  const { high, low, close } = dailyCandle;
  const P = (high + low + close) / 3;
  return {
    P,
    R1: 2 * P - low,
    R2: P + (high - low),
    R3: high + 2 * (P - low),
    S1: 2 * P - high,
    S2: P - (high - low),
    S3: low - 2 * (high - P),
  };
};

/**
 * Compute signal dampening when price is near a pivot level
 * Dampens positive scores near resistance, negative scores near support
 * @param {number} price - Current price
 * @param {{P: number, R1: number, R2: number, R3: number, S1: number, S2: number, S3: number}} pivots
 * @param {number} [proximityPct=0.001] - Proximity threshold as fraction (0.1% default)
 * @returns {{nearLevel: string|null, dampMultiplier: number, pivots: Object}}
 */
const computePivotDampening = (price, pivots, proximityPct = 0.001) => {
  if (!pivots || !price) return { nearLevel: null, dampMultiplier: 1, pivots };

  const isNear = (level) => Math.abs(price - level) / price < proximityPct;

  // Check resistance levels (dampen positive scores)
  if (isNear(pivots.R2)) return { nearLevel: 'R2', dampMultiplier: 0.70, pivots };
  if (isNear(pivots.R1)) return { nearLevel: 'R1', dampMultiplier: 0.85, pivots };

  // Check support levels (dampen negative scores)
  if (isNear(pivots.S2)) return { nearLevel: 'S2', dampMultiplier: 0.70, pivots };
  if (isNear(pivots.S1)) return { nearLevel: 'S1', dampMultiplier: 0.85, pivots };

  return { nearLevel: null, dampMultiplier: 1, pivots };
};

module.exports = { calculatePivotPoints, computePivotDampening };
