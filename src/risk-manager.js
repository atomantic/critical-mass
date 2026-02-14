// @ts-check
/**
 * Risk Manager
 *
 * Enforces position limits and tracks risk metrics:
 * - BTC exposure caps
 * - USDC deployment caps
 * - Maximum drawdown tracking
 * - Ladder step limits
 *
 * All checks return structured results for consistent handling.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * Create risk manager instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @returns {Object} Risk manager instance
 */
const createRiskManager = (exchange, config) => {
  let peakEquity = null; // null = uninitialized, will be set to first observed equity
  let maxDrawdownSeen = 0;
  let isDrawdownPaused = false;
  let drawdownPausedAt = null; // Timestamp when drawdown pause started
  let cycleBuysLimitReachedAt = null; // Timestamp when ladder limit was first reached

  /**
   * Check if entry would exceed BTC exposure cap
   * @param {number} currentAsset - Current BTC position
   * @param {number} entryAsset - BTC amount to add
   * @returns {{allowed: boolean, reason: string|null, currentAsset: number, maxAsset: number}}
   */
  const checkAssetCap = (currentAsset, entryAsset) => {
    const newTotal = currentAsset + entryAsset;

    if (newTotal > config.maxAssetExposure) {
      return {
        allowed: false,
        reason: `btc_cap_exceeded:${roundAsset(newTotal)}>${config.maxAssetExposure}`,
        currentAsset,
        maxAsset: config.maxAssetExposure,
      };
    }

    return {
      allowed: true,
      reason: null,
      currentAsset,
      maxAsset: config.maxAssetExposure,
    };
  };

  /**
   * Check if entry would exceed USDC deployment cap
   * @param {number} currentDeployed - Current USDC deployed
   * @param {number} entryUsdc - USDC amount to add
   * @returns {{allowed: boolean, reason: string|null, currentUsdc: number, maxUsdc: number}}
   */
  const checkUSDCCap = (currentDeployed, entryUsdc) => {
    const newTotal = currentDeployed + entryUsdc;

    if (newTotal > config.maxUsdcDeployed) {
      return {
        allowed: false,
        reason: `usdc_cap_exceeded:${roundUSDC(newTotal)}>${config.maxUsdcDeployed}`,
        currentUsdc: currentDeployed,
        maxUsdc: config.maxUsdcDeployed,
      };
    }

    return {
      allowed: true,
      reason: null,
      currentUsdc: currentDeployed,
      maxUsdc: config.maxUsdcDeployed,
    };
  };

  /**
   * Check if cycle buys limit is reached
   * @param {number} currentStep - Current cycle buy count
   * @returns {{allowed: boolean, reason: string|null, currentStep: number, maxSteps: number, shouldReset: boolean}}
   */
  const checkCycleBuysLimit = (currentStep) => {
    if (currentStep >= config.maxCycleBuys) {
      // Track when limit was first reached
      if (!cycleBuysLimitReachedAt) {
        cycleBuysLimitReachedAt = Date.now();
        console.log(`⚠️ [${exchange}] Cycle buys limit reached: ${currentStep}/${config.maxCycleBuys}, waiting for TP or auto-reset`);
      }

      // Check for time-based auto-reset
      if (cycleBuysLimitReachedAt && config.cycleResetHours > 0) {
        const atLimitMs = Date.now() - cycleBuysLimitReachedAt;
        const atLimitHours = atLimitMs / (1000 * 60 * 60);
        if (atLimitHours >= config.cycleResetHours) {
          console.log(`🔄 [${exchange}] Auto-resetting cycle buys after ${config.cycleResetHours}h at limit`);
          cycleBuysLimitReachedAt = null;
          return {
            allowed: true,
            reason: null,
            currentStep,
            maxSteps: config.maxCycleBuys,
            shouldReset: true, // Signal to regime engine to reset cycleBuys
          };
        }
      }

      return {
        allowed: false,
        reason: `cycle_buys_limit_reached:${currentStep}>=${config.maxCycleBuys}`,
        currentStep,
        maxSteps: config.maxCycleBuys,
        shouldReset: false,
      };
    }

    // Not at limit, clear the timestamp
    cycleBuysLimitReachedAt = null;

    return {
      allowed: true,
      reason: null,
      currentStep,
      maxSteps: config.maxCycleBuys,
      shouldReset: false,
    };
  };

  /**
   * Update equity and check drawdown
   * @param {number} totalAsset - Current BTC position
   * @param {number} currentPrice - Current BTC price
   * @param {number} totalCostBasis - Total cost invested
   * @returns {{drawdownPercent: number, isPaused: boolean, peakEquity: number}}
   */
  const updateDrawdown = (totalAsset, currentPrice, totalCostBasis) => {
    // Calculate current equity as position market value (not P&L)
    // This ensures we track drawdown from the actual capital at risk
    const currentEquity = totalAsset * currentPrice;

    // Skip drawdown tracking if no position
    if (totalAsset <= 0 || currentEquity <= 0) {
      return {
        drawdownPercent: 0,
        isPaused: isDrawdownPaused,
        peakEquity: peakEquity || 0,
        drawdownPausedAt,
      };
    }

    // Initialize peakEquity on first observation with a position
    if (peakEquity === null) {
      peakEquity = currentEquity;
      console.log(`📊 [${exchange}] Initialized peak equity to $${peakEquity.toFixed(2)}`);
    }

    // Check for time-based reset if paused and configured
    if (isDrawdownPaused && drawdownPausedAt && config.drawdownResetHours > 0) {
      const pausedMs = Date.now() - drawdownPausedAt;
      const pausedHours = pausedMs / (1000 * 60 * 60);
      if (pausedHours >= config.drawdownResetHours) {
        console.log(`🔄 [${exchange}] Auto-resetting peak after ${config.drawdownResetHours}h of drawdown pause`);
        peakEquity = currentEquity; // Reset peak to current equity
        isDrawdownPaused = false;
        drawdownPausedAt = null;
      }
    }

    // Update peak
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }

    // Calculate drawdown from peak
    const drawdownPercent = ((peakEquity - currentEquity) / peakEquity) * 100;

    // Track max drawdown
    if (drawdownPercent > maxDrawdownSeen) {
      maxDrawdownSeen = drawdownPercent;
    }

    // Check if we should pause
    if (drawdownPercent >= config.maxDrawdownPercent) {
      if (!isDrawdownPaused) {
        isDrawdownPaused = true;
        drawdownPausedAt = Date.now();
        console.log(`⚠️ [${exchange}] Drawdown limit reached: ${drawdownPercent.toFixed(1)}% >= ${config.maxDrawdownPercent}%`);
      }
    } else if (isDrawdownPaused && drawdownPercent < config.maxDrawdownPercent * 0.5) {
      // Resume if drawdown recovers to half of limit
      isDrawdownPaused = false;
      drawdownPausedAt = null;
      console.log(`✅ [${exchange}] Drawdown recovered: ${drawdownPercent.toFixed(1)}%`);
    }

    return {
      drawdownPercent,
      isPaused: isDrawdownPaused,
      peakEquity,
      drawdownPausedAt,
    };
  };

  /**
   * Check all caps and return combined result
   * @param {RegimePositionState} position - Current position state
   * @param {number} entryAsset - BTC to add (optional)
   * @param {number} entryUsdc - USDC to add (optional)
   * @returns {{allowed: boolean, reasons: string[], shouldResetCycleBuys: boolean}}
   */
  const checkAllCaps = (position, entryAsset = 0, entryUsdc = 0) => {
    const reasons = [];
    let shouldResetCycleBuys = false;

    const btcCheck = checkAssetCap(position.totalAsset, entryAsset);
    if (!btcCheck.allowed) {
      reasons.push(btcCheck.reason);
    }

    const usdcCheck = checkUSDCCap(position.totalCostBasis, entryUsdc);
    if (!usdcCheck.allowed) {
      reasons.push(usdcCheck.reason);
    }

    const ladderCheck = checkCycleBuysLimit(position.cycleBuys);
    if (!ladderCheck.allowed) {
      reasons.push(ladderCheck.reason);
    }
    if (ladderCheck.shouldReset) {
      shouldResetCycleBuys = true;
    }

    if (isDrawdownPaused) {
      reasons.push(`drawdown_paused:${maxDrawdownSeen.toFixed(1)}%`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      shouldResetCycleBuys,
    };
  };

  /**
   * Check if entry is allowed (combined caps check)
   * @param {RegimePositionState} position - Current position
   * @param {number} entryAsset - BTC to add
   * @param {number} entryUsdc - USDC to add
   * @returns {{allowed: boolean, reason: string|null, shouldResetCycleBuys: boolean}}
   */
  const canPlaceEntry = (position, entryAsset, entryUsdc) => {
    const result = checkAllCaps(position, entryAsset, entryUsdc);

    if (!result.allowed) {
      return {
        allowed: false,
        reason: result.reasons.join(', '),
        shouldResetCycleBuys: result.shouldResetCycleBuys,
      };
    }

    return { allowed: true, reason: null, shouldResetCycleBuys: result.shouldResetCycleBuys };
  };

  /**
   * Calculate remaining capacity
   * @param {RegimePositionState} position - Current position
   * @param {number} currentPrice - Current BTC price
   * @returns {{remainingAsset: number, remainingUsdc: number, remainingSteps: number}}
   */
  const getRemainingCapacity = (position, currentPrice) => {
    const remainingAsset = roundAsset(config.maxAssetExposure - position.totalAsset);
    const remainingUsdc = roundUSDC(config.maxUsdcDeployed - position.totalCostBasis);
    const remainingSteps = config.maxCycleBuys - position.cycleBuys;

    return {
      remainingAsset: Math.max(0, remainingAsset),
      remainingUsdc: Math.max(0, remainingUsdc),
      remainingSteps: Math.max(0, remainingSteps),
    };
  };

  /**
   * Get utilization percentages
   * @param {RegimePositionState} position - Current position
   * @returns {{btcUtilization: number, usdcUtilization: number, cycleBuysUtilization: number}}
   */
  const getUtilization = (position) => {
    return {
      btcUtilization: (position.totalAsset / config.maxAssetExposure) * 100,
      usdcUtilization: (position.totalCostBasis / config.maxUsdcDeployed) * 100,
      cycleBuysUtilization: (position.cycleBuys / config.maxCycleBuys) * 100,
    };
  };

  /**
   * Get risk summary for logging
   * @param {RegimePositionState} position - Current position
   * @returns {string}
   */
  const getSummary = (position) => {
    const util = getUtilization(position);
    const parts = [
      `btc=${position.totalAsset.toFixed(4)}/${config.maxAssetExposure}(${util.btcUtilization.toFixed(0)}%)`,
      `usdc=$${position.totalCostBasis.toFixed(0)}/${config.maxUsdcDeployed}(${util.usdcUtilization.toFixed(0)}%)`,
      `buys=${position.cycleBuys}/${config.maxCycleBuys}`,
    ];

    if (maxDrawdownSeen > 0) {
      parts.push(`dd=${maxDrawdownSeen.toFixed(1)}%`);
    }

    if (isDrawdownPaused) {
      if (drawdownPausedAt) {
        const pausedHours = ((Date.now() - drawdownPausedAt) / (1000 * 60 * 60)).toFixed(1);
        parts.push(`PAUSED(${pausedHours}h)`);
      } else {
        parts.push('PAUSED');
      }
    }

    return parts.join(' ');
  };

  /**
   * Reset risk tracking (for new cycle)
   */
  const resetCycleTracking = () => {
    peakEquity = null; // Reset to uninitialized
    // Don't reset maxDrawdownSeen - it's a session metric
  };

  /**
   * Get current risk state
   * @returns {{peakEquity: number, maxDrawdownSeen: number, isDrawdownPaused: boolean, drawdownPausedAt: number|null, drawdownPausedHours: number|null}}
   */
  const getState = () => {
    let drawdownPausedHours = null;
    if (isDrawdownPaused && drawdownPausedAt) {
      drawdownPausedHours = (Date.now() - drawdownPausedAt) / (1000 * 60 * 60);
    }
    return {
      peakEquity,
      maxDrawdownSeen,
      isDrawdownPaused,
      drawdownPausedAt,
      drawdownPausedHours,
      drawdownResetHours: config.drawdownResetHours,
    };
  };

  /**
   * Force resume from drawdown pause (manual override)
   * @param {number} [currentEquity] - Current equity to set as new peak (optional)
   */
  const forceResume = (currentEquity) => {
    if (isDrawdownPaused) {
      isDrawdownPaused = false;
      drawdownPausedAt = null;
      if (currentEquity !== undefined) {
        peakEquity = currentEquity; // Reset peak to current equity
      }
      console.log(`▶️ [${exchange}] Manually resumed from drawdown pause, peak reset to ${peakEquity.toFixed(2)}`);
    }
  };

  return {
    checkAssetCap,
    checkUSDCCap,
    checkCycleBuysLimit,
    updateDrawdown,
    checkAllCaps,
    canPlaceEntry,
    getRemainingCapacity,
    getUtilization,
    getSummary,
    resetCycleTracking,
    getState,
    forceResume,
  };
};

module.exports = {
  createRiskManager,
};
