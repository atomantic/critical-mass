// @ts-check
/**
 * Ladder Calculator
 *
 * Calculates ladder parameters for pre-positioned liquidity ladder mode:
 * - Lower bound calculation (adaptive based on ATH distance, volatility)
 * - Price level distribution (linear, sqrt, exponential spacing)
 * - Size allocation across levels (flat, linear, sqrt distribution)
 *
 * The ladder mode complements reactive mode by capturing liquidity shocks
 * and fat-tail events that single-order approaches miss.
 */

const { roundBTC, roundPrice, roundUSDC } = require('./volatility-utils');

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
 * @property {number} volMultiplier - Volatility multiplier used
 */

/**
 * @typedef {Object} MarketContext
 * @property {number} atr - Current ATR value
 * @property {number} volBaseline - Baseline volatility
 * @property {number} athDistance - Distance from ATH (negative when below, e.g., -0.43 for 43% below)
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
   * Calculate adaptive lower bound based on market conditions
   * @param {number} currentPrice - Current market price
   * @param {MarketContext} context - Market context
   * @returns {{lowerBound: number, lowerBoundPct: number, volMultiplier: number}}
   */
  const calculateLowerBound = (currentPrice, context) => {
    const { athDistance = 0, realizedVol = 0, volBaseline = 0 } = context;

    // Start with base percentage from config
    let adjustedPct = config.ladderLowerBoundPct || 15;

    // ATH adjustment: widen ladder when further from ATH
    // e.g., 43% below ATH -> 1.43x multiplier
    let athMultiplier = 1.0;
    if (config.ladderLowerBoundAthAdjust && athDistance < 0) {
      athMultiplier = 1 + Math.abs(athDistance);
      adjustedPct *= athMultiplier;
    }

    // Volatility adjustment: widen during high volatility
    let volMultiplier = 1.0;
    if (volBaseline > 0 && realizedVol > volBaseline) {
      const volExpansion = realizedVol / volBaseline;
      // Cap at 2x to prevent extreme widening
      volMultiplier = Math.min(volExpansion, 2.0);
      adjustedPct *= volMultiplier;
    }

    // Cap total adjustment at reasonable maximum (50%)
    adjustedPct = Math.min(adjustedPct, 50);

    const lowerBound = roundPrice(currentPrice * (1 - adjustedPct / 100));

    return {
      lowerBound,
      lowerBoundPct: adjustedPct,
      athMultiplier,
      volMultiplier,
    };
  };

  /**
   * Calculate price levels using specified spacing mode
   * @param {number} currentPrice - Current price (top of ladder)
   * @param {number} lowerBound - Lower bound price (bottom of ladder)
   * @param {number} numLevels - Number of ladder rungs
   * @param {'linear' | 'sqrt' | 'exponential'} spacingMode - Spacing distribution
   * @returns {number[]} Array of prices from top to bottom
   */
  const calculateLadderLevels = (currentPrice, lowerBound, numLevels, spacingMode) => {
    const totalRange = currentPrice - lowerBound;
    const prices = [];
    const minSpacingPct = (config.ladderMinSpacingPct || 0.5) / 100;
    const minSpacing = currentPrice * minSpacingPct;

    for (let i = 0; i < numLevels; i++) {
      let fraction;

      switch (spacingMode) {
        case 'sqrt':
          // Square root: denser near top (current price), sparser at bottom
          // Good for capturing small dips while still having exposure to larger drops
          fraction = Math.sqrt(i / (numLevels - 1 || 1));
          break;

        case 'exponential':
          // Exponential: sparser near top, denser at bottom
          // Good for aggressive accumulation during crashes
          fraction = Math.pow(i / (numLevels - 1 || 1), 2);
          break;

        case 'linear':
        default:
          // Linear: even spacing throughout
          fraction = i / (numLevels - 1 || 1);
          break;
      }

      const price = roundPrice(currentPrice - fraction * totalRange);
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
   * @param {'flat' | 'linear' | 'sqrt'} sizeMode - Size distribution mode
   * @returns {number[]} Array of USDC allocations per level
   */
  const calculateLevelSizes = (totalBudget, numLevels, sizeMode) => {
    const sizes = [];

    switch (sizeMode) {
      case 'linear':
        // Linear: larger sizes at lower prices (more capital at bottom)
        {
          // Weights: 1, 2, 3, ..., numLevels
          const totalWeight = (numLevels * (numLevels + 1)) / 2;
          for (let i = 0; i < numLevels; i++) {
            const weight = i + 1;
            sizes.push(roundUSDC((weight / totalWeight) * totalBudget));
          }
        }
        break;

      case 'sqrt':
        // Square root: moderate increase towards bottom
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
        // Flat: equal allocation to all levels
        {
          const perLevel = roundUSDC(totalBudget / numLevels);
          for (let i = 0; i < numLevels; i++) {
            sizes.push(perLevel);
          }
        }
        break;
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
    const numLevels = config.ladderLevels || 10;
    const spacingMode = config.ladderSpacingMode || 'sqrt';
    const sizeMode = config.ladderSizeMode || 'flat';

    // Calculate adaptive lower bound
    const { lowerBound, lowerBoundPct, volMultiplier } = calculateLowerBound(
      currentPrice,
      context
    );

    // Calculate price levels
    const priceLevels = calculateLadderLevels(currentPrice, lowerBound, numLevels, spacingMode);

    // Calculate size allocations
    const sizesRaw = calculateLevelSizes(totalBudget, priceLevels.length, sizeMode);

    // Combine prices and sizes, filtering out levels below minimum order size together
    const levels = [];
    const minSize = config.baseSizeUsdc || 50;

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

    return {
      lowerBound,
      lowerBoundPct,
      totalBudget,
      levels,
      athDistance: context.athDistance || 0,
      volMultiplier,
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
