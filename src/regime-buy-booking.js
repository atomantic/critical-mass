// @ts-check

const { classifyBodyTpCancellation } = require('./cancellation-result');
const { roundPrice } = require('./volatility-utils');
const { fmtCurrency: fmtPrice } = require('./shared-utils');
const { tradeEvents } = require('./trade-events');
const celestialHierarchy = require('./celestial-hierarchy');
const {
  boundRecoveredBuyRows, buildPartialFillData, collectBuyBookingBatch, isBuyAlreadyCommitted,
  isUnsettledBuyRow, makeFillDedupKey, shouldSkipOwnedBuyRecommit, snapshotBody,
} = require('./regime-pure-helpers');

/**
 * Book a batch of order executions into a new or existing body. The fill
 * handler serializes calls for the same buy order and owns dedup retry cleanup.
 * @param {Object} deps
 */
const createBuyBooking = ({
  exchange, baseCurrency, config, logger, positionState, positionSizer, fillLedger,
  recentlyProcessedBuyFills, pendingMergeTpOrders, completeMergeSnapshot,
  getAdapter, getOrderExecutor, getPriceIncrement, lookupOrNull, saveLiveState,
  handleOrderFill, cancelBodyTpForReplace, placeBodyTp, placeBodyTpWithRetry, calculateDynamicTpPercent,
}) => {
  /**
   * Drop a terminal order from the persisted pending-entry / ladder lists.
   * Shared by the normal commit path and the skip-recommit early return, which
   * would otherwise leave the entry (and its deployedInPosition share) behind.
   * @param {string} orderId
   * @returns {void}
   */
  const retireTrackedEntry = (orderId) => {
    let changed = false;
    if (positionState.pendingEntryOrders?.length > 0) {
      const before = positionState.pendingEntryOrders.length;
      positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(e => e.orderId !== orderId);
      changed = positionState.pendingEntryOrders.length !== before;
    }
    if (positionState.pendingLadderOrders?.length > 0) {
      const before = positionState.pendingLadderOrders.length;
      positionState.pendingLadderOrders = positionState.pendingLadderOrders.filter(o => o.orderId !== orderId);
      changed = changed || positionState.pendingLadderOrders.length !== before;
    }
    if (changed) saveLiveState();
  };

  /**
   * Record a buy-merge TP cancellation before any further asynchronous work.
   * A clean cancellation keeps the target; other outcomes route the buy to a
   * new body. An execution-bearing cancellation also returns
   * `execution.followUp`: 'book-execution' (book the sold tranche now),
   * 'rearm-target' (an in-flight fill already booked it; re-place the target's
   * TP) or null (no TP to act on). Keep those awaits in handleBuyOrderFill so a
   * clean cancel and its body/counter commitment remain one synchronous step.
   */
  const recordBuyMergeCancellation = (mergeTarget, cancelResult) => {
    const cancellationOutcome = classifyBodyTpCancellation(cancelResult);
    if (cancellationOutcome === 'filled' || cancellationOutcome === 'unresolved') {
      if (mergeTarget.tpOrderId) pendingMergeTpOrders.delete(mergeTarget.tpOrderId);
      logger.warn(`⚠️ [${exchange}] Body ${mergeTarget.id.slice(-8)} TP ${cancellationOutcome === 'filled' ? 'already filled' : 'cancel failed'}, redirecting buy to new body`);
      return { mergeTarget: null };
    }

    if (cancellationOutcome === 'cancelled_with_execution') {
      // Partial-during-cancel race (issue #227): the buy-fill pre-check saw the
      // target TP clean, but it partially filled WHILE we were cancelling.
      // safeCancelOrder now surfaces the sold quantity via filledSize, so we
      // react to it directly instead of folding the buy onto the target's
      // now-stale assetQty/costBasis (which still include the just-sold
      // tranche). Mirror the pre-check: route the buy to its own body and
      // clear the cancelled TP. The Race-3 snapshot below carries the sold
      // tranche to the merge-snapshot sell handler, which deducts it from the
      // target and re-places a correctly-sized TP.
      logger.warn(`⚠️ [${exchange}] Merge target ${mergeTarget.id.slice(-8)} TP filled ${cancelResult.filledSize} ${baseCurrency} during cancel — routing buy to its own body (issue #227)`);
      const soldTp = mergeTarget.tpOrderId;
      // A WS/poll fill for soldTp that landed while this cancel was in
      // flight is handled by the merge-snapshot branch, which consumes the
      // pending snapshot and deducts the tranche from mergeTarget (issue
      // #770). Everything that handler ingested for soldTp is booked, so
      // the immediate booking below must only run for execution beyond
      // it: re-booking the same cumulative size against a fresh snapshot
      // of the already-deducted body double-counts the sale whenever the
      // two deliveries' dedup keys differ (a terminal event keys on the
      // bare orderId, this booking on orderId:size).
      // "Booked" means the handler committed its booking: the per-order
      // bodyBookedSize marker (issue #777), written synchronously with
      // the body mutation — not merely that the snapshot left the map (a
      // handler that threw after consuming it booked nothing) nor that
      // the order carries a bodyPnl from some other booking. Execution
      // beyond the marker is booked below, and adds to it.
      const snapshotConsumed = !!soldTp && !pendingMergeTpOrders.has(soldTp);
      const committedBooking = snapshotConsumed ? fillLedger.getSellBooking(soldTp) : null;
      const alreadyBookedSize = committedBooking && committedBooking.hasMarker ? committedBooking.bookedSize : 0;
      const executionAlreadyBooked = snapshotConsumed
        && !((cancelResult.filledSize || 0) > alreadyBookedSize + 1e-9);
      if (executionAlreadyBooked) {
        logger.info(
          `ℹ️ [${exchange}] Merge target ${mergeTarget.id.slice(-8)} TP ${soldTp.slice(0, 8)} execution (${cancelResult.filledSize} ${baseCurrency}) was already booked by its in-flight fill — not re-booking (#770)`,
          { orderId: soldTp, filledSize: cancelResult.filledSize, alreadyBookedSize }
        );
      }
      // executionAlreadyBooked implies soldTp (the snapshot was consumed).
      const followUp = executionAlreadyBooked ? 'rearm-target' : soldTp ? 'book-execution' : null;
      if (followUp === 'book-execution') {
        completeMergeSnapshot(snapshotBody(mergeTarget));
      }
      // Clear the cancelled TP so no body references a dead order; the
      // merge-snapshot handler re-places a right-sized TP after deducting.
      mergeTarget.tpOrderId = null;
      mergeTarget.tpPrice = 0;
      mergeTarget.assetOnOrder = 0;
      saveLiveState();
      return { mergeTarget: null, execution: { soldTp, followUp } };
    }

    // Cancel succeeded — move to completed with TTL
    if (mergeTarget.tpOrderId) {
      completeMergeSnapshot(snapshotBody(mergeTarget));
    }
    // Clear body TP fields so placeBodyTp can re-place after merge
    // (cancelBodyTpOrder only removes executor tracking, not body state)
    mergeTarget.tpOrderId = null;
    mergeTarget.tpPrice = 0;
    mergeTarget.assetOnOrder = 0;
    // Persist before re-place: a crash between cancel and new TP would
    // otherwise resurrect the orphaned tpOrderId on restart.
    saveLiveState();
    return { mergeTarget };
  };

  /**
   * Capture one buy pass's booking inputs and return its synchronous, once-only
   * commit of entry tracking and live-cycle attribution after the body exists.
   * The order ownership and rows belong to this pass; the cycle is read when
   * committing. Do not await between body ownership and this commit (#131).
   *
   * @param {Object} booking
   * @param {Object} booking.fillData - Exchange order being booked
   * @param {Object} booking.entrySummary - Economics of this pass's booking rows
   * @param {Object[]} booking.bookingRows - Only the rows this pass books
   * @param {boolean} booking.orderWasOwned - Body ownership before merge awaits
   * @param {string|null} booking.ingestCycleId - Cycle at ingestion, for diagnostics
   * @returns {() => void} Idempotent within this pass; retry guards live in the caller
   */
  const createBuyAccountingCommit = ({ fillData, entrySummary, bookingRows, orderWasOwned, ingestCycleId }) => {
    let accountingCommitted = false;
    return () => {
      if (accountingCommitted) return;
      accountingCommitted = true;
      // Only a genuinely new buy order advances the cycle-buy count; an
      // advancing partial of an already-owned order refreshes entry tracking
      // without re-counting the order.
      if (!orderWasOwned) positionState.cycleBuys += 1;
      positionState.lastEntryPrice = entrySummary.avgPrice;
      positionState.lastEntryTime = Date.now();
      // Read the cycle at COMMIT, after any merge-cancel await: a concurrent
      // reset may have advanced it since ingestion (#711). Move every booked
      // row from outside that cycle, including null-tagged first-cycle rows
      // (#774) and rows recovered from an older failed attempt (#1021).
      const liveCycleId = fillLedger.getCurrentCycleId();
      if (liveCycleId && bookingRows.some(f => f.side === 'buy' && f.cycleId !== liveCycleId)) {
        // An advancing partial of an already-owned order skipped the
        // increment above (counted in the closed cycle); if the new cycle
        // has no row of it yet, this move makes it one of that cycle's buy
        // orders, so count it there too or the ledger and counter disagree.
        const liveHadOrder = fillLedger.getCurrentCycleFills()
          .some(f => f.side === 'buy' && f.orderId === fillData.orderId);
        let moved = 0;
        for (const f of bookingRows) {
          if (f.side === 'buy' && f.cycleId !== liveCycleId && f.tradeId) {
            fillLedger.updateFillCycleId(f.tradeId, liveCycleId);
            moved++;
          }
        }
        if (moved > 0 && orderWasOwned && !liveHadOrder) positionState.cycleBuys += 1;
        if (moved > 0) {
          logger.info(`🔀 [${exchange}] Buy ${fillData.orderId} booked into cycle ${liveCycleId} — moved ${moved} fill(s) from an earlier cycle (ingested under ${ingestCycleId})`, {
            orderId: fillData.orderId, ingestCycleId, toCycleId: liveCycleId, moved,
          });
        }
      }
    };
  };

  const updatePendingBuyTracking = (fillData, summary, keepEntryTracked, isLadderFill) => {
    // Remove filled entry from persisted pending orders — but ONLY once the
    // order is terminal. A PARTIAL buy fill leaves the order live on the book
    // with an unfilled remainder; dropping it here left the in-memory
    // pendingOrders map as the sole tracking, so a restart (or any path that
    // clears it) orphaned the remaining tranche forever. Gemini has no
    // order-events WS, so `checkPendingOrderFills` over that map is the ONLY
    // detector of the order completing — nothing re-derives it from the
    // exchange. That leaked 1.204 ETH of ETHUSD buys across 61 fills before
    // it was caught; see docs/fill-ledger-sell-linkage.md.
    //
    // A partial keeps the order tracked but must SHRINK it to the unfilled
    // remainder: apy-calculator sums pendingEntryOrders' sizeUsdc into
    // deployedInPosition alongside the bodies' costBasis, so leaving the
    // original full size there double-counts the tranche already committed to
    // a body and under-reports availableCapital until the remainder fills.
    const entryIsTerminal = !keepEntryTracked;
    // Shrink by exactly what this pass committed to a body: `summary` is the
    // booking batch — unbooked rows only, so a tranche an earlier pass
    // already shrank the entry for is never subtracted twice, and one an
    // earlier failed attempt left unbooked is subtracted now (#1021).
    const bookedSize = summary.totalSize;
    const bookedCost = summary.totalValue + summary.totalFees;
    const shrinkTracked = (orders) => orders.map(o => (o.orderId !== fillData.orderId ? o : {
      ...o,
      assetQty: Math.max(0, (o.assetQty || 0) - bookedSize),
      sizeUsdc: Math.max(0, (o.sizeUsdc || 0) - bookedCost),
    }));

    if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
      positionState.pendingEntryOrders = entryIsTerminal
        ? positionState.pendingEntryOrders.filter(e => e.orderId !== fillData.orderId)
        : shrinkTracked(positionState.pendingEntryOrders);
    }

    // Same rule for a ladder rung: a partially filled rung is still resting on
    // the book, so it stays tracked — at its remaining size.
    if (isLadderFill && positionState.pendingLadderOrders && positionState.pendingLadderOrders.length > 0) {
      positionState.pendingLadderOrders = entryIsTerminal
        ? positionState.pendingLadderOrders.filter(o => o.orderId !== fillData.orderId)
        : shrinkTracked(positionState.pendingLadderOrders);
    }
  };

  // Resolve bookable rows and register dedup before any body mutation or await.
  const resolveBuyBookingBatch = (fillData, {
    ingestedFills, isTerminalFill, keepEntryTracked, dedupRef, fillsToAggregate,
  }) => {
    // Nothing to book this pass — no new fills were ingested, nothing was
    // already in the ledger for this orderId to fall back on, AND gap
    // synthesis either didn't apply (gated to terminal fills only) or
    // found no gap. Falling through would aggregateFills([]) into a
    // ZERO-value summary and still commit a body off it below: assetQty/
    // costBasis 0, cycleBuys incremented, lastEntryPrice set to 0,
    // buy_filled emitted, and findMergeTarget free to cancel/re-place a
    // REAL body's TP against a phantom candidate price of 0. fillsToAggregate falls back to
    // getFillsForOrder(orderId) whenever nothing new was ingested, so an
    // empty result here also guarantees ledgerTotalForOrder was 0 —
    // i.e. this orderId owns no body yet, so bailing out cannot strand an
    // advancing partial or duplicate an already-committed buy (that case
    // is instead handled by shouldSkipOwnedBuyRecommit below, which only runs
    // once fillsToAggregate/summary are known non-degenerate).
    if (fillsToAggregate.length === 0) {
      if (isTerminalFill) {
        // A terminal order with genuinely no discoverable fills is an
        // anomaly, not a normal "still filling" state — throw so the
        // engine-level bounded retry (isTerminalStatus gate in
        // onFillDetected's catch) or the startup catch-up path re-arms
        // it, rather than silently committing nothing and losing the
        // fill.
        throw Object.assign(
          new Error(`[${exchange}] No fills available to book for terminal buy order ${fillData.orderId} (status shows ${fillData.filledSize} filled) — refusing to commit a zero-value body`),
          { incompleteFills: true }
        );
      }
      logger.info(
        `⏳ [${exchange}] No fills to aggregate yet for still-live buy ${fillData.orderId} (status shows ${fillData.filledSize} filled) — leaving retryable for the next poll/reconcile`,
        { orderId: fillData.orderId, filledSize: fillData.filledSize }
      );
      return { skip: 'no-fills' };
    }

    // Every row we hold for this order was already booked by a body that is
    // gone now (its TP sold it, or it was otherwise retired) while the entry
    // kept resting — and this pass brought nothing new. Falling through
    // would rebuild a body from those settled rows (the getFillsForOrder
    // fallback above) and list a TP for asset that was already sold. The
    // first poll after a restart lands here: the executor's partial-size
    // tracker starts at 0, so the order's unchanged filledSize reads as an
    // advance (issue #671).
    // Rows no body booked yet (if any) are still booked on their own. This
    // also recovers an excess row persisted before a prior body-booking
    // attempt failed, even when another tranche of the order already owns
    // a live body — and even when this pass ALSO brought new executions:
    // the batch is every unbooked row plus this pass's bookable rows, never
    // just this pass's delta, or a retry that arrives with a newer
    // execution books only that and strands the earlier tranche (#1021).
    // Frozen here, before any await; per-order serialization (the
    // handleOrderFill wrapper) keeps a second pass from claiming it too.
    const {
      batch: bookingBatch, withheldQty, shortfall: measuredShortfall,
    } = boundRecoveredBuyRows(
      collectBuyBookingBatch(fillLedger.getFillsForOrder(fillData.orderId), ingestedFills),
      ingestedFills, positionState.celestialBodies, fillData.orderId,
      fillLedger.getBuyOrderConsumption(fillData.orderId)
    );
    if (withheldQty > 0) {
      logger.warn(`⚠️ [${exchange}] Buy ${fillData.orderId}: ${withheldQty} ${baseCurrency} of earlier unannotated rows not recovered — its bodies' tranches do not confirm them missing (shortfall ${measuredShortfall ?? 'unmeasurable'}); booking only this pass's new fills`, {
        orderId: fillData.orderId, withheldQty, shortfall: measuredShortfall,
      });
    }
    if (bookingBatch.length === 0
      && !isBuyAlreadyCommitted(positionState.celestialBodies, fillData.orderId)) {
      logger.info(`⏭️ [${exchange}] Buy ${fillData.orderId} holds only tranches a retired body already settled and no new fills — nothing to book`);
      return { skip: 'settled' };
    }
    if (bookingBatch.length > 0) fillsToAggregate = bookingBatch;
    const hasBookableBuyFills = bookingBatch.length > 0;
    const bookedTradeIds = new Set(bookingBatch.map(f => f.tradeId));
    // Buy-fill dedup across WS vs polling. Without it, a buy detected by both
    // the polling path (which starts the multi-hundred-ms handleOrderFill
    // chain, incl. a possible 2s retry) and a late WS FILLED event for the
    // same order would run the buy branch twice — falling back to the full
    // getFillsForOrder set on the second pass and creating a duplicate body
    // at full size (cycleBuys double-incremented). Mirrors the sell dedup.
    // For partials, key on filled size so an advancing partial still processes.
    // A new real execution can arrive after terminal status already booked
    // synthetic coverage. Give that reconciliation a distinct key only
    // when the order's terminal key is already set. This avoids colliding
    // with a prior partial at the same cumulative size, while retaining the
    // order-level key that rejects an ordinary terminal replay. Unsettled
    // ledger rows keep the reconciliation key available on a retry after
    // ingestion succeeded but body booking failed.
    const terminalBuyKey = makeFillDedupKey(fillData.orderId, false, fillData.filledSize);
    const buyDedupKey = !keepEntryTracked && hasBookableBuyFills
      && recentlyProcessedBuyFills.has(terminalBuyKey)
      ? `${fillData.orderId}:terminal-reconcile:${(fillData.filledSize || 0).toFixed(8)}`
      : makeFillDedupKey(fillData.orderId, keepEntryTracked, fillData.filledSize);
    if (recentlyProcessedBuyFills.has(buyDedupKey)) {
      logger.info(`⏭️ [${exchange}] Buy fill already processed, skipping: ${buyDedupKey}`);
      return { skip: 'duplicate' };
    }
    recentlyProcessedBuyFills.add(buyDedupKey);
    if (dedupRef) { dedupRef.set = recentlyProcessedBuyFills; dedupRef.key = buyDedupKey; }

    // Idempotency guard against a RETRY that already committed this buy
    // (issue #131). The dedup key above is CLEARED when handleOrderFill throws
    // (so a transient failure on the early getOrderFills fetch can retry), but
    // cycleBuys++ and celestialBodies.push() below mutate in-memory state that
    // ingestFill's tradeId dedup does NOT protect. If a prior attempt threw
    // AFTER committing the body (e.g. placeBodyTp rejected), the next reconcile/
    // poll re-runs this branch and would double-count: a second cycleBuys and a
    // duplicate body for the same buyOrderId (→ duplicate TP).
    //
    // Gate on the bounded bookable batch, not new ingestion: persisted
    // unsettled rows can still need booking after a duplicate-only delivery.
    // collectBuyBookingBatch/boundRecoveredBuyRows exclude already-booked or
    // consumed quantities. Advancing and recovered tranches must process even
    // when a body owns the order, or its quantity / TP sizing loses the tranche.
    if (shouldSkipOwnedBuyRecommit({
      hasBookableRows: hasBookableBuyFills,
      bodies: positionState.celestialBodies,
      orderId: fillData.orderId,
    })) {
      logger.info(`⏭️ [${exchange}] Buy ${fillData.orderId} already owned by a body and no bookable rows remain — skipping re-commit (retry after partial failure); reconcile will repair any missing TP`);
      // The re-commit is what's redundant, not the bookkeeping. A TERMINAL
      // status can land here when the partial poll already ingested every fill
      // row the exchange had exposed, and returning outright would strand the
      // persisted pending-entry (and its share of deployedInPosition) until a
      // restart, even though the executor has already dropped the order.
      return { skip: 'recommit' };
    }

    return { batch: fillsToAggregate, bookedTradeIds, hasBookableBuyFills };
  };

  // The two arms have distinct synchronous prefixes: merges annotate before
  // promotion/sync; new bodies sync before annotation. Both commit accounting
  // before the first TP await, and merge size repair precedes notification.
  const commitBuyIntoBody = async ({
    newBuy, orderId, mergeTarget, summary, fillTypeLabel, isLadderFill,
    linkBookedBuyRows, commitBuyAccounting, finishBooking,
  }) => {
    const isMerge = Boolean(mergeTarget);
    let body;
    if (isMerge) {
      body = celestialHierarchy.mergeIntoBody(mergeTarget, newBuy, config.maxUsdcDeployed, undefined, logger);
      const idx = positionState.celestialBodies.findIndex(b => b.id === body.id);
      if (idx !== -1) positionState.celestialBodies[idx] = body;
    } else {
      body = celestialHierarchy.createNewBody(newBuy, orderId);
      positionState.celestialBodies = positionState.celestialBodies || [];
      positionState.celestialBodies.push(body);
    }
    const annotate = () => linkBookedBuyRows({ isBodyOwned: true, bodyId: body.id, bodyTier: body.tier });
    if (isMerge) {
      annotate();
      celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    } else {
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      annotate();
    }
    commitBuyAccounting();

    if (isMerge) {
      await placeBodyTpWithRetry(body, 'Merge');
      // Defense-in-depth: verify TP covers updated body size after merge
      if (body.tpOrderId && body.assetOnOrder > 0 && body.tpPrice > 0) {
        const tierCfgCheck = celestialHierarchy.getTierConfig(body.tier);
        const { sellQty } = positionSizer.calculateTakeProfitSize(
          body.assetQty, body.avgPrice, body.tpPrice, tierCfgCheck.holdbackScale
        );
        if (Math.abs(sellQty - body.assetOnOrder) > 0.00000001) {
          logger.warn(`⚠️ [${exchange}] Stale TP detected for body ${body.id.slice(-8)}: onOrder=${body.assetOnOrder}, expected=${sellQty} — cancelling for re-place`);
          if (await cancelBodyTpForReplace(body, 'Post-merge stale-size') === 'cancelled') {
            await placeBodyTp(body);
          }
        }
      }
    } else {
      const bodyTpPlaced = await placeBodyTp(body);
      if (!bodyTpPlaced) {
        logger.warn(`⚠️ [${exchange}] Body TP placement failed for ${body.id.slice(-8)}, body persists without TP`);
      }
    }

    const tierCfg = celestialHierarchy.getTierConfig(body.tier);
    if (isMerge) {
      logger.info(`${tierCfg.emoji} [${exchange}] ${fillTypeLabel}Buy merged into ${body.tier}: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, body=${body.id.slice(-8)} (${body.assetQty.toFixed(6)} ${baseCurrency}, avg=${fmtPrice(body.avgPrice)})`);
    } else {
      logger.info(`${tierCfg.emoji} [${exchange}] ${fillTypeLabel}Buy filled → created ${body.tier} body: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, body=${body.id.slice(-8)}`);
    }
    const bodyLabel = isMerge ? `merged→${body.tier}` : `new ${body.tier}`;
    tradeEvents.emitTradeEvent('buy_filled', exchange, `${fillTypeLabel}${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)} [${bodyLabel}]`, {
      assetAmount: summary.totalSize,
      price: summary.avgPrice,
      bodyId: body.id,
      bodyTier: body.tier,
      ...(isMerge ? { isMerge: true } : {}),
      isLadderFill,
    });
    // Finish tracking and persistence in this continuation, before resolving
    // the helper promise can yield to another order's booking/reset cycle.
    finishBooking();
  };

  // Prepare the booking inputs before any merge cancellation awaits.
  const prepareBuyBodyBooking = (fillData, fillsToAggregate, ingestCycleId) => {
    // Check if this is a ladder order fill (use positionState since polling may delete from pendingOrders before callback)
    const isLadderFill =
      (positionState.pendingLadderOrders &&
        positionState.pendingLadderOrders.some(o => o.orderId === fillData.orderId)) ||
      getOrderExecutor().isLadderOrder(fillData.orderId);

    const summary = fillLedger.aggregateFills(fillsToAggregate);

    // Was this exchange order ALREADY represented by a body before this pass?
    // An advancing partial (orderId already owned, new fills this pass) must
    // process its new tranche but must NOT consume a second cycleBuys step —
    // cycleBuys counts buy ORDERS filled in the cycle, and one order that
    // fills across multiple events is a single buy. A brand-new
    // order increments; an advancing partial only refreshes entry tracking.
    const orderAlreadyOwned = isBuyAlreadyCommitted(positionState.celestialBodies, fillData.orderId);

    // Prepare before merge awaits; commit only once the body owns the buy.
    const commitBuyAccounting = createBuyAccountingCommit({
      fillData,
      entrySummary: summary,
      bookingRows: fillsToAggregate,
      orderWasOwned: orderAlreadyOwned,
      ingestCycleId,
    });

    // Celestial hierarchy: create new buy descriptor
    const newBuy = {
      assetQty: summary.totalSize,
      costBasis: summary.totalValue + summary.totalFees,
      avgPrice: summary.avgPrice,
      buyOrderId: fillData.orderId,
    };

    // Calculate candidate TP price for merge proximity check
    const candidateTpPrice = roundPrice(summary.avgPrice * (1 + calculateDynamicTpPercent() / 100), getPriceIncrement());

    // Find merge target among existing celestial bodies
    const bodies = positionState.celestialBodies || [];
    const mergeTarget = celestialHierarchy.findMergeTarget(
      bodies, newBuy, {
        maxUsdcDeployed: config.maxUsdcDeployed,
        candidateTpPrice,
        maxBodies: config.maxCelestialBodies || 10,
        pendingOrderCount: getOrderExecutor().getPendingCounts().total,
        maxOpenOrders: config.maxOpenOrders,
        proximityScale: config.mergeProximityScale ?? 1.0
      }
    );

    return { summary, newBuy, mergeTarget, commitBuyAccounting, isLadderFill,
      fillTypeLabel: isLadderFill ? '[LADDER] ' : '' };
  };

  // This step retains each early return's executor acknowledgement behavior.
  const handleBuyOrderFill = async (fillData, dedupRef, keepEntryTracked, {
    ingestCycleId, ingestedFills, isTerminalFill, fillsToAggregate,
  }) => {
    const booking = resolveBuyBookingBatch(fillData, {
      ingestedFills, isTerminalFill, keepEntryTracked, dedupRef, fillsToAggregate,
    });
    if (booking.skip) {
      if (!keepEntryTracked && ['settled', 'recommit'].includes(booking.skip)) {
        retireTrackedEntry(fillData.orderId);
        getOrderExecutor().handleOrderFill(fillData.orderId);
      }
      return;
    }
    fillsToAggregate = booking.batch;
    const { bookedTradeIds } = booking;
    // Link only rows this pass committed (plus rows a body already owns, so
    // the order-level annotation stays uniform): a row of the order that is
    // still unbooked and outside the batch must stay recoverable.
    const linkBookedBuyRows = (metadata) => fillLedger.annotateFillsByOrderIds([fillData.orderId], metadata,
      { include: f => bookedTradeIds.has(f.tradeId) || !isUnsettledBuyRow(f) });

    const { summary, newBuy, commitBuyAccounting, isLadderFill, fillTypeLabel,
      mergeTarget: initialMergeTarget } = prepareBuyBodyBooking(fillData, fillsToAggregate, ingestCycleId);
    let mergeTarget = initialMergeTarget;

    // NOTE: cycleBuys / lastEntry* are committed AFTER the body is created or
    // merged below (issue #131). Incrementing here — before the merge-cancel
    // await (cancelBodyTpOrder) — meant a reject there left a stranded
    // cycleBuys++ with no body owning the orderId, which the
    // buyAlreadyCommitted guard above could not detect on retry, so the next
    // reconcile re-incremented. Deferring the counter to post-commit keeps the
    // increment and the body atomic with respect to a retry.

    // Partial-fill pre-check (mirror _mergeBodyImpl's guard, issue #201). If the
    // merge target's TP has ALREADY partially filled, merging would fold the new
    // buy onto the target's stale assetQty/costBasis (which still include the
    // sold tranche) — leaving the body claiming asset the account no longer
    // holds and double-attributing the sold tranche's cost. Don't merge; route
    // the buy to its own new body instead.
    if (mergeTarget && mergeTarget.tpOrderId) {
      const targetTpStatus = await lookupOrNull('getOrder', mergeTarget.tpOrderId, getAdapter().getOrder(mergeTarget.tpOrderId));
      if (targetTpStatus && targetTpStatus.filledSize > 0) {
        logger.warn(`⚠️ [${exchange}] Merge target ${mergeTarget.id.slice(-8)} TP partially filled (${targetTpStatus.filledSize} ${baseCurrency}) — routing buy to its own body (issue #201)`);
        mergeTarget = null;
      }
    }

    if (mergeTarget) {
      // Race 3: snapshot merge target before cancel in case TP fills in-flight
      if (mergeTarget.tpOrderId) {
        pendingMergeTpOrders.set(mergeTarget.tpOrderId, snapshotBody(mergeTarget));
      }
      const cancelResult = await getOrderExecutor().cancelBodyTpOrder(mergeTarget.id, mergeTarget.tpOrderId);
      const cancellation = recordBuyMergeCancellation(mergeTarget, cancelResult);
      if (cancellation.execution) {
        const { soldTp, followUp } = cancellation.execution;
        // cancelBodyTpOrder has just removed this order from ALL executor
        // tracking (pendingOrders included) — a future poll can no longer find
        // it to discover the fill, and if this WS connection happens to also
        // be degraded right now, nothing else will ever invoke the
        // merge-snapshot sell handler. We already have everything the
        // handler needs (cancelResult's fill details), so book it ourselves
        // immediately instead of hoping a WS event arrives (issue #227
        // follow-up). handleOrderFill's own dedup guard makes this safe even
        // if a WS/poll event for the same fill also arrives independently.
        if (followUp === 'book-execution') {
          await handleOrderFill(buildPartialFillData(soldTp, 'sell', {
            status: 'CANCELLED',
            filledSize: cancelResult.filledSize,
            filledValue: cancelResult.filledValue,
            averageFilledPrice: cancelResult.averageFilledPrice,
          }, { totalFees: cancelResult.totalFees || 0 })).catch((err) => {
            logger.warn(
              `⚠️ [${exchange}] Failed to book merge-target partial fill for ${soldTp.slice(0, 8)} immediately: ${err.message} — relying on a later WS/poll event`,
              { orderId: soldTp, error: err.message }
            );
          });
        } else if (followUp === 'rearm-target' && mergeTarget.assetQty > 0
          && (positionState.celestialBodies || []).includes(mergeTarget)) {
          // The in-flight fill's snapshot handler left the cancel and the
          // re-place to this continuation (it saw the body still pointing at
          // soldTp), and no booking will run to re-arm the deducted body.
          await placeBodyTp(mergeTarget);
        }
      }
      mergeTarget = cancellation.mergeTarget;
    }

    return commitBuyIntoBody({ newBuy, orderId: fillData.orderId, mergeTarget,
      summary, fillTypeLabel, isLadderFill, linkBookedBuyRows, commitBuyAccounting,
      finishBooking: () => {
        // Both body paths commit before TP placement; repeating the once-only
        // accounting commit here preserves the post-branch safety net.
        commitBuyAccounting();

        updatePendingBuyTracking(fillData, summary, keepEntryTracked, isLadderFill);

        // Ladder orders stay in place on individual fills (no reprice).
        // Rebuild happens only after cycle reset.

        // Persist state immediately after buy fill to prevent loss on crash
        saveLiveState();
        fillLedger.persist();

        if (!keepEntryTracked) getOrderExecutor().handleOrderFill(fillData.orderId);
      },
    });
  };

  return { handleBuyOrderFill };
};

module.exports = { createBuyBooking };
