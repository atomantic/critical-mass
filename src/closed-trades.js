// @ts-check
/**
 * Closed Trades Ledger
 *
 * Aggregated records of completed sell trades with their matched buy costs.
 * A second booking of the same sell order updates its existing record so
 * status totals stay aligned with the fill ledger; a replay remains a no-op.
 * Total realized P&L is simply the sum of all closed trade pnl fields.
 */

const fs = require('fs');
const path = require('path');
const { resolveFundDataDir } = require('./migration');
const { atomicWriteSync } = require('./state-tracker');
const { createContextLogger } = require('./logger');
const { roundAsset, roundUSDC } = require('./volatility-utils');

/**
 * Dedup key for a closed trade. Keyed on sellOrderId ALONE — each sell order
 * closes exactly one cycle's worth of buys and has one aggregate record. (A
 * true partial body-TP fill normally re-places its residual under a NEW
 * orderId; when a second booking keeps the same orderId, record() updates the
 * existing aggregate instead of creating a second record.) Keying on
 * `sellOrderId:qtySold` instead let the live path (qtySold = size over the
 * newly-ingested fills) and migrateFromFills (qtySold = size over ALL rows for
 * the orderId) compute different qtys for the same sell → different keys →
 * the same trade recorded twice, double-counting totalPnl (issue #108).
 *
 * Fallback to `sellOrderId:qtySold:timestamp` only when sellOrderId is missing
 * (legacy/manual rows) so distinct unlinked trades aren't collapsed into one.
 * @param {{sellOrderId?: string|null, qtySold?: number, timestamp?: number}} trade
 * @returns {string}
 */
const dedupKeyFor = (trade) =>
  trade.sellOrderId
    ? `${trade.sellOrderId}`
    : `${trade.sellOrderId}:${trade.qtySold?.toFixed(8)}:${trade.timestamp}`;

/**
 * @typedef {Object} ClosedTrade
 * @property {string} sellOrderId
 * @property {number} timestamp
 * @property {number} recordedAt
 * @property {number} qtySold
 * @property {number} sellProceeds
 * @property {number} sellFees
 * @property {number} costBasis
 * @property {number} buyAvgPrice
 * @property {number} pnl
 * @property {number} holdbackAsset - reserves booked (≥ 0)
 * @property {number} [reservesSoldAsset] - reserves a stale TP sold beyond its body (#770)
 * @property {boolean} isPartial
 * @property {string|null} bodyId
 * @property {string|null} bodyTier
 * @property {string|null} cycleId
 * @property {string[]} buyOrderIds
 * @property {string} source
 */

const getClosedTradesPath = (exchange, pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'closed-trades.json');
};

/**
 * Create closed trades ledger instance
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {Object}
 */
