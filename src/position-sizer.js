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
   * @param {number} params.ladderStep - Current ladder step (0-indexed)
   * @param {number} params.totalCostBasis - Current cost basis
   * @param {number} [params.bidDepthUsdc] - Bid depth in USDC (optional)
   * @param {number} [params.baselineDepth] - Baseline depth for comparison (optional)
   * @returns {{sizeUsdc: number, sizeBTC: number, factors: Object}}
   */
  const calculateEntrySize = (params) => {
    const { regime, ladderStep, totalCostBasis, bidDepthUsdc, baselineDepth } = params;

    // Get regime scale factor
    const regimeScale = getRegimeScale(regime);

    // Get liquidity factor
    const liquidityFactor = calculateLiquidityFactor(ladderStep, bidDepthUsdc, baselineDepth);

    // Calculate raw size
    let sizeUsdc = config.baseSizeUsdc * regimeScale * liquidityFactor;

    // Check remaining budget
    const remainingBudget = config.maxUsdcDeployed - totalCostBasis;
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
        ladderStep,
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
   * @param {number} ladderStep - Current ladder step
   * @param {number} [bidDepthUsdc] - Current bid depth
   * @param {number} [baselineDepth] - Baseline depth
   * @returns {number} Liquidity factor
   */
  const calculateLiquidityFactor = (ladderStep, bidDepthUsdc, baselineDepth) => {
    // If L2 depth is available, use sqrt scaling
    if (bidDepthUsdc !== undefined && baselineDepth !== undefined && baselineDepth > 0) {
      const depthRatio = bidDepthUsdc / baselineDepth;
      const factor = Math.sqrt(depthRatio);
      return Math.min(factor, config.liquidityFactorCap);
    }

    // Fallback: geometric scaling based on ladder step
    // factor = 1 + (step * 0.1), capped
    const stepFactor = 1 + (ladderStep * 0.1);
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
   * Calculate take-profit size (accounts for holdback)
   * @param {number} totalBTC - Total BTC position
   * @returns {{sellQty: number, holdbackQty: number}}
   */
  const calculateTakeProfitSize = (totalBTC) => {
    const holdbackQty = roundBTC(totalBTC * (config.holdbackPercent / 100));
    const sellQty = roundBTC(totalBTC - holdbackQty);

    return {
      sellQty,
      holdbackQty,
    };
  };

  /**
   * Get sizing summary for logging
   * @param {Object} factors - Sizing factors from calculateEntrySize
   * @returns {string}
   */
  const getSizingSummary = (factors) => {
    const { base, regimeScale, liquidityFactor, remainingBudget, regime, ladderStep } = factors;
    return `base=$${base} regime=${regime}(${regimeScale}) liq=${liquidityFactor.toFixed(2)} step=${ladderStep} budget=$${remainingBudget.toFixed(0)}`;
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
        ladderStep: step,
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
