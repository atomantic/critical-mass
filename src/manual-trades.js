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
const { atomicWriteSync, quarantineFile } = require('./state-tracker');
const { createContextLogger } = require('./logger');

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
 * @property {RecoveryAttempt[]} [recoveryAttempts] - Sell-first only: every recovery buy placed or linked, oldest first
 * @property {{at:number, error:string|null, message:string}|null} [lastCheck] - Outcome of the most recent status check or recovery operation
 * @property {'sell_recorded'|'buy_pending'|'buy_cancelled'|'buy_recorded'|'tp_pending'|'completed'|'dismissed'} status
 * @property {'sell_first'|'buy_first'|'paired'} tradeType
 * @property {string|null} bodyId
 * @property {BodyIntent|null} bodyIntent
 * @property {RecoveryIntent|null} [recoveryIntent] - Sell-first only: recovery buy submitted (or about to be) whose outcome is not yet recorded
 * @property {number} [recoveryIntentSeq] - Sell-first only: recovery placements ever attempted; seeds each intent's client order id
 * @property {string} note
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * Durable record of a buy-first import's body creation (issue #1022). Written
 * BEFORE the body is published anywhere, so a crash or a thrown publication
 * can always be resumed with the same body identity instead of being inferred
 * from a ledger bodyId alone.
 * @typedef {Object} BodyIntent
 * @property {string} bodyId - Stable id of the body this import creates
 * @property {Object|null} body - Complete body payload; dropped once committed
 * @property {'pending'|'committed'} phase
 * @property {number} createdAt
 * @property {number|null} committedAt
 */

/**
 * Durable record of a sell-first recovery buy placement (issue #1058). Written
 * BEFORE the order is submitted, so a crash, restart or transport error between
 * the exchange accepting the order and the store recording it can never be
 * mistaken for "no buy placed": the intent blocks another placement until the
 * exchange is asked about its client order id.
 * @typedef {Object} RecoveryIntent
 * @property {string} clientOrderId - Deterministic id sent with the order
 * @property {number} attempt - 1-based placement sequence the id was derived from
 * @property {string} productId
 * @property {number} size
 * @property {number} price
 * @property {number} createdAt
 */

/**
 * Deterministic client order id for one recovery placement: UUID-shaped (every
 * adapter accepts it — Crypto.com caps client_oid at 36 characters) and derived
 * only from the trade id and attempt number, so it is reproducible from the
 * persisted record.
 * @param {string} tradeId
 * @param {number} attempt
 * @returns {string}
 */
