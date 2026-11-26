// @ts-check

const { classifyBodyTpCancellation } = require('./cancellation-result');
const { fmtCurrency: fmtPrice, isFilledStatus, isTerminalStatus, isOrderStillOpen, sleep } = require('./shared-utils');
const { buildPartialFillData, isFullTpExecution } = require('./regime-pure-helpers');
const { planTerminalFillGap, buildSyntheticGapFill } = require('./regime-sell-booking');
const { FILL_RETRY_DELAY_MS } = require('./timing-constants');
const { createContextLogger } = require('./logger');

/**
 * Freeze a partial sell before changing its body. A cancel acknowledgement is
 * not terminal evidence: query status and cross-check the open-order snapshot.
 * Unknown outcomes retain the original identity for reconciliation/restart.
 */
const cancelPartialFillOrder = async (deps, orderId) => {
  const { adapter, exchange, pair, log = createContextLogger({ exchange, pair }).warn } = deps;
  let error;
  try {
    await adapter.cancelOrder(orderId);
  } catch (err) {
    error = err;
  }
  try {
    const order = await adapter.getOrder(orderId);
    if (isTerminalStatus(order)) {
      const openOrders = await adapter.getOpenOrders(pair);
      if (Array.isArray(openOrders) && !isOrderStillOpen(openOrders, orderId)) {
        return { cancelled: true, order };
      }
    }
  } catch (err) {
    error = err;
  }
  log(`⚠️ [${exchange}] Partial TP ${orderId} is not confirmed terminal — retaining tracking for reconciliation`,
    { orderId, orderType: 'body_tp' });
  return { cancelled: false, ...(error ? { error } : {}) };
};

/**
 * Gather and persist exchange evidence, then dispatch it to buy or sell
 * booking. All normal callers share the engine's backup fence and fill gate.
 * Nested sell booking during a TP cancel keeps the outer fill's admission.
 * Fill validation uses the constructor from the ledger's module instance.
 * @param {Object} deps
 */
