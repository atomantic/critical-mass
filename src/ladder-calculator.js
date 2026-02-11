// @ts-check
/**
 * Ladder Calculator
 *
 * Deploys ALL available USDC as limit buy orders from just below current
 * price down to an ATH-based floor with Fibonacci-weighted sizing.
 *
 * Key behaviors:
 * - Bottom of ladder is ATH-based (not % below current price)
 * - Number of orders is dynamic (not a fixed count)
 * - Fibonacci sizing (smallest at top, largest at bottom)
 * - Orders stay in place on individual buy fills (no reprice)
 * - Rebuild only after all sells clear (cycle reset)
 */

const { roundBTC, roundPrice, roundUSDC } = require('./volatility-utils');
const { FIBONACCI, getFibonacciMultiplier } = require('./fibonacci-utils');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 */

/**
 * @typedef {Object} LadderLevel
 * @property {number} index - Level index (0 = top, closest to current price)
 * @property {number} price - Price for this level
 * @property {number} sizeUsdc - USDC allocation for this level
 * @property {number} btcQty - BTC quantity for this level
 * @property {number} distancePct - Distance from current price in %
 */

/**
 * @typedef {Object} LadderResult
 * @property {number} lowerBound - Calculated lower bound price
 * @property {number} lowerBoundPct - Lower bound as % below current price
 * @property {number} totalBudget - Total USDC budget for ladder
 * @property {LadderLevel[]} levels - Array of ladder levels
 * @property {number} athDistance - ATH distance factor used
 */

/**
 * @typedef {Object} MarketContext
 * @property {number} atr - Current ATR value
 * @property {number} volBaseline - Baseline volatility
 * @property {number} athDistance - Distance from ATH (negative when below, e.g., -0.43 for 43% below)
 * @property {number} [ath] - All-time high price
 * @property {number} [realizedVol] - Current realized volatility
 */

/**
 * Create ladder calculator instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Regime configuration
 * @returns {Object} Ladder calculator instance
 */
