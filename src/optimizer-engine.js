/**
 * DCA Parameter Optimizer
 * Finds the best combination of trading settings by running backtests
 * across multiple parameter combinations and time periods.
 */

const { runBacktest, getPriceData } = require('./backtest-engine');
const {
  OPTIMIZER_INTERVALS: DEFAULT_INTERVALS,
  DEFAULT_BUY_AMOUNTS,
  OPTIMIZER_MARKUPS: DEFAULT_MARKUPS,
  OPTIMIZER_PERIODS: DEFAULT_PERIODS,
  resolveOptimizerFees,
} = require('./simulation-policy');
const { createContextLogger } = require('./logger');
const { getIntervalConfig } = require('./interval-utils');

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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

const requireSupportedIntervals = (intervals) => {
  for (const interval of intervals) {
    if (!DEFAULT_INTERVALS.includes(interval)) {
      throw new Error(`Unsupported optimizer interval: ${interval}`);
    }
  }
};

/**
 * Pre-fetch and cache price data for selected interval types
 * This improves performance by avoiding redundant API calls
 * @param {readonly string[]} intervals - Interval types to fetch
 * @param {readonly string[]} periods - Periods to fetch (determines max intervals needed)
 * @param {function} onProgress - Progress callback
 * @param {string} exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {boolean} forceRefresh - If true, fetch fresh data; otherwise prefer cached data
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 */
const prefetchPriceData = async (intervals, periods, onProgress, exchange = 'coinbase', forceRefresh = false, productId = null, issues = { skipped: [], stale: [] }) => {
  requireSupportedIntervals(intervals);
  const logger = createContextLogger({ exchange, pair: productId || undefined });
  const cache = {};
  let fetched = 0;
  const total = intervals.length;

  // Find the longest period we need data for
  const periodOrder = ['30D', '60D', '90D', '1Y'];
  const maxPeriodIndex = Math.max(...periods.map(p => periodOrder.indexOf(p)));
  const maxPeriod = periodOrder[maxPeriodIndex] || '1Y';

  for (const intervalType of intervals) {
    // Get the maximum intervals needed for this type based on selected periods
    const maxIntervals = PERIOD_INTERVALS[intervalType][maxPeriod];

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
    const freshness = {};
    /** @type {Error|null} */
    let fetchError = null;
    const priceData = await getPriceData(maxIntervals, intervalType, exchange, {
      preferCache: !forceRefresh,
      productId,
      freshness
    }).catch(err => {
      fetchError = err;
      logger.error(`Error fetching ${intervalType} price data: ${err.message}`);
      return []; // runOptimizer skips this interval and reports why
    });

    if (priceData.length === 0) {
      logger.warn(`Warning: No ${intervalType} price data available for ${productId || 'default'} from ${exchange}`);
      issues.skipped.push({
        intervalType,
        reason: fetchError
          ? `Price fetch failed: ${fetchError.message}`
          : `No ${intervalType} price data available from ${exchange}`
      });
    } else if (freshness.stale) {
      issues.stale.push({ intervalType, reason: freshness.staleReason });
    }

    cache[intervalType] = priceData;
    fetched++;
  }

  return cache;
};

/**
 * Build the optimizer result record for one backtest, annotating it with the
 * ACTUAL candle coverage rather than only the requested period label.
 *
 * `runSingleBacktest` slices `cachedPrices.slice(-intervals)`; when the cache
 * holds fewer candles than the requested period needs (common for Gemini /
 * Crypto.com, whose history is short), the slice silently returns everything
 * available. `runBacktest` reports the real count as `result.params.intervals`,
 * so every period longer than the available history produced byte-identical
 * metrics all labeled with their requested period ("90D"/"1Y") — letting the
 * sort crown a "1Y" best that actually covered weeks (#213B). We surface
 * `actualIntervals`, `requestedIntervals`, `coveragePct`, and an `underCovered`
 * flag so consumers can trust (or discount) the period label.
 *
 * @param {Object} currentParams - Requested params (includes `intervals`, `period`)
 * @param {Object} result - Backtest result from runBacktest
 * @returns {Object} Result record with annotated params + metrics
 */
const buildResultRecord = (currentParams, result) => {
  const requestedIntervals = currentParams.intervals;
  // runBacktest sets result.params.intervals = priceData.length (actual count).
  const actualIntervals = result.params.intervals;
  const underCovered = actualIntervals < requestedIntervals;
  const coveragePct = requestedIntervals > 0
    ? (actualIntervals / requestedIntervals) * 100
    : 100;

  const intervalMs = getIntervalConfig(currentParams.intervalType).ms;
  const { startDate, endDate, roi } = result.metrics;
  const elapsedMs = Date.parse(endDate) - Date.parse(startDate) + intervalMs;
  const observedMs = Math.max(actualIntervals * intervalMs, Number.isFinite(elapsedMs) ? elapsedMs : intervalMs);
  // Simple annualization compares different durations without assuming gains
  // compound or external contributions are reinvested at the same rate.
  const annualizedRoi = roi * YEAR_MS / observedMs;

  return {
    params: {
      ...currentParams,
      requestedIntervals,
      actualIntervals,
      coveragePct,
      underCovered,
    },
    metrics: {
      totalValue: result.metrics.totalValue,
      roi,
      annualizedRoi,
      fillRate: result.metrics.fillRate,
      sellsFilled: result.metrics.sellsFilled,
      totalSells: result.metrics.totalSells,
      avgIntervalsToFill: result.metrics.avgIntervalsToFill,
      assetReserves: result.metrics.assetReserves,
      netFees: result.metrics.netFees,
      intervalsSkipped: result.metrics.intervalsSkipped,
      // Coverage truth alongside the metrics so a mislabeled period is obvious.
      actualIntervals,
      requestedIntervals,
      coveragePct,
      underCovered,
      startDate,
      endDate,
    },
  };
};

