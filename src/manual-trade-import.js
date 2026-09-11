// @ts-check
/**
 * Manual Trade Import
 *
 * Operator-facing reconciliation of trades made outside the regime engine.
 * These are the only paths that write directly into the fill ledger (the
 * documented source of truth for realized P&L — see CLAUDE.md) and, on the
 * sell-first recovery path, place a live exchange order.
 *
 * Extracted from engines/coinbase-engine.js so the behavior is testable: the
 * engine module calls startup() and registers process signal handlers at module
 * scope, so it can never be require()d from a test. The engine keeps only the
 * IPC wiring that resolves the fund's adapter/ledger/store and delegates here.
 *
 * Ordering contract (issue #423) — both rules exist because the ledger is live
 * state that the running engine persists on its own schedule:
 *  1. Validate every input BEFORE the first ledger or store mutation, so a
 *     rejected request leaves no trace on disk.
 *  2. Fetch ALL fill sets before ingesting ANY of them, so a late failure can
 *     never leave unpaired buy rows behind. Per CLAUDE.md, a buy whose
 *     `sellOrderId` is absent counts toward `heldOpenBuyCostBasis` — orphan buy
 *     rows permanently inflate the dashboard's open-position figure and are not
 *     self-healing.
 */

const { createNewBody, syncPositionState } = require('./celestial-hierarchy');
const { loadRegimeState, saveRegimeState } = require('./state-tracker');
const { STATUS } = require('./manual-trades');

