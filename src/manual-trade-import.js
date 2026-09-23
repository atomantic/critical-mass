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
const { readBooleanFlag } = require('./shared-utils');

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
   * Idempotent by buyOrderId end-to-end (issue #691): a retry (IPC timeout,
   * or a thrown injectBody after the ledger/store writes) returns the
   * already-imported trade with `alreadyImported: true` instead of creating
   * a second body and placing a second live TP sell for the same fill.
   *
   * @param {Object} payload
   * @param {string} payload.buyOrderId
   * @param {string} [payload.note]
   * @param {boolean} [payload.createBody=true]
   */
  const importBuy = async (payload = {}) => {
    const { buyOrderId, note } = payload;
    if (!buyOrderId) return fail('buyOrderId is required');

    // Validate before the first ledger/store mutation (issue #423's ordering
    // contract, extended to this flag by issue #454): createBody selects
    // between ledger-only import and injecting/persisting a body that may
    // place a live TP order, so a non-boolean (e.g. the string "false") must
    // never reach that branch.
    const createBodyFlag = readBooleanFlag(payload, 'createBody', true);
    if (createBodyFlag.error) return fail(createBodyFlag.error);
    const createBody = createBodyFlag.value;

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

    // Retry guard (issue #691, mirrors importSell's #423 guard): addManualBuy
    // is idempotent at the STORE layer, but a retry that reaches this point
    // would still create and inject a SECOND body for the same fill, placing
    // a second live TP sell that eats into other bodies' inventory. A body
    // was already created for this trade iff bodyId is set (markTpPlaced
    // stamps it right after the first successful injectBody/persistBodyToDisk
    // below) or the status already advanced to TP_PENDING.
    if (trade.bodyId || trade.status === STATUS.TP_PENDING) {
      log.info(`ℹ️ 📦 [${exchange}] Manual buy import: buy ${buyOrderId} already has body ${trade.bodyId} — skipping duplicate body creation`, {
        bodyId: trade.bodyId,
        buyOrderId,
      });
      return ok({ trade: store.getById(trade.id), alreadyImported: true });
    }

    // Durable close-check (issue #691, codex review, refined across two
    // rounds). The in-memory duplicate check inside injectBody
    // (regime-engine.js) only sees bodies still in
    // positionState.celestialBodies — a body that fully closed (its TP
    // completely filled) is spliced out of that array, so it becomes
    // invisible to that check. The fill ledger doesn't lose the link, but it
    // must be read carefully:
    //   - `bodyId` is the precise signal. It is stamped ONLY by an actual
    //     body-creation flow — this function's own pre-injection annotation a
    //     few lines below, and placeBodyTp's TP-placement annotation — and,
    //     once set, is never cleared except by this function's own
    //     clearBodyAnnotation() rollback below on a confirmed non-duplicate
    //     failure. It survives the body's later removal from
    //     celestialBodies, and (for the engine-stopped path) it is persisted
    //     to the ledger BEFORE persistBodyToDisk ever runs, so it also
    //     catches a crash between persistBodyToDisk succeeding and
    //     store.markTpPlaced below ever running.
    //   - `sellOrderId` alone is NOT safe to key on: recalculateCycles'
    //     "auto-link buys to sells" step (fill-ledger.js) blanket-stamps
    //     sellOrderId onto EVERY buy in a cycle once that cycle crosses the
    //     50% sold heuristic (isCompletedCycle) — a display convenience for
    //     the aggregate cycle view, not proof this SPECIFIC buy's quantity
    //     was sold. Keying on it would false-positive and leave a genuinely
    //     unsold, unmanaged buy silently skipped.
    const alreadyOwningBodyId = fillLedger.getFillsForOrder(buyOrderId).find((r) => r.bodyId)?.bodyId;
    if (alreadyOwningBodyId) {
      // The ledger already knows about a body for this buy, but the trade
      // record might not (this is exactly the window this check exists to
      // cover — e.g. the first attempt's injectBody THREW rather than
      // returning normally, which skips markTpPlaced entirely without ever
      // reaching the confirmed-duplicate re-link above). Link the trade
      // record now so it doesn't sit at BUY_RECORDED/bodyId=null forever —
      // every future retry would otherwise keep re-detecting this same
      // ledger state without ever fixing it.
      store.markTpPlaced(trade.id, alreadyOwningBodyId);
      log.warn(`⚠️ [${exchange}] Manual buy import: buy ${buyOrderId} is already linked to body ${alreadyOwningBodyId} — refusing to create another body`, {
        buyOrderId,
        bodyId: alreadyOwningBodyId,
      });
      return ok({ trade: store.getById(trade.id), alreadyImported: true });
    }

    if (!createBody) return ok({ trade: store.getById(trade.id) });

    const totalFees = buyFills.reduce((sum, f) => sum + (f.commission || f.totalCommission || 0), 0);
    const body = createNewBody({
      assetQty: totalSize,
      costBasis: totalQuote + totalFees,
      avgPrice: avgBuyPrice,
    }, buyOrderId);

    fillLedger.annotateFillsByOrderId(buyOrderId, { bodyId: body.id, isBodyOwned: true, isSatellite: true, bodyTier: body.tier });
    fillLedger.persist();

    // The fill-ledger rows above are annotated optimistically, before we know
    // whether the body actually ends up tracked anywhere. If it doesn't
    // (engine-not-running race, no position state on disk), undo that
    // annotation — an untracked bodyId on the ledger is worse than none,
    // since it looks body-owned without a body anywhere to close it.
    const clearBodyAnnotation = () => {
      fillLedger.annotateFillsByOrderId(buyOrderId, { bodyId: null, isBodyOwned: false, isSatellite: false, bodyTier: null });
      fillLedger.persist();
    };

    if (injectBody) {
      const injectResult = await injectBody(body);
      // injectBody's own defense-in-depth (regime-engine.js) refuses a body
      // whose sourceOrderIds[0]/id already exists among the live bodies. That
      // is exactly the retry race this guard targets: an earlier call's
      // injectBody succeeded (pushed the real body, placed its TP) but this
      // trade never reached markTpPlaced below (e.g. a subsequent throw from
      // saveLiveState()), so the top-of-function guard didn't fire and we
      // just tried to inject a second, phantom body for the same fill. Never
      // point the trade/ledger at that phantom (it was refused — it does not
      // exist in the engine and will never get a TP) — re-point them at the
      // real body the engine already holds instead.
      if (injectResult && injectResult.success === false && injectResult.bodyId) {
        fillLedger.annotateFillsByOrderId(buyOrderId, { bodyId: injectResult.bodyId, isBodyOwned: true, isSatellite: true });
        fillLedger.persist();
        store.markTpPlaced(trade.id, injectResult.bodyId);
        log.warn(`⚠️ [${exchange}] Manual buy import: buy ${buyOrderId} injectBody refused a duplicate — re-linked to existing body ${injectResult.bodyId} instead of phantom ${body.id}`, {
          bodyId: injectResult.bodyId,
          phantomBodyId: body.id,
          buyOrderId,
        });
        return ok({ trade: store.getById(trade.id), alreadyImported: true });
      }
      // Any other failure (codex review: e.g. `{success:false, error:'Engine
      // not running'}` from a race with regime:start/stop) means the body was
      // NEVER pushed into the engine and has no live TP. Do not call
      // markTpPlaced here — doing so unconditionally (as before this fix)
      // marked the trade TP_PENDING against a phantom body that manages
      // nothing, and the new top-of-function retry guard would then
      // permanently short-circuit every future retry on that same
      // buyOrderId, orphaning the fill for good. Leave the trade at its
      // current (non-TP_PENDING) status and fail the call so the caller can,
      // and is expected to, retry.
      if (injectResult && injectResult.success === false) {
        clearBodyAnnotation();
        log.warn(`⚠️ [${exchange}] Manual buy import: injectBody failed for buy ${buyOrderId} (${injectResult.error || 'unknown error'}) — leaving the trade retryable`, {
          buyOrderId,
          error: injectResult.error,
        });
        return fail(`Failed to inject body: ${injectResult.error || 'unknown error'}`);
      }
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
      // No position state to persist into at all — the body was never saved
      // anywhere. Same reasoning as the injectBody failure above: don't mark
      // TP_PENDING against a body nothing is tracking, and don't trip the
      // top-of-function retry guard on the next attempt.
      clearBodyAnnotation();
      log.warn(`⚠️ [${exchange}] Manual buy import: no position state for body ${body.id} — leaving the trade retryable`, {
        bodyId: body.id,
        buyOrderId,
      });
      return fail(`Failed to persist body: no position state for ${exchange}/${pair}`);
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