/**
 * Rank optimizer results for display/bestResult selection: every fully-covered
 * result ranks ahead of an under-covered one (#213B), then by annualized ROI
 * descending within each group so results from different periods are comparable.
 * @param {Object} a - Result record (shape from buildResultRecord)
 * @param {Object} b - Result record (shape from buildResultRecord)
 * @returns {number} Sort comparator result
 */
const compareOptimizerResults = (a, b) => {
  if (a.params.underCovered !== b.params.underCovered) {
    return a.params.underCovered ? 1 : -1;
  }
  return b.metrics.annualizedRoi - a.metrics.annualizedRoi;
};

/**
 * Run a single backtest with given parameters
 * @param {Object} params - Backtest parameters
 * @param {Object} priceCache - Cached price data by interval type
 * @param {{feePercent: number, rebatePercent: number}} fees - Fund fee assumptions
 * @param {string} exchange - Exchange name (coinbase, gemini, cryptocom)
 * @param {string} [productId] - Product ID (e.g., 'BTC-USDC', 'CRO_USD')
 */
const runSingleBacktest = async (params, priceCache, fees, exchange, productId = null) => {
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
    ...fees,
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
 * @param {{feePercent: number, rebatePercent: number}} [options.fees] - Resolved fund fee assumptions
 * @returns {Promise<Object>} Optimization results
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
  buyAmounts = null,
  fees = resolveOptimizerFees()
}) => {
  const startTime = Date.now();
  const results = [];

  // Use provided options or defaults
  const selectedIntervals = intervals || DEFAULT_INTERVALS;
  requireSupportedIntervals(selectedIntervals);
  const selectedMarkups = markups || DEFAULT_MARKUPS;
  const selectedPeriods = periods || DEFAULT_PERIODS;
  const selectedBuyAmounts = { ...DEFAULT_BUY_AMOUNTS, ...buyAmounts };

  // Calculate total combinations
  let totalCombinations = selectedIntervals.length * selectedMarkups.length * selectedPeriods.length;
  let completed = 0;

  // Phase 1: Pre-fetch price data for selected intervals only
  onProgress?.({
    phase: 'prefetch',
    message: `Pre-fetching price data for ${productId || 'default pair'}...`,
    current: 0,
    total: selectedIntervals.length,
    percentComplete: 0
  });

  const issues = { skipped: [], stale: [] };
  const priceCache = await prefetchPriceData(selectedIntervals, selectedPeriods, (progress) => {
    onProgress?.({
      ...progress,
      percentComplete: Math.round((progress.current / progress.total) * 10) // 0-10%
    });
  }, exchange, forceRefresh, productId, issues);

  const skippedTypes = new Set(issues.skipped.map(s => s.intervalType));
  totalCombinations -= skippedTypes.size * selectedMarkups.length * selectedPeriods.length;
  if (skippedTypes.size === selectedIntervals.length) {
    throw new Error(`No price data available for any selected interval: ${issues.skipped.map(s => `${s.intervalType} (${s.reason})`).join('; ')}`);
  }

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
    if (skippedTypes.has(intervalType)) continue;
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

        // Release the event loop between combinations: with pre-fetched prices
        // each simulation is pure CPU, and the optimizer runs in the gateway.
        await new Promise(resolve => setImmediate(resolve));
        const result = await runSingleBacktest(currentParams, priceCache, fees, exchange, productId);

        const fullResult = buildResultRecord(currentParams, result);

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

  results.sort(compareOptimizerResults);

  const duration = Date.now() - startTime;

  return {
    results,
    bestResult: results[0],
    totalCombinations,
    ...(issues.skipped.length ? { skippedIntervals: issues.skipped } : {}),
    ...(issues.stale.length ? { staleIntervals: issues.stale } : {}),
    duration,
    fundSize,
    productId,
    config: {
      intervals: selectedIntervals,
      // Only selections that actually participated in this run belong in the
      // cache identity. Unused UI fields must not invalidate a cached result.
      buyAmounts: Object.fromEntries(selectedIntervals.map(intervalType => [intervalType, selectedBuyAmounts[intervalType]])),
      markups: selectedMarkups,
      periods: selectedPeriods,
      ...fees
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
  prefetchPriceData,
  getTopResults,
  buildResultRecord,
  compareOptimizerResults,
  DEFAULT_INTERVALS,
  DEFAULT_BUY_AMOUNTS,
  DEFAULT_MARKUPS,
  DEFAULT_PERIODS,
  PERIOD_INTERVALS
};
