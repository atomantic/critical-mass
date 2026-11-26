// @ts-check

const { updateRegimeConfig } = require('./config-utils');
const { classifyBodyTpCancellation } = require('./cancellation-result');
const { roundAsset, roundUSDC } = require('./volatility-utils');
const { fmtCurrency: fmtPrice } = require('./shared-utils');
const { tradeEvents } = require('./trade-events');
const celestialHierarchy = require('./celestial-hierarchy');
const { makeFillDedupKey } = require('./regime-pure-helpers');
const {
  classifyTpFill, planBodyTpBooking, planPartialBodyRemainder, collectBodyLinkedBuyOrderIds,
  buildBodyTpClosedTrade, isMergedSnapshotClosed, planLiveMergedDeduction, planClosedSnapshotDetach,
  buildMergedSnapshotSellBooking, isSellBookedAsBody, isOwnLegacyCoreTp, untrackedSellRejectReason,
  planCoreTpClose, collectCoreCycleBuyOrderIds, buildCoreTpClosedTrade,
} = require('./regime-sell-booking');

/**
 * Settle sell fills for one fund. The caller has ingested exchange evidence
 * and holds the fill gate. Keep the ledger and capital commits synchronous
 * before TP replacement or cycle-reset awaits can interleave with another fill.
 * @param {Object} deps
 */
