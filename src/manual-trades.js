// @ts-check
/**
 * Manual Trade Tracker
 *
 * Tracks manual trades made outside the regime engine (e.g., sell-first
 * rebalancing orders). Each manual trade pairs a sell with a recovery buy,
 * and the system monitors the buy order until it fills.
 *
 * State is persisted to data/<exchange>/<pair>/manual-trades.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveFundDataDir } = require('./migration');
const { atomicWriteSync } = require('./state-tracker');

/**
 * @typedef {Object} ManualTrade
 * @property {string} id
 * @property {string} sellOrderId
 * @property {number} sellPrice
 * @property {number} sellSize
 * @property {number} sellQuoteAmount
 * @property {number} sellTimestamp
 * @property {string[]} sellFillTradeIds
 * @property {string|null} buyOrderId
 * @property {number|null} buyPrice
 * @property {number|null} buySize
 * @property {number|null} buyPlacedAt
 * @property {number|null} buyFilledAt
 * @property {string[]} buyFillTradeIds
 * @property {'sell_recorded'|'buy_pending'|'buy_recorded'|'tp_pending'|'completed'|'dismissed'} status
 * @property {'sell_first'|'buy_first'|'paired'} tradeType
 * @property {string|null} bodyId
 * @property {string} note
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const STATUS = Object.freeze({
  SELL_RECORDED: 'sell_recorded',
  BUY_PENDING: 'buy_pending',
  BUY_RECORDED: 'buy_recorded',
  TP_PENDING: 'tp_pending',
  COMPLETED: 'completed',
  DISMISSED: 'dismissed',
});

const getStorePath = (exchange, pair) => {
  return path.join(resolveFundDataDir(exchange, pair), 'manual-trades.json');
};

/**
 * Create manual trade store instance
 * @param {string} exchange
 * @param {string} [pair]
 * @returns {Object}
 */
