// @ts-check
/**
 * Position Sizer
 *
 * Calculates entry sizes based on:
 * - Current regime (HARVEST/CAUTION/TREND scale factors)
 * - Ladder step position (geometric scaling)
 * - Liquidity factor (if L2 depth available)
 * - Remaining budget cap
 *
 * Replaces Fibonacci scaling with liquidity-aware sizing.
 */

const { roundUSDC, roundBTC } = require('./volatility-utils');

/**
 * @typedef {import('./types').RegimeMode} RegimeMode
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * Create position sizer instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @returns {Object} Position sizer instance
 */
const createPositionSizer = (exchange, config) => {
  /**
   * Calculate entry size in USDC
   * @param {Object} params - Sizing parameters
   * @param {RegimeMode} params.regime - Current regime mode
   * @param {number} params.cycleBuys - Current ladder step (0-indexed)
   * @param {number} params.totalCostBasis - Current cost basis
   * @param {number} [params.bidDepthUsdc] - Bid depth in USDC (optional)
   * @param {number} [params.baselineDepth] - Baseline depth for comparison (optional)
   * @returns {{sizeUsdc: number, sizeBTC: number, factors: Object}}
   */
  const calculateEntrySize = (params) => {
    const { regime, cycleBuys, totalCostBasis, bidDepthUsdc, baselineDepth } = params;

    // Get regime scale factor
    const regimeScale = getRegimeScale(regime);

    // Get liquidity factor
    const liquidityFactor = calculateLiquidityFactor(cycleBuys, bidDepthUsdc, baselineDepth);

    // Calculate raw size
    let sizeUsdc = config.baseSizeUsdc * regimeScale * liquidityFactor;

    // Check remaining budget (cap at 0 to prevent negative sizes)
    const remainingBudget = Math.max(0, config.maxUsdcDeployed - totalCostBasis);
    sizeUsdc = Math.min(sizeUsdc, remainingBudget);

    // Round to 2 decimals
    sizeUsdc = roundUSDC(sizeUsdc);

    return {
      sizeUsdc,
      sizeBTC: 0, // Will be calculated after price is known
      factors: {
        base: config.baseSizeUsdc,
        regimeScale,
        liquidityFactor,
        remainingBudget,
        regime,
        cycleBuys,
      },
    };
  };

  /**
   * Get regime scale factor
   * @param {RegimeMode} regime - Current regime
   * @returns {number} Scale factor
   */
  const getRegimeScale = (regime) => {
    switch (regime) {
      case 'HARVEST':
        return config.harvestScale;
      case 'CAUTION':
        return config.cautionScale;
      case 'TREND':
        return config.trendScale;
      default:
        return 1.0;
    }
  };

  /**
   * Calculate liquidity factor
   * If L2 depth available: sqrt(depth / baseline)
   * Fallback: geometric scaling based on ladder step
   * @param {number} cycleBuys - Current ladder step
   * @param {number} [bidDepthUsdc] - Current bid depth
   * @param {number} [baselineDepth] - Baseline depth
   * @returns {number} Liquidity factor
   */
  const calculateLiquidityFactor = (cycleBuys, bidDepthUsdc, baselineDepth) => {
    // If L2 depth is available, use sqrt scaling
    if (bidDepthUsdc !== undefined && baselineDepth !== undefined && baselineDepth > 0) {
      const depthRatio = bidDepthUsdc / baselineDepth;
      const factor = Math.sqrt(depthRatio);
      return Math.min(factor, config.liquidityFactorCap);
    }

    // Fallback: geometric scaling based on ladder step
    // factor = 1 + (step * 0.1), capped
    const stepFactor = 1 + (cycleBuys * 0.1);
    return Math.min(stepFactor, config.liquidityFactorCap);
  };

  /**
   * Calculate BTC quantity from USDC size and price
   * @param {number} sizeUsdc - Size in USDC
   * @param {number} price - Price per BTC
   * @returns {number} BTC quantity
   */
  const calculateBTCQuantity = (sizeUsdc, price) => {
    if (price <= 0) return 0;
    return roundBTC(sizeUsdc / price);
  };

  /**
   * Check if size meets minimum order requirements
   * @param {number} sizeUsdc - Size in USDC
   * @param {number} minOrderSize - Minimum order size
   * @returns {boolean}
   */
  const meetsMinimum = (sizeUsdc, minOrderSize) => {
    return sizeUsdc >= minOrderSize;
  };

  /**
   * Calculate take-profit size based on profit-based holdback
   * Recovers full cost basis + (1-holdbackRatio) of profit as USDC
   * Keeps holdbackRatio of profit as BTC appreciation
   *
   * @param {number} totalBTC - Total BTC position
   * @param {number} avgCostBasis - Average cost per BTC
   * @param {number} sellPrice - Target sell price
   * @param {number} [tierHoldbackScale=1.0] - Tier-specific holdback multiplier (higher tiers hold more)
   * @returns {{sellQty: number, holdbackQty: number, profitUsdc: number, profitBtcValue: number}}
   */
  const calculateTakeProfitSize = (totalBTC, avgCostBasis, sellPrice, tierHoldbackScale = 1.0) => {
    const baseHoldback = config.holdbackRatio ?? 0.5;
    const holdbackRatio = Math.min(baseHoldback * tierHoldbackScale, 0.95); // Cap at 95%

    // Calculate profit per BTC and total profit
    const profitPerBTC = sellPrice - avgCostBasis;
    const totalProfit = totalBTC * profitPerBTC;

    // Calculate how much profit to keep as BTC value
    const profitToHoldAsBtcValue = totalProfit * holdbackRatio;

    // Convert that profit value to BTC quantity at sell price
    // Enforce minimum 1 satoshi holdback — if we can't hold back at least 1 sat,
    // the TP price isn't high enough (caller should raise minTpPct)
    const MIN_HOLDBACK = 0.00000001; // 1 satoshi
    const rawHoldback = profitToHoldAsBtcValue / sellPrice;
    const holdbackQty = Math.max(roundBTC(rawHoldback), MIN_HOLDBACK);
    const sellQty = roundBTC(totalBTC - holdbackQty);

    // Calculate actual profit split
    const profitUsdc = sellQty * profitPerBTC;  // USDC profit from selling
    const profitBtcValue = holdbackQty * profitPerBTC;  // BTC profit value kept

    return {
      sellQty,
      holdbackQty,
      profitUsdc,
      profitBtcValue,
    };
  };

  /**
   * Get sizing summary for logging
   * @param {Object} factors - Sizing factors from calculateEntrySize
   * @returns {string}
   */
  const getSizingSummary = (factors) => {
    const { base, regimeScale, liquidityFactor, remainingBudget, regime, cycleBuys } = factors;
    return `base=$${base} regime=${regime}(${regimeScale}) liq=${liquidityFactor.toFixed(2)} buys=${cycleBuys} budget=$${remainingBudget.toFixed(0)}`;
  };

  /**
   * Preview sizing for multiple ladder steps
   * Useful for planning/UI display
   * @param {RegimeMode} regime - Current regime
   * @param {number} maxSteps - Maximum steps to preview
   * @returns {Array<{step: number, sizeUsdc: number}>}
   */
  const previewLadder = (regime, maxSteps = 10) => {
    const preview = [];
    let cumulativeCost = 0;

    for (let step = 0; step < maxSteps; step++) {
      const result = calculateEntrySize({
        regime,
        cycleBuys: step,
        totalCostBasis: cumulativeCost,
      });

      if (result.sizeUsdc <= 0) break;

      preview.push({
        step,
        sizeUsdc: result.sizeUsdc,
      });

      cumulativeCost += result.sizeUsdc;
    }

    return preview;
  };

  /**
   * Calculate total potential deployment for a ladder
   * @param {RegimeMode} regime - Regime mode
   * @param {number} maxSteps - Maximum steps
   * @returns {number} Total USDC
   */
  const calculateTotalLadder = (regime, maxSteps = 10) => {
    const preview = previewLadder(regime, maxSteps);
    return preview.reduce((sum, step) => sum + step.sizeUsdc, 0);
  };

  return {
    calculateEntrySize,
    calculateBTCQuantity,
    calculateTakeProfitSize,
    meetsMinimum,
    getRegimeScale,
    calculateLiquidityFactor,
    getSizingSummary,
    previewLadder,
    calculateTotalLadder,
  };
};

module.exports = {
  createPositionSizer,
};