/** Logger used when a caller supplies none (tests, CLI paths). */
const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Ingest adapter fills into the fill ledger, accumulating totals.
 *
 * Manual-trade reconciliation fills can be days old, so `cycleId: null` keeps
 * them out of the live cycle (issue #108); `recalculateCycles`' orphan logic
 * places them in the correct cycle by buy/sell pattern. Persisting is left to
 * the caller so a multi-order import writes once, atomically.
 *
 * @param {Object} fillLedger - Fill ledger instance
 * @param {Object[]} fills - Raw adapter fills
 * @param {string} orderId - Exchange order id the fills belong to
 * @param {'buy'|'sell'} defaultSide - Side to use when a fill omits its own
 * @returns {{ tradeIds: string[], totalSize: number, totalQuote: number }}
 */
const ingestAdapterFills = (fillLedger, fills, orderId, defaultSide) => {
  const tradeIds = [];
  let totalSize = 0;
  let totalQuote = 0;
  for (const raw of fills) {
    tradeIds.push(raw.tradeId);
    totalSize += raw.size;
    totalQuote += raw.price * raw.size;
    fillLedger.ingestFill({
      tradeId: raw.tradeId,
      orderId,
      side: raw.side?.toLowerCase() || defaultSide,
      price: raw.price,
      size: raw.size,
      totalCommission: raw.totalCommission || raw.commission || 0,
      commission: raw.commission || 0,
      rebate: raw.rebate || 0,
      netFee: raw.netFee || raw.commission || 0,
      liquidityIndicator: raw.liquidityIndicator || 'TAKER',
      tradeTime: raw.tradeTime,
      fee_asset: 'USDC',
    }, null, { skipPersist: true, cycleId: null });
  }
  return { tradeIds, totalSize, totalQuote };
};

/** Volume-weighted average price, safe on an empty fill set. */
const averagePrice = (totalQuote, totalSize) => (totalSize > 0 ? totalQuote / totalSize : 0);

/** Milliseconds of the first fill, used as the leg's timestamp. */
const legTimestamp = (fills) => new Date(fills[0].tradeTime).getTime();

/**
 * Create the manual-trade importer for one fund.
 *
 * @param {Object} deps
 * @param {string} deps.exchange - Exchange name
 * @param {string} [deps.pair] - Resolved trading pair
 * @param {Object} deps.adapter - Exchange adapter (getOrderFills/getOrder/placeLimitBuy)
 * @param {Object} deps.fillLedger - Fill ledger for this fund (engine's own when running)
 * @param {Object} deps.store - Manual trade store for this fund
 * @param {Object} [deps.fundConfig] - Fund config, read for productId
 * @param {Object} [deps.logger] - Context logger
 * @param {((body: Object) => Promise<Object>)|null} [deps.injectBody] - Injects a
 *   new celestial body into the running engine; null when no engine is up, in
 *   which case the body is persisted to regime-state.json instead.
 * @returns {Object} importSell / importBuy / importPair / checkPendingBuy
 */
const createManualTradeImporter = ({
  exchange,
  pair,
  adapter,
  fillLedger,
  store,
  fundConfig,
  logger,
  injectBody = null,
}) => {
  const log = logger || NOOP_LOGGER;
  const ok = (extra) => ({ success: true, exchange, pair, ...extra });
  const fail = (error) => ({ success: false, error });

  /**
   * Fetch one order's fills, normalizing both failure modes to `{ error }`.
   * @returns {Promise<{ fills?: Object[], error?: string }>}
   */
  const fetchOrderFills = async (orderId, side) => {
    let fills;
    try {
      fills = await adapter.getOrderFills(orderId);
    } catch (err) {
      return { error: `Failed to fetch ${side} order fills: ${err.message}` };
    }
    if (!fills || fills.length === 0) return { error: `No fills found for ${side} order ${orderId}` };
    return { fills };
  };

  /**
   * Sell-first recovery import: record a manual sell and optionally place (or
   * link) the buy that recovers the sold asset.
   *
   * @param {Object} payload
   * @param {string} payload.sellOrderId
   * @param {string|number} [payload.recoveryBuyPrice] - Limit price for a new recovery buy
   * @param {string} [payload.existingBuyOrderId] - Already-placed buy to link instead
   * @param {string} [payload.note]
   */
  const importSell = async ({ sellOrderId, recoveryBuyPrice, existingBuyOrderId, note } = {}) => {
    if (!sellOrderId) return fail('sellOrderId is required');

    // Validate BEFORE touching the ledger or the store: the pre-extraction code
    // ingested fills and persisted the trade record first and only then parsed
    // the price, so a bad price reported failure over already-mutated disk state.
    const placingRecoveryBuy = Boolean(recoveryBuyPrice) && !existingBuyOrderId;
    const buyPrice = placingRecoveryBuy ? parseFloat(String(recoveryBuyPrice)) : 0;
    if (placingRecoveryBuy && (!Number.isFinite(buyPrice) || buyPrice <= 0)) {
      return fail('Invalid recoveryBuyPrice');
    }

    const { fills: sellFills, error } = await fetchOrderFills(sellOrderId, 'sell');
    if (error) return fail(error);

    const { tradeIds, totalSize, totalQuote } = ingestAdapterFills(fillLedger, sellFills, sellOrderId, 'sell');
    fillLedger.persist();

    // Idempotent by sellOrderId — a retry returns the existing record.
    const trade = store.addManualSell({
      sellOrderId,
      sellPrice: averagePrice(totalQuote, totalSize),
      sellSize: totalSize,
      sellQuoteAmount: totalQuote,
      sellTimestamp: legTimestamp(sellFills),
      sellFillTradeIds: tradeIds,
      note: note || '',
    });

    if (existingBuyOrderId) {
      store.linkExistingBuy(trade.id, existingBuyOrderId);
      log.info(`ℹ️ 📝 [${exchange}] Manual trade: linked existing buy order ${existingBuyOrderId}`, { orderId: existingBuyOrderId });
    } else if (placingRecoveryBuy && trade.buyOrderId) {
      // Operator retried an import whose recovery buy is already on the book.
      // Store idempotency alone does not stop a second placeLimitBuy here —
      // this guard is what prevents the duplicate live order.
      log.info(`ℹ️ 📝 [${exchange}] Manual trade: recovery buy ${trade.buyOrderId} already placed for sell ${sellOrderId} — skipping duplicate order`, { orderId: trade.buyOrderId, sellOrderId });
    } else if (placingRecoveryBuy) {
      const productId = fundConfig?.productId || 'BTC-USDC';
      const buySize = totalSize; // Recover exactly what was sold
      let result;
      try {
        result = await adapter.placeLimitBuy(productId, buySize, buyPrice, { postOnly: false });
      } catch (err) {
        return fail(`Failed to place recovery buy: ${err.message}`);
      }
      if (!result?.success) return fail(`Failed to place recovery buy: ${result?.errorMessage || 'unknown'}`);
      store.recordRecoveryBuy(trade.id, result.orderId, buyPrice, buySize);
      log.info(`ℹ️ 📝 [${exchange}] Manual trade: placed recovery buy ${buySize} @ $${buyPrice} (orderId=${result.orderId})`, { orderId: result.orderId, buySize, buyPrice });
    }

    return ok({ trade: store.getById(trade.id) });
  };

  /**
   * Poll a pending recovery buy and, once filled, pair it to its sell.
   * @param {Object} payload
   * @param {string} payload.tradeId
   */
  const checkPendingBuy = async ({ tradeId } = {}) => {
    if (!tradeId) return fail('tradeId is required');

    const trade = store.getById(tradeId);
    if (!trade) return fail(`Manual trade ${tradeId} not found`);
    if (trade.status !== STATUS.BUY_PENDING || !trade.buyOrderId) {
      return ok({ trade, message: 'No pending buy to check' });
    }

    let orderStatus;
    try {
      orderStatus = await adapter.getOrder(trade.buyOrderId);
    } catch (err) {
      return fail(`Failed to check buy order: ${err.message}`);
    }

    const normalizedStatus = (orderStatus?.status || '').toUpperCase();

    if (normalizedStatus === 'FILLED' || orderStatus?.completionPercentage >= 100) {
      let buyFills;
      try {
        buyFills = await adapter.getOrderFills(trade.buyOrderId);
      } catch (err) {
        return fail(`Buy order filled but failed to fetch fills: ${err.message}`);
      }
      if (!buyFills || buyFills.length === 0) {
        return fail(`Buy order filled but no fills found for order ${trade.buyOrderId}`);
      }

      const { tradeIds, totalSize, totalQuote } = ingestAdapterFills(fillLedger, buyFills, trade.buyOrderId, 'buy');
      // Pair the buy to its sell so it is not counted as an open position.
      fillLedger.annotateFillsByOrderId(trade.buyOrderId, { sellOrderId: trade.sellOrderId });
      fillLedger.persist();

      const avgBuyPrice = averagePrice(totalQuote, totalSize);
      store.markBuyFilled(tradeId, { buyPrice: avgBuyPrice, buySize: totalSize, buyFillTradeIds: tradeIds });

      log.info(`ℹ️ ✅ [${exchange}] Manual trade completed: sold ${trade.sellSize} @ $${trade.sellPrice.toFixed(2)}, bought back ${totalSize} @ $${avgBuyPrice.toFixed(2)}`, {
        tradeId,
        buyOrderId: trade.buyOrderId,
        sellOrderId: trade.sellOrderId,
        buySize: totalSize,
        buyPrice: avgBuyPrice,
      });
      return ok({ trade: store.getById(tradeId), filled: true });
    }

    if (normalizedStatus === 'CANCELLED') {
      return ok({ trade, cancelled: true, message: 'Buy order was cancelled on exchange' });
    }

    return ok({
      trade,
      orderStatus: normalizedStatus,
      filledPercent: orderStatus?.completionPercentage || 0,
      message: `Buy order is ${normalizedStatus}`,
    });
  };

  /**
   * Persist a freshly created body when no engine is running. The engine picks
   * it up on next start and places its take-profit order.
   * @returns {boolean} Whether the body reached disk
   */
  const persistBodyToDisk = (body) => {
    const saved = loadRegimeState(exchange, pair);
    if (!saved.position) return false;
    saved.position.celestialBodies = saved.position.celestialBodies || [];
    saved.position.celestialBodies.push(body);
    syncPositionState(saved.position, saved.position.celestialBodies);
    saveRegimeState(saved.position, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, pair);
    return true;
  };

  /**
   * Buy-first import: record a manual buy and, by default, turn it into a
   * celestial body so the engine places a take-profit against it.
   *
   * @param {Object} payload
   * @param {string} payload.buyOrderId
   * @param {string} [payload.note]
   * @param {boolean} [payload.createBody=true]
   */
  const importBuy = async ({ buyOrderId, note, createBody = true } = {}) => {
    if (!buyOrderId) return fail('buyOrderId is required');

    const { fills: buyFills, error } = await fetchOrderFills(buyOrderId, 'buy');
    if (error) return fail(error);

    const { tradeIds, totalSize, totalQuote } = ingestAdapterFills(fillLedger, buyFills, buyOrderId, 'buy');
    fillLedger.persist();

    const avgBuyPrice = averagePrice(totalQuote, totalSize);
    // Idempotent by buyOrderId — a retry returns the existing record.
    const trade = store.addManualBuy({
      buyOrderId,
      buyPrice: avgBuyPrice,
      buySize: totalSize,
      buyQuoteAmount: totalQuote,
      buyTimestamp: legTimestamp(buyFills),
      buyFillTradeIds: tradeIds,
      note: note || '',
    });

    if (!createBody) return ok({ trade: store.getById(trade.id) });

    const totalFees = buyFills.reduce((sum, f) => sum + (f.commission || f.totalCommission || 0), 0);
    const body = createNewBody({
      assetQty: totalSize,
      costBasis: totalQuote + totalFees,
      avgPrice: avgBuyPrice,
    }, buyOrderId);

    fillLedger.annotateFillsByOrderId(buyOrderId, { bodyId: body.id, isBodyOwned: true, isSatellite: true, bodyTier: body.tier });
    fillLedger.persist();

    if (injectBody) {
      const injectResult = await injectBody(body);
      log.info(`ℹ️ 📦 [${exchange}] Manual buy import: injected body ${body.id} into running engine (TP placed: ${injectResult?.tpPlaced})`, {
        bodyId: body.id,
        buyOrderId,
        tpPlaced: injectResult?.tpPlaced,
      });
    } else if (persistBodyToDisk(body)) {
      log.info(`ℹ️ 📦 [${exchange}] Manual buy import: saved body ${body.id} to disk (engine not running, TP will be placed on start)`, {
        bodyId: body.id,
        buyOrderId,
      });
    } else {
      log.warn(`⚠️ [${exchange}] Manual buy import: no position state for body ${body.id} — TP will not be placed`, {
        bodyId: body.id,
        buyOrderId,
      });
    }

    store.markTpPlaced(trade.id, body.id);
    return ok({ trade: store.getById(trade.id) });
  };

  /**
   * Paired import: a buy and its closing sell, both already filled.
   * @param {Object} payload
   * @param {string} payload.buyOrderId
   * @param {string} payload.sellOrderId
   * @param {string} [payload.note]
   */
  const importPair = async ({ buyOrderId, sellOrderId, note } = {}) => {
    if (!buyOrderId || !sellOrderId) return fail('Both buyOrderId and sellOrderId are required');

    // Fetch BOTH legs before ingesting EITHER. Ingesting the buy first left
    // unpaired buy rows in the live ledger whenever the sell fetch failed,
    // inflating heldOpenBuyCostBasis for a position that was already closed.
    const buy = await fetchOrderFills(buyOrderId, 'buy');
    if (buy.error) return fail(buy.error);
    const sell = await fetchOrderFills(sellOrderId, 'sell');
    if (sell.error) return fail(sell.error);

    const buyTotals = ingestAdapterFills(fillLedger, buy.fills, buyOrderId, 'buy');
    const sellTotals = ingestAdapterFills(fillLedger, sell.fills, sellOrderId, 'sell');

    // Link buy fills to their sell so the cycle is closed for P&L.
    fillLedger.annotateFillsByOrderId(buyOrderId, { sellOrderId });
    fillLedger.persist();

    const avgBuyPrice = averagePrice(buyTotals.totalQuote, buyTotals.totalSize);
    const avgSellPrice = averagePrice(sellTotals.totalQuote, sellTotals.totalSize);

    const trade = store.addPairedTrade(
      {
        buyOrderId,
        buyPrice: avgBuyPrice,
        buySize: buyTotals.totalSize,
        buyQuoteAmount: buyTotals.totalQuote,
        buyTimestamp: legTimestamp(buy.fills),
        buyFillTradeIds: buyTotals.tradeIds,
      },
      {
        sellOrderId,
        sellPrice: avgSellPrice,
        sellSize: sellTotals.totalSize,
        sellQuoteAmount: sellTotals.totalQuote,
        sellTimestamp: legTimestamp(sell.fills),
        sellFillTradeIds: sellTotals.tradeIds,
      },
      note,
    );

    // Both orders are now accounted for — drop them from the unaccounted view.
    store.dismissFills([buyOrderId, sellOrderId]);

    log.info(`ℹ️ 📝 [${exchange}] Manual paired import: buy ${buyTotals.totalSize} @ $${avgBuyPrice.toFixed(2)} + sell ${sellTotals.totalSize} @ $${avgSellPrice.toFixed(2)}`, {
      buyOrderId,
      sellOrderId,
      buySize: buyTotals.totalSize,
      sellSize: sellTotals.totalSize,
    });

    return ok({ trade: store.getById(trade.id) });
  };

  return { importSell, importBuy, importPair, checkPendingBuy };
};

module.exports = { createManualTradeImporter };