const createFillHandler = ({
  exchange, productId, baseCurrency, fundLabel, logger, positionState, engineLocks,
  fillLedger, FillValidationError,
  getAdapter, getOrderExecutor, isBodyTpSellOrder, fencedWrite, saveLiveState,
  handleBuyOrderFill, handleSellOrderFill,
}) => {
  /**
   * Ingest an order's trade-level rows into the fill ledger (synchronous) and
   * return the rows this pass may book. Rows are batched (skipPersist) and
   * flushed once: a large order can carry 100+ execution rows, and a
   * full-ledger rewrite per row blocks the event loop for seconds. The flush
   * still lands before any booking; on a failure, rows ingested before the
   * failing one are flushed and the ingest error is rethrown.
   * @param {Object} fillData
   * @param {Array<Object>} rawFills
   * @param {number|null} orderPlacedAt
   * @returns {Array<Object>} Newly ingested, bookable rows
   */
  const ingestRawFillRows = (fillData, rawFills, orderPlacedAt) => {
    const ingestedFills = [];
    try {
      for (const fill of rawFills) {
        let result;
        try {
          result = fillLedger.ingestFill(fill, orderPlacedAt, { skipPersist: true });
        } catch (err) {
          if (!(err instanceof FillValidationError)) throw err;
          // Rejected before any ledger mutation. Skip it: the gap-fill fallback
          // below reconciles against the cumulative ledger total, so the missing
          // quantity is still handled without booking the malformed record.
          logger.error(`❌ [${exchange}] Rejected invalid fill for ${fillData.orderId}: ${err.message}`, {
            orderId: fillData.orderId, tradeId: err.tradeId, reason: err.reason,
          });
          continue;
        }
        // A real ID can replace terminal coverage and cross beyond it. The
        // ledger returns only still-unbooked covered rows plus the excess
        // tranche, so previously represented quantity never grows a body or
        // gets booked a second time.
        if (Array.isArray(result.bookableFills)) ingestedFills.push(...result.bookableFills);
        else if (result.fill && !result.identityReplacement) ingestedFills.push(result.fill);
      }
    } catch (err) {
      // Flush rows ingested before the failing one so they keep the durability
      // they had when every row persisted on its own. The ingest error stays
      // the root cause even if this flush fails too.
      try {
        fillLedger.persist();
      } catch (persistErr) {
        logger.error(`❌ [${exchange}] Ledger flush after failed ingest for ${fillData.orderId} also failed: ${persistErr.message}`, {
          orderId: fillData.orderId, error: persistErr.message,
        });
      }
      throw err;
    }
    fillLedger.persist();
    return ingestedFills;
  };

  /**
   * Ingest trade evidence and terminal coverage before booking an order fill.
   * Keep this synchronous: the cycle snapshot and ledger rows must reach the
   * buy/sell booking branch without introducing another scheduling boundary.
   * Steps: ingestRawFillRows, then planTerminalFillGap /
   * buildSyntheticGapFill for a terminal order the ledger still falls short of.
   */
  const ingestOrderFillEvidence = (fillData, rawFills) => {
    // Get order placement time for fill time tracking (entry orders only)
    // Use placedAt from fillData (polling callback) or fall back to order executor lookup
    const orderPlacedAt = fillData.side.toLowerCase() === 'buy'
      ? (fillData.placedAt || getOrderExecutor().getOrderPlacedAt(fillData.orderId))
      : null;

    // The live cycle these rows are stamped with — the buy branch compares it
    // at commit time to detect a cycle turnover mid-pass (issue #711).
    const ingestCycleId = fillLedger.getCurrentCycleId();

    // Ingest each fill and collect the normalized fills.
    const ingestedFills = ingestRawFillRows(fillData, rawFills, orderPlacedAt);

    // Use ingested fills (which have quoteAmount) for aggregation
    // Fall back to getting fills from ledger if all were duplicates
    let fillsToAggregate = ingestedFills.length > 0
      ? ingestedFills
      : fillLedger.getFillsForOrder(fillData.orderId);

    // Last resort: if the order's CUMULATIVE ledger total for this orderId
    // (everything ever ingested for it, including whatever the loop above
    // just added) still falls short of what order status says filled,
    // synthesize a fill for the GAP rather than the whole size. Deliberately
    // compares against the cumulative LEDGER total, not fillsToAggregate —
    // fillsToAggregate is this PASS's delta only (by design: an advancing
    // partial's ingestedFills naturally excludes already-ingested rows via
    // ingestFill's tradeId dedup), so comparing filledSize (a cumulative
    // order-status figure) against it would misfire on every ordinary
    // advancing partial, treating its by-design-partial "delta" as a false
    // shortfall. This covers two cases the same way: no prior fills at all
    // (ledgerTotal=0, gap=the full filledSize — the original Coinbase
    // eventual-consistency case this fallback was built for) AND an order a
    // body already partially owns from an earlier partial fill, whose
    // TERMINAL rescan then failed (ledgerTotal=the earlier partial only,
    // gap=the newly-filled remainder) — issue #679 follow-up: previously a
    // failed terminal rescan fell back to
    // the stale ledger-only total, and the buy booking's shouldSkipOwnedBuyRecommit then
    // retired the order as "already owned, nothing new" without ever
    // booking the remainder — the exchange's larger filledSize never
    // reached the position model.
    // Synthesize gaps only for TERMINAL fills. A still-live partial
    // (keepEntryTracked) must stay
    // retryable, never synthesized. Without this gate, an advancing
    // partial whose getOrderFills failed would synthesize uncertain execution.
    // Terminal coverage is provisional too: the ledger replaces equivalent
    // coverage when real trade IDs arrive, and refuses economic corrections
    // until they can be reconciled across the accounting stores (#807).
    const isTerminalFill = isTerminalStatus(fillData);
    // Status quote is cumulative, just like quantity and fees. The plan
    // prices only the unrecorded tranche from the quote left after earlier
    // executions; an explicitly supplied invalid value must not fall back to
    // an average (planTerminalFillGap).
    const gap = planTerminalFillGap({
      fillData,
      recordedSize: fillLedger.getRecordedSizeForOrder(fillData.orderId),
      loadExistingFills: () => fillLedger.getFillsForOrder(fillData.orderId),
      isTerminalFill,
    });
    if (gap) {
      const { ledgerTotalForOrder, fillGap, cumulativeQuote, recordedQuote, remainingQuote, gapPrice } = gap;
      if (!gap.valid) {
        throw Object.assign(
          new Error(`[${exchange}] Inconsistent cumulative execution value for terminal order ${fillData.orderId} — leaving fill gap retryable`),
          { incompleteFills: true }
        );
      }
      logger.warn(
        `⚠️ [${exchange}] Using order status data as fallback for ${fillData.orderId}: gap ${fillGap} of ${fillData.filledSize} @ ${fmtPrice(gapPrice)}`,
        {
          orderId: fillData.orderId,
          side: fillData.side,
          filledSize: fillData.filledSize,
          ledgerTotalForOrder,
          fillGap,
          averageFilledPrice: fillData.averageFilledPrice,
          cumulativeQuote,
          recordedQuote,
          remainingQuote,
          gapPrice,
        }
      );
      // fillData.totalFees is CUMULATIVE for the whole order (Coinbase's
      // getOrder() reports the running total, not a per-poll delta) — the
      // plan's feeDelta is that cumulative figure minus whatever fee prior
      // fills for this order already booked, never the whole cumulative
      // figure again (a prior version zeroed it whenever
      // ledgerTotalForOrder > 0, dropping the new tranche's fee to $0).
      // The synthetic row's tradeId is suffixed with the cumulative
      // filledSize so a later pass computing a DIFFERENT (larger) gap for
      // the same order ingests as a genuinely new row, not a duplicate.
      const syntheticFill = buildSyntheticGapFill({ fillData, gap, timestamp: Date.now() });
      // Ingest synthetic fill into ledger. result.fill is null when
      // ingestFill treats this exact tradeId as an already-seen duplicate
      // (e.g. a retry that re-computed the identical gap) — in that case
      // NOTHING new actually landed in the ledger this pass, so
      // fillsToAggregate/ingestedFills must NOT be credited with it either:
      // doing so (as an earlier round of this fix did, falling back to the
      // raw un-ingested syntheticFill object) let the body absorb the gap
      // every such pass while the ledger only ever recorded it once. When it
      // DOES ingest, combine it with this pass's newly ingested rows:
      // downstream "advancing partial" handling ADDS summary.totalSize
      // onto the EXISTING body's assetQty, mirroring the success path
      // where ingestedFills already contains only the NEW delta —
      // aggregating previously BOOKED rows too would double-count what
      // they contributed when first booked. (The buy branch still adds
      // rows that were never booked — collectBuyBookingBatch, #1021.) Also count it in
      // ingestedFills — feeds the bounded buy booking batch, so an order a
      // body already owns is not treated as "nothing new" when this gap
      // fill is exactly the new thing.
      const result = fillLedger.ingestFill(syntheticFill, orderPlacedAt);
      if (result.fill) {
        const bookable = Array.isArray(result.bookableFills) ? result.bookableFills : [result.fill];
        ingestedFills.push(...bookable);
        fillsToAggregate = ingestedFills;
      } else {
        logger.info(
          `ℹ️ [${exchange}] Gap fill for ${fillData.orderId} already ingested — nothing new to aggregate this pass`,
          { orderId: fillData.orderId, fillGap }
        );
      }
    }

    return { ingestCycleId, ingestedFills, fillsToAggregate, isTerminalFill };
  };

  /**
   * Freeze a partially-filled sell (cancel the remainder) and rebuild its fill
   * data from the final order status plus the trade-level fills. Throws when
   * the cancellation or the final fill set cannot be confirmed so the caller
   * retries reconciliation.
   * @param {Object} fillData - Partial sell fill data
   * @returns {Promise<Object>} Frozen fill data carrying confirmedFills
   */
  const freezePartialSellFill = async (fillData) => {
    const cancellation = await cancelPartialFillOrder({ adapter: getAdapter(), exchange, pair: productId }, fillData.orderId);
    if (!cancellation.cancelled) {
      throw new Error(`Partial TP ${fillData.orderId} cancellation unresolved; retry reconciliation`);
    }
    // The sell may have advanced or fully filled while cancellation was in flight.
    const knownFilledSize = fillData.filledSize || 0;
    fillData = buildPartialFillData(fillData.orderId, 'sell', cancellation.order, {
      isPartialFill: !isFilledStatus(cancellation.order),
      totalFees: cancellation.order.totalFees,
      source: fillData.source,
    });
    // Some exchanges omit cumulative filledSize on a CANCELLED status (the
    // executor then reports its polled high-water mark instead). Filled size
    // only grows, so never let the frozen status undercut a size the caller
    // already knew — the trade-level fill check below still has to match it.
    const statusOmittedSize = !(parseFloat(cancellation.order.filledSize) > 0);
    if (!(fillData.filledSize >= knownFilledSize)) fillData.filledSize = knownFilledSize;
    // Require the final fill set before accounting; never synthesize a stale
    // partial from the pre-cancel poll while the fills endpoint catches up.
    const finalFills = await getAdapter().getOrderFills(fillData.orderId);
    const finalSize = finalFills.reduce((sum, fill) => sum + Number(fill.size || 0), 0);
    // With no size on the status, the known size may be only the executor's
    // polled high-water mark, below the true final fill. The trade-level
    // fills are then the best evidence — accept them when they cover at
    // least what was known, or the size check below throws on every retry.
    if (statusOmittedSize && Number.isFinite(finalSize) && finalSize > 0 && finalSize >= knownFilledSize - 1e-8) {
      fillData.filledSize = finalSize;
    }
    if (!(fillData.filledSize > 0) || !Number.isFinite(finalSize) || Math.abs(finalSize - fillData.filledSize) > 1e-8) {
      throw new Error(`Partial TP ${fillData.orderId} final fills incomplete; retry reconciliation`);
    }
    fillData.confirmedFills = finalFills;
    // A body TP that executed its whole planned size is a completed TP,
    // not a partial, even when the exchange reports it CANCELLED (or still
    // OPEN with a sub-1% sliver, now frozen) and carries no
    // completionPercentage for isFilledStatus to read. Without this, the
    // reconcile / startup partial routes force the partial branch: the
    // designed holdback stays an active body and is re-listed for sale
    // (issue #744). Same classification as bookTpCancelExecution (#670).
    if (fillData.isPartialFill) {
      const tpBody = (positionState.celestialBodies || []).find(b => b.tpOrderId === fillData.orderId);
      if (isFullTpExecution(tpBody, fillData.filledSize)) fillData.isPartialFill = false;
    }
    return fillData;
  };

  /**
   * Fetch the trade-level fills for an order, retrying once after a short delay
   * when the first lookup is empty or throws. Never throws: an empty result lets
   * the caller fall back to order-status data.
   * @param {Object} fillData - Fill data from order status / polling
   * @returns {Promise<Array>} Raw fills (possibly empty)
   */
  const fetchRawFillsWithRetry = async (fillData) => {
    // getOrderFills now rejects (issue #679) instead of silently returning a
    // partial/empty set when the order-detail/status lookup fails or the
    // matched fills fall short of the exchange's own filled quantity. A
    // throw and an empty array both mean "we could not confirm the real
    // trade-level fills," so treat them the same: fall through to the
    // existing empty-rawFills retry, and ultimately the order-status
    // synthetic-fill fallback below (originally built for Coinbase's
    // empty-array eventual-consistency case) — that fallback is the
    // pre-existing safety net for exactly this situation, sourced from
    // fillData (order status, from a SEPARATE already-succeeded
    // adapter.getOrder call), never from the failed getOrderFills call.
    let rawFills;
    if (fillData.confirmedFills) {
      rawFills = fillData.confirmedFills;
    } else {
      try {
        rawFills = await getAdapter().getOrderFills(fillData.orderId);
      } catch (err) {
        logger.warn(
          `⚠️ [${exchange}] getOrderFills failed for ${fillData.orderId}: ${err.message} — will retry once, then fall back to order-status data if it still fails`,
          { orderId: fillData.orderId, side: fillData.side, error: err.message, incompleteFills: err.incompleteFills === true }
        );
        rawFills = [];
      }
    }

    // If getOrderFills returned empty (either because it legitimately found no
    // fills yet, or because it just threw above), but we have fill data from
    // order status (polling detection), retry once after a short delay -
    // Coinbase has eventual consistency, and Crypto.com/Gemini's own scan may
    // need a moment longer than getOrderFills' internal retry budget.
    if (rawFills.length === 0 && fillData.filledSize > 0) {
      logger.info(
        `⏳ [${exchange}] No fills yet for ${fillData.orderId}, retrying in 2s (status shows ${fillData.filledSize} filled)`,
        { orderId: fillData.orderId, side: fillData.side, filledSize: fillData.filledSize, retryDelayMs: FILL_RETRY_DELAY_MS }
      );
      await sleep(FILL_RETRY_DELAY_MS);
      try {
        rawFills = await getAdapter().getOrderFills(fillData.orderId);
      } catch (err) {
        logger.warn(
          `⚠️ [${exchange}] getOrderFills still failing for ${fillData.orderId} after the retry: ${err.message} — falling back to order-status data`,
          { orderId: fillData.orderId, side: fillData.side, error: err.message, incompleteFills: err.incompleteFills === true }
        );
        rawFills = [];
      }
    }
    return rawFills;
  };

  /**
   * Handle order fill
   * @param {Object} fillData - Fill data
   */
  const handleOrderFillImpl = async (fillData, dedupRef) => {
    // dedupRef is a per-call holder: the buy/sell branches record the inner
    // dedup key they add ({ set, key }) into it so the wrapper can clear that
    // key if processing throws. A per-call object (not a shared closure var)
    // keeps this correct even if two handleOrderFill calls interleave across
    // awaits (WS vs polling).
    // An open partial buy must remain in BOTH pending-order stores: the
    // executor map drives future polls and the position list survives restart.
    // CANCELLED-with-execution is terminal even when isPartialFill is true.
    const keepEntryTracked = fillData.isPartialFill
      && fillData.side?.toLowerCase() === 'buy' && !isTerminalStatus(fillData);
    // Snapshot the legacy core TP id BEFORE any await (issue #672): a
    // concurrent fill's resetCycle() nulls positionState.activeTpOrderId, and
    // the untracked-sell branch must still recognise this order as the
    // engine's own TP when deciding whether it may close the cycle.
    const entryCoreTpOrderId = positionState.activeTpOrderId;
    // Freeze a partially-filled sell before resizing — see cancelPartialFillOrder.
    if (fillData.isPartialFill && fillData.side?.toLowerCase() === 'sell') {
      fillData = await freezePartialSellFill(fillData);
    }

    const rawFills = await fetchRawFillsWithRetry(fillData);

    const { ingestCycleId, ingestedFills, isTerminalFill, fillsToAggregate: evidenceFills } =
      ingestOrderFillEvidence(fillData, rawFills);
    const fillsToAggregate = evidenceFills;

    // Determine if buy or sell
    if (fillData.side.toLowerCase() === 'buy') {
      return handleBuyOrderFill(fillData, dedupRef, keepEntryTracked, {
        ingestCycleId, ingestedFills, isTerminalFill, fillsToAggregate,
      });
    } else if (fillData.side.toLowerCase() === 'sell') {
      return handleSellOrderFill(fillData, dedupRef, keepEntryTracked, {
        ingestedFills, fillsToAggregate, entryCoreTpOrderId,
      });
    }

    if (!keepEntryTracked) getOrderExecutor().handleOrderFill(fillData.orderId);
  };

  /**
   * Wrapper around handleOrderFillImpl: if processing throws AFTER the inner
   * buy/sell dedup key was added (e.g. during TP placement or persistence),
   * clear that key so the next reconcile/poll retry re-processes the fill
   * instead of skipping it as "already processed" until the 5-min TTL. Applies
   * to ALL callers (WS, reconcile, polling) — the polling callback also clears
   * its own outer recentlyProcessedFills key (issue #99 follow-up).
   */
  const handleOrderFill = (fillData) => fencedWrite(`engine-booking:${fundLabel}`, async () => {
    const dedupRef = { set: null, key: null };
    try {
      // withFillGate increments the in-flight fill count (so dust consolidation
      // will not START a merge mid-fill) and waits out an already-running merge
      // (#196). Deadlock-free because withMergeLock never consults the fill gate.
      return await serializeBuyBooking(fillData, async () => {
        const result = await engineLocks.withFillGate(
          () => handleOrderFillImpl(fillData, dedupRef),
          { exchange, orderId: fillData.orderId }
        );
        // An open buy can have empty/lagging execution history. Book only
        // confirmed rows, then leave BOTH detection and booking retryable for
        // this same cumulative size. Clear the inner key before releasing the
        // per-order queue, so a queued WS/poll pass can book the missing rows.
        if (fillData.isPartialFill && fillData.side?.toLowerCase() === 'buy' && !isTerminalStatus(fillData)
          && fillLedger.getRecordedSizeForOrder(fillData.orderId) + 1e-9 < Number(fillData.filledSize)) {
          if (dedupRef.set) dedupRef.set.delete(dedupRef.key);
          return false;
        }
        return result;
      });
    } catch (err) {
      if (dedupRef.set) dedupRef.set.delete(dedupRef.key);
      throw err;
    }
  });

  /**
   * Run buy passes for one exchange order one at a time (issue #1021). A
   * buy pass books every still-unbooked row of its order, frozen before its
   * first await (the merge-target TP cancel); a second pass for the same
   * order starting inside that window would claim the same rows and book
   * them twice. Queued behind it instead, it sees them booked and takes only
   * what is still outstanding — including the batch of a pass that failed.
   * Sells and other orders are not queued. A buy pass never awaits another
   * buy pass of its own order, so the chain cannot deadlock.
   */
  const buyBookingQueues = new Map();
  const serializeBuyBooking = (fillData, run) => {
    const orderId = fillData?.orderId;
    if (!orderId || String(fillData.side).toLowerCase() !== 'buy') return run();
    const prior = buyBookingQueues.get(orderId) || Promise.resolve();
    const pass = prior.then(run);
    const settled = pass.then(() => {}, () => {});
    buyBookingQueues.set(orderId, settled);
    settled.then(() => {
      if (buyBookingQueues.get(orderId) === settled) buyBookingQueues.delete(orderId);
    });
    return pass;
  };

  /**
   * Cancel a body's TP so the caller can re-place it (operator TP edit,
   * reconcile stale-size, post-merge stale-size, startup reprice) — issue #670.
   *
   * A TP can sell a tranche WHILE it is being cancelled; cancelBodyTpOrder
   * still reports `cancelled: true` (with filledSize > 0) and has already
   * dropped all executor tracking for the order, so no poll will ever find
   * that sale. Re-placing for the full, un-reduced body would then list asset
   * the body no longer holds. classifyBodyTpCancellation tells the outcomes
   * apart:
   * - `cancelled`: clears the body's TP fields → returns 'cancelled' (the
   *   only outcome on which the caller re-places).
   * - `cancelled_with_execution`: books the sale immediately through the
   *   normal body-TP sell path — the body still carries `tpOrderId = oldTp`,
   *   so the sell handler finds it, records per-buy consumption, prorates
   *   qty/cost, credits capital, and re-places a right-sized TP itself (or
   *   closes the body on a full-size fill) → returns 'booked', or
   *   'booking_failed' if the booking threw. The caller must NOT re-place.
   * - `filled` / `unresolved`: leaves the TP untouched → returned as-is.
   *
   * Books through the handleOrderFill wrapper so an operator edit waits out
   * an in-flight merge like any other fill (none of the callers hold the
   * merge lock, so this cannot self-stall), and a failed booking releases its
   * dedup key. If booking fails, the body keeps `tpOrderId = oldTp` so the
   * reconcile loop re-discovers the CANCELLED order's partial and books it on
   * a later tick.
   * @param {Object} body - Celestial body whose TP is being replaced
   * @param {string} context - Log label for the calling path
   * @returns {Promise<'cancelled'|'booked'|'booking_failed'|'filled'|'unresolved'>}
   */
  const cancelBodyTpForReplace = async (body, context) => {
    const oldTp = body.tpOrderId;
    if (!oldTp) return 'cancelled';
    const cancelResult = await getOrderExecutor().cancelBodyTpOrder(body.id, oldTp);
    const outcome = classifyBodyTpCancellation(cancelResult);
    if (outcome === 'cancelled') {
      getOrderExecutor().removeBodyTracking(oldTp);
      body.tpOrderId = null;
      body.tpPrice = 0;
      body.assetOnOrder = 0;
      return 'cancelled';
    }
    if (outcome !== 'cancelled_with_execution') return outcome;

    logger.warn(
      `⚠️ [${exchange}] ${context}: body ${body.id.slice(-8)} TP ${oldTp.slice(0, 8)} sold ${cancelResult.filledSize} ${baseCurrency} during cancel — booking before re-place (#670)`,
      { bodyId: body.id, orderId: oldTp, filledSize: cancelResult.filledSize, context }
    );
    return bookTpCancelExecution(body, oldTp, cancelResult, context);
  };

  /**
   * The execution a failed cancel-for-replace booking recorded for this
   * body's current TP (see bookTpCancelExecution), when the exchange's
   * CANCELLED status does not report MORE than it — a status that omits the
   * size, or reports a smaller one, must not override what we already knew.
   * @param {Object} body
   * @param {Object|null} status - Exchange order status for body.tpOrderId
   * @returns {Object|null}
   */
  const knownTpCancelExecution = (body, status) => {
    const known = body.pendingTpCancelExecution;
    if (!known || !body.tpOrderId || known.orderId !== body.tpOrderId) return null;
    return (parseFloat(status?.filledSize) || 0) > known.filledSize ? null : known;
  };

  /**
   * Book a body TP's execution that was reported by a cancel (see
   * cancelBodyTpForReplace) through the normal body-TP sell path. The body
   * must still carry `tpOrderId = orderId`.
   *
   * On failure the known execution is kept on the body as
   * `pendingTpCancelExecution` (persisted with it), so the reconcile loop can
   * retry the booking even when the exchange's CANCELLED status omits the
   * filled size — otherwise it would read "cancelled, nothing filled", clear
   * the TP and re-place against the unreduced body, losing the sale.
   * @param {Object} body
   * @param {string} orderId - The cancelled TP
   * @param {{filledSize: number, filledValue?: number, averageFilledPrice?: number, totalFees?: number}} execution
   * @param {string} context - Log label
   * @param {{nested?: boolean}} [opts] - `nested: true` when the caller is
   *   itself running inside handleOrderFillImpl or a roll-up merge
   * @returns {Promise<'booked'|'booking_failed'>}
   */
  const bookTpCancelExecution = async (body, orderId, execution, context, { nested = false } = {}) => {
    // A TP that executed its whole planned size before the cancel landed
    // (the cancel-after-full-fill race) is a completed TP, not a partial:
    // route it as terminal so the sell handler closes the body and books its
    // designed holdback as reserves instead of re-listing that holdback. The
    // partial-fill flag would otherwise force the partial branch whenever the
    // exchange's status carries no completionPercentage.
    const executedFullTp = isFullTpExecution(body, execution.filledSize);
    const fillData = buildPartialFillData(orderId, 'sell', {
      status: executedFullTp ? 'FILLED' : 'CANCELLED',
      filledSize: execution.filledSize,
      filledValue: execution.filledValue,
      averageFilledPrice: execution.averageFilledPrice,
    }, { totalFees: execution.totalFees || 0, ...(executedFullTp && { isPartialFill: false }) });
    try {
      if (nested) {
        // Already inside a fill (fill gate held) or a roll-up (merge lock
        // held): the wrapper's fill gate would wait on that same merge hold
        // for its full window (see bookExecutionDuringCancel), so run the
        // handler directly and release its dedup key on failure ourselves,
        // exactly as the wrapper would.
        const dedupRef = { set: null, key: null };
        try {
          await handleOrderFillImpl(fillData, dedupRef);
        } catch (err) {
          if (dedupRef.set) dedupRef.set.delete(dedupRef.key);
          throw err;
        }
      } else {
        await handleOrderFill(fillData);
      }
    } catch (err) {
      body.pendingTpCancelExecution = {
        orderId,
        filledSize: execution.filledSize,
        filledValue: execution.filledValue || 0,
        averageFilledPrice: execution.averageFilledPrice || 0,
        totalFees: execution.totalFees || 0,
      };
      saveLiveState();
      logger.warn(
        `⚠️ [${exchange}] ${context}: failed to book body ${body.id.slice(-8)} TP ${orderId.slice(0, 8)} execution during cancel: ${err.message} — keeping TP identity for reconciliation`,
        { bodyId: body.id, orderId, error: err.message, context }
      );
      return 'booking_failed';
    }
    delete body.pendingTpCancelExecution;
    return 'booked';
  };

  return { handleOrderFill, handleOrderFillImpl, cancelBodyTpForReplace, knownTpCancelExecution, bookTpCancelExecution };
};

module.exports = { createFillHandler, cancelPartialFillOrder };