const createClosedTrades = (exchange, pair) => {
  const logger = createContextLogger({ exchange, pair });
  /** @type {ClosedTrade[]} */
  const trades = [];
  /** @type {Set<string>} Aggregate keys (see dedupKeyFor — keyed on sellOrderId) */
  const dedupKeys = new Set();

  const load = () => {
    const filePath = getClosedTradesPath(exchange, pair);
    if (!fs.existsSync(filePath)) return false;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : [];
      trades.length = 0;
      dedupKeys.clear();
      for (const t of arr) {
        trades.push(t);
        dedupKeys.add(dedupKeyFor(t));
      }
      logger.info(`📋 [${exchange}] Loaded ${trades.length} closed trades`, {
        filePath,
        tradeCount: trades.length,
      });
      return true;
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Failed to load closed trades: ${err.message}`, {
        filePath,
        error: err.message,
      });
      return false;
    }
  };

  const persist = () => {
    const filePath = getClosedTradesPath(exchange, pair);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(filePath, JSON.stringify(trades, null, 2));
  };

  /**
   * Record a closed trade. New sell orders append a record. A booking that
   * adds newly-ingested execution to an existing sell order passes `additive`
   * so its quantities and realized values merge in place; a replay leaves the
   * existing record untouched.
   * @param {ClosedTrade} trade
   * @param {{additive?: boolean}} [options]
   * @returns {boolean} Whether the ledger changed (false for a replay)
   */
  const record = (trade, { additive = false } = {}) => {
    const key = dedupKeyFor(trade);
    if (dedupKeys.has(key)) {
      if (!additive) return false;

      const existing = trades.find(t => dedupKeyFor(t) === key);
      if (!existing) return false;

      const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
      const add = (field, round) => {
        existing[field] = round(number(existing[field]) + number(trade[field]));
      };

      add('qtySold', roundAsset);
      add('sellProceeds', roundUSDC);
      add('sellFees', roundUSDC);
      add('costBasis', roundUSDC);
      add('pnl', roundUSDC);
      add('holdbackAsset', roundAsset);

      const reservesSoldAsset = roundAsset(
        number(existing.reservesSoldAsset) + number(trade.reservesSoldAsset)
      );
      if (reservesSoldAsset > 0 || existing.reservesSoldAsset != null || trade.reservesSoldAsset != null) {
        existing.reservesSoldAsset = reservesSoldAsset;
      }

      if (Number.isFinite(Number(trade.timestamp))
        && (!Number.isFinite(Number(existing.timestamp)) || trade.timestamp > existing.timestamp)) {
        existing.timestamp = trade.timestamp;
      }
      if (Number.isFinite(Number(trade.recordedAt))
        && (!Number.isFinite(Number(existing.recordedAt)) || trade.recordedAt > existing.recordedAt)) {
        existing.recordedAt = trade.recordedAt;
      }
      if (Number.isFinite(Number(trade.buyAvgPrice))) existing.buyAvgPrice = trade.buyAvgPrice;
      if (trade.isPartial !== undefined) existing.isPartial = trade.isPartial;
      for (const field of ['bodyId', 'bodyTier', 'cycleId', 'source']) {
        if (trade[field] != null) existing[field] = trade[field];
      }
      existing.buyOrderIds = [...new Set([
        ...(existing.buyOrderIds || []),
        ...(trade.buyOrderIds || []),
      ])];

      persist();
      return true;
    }
    dedupKeys.add(key);
    trades.push(trade);
    persist();
    return true;
  };

  const getAll = () => [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const getTotalPnL = () => roundUSDC(trades.reduce((s, t) => s + (t.pnl || 0), 0));
  // Net of reserves a stale TP sold beyond its body (#770): that asset left
  // the reserves, and its proceeds are already in the trade's pnl.
  const getTotalHoldback = () => roundAsset(trades.reduce((s, t) => s + (t.holdbackAsset || 0) - (t.reservesSoldAsset || 0), 0));
  const getCount = () => trades.length;
  const getByCycleId = (cycleId) => trades.filter(t => t.cycleId === cycleId);

  /**
   * Backfill closed-trades from fill ledger.
   *
   * Idempotent: each generated entry carries a sellOrderId and is dedup'd
   * via record() (keyed on sellOrderId alone — see dedupKeyFor). Safe to
   * call on every engine startup — it'll only
   * add missing entries, leaving live engine-recorded entries untouched.
   *
   * This was originally a one-time migration gated on `trades.length === 0`,
   * but that gate failed to self-heal post-rectification scenarios where
   * closed-trades.json was cleared (or partially repopulated by post-rectify
   * sells) while the ledger had a fuller history. Now we always run and rely
   * on record()'s dedup.
   * @param {Object} fillLedger
   */
  const migrateFromFills = (fillLedger) => {
    const allFills = fillLedger.getAllFills();
    if (allFills.length === 0) return;

    // Group buys and sells by bodyId
    const buysByBody = new Map();
    const sellsByBody = new Map();
    const sellsNoBody = [];

    for (const fill of allFills) {
      if (fill.side === 'buy' && fill.bodyId) {
        if (!buysByBody.has(fill.bodyId)) buysByBody.set(fill.bodyId, []);
        buysByBody.get(fill.bodyId).push(fill);
      } else if (fill.side === 'sell') {
        if (fill.bodyId) {
          if (!sellsByBody.has(fill.bodyId)) sellsByBody.set(fill.bodyId, []);
          sellsByBody.get(fill.bodyId).push(fill);
        } else {
          sellsNoBody.push(fill);
        }
      }
    }

    // Process body-matched sells: prorate buy cost to sell quantity
    for (const [bodyId, sellFills] of sellsByBody) {
      const buyFills = buysByBody.get(bodyId) || [];

      // Aggregate sell fills by orderId
      const sellOrders = new Map();
      for (const s of sellFills) {
        const prev = sellOrders.get(s.orderId);
        if (prev) {
          prev.qty += s.size;
          prev.proceeds += s.quoteAmount - s.netFee;
          prev.fees += s.netFee;
        } else {
          sellOrders.set(s.orderId, {
            qty: s.size,
            proceeds: s.quoteAmount - s.netFee,
            fees: s.netFee,
            timestamp: s.timestamp,
            tier: s.bodyTier,
            cycleId: s.cycleId,
            isPartial: s.partialFill || false,
            holdback: s.bodyHoldbackAsset || 0,
          });
        }
      }

      // Total buy cost and quantity for this body
      const totalBuyQty = buyFills.reduce((s, b) => s + b.size, 0);
      const totalBuyCost = buyFills.reduce((s, b) => s + (b.quoteAmount || 0) + (b.netFee || 0), 0);
      const buyAvgPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
      const buyOrderIds = [...new Set(buyFills.map(b => b.orderId))];

      for (const [sellOrderId, sd] of sellOrders) {
        // Prorate buy cost to this sell's quantity
        const costBasis = totalBuyQty > 0
          ? roundUSDC((sd.qty / totalBuyQty) * totalBuyCost)
          : 0;
        const pnl = roundUSDC(sd.proceeds - costBasis);

        record({
          sellOrderId,
          timestamp: sd.timestamp,
          recordedAt: Date.now(),
          qtySold: sd.qty,
          sellProceeds: roundUSDC(sd.proceeds),
          sellFees: roundUSDC(sd.fees),
          costBasis,
          buyAvgPrice: roundUSDC(buyAvgPrice),
          pnl,
          holdbackAsset: 0, // Can't reliably compute from historical data
          isPartial: sd.isPartial,
          bodyId,
          bodyTier: sd.tier || null,
          cycleId: sd.cycleId || null,
          buyOrderIds,
          source: 'migration',
        });
      }
    }

    // Process non-body sells: match via sellOrderId linkage on buys
    const buysBySellId = new Map();
    for (const fill of allFills) {
      if (fill.side === 'buy' && fill.sellOrderId && !fill.bodyId) {
        if (!buysBySellId.has(fill.sellOrderId)) buysBySellId.set(fill.sellOrderId, []);
        buysBySellId.get(fill.sellOrderId).push(fill);
      }
    }

    // Aggregate non-body sells by orderId
    const noBodySellOrders = new Map();
    for (const s of sellsNoBody) {
      const prev = noBodySellOrders.get(s.orderId);
      if (prev) {
        prev.qty += s.size;
        prev.proceeds += s.quoteAmount - s.netFee;
        prev.fees += s.netFee;
      } else {
        noBodySellOrders.set(s.orderId, {
          qty: s.size,
          proceeds: s.quoteAmount - s.netFee,
          fees: s.netFee,
          timestamp: s.timestamp,
          cycleId: s.cycleId,
        });
      }
    }

    for (const [sellOrderId, sd] of noBodySellOrders) {
      const linkedBuys = buysBySellId.get(sellOrderId) || [];
      if (linkedBuys.length === 0) continue; // Can't compute without buys

      const buyCost = linkedBuys.reduce((s, b) => s + (b.quoteAmount || 0) + (b.netFee || 0), 0);
      const buyQty = linkedBuys.reduce((s, b) => s + b.size, 0);
      const costBasis = buyQty > 0
        ? roundUSDC((sd.qty / buyQty) * buyCost)
        : 0;

      record({
        sellOrderId,
        timestamp: sd.timestamp,
        recordedAt: Date.now(),
        qtySold: sd.qty,
        sellProceeds: roundUSDC(sd.proceeds),
        sellFees: roundUSDC(sd.fees),
        costBasis,
        buyAvgPrice: buyQty > 0 ? roundUSDC(buyCost / buyQty) : 0,
        pnl: roundUSDC(sd.proceeds - costBasis),
        holdbackAsset: 0,
        isPartial: false,
        bodyId: null,
        bodyTier: null,
        cycleId: sd.cycleId || null,
        buyOrderIds: [...new Set(linkedBuys.map(b => b.orderId))],
        source: 'migration',
      });
    }

    if (trades.length > 0) {
      persist();
      logger.info(`📋 [${exchange}] Migrated ${trades.length} closed trades from fill ledger (P&L: $${getTotalPnL().toFixed(2)})`, {
        tradeCount: trades.length,
        totalPnl: getTotalPnL(),
        source: 'fill-ledger',
      });
    }
  };

  return {
    load,
    persist,
    record,
    getAll,
    getTotalPnL,
    getTotalHoldback,
    getCount,
    getByCycleId,
    migrateFromFills,
  };
};

module.exports = {
  createClosedTrades,
  getClosedTradesPath,
};
