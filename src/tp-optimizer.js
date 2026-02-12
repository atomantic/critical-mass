// @ts-check
/**
 * TP Optimizer Module
 *
 * Dynamically adjusts take-profit parameters based on observed cycle data.
 * Features:
 * - Records cycle analytics (optimal TP %, volatility context)
 * - Compresses data into histogram buckets with time-weighted decay
 * - Calculates percentiles (p25, p50, p75) from compressed data
 * - Recommends new TP values with safety bounds and rate limiting
 */

const { roundUSDC } = require('./volatility-utils');

/**
 * @typedef {Object} CycleRecord
 * @property {number} optimalTpPct - Best possible TP % for this cycle
 * @property {number} actualTpPct - Actual TP % achieved
 * @property {number} completedAt - Timestamp when cycle completed
 * @property {number} volBaseline - Volatility baseline at completion
 */

/**
 * @typedef {Object} HistogramBucket
 * @property {number} min - Bucket lower bound
 * @property {number} max - Bucket upper bound
 * @property {number} weight - Time-decayed weight
 * @property {number} count - Number of samples
 */

/**
 * @typedef {Object} TpAdjustment
 * @property {number} tpMinPercent - New minimum TP %
 * @property {number} tpMaxPercent - New maximum TP %
 * @property {number} holdbackRatio - Ratio of position to hold vs sell (0.0-1.0)
 * @property {string} reason - Adjustment reason
 */

/**
 * @typedef {Object} OptimizerState
 * @property {HistogramBucket[]} histogram - Compressed historical data
 * @property {CycleRecord[]} recentCycles - Recent raw cycles
 * @property {Object} stats - Current statistics
 * @property {number} lastEvaluationTime - Last evaluation timestamp
 * @property {number} lastEvaluationCycle - Cycle count at last evaluation
 * @property {Array<{timestamp: number, tpMin: number, tpMax: number, holdbackRatio: number, reason: string}>} adjustmentHistory
 */

const BUCKET_COUNT = 20;
const BUCKET_RANGE_MIN = 0;
const BUCKET_RANGE_MAX = 5;
const MAX_RECENT_CYCLES = 50;
const TIME_DECAY_ALPHA = 0.95;

/**
 * Create histogram buckets
 * @returns {HistogramBucket[]}
 */
const createEmptyHistogram = () => {
  const buckets = [];
  const bucketWidth = (BUCKET_RANGE_MAX - BUCKET_RANGE_MIN) / BUCKET_COUNT;

  for (let i = 0; i < BUCKET_COUNT; i++) {
    buckets.push({
      min: BUCKET_RANGE_MIN + i * bucketWidth,
      max: BUCKET_RANGE_MIN + (i + 1) * bucketWidth,
      weight: 0,
      count: 0,
    });
  }

  return buckets;
};

/**
 * Find bucket index for a value
 * @param {number} value - Value to bucket
 * @returns {number} Bucket index (clamped to valid range)
 */
const getBucketIndex = (value) => {
  const bucketWidth = (BUCKET_RANGE_MAX - BUCKET_RANGE_MIN) / BUCKET_COUNT;
  const idx = Math.floor((value - BUCKET_RANGE_MIN) / bucketWidth);
  return Math.max(0, Math.min(BUCKET_COUNT - 1, idx));
};

/**
 * Create TP optimizer instance
 * @param {string} exchange - Exchange name
 * @param {Object} config - Regime configuration
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onAdjustment] - Called when TP values are adjusted
 * @returns {Object} TP optimizer instance
 */
