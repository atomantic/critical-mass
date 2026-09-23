// @ts-check
/**
 * Size Optimizer Module
 *
 * Dynamically adjusts position sizing parameters based on:
 * - Available USDC balance
 * - Historical cycle data (steps used, capital deployed)
 * - Target capital utilization
 *
 * Features:
 * - Calculates optimal baseSizeUsdc for target utilization
 * - Optionally adjusts maxCycleBuys based on historical buy depth
 * - Evaluates for a new size adjustment at cycle-completion boundaries
 *   (recordCycle()), fed the real adapter balance
 * - Rate-limited adjustments with safety bounds
 * - State persistence for continuity across restarts
 */

const { roundUSDC } = require('./volatility-utils');
const { createContextLogger } = require('./logger');

/**
 * @typedef {Object} CycleRecord
 * @property {number} stepsUsed - Number of buys used in cycle
 * @property {number} capitalDeployed - USDC deployed in cycle
 * @property {number} completedAt - Timestamp when cycle completed
 * @property {number} availableBalance - Available USDC at cycle completion
 */

/**
 * @typedef {Object} SizeAdjustment
 * @property {number} baseSizeUsdc - New base size in USDC
 * @property {number} maxUsdcDeployed - New max deployment cap
 * @property {number} [maxCycleBuys] - New max cycle buys (optional)
 * @property {string} reason - Adjustment reason
 */

/**
 * @typedef {Object} OptimizerState
 * @property {CycleRecord[]} recentCycles - Recent cycle records
 * @property {Object} stats - Current statistics
 * @property {number} lastEvaluationTime - Last evaluation timestamp
 * @property {number} lastEvaluationCycle - Cycle count at last evaluation
 * @property {number} lastKnownBalance - Last known USDC balance
 * @property {Array<{timestamp: number, baseSizeUsdc: number, maxUsdcDeployed: number, reason: string}>} adjustmentHistory
 */

const MAX_RECENT_CYCLES = 50;

/**
 * Calculate the total ladder multiplier for a given number of steps
 * With divergence-based scaling, per-step factors are unknowable at planning time
 * (they depend on runtime price vs avg cost), so assume factor=1.0 per step.
 * This is conservative — divergence scaling acts as bonus capacity that's still budget-capped.
 *
 * @param {number} maxSteps - Maximum ladder steps
 * @param {number} _liquidityFactorCap - Unused (kept for API compatibility)
 * @returns {number} Total multiplier sum
 */
const calculateTotalStepMultiplier = (maxSteps, _liquidityFactorCap = 2.0) => {
  return maxSteps;
};

/**
 * Create size optimizer instance
 * @param {string} exchange - Exchange name
 * @param {Object} config - Regime configuration
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onAdjustment] - Called when sizing values are adjusted
 * @param {string} [productId] - Trading pair ID
 * @returns {Object} Size optimizer instance
 */