const createLadderCalculator = (exchange, config) => {
  /**
   * Calculate ATH-based lower bound (floor price for the ladder)
   * @param {number} currentPrice - Current market price
   * @param {number} ath - All-time high price
   * @param {number} maxAthDropPct - Max drop from ATH in percent (e.g. 80 → floor at 20% of ATH)
   * @returns {number|null} Floor price, or null if currentPrice is already below the floor
   */
  const calculateLowerBound = (currentPrice, ath, maxAthDropPct) => {
    const reference = ath > 0 ? ath : currentPrice;
    const floor = roundPrice(reference * (1 - maxAthDropPct / 100));
    return floor < currentPrice ? floor : null;
  };

  /**
   * Calculate dynamic level count for fibonacci sizing
   * Finds max N where the smallest fib-weighted order meets minOrderSize
   * @param {number} budget - Total USDC budget
   * @param {number} baseSizeUsdc - Minimum acceptable order size
   * @returns {number} Number of levels (capped at 30)
   */
  const calculateDynamicLevelCount = (budget, baseSizeUsdc) => {
    const maxLevels = 30;
    for (let n = maxLevels; n >= 2; n--) {
      // fib(0) = 1 is the smallest weight (top of ladder)
      let fibSum = 0;
      for (let i = 0; i < n; i++) {
        fibSum += getFibonacciMultiplier(i);
      }
      const smallestAllocation = (getFibonacciMultiplier(0) / fibSum) * budget;
      if (smallestAllocation >= baseSizeUsdc) {
        return n;
      }
    }
    // If budget can only fit 1 order, return 1
    return budget >= baseSizeUsdc ? 1 : 0;
  };

  /**
   * Calculate price levels using specified spacing mode
   * @param {number} topPrice - Top of ladder (below current price)
   * @param {number} lowerBound - Lower bound price (bottom of ladder)
   * @param {number} numLevels - Number of ladder rungs
   * @param {'linear' | 'sqrt' | 'exponential'} spacingMode - Spacing distribution
   * @returns {number[]} Array of prices from top to bottom
   */
  const calculateLadderLevels = (topPrice, lowerBound, numLevels, spacingMode) => {
    if (numLevels <= 1) return [topPrice];

    const totalRange = topPrice - lowerBound;
    const prices = [];
    const minSpacingPct = (config.ladderMinSpacingPct || 0.5) / 100;
    const minSpacing = topPrice * minSpacingPct;

    for (let i = 0; i < numLevels; i++) {
      let fraction;

      switch (spacingMode) {
        case 'sqrt':
          fraction = Math.sqrt(i / (numLevels - 1));
          break;

        case 'exponential':
          fraction = Math.pow(i / (numLevels - 1), 2);
          break;

        case 'linear':
        default:
          fraction = i / (numLevels - 1);
          break;
      }

      const price = roundPrice(topPrice - fraction * totalRange);
      prices.push(price);
    }

    // Enforce minimum spacing between levels
    const spacedPrices = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
      const prevPrice = spacedPrices[spacedPrices.length - 1];
      if (prevPrice - prices[i] >= minSpacing) {
        spacedPrices.push(prices[i]);
      }
    }

    return spacedPrices;
  };

  /**
   * Calculate size allocation for each level
   * @param {number} totalBudget - Total USDC to allocate
   * @param {number} numLevels - Number of levels
   * @param {'flat' | 'linear' | 'sqrt' | 'fibonacci'} sizeMode - Size distribution mode
   * @returns {number[]} Array of USDC allocations per level
   */
  const calculateLevelSizes = (totalBudget, numLevels, sizeMode) => {
    const sizes = [];

    switch (sizeMode) {
      case 'fibonacci':
        // Fibonacci: escalating sizes at bottom (1, 1, 2, 3, 5, 8, 13...)
        {
          const weights = [];
          let totalWeight = 0;
          for (let i = 0; i < numLevels; i++) {
            const weight = getFibonacciMultiplier(i);
            weights.push(weight);
            totalWeight += weight;
          }
          for (let i = 0; i < numLevels; i++) {
            sizes.push(roundUSDC((weights[i] / totalWeight) * totalBudget));
          }
        }
        break;

      case 'linear':
        {
          const totalWeight = (numLevels * (numLevels + 1)) / 2;
          for (let i = 0; i < numLevels; i++) {
            const weight = i + 1;
            sizes.push(roundUSDC((weight / totalWeight) * totalBudget));
          }
        }
        break;

      case 'sqrt':
        {
          const weights = [];
          let totalWeight = 0;
          for (let i = 0; i < numLevels; i++) {
            const weight = Math.sqrt(i + 1);
            weights.push(weight);
            totalWeight += weight;
          }
          for (let i = 0; i < numLevels; i++) {
            sizes.push(roundUSDC((weights[i] / totalWeight) * totalBudget));
          }
        }
        break;

      case 'flat':
      default:
        {
          const perLevel = roundUSDC(totalBudget / numLevels);
          for (let i = 0; i < numLevels; i++) {
            sizes.push(perLevel);
          }
        }
        break;
    }

    // Correct rounding drift: adjust final level so total matches budget
    const sizeSum = sizes.reduce((s, v) => s + v, 0);
    if (sizes.length > 0) {
      const drift = roundUSDC(sizeSum - totalBudget);
      if (drift !== 0) {
        sizes[sizes.length - 1] = roundUSDC(sizes[sizes.length - 1] - drift);
      }
    }

    return sizes;
  };

  /**
   * Build complete ladder with prices and sizes
   * @param {number} currentPrice - Current market price
   * @param {number} totalBudget - Total USDC budget for ladder
   * @param {MarketContext} context - Market context (ATR, vol, ATH distance)
   * @returns {LadderResult}
   */
  const buildLadder = (currentPrice, totalBudget, context) => {
    const maxAthDropPct = config.ladderMaxAthDropPct || 80;
    const spacingMode = config.ladderSpacingMode || 'sqrt';
    const sizeMode = config.ladderSizeMode || 'fibonacci';
    const ath = context.ath || 0;
    const baseSizeUsdc = config.baseSizeUsdc || 50;

    // Calculate ATH-based floor
    const lowerBound = calculateLowerBound(currentPrice, ath, maxAthDropPct);
    if (lowerBound === null) {
      // Price already at or below floor — no ladder to build
      return { lowerBound: 0, lowerBoundPct: 0, totalBudget, levels: [], athDistance: context.athDistance || 0 };
    }

    // Compute first order offset adaptively: same as reactive mode's volatility trigger
    const kFactor = config.kFactor || 0.65;
    const atr = context.atr || 0;
    let firstDropPct = 1; // fallback 1% if ATR unavailable
    if (atr > 0 && currentPrice > 0) {
      firstDropPct = (kFactor * atr / currentPrice) * 100;
      firstDropPct = Math.max(firstDropPct, 0.1); // min 0.1%
    }
    const topPrice = roundPrice(currentPrice * (1 - firstDropPct / 100));

    // Ensure topPrice is above floor
    if (topPrice <= lowerBound) {
      return { lowerBound, lowerBoundPct: roundUSDC(((currentPrice - lowerBound) / currentPrice) * 100), totalBudget, levels: [], athDistance: context.athDistance || 0 };
    }

    // Dynamic level count for fibonacci mode; fixed fallback for others
    let numLevels;
    if (sizeMode === 'fibonacci') {
      numLevels = calculateDynamicLevelCount(totalBudget, baseSizeUsdc);
    } else {
      numLevels = Math.max(2, Math.floor(totalBudget / baseSizeUsdc));
      numLevels = Math.min(numLevels, 30);
    }

    if (numLevels === 0) {
      return { lowerBound, lowerBoundPct: roundUSDC(((currentPrice - lowerBound) / currentPrice) * 100), totalBudget, levels: [], athDistance: context.athDistance || 0 };
    }

    // Generate price levels from topPrice to floor
    const priceLevels = calculateLadderLevels(topPrice, lowerBound, numLevels, spacingMode);

    // Allocate sizes
    const sizesRaw = calculateLevelSizes(totalBudget, priceLevels.length, sizeMode);

    // Combine prices and sizes, filtering out sub-minimum levels
    const levels = [];
    const minSize = config.minOrderSizeUsdc || 5;

    for (let i = 0; i < priceLevels.length; i++) {
      const price = priceLevels[i];
      const sizeUsdc = sizesRaw[i];
      if (sizeUsdc < minSize) continue;
      const btcQty = roundBTC(sizeUsdc / price);
      const distancePct = roundUSDC(((currentPrice - price) / currentPrice) * 100);

      levels.push({
        index: levels.length,
        price,
        sizeUsdc,
        btcQty,
        distancePct,
      });
    }

    const lowerBoundPct = roundUSDC(((currentPrice - lowerBound) / currentPrice) * 100);

    return {
      lowerBound,
      lowerBoundPct,
      totalBudget,
      levels,
      athDistance: context.athDistance || 0,
    };
  };

  /**
   * Calculate All-Time High from candle data
   * @param {Array<{high: number}>} dailyCandles - Array of daily candles with high prices
   * @returns {number} ATH price
   */
  const calculateATHFromCandles = (dailyCandles) => {
    if (!dailyCandles || dailyCandles.length === 0) {
      return 0;
    }
    return Math.max(...dailyCandles.map(c => c.high));
  };

  /**
   * Calculate ATH distance (percentage below ATH)
   * @param {number} currentPrice - Current price
   * @param {number} ath - All-time high price
   * @returns {number} Distance from ATH as decimal (e.g., -0.43 for 43% below)
   */
  const calculateATHDistance = (currentPrice, ath) => {
    if (ath <= 0 || currentPrice <= 0) {
      return 0;
    }
    return (currentPrice - ath) / ath;
  };

  /**
   * Get ladder status summary for logging
   * @param {LadderResult} ladder - Ladder result
   * @returns {string}
   */
  const getSummary = (ladder) => {
    const topLevel = ladder.levels[0];
    const bottomLevel = ladder.levels[ladder.levels.length - 1];
    return `${ladder.levels.length} levels, $${topLevel?.price || 0} to $${bottomLevel?.price || 0} (${ladder.lowerBoundPct.toFixed(1)}% range)`;
  };

  return {
    calculateLowerBound,
    calculateDynamicLevelCount,
    calculateLadderLevels,
    calculateLevelSizes,
    buildLadder,
    calculateATHFromCandles,
    calculateATHDistance,
    getSummary,
  };
};

module.exports = {
  createLadderCalculator,
};