const createTpOptimizer = (exchange, config, callbacks = {}) => {
  /** @type {HistogramBucket[]} */
  let histogram = createEmptyHistogram();

  /** @type {CycleRecord[]} */
  let recentCycles = [];

  /** @type {Array<{timestamp: number, tpMin: number, tpMax: number, holdback: number, reason: string}>} */
  let adjustmentHistory = [];

  let lastEvaluationTime = Date.now();
  let lastEvaluationCycle = 0;
  let totalSampleCount = 0;
  let avgVolBaseline = 0;
  let historicalVolBaseline = 0; // Slower-moving historical vol for volFactor comparison

  // Cache for percentile calculations
  let cachedPercentiles = { p25: 0, p50: 0, p75: 0 };
  let percentileCacheValid = false;

  /**
   * Apply time decay to histogram
   */
  const applyTimeDecay = () => {
    for (const bucket of histogram) {
      bucket.weight *= TIME_DECAY_ALPHA;
    }
  };

  /**
   * Add a sample to histogram
   * @param {number} value - Value to add
   * @param {number} [weight=1] - Sample weight
   */
  const addToHistogram = (value, weight = 1) => {
    const idx = getBucketIndex(value);
    histogram[idx].weight += weight;
    histogram[idx].count += 1;
    percentileCacheValid = false;
  };

  /**
   * Calculate percentiles from histogram and recent cycles
   * @returns {{p25: number, p50: number, p75: number}}
   */
  const calculatePercentiles = () => {
    if (percentileCacheValid) {
      return cachedPercentiles;
    }

    // Combine histogram weights with recent cycle data
    const combinedBuckets = histogram.map(b => ({ ...b }));

    // Add recent cycles to combined buckets with full weight
    for (const cycle of recentCycles) {
      const idx = getBucketIndex(cycle.optimalTpPct);
      combinedBuckets[idx].weight += 1;
    }

    // Calculate total weight
    const totalWeight = combinedBuckets.reduce((sum, b) => sum + b.weight, 0);

    if (totalWeight === 0) {
      cachedPercentiles = { p25: 0, p50: 0, p75: 0 };
      percentileCacheValid = true;
      return cachedPercentiles;
    }

    // Find percentiles
    const findPercentile = (pct) => {
      const targetWeight = totalWeight * pct;
      let cumWeight = 0;

      for (const bucket of combinedBuckets) {
        cumWeight += bucket.weight;
        if (cumWeight >= targetWeight) {
          // Linear interpolation within bucket
          const prevCumWeight = cumWeight - bucket.weight;
          const ratio = bucket.weight > 0 ? (targetWeight - prevCumWeight) / bucket.weight : 0.5;
          return bucket.min + ratio * (bucket.max - bucket.min);
        }
      }

      return combinedBuckets[combinedBuckets.length - 1].max;
    };

    cachedPercentiles = {
      p25: findPercentile(0.25),
      p50: findPercentile(0.50),
      p75: findPercentile(0.75),
    };
    percentileCacheValid = true;

    return cachedPercentiles;
  };

  /**
   * Compress old cycles into histogram
   */
  const compressOldCycles = () => {
    // Keep only the most recent cycles in raw form
    while (recentCycles.length > MAX_RECENT_CYCLES) {
      const oldest = recentCycles.shift();
      if (oldest) {
        addToHistogram(oldest.optimalTpPct);
      }
    }
  };

  /**
   * Record a completed cycle
   * @param {CycleRecord} cycleData - Cycle data
   * @returns {TpAdjustment|null} Adjustment if triggered, null otherwise
   */
  const recordCycle = (cycleData) => {
    // Add to recent cycles
    recentCycles.push({
      optimalTpPct: cycleData.optimalTpPct,
      actualTpPct: cycleData.actualTpPct,
      completedAt: cycleData.completedAt || Date.now(),
      volBaseline: cycleData.volBaseline || 0,
    });

    // Update stats
    totalSampleCount += 1;
    avgVolBaseline = avgVolBaseline === 0
      ? cycleData.volBaseline
      : avgVolBaseline * 0.95 + cycleData.volBaseline * 0.05;
    historicalVolBaseline = historicalVolBaseline === 0
      ? cycleData.volBaseline
      : historicalVolBaseline * 0.99 + cycleData.volBaseline * 0.01;

    // Compress if needed
    compressOldCycles();

    // Invalidate cache
    percentileCacheValid = false;

    // Check if evaluation is needed
    return evaluate();
  };

  /**
   * Evaluate if TP adjustment is needed
   * @returns {TpAdjustment|null}
   */
  const evaluate = () => {
    if (!config.tpAutoManaged) {
      return null;
    }

    const now = Date.now();
    const cyclesSinceEval = totalSampleCount - lastEvaluationCycle;
    const hoursSinceEval = (now - lastEvaluationTime) / (1000 * 60 * 60);

    // Check evaluation triggers
    const evaluationCycles = config.tpEvaluationCycles || 5;
    const evaluationMaxHours = config.tpEvaluationMaxHours || 24;

    const shouldEvaluate = cyclesSinceEval >= evaluationCycles || hoursSinceEval >= evaluationMaxHours;

    if (!shouldEvaluate) {
      return null;
    }

    // Check minimum sample size
    const minSampleSize = config.tpMinSampleSize || 10;
    if (totalSampleCount < minSampleSize) {
      return null;
    }

    // Calculate new values
    const adjustment = calculateAdjustment();

    if (adjustment) {
      lastEvaluationTime = now;
      lastEvaluationCycle = totalSampleCount;

      // Apply time decay to histogram after evaluation
      applyTimeDecay();

      // Record adjustment
      adjustmentHistory.push({
        timestamp: now,
        tpMin: adjustment.tpMinPercent,
        tpMax: adjustment.tpMaxPercent,
        holdbackRatio: adjustment.holdbackRatio,
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
   * Calculate new TP values
   * @returns {TpAdjustment|null}
   */
  const calculateAdjustment = () => {
    const percentiles = calculatePercentiles();

    if (percentiles.p50 === 0) {
      return null;
    }

    // Current values
    const currentTpMin = config.tpMinPercent;
    const currentTpMax = config.tpMaxPercent;

    // Safety bounds from config
    const absoluteMin = config.tpAbsoluteMin || 0.05;
    const absoluteMax = config.tpAbsoluteMax || 5.0;
    const maxChangePercent = config.tpMaxChangePercent || 25;

    // Volatility adjustment factor
    // Higher vol = wider TP, lower vol = tighter TP
    const currentVol = avgVolBaseline || 1;
    const historicalVol = historicalVolBaseline || avgVolBaseline || 1;
    const volFactor = historicalVol > 0 ? Math.sqrt(currentVol / historicalVol) : 1;

    // Calculate proposed values
    // Min TP at p25, Max TP at p75, with vol adjustment and safety margins
    let proposedTpMin = percentiles.p25 * volFactor * 0.8;
    let proposedTpMax = percentiles.p75 * volFactor * 1.2;

    // Apply absolute bounds
    proposedTpMin = Math.max(absoluteMin, Math.min(proposedTpMin, absoluteMax * 0.5));
    proposedTpMax = Math.max(proposedTpMin * 1.5, Math.min(proposedTpMax, absoluteMax));

    // Ensure minimum spread
    if (proposedTpMax < proposedTpMin * 1.5) {
      proposedTpMax = proposedTpMin * 1.5;
    }

    // Rate limiting - max change per adjustment
    const maxMinChange = currentTpMin * (maxChangePercent / 100);
    const maxMaxChange = currentTpMax * (maxChangePercent / 100);

    let newTpMin = proposedTpMin;
    let newTpMax = proposedTpMax;
    let reason = 'percentile_based';

    // Apply rate limiting to min
    if (Math.abs(newTpMin - currentTpMin) > maxMinChange) {
      newTpMin = newTpMin > currentTpMin
        ? currentTpMin + maxMinChange
        : currentTpMin - maxMinChange;
      reason = 'rate_limited';
    }

    // Apply rate limiting to max
    if (Math.abs(newTpMax - currentTpMax) > maxMaxChange) {
      newTpMax = newTpMax > currentTpMax
        ? currentTpMax + maxMaxChange
        : currentTpMax - maxMaxChange;
      reason = 'rate_limited';
    }

    // Round to 2 decimal places
    newTpMin = roundUSDC(newTpMin * 100) / 100;
    newTpMax = roundUSDC(newTpMax * 100) / 100;

    // Check if values actually changed (beyond 0.01% threshold)
    const minChanged = Math.abs(newTpMin - currentTpMin) > 0.01;
    const maxChanged = Math.abs(newTpMax - currentTpMax) > 0.01;

    if (!minChanged && !maxChanged) {
      return null;
    }

    // HoldbackRatio stays at 0.5 when auto-managed (50% sell, 50% hold)
    // This provides balanced profit-taking between USDC and BTC appreciation
    const currentHoldbackRatio = config.holdbackRatio ?? 0.5;

    return {
      tpMinPercent: newTpMin,
      tpMaxPercent: newTpMax,
      holdbackRatio: currentHoldbackRatio,
      reason: `${reason}: p25=${percentiles.p25.toFixed(2)}% p50=${percentiles.p50.toFixed(2)}% p75=${percentiles.p75.toFixed(2)}%`,
    };
  };

  /**
   * Export state for persistence
   * @returns {OptimizerState}
   */
  const exportState = () => ({
    histogram: histogram.map(b => ({ ...b })),
    recentCycles: [...recentCycles],
    stats: {
      totalSampleCount,
      avgVolBaseline,
      historicalVolBaseline,
      cachedPercentiles: { ...cachedPercentiles },
    },
    lastEvaluationTime,
    lastEvaluationCycle,
    adjustmentHistory: [...adjustmentHistory],
  });

  /**
   * Import state from persistence
   * @param {OptimizerState} state - State to restore
   */
  const importState = (state) => {
    if (!state) return;

    if (state.histogram && state.histogram.length === BUCKET_COUNT) {
      histogram = state.histogram.map(b => ({ ...b }));
    }

    if (state.recentCycles) {
      recentCycles = state.recentCycles.map(c => ({ ...c }));
    }

    if (state.stats) {
      totalSampleCount = state.stats.totalSampleCount || 0;
      avgVolBaseline = state.stats.avgVolBaseline || 0;
      historicalVolBaseline = state.stats.historicalVolBaseline || 0;
      if (state.stats.cachedPercentiles) {
        cachedPercentiles = { ...state.stats.cachedPercentiles };
      }
    }

    lastEvaluationTime = state.lastEvaluationTime || Date.now();
    lastEvaluationCycle = state.lastEvaluationCycle || 0;

    if (state.adjustmentHistory) {
      adjustmentHistory = state.adjustmentHistory.map(a => ({ ...a }));
    }

    percentileCacheValid = false;

    console.log(`📊 [${exchange}] TP optimizer restored: ${totalSampleCount} samples, ${recentCycles.length} recent cycles`);
  };

  /**
   * Get current status for dashboard
   * @returns {Object}
   */
  const getStatus = () => {
    const percentiles = calculatePercentiles();

    return {
      enabled: config.tpAutoManaged === true,
      sampleCount: totalSampleCount,
      recentCycleCount: recentCycles.length,
      percentiles,
      avgVolBaseline,
      lastEvaluationTime,
      lastEvaluationCycle,
      cyclesSinceEval: totalSampleCount - lastEvaluationCycle,
      adjustmentHistory: adjustmentHistory.slice(-10),
      currentConfig: {
        tpMinPercent: config.tpMinPercent,
        tpMaxPercent: config.tpMaxPercent,
        holdbackRatio: config.holdbackRatio,
      },
    };
  };

  /**
   * Reset optimizer state
   */
  const reset = () => {
    histogram = createEmptyHistogram();
    recentCycles = [];
    adjustmentHistory = [];
    lastEvaluationTime = Date.now();
    lastEvaluationCycle = 0;
    totalSampleCount = 0;
    avgVolBaseline = 0;
    historicalVolBaseline = 0;
    cachedPercentiles = { p25: 0, p50: 0, p75: 0 };
    percentileCacheValid = false;
    console.log(`📊 [${exchange}] TP optimizer reset`);
  };

  return {
    recordCycle,
    evaluate,
    getStatus,
    exportState,
    importState,
    reset,
    // For testing
    _getHistogram: () => histogram,
    _getRecentCycles: () => recentCycles,
    _calculatePercentiles: calculatePercentiles,
  };
};

module.exports = {
  createTpOptimizer,
};