const createSizeOptimizer = (exchange, config, callbacks = {}, productId) => {
  const logger = createContextLogger({ exchange, pair: productId });
  /** @type {CycleRecord[]} */
  let recentCycles = [];

  /** @type {Array<{timestamp: number, baseSizeUsdc: number, maxUsdcDeployed: number, maxCycleBuys?: number, reason: string}>} */
  let adjustmentHistory = [];

  let lastEvaluationTime = Date.now();
  let lastEvaluationCycle = 0;
  let totalCycleCount = 0;
  let lastKnownBalance = 0;

  // Statistics
  let avgStepsUsed = 0;
  let p90StepsUsed = 0;

  /**
   * Record a completed cycle
   * @param {CycleRecord} cycleData - Cycle data
   * @returns {SizeAdjustment|null} Adjustment if triggered, null otherwise
   */
  const recordCycle = (cycleData) => {
    recentCycles.push({
      stepsUsed: cycleData.stepsUsed,
      capitalDeployed: cycleData.capitalDeployed,
      completedAt: cycleData.completedAt || Date.now(),
      availableBalance: cycleData.availableBalance || 0,
    });

    totalCycleCount += 1;

    // Keep recent cycles manageable
    while (recentCycles.length > MAX_RECENT_CYCLES) {
      recentCycles.shift();
    }

    // Update statistics
    updateStatistics();

    // Track balance for change detection
    if (cycleData.availableBalance > 0) {
      lastKnownBalance = cycleData.availableBalance;
    }

    // Check if evaluation is needed
    return evaluate();
  };

  /**
   * Invalidate the cached balance reading (issue #694 review round 2).
   *
   * A caller can lose the ability to attribute the shared exchange wallet to
   * this fund alone (e.g. a sibling fund on the same exchange/quote currency
   * gets added after this fund already had a verified balance) — at that
   * point the previously-recorded `lastKnownBalance` is no longer sound to
   * evaluate against, even though it's still a positive number. Without an
   * explicit reset, `evaluate()`'s `lastKnownBalance <= 0` guard would never
   * catch this: it only guards "never observed a balance," not "observed one
   * that's since become unsound." Reset it back to the same unset state a
   * fresh optimizer starts in, so evaluate() skips until a fresh, unambiguous
   * balance is observed again.
   */
  const invalidateBalance = () => {
    lastKnownBalance = 0;
  };

  /**
   * Update statistics from recent cycles
   */
  const updateStatistics = () => {
    if (recentCycles.length === 0) {
      avgStepsUsed = 0;
      p90StepsUsed = 0;
      return;
    }

    const steps = recentCycles.map(c => c.stepsUsed).sort((a, b) => a - b);
    avgStepsUsed = steps.reduce((sum, s) => sum + s, 0) / steps.length;

    // P90 - 90th percentile of steps used
    const p90Index = Math.floor(steps.length * 0.9);
    p90StepsUsed = steps[Math.min(p90Index, steps.length - 1)];
  };

  /**
   * Evaluate if size adjustment is needed (cycle-based)
   * @returns {SizeAdjustment|null}
   */
  const evaluate = () => {
    if (!config.sizeAutoManaged) {
      return null;
    }

    const now = Date.now();
    const cyclesSinceEval = totalCycleCount - lastEvaluationCycle;
    const hoursSinceEval = (now - lastEvaluationTime) / (1000 * 60 * 60);

    // Evaluation triggers
    const evaluationCycles = config.sizeEvaluationCycles || 5;
    const evaluationMaxHours = config.sizeEvaluationMaxHours || 24;

    const shouldEvaluate = cyclesSinceEval >= evaluationCycles || hoursSinceEval >= evaluationMaxHours;

    if (!shouldEvaluate) {
      return null;
    }

    // Minimum sample size
    const minSampleSize = config.sizeMinSampleSize || 5;
    if (totalCycleCount < minSampleSize) {
      return null;
    }

    // No real balance has ever been observed yet (every recordCycle() call so
    // far arrived with availableBalance <= 0 — e.g. a failed/unavailable
    // exchange balance fetch — so lastKnownBalance is still its 0 initial
    // value, never a verified reading). Evaluating against 0 here would floor
    // baseSizeUsdc to sizeAbsoluteMinBase and (unlike the deliberate,
    // explicit balance=0 case covered by calculateAdjustment's own tests)
    // slash maxUsdcDeployed to 0 with no real signal behind it. Skip this
    // evaluation and wait for a verified balance instead (issue #694 item 2).
    if (lastKnownBalance <= 0) {
      return null;
    }

    const adjustment = calculateAdjustment(lastKnownBalance);

    if (adjustment) {
      lastEvaluationTime = now;
      lastEvaluationCycle = totalCycleCount;

      adjustmentHistory.push({
        timestamp: now,
        baseSizeUsdc: adjustment.baseSizeUsdc,
        maxUsdcDeployed: adjustment.maxUsdcDeployed,
        maxCycleBuys: adjustment.maxCycleBuys,
        reason: adjustment.reason,
      });

      // Keep history manageable
      if (adjustmentHistory.length > 50) {
        adjustmentHistory.shift();
      }

      if (callbacks.onAdjustment) {
        callbacks.onAdjustment(adjustment);
      }
    }

    return adjustment;
  };

  /**
   * Calculate new sizing values
   * @param {number} availableBalance - Available USDC balance
   * @returns {SizeAdjustment|null}
   */
  const calculateAdjustment = (availableBalance) => {
    // Safety bounds from config or defaults
    const absoluteMinBase = config.sizeAbsoluteMinBase || 10;
    const absoluteMaxBase = config.sizeAbsoluteMaxBase || 500;
    const targetUtilization = config.sizeTargetUtilization || 0.90; // 90% by default
    const maxChangePercent = config.sizeMaxChangePercent || 25;

    // Current values
    const currentBaseSizeUsdc = config.baseSizeUsdc;
    const currentMaxCycleBuys = config.maxCycleBuys;
    const liquidityFactorCap = config.liquidityFactorCap || 2.0;

    // Calculate total step multiplier for current max buys
    const totalMultiplier = calculateTotalStepMultiplier(currentMaxCycleBuys, liquidityFactorCap);

    // Target deployment based on available balance
    const targetDeployment = availableBalance * targetUtilization;

    // Calculate optimal base size
    // baseSizeUsdc * totalMultiplier = targetDeployment (in HARVEST mode, scale=1.0)
    let proposedBaseSizeUsdc = targetDeployment / totalMultiplier;

    // Apply absolute bounds
    proposedBaseSizeUsdc = Math.max(absoluteMinBase, Math.min(proposedBaseSizeUsdc, absoluteMaxBase));

    // Rate limiting - max change per adjustment
    const maxChange = currentBaseSizeUsdc * (maxChangePercent / 100);
    let newBaseSizeUsdc = proposedBaseSizeUsdc;
    let reason = 'balance_based';

    if (Math.abs(newBaseSizeUsdc - currentBaseSizeUsdc) > maxChange) {
      newBaseSizeUsdc = newBaseSizeUsdc > currentBaseSizeUsdc
        ? currentBaseSizeUsdc + maxChange
        : currentBaseSizeUsdc - maxChange;
      reason = 'rate_limited';
    }

    // Round to 2 decimal places
    newBaseSizeUsdc = roundUSDC(newBaseSizeUsdc);

    // Calculate new maxUsdcDeployed to match
    const newMaxUsdcDeployed = roundUSDC(availableBalance * targetUtilization);

    // Optionally adjust max cycle buys based on historical data
    let newMaxCycleBuys = undefined;
    if (config.sizeAutoCycleBuys && recentCycles.length >= 10) {
      // Use p90 steps * 1.5 as buffer, with min/max bounds
      const proposedSteps = Math.ceil(p90StepsUsed * 1.5);
      const minSteps = config.sizeMinCycleBuys || 10;
      const maxSteps = config.sizeMaxCycleBuys || 100;
      newMaxCycleBuys = Math.max(minSteps, Math.min(proposedSteps, maxSteps));

      // Only include if significantly different from current
      if (Math.abs(newMaxCycleBuys - currentMaxCycleBuys) < 3) {
        newMaxCycleBuys = undefined;
      }
    }

    // Check if values actually changed (beyond 1% threshold)
    const baseChanged = Math.abs(newBaseSizeUsdc - currentBaseSizeUsdc) / currentBaseSizeUsdc > 0.01;
    const deployChanged = Math.abs(newMaxUsdcDeployed - config.maxUsdcDeployed) / config.maxUsdcDeployed > 0.01;
    const stepsChanged = newMaxCycleBuys !== undefined && newMaxCycleBuys !== currentMaxCycleBuys;

    if (!baseChanged && !deployChanged && !stepsChanged) {
      return null;
    }

    const details = [
      `base: $${currentBaseSizeUsdc}→$${newBaseSizeUsdc}`,
      `cap: $${config.maxUsdcDeployed.toFixed(0)}→$${newMaxUsdcDeployed.toFixed(0)}`,
    ];
    if (newMaxCycleBuys !== undefined) {
      details.push(`steps: ${currentMaxCycleBuys}→${newMaxCycleBuys}`);
    }

    return {
      baseSizeUsdc: newBaseSizeUsdc,
      maxUsdcDeployed: newMaxUsdcDeployed,
      maxCycleBuys: newMaxCycleBuys,
      reason: `${reason}: ${details.join(', ')}`,
    };
  };

  /**
   * Preview what the sizing would be for a given balance
   * @param {number} balance - USDC balance to calculate for
   * @returns {Object} Preview of sizing values
   */
  const previewSizing = (balance) => {
    const liquidityFactorCap = config.liquidityFactorCap || 2.0;
    const targetUtilization = config.sizeTargetUtilization || 0.90;
    const maxCycleBuys = config.maxCycleBuys;

    const totalMultiplier = calculateTotalStepMultiplier(maxCycleBuys, liquidityFactorCap);
    const targetDeployment = balance * targetUtilization;
    const optimalBaseSizeUsdc = roundUSDC(targetDeployment / totalMultiplier);

    // Calculate expected deployment per regime
    const harvestScale = config.harvestScale || 1.0;
    const cautionScale = config.cautionScale || 0.5;

    const harvestDeployment = optimalBaseSizeUsdc * totalMultiplier * harvestScale;
    const cautionDeployment = optimalBaseSizeUsdc * totalMultiplier * cautionScale;

    return {
      balance,
      targetUtilization,
      targetDeployment,
      totalMultiplier: roundUSDC(totalMultiplier),
      maxCycleBuys,
      optimalBaseSizeUsdc,
      currentBaseSizeUsdc: config.baseSizeUsdc,
      expectedDeployment: {
        harvest: roundUSDC(harvestDeployment),
        caution: roundUSDC(cautionDeployment),
      },
      currentDeployment: {
        harvest: roundUSDC(config.baseSizeUsdc * totalMultiplier * harvestScale),
        caution: roundUSDC(config.baseSizeUsdc * totalMultiplier * cautionScale),
      },
      utilizationPercent: {
        harvest: roundUSDC((harvestDeployment / balance) * 100),
        caution: roundUSDC((cautionDeployment / balance) * 100),
      },
    };
  };

  /**
   * Export state for persistence
   * @returns {OptimizerState}
   */
  const exportState = () => ({
    recentCycles: [...recentCycles],
    stats: {
      totalCycleCount,
      avgStepsUsed,
      p90StepsUsed,
    },
    lastEvaluationTime,
    lastEvaluationCycle,
    lastKnownBalance,
    adjustmentHistory: [...adjustmentHistory],
  });

  /**
   * Import state from persistence
   * @param {OptimizerState} state - State to restore
   */
  const importState = (state) => {
    if (!state) return;

    if (state.recentCycles) {
      recentCycles = state.recentCycles.map(c => ({ ...c }));
    }

    if (state.stats) {
      totalCycleCount = state.stats.totalCycleCount || 0;
      avgStepsUsed = state.stats.avgStepsUsed || 0;
      p90StepsUsed = state.stats.p90StepsUsed || 0;
    }

    lastEvaluationTime = state.lastEvaluationTime || Date.now();
    lastEvaluationCycle = state.lastEvaluationCycle || 0;
    lastKnownBalance = state.lastKnownBalance || 0;

    if (state.adjustmentHistory) {
      adjustmentHistory = state.adjustmentHistory.map(a => ({ ...a }));
    }

    logger.info(`📊 [${exchange}] Size optimizer restored: ${totalCycleCount} cycles, avg ${avgStepsUsed.toFixed(1)} steps, p90 ${p90StepsUsed} steps`, {
      totalCycleCount, averageStepsUsed: avgStepsUsed, p90StepsUsed,
    });
  };

  /**
   * Get current status for dashboard
   * @returns {Object}
   */
  const getStatus = () => ({
    enabled: config.sizeAutoManaged === true,
    totalCycleCount,
    recentCycleCount: recentCycles.length,
    stats: {
      avgStepsUsed: roundUSDC(avgStepsUsed),
      p90StepsUsed,
    },
    lastKnownBalance,
    lastEvaluationTime,
    lastEvaluationCycle,
    cyclesSinceEval: totalCycleCount - lastEvaluationCycle,
    currentConfig: {
      baseSizeUsdc: config.baseSizeUsdc,
      maxUsdcDeployed: config.maxUsdcDeployed,
      maxCycleBuys: config.maxCycleBuys,
    },
    adjustmentHistory: adjustmentHistory.slice(-10),
  });

  /**
   * Reset optimizer state
   */
  const reset = () => {
    recentCycles = [];
    adjustmentHistory = [];
    lastEvaluationTime = Date.now();
    lastEvaluationCycle = 0;
    totalCycleCount = 0;
    lastKnownBalance = 0;
    avgStepsUsed = 0;
    p90StepsUsed = 0;
    logger.info(`📊 [${exchange}] Size optimizer reset`, { lifecycle: 'reset' });
  };

  return {
    recordCycle,
    invalidateBalance,
    evaluate,
    previewSizing,
    getStatus,
    exportState,
    importState,
    reset,
    // Utility export
    calculateTotalStepMultiplier,
    // For testing
    _calculateAdjustment: calculateAdjustment,
  };
};

module.exports = {
  createSizeOptimizer,
  calculateTotalStepMultiplier,
};