const recoveryClientOrderId = (tradeId, attempt) => {
  const hex = crypto.createHash('sha256').update(`manual-recovery:${tradeId}:${attempt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const INTENT_PHASE = Object.freeze({
  PENDING: 'pending',
  COMMITTED: 'committed',
});

/**
 * One recovery buy order for a sell-first trade (issue #1034). The attempt list
 * is append-only history: a terminal attempt keeps its order id and whatever
 * it executed, so a replacement only has to cover what is still missing.
 * @typedef {Object} RecoveryAttempt
 * @property {string} orderId
 * @property {'placed'|'linked'} kind
 * @property {number|null} price - Limit price when placed by us
 * @property {number|null} size - Planned quantity when placed by us
 * @property {number|null} startedAt
 * @property {'filled'|'cancelled'|null} outcome - null while the order may still be live
 * @property {string|null} exchangeStatus - Terminal status the exchange reported
 * @property {number} filledSize
 * @property {number} filledQuote
 * @property {string[]} fillTradeIds
 * @property {number|null} endedAt
 */

/** Quantities closer than this are treated as equal (1 satoshi). */
const SIZE_EPSILON = 0.00000001;

const STATUS = Object.freeze({
  SELL_RECORDED: 'sell_recorded',
  BUY_PENDING: 'buy_pending',
  // The recovery buy left the book without covering the whole sell (issue
  // #1034). Terminal for that order, but the trade itself stays recoverable:
  // retryRecovery places/links a replacement for the uncovered remainder.
  BUY_CANCELLED: 'buy_cancelled',
  BUY_RECORDED: 'buy_recorded',
  TP_PENDING: 'tp_pending',
  COMPLETED: 'completed',
  DISMISSED: 'dismissed',
});

/** @returns {RecoveryAttempt} */
const newAttempt = ({ orderId, kind, price = null, size = null, startedAt = Date.now() }) => ({
  orderId,
  kind,
  price,
  size,
  startedAt,
  outcome: null,
  exchangeStatus: null,
  filledSize: 0,
  filledQuote: 0,
  fillTradeIds: [],
  endedAt: null,
});

/**
 * Give a record written before attempts were tracked an attempt list that
 * matches its legacy fields, so every reader can rely on it.
 * @param {ManualTrade} trade
 */
const normalizeRecoveryAttempts = (trade) => {
  if (trade.tradeType !== 'sell_first' || Array.isArray(trade.recoveryAttempts)) return;
  trade.recoveryAttempts = [];
  if (!trade.buyOrderId) return;
  const attempt = newAttempt({
    orderId: trade.buyOrderId,
    kind: trade.buyPlacedAt ? 'placed' : 'linked',
    price: trade.buyPlacedAt ? trade.buyPrice : null,
    size: trade.buyPlacedAt ? trade.buySize : null,
    startedAt: trade.buyPlacedAt || trade.updatedAt || null,
  });
  if (trade.status === STATUS.COMPLETED) {
    attempt.outcome = 'filled';
    attempt.filledSize = trade.buySize || 0;
    attempt.filledQuote = (trade.buySize || 0) * (trade.buyPrice || 0);
    attempt.fillTradeIds = trade.buyFillTradeIds || [];
    attempt.endedAt = trade.buyFilledAt || null;
  }
  trade.recoveryAttempts.push(attempt);
};

/**
 * Quantity and quote already recovered by a sell-first trade's terminal
 * attempts. A live attempt contributes nothing until it is confirmed terminal.
 * @param {ManualTrade} trade
 * @returns {{size:number, quote:number, tradeIds:string[]}}
 */
const getRecoveredTotals = (trade) => {
  const done = (trade.recoveryAttempts || []).filter((a) => a.outcome);
  return {
    size: done.reduce((sum, a) => sum + a.filledSize, 0),
    quote: done.reduce((sum, a) => sum + a.filledQuote, 0),
    tradeIds: done.flatMap((a) => a.fillTradeIds),
  };
};

/**
 * Sold quantity a sell-first trade still has to buy back, with float noise
 * removed so the adapter's floor-to-increment does not shave a satoshi.
 * @param {ManualTrade} trade
 * @returns {number}
 */
const getUncoveredSize = (trade) => {
  const remaining = (trade.sellSize || 0) - getRecoveredTotals(trade).size;
  return remaining > SIZE_EPSILON ? Math.round(remaining * 1e10) / 1e10 : 0;
};

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
  const logger = createContextLogger({ exchange, pair });
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

  /** @type {Map<string, Promise<void>>} */
  const orderLocks = new Map();

  const load = () => {
    const filePath = getStorePath(exchange, pair);
    if (!fs.existsSync(filePath)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(raw.trades)) {
        for (const t of raw.trades) {
          if (!t.tradeType) t.tradeType = 'sell_first';
          if (t.bodyId === undefined) t.bodyId = null;
          if (t.bodyIntent === undefined) t.bodyIntent = null;
          if (t.recoveryIntent === undefined) t.recoveryIntent = null;
          normalizeRecoveryAttempts(t);
          trades.set(t.id, t);
        }
      }
      if (Array.isArray(raw.dismissedFillOrderIds)) {
        for (const id of raw.dismissedFillOrderIds) {
          dismissedFillOrderIds.add(id);
        }
      }
      logger.info(`📋 [${exchange}] Loaded ${trades.size} manual trades, ${dismissedFillOrderIds.size} dismissed fills`, {
        filePath,
        tradeCount: trades.size,
        dismissedFillCount: dismissedFillOrderIds.size,
      });
    } catch (err) {
      // The next persist() would overwrite the file with an empty store.
      const quarantinePath = quarantineFile(filePath, logger);
      logger.warn(`⚠️ [${exchange}] Failed to load manual trades: ${err.message}`, {
        filePath,
        quarantinePath,
        error: err.message,
      });
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
      recoveryAttempts: [],
      lastCheck: null,
      status: STATUS.SELL_RECORDED,
      tradeType: 'sell_first',
      bodyId: null,
      bodyIntent: null,
      recoveryIntent: null,
      recoveryIntentSeq: 0,
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
      bodyIntent: null,
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
    // Idempotent by (buyOrderId, sellOrderId) — a retry returns the existing
    // record instead of creating a second paired-trade row for the same fills
    // (issue #691; mirrors addManualBuy/addManualSell's per-order idempotency).
    for (const t of trades.values()) {
      if (t.buyOrderId === buyData.buyOrderId && t.sellOrderId === sellData.sellOrderId) {
        if (t.status === STATUS.COMPLETED || t.status === STATUS.DISMISSED) {
          // COMPLETED: a genuine prior paired import of this exact pair —
          // nothing to do. DISMISSED: the operator explicitly dismissed this
          // pair — promoting it back to COMPLETED would silently resurrect a
          // record they chose to discard; leave it exactly as they left it.
          return t;
        }
        // A non-completed, non-dismissed record for this exact
        // (buyOrderId, sellOrderId) already exists — most likely
        // importSell's sell-first recovery flow created it (status
        // BUY_PENDING) while waiting on the recovery buy to fill, and the
        // operator has now imported the same pair directly via importPair,
        // which already fetched and linked both legs' fills. Promote it in
        // place instead of returning it unchanged (issue #726) — otherwise
        // it stays stuck at its old status forever despite nothing being
        // left to do.
        t.sellPrice = sellData.sellPrice;
        t.sellSize = sellData.sellSize;
        t.sellQuoteAmount = sellData.sellQuoteAmount;
        t.sellTimestamp = sellData.sellTimestamp;
        t.sellFillTradeIds = sellData.sellFillTradeIds || [];
        t.buyPrice = buyData.buyPrice;
        t.buySize = buyData.buySize;
        t.buyQuoteAmount = buyData.buyQuoteAmount;
        t.buyFilledAt = buyData.buyTimestamp;
        t.buyFillTradeIds = buyData.buyFillTradeIds || [];
        t.status = STATUS.COMPLETED;
        t.tradeType = 'paired';
        if (note) t.note = note;
        t.updatedAt = Date.now();
        persist();
        return t;
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
      buyOrderId: buyData.buyOrderId,
      buyPrice: buyData.buyPrice,
      buySize: buyData.buySize,
      buyPlacedAt: buyData.buyTimestamp,
      buyFilledAt: buyData.buyTimestamp,
      buyFillTradeIds: buyData.buyFillTradeIds || [],
      status: STATUS.COMPLETED,
      tradeType: 'paired',
      bodyId: null,
      bodyIntent: null,
      note: note || '',
      createdAt: now,
      updatedAt: now,
    };

    trades.set(trade.id, trade);
    persist();
    return trade;
  };

  /**
   * Refresh a buy-first trade's recorded fill totals to match a fuller fill
   * set discovered on a retried import (issue #726 — the buy order was
   * still filling when the trade record was first written, so its
   * buyPrice/buySize/buyQuoteAmount/buyFillTradeIds reflected only the
   * fills seen at that time). Only called once a retry's extra fills have
   * actually been folded into the body they belong to, so the two never
   * drift apart.
   * @param {string} tradeId
   * @param {{buyPrice:number, buySize:number, buyQuoteAmount:number, buyFillTradeIds:string[]}} totals
   * @returns {ManualTrade|null}
   */
  const refreshBuyTotals = (tradeId, totals) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.buyPrice = totals.buyPrice;
    trade.buySize = totals.buySize;
    trade.buyQuoteAmount = totals.buyQuoteAmount;
    trade.buyFillTradeIds = totals.buyFillTradeIds || trade.buyFillTradeIds;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Durably record the body a buy-first import is about to publish (issue
   * #1022). Must land before the body reaches the engine or regime-state.json
   * and before any ledger ownership is written, so every interruption after
   * this point resumes the SAME body instead of leaving ownership that no
   * body backs.
   * @param {string} tradeId
   * @param {Object} body - Complete body payload (deep-copied)
   * @returns {ManualTrade|null}
   */
  const recordBodyIntent = (tradeId, body) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    const prior = { bodyIntent: trade.bodyIntent, updatedAt: trade.updatedAt };
    const now = Date.now();
    trade.bodyIntent = {
      bodyId: body.id,
      body: JSON.parse(JSON.stringify(body)),
      phase: INTENT_PHASE.PENDING,
      createdAt: now,
      committedAt: null,
    };
    trade.updatedAt = now;

    try {
      persist();
    } catch (err) {
      // An intent that never reached disk must not linger in memory, where
      // the next request's recovery would publish a body with no durable
      // record behind it.
      Object.assign(trade, prior);
      throw err;
    }
    return trade;
  };

  /**
   * Drop a pending body intent whose publication was confirmed NOT to happen
   * (engine refused for a non-duplicate reason, no position state on disk), so
   * the next import starts clean. Never called on a thrown publication — that
   * outcome is unknown and must be resumed instead.
   * @param {string} tradeId
   * @returns {ManualTrade|null}
   */
  const discardBodyIntent = (tradeId) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.bodyIntent = null;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Mark a buy-first trade as having a TP body placed. This is the commit
   * point of a body intent (issue #1022): callers reach it only once the body
   * is durable (or proven retired), so it also seals the intent as committed.
   * @param {string} tradeId
   * @param {string} bodyId
   * @returns {ManualTrade|null}
   */
  const markTpPlaced = (tradeId, bodyId) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    const now = Date.now();
    trade.bodyId = bodyId;
    trade.status = STATUS.TP_PENDING;
    trade.bodyIntent = {
      bodyId,
      body: null,
      phase: INTENT_PHASE.COMMITTED,
      createdAt: trade.bodyIntent?.createdAt ?? now,
      committedAt: now,
    };
    trade.updatedAt = now;

    persist();
    return trade;
  };

  /**
   * Durably record a recovery buy about to be submitted (issue #1058). Must
   * land before placeLimitBuy is called: from then on the order may exist on
   * the exchange, and only this record lets a later request find it by client
   * order id instead of placing a second buy.
   * @param {string} tradeId
   * @param {{productId: string, size: number, price: number}} order
   * @returns {RecoveryIntent|null} The persisted intent
   */
  const recordRecoveryIntent = (tradeId, { productId, size, price }) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    const prior = { recoveryIntent: trade.recoveryIntent, recoveryIntentSeq: trade.recoveryIntentSeq, updatedAt: trade.updatedAt };
    const now = Date.now();
    const attempt = (trade.recoveryIntentSeq || 0) + 1;
    trade.recoveryIntentSeq = attempt;
    trade.recoveryIntent = {
      clientOrderId: recoveryClientOrderId(trade.id, attempt),
      attempt,
      productId,
      size,
      price,
      createdAt: now,
    };
    trade.updatedAt = now;

    try {
      persist();
    } catch (err) {
      // An intent that never reached disk must not be submitted: the order
      // would have no durable record to reconcile from.
      Object.assign(trade, prior);
      throw err;
    }
    return trade.recoveryIntent;
  };

  /**
   * Drop a recovery intent the exchange positively confirmed it never holds
   * (clean rejection, or a client-id lookup that found no order / a cancelled
   * one with no executions), so a new placement may proceed.
   * @param {string} tradeId
   * @param {string} [message] - Recorded as the trade's lastCheck when given
   * @returns {ManualTrade|null}
   */
  const releaseRecoveryIntent = (tradeId, message) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    const now = Date.now();
    trade.recoveryIntent = null;
    if (message) trade.lastCheck = { at: now, error: null, message };
    trade.updatedAt = now;

    persist();
    return trade;
  };

  /**
   * Record a recovery buy order (newly placed, or adopted by client order id)
   * as the trade's live attempt.
   * Also resolves the trade's recovery intent in the same write, so there is
   * no moment on disk where the order is neither intended nor recorded.
   * @param {string} tradeId - Manual trade ID
   * @param {string} buyOrderId - Exchange order ID
   * @param {number} buyPrice - Limit price
   * @param {number} buySize - BTC quantity
   * @returns {ManualTrade|null}
   */
  const recordRecoveryBuy = (tradeId, buyOrderId, buyPrice, buySize) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.recoveryIntent = null;
    const now = Date.now();
    normalizeRecoveryAttempts(trade);
    trade.recoveryAttempts.push(newAttempt({ orderId: buyOrderId, kind: 'placed', price: buyPrice, size: buySize, startedAt: now }));
    trade.buyOrderId = buyOrderId;
    trade.buyPrice = buyPrice;
    trade.buySize = buySize;
    trade.buyPlacedAt = now;
    trade.status = STATUS.BUY_PENDING;
    trade.lastCheck = null;
    trade.updatedAt = now;

    persist();
    return trade;
  };

  /**
   * Link an existing buy order (already placed on exchange) as the trade's
   * live attempt
   * @param {string} tradeId - Manual trade ID
   * @param {string} buyOrderId - Exchange order ID
   * @returns {ManualTrade|null}
   */
  const linkExistingBuy = (tradeId, buyOrderId) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    normalizeRecoveryAttempts(trade);
    trade.recoveryAttempts.push(newAttempt({ orderId: buyOrderId, kind: 'linked' }));
    trade.buyOrderId = buyOrderId;
    trade.status = STATUS.BUY_PENDING;
    trade.lastCheck = null;
    trade.updatedAt = Date.now();

    persist();
    return trade;
  };

  /**
   * Close the trade's live recovery attempt with the executions the exchange
   * confirmed for it, then settle the trade: COMPLETED once the caller says the
   * attempt covers the recovery or everything sold is recovered, otherwise
   * BUY_CANCELLED (recoverable).
   * The trade's buy totals always describe every attempt's executions together.
   * @param {string} tradeId - Manual trade ID
   * @param {Object} result
   * @param {'filled'|'cancelled'} result.outcome
   * @param {string} result.exchangeStatus - Status the exchange reported
   * @param {number} result.filledSize
   * @param {number} result.filledQuote
   * @param {string[]} result.fillTradeIds
   * @param {boolean} [result.completesRecovery] - The attempt covers the rest regardless of dust
   * @param {string} [result.message] - Recorded as the trade's lastCheck
   * @returns {ManualTrade|null}
   */
  const settleRecoveryAttempt = (tradeId, { outcome, exchangeStatus, filledSize, filledQuote, fillTradeIds, completesRecovery = false, message = '' }) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;
    normalizeRecoveryAttempts(trade);
    const attempt = trade.recoveryAttempts.find((a) => a.orderId === trade.buyOrderId && !a.outcome);
    if (!attempt) return null;

    const now = Date.now();
    Object.assign(attempt, { outcome, exchangeStatus, filledSize, filledQuote, fillTradeIds, endedAt: now });
    const recovered = getRecoveredTotals(trade);
    const complete = completesRecovery || getUncoveredSize(trade) === 0;

    trade.buyFillTradeIds = recovered.tradeIds;
    if (recovered.size > 0) {
      trade.buyPrice = recovered.quote / recovered.size;
      trade.buySize = recovered.size;
    }
    if (complete) trade.buyFilledAt = now;
    trade.status = complete ? STATUS.COMPLETED : STATUS.BUY_CANCELLED;
    trade.lastCheck = { at: now, error: null, message };
    trade.updatedAt = now;

    persist();
    return trade;
  };

  /**
   * Record the outcome of a status check or recovery operation that did not
   * change the trade's lifecycle, so the row can explain itself after a reload.
   * @param {string} tradeId
   * @param {{error?: string|null, message?: string}} check
   * @returns {ManualTrade|null}
   */
  const recordCheck = (tradeId, { error = null, message = '' }) => {
    const trade = trades.get(tradeId);
    if (!trade) return null;

    trade.lastCheck = { at: Date.now(), error, message };
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
   * Trades whose body creation was interrupted before it committed (#1022).
   * @returns {ManualTrade[]}
   */
  const getPendingBodyIntents = () => getAll().filter(t => t.bodyIntent?.phase === INTENT_PHASE.PENDING);

  /**
   * Trades with a recovery buy whose submission outcome is unrecorded (#1058).
   * @returns {ManualTrade[]}
   */
  const getPendingRecoveryIntents = () => getAll().filter(t => t.recoveryIntent);

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

  /**
   * Store-owned async serialization keyed by order. Every importer built over
   * this store shares the queue, so overlapping requests for one order run one
   * at a time (check -> placement -> association) while other orders proceed
   * independently. The lock is released in `finally` once `fn` settles; there
   * is deliberately no timeout, so it is never dropped while a submission is
   * still awaiting the exchange.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withOrderLock = (key, fn) => {
    const prev = orderLocks.get(key) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => {}, () => {});
    orderLocks.set(key, tail);
    tail.then(() => {
      if (orderLocks.get(key) === tail) orderLocks.delete(key);
    });
    return run;
  };

  /**
   * Serialize work for one sell (recovery-buy placement, issue #874).
   * @template T
   * @param {string} sellOrderId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withSellLock = (sellOrderId, fn) => withOrderLock(`sell:${sellOrderId}`, fn);

  /**
   * Serialize body creation/recovery for one buy (issue #1022), so concurrent
   * imports and retries resume one stable operation instead of racing to
   * create two bodies.
   * @template T
   * @param {string} buyOrderId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withBuyLock = (buyOrderId, fn) => withOrderLock(`buy:${buyOrderId}`, fn);

  return {
    load,
    persist,
    withSellLock,
    withBuyLock,
    addManualSell,
    addManualBuy,
    addPairedTrade,
    recordRecoveryIntent,
    releaseRecoveryIntent,
    recordRecoveryBuy,
    linkExistingBuy,
    settleRecoveryAttempt,
    recordCheck,
    markTpPlaced,
    recordBodyIntent,
    discardBodyIntent,
    refreshBuyTotals,
    dismiss,
    dismissFills,
    isFillDismissed,
    getAll,
    getPending,
    getPendingBodyIntents,
    getPendingRecoveryIntents,
    getById,
    getPendingBuyOrderIds,
  };
};

module.exports = { createManualTradeStore, STATUS, INTENT_PHASE, SIZE_EPSILON, getUncoveredSize, recoveryClientOrderId };
