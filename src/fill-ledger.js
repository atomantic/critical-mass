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
  /** @type {Map<string, number>} orderId -> total recorded size for O(1) watermark lookups in hot retry loops */
  const orderSizeIndex = new Map();
  let currentCycleId = null;
  let nextCycleNumber = 1;
  // True when in-memory state has been mutated since the last successful
  // persist. Lets persist() short-circuit when there's nothing new to
  // write, so callers (e.g. unbounded retry loops in market-data-service)
  // can call persist() defensively on every tick without churning the
  // ledger file or blocking the event loop on every backoff. External
  // callers that mutate fill objects directly (via getAllFills /
  // getFillsForOrder) MUST call markDirty() so the next persist actually
  // flushes their changes — see dca-converter.js for the pattern.
  let dirtySinceLastPersist = false;
  // Tracks whether load() has ever completed (file present or absent) so
  // corruption-recovery branches can distinguish a live SIGUSR1 reload
  // (preserve in-memory) from a cold-start boot (throw, force operator
  // intervention). Without this, a cold start with a corrupt file would
  // boot with an empty ledger and the next successful persist would
  // overwrite the recoverable file with only post-start fills, silently
  // discarding history.
  let hasLoadedSuccessfully = false;
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
  const resetCaches = () => {
    // Reset all in-memory state to empty. load() may be called more than
    // once on a live ledger instance (regime-engine SIGUSR1 reload), so
    // every load path must start clean — otherwise stale fills from a
    // prior load (or from before a manual reconciliation removed them
    // from disk) would survive and inflate getRecordedSizeForOrder.
    // currentCycleId/nextCycleNumber are part of that state — without
    // resetting them, a reload to an empty ledger would keep attributing
    // new fills to the prior cycle.
    fills.clear();
    cycleIndex.clear();
    orderSizeIndex.clear();
    currentCycleId = null;
    nextCycleNumber = 1;
    // Clear the dirty flag too. After a reload, in-memory matches disk,
    // so a defensive persist() on the next tick must be a no-op rather
    // than rewriting the just-loaded snapshot — preserves the "clean
    // persists are a no-op" contract that avoids file churn on every
    // retry-loop call to persist().
    dirtySinceLastPersist = false;
  };

  const load = () => {
    const filePath = getFillLedgerPath(exchange, pair);
    // Reload-vs-cold-start signal. Either a prior successful load OR any
    // already-ingested fills means there is in-memory state worth
    // preserving. Without this distinction, a cold-start boot against a
    // corrupt file would silently start with an empty ledger and the
    // next persist would overwrite the recoverable file with only
    // post-start fills — destroying the historical record.
    const isReload = hasLoadedSuccessfully || fills.size > 0;
    if (!fs.existsSync(filePath)) {
      // Initial load (no file yet) leaves the freshly-constructed empty
      // caches in place. SIGUSR1 reload (regime-engine.js calls load()
      // on the live ledger) preserves whatever is in memory so a
      // momentarily-missing file (e.g., operator's edit/rename window)
      // doesn't wipe live data. To intentionally clear, write `[]` to
      // the file — that loads cleanly to empty state.
      console.log(`📖 [${exchange}] fill-ledger not found at ${filePath} — preserving in-memory state (${fills.size} fills)`);
      hasLoadedSuccessfully = true;
      return;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if (!isReload) {
        // Cold-start corruption: throwing forces the operator to repair
        // (or move aside) the file before the engine boots, so a
        // post-start persist can't overwrite the recoverable contents.
        throw new Error(`fill-ledger at ${filePath} is corrupted or unreadable on cold start: ${err.message}. Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
      }
      // Corrupt/unreadable file: don't reset in-memory state. SIGUSR1
      // reload on a live ledger could otherwise turn a bad manual edit
      // or partial write into live data loss — the running process
      // would forget its last known-good state and the next persist
      // would rewrite the file with only the fills that arrive after
      // the reload. Operator can fix the file and re-fire SIGUSR1.
      console.log(`❌ [${exchange}] fill-ledger corrupted or unreadable at ${filePath}: ${err.message} — keeping in-memory state (${fills.size} fills); operator must fix and reload`);
      return;
    }
    // Validate shape BEFORE resetCaches. Valid JSON like `{}` or `null`
    // would parse without throwing but the for-of below would crash —
    // resetCaches() would have already wiped the live ledger by then,
    // so the reload-on-malformed-payload would fall into the same data-
    // loss mode that the catch-block above guards against.
    if (!Array.isArray(data)) {
      if (!isReload) {
        throw new Error(`fill-ledger at ${filePath} is not an array on cold start (got ${data === null ? 'null' : typeof data}). Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
      }
      console.log(`❌ [${exchange}] fill-ledger at ${filePath} is not an array (got ${data === null ? 'null' : typeof data}) — keeping in-memory state (${fills.size} fills); operator must fix and reload`);
      return;
    }
    // Element-level validation: even an array can contain malformed
    // entries like `[null]` or `[{}]` that would crash on `fill.tradeId`
    // mid-loop, leaving the live ledger half-populated after the
    // already-run resetCaches. Pre-pass guarantees a clean reload-or-bail.
    //
    // Field-type validation is required, not just presence: the load-body
    // below calls `fill.cycleId.match(/^cycle-(\d+)$/)` which throws on
    // non-string cycleId (e.g. an object). A presence-only pre-pass would
    // accept `{tradeId:"t1", cycleId:{}}` and we'd crash mid-load AFTER
    // resetCaches has wiped the live ledger — re-introducing the data-loss
    // mode the pre-validation is meant to prevent.
    for (const fill of data) {
      let invalidReason = null;
      if (!fill || typeof fill !== 'object') {
        invalidReason = 'non-object entry';
      } else if (typeof fill.tradeId !== 'string' || !fill.tradeId) {
        invalidReason = 'missing or non-string tradeId';
      } else if (fill.cycleId != null && typeof fill.cycleId !== 'string') {
        invalidReason = 'cycleId must be a string when present';
      } else if (fill.orderId != null && typeof fill.orderId !== 'string') {
        invalidReason = 'orderId must be a string when present';
      } else if (fill.side != null && fill.side !== 'buy' && fill.side !== 'sell') {
        invalidReason = "side must be 'buy' or 'sell' when present";
      } else if (fill.size != null && (typeof fill.size !== 'number' || !Number.isFinite(fill.size))) {
        invalidReason = 'size must be a finite number when present';
      } else if (fill.timestamp != null && (typeof fill.timestamp !== 'number' || !Number.isFinite(fill.timestamp))) {
        invalidReason = 'timestamp must be a finite number when present';
      }
      if (invalidReason) {
        if (!isReload) {
          throw new Error(`fill-ledger at ${filePath} contains an invalid entry (${invalidReason}) on cold start. Repair or move the file aside before starting; refusing to boot with an empty ledger that would overwrite recoverable history on next persist.`);
        }
        console.log(`❌ [${exchange}] fill-ledger at ${filePath} contains an invalid entry (${invalidReason}) — keeping in-memory state (${fills.size} fills); operator must fix and reload`);
        return;
      }
    }
    // Clean slate before re-reading. The successful-read path mirrors
    // disk authoritatively (handles "operator removed fills via manual
    // reconciliation, then reloaded" — those removals must take effect).
    resetCaches();
    for (const fill of data) {
      fills.set(fill.tradeId, fill);
      // Populate cycle index
      if (fill.cycleId) {
        if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
        cycleIndex.get(fill.cycleId).add(fill.tradeId);
      }
    }
    // Rebuild orderSizeIndex from the canonical fills Map AFTER population.
    // load() can be called multiple times on a live ledger (regime-engine.js
    // re-loads on state reload). If we accumulated inside the loop above,
    // a second load() would double-count every persisted fill on top of
    // the existing totals — making getRecordedSizeForOrder over-report
    // and the market-data-service watermark believe orders are fully
    // ingested when they're not. Rebuilding from `fills` is idempotent.
    orderSizeIndex.clear();
    for (const f of fills.values()) {
      if (f.orderId) {
        const next = (orderSizeIndex.get(f.orderId) || 0) + (f.size || 0);
        orderSizeIndex.set(f.orderId, roundAsset(next));
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
    // A cycle is "active" if it has not been fully closed (any unsold portion remains)
    const allFills = Array.from(fills.values()).sort((a, b) => b.timestamp - a.timestamp);
    for (const fill of allFills) {
      if (!fill.cycleId) continue;
      const stats = cycleStats.get(fill.cycleId);
      if (!stats || stats.buysAsset === 0) continue;
      const sellRatio = stats.sellsAsset / stats.buysAsset;
      if (sellRatio < 1.0) {
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

    hasLoadedSuccessfully = true;
    console.log(`📖 [${exchange}] Loaded ${fills.size} fills from ledger`);
  };

  // Counter for tests: increments only when persist() actually writes to
  // disk (after the dirty-flag short-circuit). Tests assert the no-op
  // contract of persist() against this counter rather than filesystem
  // mtime, since mtime granularity varies across CI filesystems and
  // produces flaky assertions.
  let writeCount = 0;

  /**
   * Persist fill ledger to disk. No-op when nothing has changed since the
   * last successful persist — callers can invoke this defensively on
   * every retry tick without churning the ledger file.
   */
  const persist = () => {
    const filePath = getFillLedgerPath(exchange, pair);
    // Clean shutdowns must still write when the on-disk file has gone
    // missing (operator rm, transient unmount, etc.) — otherwise
    // regime-engine.stop()'s defensive persist() would no-op, the
    // process exits, and the next boot's load() sees no file and treats
    // it as a fresh deployment with empty history. Subsequent persists
    // would then write a file containing only post-restart fills,
    // silently destroying the recoverable in-memory ledger that the
    // dirty-flag short-circuit refused to flush. fs.existsSync is cheap
    // and the missing-file case is rare, so the extra check costs ~nothing.
    if (!dirtySinceLastPersist && fs.existsSync(filePath)) return;

    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fillsArray = Array.from(fills.values())
      .sort((a, b) => a.timestamp - b.timestamp);

    atomicWriteSync(filePath, JSON.stringify(fillsArray, null, 2));
    dirtySinceLastPersist = false;
    writeCount += 1;
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
    // Maintain per-order size index for O(1) watermark lookups in retry loops.
    // Round to asset precision so accumulated float error can't keep the
    // retry chain running on a fully-recorded order (see load() for context).
    if (fill.orderId) {
      const next = (orderSizeIndex.get(fill.orderId) || 0) + (fill.size || 0);
      orderSizeIndex.set(fill.orderId, roundAsset(next));
    }
    dirtySinceLastPersist = true;
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

    // Global realized P&L via FIFO cost basis replay. This is the gold standard:
    // replay all buys and sells chronologically, track cost lots, compute realized
    // P&L on each sell. Independent of annotations and buy-sell linkage.
    let globalRealizedPnL = 0;
    let globalRealizedAssetPnL = 0;
    const costLots = []; // [{qty, unitCost}]
    for (const fill of allFills) {
      if (fill.side === 'buy') {
        const cost = fill.quoteAmount + fill.netFee;
        costLots.push({ qty: fill.size, unitCost: fill.size > 0 ? cost / fill.size : 0 });
      } else if (fill.side === 'sell') {
        const proceeds = fill.quoteAmount - fill.netFee;
        let remain = fill.size;
        let costBasis = 0;
        while (remain > 1e-12 && costLots.length > 0) {
          const lot = costLots[0];
          const use = Math.min(remain, lot.qty);
          costBasis += use * lot.unitCost;
          lot.qty -= use;
          remain -= use;
          if (lot.qty <= 1e-12) costLots.shift();
        }
        globalRealizedPnL += proceeds - costBasis;
      }
    }
    // Remaining lots = unsold position (holdback reserves + active position)
    globalRealizedAssetPnL = roundAsset(costLots.reduce((s, l) => s + l.qty, 0));
    globalRealizedPnL = roundUSDC(globalRealizedPnL);
    globalRealizedAssetPnL = roundAsset(globalRealizedAssetPnL);

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
          dirtySinceLastPersist = true;
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

    // Renumber cycles only when orphan fills created new cycle IDs that need
    // sequential numbering. Skip renumbering otherwise to preserve stable IDs.
    if (orphansFixed > 0) {
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
        cycleIndex.clear();
        for (const fill of Array.from(fills.values())) {
          if (fill.cycleId && idMap.has(fill.cycleId)) {
            fill.cycleId = idMap.get(fill.cycleId);
            fills.set(fill.tradeId, fill);
            dirtySinceLastPersist = true;
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
    }

    // Auto-link buys to sells within completed cycles only (fixes orphaned buys display).
    // Skip active cycles to avoid linking unsold buys to early partial sells.
    let linkedCount = 0;
    const completedCycleIds = new Set(cycleDetails.map(d => d.cycleId));
    const cycleSellIds = new Map(); // cycleId -> first sell orderId
    for (const fill of fills.values()) {
      if (fill.side === 'sell' && fill.cycleId && completedCycleIds.has(fill.cycleId) && !cycleSellIds.has(fill.cycleId)) {
        cycleSellIds.set(fill.cycleId, fill.orderId);
      }
    }
    for (const fill of fills.values()) {
      if (fill.side === 'buy' && fill.cycleId && !fill.sellOrderId && completedCycleIds.has(fill.cycleId)) {
        const sellId = cycleSellIds.get(fill.cycleId);
        if (sellId) {
          fill.sellOrderId = sellId;
          linkedCount++;
          dirtySinceLastPersist = true;
        }
      }
    }
    if (linkedCount > 0) {
      console.log(`🔗 [${exchange}] Linked ${linkedCount} buys to their cycle sells`);
    }

    if (orphansFixed > 0 || linkedCount > 0) {
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
      dirtySinceLastPersist = true;
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
        dirtySinceLastPersist = true;
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
    /** O(1) watermark lookup. Use this in hot paths instead of getFillsForOrder + reduce. */
    getRecordedSizeForOrder: (orderId) => orderSizeIndex.get(orderId) || 0,
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
    /** External callers that mutate fill objects directly (via getAllFills /
     * getFillsForOrder) MUST call this so the next persist() actually
     * flushes their changes — persist no-ops on a clean dirty flag. */
    markDirty: () => { dirtySinceLastPersist = true; },
    load,
    // Test-only handle: returns the number of times persist() actually
    // wrote to disk (skipping the no-op short-circuit). Lets tests
    // assert "no-op when clean" without relying on filesystem mtime,
    // which has variable granularity across CI runners.
    _test: { getWriteCount: () => writeCount },
  };
};

module.exports = {
  createFillLedger,
  getFillLedgerPath,
};