const createSellFillBooking = ({
  exchange, pair, productId, baseCurrency, config, logger, callbacks,
  positionState, fillLedger, closedTrades,
  recentlyProcessedSellFills, pendingMergeTpOrders, completedMergeTpOrders, dustWaitLoggedQty,
  getOrderExecutor, isBodyTpSellOrder, bookTpCancelExecution, placeBodyTp,
  recordCycleForOptimizer, recordCycleForSizeOptimizer, resaveAfterSizeOptimizerLive,
  resetCycle, saveLiveState, getState,
}) => {
  /**
   * Identity fields for a closed trade, derived from the SELL's own fills.
   *
   * Every closedTrades.record() site must spread this instead of stamping
   * ad hoc. Reading live engine state at record time is wrong twice over:
   * resetCycle() advances the cycle counter BEFORE the trade is recorded
   * (filing it under a later cycle), and the offline-fill paths book a fill
   * that may have happened days earlier (dating it to engine-restart time).
   * The 612c14ce incident hit both — a cycle-18 sell written as cycle-21.
   * Live values remain as fallbacks only for a summary with no usable fills.
   *
   * `recordedAt` is deliberately NOT included: it means "when the engine
   * booked this", so Date.now() is correct for it.
   *
   * @param {{cycleId: string|null, lastTimestamp: number}} summary - aggregateFills result for the sell
   * @returns {{timestamp: number, cycleId: string|null}}
   */
  const sellTradeStamp = (summary) => ({
    timestamp: summary.lastTimestamp || Date.now(),
    cycleId: summary.cycleId ?? fillLedger.getCurrentCycleId(),
  });

  /**
   * Apply capital growth idempotently per sell order (issue #210-B). The credit
   * is a non-idempotent config.json write; claiming the credit in the fill
   * ledger (persisted before this write) makes a crash-replay of the same
   * sellOrderId a no-op instead of a double-apply that inflates the budget cap.
   * The claim is keyed per booked amount (issue #777): a second booking of
   * the same sell order for execution the first never covered is credited
   * too, while a replay of an already-credited booking is not.
   * @param {string} sellOrderId
   * @param {number} pnl
   * @param {{bookedSize: number, replay: boolean}} [booking] - From
   *   planSellBooking: the order's cumulative booked size once this booking
   *   commits, and whether the pass re-aggregates the whole order (a replay
   *   refuses on any prior credit)
   * @returns {number} maxUsdcDeployed BEFORE this credit (unchanged when already credited)
   */
  const creditCapitalGrowth = (sellOrderId, pnl, booking) => {
    const prevMaxUsdc = config.maxUsdcDeployed;
    if (!fillLedger.claimCapitalCredit(sellOrderId, booking?.bookedSize, { replay: !!booking?.replay })) {
      logger.info(
        `ℹ️ [${exchange}] Capital growth for ${sellOrderId?.slice(0, 8)} already credited — skipping re-apply (crash-replay idempotency #210-B)`,
        { orderId: sellOrderId }
      );
      return prevMaxUsdc;
    }
    config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
    updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });
    return prevMaxUsdc;
  };

  /**
   * How a body-TP sell booking lands on the fill ledger (issue #777). The
   * per-order annotations (bodyPnl, holdback, reserves sold, consumedBy, the
   * capital credit) are read once per orderId, so a SECOND booking of an
   * order that already committed one — a partial then its remainder, or a
   * cancel-race execution beyond what an in-flight fill booked (#227/#770) —
   * must add to it. It does only when this pass aggregated rows it just
   * ingested: those rows cannot be part of the committed booking. A pass that
   * ingested nothing re-aggregates every row of the order (a crash replay),
   * so it replaces, exactly as before.
   * @param {string} orderId - Sell order id
   * @param {number} soldSize - Base quantity this booking sold
   * @param {boolean} rowsAreNew - The booking aggregates only newly ingested rows
   * @returns {{additive: boolean, replay: boolean, bookedSize: number}}
   *   bookedSize is the order's cumulative booked size once this booking
   *   commits; `replay` marks a pass that re-aggregated the whole order
   */
  const planSellBooking = (orderId, soldSize, rowsAreNew) => {
    const prior = rowsAreNew ? fillLedger.getSellBooking(orderId) : null;
    return {
      additive: !!prior,
      replay: !rowsAreNew,
      bookedSize: roundAsset((prior ? prior.bookedSize : 0) + (Number(soldSize) || 0)),
    };
  };

  /**
   * What a PRE-#607 buy order had already lost before its first consumption
   * record: everything the ledger bought on it that no live tranche still
   * holds open. Only the tranches of the body being sold are in the plan, but
   * an order filled in advancing partials can be split across bodies, one of
   * them closed long ago under sellOrderId closure — seeding from this body
   * alone would read that sold part as open forever. Orders whose every
   * tranche was created under #607 (finite `consumedQty`) are not seeded this
   * way: for them, ledger quantity no tranche holds is genuinely unsold and
   * must stay visible.
   *
   * For pre-#607 orders this is deliberately the conservative reading: the
   * ledger cannot tell a tranche another body sold from one no body ever
   * attributed (the leaked 1.14 ETH), so both keep their legacy "closed"
   * status. Resurrecting the second kind would double count inventory the
   * operator already adopted into a body (scripts/adopt-untracked-asset.js,
   * which is how that gap is repaired), and resurrecting the first would leave
   * a permanent phantom. The exchange-balance coverage check still sees it.
   * @param {{orders: Map<string, Object>, entries: Array<{entry: Object}>}} plan
   * @param {(orderId: string) => (Object|null)} consumptionOf - Cached getBuyOrderConsumption
   * @param {(entry: Object) => number} legacyFraction
   * @returns {Map<string, number>} orderId → seed, only for legacy orders
   */
  const legacyConsumptionSeeds = (plan, consumptionOf, legacyFraction) => {
    const seeds = new Map();
    const tranchesByOrder = new Map();
    const seen = new Set();
    const addTranche = (entry) => {
      if (!entry || seen.has(entry) || !plan.orders.has(entry.orderId)) return;
      seen.add(entry);
      if (!tranchesByOrder.has(entry.orderId)) tranchesByOrder.set(entry.orderId, []);
      tranchesByOrder.get(entry.orderId).push(entry);
    };
    for (const { entry } of plan.entries) addTranche(entry);
    for (const body of (positionState.celestialBodies || [])) {
      for (const entry of (body.buyOrders || [])) addTranche(entry);
    }
    for (const [orderId, tranches] of tranchesByOrder) {
      const ledger = consumptionOf(orderId);
      if (!ledger || ledger.consumedBy) continue;
      if (tranches.every(t => Number.isFinite(t.consumedQty))) continue;
      const openAll = tranches.reduce((sum, t) => {
        const size = Number(t.assetQty) || 0;
        const prior = Number.isFinite(t.consumedQty) ? t.consumedQty : size * legacyFraction(t);
        return sum + Math.max(0, size - prior);
      }, 0);
      seeds.set(orderId, Math.max(0, ledger.size - openAll));
    }
    return seeds;
  };

  /**
   * Record on the fill ledger which buy orders a body sale consumed, and how
   * much of each (issue #607). This is what lets computeRealizedFromCyclePairs
   * hold the unsold remainder of a partly-sold buy order open instead of
   * reading `sellOrderId` as "fully closed". The consumption is spread over
   * the body's tranches (`body.buyOrders`) by celestialHierarchy.planBodyConsumption,
   * and each tranche's `consumedQty` is advanced to match.
   *
   * Call BEFORE the body's assetQty/costBasis are reduced for this sale.
   * @param {Object} args
   * @param {Array} args.entries - The tranches the sold TP covered (body.buyOrders)
   * @param {number} args.bodyQty - Body assetQty before this sale
   * @param {number} args.qty - Base quantity consumed: sold + booked holdback
   * @param {boolean} args.closesBody - The sale closed the TP's body: every
   *   tranche it covered is consumed in full
   * @param {string} args.sellOrderId
   * @param {string} args.bodyId - For logging
   * @param {boolean} [args.additive] - A second booking of the same sell
   *   order (issue #777): add to its consumption instead of replacing it
   * @returns {void} Buys with no open tranche stay on legacy sellOrderId /
   *   consumedCostFraction closure.
   */
  const recordBodyConsumption = ({ entries, bodyQty, qty, closesBody, sellOrderId, bodyId, additive = false }) => {
    // getBuyOrderConsumption scans the whole ledger; a collapsed body can hold
    // hundreds of tranches, so look each order up once per sale.
    const consumptionCache = new Map();
    const consumptionOf = (orderId) => {
      if (!consumptionCache.has(orderId)) consumptionCache.set(orderId, fillLedger.getBuyOrderConsumption(orderId));
      return consumptionCache.get(orderId);
    };
    const legacyFraction = (entry) => consumptionOf(entry.orderId)?.consumedCostFraction ?? 0;
    const plan = celestialHierarchy.planBodyConsumption(entries, bodyQty, qty, legacyFraction, { closesBody });
    if (plan) {
      // Before the tranches advance: the seeds read their pre-sale state.
      const legacySeeds = legacyConsumptionSeeds(plan, consumptionOf, legacyFraction);
      for (const { entry, next } of plan.entries) entry.consumedQty = roundAsset(next);
      for (const [orderId, { delta, prior }] of plan.orders) {
        if (delta > 0) fillLedger.recordBuyConsumption(orderId, sellOrderId, delta, legacySeeds.get(orderId) ?? prior, { additive });
      }
    }
    const coverage = plan ? plan.coverage : 0;
    if (coverage < 0.99) {
      logger.warn(
        `⚠️ [${exchange}] Body ${String(bodyId).slice(-8)} tranches account for ${(coverage * 100).toFixed(1)}% of its ${roundAsset(bodyQty)} ${baseCurrency} — the rest of sale ${String(sellOrderId).slice(0, 8)} is not recorded per buy order (legacy closure)`,
        { bodyId, sellOrderId, bodyQty, qty, coverage, tranches: (entries || []).length }
      );
    }
  };

  /**
   * Compose a body sale's consumed-cost ratio into each source buy's OWN
   * consumedCostFraction (issue #704) — the legacy fallback for buys a sale
   * cannot record per order. Stamping one body-level scalar on every buy
   * retroactively charged a buy folded in after an earlier partial sale with
   * that sale's consumption.
   *
   * Skips every buy the per-order model tracks: one with a consumedBy record
   * (the fraction is ignored for it) or a tranche with a `consumedQty` (it
   * would seed that tranche's first record, charging it twice — and a fold-in
   * a merge-snapshot TP never covered must not be charged at all).
   * @param {Object} body - Body whose source buys to annotate
   * @param {number} ratio - Fraction of the pool's remaining cost this sale removed
   */
  const stampConsumedCostFraction = (body, ratio) => {
    const tracked = new Set((body.buyOrders || [])
      .filter(e => e && e.orderId && (Number(e.assetQty) || 0) > 0 && Number.isFinite(e.consumedQty))
      .map(e => e.orderId));
    for (const srcId of new Set([
      ...(body.sourceOrderIds || []),
      ...((body.buyOrders || []).map(b => b.orderId)),
    ])) {
      if (!srcId || srcId === 'core-migration' || tracked.has(srcId)) continue;
      const prior = fillLedger.getBuyOrderConsumption(srcId);
      if (!prior || prior.consumedBy) continue;
      fillLedger.annotateFillsByOrderId(srcId, {
        consumedCostFraction: 1 - (1 - (prior.consumedCostFraction ?? 0)) * (1 - ratio),
      });
    }
  };

  /**
   * Synchronous financial settlement of a TP fill against a merge snapshot:
   * classifies the sale, deducts the sold tranche from the live merged body,
   * credits capital, records the per-buy consumption and commits the sell
   * booking. Adds no await: the in-memory booking marker it writes must be
   * visible before the caller's stale-TP cancel / re-place awaits (issue #777).
   * The decisions and amounts come from the pure planners in
   * regime-sell-booking (classifyTpFill, isMergedSnapshotClosed,
   * planLiveMergedDeduction, planClosedSnapshotDetach,
   * buildMergedSnapshotSellBooking); this function applies them in order.
   * @param {Object} args
   * @param {Object} args.fillData - Fill data
   * @param {Object} args.summary - Aggregated fill summary
   * @param {Object} args.booking - Planned sell booking
   * @param {Object} args.mergeSnapshot - Snapshot of the body before merge/cancel
   * @param {Array<string>} args.bookedTradeIds - Trade IDs of booked fills
   * @returns {{tierCfg: Object, pnl: number, holdbackAsset: number, reservesSoldAsset: number, liveOwnsRemainder: boolean, liveMerged: Object|undefined, snapshotClosed: boolean, prevMaxUsdc: number}}
   */
  const commitMergedSnapshotSell = ({ fillData, summary, booking, mergeSnapshot, bookedTradeIds }) => {
    const tierCfg = celestialHierarchy.getTierConfig(mergeSnapshot.tier);
    // Detect a TRUE partial fill of the snapshot's own TP — NOT "does the
    // live body still hold asset" (a healthy 100%-of-assetOnOrder fill
    // ALWAYS leaves designed holdback behind, per the holdback-vs-partial
    // distinction this codebase treats as load-bearing: summary.totalSize
    // === body.assetQty is never true on a healthy fill). Same classifier
    // and whole-inventory rule (issue #770) as the normal path, using
    // mergeSnapshot.assetOnOrder — the frozen size the cancelled/fired TP
    // was actually placed for (snapshotted before assetOnOrder is cleared
    // to 0 on cancel, both in the buy-merge race above and in
    // bookExecutionDuringCancel's roll-up snapshots). Deliberately does
    // NOT pass `fillData.isPartialFill`: every caller that reaches this
    // branch via buildPartialFillData (the #227/#368 immediate
    // self-booking paths) hardcodes that flag to `true` regardless of
    // whether the fill was actually partial, so it is not a usable signal
    // here (unlike the normal path's other callers).
    const fill = classifyTpFill({ body: mergeSnapshot, summary });
    const { proratedCostBasis, pnl, holdbackAsset, reservesSoldAsset } = fill;
    const isPartialSnapshotFill = fill.isPartial;

    // Deduct the sold tranche from the LIVE merged body (issue #201). If a buy
    // folded onto this body in the Race-3 window (between the partial-fill
    // pre-check and the TP cancel), the merged body still contains the qty/cost
    // this snapshot sell just realized. Without deducting, the body claims asset
    // the account no longer holds and the sold tranche's cost is double-counted
    // (once here via bodyPnl, once retained in the merged body's costBasis).
    const liveMerged = (positionState.celestialBodies || []).find(b => b.id === mergeSnapshot.id);
    // The body is still OPEN only when `liveMerged` exists AND this was a
    // true partial fill of its TP — a healthy complete-of-assetOnOrder
    // fill closes the cycle (reserves booked, bodiesCompleted counted)
    // exactly like the normal path, even though this branch never splices
    // the now-empty-of-obligation body out of celestialBodies (issue
    // #617/#669).
    const liveOwnsRemainder = !!liveMerged && isPartialSnapshotFill;

    const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
    if (!liveOwnsRemainder) cs.bodiesCompleted += 1;
    positionState.celestialState = cs;

    const prevMaxUsdc = creditCapitalGrowth(fillData.orderId, pnl, booking);

    getOrderExecutor().removeBodyTracking(fillData.orderId);

    // Record the consumption against the tranches the SNAPSHOT covered —
    // its buyOrders array is copied when the snapshot is taken, so a buy
    // folded onto the live body in the Race-3 window is not charged for a
    // TP it was never part of. The tranche objects themselves are shared
    // with the live body, which is what advances its consumedQty.
    //
    // Consume exactly what leaves a body. A true partial with the live body
    // still present consumes only the sold qty (the block below deducts
    // nothing else), so held cost keeps matching the bodies. A complete
    // fill closes the snapshot body even though its live object remains:
    // sold + booked holdback, every tranche it covered in full — and the
    // block below removes the same whole snapshot from the live body, so
    // the holdback is not also left in it as inventory (issue #718).
    // With no live body, the snapshot body closed only if no other body
    // holds its tranches (issue #607): a roll-up moves the snapshot's
    // tranche objects into the surviving target, so "the snapshot body's
    // id is gone" does not mean its asset left the model — a late fill of
    // the source's old TP (the completedMergeTpOrders window) must not
    // close tranches a live body still carries.
    const snapshotTranches = new Set(mergeSnapshot.buyOrders || []);
    const snapshotClosed = isMergedSnapshotClosed({
      snapshotTranches, bodies: positionState.celestialBodies, liveMerged, liveOwnsRemainder,
    });
    recordBodyConsumption({
      entries: mergeSnapshot.buyOrders,
      bodyQty: mergeSnapshot.assetQty,
      // A closing sale consumes exactly the snapshot's own quantity; any
      // excess came out of reserves (issue #770).
      qty: snapshotClosed ? mergeSnapshot.assetQty : summary.totalSize,
      closesBody: snapshotClosed,
      sellOrderId: fillData.orderId,
      bodyId: mergeSnapshot.id,
      additive: booking.additive,
    });

    if (liveMerged) {
      // consumedCostFraction must reflect what FRACTION OF THE DOLLAR COST
      // this sale actually removed from the live pool — NOT a quantity
      // ratio. `proratedCostBasis` (below) is priced off the frozen
      // `mergeSnapshot.costBasis`, so when a buy folded onto this SAME live
      // body in the Race-3 window at a DIFFERENT price than the original
      // body's avg price (the fold-in is part of liveMerged's pool and its
      // sourceOrderIds, which this stamps), a quantity-based ratio
      // (sold-size / live-qty) diverges from the dollar fraction actually
      // deducted, and Σ buy.cost*(1-consumedCostFraction) would no longer
      // reconcile to liveMerged.costBasis. Pricing the ratio directly off
      // the dollar amount removed (proratedCostBasis / pre-deduction
      // liveMerged.costBasis) makes that reconciliation exact by
      // construction, regardless of the fold-in's price.
      //
      // What leaves the live pool depends on whether the snapshot body
      // closed. A true partial removes only the sold tranche at its
      // prorated cost. A complete fill removes the WHOLE snapshot — sold
      // qty plus the designed holdback just booked as zero-cost reserves,
      // at its full cost — exactly as the normal path splices a filled
      // body out entirely. Deducting only the sold qty there left the
      // holdback in the live body as well as in reserves, so it was
      // counted twice and re-listed for sale (issue #718). Only a fold-in
      // the snapshot's TP never covered stays behind. A sale beyond the
      // snapshot's own quantity drew the excess from reserves
      // (bodyReservesSoldAsset, issue #770), so it must not ALSO come out
      // of the fold-in.
      const deduction = planLiveMergedDeduction({ liveMerged, mergeSnapshot, summary, proratedCostBasis, snapshotClosed });
      const { liveConsumedRatio } = deduction;

      liveMerged.assetQty = deduction.assetQty;
      liveMerged.costBasis = deduction.costBasis;

      // Track the cumulative fraction of the body's ORIGINAL cost basis
      // already realized via partial sells (mirrors the normal partial-fill
      // path's planPartialBodyRemainder). Without this, heldOpenBuyCostBasis
      // counts the full buy cost as still-open while the sold tranche's
      // prorated cost is simultaneously realized via bodyPnl above —
      // double-counting it.
      liveMerged.consumedCostFraction = deduction.consumedCostFraction;
      if (snapshotClosed) {
        // The closed snapshot's tranches (consumed in full above) leave
        // the live body with its asset, so its next TP neither re-links
        // them nor spreads a later sale over them. Link them to THIS sell
        // like the normal full-fill path does: a TP re-placed on the live
        // body after the snapshot re-stamped them with an order this
        // branch cancels, which would leave an untracked buy held open
        // with no body to re-link it. The untouched fold-in pool must not
        // be charged this sale's cost fraction.
        const detach = planClosedSnapshotDetach({ liveMerged, mergeSnapshot, snapshotTranches });
        liveMerged.buyOrders = detach.buyOrders;
        liveMerged.sourceOrderIds = detach.sourceOrderIds;
        const { closedOnlyIds } = detach;
        if (closedOnlyIds.length > 0) {
          fillLedger.annotateFillsByOrderIds(closedOnlyIds, { sellOrderId: fillData.orderId });
        }
        liveMerged.avgPrice = liveMerged.assetQty > 0 ? liveMerged.costBasis / liveMerged.assetQty : 0;
      } else {
        // Legacy fallback for buys the sale could not record per order. A
        // tracked buy ignores this fraction — and a tracked fold-in the
        // snapshot's TP never covered must not be charged it at all.
        stampConsumedCostFraction(liveMerged, liveConsumedRatio);
      }
    }

    // Commit the booking the moment the body mutation above is done —
    // synchronously with it, before any await below (issue #777). The
    // per-order bodyBookedSize this writes is the booking-commit marker
    // the buy-merge #227 continuation reads to decide what an in-flight
    // fill already booked: written any later, a throw in the stale-TP
    // cancel / re-place below would leave a deducted body with no marker,
    // and the continuation would book the same sale on top of it.
    fillLedger.commitSellBooking(fillData.orderId,
      buildMergedSnapshotSellBooking({ mergeSnapshot, summary, fill, liveOwnsRemainder }),
      { additive: booking.additive, soldSize: summary.totalSize, bookedTradeIds });

    return { tierCfg, pnl, holdbackAsset, reservesSoldAsset, liveOwnsRemainder, liveMerged, snapshotClosed, prevMaxUsdc };
  };

  /**
   * Process a TP fill against a merge snapshot (body was removed/merged while its TP was in flight).
   * Deducts the sold tranche from the live merged body if present, commits the sell booking,
   * handles stale TP cancellation/replacement on the surviving body, and records events.
   * @param {Object} args
   * @param {Object} args.fillData - Fill data
   * @param {Object} args.summary - Aggregated fill summary
   * @param {Object} args.booking - Planned sell booking
   * @param {Object} args.mergeSnapshot - Snapshot of the body before merge/cancel
   * @param {Array<string>} args.bookedTradeIds - Trade IDs of booked fills
   */
  const handleMergedSnapshotTpFill = async ({ fillData, summary, booking, mergeSnapshot, bookedTradeIds }) => {
    // Process fill using snapshot data — body was already merged/removed
    pendingMergeTpOrders.delete(fillData.orderId);
    completedMergeTpOrders.delete(fillData.orderId);

    const {
      tierCfg, pnl, holdbackAsset, reservesSoldAsset, liveOwnsRemainder, liveMerged, snapshotClosed, prevMaxUsdc,
    } = commitMergedSnapshotSell({ fillData, summary, booking, mergeSnapshot, bookedTradeIds });

    if (liveMerged) {
      if (liveMerged.tpOrderId && liveMerged.tpOrderId === fillData.orderId) {
        // The body still points at the snapshotted order itself: this
        // fill landed while a buy-merge / roll-up cancel of that same
        // order is still in flight (issue #744). Its execution is the one
        // THIS handler is booking, and the merge continuation owns the
        // cancel and the re-place — cancelling, booking or re-placing here
        // would double-book the sale or leave a second TP live next to
        // the one the continuation places. Only a body this sale drained
        // drops the identity (nothing left to re-arm), so it is removed
        // below and reconcile can never re-book the order against it.
        if (snapshotClosed && !(liveMerged.assetQty > 0)) {
          liveMerged.tpOrderId = null;
          liveMerged.tpPrice = 0;
          liveMerged.assetOnOrder = 0;
          if (getOrderExecutor().removeBodyTracking) getOrderExecutor().removeBodyTracking(fillData.orderId);
        }
      } else if (liveMerged.tpOrderId) {
        // The resting TP was sized for the pre-deduction (oversized) qty — cancel
        // and clear it so a correctly-sized TP is re-placed for the remaining body.
        const staleTp = liveMerged.tpOrderId;
        let cancelResult;
        try {
          cancelResult = await getOrderExecutor().cancelBodyTpOrder(liveMerged.id, staleTp);
        } catch (err) {
          logger.error(
            `❌ [${exchange}] Failed to cancel merge-snapshot body TP ${staleTp}: ${err.message} — keeping the existing TP identity and skipping replacement`,
            { bodyId: liveMerged.id, orderId: staleTp, cancellationOutcome: 'rejected', error: err.message }
          );
        }

        const staleOutcome = cancelResult ? classifyBodyTpCancellation(cancelResult) : null;
        if (staleOutcome === 'cancelled') {
          liveMerged.tpOrderId = null;
          liveMerged.tpPrice = 0;
          liveMerged.assetOnOrder = 0;
          if (getOrderExecutor().removeBodyTracking) getOrderExecutor().removeBodyTracking(staleTp);
        } else if (staleOutcome === 'cancelled_with_execution') {
          // The stale TP sold a tranche while we cancelled it, and
          // cancelBodyTpOrder has already dropped its executor tracking —
          // no poll will ever find that sale (issue #744, the #670 class).
          // Book it now through the normal body-TP sell path: liveMerged
          // still carries tpOrderId = staleTp, so that path deducts the
          // tranche from the (already snapshot-deducted) live body, records
          // its consumption, and re-places a right-sized TP — or closes the
          // body on a full-size fill. Nested: we are already inside a fill
          // or a roll-up, so the fill gate must not be re-entered. On a
          // booking failure the body keeps tpOrderId = staleTp plus the
          // pendingTpCancelExecution marker, and reconcile retries it.
          logger.warn(
            `⚠️ [${exchange}] Merge-snapshot: body ${liveMerged.id.slice(-8)} TP ${staleTp.slice(0, 8)} sold ${cancelResult.filledSize} ${baseCurrency} during its stale-size cancel — booking before re-place (#744)`,
            { bodyId: liveMerged.id, orderId: staleTp, filledSize: cancelResult.filledSize }
          );
          // The stale TP was sized for the PRE-deduction body, so its
          // assetOnOrder can exceed what the live body still holds. Cap it
          // at the body before booking: the sell handler classifies
          // full-vs-partial against assetOnOrder, and a sale covering the
          // whole remaining body must close it — as a partial it would
          // drive assetQty negative.
          if (liveMerged.assetOnOrder > liveMerged.assetQty) liveMerged.assetOnOrder = liveMerged.assetQty;
          await bookTpCancelExecution(liveMerged, staleTp, cancelResult, 'Merge-snapshot stale-size', { nested: true });
        } else if (cancelResult) {
          logger.error(
            `❌ [${exchange}] Merge-snapshot body TP cancellation was not confirmed for ${staleTp} — keeping the existing TP identity and skipping replacement`,
            {
              bodyId: liveMerged.id,
              orderId: staleTp,
              cancellationOutcome: 'unconfirmed',
              cancelled: false,
              filled: Boolean(cancelResult.filled),
              filledSize: cancelResult.filledSize || 0,
            }
          );
        }
      }
    }

    // A closed snapshot with no fold-in drains the live body to zero: drop
    // it like the normal full-fill path does rather than leave an empty
    // body that never re-arms (issue #718). No cycle reset here: a body
    // drains to zero only when its TP executed during a merge cancel, and
    // that caller is either a buy-merge about to create the buy's own body
    // or a roll-up whose other body remains. A TP whose cancel was not
    // confirmed keeps the body so reconciliation can still find that order.
    if (liveMerged && snapshotClosed && !(liveMerged.assetQty > 0) && !liveMerged.tpOrderId) {
      // In place: the buy-merge caller still holds this array.
      const drainedIdx = positionState.celestialBodies.indexOf(liveMerged);
      if (drainedIdx !== -1) {
        positionState.celestialBodies.splice(drainedIdx, 1);
        dustWaitLoggedQty.delete(liveMerged.id);
      }
    }

    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

    // Re-place a correctly-sized TP on the deducted body (issue #201) —
    // unless booking its stale TP's cancel-race execution just closed and
    // removed it (issue #744): a detached body must not list a TP.
    if (liveMerged && liveMerged.assetQty > 0 && !liveMerged.tpOrderId
      && (positionState.celestialBodies || []).includes(liveMerged)) {
      await placeBodyTp(liveMerged);
    }

    logger.info(`${tierCfg.emoji} [${exchange}] Merge-snapshot TP filled (${mergeSnapshot.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

    tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)} [merge-snapshot]`, {
      assetAmount: summary.totalSize,
      price: summary.avgPrice,
      pnl,
      holdbackAsset: liveOwnsRemainder ? 0 : holdbackAsset,
      ...(!liveOwnsRemainder && reservesSoldAsset > 0 && { reservesSoldAsset }),
      bodyId: mergeSnapshot.id,
      bodyTier: mergeSnapshot.tier,
      mergeSnapshot: true,
      ...(liveOwnsRemainder && { isPartialFill: true, remainingAsset: liveMerged.assetQty }),
    });

    saveLiveState();
    fillLedger.persist();
    getOrderExecutor().handleOrderFill(fillData.orderId);
  };

  /**
   * Apply a TRUE partial body TP fill (synchronous; the caller re-places the
   * TP afterwards): reduce the body to its remainder, keep it active, and drop
   * the filled TP's tracking so the remainder is re-listed at its own size.
   * Runs after the sale's consumption and booking are committed.
   * @param {Object} args
   * @param {Object} args.fillData
   * @param {Object} args.summary
   * @param {Object} args.body - The live body (mutated)
   * @param {ReturnType<typeof classifyTpFill>} args.fill
   * @param {Object} args.tierCfg
   * @param {number} args.prevMaxUsdc - maxUsdcDeployed before this sale's credit
   */
  const applyPartialBodyTpFill = ({ fillData, summary, body, fill, tierCfg, prevMaxUsdc }) => {
    const { soldRatio, pnl } = fill;
    // PARTIAL FILL: reduce body size, keep body active, re-place TP for remaining
    // The cumulative fraction of the body's ORIGINAL cost basis realized via
    // partial sells (issue #128) — see planPartialBodyRemainder. Annotating
    // the source buys with it lets computeRealizedFromCyclePairs subtract the
    // already-realized portion from heldOpenBuyCostBasis while the residual
    // TP rests — otherwise the sold tranche's cost is double-counted (once
    // realized via bodyPnl, once held), transiently understating return.
    const remainder = planPartialBodyRemainder({ body, summary, soldRatio });
    const remainingAsset = remainder.assetQty;
    body.consumedCostFraction = remainder.consumedCostFraction;
    // Legacy fallback for buys the sale could not record per order.
    stampConsumedCostFraction(body, soldRatio);

    body.assetQty = remainingAsset;
    body.costBasis = remainder.costBasis;
    // avgPrice stays the same (weighted average of buys doesn't change)

    // Remove old TP tracking — engine will re-place for correct remaining size
    getOrderExecutor().removeBodyTracking(fillData.orderId);
    body.tpOrderId = null;
    body.tpPrice = 0;
    body.assetOnOrder = 0;

    // Sync aggregate fields
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

    logger.info(`${tierCfg.emoji} [${exchange}] Body TP PARTIAL fill (${body.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, remaining=${remainingAsset} ${baseCurrency}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

    tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)} [PARTIAL]`, {
      assetAmount: summary.totalSize,
      price: summary.avgPrice,
      pnl,
      holdbackAsset: remainingAsset,
      bodyId: body.id,
      bodyTier: body.tier,
      isPartialFill: true,
      remainingAsset,
    });
  };

  /**
   * Apply a full body TP fill (synchronous): remove the body and its executor
   * tracking. Runs after the sale's consumption and booking are committed.
   * @param {Object} args
   * @param {Object} args.fillData
   * @param {Object} args.summary
   * @param {Object} args.body
   * @param {number} args.bodyIdx - Index of the body in positionState.celestialBodies
   * @param {ReturnType<typeof classifyTpFill>} args.fill
   * @param {Object} args.tierCfg
   * @param {number} args.prevMaxUsdc - maxUsdcDeployed before this sale's credit
   * @returns {boolean} Whether no bodies remain, so the cycle closes
   */
  const applyFullBodyTpFill = ({ fillData, summary, body, bodyIdx, fill, tierCfg, prevMaxUsdc }) => {
    const { pnl, holdbackAsset, reservesSoldAsset } = fill;
    // FULL FILL: remove body entirely
    // Remove body from array
    positionState.celestialBodies.splice(bodyIdx, 1);
    dustWaitLoggedQty.delete(body.id);

    // Remove executor tracking
    getOrderExecutor().removeBodyTracking(fillData.orderId);

    // Sync aggregate fields
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

    const remaining = positionState.celestialBodies.length;
    logger.info(`${tierCfg.emoji} [${exchange}] Body TP filled (${body.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackAsset.toFixed(6)} ${baseCurrency}${reservesSoldAsset > 0 ? ` (sold ${reservesSoldAsset.toFixed(6)} ${baseCurrency} beyond the body — drawn from reserves, #770)` : ''}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed} (${remaining} remaining)`);

    tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
      assetAmount: summary.totalSize,
      price: summary.avgPrice,
      pnl,
      holdbackAsset,
      ...(reservesSoldAsset > 0 && { reservesSoldAsset }),
      bodyId: body.id,
      bodyTier: body.tier,
      bodiesRemaining: remaining,
      capitalGrowth: pnl,
      newMaxUsdcDeployed: config.maxUsdcDeployed,
    });

    // No bodies left: the cycle closes. The reset runs in the caller, after
    // this sell's P&L annotation and closed-trade record are committed (#766).
    return positionState.celestialBodies.length === 0;
  };

  /**
   * Book a matched celestial body's TP fill, including partial re-placement
   * and a final body's durable cycle close. Keep the booking and body mutation
   * together before any await; the caller owns fill dedup and executor cleanup.
   *
   * Steps, in order (the first await is placeBodyTp on the partial path):
   *  1. classifyTpFill — pure: partial vs designed holdback, prorated cost, pnl
   *  2. count the completed body, credit capital growth
   *  3. planBodyTpBooking — pure — then record its per-buy consumption and
   *     commit its sell annotation, synchronously with the credit
   *  4. applyPartialBodyTpFill (+ re-place the TP) or applyFullBodyTpFill
   *     (+ link the source buys to this sell)
   *  5. record the closed trade, then a final body's durable cycle close
   * @param {Object} args
   * @param {Object} args.fillData - Fill data
   * @param {Object} args.summary - Aggregated fill summary
   * @param {Object} args.booking - Planned sell booking (planSellBooking)
   * @param {Array<Object>} args.bodies - positionState.celestialBodies
   * @param {number} args.bodyIdx - Index of the body whose TP filled
   * @param {Array<string>} args.bookedTradeIds - Trade IDs of booked fills
   */
  const handleBodyTpFill = async ({ fillData, summary, booking, bodies, bodyIdx, bookedTradeIds }) => {
    // CELESTIAL BODY TP FILL (full or partial)
    const body = bodies[bodyIdx];
    const tierCfg = celestialHierarchy.getTierConfig(body.tier);
    // Partial vs designed holdback (issues #107 M1, #770) and the prorated
    // cost of the sold tranche — see classifyTpFill.
    const fill = classifyTpFill({ body, summary, isPartialFill: fillData.isPartialFill });
    const { isPartial, pnl } = fill;

    // Update celestial state
    const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
    if (!isPartial) cs.bodiesCompleted += 1;
    positionState.celestialState = cs;
    // Partial fills are handled naturally — FIFO sees only the actual sold qty.

    // Grow capital (idempotent per booked amount — issues #210-B, #777)
    const prevMaxUsdc = creditCapitalGrowth(fillData.orderId, pnl, booking);

    // Planned from the pre-sale body (assetQty/avgPrice not yet reduced).
    const plan = planBodyTpBooking({ body, summary, fill, sellOrderId: fillData.orderId, additive: booking.additive });

    // Record per buy order what this sale consumed (issue #607), before
    // the body is reduced.
    recordBodyConsumption(plan.consumption);

    // Annotate the sell with its body booking, committed synchronously
    // with the credit and consumption above — before any await below, so
    // a concurrent booking of the same order cannot interleave between
    // the plan and the commit, and a later throw cannot leave a mutated
    // body without its commit marker. Adds to a booking this order
    // already committed when this pass booked new execution (issue #777).
    fillLedger.commitSellBooking(fillData.orderId, plan.sellBooking,
      { additive: booking.additive, soldSize: summary.totalSize, bookedTradeIds });

    let closesCycle = false;
    if (isPartial) {
      applyPartialBodyTpFill({ fillData, summary, body, fill, tierCfg, prevMaxUsdc });
      // Re-place TP for remaining body size
      await placeBodyTp(body);
    } else {
      closesCycle = applyFullBodyTpFill({ fillData, summary, body, bodyIdx, fill, tierCfg, prevMaxUsdc });
      // Link source buy fills to this sell order for buy→sell display linkage.
      // Skipped on partial fills: placeBodyTp above already re-linked the buys
      // to the re-placed TP for the remainder — stamping the filled orderId
      // there would clobber that linkage and make the remaining tranche's cost
      // basis vanish from heldOpenBuyCostBasis until the residual TP fills.
      // One ledger write for every linked buy (a merged body can own
      // hundreds), not a full-ledger rewrite per buy.
      fillLedger.annotateFillsByOrderIds(collectBodyLinkedBuyOrderIds(body), { sellOrderId: fillData.orderId });
    }

    // Record the aggregate closed trade. A second booking of the same
    // order adds its newly-booked tranche; a replay remains idempotent.
    closedTrades.record(buildBodyTpClosedTrade({
      sellOrderId: fillData.orderId,
      stamp: sellTradeStamp(summary),
      recordedAt: Date.now(),
      summary,
      body,
      fill,
    }), { additive: booking.additive });

    // If no bodies remain, do a full cycle reset — AFTER the bookkeeping
    // above, persisted first: resetCycle can wait on the ladder lock behind
    // an in-flight rebuild (#766), and a crash during that wait must not
    // lose this sell's bodyPnl/holdback annotation (the realized-P&L source
    // of truth) with the body it came from already gone.
    if (closesCycle) {
      positionState.cyclesCompleted += 1;

      const actualTpPct = body.avgPrice > 0
        ? ((summary.avgPrice - body.avgPrice) / body.avgPrice) * 100
        : 0;
      // Durable "this close still owes a cycle reset" marker: once the sell
      // is annotated, a retry of this fill (after resetCycle throws) takes
      // the already-processed branch below, which finishes the reset from
      // it instead of skipping it.
      positionState.pendingCycleResetFor = fillData.orderId;
      saveLiveState();
      fillLedger.persist();
      // Capture before resetCycle() zeroes cycleBuys, and run the
      // optimizer's real-balance fetch (issue #694) AFTER resetCycle()
      // flips the fill-ledger's cycle boundary (fillLedger.startNewCycle())
      // — not before it — so the network round-trip never widens the
      // window where a concurrent entry evaluation (gated only by
      // isEntryInProgress(), not isMutatingPosition()) could land a buy
      // fill still attributed to the closing cycle.
      const cycleBuysAtClose = positionState.cycleBuys;
      // try/finally: resetCycle()'s only network call (ladder cancel)
      // runs before any state mutation, so a throw there means nothing
      // else in resetCycle() ran either — but capitalDeployed/stepsUsed
      // above are already committed facts about this fill, independent
      // of whether the ladder cleanup succeeds. Recording them in
      // `finally` means a resetCycle() failure (the sell itself is
      // already booked and persisted above, so it is never re-booked)
      // can never permanently drop this cycle from the optimizer's stats.
      // A reset that reports it was stale skips
      // those samples below because another close already counted it.
      // Deliberately NOT awaited: the caller's own saveLiveState()/
      // fillLedger.persist() (below) durably persist this already-
      // completed sell/cycle-close before the optimizer's balance-fetch
      // (up to a 30s exchange timeout) gets a chance to delay them — a
      // crash during that fetch loses only this one best-effort
      // optimizer stats sample, never the P&L-critical state.
      // recordCycleForSizeOptimizer never rejects (its
      // own body is try/caught), so no unhandled-rejection risk. Once
      // it DOES resolve, re-save so the recorded sample/balance isn't
      // left ONLY in memory until some unrelated future save happens to
      // pick it up — cheap and idempotent, the same
      // as the periodic save timer already does.
      let resetResult;
      try {
        resetResult = await resetCycle();
      } finally {
        // Keep the close count persisted before the reset wait above, but
        // undo it when a queued reset discovers that an earlier close
        // already turned over this cycle. An operator boundary can also
        // supersede the queued reset, but it does not make this genuine
        // close a duplicate, so its optimizer samples still belong here.
        if (resetResult?.turnedOver === false && resetResult.duplicateClose) {
          positionState.cyclesCompleted -= 1;
        } else {
          recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
          recordCycleForSizeOptimizer({
            stepsUsed: cycleBuysAtClose,
            capitalDeployed: body.costBasis,
          }).catch(() => {}).finally(resaveAfterSizeOptimizerLive);
        }
      }
    }

    saveLiveState();
    fillLedger.persist();
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(getState());

  };

  /**
   * Record a sell that must not close the cycle (synchronous): bodies are
   * still active, or it is not the engine's own take-profit order. The
   * position model is deliberately left untouched (issue #750); the ledger
   * keeps the fact as `untrackedSell`.
   * @param {Object} args
   * @param {string} args.sellOrderId
   * @param {Object} args.summary - aggregateFills result for the sell
   * @param {string} args.reason - From untrackedSellRejectReason
   * @param {number} args.remainingBodies
   */
  const markUntrackedSell = ({ sellOrderId, summary, reason, remainingBodies }) => {
    logger.warn(`⚠️ [${exchange}] Untracked sell ${String(sellOrderId).slice(0,8)} (${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}) — ${reason}, skipping cycle completion`);
    // Position model is deliberately left untouched (issue #750). Which
    // holding a foreign sell drew down — zero-cost reserves or the
    // managed position — is unknowable from the fill, so any
    // attribution to totalAsset/totalCostBasis (or realizedAssetPnL)
    // would be a guess that corrupts P&L either way. The ledger keeps
    // the fact instead: `untrackedSell` rows lower ledgerNetAsset and
    // are broken out as `untrackedSellQty`, so the position-coverage
    // sweep (positionCoverage.ledger.untrackedSold) shows the gap and
    // its cause. Resolution is an operator action.
    if (remainingBodies === 0 && positionState.totalAsset > 0) {
      logger.warn(
        `⚖️ [${exchange}] Untracked sell ${String(sellOrderId).slice(0,8)} may have consumed the held position (${positionState.totalAsset} ${baseCurrency}) — position left unchanged; see positionCoverage.ledger.untrackedSold, operator review required`,
        { pair: productId, orderId: sellOrderId, soldQty: summary.totalSize, totalAsset: positionState.totalAsset, reserves: positionState.realizedAssetPnL || 0 }
      );
    }
    fillLedger.annotateFillsByOrderId(sellOrderId, { untrackedSell: true });
    saveLiveState();
    fillLedger.persist();
  };

  /**
   * The claim-gated half of a legacy core TP close (synchronous): bump
   * cyclesCompleted, apply the capital credit, emit tp_filled and feed the
   * TP optimizer — once per order, gated by fillLedger.claimCapitalCredit
   * (issue #679 follow-up).
   *
   * Only these truly non-idempotent counter bumps are gated, not the whole
   * close. An earlier round of this fix gated resetCycle() and
   * closedTrades.record behind this SAME claim, which stranded an in-progress
   * cycle close forever whenever resetCycle()'s own network cancel call failed
   * afterward: the claim was already persisted by claimCapitalCredit, so a
   * retry never got back into the block to finish closing. Both of those retry
   * safely on their own — closedTrades.record dedupes by sellOrderId alone (see
   * dedupKeyFor in closed-trades.js), and resetCycle's state resets are already
   * state-gated/idempotent (its one non-idempotent step,
   * fillLedger.startNewCycle(), landing twice on a genuine retry only costs a
   * spare cycle-number boundary — cosmetic, never a P&L figure) — so they stay
   * UNGATED in the caller and always run.
   *
   * The size-optimizer sample is captured here (claim-gated, same reasoning as
   * tp_filled) and fed AFTER resetCycle() runs — not inline — so the
   * optimizer's real-balance network fetch (issue #694) never sits between the
   * capital credit and resetCycle()'s fillLedger.startNewCycle() cycle-boundary
   * flip. Widening that gap with an awaited round-trip would let a concurrent
   * entry evaluation (gated only by isEntryInProgress(), not
   * isMutatingPosition() — unlike refreshDrawdownGuard/consolidateDustBodies)
   * land a buy fill that gets attributed to the closing cycle instead of the
   * new one.
   * @param {Object} args
   * @param {string} args.sellOrderId
   * @param {Object} args.summary - aggregateFills result for the sell
   * @param {ReturnType<typeof planCoreTpClose>} args.close
   * @returns {{stepsUsed: number, capitalDeployed: number}|null} The size-optimizer
   *   sample, or null when a prior pass already claimed the credit
   */
  const claimCoreTpCapitalCredit = ({ sellOrderId, summary, close }) => {
    const { pnl, holdbackAsset, soldCostBasis } = close;
    if (!fillLedger.claimCapitalCredit(sellOrderId)) {
      logger.info(
        `ℹ️ [${exchange}] Untracked sell ${sellOrderId.slice(0, 8)} capital already credited — skipping re-apply, still completing the cycle close`,
        { orderId: sellOrderId }
      );
      return null;
    }
    positionState.cyclesCompleted += 1;

    // Capital was already claimed (fillLedger.claimCapitalCredit)
    // above as the idempotency gate — apply it directly rather
    // than calling creditCapitalGrowth, which would re-claim and
    // (seeing it already claimed) skip applying pnl.
    const prevMaxUsdc = config.maxUsdcDeployed;
    config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
    updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

    logger.info(`✅ [${exchange}] TP filled (untracked): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

    // tp_filled + the optimizer recorders belong to the SAME
    // claim-gated commit as cyclesCompleted++ / the capital credit.
    // They were previously ungated, alongside
    // resetCycle()/closedTrades.record — so a
    // retry after the claim already succeeded (capital credited,
    // resetCycle awaiting a network cancel that then failed) would
    // re-emit tp_filled and re-feed the optimizers on every retry,
    // and once resetCycle() DID complete, avgCostBasis is reset to
    // 0, so a subsequent retry's actualTpPct calc below would also
    // be wrong. resetCycle()/closedTrades.record stay outside this
    // gate (they retry idempotently on their own).
    const actualTpPct = positionState.avgCostBasis > 0
      ? ((summary.avgPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100
      : 0;
    tradeEvents.emitTradeEvent('tp_filled', exchange, `${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
      assetAmount: summary.totalSize,
      price: summary.avgPrice,
      pnl,
      holdbackAsset,
      capitalGrowth: pnl,
      newMaxUsdcDeployed: config.maxUsdcDeployed,
    });
    recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
    return {
      stepsUsed: positionState.cycleBuys,
      capitalDeployed: soldCostBasis,
    };
  };

  /**
   * Close the cycle on the engine's own legacy core TP fill, then acknowledge
   * the order to the executor. Everything up to resetCycle() runs in one
   * synchronous block, exactly as before; the acknowledgement follows the
   * final save with no await between them.
   * @param {Object} args
   * @param {Object} args.fillData
   * @param {Object} args.summary - aggregateFills result for the sell
   * @param {Object} args.booking - Planned sell booking
   */
  const closeLegacyCoreTp = async ({ fillData, summary, booking }) => {
    const close = planCoreTpClose({
      summary, avgCostBasis: positionState.avgCostBasis, totalAsset: positionState.totalAsset,
    });

    positionState.assetOnOrder = 0;

    const sizeOptimizerCycleData = claimCoreTpCapitalCredit({ sellOrderId: fillData.orderId, summary, close });

    // Link current-cycle buy fills to this sell order for buy→sell display
    // linkage (skip body-owned and timestamp-folded buys, #705).
    const buyOrderIds = collectCoreCycleBuyOrderIds(fillLedger.getCurrentCycleFills());
    fillLedger.annotateFillsByOrderIds(buyOrderIds, { sellOrderId: fillData.orderId });

    // Preserve the legacy audit record before resetCycle clears its
    // cost basis. Safe to call every pass — record() accumulates only a
    // newly-booked tranche and leaves a replay unchanged.
    closedTrades.record(buildCoreTpClosedTrade({
      sellOrderId: fillData.orderId,
      stamp: sellTradeStamp(summary),
      recordedAt: Date.now(),
      summary,
      close,
      avgCostBasis: positionState.avgCostBasis,
      buyOrderIds,
      source: fillData.source,
    }), { additive: booking.additive });

    // Record the optimizer sample even if resetCycle() throws: the retry
    // of this fill finds claimCapitalCredit already spent and would never
    // rebuild sizeOptimizerCycleData, dropping the cycle from the stats.
    // (A throw comes from the ladder cancel, before any state mutation.)
    // Not awaited, so its balance fetch (up to a 30s timeout) cannot delay
    // the P&L-critical saves below; it never rejects, and re-saves once
    // it resolves so the sample is not held only in memory.
    try {
      await resetCycle();
    } finally {
      if (sizeOptimizerCycleData) {
        recordCycleForSizeOptimizer(sizeOptimizerCycleData).catch(() => {}).finally(resaveAfterSizeOptimizerLive);
      }
    }
    saveLiveState();
    fillLedger.persist();

    getOrderExecutor().handleOrderFill(fillData.orderId);
  };

  /**
   * Book a sell with no matching live body: reject body-TP replays and foreign
   * sells, or finish an owned legacy core TP close. Own the final executor
   * acknowledgement here so guard returns keep their original skip semantics.
   * The caller returns this promise directly: no new await separates the close's
   * mutations, persistence, and acknowledgement.
   * @param {Object} args
   * @param {Object} args.fillData
   * @param {Array<Object>} args.fillsToAggregate - This pass's sell rows
   * @param {Object} args.booking - Planned sell booking
   * @param {string|null|undefined} args.entryCoreTpOrderId - Core TP id snapshotted before any await
   */
  const handleUntrackedSellFill = async ({ fillData, fillsToAggregate, booking, entryCoreTpOrderId }) => {
    // UNTRACKED SELL — could be a core TP from before migration
    const summary = fillLedger.aggregateFills(fillsToAggregate);

    // Guard: check if fills for this order are already annotated as body TP.
    // This catches duplicate body TP fills from cancel-and-replace races where both the
    // old and new TP orders fill simultaneously — the first is processed correctly, the
    // second arrives after the body is removed and would otherwise trigger a false cycle.
    const existingFills = fillLedger.getFillsForOrder(fillData.orderId);
    if (isSellBookedAsBody(existingFills)) {
      // A retry of a body TP close whose cycle reset failed after the sell
      // was booked (#766): finish the reset the first pass owed.
      if (positionState.pendingCycleResetFor === fillData.orderId
        && (positionState.celestialBodies || []).length === 0) {
        logger.warn(`🔁 [${exchange}] Sell ${fillData.orderId.slice(0,8)} already booked — completing its pending cycle reset`);
        await resetCycle();
        positionState.pendingCycleResetFor = null;
        saveLiveState();
        fillLedger.persist();
        return;
      }
      logger.info(`⏭️ [${exchange}] Sell ${fillData.orderId.slice(0,8)} already processed as body TP, skipping`);
      return;
    }

    // Guard (issue #672): only the engine's OWN legacy core TP may close
    // the cycle. The exchange user channel delivers every sell on the
    // product — a manual sale of reserves, the DCA/manual-trades tooling,
    // scripts — and between celestial cycles there are no bodies, so
    // without this a foreign sell was booked as a cycle close crediting
    // its full proceeds to maxUsdcDeployed. Ownership is proven by:
    //  - the core TP id snapshotted before any await, or still current;
    //  - the executor tracking it as `take_profit` (pending, active, or
    //    recently settled — covers polling-backstop / cancel-race paths);
    //  - a prior pass having already claimed its capital credit — a
    //    retry of a close whose resetCycle() already nulled
    //    activeTpOrderId must still finish closing idempotently.
    const sellOrderId = fillData.orderId;
    const isOwnCoreTp = isOwnLegacyCoreTp({
      sellOrderId,
      entryCoreTpOrderId,
      activeTpOrderId: positionState.activeTpOrderId,
      isTrackedTpOrder: typeof getOrderExecutor().isTrackedTpOrder === 'function'
        ? (orderId) => getOrderExecutor().isTrackedTpOrder(orderId)
        : undefined,
      existingFills,
    });

    // Guard: if celestial bodies still exist, this is NOT a legitimate cycle-closing TP.
    // It's likely a duplicate/untracked satellite sell. Log and annotate but don't complete the cycle.
    const remainingBodies = (positionState.celestialBodies || []).length;
    const reason = untrackedSellRejectReason({ remainingBodies, isOwnCoreTp });
    if (reason) {
      markUntrackedSell({ sellOrderId, summary, reason, remainingBodies });
      getOrderExecutor().handleOrderFill(fillData.orderId);
      return;
    }

    return closeLegacyCoreTp({ fillData, summary, booking });
  };

  const handleSellOrderFill = async (fillData, dedupRef, keepEntryTracked, {
    ingestedFills, fillsToAggregate, entryCoreTpOrderId,
  }) => {
    const unbookedSellFills = fillLedger.getUnbookedSellFills(fillData.orderId) || [];
    // Sell-fill dedup: skip if already processed (prevents double-processing across WS/reconcile/polling)
    // A terminal rescan can expose new excess beyond already-booked
    // synthetic coverage. Use a separate key for that new unbooked tranche,
    // while retaining the terminal key so a later replay remains a no-op.
    const terminalSellKey = makeFillDedupKey(fillData.orderId, false, fillData.filledSize);
    const dedupKey = !fillData.isPartialFill && unbookedSellFills.length > 0
      && recentlyProcessedSellFills.has(terminalSellKey)
      ? `${fillData.orderId}:terminal-reconcile:${(fillData.filledSize || 0).toFixed(8)}`
      : makeFillDedupKey(fillData.orderId, fillData.isPartialFill, fillData.filledSize);
    if (recentlyProcessedSellFills.has(dedupKey)) {
      logger.info(`⏭️ [${exchange}] Sell fill already processed, skipping: ${dedupKey}`);
      return;
    }
    recentlyProcessedSellFills.add(dedupKey);
    if (dedupRef) { dedupRef.set = recentlyProcessedSellFills; dedupRef.key = dedupKey; }

    // An order that already committed a booking books only the rows no
    // booking covered yet (issue #777): whatever this pass ingested, plus
    // any row that reached the ledger another way (startup recovery, a
    // dedup-skipped delivery) — so that execution is booked, and added to
    // the committed booking, instead of re-booking every row of the order
    // as a replay. With nothing unbooked this IS a replay: all rows, as before.
    let sellRowsAreNew = ingestedFills.length > 0;
    if (unbookedSellFills && unbookedSellFills.length > 0) {
      fillsToAggregate = unbookedSellFills;
      sellRowsAreNew = true;
    } else if (sellRowsAreNew && isBodyTpSellOrder(fillData.orderId)
      && !fillLedger.getSellBooking(fillData.orderId)) {
      // A body TP no booking ever covered: rows recovered while the engine
      // was down (a partial of a TP that was still resting) are as unbooked
      // as this pass's, and booking only the new rows would lose that
      // execution (issue #1398). Book every row of the order once.
      const aggregated = new Set(fillsToAggregate.map(f => f.tradeId));
      fillsToAggregate = [...fillsToAggregate, ...fillLedger.getFillsForOrder(fillData.orderId)
        .filter(f => f.side === 'sell' && f.size > 1e-9 && !f.bodyBooked && !aggregated.has(f.tradeId))];
    }
    const bookedTradeIds = fillsToAggregate.map(f => f.tradeId);

    // UNIFIED BODY TP FILL — find matching celestial body by TP order ID
    const summary = fillLedger.aggregateFills(fillsToAggregate);
    const booking = planSellBooking(fillData.orderId, summary.totalSize, sellRowsAreNew);

    // Race 3: check merge-snapshot maps first (fill arrived for body removed during merge)
    const mergeSnapshot = pendingMergeTpOrders.get(fillData.orderId)
      || completedMergeTpOrders.get(fillData.orderId);
    if (mergeSnapshot) {
      await handleMergedSnapshotTpFill({ fillData, summary, booking, mergeSnapshot, bookedTradeIds });
      return;
    }

    // Find the body whose tpOrderId matches this fill
    const bodies = positionState.celestialBodies || [];
    const bodyIdx = bodies.findIndex(b => b.tpOrderId === fillData.orderId);

    if (bodyIdx !== -1) {
      await handleBodyTpFill({ fillData, summary, booking, bodies, bodyIdx, bookedTradeIds });
    } else {
      return handleUntrackedSellFill({ fillData, fillsToAggregate, booking, entryCoreTpOrderId });
    }

    if (!keepEntryTracked) getOrderExecutor().handleOrderFill(fillData.orderId);
  };

  return { handleSellOrderFill };
};

module.exports = { createSellFillBooking };
