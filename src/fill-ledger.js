// @ts-check
/**
 * Fill Ledger
 *
 * Idempotent fill tracking with proper cost basis calculation.
 * Uses trade_id as primary key to prevent duplicate processing.
 * Maintains fill history and rebuilds position state from fills.
 */

const fs = require('fs');
const path = require('path');
const { getExchangeDataDir } = require('./migration');
const { roundBTC, roundUSDC } = require('./volatility-utils');

/**
 * @typedef {import('./types').Fill} Fill
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * Get fill ledger file path for an exchange
 * @param {string} exchange - Exchange name
 * @returns {string} Path to fill ledger file
 */
const getFillLedgerPath = (exchange) => {
  const dir = getExchangeDataDir(exchange);
  return path.join(dir, 'fill-ledger.json');
};

/**
 * Create fill ledger instance
 * @param {string} exchange - Exchange name
 * @returns {Object} Fill ledger instance
 */
const createFillLedger = (exchange) => {
  /** @type {Map<string, Fill>} */
  const fills = new Map();
  let currentCycleId = null;

  /**
   * Load fill ledger from disk
   */
  const load = () => {
    const filePath = getFillLedgerPath(exchange);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const fill of data) {
      fills.set(fill.tradeId, fill);
    }

    // Restore currentCycleId from loaded fills
    // Find the most recent cycle that's still active (has buys but no sell)
    const cycleStats = new Map(); // cycleId -> { buys: number, sells: number }
    for (const fill of fills.values()) {
      if (!fill.cycleId) continue;
      if (!cycleStats.has(fill.cycleId)) {
        cycleStats.set(fill.cycleId, { buys: 0, sells: 0 });
      }
      const stats = cycleStats.get(fill.cycleId);
      if (fill.side === 'buy') stats.buys++;
      else if (fill.side === 'sell') stats.sells++;
    }

    // Find an active cycle (has buys, no sells) - prefer most recent
    const allFills = Array.from(fills.values()).sort((a, b) => b.timestamp - a.timestamp);
    for (const fill of allFills) {
      if (!fill.cycleId) continue;
      const stats = cycleStats.get(fill.cycleId);
      if (stats && stats.buys > 0 && stats.sells === 0) {
        currentCycleId = fill.cycleId;
        console.log(`📖 [${exchange}] Restored active cycle: ${currentCycleId}`);
        break;
      }
    }

    console.log(`📖 [${exchange}] Loaded ${fills.size} fills from ledger`);
  };

  /**
   * Persist fill ledger to disk
   */
  const persist = () => {
    const filePath = getFillLedgerPath(exchange);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fillsArray = Array.from(fills.values())
      .sort((a, b) => a.timestamp - b.timestamp);

    fs.writeFileSync(filePath, JSON.stringify(fillsArray, null, 2));
  };

  /**
   * Ingest a fill (idempotent)
   * @param {Object} fillData - Raw fill data from exchange
   * @returns {{ingested: boolean, fill: Fill|null}} Result
   */
  const ingestFill = (fillData) => {
    const tradeId = fillData.tradeId || fillData.trade_id;

    // Idempotency check
    if (fills.has(tradeId)) {
      return { ingested: false, fill: null };
    }

    const fill = {
      tradeId,
      orderId: fillData.orderId || fillData.order_id,
      side: (fillData.side || '').toLowerCase(),
      price: parseFloat(fillData.price),
      size: parseFloat(fillData.size),
      quoteAmount: parseFloat(fillData.price) * parseFloat(fillData.size),
      fee: parseFloat(fillData.totalCommission || fillData.commission || 0),
      feeAsset: fillData.commissionAsset || fillData.fee_asset || 'USDC',
      rebate: parseFloat(fillData.rebate || 0),
      netFee: parseFloat(fillData.totalCommission || fillData.commission || 0) - parseFloat(fillData.rebate || 0),
      liquidityIndicator: fillData.liquidityIndicator || fillData.liquidity_indicator || 'TAKER',
      timestamp: fillData.tradeTime ? new Date(fillData.tradeTime).getTime() : Date.now(),
      ingestedAt: Date.now(),
      cycleId: currentCycleId,
    };

    fills.set(tradeId, fill);
    persist();

    console.log(`📝 [${exchange}] Fill ingested: ${fill.side} ${fill.size} BTC @ $${fill.price} (fee: $${fill.netFee.toFixed(4)})`);

    return { ingested: true, fill };
  };

  /**
   * Get all fills for an order
   * @param {string} orderId - Order ID
   * @returns {Fill[]} Fills for the order
   */
  const getFillsForOrder = (orderId) => {
    return Array.from(fills.values())
      .filter(f => f.orderId === orderId)
      .sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Get fills for current cycle
   * @returns {Fill[]} Fills in current cycle
   */
  const getCurrentCycleFills = () => {
    if (!currentCycleId) return [];
    return Array.from(fills.values())
      .filter(f => f.cycleId === currentCycleId)
      .sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Rebuild position state from fills
   * @param {Fill[]} [fillsToProcess] - Specific fills to process (defaults to current cycle)
   * @returns {RegimePositionState} Rebuilt position state
   */
  const rebuildPositionFromFills = (fillsToProcess) => {
    const targetFills = fillsToProcess || getCurrentCycleFills();

    let totalBTC = 0;
    let totalCostBasis = 0;
    let realizedPnL = 0;
    let ladderStep = 0;
    let lastEntryPrice = 0;
    let lastEntryTime = 0;

    for (const fill of targetFills) {
      if (fill.side === 'buy') {
        const costBasis = fill.quoteAmount + fill.netFee;
        totalBTC = roundBTC(totalBTC + fill.size);
        totalCostBasis = roundUSDC(totalCostBasis + costBasis);
        ladderStep += 1;
        lastEntryPrice = fill.price;
        lastEntryTime = fill.timestamp;
      } else if (fill.side === 'sell') {
        const proceeds = fill.quoteAmount - fill.netFee;
        const avgCost = totalBTC > 0 ? totalCostBasis / totalBTC : 0;
        const soldCostBasis = fill.size * avgCost;
        realizedPnL = roundUSDC(realizedPnL + (proceeds - soldCostBasis));

        totalBTC = roundBTC(totalBTC - fill.size);
        totalCostBasis = roundUSDC(totalCostBasis - soldCostBasis);
      }
    }

    const avgCostBasis = totalBTC > 0 ? totalCostBasis / totalBTC : 0;

    return {
      totalBTC,
      totalCostBasis,
      avgCostBasis,
      ladderStep,
      lastEntryPrice,
      lastEntryTime,
      anchorPrice: lastEntryPrice,
      activeTpOrderId: null,
      lastTpPrice: 0,
      cyclesCompleted: 0,
      unrealizedPnL: 0,
      realizedPnL,
      maxDrawdownSeen: 0,
      scalingDisabled: false,
      scalingDisabledReason: null,
    };
  };

  /**
   * Start a new trading cycle
   * @returns {string} New cycle ID
   */
  const startNewCycle = () => {
    currentCycleId = `cycle-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log(`🔄 [${exchange}] Started new cycle: ${currentCycleId}`);
    return currentCycleId;
  };

  /**
   * Get current cycle ID
   * @returns {string|null}
   */
  const getCurrentCycleId = () => currentCycleId;

  /**
   * Set current cycle ID (for recovery)
   * @param {string|null} cycleId
   */
  const setCurrentCycleId = (cycleId) => {
    currentCycleId = cycleId;
  };

  /**
   * Check if a trade has been processed
   * @param {string} tradeId - Trade ID to check
   * @returns {boolean}
   */
  const hasProcessedTrade = (tradeId) => fills.has(tradeId);

  /**
   * Get fill count
   * @returns {number}
   */
  const getFillCount = () => fills.size;

  /**
   * Get all fills
   * @returns {Fill[]}
   */
  const getAllFills = () => Array.from(fills.values());

  /**
   * Get fill statistics
   * @returns {Object} Stats summary
   */
  const getStats = () => {
    const allFills = Array.from(fills.values());
    const buyFills = allFills.filter(f => f.side === 'buy');
    const sellFills = allFills.filter(f => f.side === 'sell');

    const totalBuyValue = buyFills.reduce((sum, f) => sum + f.quoteAmount, 0);
    const totalSellValue = sellFills.reduce((sum, f) => sum + f.quoteAmount, 0);
    const totalBuyBTC = buyFills.reduce((sum, f) => sum + f.size, 0);
    const totalSellBTC = sellFills.reduce((sum, f) => sum + f.size, 0);
    const totalFees = allFills.reduce((sum, f) => sum + f.netFee, 0);

    return {
      totalFills: allFills.length,
      buyFills: buyFills.length,
      sellFills: sellFills.length,
      totalBuyValue: roundUSDC(totalBuyValue),
      totalSellValue: roundUSDC(totalSellValue),
      totalBuyBTC: roundBTC(totalBuyBTC),
      totalSellBTC: roundBTC(totalSellBTC),
      netBTC: roundBTC(totalBuyBTC - totalSellBTC),
      totalFees: roundUSDC(totalFees),
      currentCycleId,
    };
  };

  /**
   * Get fills since a timestamp
   * @param {number} since - Timestamp
   * @returns {Fill[]}
   */
  const getFillsSince = (since) => {
    return Array.from(fills.values())
      .filter(f => f.timestamp >= since)
      .sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Calculate aggregate stats for fills
   * @param {Fill[]} fillsToAggregate - Fills to aggregate
   * @returns {{totalSize: number, totalValue: number, totalFees: number, avgPrice: number}}
   */
  const aggregateFills = (fillsToAggregate) => {
    let totalSize = 0;
    let totalValue = 0;
    let totalFees = 0;

    for (const fill of fillsToAggregate) {
      totalSize += fill.size;
      totalValue += fill.quoteAmount;
      totalFees += fill.netFee;
    }

    return {
      totalSize: roundBTC(totalSize),
      totalValue: roundUSDC(totalValue),
      totalFees: roundUSDC(totalFees),
      avgPrice: totalSize > 0 ? roundUSDC(totalValue / totalSize) : 0,
    };
  };

  // Initialize by loading from disk
  load();

  return {
    ingestFill,
    getFillsForOrder,
    getCurrentCycleFills,
    rebuildPositionFromFills,
    startNewCycle,
    getCurrentCycleId,
    setCurrentCycleId,
    hasProcessedTrade,
    getFillCount,
    getAllFills,
    getStats,
    getFillsSince,
    aggregateFills,
    persist,
    load,
  };
};

module.exports = {
  createFillLedger,
  getFillLedgerPath,
};
