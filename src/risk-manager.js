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

const { roundBTC, roundUSDC } = require('./volatility-utils');

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
  let peakEquity = 0;
  let maxDrawdownSeen = 0;
  let isDrawdownPaused = false;
  let drawdownPausedAt = null; // Timestamp when drawdown pause started
  let ladderLimitReachedAt = null; // Timestamp when ladder limit was first reached

  /**
   * Check if entry would exceed BTC exposure cap
   * @param {number} currentBTC - Current BTC position
   * @param {number} entryBTC - BTC amount to add
   * @returns {{allowed: boolean, reason: string|null, currentBTC: number, maxBTC: number}}
   */
  const checkBTCCap = (currentBTC, entryBTC) => {
    const newTotal = currentBTC + entryBTC;

    if (newTotal > config.maxBtcExposure) {
      return {
        allowed: false,
        reason: `btc_cap_exceeded:${roundBTC(newTotal)}>${config.maxBtcExposure}`,
        currentBTC,
        maxBTC: config.maxBtcExposure,
      };
    }

    return {
      allowed: true,
      reason: null,
      currentBTC,
      maxBTC: config.maxBtcExposure,
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
   * Check if ladder step limit is reached
   * @param {number} currentStep - Current ladder step
   * @returns {{allowed: boolean, reason: string|null, currentStep: number, maxSteps: number, shouldReset: boolean}}
   */
  const checkLadderLimit = (currentStep) => {
    if (currentStep >= config.maxLadderSteps) {
      // Track when limit was first reached
      if (!ladderLimitReachedAt) {
        ladderLimitReachedAt = Date.now();
        console.log(`⚠️ [${exchange}] Ladder limit reached: ${currentStep}/${config.maxLadderSteps}, waiting for TP or auto-reset`);
      }

      // Check for time-based auto-reset
      if (ladderLimitReachedAt && config.ladderResetHours > 0) {
        const atLimitMs = Date.now() - ladderLimitReachedAt;
        const atLimitHours = atLimitMs / (1000 * 60 * 60);
        if (atLimitHours >= config.ladderResetHours) {
          console.log(`🔄 [${exchange}] Auto-resetting ladder after ${config.ladderResetHours}h at limit`);
          ladderLimitReachedAt = null;
          return {
            allowed: true,
            reason: null,
            currentStep,
            maxSteps: config.maxLadderSteps,
            shouldReset: true, // Signal to regime engine to reset ladderStep
          };
        }
      }

      return {
        allowed: false,
        reason: `ladder_limit_reached:${currentStep}>=${config.maxLadderSteps}`,
        currentStep,
        maxSteps: config.maxLadderSteps,
        shouldReset: false,
      };
    }

    // Not at limit, clear the timestamp
    ladderLimitReachedAt = null;

    return {
      allowed: true,
      reason: null,
      currentStep,
      maxSteps: config.maxLadderSteps,
      shouldReset: false,
    };
  };

  /**
   * Update equity and check drawdown
   * @param {number} totalBTC - Current BTC position
   * @param {number} currentPrice - Current BTC price
   * @param {number} totalCostBasis - Total cost invested
   * @returns {{drawdownPercent: number, isPaused: boolean, peakEquity: number}}
   */
  const updateDrawdown = (totalBTC, currentPrice, totalCostBasis) => {
    // Calculate current equity value
    const currentValue = totalBTC * currentPrice;
    const currentEquity = currentValue - totalCostBasis;

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
    let drawdownPercent = 0;
    if (peakEquity > 0) {
      drawdownPercent = ((peakEquity - currentEquity) / peakEquity) * 100;
    }

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
   * @param {number} entryBTC - BTC to add (optional)
   * @param {number} entryUsdc - USDC to add (optional)
   * @returns {{allowed: boolean, reasons: string[], shouldResetLadder: boolean}}
   */
  const checkAllCaps = (position, entryBTC = 0, entryUsdc = 0) => {
    const reasons = [];
    let shouldResetLadder = false;

    const btcCheck = checkBTCCap(position.totalBTC, entryBTC);
    if (!btcCheck.allowed) {
      reasons.push(btcCheck.reason);
    }

    const usdcCheck = checkUSDCCap(position.totalCostBasis, entryUsdc);
    if (!usdcCheck.allowed) {
      reasons.push(usdcCheck.reason);
    }

    const ladderCheck = checkLadderLimit(position.ladderStep);
    if (!ladderCheck.allowed) {
      reasons.push(ladderCheck.reason);
    }
    if (ladderCheck.shouldReset) {
      shouldResetLadder = true;
    }

    if (isDrawdownPaused) {
      reasons.push(`drawdown_paused:${maxDrawdownSeen.toFixed(1)}%`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      shouldResetLadder,
    };
  };

  /**
   * Check if entry is allowed (combined caps check)
   * @param {RegimePositionState} position - Current position
   * @param {number} entryBTC - BTC to add
   * @param {number} entryUsdc - USDC to add
   * @returns {{allowed: boolean, reason: string|null, shouldResetLadder: boolean}}
   */
  const canPlaceEntry = (position, entryBTC, entryUsdc) => {
    const result = checkAllCaps(position, entryBTC, entryUsdc);

    if (!result.allowed) {
      return {
        allowed: false,
        reason: result.reasons.join(', '),
        shouldResetLadder: result.shouldResetLadder,
      };
    }

    return { allowed: true, reason: null, shouldResetLadder: result.shouldResetLadder };
  };

  /**
   * Calculate remaining capacity
   * @param {RegimePositionState} position - Current position
   * @param {number} currentPrice - Current BTC price
   * @returns {{remainingBTC: number, remainingUsdc: number, remainingSteps: number}}
   */
  const getRemainingCapacity = (position, currentPrice) => {
    const remainingBTC = roundBTC(config.maxBtcExposure - position.totalBTC);
    const remainingUsdc = roundUSDC(config.maxUsdcDeployed - position.totalCostBasis);
    const remainingSteps = config.maxLadderSteps - position.ladderStep;

    return {
      remainingBTC: Math.max(0, remainingBTC),
      remainingUsdc: Math.max(0, remainingUsdc),
      remainingSteps: Math.max(0, remainingSteps),
    };
  };

  /**
   * Get utilization percentages
   * @param {RegimePositionState} position - Current position
   * @returns {{btcUtilization: number, usdcUtilization: number, ladderUtilization: number}}
   */
  const getUtilization = (position) => {
    return {
      btcUtilization: (position.totalBTC / config.maxBtcExposure) * 100,
      usdcUtilization: (position.totalCostBasis / config.maxUsdcDeployed) * 100,
      ladderUtilization: (position.ladderStep / config.maxLadderSteps) * 100,
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
      `btc=${position.totalBTC.toFixed(4)}/${config.maxBtcExposure}(${util.btcUtilization.toFixed(0)}%)`,
      `usdc=$${position.totalCostBasis.toFixed(0)}/${config.maxUsdcDeployed}(${util.usdcUtilization.toFixed(0)}%)`,
      `steps=${position.ladderStep}/${config.maxLadderSteps}`,
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
    peakEquity = 0;
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
    checkBTCCap,
    checkUSDCCap,
    checkLadderLimit,
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
