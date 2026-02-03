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
   * @param {number} [orderPlacedAt] - Optional timestamp when the order was placed (for fill time tracking)
   * @returns {{ingested: boolean, fill: Fill|null}} Result
   */
  const ingestFill = (fillData, orderPlacedAt = null) => {
    const tradeId = fillData.tradeId || fillData.trade_id;

    // Idempotency check
    if (fills.has(tradeId)) {
      return { ingested: false, fill: null };
    }

    const fillTimestamp = fillData.tradeTime ? new Date(fillData.tradeTime).getTime() : Date.now();

    // Calculate fill time if we have order placement time
    const fillTimeMs = orderPlacedAt && orderPlacedAt > 0 ? fillTimestamp - orderPlacedAt : null;

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
      timestamp: fillTimestamp,
      ingestedAt: Date.now(),
      cycleId: currentCycleId,
      // Fill time tracking
      orderPlacedAt: orderPlacedAt || null,
      fillTimeMs: fillTimeMs,
    };

    fills.set(tradeId, fill);
    persist();

    const fillTimeStr = fillTimeMs !== null ? ` (fill time: ${(fillTimeMs / 1000).toFixed(1)}s)` : '';
    console.log(`📝 [${exchange}] Fill ingested: ${fill.side} ${fill.size} BTC @ $${fill.price} (fee: $${fill.netFee.toFixed(4)})${fillTimeStr}`);

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
   * Get fill time statistics for entry orders
   * @param {number} [sinceDays=7] - Only include fills from the last N days
   * @returns {{count: number, avgMs: number, minMs: number, maxMs: number, p50Ms: number, p90Ms: number, staleCount: number, staleRate: number}}
   */
  const getFillTimeStats = (sinceDays = 7) => {
    const cutoff = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);

    // Get buy fills with fill time data
    const fillsWithTime = Array.from(fills.values())
      .filter(f => f.side === 'buy' && f.fillTimeMs !== null && f.fillTimeMs !== undefined && f.timestamp >= cutoff)
      .map(f => f.fillTimeMs)
      .sort((a, b) => a - b);

    if (fillsWithTime.length === 0) {
      return {
        count: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p50Ms: 0,
        p90Ms: 0,
        staleCount: 0,
        staleRate: 0,
      };
    }

    const sum = fillsWithTime.reduce((acc, t) => acc + t, 0);
    const avg = sum / fillsWithTime.length;

    // Calculate percentiles
    const p50Index = Math.floor(fillsWithTime.length * 0.5);
    const p90Index = Math.floor(fillsWithTime.length * 0.9);

    // Count "stale" fills (took longer than 30s default)
    const staleThreshold = 30000; // 30 seconds
    const staleCount = fillsWithTime.filter(t => t > staleThreshold).length;

    return {
      count: fillsWithTime.length,
      avgMs: Math.round(avg),
      minMs: fillsWithTime[0],
      maxMs: fillsWithTime[fillsWithTime.length - 1],
      p50Ms: fillsWithTime[p50Index],
      p90Ms: fillsWithTime[Math.min(p90Index, fillsWithTime.length - 1)],
      staleCount,
      staleRate: roundUSDC((staleCount / fillsWithTime.length) * 100),
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

  /**
   * Recalculate cycles from fill history
   * - Identifies completed cycles (cycles with sells)
   * - Assigns orphan fills (cycleId: null) to cycles based on timestamp
   * - Calculates BTC holdback per cycle and total reserves
   * @returns {{cyclesCompleted: number, realizedPnL: number, realizedBtcPnL: number, cycleDetails: Array, orphansFixed: number}}
   */
  const recalculateCycles = () => {
    const allFills = Array.from(fills.values()).sort((a, b) => a.timestamp - b.timestamp);

    // Group fills by cycleId
    const cycleMap = new Map();
    const orphanFills = [];

    for (const fill of allFills) {
      if (!fill.cycleId) {
        orphanFills.push(fill);
      } else {
        if (!cycleMap.has(fill.cycleId)) {
          cycleMap.set(fill.cycleId, []);
        }
        cycleMap.get(fill.cycleId).push(fill);
      }
    }

    // Identify completed cycles (have at least one sell)
    const completedCycles = [];
    const activeCycles = [];

    for (const [cycleId, cycleFills] of cycleMap) {
      const hasSell = cycleFills.some(f => f.side === 'sell');
      if (hasSell) {
        completedCycles.push({ cycleId, fills: cycleFills });
      } else {
        activeCycles.push({ cycleId, fills: cycleFills });
      }
    }

    // Calculate P&L and holdback for each completed cycle
    const cycleDetails = [];
    let totalRealizedPnL = 0;
    let totalRealizedBtcPnL = 0;

    for (const { cycleId, fills: cycleFills } of completedCycles) {
      let totalBTC = 0;
      let totalCost = 0;
      let sellProceeds = 0;
      let btcSold = 0;

      for (const fill of cycleFills) {
        if (fill.side === 'buy') {
          totalBTC += fill.size;
          totalCost += fill.quoteAmount + fill.netFee;
        } else if (fill.side === 'sell') {
          sellProceeds += fill.quoteAmount - fill.netFee;
          btcSold += fill.size;
        }
      }

      const avgCost = totalBTC > 0 ? totalCost / totalBTC : 0;
      const costBasisSold = avgCost * btcSold;
      const pnl = sellProceeds - costBasisSold;
      const holdbackBtc = roundBTC(totalBTC - btcSold);

      cycleDetails.push({
        cycleId,
        buys: cycleFills.filter(f => f.side === 'buy').length,
        sells: cycleFills.filter(f => f.side === 'sell').length,
        totalBtcBought: roundBTC(totalBTC),
        btcSold: roundBTC(btcSold),
        holdbackBtc,
        avgCost: roundUSDC(avgCost),
        sellPrice: btcSold > 0 ? roundUSDC(sellProceeds / btcSold) : 0,
        pnl: roundUSDC(pnl),
      });

      totalRealizedPnL += pnl;
      totalRealizedBtcPnL += holdbackBtc;
    }

    // Assign orphan fills to cycles based on buy-sell pattern
    // A sell ends a cycle, the next buy starts a new cycle
    let orphansFixed = 0;
    if (orphanFills.length > 0) {
      // Sort orphans chronologically
      orphanFills.sort((a, b) => a.timestamp - b.timestamp);

      // Split orphans into cycles based on buy-sell pattern
      const orphanCycles = [];
      let currentOrphanCycle = [];
      let lastWasSell = false;

      for (const fill of orphanFills) {
        // If last fill was a sell and this is a buy, start new cycle
        if (lastWasSell && fill.side === 'buy') {
          if (currentOrphanCycle.length > 0) {
            orphanCycles.push(currentOrphanCycle);
          }
          currentOrphanCycle = [];
        }

        currentOrphanCycle.push(fill);
        lastWasSell = (fill.side === 'sell');
      }

      // Don't forget the last cycle
      if (currentOrphanCycle.length > 0) {
        orphanCycles.push(currentOrphanCycle);
      }

      console.log(`🔧 [${exchange}] Split ${orphanFills.length} orphan fills into ${orphanCycles.length} cycles`);

      // Assign cycle IDs and calculate P&L for completed orphan cycles
      for (let i = 0; i < orphanCycles.length; i++) {
        const cycleFills = orphanCycles[i];
        const hasSell = cycleFills.some(f => f.side === 'sell');
        const cycleId = `cycle-${cycleFills[0].timestamp}-recovered-${i + 1}`;

        // Assign cycle ID to all fills in this cycle
        for (const fill of cycleFills) {
          fill.cycleId = cycleId;
          fills.set(fill.tradeId, fill);
          orphansFixed++;
        }

        // If this is a completed cycle (has sell), calculate its P&L
        if (hasSell) {
          let totalBTC = 0;
          let totalCost = 0;
          let sellProceeds = 0;
          let btcSold = 0;

          for (const fill of cycleFills) {
            if (fill.side === 'buy') {
              totalBTC += fill.size;
              totalCost += fill.quoteAmount + fill.netFee;
            } else if (fill.side === 'sell') {
              sellProceeds += fill.quoteAmount - fill.netFee;
              btcSold += fill.size;
            }
          }

          const avgCost = totalBTC > 0 ? totalCost / totalBTC : 0;
          const costBasisSold = avgCost * btcSold;
          const pnl = sellProceeds - costBasisSold;
          const holdbackBtc = roundBTC(totalBTC - btcSold);

          cycleDetails.push({
            cycleId,
            buys: cycleFills.filter(f => f.side === 'buy').length,
            sells: cycleFills.filter(f => f.side === 'sell').length,
            totalBtcBought: roundBTC(totalBTC),
            btcSold: roundBTC(btcSold),
            holdbackBtc,
            avgCost: roundUSDC(avgCost),
            sellPrice: btcSold > 0 ? roundUSDC(sellProceeds / btcSold) : 0,
            pnl: roundUSDC(pnl),
          });

          totalRealizedPnL += pnl;
          totalRealizedBtcPnL += holdbackBtc;
          completedCycles.push({ cycleId, fills: cycleFills });
        } else {
          // This is the current active cycle
          currentCycleId = cycleId;
        }
      }

      if (orphansFixed > 0) {
        console.log(`🔧 [${exchange}] Assigned ${orphansFixed} orphan fills, found ${orphanCycles.filter(c => c.some(f => f.side === 'sell')).length} completed cycles`);
      }
    }

    // Persist the cycle ID assignments
    if (orphansFixed > 0) {
      persist();
    }

    return {
      cyclesCompleted: cycleDetails.length,
      realizedPnL: roundUSDC(totalRealizedPnL),
      realizedBtcPnL: roundBTC(totalRealizedBtcPnL),
      cycleDetails,
      orphansFixed,
      activeCycleId: currentCycleId,
    };
  };

  /**
   * Update a fill's cycleId
   * @param {string} tradeId - Trade ID
   * @param {string} cycleId - New cycle ID
   */
  const updateFillCycleId = (tradeId, cycleId) => {
    const fill = fills.get(tradeId);
    if (fill) {
      fill.cycleId = cycleId;
      fills.set(tradeId, fill);
    }
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
    getFillTimeStats,
    getFillsSince,
    aggregateFills,
    recalculateCycles,
    updateFillCycleId,
    persist,
    load,
  };
};

module.exports = {
  createFillLedger,
  getFillLedgerPath,
};
