// @ts-check
/**
 * Shared Utilities
 *
 * Pure utility functions extracted from server.js so they can be imported
 * by both the gateway and engine processes without duplicating code.
 */

const fs = require('fs');
const path = require('path');
const stateTracker = require('./state-tracker');
const { DATA_DIR } = require('./paths');
const {
  normalizeConfig,
  getNextExecutionTime,
  hasRunThisInterval,
  formatInterval,
  getTimeUntilNext,
} = require('./interval-utils');

// ============ JSON / TSV Helpers ============

/**
 * Read and parse a JSON file, returning a default value on error
 * @param {string} filepath
 * @param {*} [defaultValue]
 * @returns {*}
 */
const readJSON = (filepath, defaultValue = {}) => {
  if (!fs.existsSync(filepath)) return defaultValue;
  const content = fs.readFileSync(filepath, 'utf8');
  if (!content || content.trim() === '') return defaultValue;
  try {
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error parsing JSON from ${filepath}:`, err.message);
    return defaultValue;
  }
};

/**
 * Write JSON atomically (write .tmp then rename)
 * @param {string} filepath
 * @param {*} data
 */
const { atomicWriteSync } = stateTracker;
const writeJSON = (filepath, data) => {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(filepath, JSON.stringify(data, null, 2));
};

/**
 * Parse a TSV file into an array of records
 * @param {string} filepath
 * @returns {Object[]}
 */
const parseTSV = (filepath) => {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.trim().split('\n');
  if (lines.length <= 1) return [];

  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    const record = {};
    headers.forEach((header, i) => {
      const value = values[i] || '';
      if (header === 'Date' || header === 'Timestamp') {
        record[header] = value;
      } else {
        const num = parseFloat(value);
        record[header] = isNaN(num) ? value : num;
      }
    });
    return record;
  });
};

// ============ Cost Basis ============

/**
 * Calculate cost basis from orders and transactions
 * @param {Object} state
 * @param {Object[]} transactions
 * @returns {Object}
 */
const calculateCostBasis = (state, transactions) => {
  const orders = state.orders || [];
  const buys = transactions.filter((t) => t.Type === 'BUY');

  let totalCostBasis = 0;
  let totalAssetFromOrders = 0;
  let reservesCostBasis = 0;
  let pendingCostBasis = 0;
  let pendingAsset = 0;

  orders.forEach((order) => {
    const costBasis =
      order.buyCostBasis || order.buyUSDC || (order.buyQuantity || order.buyQuantityBTC || 0) * order.buyPrice;
    const assetAmount = order.buyQuantity || order.buyQuantityBTC || 0;
    const holdback = order.holdbackAsset || order.holdbackBTC || 0;
    const sellQuantity = order.sellQuantity || order.sellQuantityBTC || 0;
    const costPerAsset = assetAmount > 0 ? costBasis / assetAmount : 0;

    reservesCostBasis += holdback * costPerAsset;

    if (order.status === 'pending') {
      pendingCostBasis += sellQuantity * costPerAsset;
      pendingAsset += sellQuantity;
    }

    totalCostBasis += costBasis;
    totalAssetFromOrders += assetAmount;
  });

  if (orders.length === 0 && buys.length > 0) {
    buys.forEach((buy) => {
      const cost = Math.abs(buy['USDC Amount'] || 0) + (buy['Net Fees'] || 0);
      const asset = buy['BTC Amount'] || 0;
      totalCostBasis += cost;
      totalAssetFromOrders += asset;
    });

    const avgCost = totalAssetFromOrders > 0 ? totalCostBasis / totalAssetFromOrders : 0;
    reservesCostBasis = (state.assetReserves || state.btcReserves || 0) * avgCost;
    pendingCostBasis = (state.outstandingOrdersAsset || state.outstandingOrdersBTC || 0) * avgCost;
    pendingAsset = state.outstandingOrdersAsset || state.outstandingOrdersBTC || 0;
  }

  const avgCostPerAsset = totalAssetFromOrders > 0 ? totalCostBasis / totalAssetFromOrders : 0;
  const assetReserves = state.assetReserves || state.btcReserves || 0;
  const reservesAvgCost =
    assetReserves > 0 ? reservesCostBasis / assetReserves : avgCostPerAsset;

  return {
    totalCostBasis,
    totalAssetBought: totalAssetFromOrders,
    avgCostPerAsset,
    reservesAsset: assetReserves,
    reservesCostBasis,
    reservesAvgCost,
    pendingAsset,
    pendingCostBasis,
    pendingAvgCost: pendingAsset > 0 ? pendingCostBasis / pendingAsset : 0,
    orderBreakdown: orders.map((order) => {
      const costBasis =
        order.buyCostBasis || order.buyUSDC || (order.buyQuantity || order.buyQuantityBTC || 0) * order.buyPrice;
      const assetAmount = order.buyQuantity || order.buyQuantityBTC || 0;
      const costPerAsset = assetAmount > 0 ? costBasis / assetAmount : 0;
      return {
        date: order.createdAt ? order.createdAt.split('T')[0] : 'Unknown',
        buyPrice: order.buyPrice,
        assetBought: assetAmount,
        costBasis,
        costPerAsset,
        fees: order.buyFees || 0,
        rebates: order.buyRebates || 0,
        netFees: order.buyNetFees || 0,
        holdback: order.holdbackAsset || order.holdbackBTC || 0,
        holdbackCost: (order.holdbackAsset || order.holdbackBTC || 0) * costPerAsset,
        sellQuantity: order.sellQuantity || order.sellQuantityBTC || 0,
        sellPrice: order.sellPrice,
        status: order.status,
        realizedPnL:
          order.status === 'filled'
            ? (order.netProceeds || order.actualFillValue || 0) -
              (order.sellQuantity || order.sellQuantityBTC || 0) * costPerAsset
            : null,
      };
    }),
  };
};

// ============ Next Trade Info ============

/**
 * Calculate next trade info for an exchange
 * @param {Object} config
 * @param {Object} state
 * @returns {Object}
 */
const getNextTradeInfo = (config, state) => {
  const normalized = normalizeConfig(config);
  const { intervalType, intervalsToSpread, totalAllocation } = normalized;

  const ranThisInterval = hasRunThisInterval(state.lastRunId, intervalType);
  const nextExecutionTime = getNextExecutionTime(intervalType, state.lastRunTimestamp);
  const timeUntilNext = getTimeUntilNext(intervalType);

  const remaining = (totalAllocation || 0) - (state.totalAllocated || 0);
  const intervalAmount = Math.min(
    (totalAllocation || 0) / (intervalsToSpread || 1),
    remaining
  );

  const fullyAllocated = remaining <= 0;

  return {
    nextTradeTime: new Date(nextExecutionTime).toISOString(),
    nextTradeAmount: fullyAllocated ? 0 : intervalAmount,
    timeUntilNext: timeUntilNext.formatted,
    intervalType,
    intervalLabel: formatInterval(intervalType),
    ranThisInterval,
    fullyAllocated,
    remaining,
    enabled: config.enabled !== false,
    dryRun: config.dryRun === true,
  };
};

// ============ Regime Engine Flag Helpers ============

/**
 * Get the file path for a regime engine running flag
 * @param {string} exchange
 * @returns {string}
 */
const getRegimeRunningFlagPath = (exchange) =>
  path.join(__dirname, '..', 'data', exchange, 'regime-engine-running.json');

/**
 * Save or remove the regime engine running flag
 * @param {string} exchange
 * @param {boolean} isRunning
 */
const saveRegimeRunningFlag = (exchange, isRunning) => {
  const flagPath = getRegimeRunningFlagPath(exchange);
  const dir = path.dirname(flagPath);
  fs.mkdirSync(dir, { recursive: true });
  if (isRunning) {
    fs.writeFileSync(
      flagPath,
      JSON.stringify({ running: true, startedAt: new Date().toISOString() })
    );
  } else if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
};

/**
 * Check if a regime engine should auto-resume on startup
 * @param {string} exchange
 * @returns {boolean}
 */
const shouldAutoResumeRegime = (exchange) => {
  const flagPath = getRegimeRunningFlagPath(exchange);
  return fs.existsSync(flagPath);
};

/**
 * Derive decimal precision from an increment/tick-size value.
 * Handles non-power-of-10 increments (e.g. 0.0025 → 4) by inspecting
 * the string representation rather than using log10.
 */
const incrementToDecimals = (increment) => {
  const s = String(increment);
  // Handle scientific notation (e.g. 1e-8 → 8 decimals)
  const sci = s.match(/^[\d.]+e[+-]?(\d+)$/i);
  if (sci) return parseInt(sci[1], 10);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
};

module.exports = {
  DATA_DIR,
  readJSON,
  writeJSON,
  parseTSV,
  calculateCostBasis,
  getNextTradeInfo,
  getRegimeRunningFlagPath,
  saveRegimeRunningFlag,
  shouldAutoResumeRegime,
  incrementToDecimals,
};