const createManualTradeStore = (exchange, pair) => {
  /** @type {Map<string, ManualTrade>} */
  const trades = new Map();
  /** @type {Set<string>} orderIds dismissed from the unaccounted fills view */
  const dismissedFillOrderIds = new Set();

  const persist = () => {
    const filePath = getStorePath(exchange, pair);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const data = {
      trades: Array.from(trades.values()),
      dismissedFillOrderIds: Array.from(dismissedFillOrderIds),
    };
    atomicWriteSync(filePath, JSON.stringify(data, null, 2));
  };

  const load = () => {
    const filePath = getStorePath(exchange, pair);
    if (!fs.existsSync(filePath)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(raw.trades)) {
        for (const t of raw.trades) {
          if (!t.tradeType) t.tradeType = 'sell_first';
          if (t.bodyId === undefined) t.bodyId = null;
          trades.set(t.id, t);
        }
      }
      if (Array.isArray(raw.dismissedFillOrderIds)) {
        for (const id of raw.dismissedFillOrderIds) {
          dismissedFillOrderIds.add(id);
        }
      }
      console.log(`📋 [${exchange}] Loaded ${trades.size} manual trades, ${dismissedFillOrderIds.size} dismissed fills`);
    } catch (err) {
      console.log(`⚠️ [${exchange}] Failed to load manual trades: ${err.message}`);
    }
  };

  /**
   * Add a manual sell trade
   * @param {Object} sellData
   * @param {string} sellData.sellOrderId
   * @param {number} sellData.sellPrice
   * @param {number} sellData.sellSize
   * @param {number} sellData.sellQuoteAmount
   * @param {number} sellData.sellTimestamp
   * @param {string[]} sellData.sellFillTradeIds
   * @param {string} [sellData.note]
   * @returns {ManualTrade}
   */
  const addManualSell = (sellData) => {
    // Check if we already have a trade for this sell order
    for (const t of trades.values()) {
      if (t.sellOrderId === sellData.sellOrderId) {
        return t; // Idempotent
      }
    }

    const now = Date.now();
    /** @type {ManualTrade} */
    const trade = {
      id: crypto.randomUUID(),
      sellOrderId: sellData.sellOrderId,
      sellPrice: sellData.sellPrice,
      sellSize: sellData.sellSize,
      sellQuoteAmount: sellData.sellQuoteAmount,
      sellTimestamp: sellData.sellTimestamp,
      sellFillTradeIds: sellData.sellFillTradeIds || [],
      buyOrderId: null,
      buyPrice: null,
      buySize: null,
      buyPlacedAt: null,
      buyFilledAt: null,
      buyFillTradeIds: [],
      status: STATUS.SELL_RECORDED,
      tradeType: 'sell_first',
      bodyId: null,
      note: sellData.note || '',
      createdAt: now,
      updatedAt: now,
    };

    trades.set(trade.id, trade);
    persist();
    return trade;
  };

  /**
   * Add a manual buy trade (buy-first flow)
   * @param {Object} buyData
   * @param {string} buyData.buyOrderId
   * @param {number} buyData.buyPrice
   * @param {number} buyData.buySize
   * @param {number} buyData.buyQuoteAmount
   * @param {number} buyData.buyTimestamp
   * @param {string[]} buyData.buyFillTradeIds
   * @param {string} [buyData.note]
   * @returns {ManualTrade}
   */
  const addManualBuy = (buyData) => {
    for (const t of trades.values()) {
      if (t.buyOrderId === buyData.buyOrderId) {
        return t; // Idempotent
      }
    }

    const now = Date.now();
    /** @type {ManualTrade} */
    const trade = {
      id: crypto.randomUUID(),
      sellOrderId: null,
      sellPrice: null,
      sellSize: null,
      sellQuoteAmount: null,
      sellTimestamp: null,
      sellFillTradeIds: [],
      buyOrderId: buyData.buyOrderId,
      buyPrice: buyData.buyPrice,
      buySize: buyData.buySize,
      buyPlacedAt: buyData.buyTimestamp,
      buyFilledAt: buyData.buyTimestamp,
      buyFillTradeIds: buyData.buyFillTradeIds || [],
      status: STATUS.BUY_RECORDED,
      tradeType: 'buy_first',
      bodyId: null,
      note: buyData.note || '',
      createdAt: now,
      updatedAt: now,
    };

    trades.set(trade.id, trade);
    persist();
    return trade;
  };

  /**
   * Add a paired trade (both buy and sell already filled)
   * @param {Object} buyData
   * @param {Object} sellData
   * @param {string} [note]
   * @returns {ManualTrade}
   */
  const addPairedTrade = (buyData, sellData, note) => {
    const now = Date.now();
    /** @type {ManualTrade} */
    const trade = {
      id: crypto.randomUUID(),
      sellOrderId: sellData.sellOrderId,
      sellPrice: sellData.sellPrice,
      sellSize: sellData.sellSize,
      sellQuoteAmount: sellData.sellQuoteAmount,
      sellTimestamp: sellData.sellTimestamp,
      sellFillTradeIds: sellData.sellFillTradeIds || [],
      buyOrderId: buyData.buyOrderId,
      buyPrice: buyData.buyPrice,
      buySize: buyData.buySize,
      buyPlacedAt: buyData.buyTimestamp,
      buyFilledAt: buyData.buyTimestamp,
      buyFillTradeIds: buyData.buyFillTradeIds || [],
      status: STATUS.COMPLETED,
      tradeType: 'paired',
      bodyId: null,
      note: note || '',
      createdAt: now,
      updatedAt: now,
    };

    trades.set(trade.id, trade);
    persist();
    return trade;
  };

  /**
   * Mark a buy-first trade as having a TP body placed
   * @param {string} tradeId
   * @param {string} bodyId
   * @returns {ManualTrade|null}
   */
  const markTpPlaced = (tradeId, bodyId) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.bodyId = bodyId;
    trade.status = STATUS.TP_PENDING;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Record a recovery buy order (newly placed)
   * @param {string} tradeId - Manual trade ID
   * @param {string} buyOrderId - Exchange order ID
   * @param {number} buyPrice - Limit price
   * @param {number} buySize - BTC quantity
   * @returns {ManualTrade|null}
   */
  const recordRecoveryBuy = (tradeId, buyOrderId, buyPrice, buySize) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.buyOrderId = buyOrderId;
    trade.buyPrice = buyPrice;
    trade.buySize = buySize;
    trade.buyPlacedAt = Date.now();
    trade.status = STATUS.BUY_PENDING;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Link an existing buy order (already placed on exchange)
   * @param {string} tradeId - Manual trade ID
   * @param {string} buyOrderId - Exchange order ID
   * @returns {ManualTrade|null}
   */
  const linkExistingBuy = (tradeId, buyOrderId) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.buyOrderId = buyOrderId;
    trade.status = STATUS.BUY_PENDING;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Mark the recovery buy as filled
   * @param {string} tradeId - Manual trade ID
   * @param {Object} fillInfo
   * @param {number} fillInfo.buyPrice - Actual fill price
   * @param {number} fillInfo.buySize - Actual fill size
   * @param {string[]} fillInfo.buyFillTradeIds - Trade IDs from exchange
   * @returns {ManualTrade|null}
   */
  const markBuyFilled = (tradeId, fillInfo) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.buyPrice = fillInfo.buyPrice;
    trade.buySize = fillInfo.buySize;
    trade.buyFilledAt = Date.now();
    trade.buyFillTradeIds = fillInfo.buyFillTradeIds || [];
    trade.status = STATUS.COMPLETED;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Dismiss a manual trade
   * @param {string} tradeId
   * @returns {ManualTrade|null}
   */
  const dismiss = (tradeId) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.status = STATUS.DISMISSED;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Dismiss fill order IDs from unaccounted fills view
   * @param {string[]} orderIds
   */
  const dismissFills = (orderIds) => {
    for (const id of orderIds) {
      dismissedFillOrderIds.add(id);
    }
    persist();
  };

  /**
   * Check if a fill order ID has been dismissed
   * @param {string} orderId
   * @returns {boolean}
   */
  const isFillDismissed = (orderId) => {
    return dismissedFillOrderIds.has(orderId);
  };

  /**
   * Get all manual trades
   * @returns {ManualTrade[]}
   */
  const getAll = () => Array.from(trades.values()).sort((a, b) => b.createdAt - a.createdAt);

  /**
   * Get pending manual trades (buy_pending status)
   * @returns {ManualTrade[]}
   */
  const getPending = () => getAll().filter(t => t.status === STATUS.BUY_PENDING);

  /**
   * Get a manual trade by ID
   * @param {string} tradeId
   * @returns {ManualTrade|null}
   */
  const getById = (tradeId) => trades.get(tradeId) || null;

  /**
   * Get pending buy order IDs (for orphan protection)
   * @returns {Set<string>}
   */
  const getPendingBuyOrderIds = () => {
    const ids = new Set();
    for (const t of trades.values()) {
      if (t.status === STATUS.BUY_PENDING && t.buyOrderId) {
        ids.add(t.buyOrderId);
      }
    }
    return ids;
  };

  return {
    load,
    persist,
    addManualSell,
    addManualBuy,
    addPairedTrade,
    recordRecoveryBuy,
    linkExistingBuy,
    markBuyFilled,
    markTpPlaced,
    dismiss,
    dismissFills,
    isFillDismissed,
    getAll,
    getPending,
    getById,
    getPendingBuyOrderIds,
  };
};

module.exports = { createManualTradeStore, STATUS };
