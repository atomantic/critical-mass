// @ts-check
/**
 * Chart Data Buffer
 *
 * Server-side buffer for chart data that persists across page reloads.
 * Mirrors the client-side useChartDataBuffer logic to maintain consistency.
 */

// Maximum data retention (15 minutes in milliseconds)
const MAX_RETENTION_MS = 15 * 60 * 1000;

// Minimum interval between data points (to prevent over-sampling)
const MIN_SAMPLE_INTERVAL_MS = 1000;

// Hard cap on array length as safety net (15 min at 1 sample/sec = 900, add buffer)
const MAX_POINTS = 1000;

/**
 * Create a chart data buffer for an exchange
 * @param {string} exchange - Exchange name
 * @returns {Object} Chart data buffer instance
 */
const createChartDataBuffer = (exchange) => {
  let priceHistory = [];
  let atrHistory = [];
  let regimeHistory = [];
  let lastSampleTime = 0;

  /**
   * Trim old data from an array (time-based + hard cap)
   * @param {Array} data - Data array
   * @returns {Array} Trimmed array
   */
  const trimOldData = (data) => {
    const cutoff = Date.now() - MAX_RETENTION_MS;
    const filtered = data.filter(d => d.timestamp > cutoff);
    if (filtered.length > MAX_POINTS) {
      return filtered.slice(-MAX_POINTS);
    }
    return filtered;
  };

  /**
   * Process incoming status update and buffer chart data
   * @param {Object} status - Regime engine status
   */
  const processStatus = (status) => {
    if (!status?.market) return;

    const now = Date.now();

    // Rate limit sampling to prevent over-accumulation
    if (now - lastSampleTime < MIN_SAMPLE_INTERVAL_MS) return;
    lastSampleTime = now;

    const { market, regime } = status;

    // Add price data point
    if (market.lastPrice) {
      const pricePoint = {
        timestamp: now,
        price: market.lastPrice,
        atr1m: market.atr1m || 0,
        atr5m: market.atr5m || 0,
      };

      priceHistory = [...trimOldData(priceHistory), pricePoint];
    }

    // Add ATR/volatility data point
    if (market.atr1m !== undefined || market.realizedVol !== undefined) {
      const atrPoint = {
        timestamp: now,
        atr1m: market.atr1m || 0,
        atr5m: market.atr5m || 0,
        realizedVol: market.realizedVol || 0,
        volBaseline: market.volBaseline || 0,
      };

      atrHistory = [...trimOldData(atrHistory), atrPoint];
    }

    // Track regime changes (only add when regime mode changes)
    if (regime?.mode) {
      const trimmed = trimOldData(regimeHistory);
      const lastRegime = trimmed[trimmed.length - 1];

      // Only add if regime mode changed or this is the first entry
      if (!lastRegime || lastRegime.mode !== regime.mode) {
        regimeHistory = [...trimmed, {
          timestamp: now,
          mode: regime.mode,
          since: regime.since,
        }];
      } else {
        regimeHistory = trimmed;
      }
    }
  };

  /**
   * Get current buffered chart data
   * @returns {Object} Chart data
   */
  const getData = () => ({
    priceHistory: trimOldData(priceHistory),
    atrHistory: trimOldData(atrHistory),
    regimeHistory: trimOldData(regimeHistory),
    exchange,
    timestamp: Date.now(),
  });

  /**
   * Clear all buffered data
   */
  const clear = () => {
    priceHistory = [];
    atrHistory = [];
    regimeHistory = [];
    lastSampleTime = 0;
  };

  /**
   * Get stats about the buffer
   * @returns {Object} Buffer stats
   */
  const getStats = () => ({
    pricePoints: priceHistory.length,
    atrPoints: atrHistory.length,
    regimePoints: regimeHistory.length,
    oldestTimestamp: priceHistory[0]?.timestamp || null,
    newestTimestamp: priceHistory[priceHistory.length - 1]?.timestamp || null,
  });

  return {
    processStatus,
    getData,
    clear,
    getStats,
  };
};

// Store buffers per exchange
const chartBuffers = new Map();

/**
 * Get or create chart data buffer for an exchange
 * @param {string} exchange - Exchange name
 * @returns {Object} Chart data buffer
 */
const getChartDataBuffer = (exchange) => {
  if (!chartBuffers.has(exchange)) {
    chartBuffers.set(exchange, createChartDataBuffer(exchange));
  }
  return chartBuffers.get(exchange);
};

/**
 * Clear chart data buffer for an exchange
 * @param {string} exchange - Exchange name
 */
const clearChartDataBuffer = (exchange) => {
  const buffer = chartBuffers.get(exchange);
  if (buffer) {
    buffer.clear();
  }
};

/**
 * Get chart data for an exchange
 * @param {string} exchange - Exchange name
 * @returns {Object|null} Chart data or null if no buffer exists
 */
const getChartData = (exchange) => {
  const buffer = chartBuffers.get(exchange);
  if (!buffer) return null;
  return buffer.getData();
};

module.exports = {
  createChartDataBuffer,
  getChartDataBuffer,
  clearChartDataBuffer,
  getChartData,
};
