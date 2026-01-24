/**
 * DCA Parameter Optimizer
 * Finds the best combination of trading settings by running backtests
 * across multiple parameter combinations and time periods.
 */

const { runBacktest, getPriceData } = require('./backtest-engine');
const { getIntervalConfig } = require('./interval-utils');

// Interval types to test
const INTERVALS = ['5min', '10min', '30min', '1hour', '4hour', 'daily'];

// Scaled buy amounts per interval
const BUY_AMOUNTS = {
  '5min': 1,
  '10min': 2,
  '30min': 10,
  '1hour': 50,
  '4hour': 100,
  'daily': 500
};

// Markup percentages to test (1-8%)
const MARKUPS = [1, 2, 3, 4, 5, 6, 7, 8];

// Time periods to test with interval counts
const PERIODS = {
  '5min': {
    '30D': 8640,
    '60D': 17280,
    '90D': 25920,
    '1Y': 105120
  },
  '10min': {
    '30D': 4320,
    '60D': 8640,
    '90D': 12960,
    '1Y': 52560
  },
  '30min': {
    '30D': 1440,
    '60D': 2880,
    '90D': 4320,
    '1Y': 17520
  },
  '1hour': {
    '30D': 720,
    '60D': 1440,
    '90D': 2160,
    '1Y': 8760
  },
  '4hour': {
    '30D': 180,
    '60D': 360,
    '90D': 540,
    '1Y': 2190
  },
  'daily': {
    '30D': 30,
    '60D': 60,
    '90D': 90,
    '1Y': 365
  }
};

// Fixed fee parameters
const FEE_PERCENT = 0.125;
const REBATE_PERCENT = 0.031;

/**
 * Pre-fetch and cache price data for all interval types
 * This improves performance by avoiding redundant API calls
 */
const prefetchPriceData = async (onProgress) => {
  const cache = {};
  let fetched = 0;
  const total = INTERVALS.length;

  for (const intervalType of INTERVALS) {
    // Get the maximum intervals needed for this type (1Y)
    const maxIntervals = PERIODS[intervalType]['1Y'];

    onProgress?.({
      phase: 'prefetch',
      message: `Fetching ${intervalType} price data...`,
      current: fetched,
      total
    });

    cache[intervalType] = await getPriceData(maxIntervals, intervalType);
    fetched++;
  }

  return cache;
};

/**
 * Run a single backtest with given parameters
 */
const runSingleBacktest = async (params, priceCache) => {
  const {
    intervalType,
    intervalBuyAmount,
    sellMarkupPercent,
    holdbackPercent,
    intervals,
    fundSize
  } = params;

  // Use cached price data (slice to needed intervals)
  const cachedPrices = priceCache[intervalType];
  const prices = cachedPrices.slice(-intervals);

  // Run backtest
  const result = await runBacktest({
    intervalBuyAmount,
    sellMarkupPercent,
    holdbackPercent,
    feePercent: FEE_PERCENT,
    rebatePercent: REBATE_PERCENT,
    intervals,
    intervalType,
    fundSize
  });

  return result;
};

/**
 * Run the full optimizer across all parameter combinations
 * @param {Object} options - Optimizer options
 * @param {number} options.fundSize - Fund size to test with
 * @param {function} options.onProgress - Progress callback
 * @returns {Object} Optimization results
 */
const runOptimizer = async ({ fundSize = 10000, onProgress }) => {
  const startTime = Date.now();
  const results = [];

  // Calculate total combinations
  const periodCount = Object.keys(PERIODS['daily']).length;
  const totalCombinations = INTERVALS.length * MARKUPS.length * periodCount;
  let completed = 0;

  // Phase 1: Pre-fetch all price data
  onProgress?.({
    phase: 'prefetch',
    message: 'Pre-fetching price data...',
    current: 0,
    total: INTERVALS.length,
    percentComplete: 0
  });

  const priceCache = await prefetchPriceData((progress) => {
    onProgress?.({
      ...progress,
      percentComplete: Math.round((progress.current / progress.total) * 10) // 0-10%
    });
  });

  // Phase 2: Run backtests
  onProgress?.({
    phase: 'backtest',
    message: 'Running backtests...',
    current: 0,
    total: totalCombinations,
    percentComplete: 10,
    currentTest: null,
    latestResult: null
  });

  for (const intervalType of INTERVALS) {
    const intervalBuyAmount = BUY_AMOUNTS[intervalType];
    const intervalPeriods = PERIODS[intervalType];

    for (const markup of MARKUPS) {
      const holdback = markup / 2; // Holdback is always 50% of markup

      for (const [periodLabel, intervals] of Object.entries(intervalPeriods)) {
        const currentParams = {
          intervalType,
          intervalBuyAmount,
          sellMarkupPercent: markup,
          holdbackPercent: holdback,
          period: periodLabel,
          intervals,
          fundSize
        };

        const result = await runSingleBacktest(currentParams, priceCache);

        const fullResult = {
          params: currentParams,
          metrics: {
            totalValue: result.metrics.totalValue,
            roi: result.metrics.roi,
            fillRate: result.metrics.fillRate,
            sellsFilled: result.metrics.sellsFilled,
            totalSells: result.metrics.totalSells,
            avgIntervalsToFill: result.metrics.avgIntervalsToFill,
            btcReserves: result.metrics.btcReserves,
            netFees: result.metrics.netFees,
            intervalsSkipped: result.metrics.intervalsSkipped
          }
        };

        results.push(fullResult);

        completed++;
        onProgress?.({
          phase: 'backtest',
          message: `Testing ${intervalType} ${markup}% markup ${periodLabel}...`,
          current: completed,
          total: totalCombinations,
          percentComplete: 10 + Math.round((completed / totalCombinations) * 90), // 10-100%
          currentTest: currentParams,
          latestResult: fullResult
        });
      }
    }
  }

  // Sort by totalValue descending
  results.sort((a, b) => b.metrics.totalValue - a.metrics.totalValue);

  const duration = Date.now() - startTime;

  return {
    results,
    bestResult: results[0],
    totalCombinations,
    duration,
    fundSize,
    config: {
      intervals: INTERVALS,
      buyAmounts: BUY_AMOUNTS,
      markups: MARKUPS,
      periods: Object.keys(PERIODS['daily']),
      feePercent: FEE_PERCENT,
      rebatePercent: REBATE_PERCENT
    }
  };
};

/**
 * Get a summary of the top N results
 */
const getTopResults = (results, n = 10) => {
  return results.slice(0, n).map((r, i) => ({
    rank: i + 1,
    ...r.params,
    ...r.metrics
  }));
};

module.exports = {
  runOptimizer,
  getTopResults,
  INTERVALS,
  BUY_AMOUNTS,
  MARKUPS,
  PERIODS
};
