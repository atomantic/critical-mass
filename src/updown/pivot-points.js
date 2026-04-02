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

// Per-level multipliers: major levels (R2/S2) have stronger effects than minor ones (R1/S1).
// breakout applies when price just crossed through; approach applies when price is nearing.
const PIVOT_LEVEL_CONFIG = {
  R2: { breakout: 1.10, approach: 0.70 },
  R1: { breakout: 1.05, approach: 0.85 },
  S2: { breakout: 1.10, approach: 0.70 },
  S1: { breakout: 1.05, approach: 0.85 },
};

/**
 * Compute signal dampening when price is near a pivot level.
 * Dampens scores when approaching a level, boosts when breaking through it.
 * @param {number} price - Current price
 * @param {{P: number, R1: number, R2: number, R3: number, S1: number, S2: number, S3: number}} pivots
 * @param {number} [proximityPct=0.001] - Proximity threshold as fraction (0.1% default)
 * @param {number|null} [prevPrice=null] - Previous price for breakout detection
 * @returns {{nearLevel: string|null, dampMultiplier: number, pivots: Object}}
 */
const computePivotDampening = (price, pivots, proximityPct = 0.001, prevPrice = null) => {
  if (!pivots || !price) return { nearLevel: null, dampMultiplier: 1, pivots };

  const isNear = (level) => Math.abs(price - level) / price < proximityPct;
  const brokAbove = (level) => prevPrice != null && prevPrice < level && price >= level;
  const brokBelow = (level) => prevPrice != null && prevPrice > level && price <= level;

  for (const [name, config] of Object.entries(PIVOT_LEVEL_CONFIG)) {
    const level = pivots[name];
    if (!isNear(level)) continue;
    const broke = name.startsWith('R') ? brokAbove(level) : brokBelow(level);
    return { nearLevel: name, dampMultiplier: broke ? config.breakout : config.approach, pivots };
  }

  return { nearLevel: null, dampMultiplier: 1, pivots };
};

module.exports = { calculatePivotPoints, computePivotDampening };
