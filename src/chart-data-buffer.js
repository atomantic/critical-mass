// @ts-check
/**
 * Chart Data Buffer
 *
 * Server-side buffer for chart data that persists across page reloads
 * and server restarts. Saves to disk periodically and loads on startup.
 */
const fs = require('fs');
const path = require('path');
const { getFundDataDir } = require('./migration');

// Maximum data retention (1 hour in milliseconds)
const MAX_RETENTION_MS = 60 * 60 * 1000;

// Minimum interval between data points (to prevent over-sampling)
const MIN_SAMPLE_INTERVAL_MS = 1000;

// Hard cap on array length as safety net (1 hour at 1 sample/sec = 3600, add buffer)
const MAX_POINTS = 4000;

// Save to disk every 30 seconds
const SAVE_INTERVAL_MS = 30 * 1000;

/**
 * Get the file path for persisted chart data
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {string}
 */
const getFilePath = (exchange, pair) => path.join(getFundDataDir(exchange, pair), 'chart-data-buffer.json');

/**
 * Create a chart data buffer for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {Object} Chart data buffer instance
 */
const createChartDataBuffer = (exchange, pair) => {
  let priceHistory = [];
  let atrHistory = [];
  let regimeHistory = [];
  let lastSampleTime = 0;
  let dirty = false;
  let saveTimer = null;

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
   * Save buffer to disk
   */
  const saveToDisk = () => {
    if (!dirty) return;
    const filePath = getFilePath(exchange, pair);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      priceHistory: trimOldData(priceHistory),
      atrHistory: trimOldData(atrHistory),
      regimeHistory: trimOldData(regimeHistory),
      savedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
    dirty = false;
  };

  /**
   * Load buffer from disk
   */
  const loadFromDisk = () => {
    const filePath = getFilePath(exchange, pair);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.priceHistory) priceHistory = trimOldData(data.priceHistory);
    if (data.atrHistory) atrHistory = trimOldData(data.atrHistory);
    if (data.regimeHistory) regimeHistory = trimOldData(data.regimeHistory);
    const loaded = priceHistory.length + atrHistory.length + regimeHistory.length;
    if (loaded > 0) {
      const age = data.savedAt ? Math.round((Date.now() - data.savedAt) / 1000) : '?';
      console.log(`📊 chart buffer loaded for ${exchange}: ${priceHistory.length} price, ${atrHistory.length} atr, ${regimeHistory.length} regime points (saved ${age}s ago)`);
    }
  };

  // Load persisted data on creation
  loadFromDisk();

  // Periodic save to disk
  saveTimer = setInterval(saveToDisk, SAVE_INTERVAL_MS);

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
      dirty = true;
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
      dirty = true;
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
        dirty = true;
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
    dirty = true;
    saveToDisk();
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

  /**
   * Flush to disk and stop the save timer
   */
  const shutdown = () => {
    saveToDisk();
    if (saveTimer) clearInterval(saveTimer);
  };

  return {
    processStatus,
    getData,
    clear,
    getStats,
    shutdown,
  };
};

// Store buffers per fund (key: `${exchange}::${pair}`)
const chartBuffers = new Map();

const bufferKey = (exchange, pair) => {
  if (!pair) {
    // Resolve default pair from config (lazy require to avoid circular deps)
    const configUtils = require('./config-utils');
    const resolved = configUtils.getDefaultPair(exchange);
    return `${exchange}::${resolved || 'default'}`;
  }
  return `${exchange}::${pair}`;
};

/**
 * Get or create chart data buffer for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {Object} Chart data buffer
 */
const getChartDataBuffer = (exchange, pair) => {
  const key = bufferKey(exchange, pair);
  if (!chartBuffers.has(key)) {
    chartBuffers.set(key, createChartDataBuffer(exchange, pair));
  }
  return chartBuffers.get(key);
};

/**
 * Clear chart data buffer for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 */
const clearChartDataBuffer = (exchange, pair) => {
  const buffer = chartBuffers.get(bufferKey(exchange, pair));
  if (buffer) {
    buffer.clear();
  }
};

/**
 * Get chart data for a fund (exchange + pair).
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {Object|null} Chart data or null if no buffer exists
 */
const getChartData = (exchange, pair) => {
  const buffer = chartBuffers.get(bufferKey(exchange, pair));
  if (!buffer) return null;
  return buffer.getData();
};

/**
 * Flush all buffers to disk (call on graceful shutdown)
 */
const shutdownAllBuffers = () => {
  for (const [key, buffer] of chartBuffers) {
    buffer.shutdown();
    console.log(`📊 chart buffer flushed for ${key}`);
  }
};

module.exports = {
  createChartDataBuffer,
  getChartDataBuffer,
  clearChartDataBuffer,
  getChartData,
  shutdownAllBuffers,
};
