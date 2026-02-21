/**
 * DCA Parameter Optimizer
 * Finds the best combination of trading settings by running backtests
 * across multiple parameter combinations and time periods.
 */

const { runBacktest, getPriceData } = require('./backtest-engine');
const { getIntervalConfig } = require('./interval-utils');

// Default interval types to test
const DEFAULT_INTERVALS = ['5min', '10min', '30min', '1hour', '4hour', 'daily'];

// Default scaled buy amounts per interval
const DEFAULT_BUY_AMOUNTS = {
  '5min': 1,
  '10min': 2,
  '30min': 10,
  '1hour': 50,
  '4hour': 100,
  'daily': 500
};

// Default markup percentages to test (1-10%)
const DEFAULT_MARKUPS = [1, 2, 3, 4, 5, 6, 7, 8, 10];

// Default periods to test
const DEFAULT_PERIODS = ['30D', '60D', '90D', '1Y'];

// Time periods to test with interval counts
const PERIOD_INTERVALS = {
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
 * Pre-fetch and cache price data for selected interval types
 * This improves performance by avoiding redundant API calls
 * @param {string[]} intervals - Interval types to fetch
 * @param {string[]} periods - Periods to fetch (determines max intervals needed)
 * @param {function} onProgress - Progress callback
 * @param {string} exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {boolean} forceRefresh - If true, fetch fresh data; otherwise prefer cached data
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 */
const prefetchPriceData = async (intervals, periods, onProgress, exchange = 'coinbase', forceRefresh = false, productId = null) => {
  const cache = {};
  let fetched = 0;
  const total = intervals.length;

  // Find the longest period we need data for
  const periodOrder = ['30D', '60D', '90D', '1Y'];
  const maxPeriodIndex = Math.max(...periods.map(p => periodOrder.indexOf(p)));
  const maxPeriod = periodOrder[maxPeriodIndex] || '1Y';

  for (const intervalType of intervals) {
    // Get the maximum intervals needed for this type based on selected periods
    const maxIntervals = PERIOD_INTERVALS[intervalType]?.[maxPeriod] || PERIOD_INTERVALS[intervalType]?.['1Y'];

    onProgress?.({
      phase: 'prefetch',
      message: forceRefresh
        ? `Fetching fresh ${intervalType} price data for ${productId || 'default'} from ${exchange}...`
        : `Loading ${intervalType} price data for ${productId || 'default'}...`,
      current: fetched,
      total
    });

    // Use preferCache option to avoid fetching new data if we have enough cached
    // Wrap in error handling to prevent crashes from API failures
    const priceData = await getPriceData(maxIntervals, intervalType, exchange, {
      preferCache: !forceRefresh,
      productId
    }).catch(err => {
      console.error(`Error fetching ${intervalType} price data: ${err.message}`);
      return []; // Return empty array on error, backtest will fail gracefully
    });

    if (priceData.length === 0) {
      console.warn(`Warning: No ${intervalType} price data available for ${productId || 'default'} from ${exchange}`);
    }

    cache[intervalType] = priceData;
    fetched++;
  }

  return cache;
};

/**
 * Run a single backtest with given parameters
 * @param {Object} params - Backtest parameters
 * @param {Object} priceCache - Cached price data by interval type
 * @param {string} exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 */
const runSingleBacktest = async (params, priceCache, exchange, productId = null) => {
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

  // Run backtest with exchange and productId, passing pre-fetched prices
  const result = await runBacktest({
    intervalBuyAmount,
    sellMarkupPercent,
    holdbackPercent,
    feePercent: FEE_PERCENT,
    rebatePercent: REBATE_PERCENT,
    intervals,
    intervalType,
    fundSize,
    exchange,
    productId
  }, prices);  // Pass pre-fetched prices to avoid redundant API calls

  return result;
};

/**
 * Run the full optimizer across all parameter combinations
 * @param {Object} options - Optimizer options
 * @param {number} options.fundSize - Fund size to test with
 * @param {string} options.exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {boolean} options.forceRefresh - If true, fetch fresh price data
 * @param {function} options.onProgress - Progress callback
 * @param {string} [options.productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 * @param {string[]} [options.intervals] - Intervals to test (default: all)
 * @param {number[]} [options.markups] - Markup percentages to test (default: 1-8)
 * @param {string[]} [options.periods] - Periods to test (default: 30D, 60D, 90D, 1Y)
 * @param {Object} [options.buyAmounts] - Buy amounts per interval (default: scaled)
 * @returns {Object} Optimization results
 */
const runOptimizer = async ({
  fundSize = 10000,
  exchange = 'coinbase',
  forceRefresh = false,
  onProgress,
  productId = null,
  intervals = null,
  markups = null,
  periods = null,
  buyAmounts = null
}) => {
  const startTime = Date.now();
  const results = [];

  // Use provided options or defaults
  const selectedIntervals = intervals || DEFAULT_INTERVALS;
  const selectedMarkups = markups || DEFAULT_MARKUPS;
  const selectedPeriods = periods || DEFAULT_PERIODS;
  const selectedBuyAmounts = { ...DEFAULT_BUY_AMOUNTS, ...buyAmounts };

  // Calculate total combinations
  const totalCombinations = selectedIntervals.length * selectedMarkups.length * selectedPeriods.length;
  let completed = 0;

  // Phase 1: Pre-fetch price data for selected intervals only
  onProgress?.({
    phase: 'prefetch',
    message: `Pre-fetching price data for ${productId || 'default pair'}...`,
    current: 0,
    total: selectedIntervals.length,
    percentComplete: 0
  });

  const priceCache = await prefetchPriceData(selectedIntervals, selectedPeriods, (progress) => {
    onProgress?.({
      ...progress,
      percentComplete: Math.round((progress.current / progress.total) * 10) // 0-10%
    });
  }, exchange, forceRefresh, productId);

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

  for (const intervalType of selectedIntervals) {
    const intervalBuyAmount = selectedBuyAmounts[intervalType] || DEFAULT_BUY_AMOUNTS[intervalType];
    const intervalPeriods = PERIOD_INTERVALS[intervalType];

    for (const markup of selectedMarkups) {
      const holdback = markup / 2; // Holdback is always 50% of markup

      for (const periodLabel of selectedPeriods) {
        const intervals = intervalPeriods[periodLabel];
        if (!intervals) continue; // Skip if period not valid for this interval type

        const currentParams = {
          intervalType,
          intervalBuyAmount,
          sellMarkupPercent: markup,
          holdbackPercent: holdback,
          period: periodLabel,
          intervals,
          fundSize
        };

        const result = await runSingleBacktest(currentParams, priceCache, exchange, productId);

        const fullResult = {
          params: currentParams,
          metrics: {
            totalValue: result.metrics.totalValue,
            roi: result.metrics.roi,
            fillRate: result.metrics.fillRate,
            sellsFilled: result.metrics.sellsFilled,
            totalSells: result.metrics.totalSells,
            avgIntervalsToFill: result.metrics.avgIntervalsToFill,
            assetReserves: result.metrics.assetReserves,
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
    productId,
    config: {
      intervals: selectedIntervals,
      buyAmounts: selectedBuyAmounts,
      markups: selectedMarkups,
      periods: selectedPeriods,
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
  DEFAULT_INTERVALS,
  DEFAULT_BUY_AMOUNTS,
  DEFAULT_MARKUPS,
  DEFAULT_PERIODS,
  PERIOD_INTERVALS
};
