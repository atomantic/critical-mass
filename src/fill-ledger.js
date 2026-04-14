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
const { resolveFundDataDir } = require('./migration');
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { atomicWriteSync } = require('./state-tracker');
const { getBaseCurrency } = require('./config-utils');

/**
 * @typedef {import('./types').Fill} Fill
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 */

/**
 * Get fill ledger file path for a fund (exchange + pair).
 * Read-only path resolution — does NOT create the directory. The persist()
 * function below mkdirs before writing.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to fill ledger file
 */
const getFillLedgerPath = (exchange, pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'fill-ledger.json');
};

/**
 * Create fill ledger instance
 * @param {string} exchange - Exchange name
 * @param {string} [productId] - Product ID (e.g. 'BTC-USDC') used to derive base currency for logs
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair (resolved when ledger is created)
 * @returns {Object} Fill ledger instance
 */
const createFillLedger = (exchange, productId, pair) => {
  /** @type {Map<string, Fill>} */
  const fills = new Map();
  /** @type {Map<string, Set<string>>} cycleId -> Set of tradeIds for O(1) cycle lookups */
  const cycleIndex = new Map();
  let currentCycleId = null;
  let nextCycleNumber = 1;
  const baseCurrency = getBaseCurrency(productId);
  const fmtPrice = (p) => {
    if (p == null || isNaN(p)) return '-';
    if (Math.abs(p) >= 100) return `$${p.toFixed(2)}`;
    if (Math.abs(p) >= 1) return `$${p.toFixed(4)}`;
    return `$${p.toFixed(5)}`;
  };

  /**
   * Load fill ledger from disk
   */
  const load = () => {
    const filePath = getFillLedgerPath(exchange, pair);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const fill of data) {
      fills.set(fill.tradeId, fill);
      // Populate cycle index
      if (fill.cycleId) {
        if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
        cycleIndex.get(fill.cycleId).add(fill.tradeId);
      }
    }

    // Restore currentCycleId from loaded fills
    // Find the most recent cycle that's still active (sells haven't closed out the position)
    const cycleStats = new Map(); // cycleId -> { buysAsset, sellsAsset }
    for (const fill of fills.values()) {
      if (!fill.cycleId) continue;
      if (!cycleStats.has(fill.cycleId)) {
        cycleStats.set(fill.cycleId, { buysAsset: 0, sellsAsset: 0 });
      }
      const stats = cycleStats.get(fill.cycleId);
      if (fill.side === 'buy') stats.buysAsset += fill.size;
      else if (fill.side === 'sell') stats.sellsAsset += fill.size;
    }

    // Find an active cycle - prefer most recent
    // A cycle is "active" if less than 50% of position has been sold
    const allFills = Array.from(fills.values()).sort((a, b) => b.timestamp - a.timestamp);
    for (const fill of allFills) {
      if (!fill.cycleId) continue;
      const stats = cycleStats.get(fill.cycleId);
      if (!stats || stats.buysAsset === 0) continue;
      const sellRatio = stats.sellsAsset / stats.buysAsset;
      if (sellRatio < 0.5) {
        currentCycleId = fill.cycleId;
        console.log(`📖 [${exchange}] Restored active cycle: ${currentCycleId} (${(sellRatio * 100).toFixed(1)}% sells)`);
        break;
      }
    }

    // Initialize nextCycleNumber from existing cycle IDs
    let maxCycleNum = 0;
    for (const fill of fills.values()) {
      if (!fill.cycleId) continue;
      const match = fill.cycleId.match(/^cycle-(\d+)$/);
      if (match) {
        maxCycleNum = Math.max(maxCycleNum, parseInt(match[1], 10));
      }
    }
    nextCycleNumber = maxCycleNum + 1;

    console.log(`📖 [${exchange}] Loaded ${fills.size} fills from ledger`);
  };

  /**
   * Persist fill ledger to disk
   */
  const persist = () => {
    const filePath = getFillLedgerPath(exchange, pair);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fillsArray = Array.from(fills.values())
      .sort((a, b) => a.timestamp - b.timestamp);

    atomicWriteSync(filePath, JSON.stringify(fillsArray, null, 2));
  };

  /**
   * Ingest a fill (idempotent)
   * @param {Object} fillData - Raw fill data from exchange
   * @param {number} [orderPlacedAt] - Optional timestamp when the order was placed (for fill time tracking)
   * @returns {{ingested: boolean, fill: Fill|null}} Result
   */
  const ingestFill = (fillData, orderPlacedAt = null, options = {}) => {
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
    // Maintain cycle index
    if (fill.cycleId) {
      if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
      cycleIndex.get(fill.cycleId).add(tradeId);
    }
    if (!options.skipPersist) persist();

    const fillTimeStr = fillTimeMs !== null ? ` (fill time: ${(fillTimeMs / 1000).toFixed(1)}s)` : '';
    console.log(`📝 [${exchange}] Fill ingested: tradeId=${tradeId} orderId=${fill.orderId} ${fill.side} ${fill.size} ${baseCurrency} @ ${fmtPrice(fill.price)} (fee: $${fill.netFee.toFixed(4)})${fillTimeStr}`);

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
    const tradeIds = cycleIndex.get(currentCycleId);
    if (!tradeIds || tradeIds.size === 0) return [];
    const result = [];
    for (const id of tradeIds) {
      const fill = fills.get(id);
      if (fill) result.push(fill);
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
  };

  /**
   * Rebuild position state from fills
   * @param {Fill[]} [fillsToProcess] - Specific fills to process (defaults to current cycle)
   * @returns {RegimePositionState} Rebuilt position state
   */
  const rebuildPositionFromFills = (fillsToProcess) => {
    const chronoFills = fillsToProcess || getCurrentCycleFills();

    // Reorder linked buy-sell pairs so buys process before their sells,
    // even when a corrective buy has a later timestamp than its sell.
    const buysBySellOrderId = new Map();
    for (const f of chronoFills) {
      if (f.side === 'buy' && f.sellOrderId) {
        if (!buysBySellOrderId.has(f.sellOrderId)) buysBySellOrderId.set(f.sellOrderId, []);
        buysBySellOrderId.get(f.sellOrderId).push(f);
      }
    }
    let targetFills = chronoFills;
    if (buysBySellOrderId.size > 0) {
      const result = [];
      const emitted = new Set();
      for (const fill of chronoFills) {
        if (emitted.has(fill.tradeId)) continue;
        if (fill.side === 'sell') {
          const linkedBuys = buysBySellOrderId.get(fill.orderId);
          if (linkedBuys) {
            for (const buy of linkedBuys) {
              if (!emitted.has(buy.tradeId)) {
                result.push(buy);
                emitted.add(buy.tradeId);
              }
            }
          }
        }
        result.push(fill);
        emitted.add(fill.tradeId);
      }
      targetFills = result;
    }

    let totalAsset = 0;
    let totalCostBasis = 0;
    let realizedPnL = 0;
    let lastEntryPrice = 0;
    let lastEntryTime = 0;
    const uniqueBuyOrders = new Set();

    for (const fill of targetFills) {
      // Skip body-owned fills — they have independent position tracking
      if (fill.isBodyOwned || fill.isSatellite || fill.bodyId) continue;

      if (fill.side === 'buy') {
        const costBasis = fill.quoteAmount + fill.netFee;
        totalAsset = roundAsset(totalAsset + fill.size);
        totalCostBasis = roundUSDC(totalCostBasis + costBasis);
        uniqueBuyOrders.add(fill.orderId);
        lastEntryPrice = fill.price;
        lastEntryTime = fill.timestamp;
      } else if (fill.side === 'sell') {
        const proceeds = fill.quoteAmount - fill.netFee;
        const avgCost = totalAsset > 0 ? totalCostBasis / totalAsset : 0;
        const soldCostBasis = fill.size * avgCost;
        realizedPnL = roundUSDC(realizedPnL + (proceeds - soldCostBasis));

        totalAsset = roundAsset(totalAsset - fill.size);
        if (totalAsset < 0) {
          console.log(`⚠️ [${exchange}] rebuildPositionFromFills: negative ${baseCurrency} ${totalAsset} after sell ${fill.tradeId}, clamping to 0`);
          totalAsset = 0;
          totalCostBasis = 0;
        } else {
          totalCostBasis = roundUSDC(totalCostBasis - soldCostBasis);
        }
      }
    }

    const avgCostBasis = totalAsset > 0 ? totalCostBasis / totalAsset : 0;

    return {
      totalAsset,
      totalCostBasis,
      avgCostBasis,
      cycleBuys: uniqueBuyOrders.size,
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
    currentCycleId = `cycle-${nextCycleNumber}`;
    nextCycleNumber++;
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
    const totalBuyAsset = buyFills.reduce((sum, f) => sum + f.size, 0);
    const totalSellAsset = sellFills.reduce((sum, f) => sum + f.size, 0);
    const totalFees = allFills.reduce((sum, f) => sum + f.netFee, 0);

    return {
      totalFills: allFills.length,
      buyFills: buyFills.length,
      sellFills: sellFills.length,
      totalBuyValue: roundUSDC(totalBuyValue),
      totalSellValue: roundUSDC(totalSellValue),
      totalBuyAsset: roundAsset(totalBuyAsset),
      totalSellAsset: roundAsset(totalSellAsset),
      netAsset: roundAsset(totalBuyAsset - totalSellAsset),
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
      totalSize: roundAsset(totalSize),
      totalValue: roundUSDC(totalValue),
      totalFees: roundUSDC(totalFees),
      avgPrice: totalSize > 0 ? totalValue / totalSize : 0,
    };
  };

  /**
   * Recalculate cycles from fill history
   * - Identifies completed cycles (cycles with sells)
   * - Assigns orphan fills (cycleId: null) to cycles based on timestamp
   * - Calculates BTC holdback per cycle and total reserves
   * @returns {{cyclesCompleted: number, realizedPnL: number, realizedAssetPnL: number, cycleDetails: Array, orphansFixed: number}}
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

    // Identify completed cycles (sells have closed most of the position)
    const completedCycles = [];
    const activeCycles = [];

    for (const [cycleId, cycleFills] of cycleMap) {
      let buysAsset = 0;
      let allSellsAsset = 0;
      for (const fill of cycleFills) {
        if (fill.side === 'buy') buysAsset += fill.size;
        else if (fill.side === 'sell') {
          allSellsAsset += fill.size;
        }
      }
      // A cycle is "completed" when total sells cover most of the bought position
      // (body TP sells, core TP sells, or any combination)
      const sellRatio = buysAsset > 0 ? allSellsAsset / buysAsset : 0;
      if (sellRatio >= 0.5) {
        completedCycles.push({ cycleId, fills: cycleFills });
      } else {
        activeCycles.push({ cycleId, fills: cycleFills });
      }
    }

    // Calculate P&L and holdback for each completed cycle
    const cycleDetails = [];
    let totalRealizedPnL = 0;
    let totalRealizedAssetPnL = 0;

    // Global P&L: total sell proceeds minus total buy costs.
    // This is always correct regardless of annotation state or buy-sell linkage.
    let globalRealizedPnL = 0;
    let globalRealizedAssetPnL = 0;
    let totalBuyQty = 0, totalBuyCost = 0;
    let totalSellQty = 0, totalSellProceeds = 0;
    for (const fill of allFills) {
      if (fill.side === 'buy') {
        totalBuyQty += fill.size;
        totalBuyCost += fill.quoteAmount + fill.netFee;
      } else if (fill.side === 'sell') {
        totalSellQty += fill.size;
        totalSellProceeds += fill.quoteAmount - fill.netFee;
      }
    }
    globalRealizedPnL = roundUSDC(totalSellProceeds - totalBuyCost);
    globalRealizedAssetPnL = roundAsset(totalBuyQty - totalSellQty);

    for (const { cycleId, fills: cycleFills } of completedCycles) {
      let totalAsset = 0;
      let totalCost = 0;
      let sellProceeds = 0;
      let assetSold = 0;

      for (const fill of cycleFills) {
        // Skip body-owned fills — they have independent P&L tracking
        if (fill.isBodyOwned || fill.isSatellite || fill.bodyId) continue;

        if (fill.side === 'buy') {
          totalAsset += fill.size;
          totalCost += fill.quoteAmount + fill.netFee;
        } else if (fill.side === 'sell') {
          sellProceeds += fill.quoteAmount - fill.netFee;
          assetSold += fill.size;
        }
      }

      const avgCost = totalAsset > 0 ? totalCost / totalAsset : 0;
      const costBasisSold = avgCost * assetSold;
      const pnl = sellProceeds - costBasisSold;
      const holdbackAsset = roundAsset(totalAsset - assetSold);

      cycleDetails.push({
        cycleId,
        buys: cycleFills.filter(f => f.side === 'buy' && !f.isSatellite && !f.bodyId).length,
        sells: cycleFills.filter(f => f.side === 'sell' && !f.isSatellite && !f.bodyId).length,
        totalAssetBought: roundAsset(totalAsset),
        assetSold: roundAsset(assetSold),
        holdbackAsset,
        avgCost: roundUSDC(avgCost),
        sellPrice: assetSold > 0 ? roundUSDC(sellProceeds / assetSold) : 0,
        pnl: roundUSDC(pnl),
      });

      totalRealizedPnL += pnl;
      totalRealizedAssetPnL += holdbackAsset;
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
        const cycleId = `cycle-${cycleFills[0].timestamp}-recovered-${i + 1}`;

        // Assign cycle ID to all fills in this cycle
        if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
        for (const fill of cycleFills) {
          fill.cycleId = cycleId;
          fills.set(fill.tradeId, fill);
          cycleIndex.get(cycleId).add(fill.tradeId);
          orphansFixed++;
        }

        // Check if this is a completed cycle using BTC balance ratio
        // (same heuristic as main cycle detection — core TP sells ~99.75%)
        let orphanBuysAsset = 0;
        let orphanSellsAsset = 0;
        for (const fill of cycleFills) {
          if (fill.side === 'buy') orphanBuysAsset += fill.size;
          else if (fill.side === 'sell') orphanSellsAsset += fill.size;
        }
        const orphanSellRatio = orphanBuysAsset > 0 ? orphanSellsAsset / orphanBuysAsset : 0;
        const isCompleted = orphanSellRatio >= 0.5;

        if (isCompleted) {
          let totalAsset = 0;
          let totalCost = 0;
          let sellProceeds = 0;
          let assetSold = 0;

          for (const fill of cycleFills) {
            // Skip body/satellite fills — they have independent P&L tracking
            if (fill.isSatellite || fill.bodyId) continue;

            if (fill.side === 'buy') {
              totalAsset += fill.size;
              totalCost += fill.quoteAmount + fill.netFee;
            } else if (fill.side === 'sell') {
              sellProceeds += fill.quoteAmount - fill.netFee;
              assetSold += fill.size;
            }
          }

          const avgCost = totalAsset > 0 ? totalCost / totalAsset : 0;
          const costBasisSold = avgCost * assetSold;
          const pnl = sellProceeds - costBasisSold;
          const holdbackAsset = roundAsset(totalAsset - assetSold);

          cycleDetails.push({
            cycleId,
            buys: cycleFills.filter(f => f.side === 'buy' && !f.isSatellite && !f.bodyId).length,
            sells: cycleFills.filter(f => f.side === 'sell' && !f.isSatellite && !f.bodyId).length,
            totalAssetBought: roundAsset(totalAsset),
            assetSold: roundAsset(assetSold),
            holdbackAsset,
            avgCost: roundUSDC(avgCost),
            sellPrice: assetSold > 0 ? roundUSDC(sellProceeds / assetSold) : 0,
            pnl: roundUSDC(pnl),
          });

          totalRealizedPnL += pnl;
          totalRealizedAssetPnL += holdbackAsset;
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

    // Renumber all cycles sequentially (cycle-1, cycle-2, etc.)
    const cycleTimestamps = new Map();
    for (const fill of Array.from(fills.values())) {
      if (!fill.cycleId) continue;
      const existing = cycleTimestamps.get(fill.cycleId);
      if (!existing || fill.timestamp < existing) {
        cycleTimestamps.set(fill.cycleId, fill.timestamp);
      }
    }

    const completedIds = new Set(cycleDetails.map(d => d.cycleId));
    const completedEntries = [];
    const activeEntries = [];
    for (const [id, ts] of cycleTimestamps) {
      if (completedIds.has(id)) completedEntries.push([id, ts]);
      else activeEntries.push([id, ts]);
    }
    completedEntries.sort((a, b) => a[1] - b[1]);
    activeEntries.sort((a, b) => a[1] - b[1]);

    let cycleNum = 1;
    let renumbered = 0;
    const idMap = new Map();
    for (const [oldId] of [...completedEntries, ...activeEntries]) {
      const newId = `cycle-${cycleNum}`;
      idMap.set(oldId, newId);
      if (oldId !== newId) renumbered++;
      cycleNum++;
    }

    if (renumbered > 0) {
      // Rebuild cycle index after renumbering
      cycleIndex.clear();
      for (const fill of Array.from(fills.values())) {
        if (fill.cycleId && idMap.has(fill.cycleId)) {
          fill.cycleId = idMap.get(fill.cycleId);
          fills.set(fill.tradeId, fill);
        }
        if (fill.cycleId) {
          if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
          cycleIndex.get(fill.cycleId).add(fill.tradeId);
        }
      }
      for (const detail of cycleDetails) {
        if (idMap.has(detail.cycleId)) detail.cycleId = idMap.get(detail.cycleId);
      }
      if (currentCycleId && idMap.has(currentCycleId)) {
        currentCycleId = idMap.get(currentCycleId);
      }
      console.log(`🔢 [${exchange}] Renumbered ${renumbered} cycles to sequential IDs (cycle-1 through cycle-${cycleNum - 1})`);
    }
    nextCycleNumber = cycleNum;

    // Auto-link buys to sells within the same cycle (fixes orphaned buys display)
    let linkedCount = 0;
    const cycleSellIds = new Map(); // cycleId -> first sell orderId
    for (const fill of fills.values()) {
      if (fill.side === 'sell' && fill.cycleId && !cycleSellIds.has(fill.cycleId)) {
        cycleSellIds.set(fill.cycleId, fill.orderId);
      }
    }
    for (const fill of fills.values()) {
      if (fill.side === 'buy' && fill.cycleId && !fill.sellOrderId) {
        const sellId = cycleSellIds.get(fill.cycleId);
        if (sellId) {
          fill.sellOrderId = sellId;
          linkedCount++;
        }
      }
    }
    if (linkedCount > 0) {
      console.log(`🔗 [${exchange}] Linked ${linkedCount} buys to their cycle sells`);
    }

    if (orphansFixed > 0 || renumbered > 0 || linkedCount > 0) {
      persist();
    }

    return {
      cyclesCompleted: cycleDetails.length,
      realizedPnL: roundUSDC(totalRealizedPnL),
      realizedAssetPnL: roundAsset(totalRealizedAssetPnL),
      globalRealizedPnL: roundUSDC(globalRealizedPnL),
      globalRealizedAssetPnL: roundAsset(globalRealizedAssetPnL),
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
      // Remove from old cycle index
      if (fill.cycleId && cycleIndex.has(fill.cycleId)) {
        cycleIndex.get(fill.cycleId).delete(tradeId);
      }
      fill.cycleId = cycleId;
      fills.set(tradeId, fill);
      // Add to new cycle index
      if (cycleId) {
        if (!cycleIndex.has(cycleId)) cycleIndex.set(cycleId, new Set());
        cycleIndex.get(cycleId).add(tradeId);
      }
    }
  };

  /**
   * Annotate a fill with additional metadata (e.g. celestial body TP data)
   * @param {string} orderId - Order ID to annotate fills for
   * @param {Object} metadata - Key-value pairs to merge into the fill (bodyId, bodyTier, isBodyOwned, etc.)
   */
  const annotateFillsByOrderId = (orderId, metadata) => {
    let matched = false;
    for (const [, fill] of fills) {
      if (fill.orderId === orderId) {
        Object.assign(fill, metadata);
        matched = true;
      }
    }
    // Persist when sellOrderId is set to ensure it survives restarts
    if (matched && metadata.sellOrderId) {
      persist();
    }
  };

  /**
   * Get the count of unique buy orders in the current cycle
   * @returns {number} Unique buy order count
   */
  const getCurrentCycleBuysCount = () => {
    const cycleFills = getCurrentCycleFills();
    const uniqueBuyOrders = new Set();
    for (const fill of cycleFills) {
      // Skip body-owned buys — they have independent position tracking
      if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId) {
        uniqueBuyOrders.add(fill.orderId);
      }
    }
    return uniqueBuyOrders.size;
  };

  // Initialize by loading from disk
  load();

  return {
    ingestFill,
    getFillsForOrder,
    getCurrentCycleFills,
    getCurrentCycleBuysCount,
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
    annotateFillsByOrderId,
    persist,
    load,
  };
};

module.exports = {
  createFillLedger,
  getFillLedgerPath,
};
