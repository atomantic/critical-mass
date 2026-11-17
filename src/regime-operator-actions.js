'use strict';

/**
 * Operator-triggered actions for one fund: the externally-driven position
 * update and recalc, body roll-up / Collapse All, the operator cycle reset,
 * manual TP edits and rebuild, ladder preview / rebuild / cancel, and body
 * inject / extend (with the recovered-row body growth that runs through
 * extend). Extracted verbatim from regime-engine (issue #1978); the engine
 * wires `createOperatorActions({...})` and exposes the same public methods and
 * `_test.mergeBody`.
 *
 * Every action takes the same locks it took inline, through the engine's own
 * `engineLocks`: the merge lock for roll-ups, the ladder lock for ladder
 * rebuild / cancel, the backup fence for extend, and a tracked pending write
 * for each recovered-row growth run. Nothing here books P&L: a roll-up merges
 * bodies and re-places one TP, and realized P&L still comes only from the fill
 * ledger's cycle-pair annotations (refreshRealizedFromCyclePairs).
 *
 * `positionState` is passed directly: the engine keeps one object identity
 * (replacePositionState, #1594). `getIsRunning`, `getAdapter`,
 * `getOrderExecutor`, `getMarketState`, `getPriceIncrement` and
 * `getCycleResetGeneration` are accessors because the engine reassigns those
 * bindings (start/stop, tests swapping the exchange deps, product details,
 * each cycle reset).
 */

const { trackPendingWrite } = require('./pending-writes');
const { updateRegimeConfig, getQuoteCurrency } = require('./config-utils');
const { LIFECYCLE } = require('./regime-state-store');
const { classifyBodyTpCancellation } = require('./cancellation-result');
const { tradeEvents } = require('./trade-events');
const celestialHierarchy = require('./celestial-hierarchy');
const { fmtCurrency: fmtPrice } = require('./shared-utils');
const { buildPartialFillData, snapshotBody } = require('./regime-pure-helpers');
const { restorePersistedCycleId, planBodyGrowthFromRecoveredBuyRows } = require('./regime-fill-annotations');

/**
 * @param {Object} deps
 * @returns {{updatePosition: Function, extendBodiesFromRecoveredBuyRows: Function, recalculateAndRefresh: Function, _mergeBodyImpl: Function, manualMergeBody: Function, rollupAllBodies: Function, resetCycleBuys: Function, setBodyTpPercent: Function, setBodyTpPrice: Function, rebuildTP: Function, previewLadder: Function, rebuildLadder: Function, cancelLadder: Function, injectBody: Function, extendBody: Function, isExtendInFlight: () => boolean}}
 */
const createOperatorActions = ({
  exchange, pair, productId, baseCurrency, fundLabel, config, logger, callbacks,
  positionState, replacePositionState,
  fillLedger, riskManager, ladderCalculator, engineLocks,
  pendingMergeTpOrders, dustWaitLoggedQty,
  getIsRunning, getAdapter, getOrderExecutor, getMarketState, getPriceIncrement, getCycleResetGeneration,
  lookupOrNull, captureEntryAdmission, getState, getStatus,
  // Live fill pipeline and TP placement
  handleOrderFillImpl, completeMergeSnapshot, cancelBodyTpForReplace,
  placeBodyTp, placeBodyTpWithRetry, placeTakeProfitOrder,
  // Cycle reset and the ladder helpers shared with ladder entry
  resetCycle, getAllocatedCapital, buildLadderFromMarket, abandonLadderPlacedAcrossReset,
  // State persistence (regime-state-persistence)
  saveLiveState, refreshRealizedFromCyclePairs,
  syncActiveCycleIdAfterRecalc, resyncLiveCycleCountersAfterRecalc,
}) => {
  /**
   * Update position state externally (e.g., from recalculate)
   * @param {Object} newPosition - New position values to merge
   */
  const updatePosition = (newPosition) => {
    replacePositionState({
      ...positionState,
      ...newPosition,
    });
    saveLiveState();
    logger.info(`🔄 [${exchange}] Position updated externally: buys=${positionState.cycleBuys}, cycles=${positionState.cyclesCompleted}, ${baseCurrency} reserves=${positionState.realizedAssetPnL}`);
  };

  /** Tail of the serialized extendBodiesFromRecoveredBuyRows runs. */
  let recoveredGrowthChain = Promise.resolve();

  /**
   * Grow each body that owns recovered partial rows of its own buy order
   * (planBodyGrowthFromRecoveredBuyRows, #752) via extendBody, which cancels
   * the body's TP BEFORE growing it and re-places it at the new size. Runs at
   * start (once live) and after an operator recalc. Fire-and-forget (callers
   * don't wait on exchange round trips) but serialized, and idempotent —
   * extendBody merges only the order's remaining shortfall, so a failed or
   * repeated attempt is simply retried by the next recalc or start.
   *
   * Backup fence (#1959): each run is its own tracked write, registered once
   * the previous run settles and executed inside that write's context.
   * extendBody passes the fence per body, so a hold parks the run before its
   * next TP cancel/re-place and marks this write parked: the process-wide
   * drain skips it instead of waiting out its bound. A run queued behind a
   * parked one is not registered yet, so it cannot stall the drain either.
   * @returns {Promise<void>}
   */
  const extendBodiesFromRecoveredBuyRows = () => {
    // Each run plans against the bodies as they are when it starts; extendBody
    // re-finds the body and recomputes its shortfall after any park.
    const runGrowth = async () => {
      const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger, celestialBodies: positionState.celestialBodies });
      for (const { buyOrderId, reason } of skipped) {
        logger.warn(`⚠️ [${exchange}] Recovered buy rows of ${String(buyOrderId).slice(0, 8)} not merged into a body (${reason}) — manual review`, { buyOrderId, reason });
      }
      for (const { body, buyOrderId, totals } of plans) {
        try {
          const res = await extendBody(body.id, totals, buyOrderId);
          if (!res.success) logger.warn(`⚠️ [${exchange}] Could not grow body ${body.id.slice(-8)} from recovered rows of buy ${String(buyOrderId).slice(0, 8)}: ${res.error}`, { bodyId: body.id, buyOrderId, error: res.error });
        } catch (err) {
          logger.error(`❌ [${exchange}] Growing body ${body.id.slice(-8)} from recovered rows of buy ${String(buyOrderId).slice(0, 8)} failed: ${err.message}`, { bodyId: body.id, buyOrderId, error: err.message });
        }
      }
    };
    // Chain onto any earlier run so back-to-back recalcs never overlap.
    recoveredGrowthChain = recoveredGrowthChain
      .then(() => trackPendingWrite(`engine-growth:${fundLabel}`, runGrowth))
      .catch((err) => {
        logger.error(`❌ [${exchange}] Recovered-row body growth failed: ${err.message}`, { error: err.message });
      });
    return recoveredGrowthChain;
  };

  /**
   * Recompute cycle boundaries on the engine's OWN ledger and re-derive P&L
   * from the cycle-pair source of truth. Used by the regime:recalculate
   * handler so it never has to (a) instantiate a second ledger on the same
   * file (lost-update race), (b) write FIFO/closed-trades totals as
   * realizedPnL, or (c) blind-merge a rebuilt position into the live engine
   * (which would null activeTpOrderId and resurrect stale bodies). It mutates
   * only realizedPnL / realizedAssetPnL / heldAssetCostBasis / cyclesCompleted
   * — never order tracking, lifecycle, or ladder state (issue #96) — except
   * that a body owning recovered rows of its own buy order is then grown
   * through extendBody, which re-places that body's TP (#752).
   * @returns {{cyclesCompleted:number, realizedPnL:number, realizedAssetPnL:number, cycleDetails:any[], orphansFixed:number, activeCycleId:string|null}}
   */
  const recalculateAndRefresh = () => {
    // Anchor the ledger on the durable boundary first so renumbering keeps
    // THAT cycle last and reports its rename in idMap (#675).
    restorePersistedCycleId(fillLedger, positionState, logger, exchange);
    const recalc = fillLedger.recalculateCycles();
    syncActiveCycleIdAfterRecalc(recalc);
    resyncLiveCycleCountersAfterRecalc(recalc);
    positionState.cyclesCompleted = recalc.cyclesCompleted;
    // Source of truth — cycle pairs, NOT FIFO/closed-trades. Also updates
    // realizedAssetPnL and heldAssetCostBasis and persists.
    refreshRealizedFromCyclePairs();
    saveLiveState();
    extendBodiesFromRecoveredBuyRows();
    return {
      cyclesCompleted: recalc.cyclesCompleted,
      realizedPnL: positionState.realizedPnL,
      realizedAssetPnL: positionState.realizedAssetPnL,
      cycleDetails: recalc.cycleDetails,
      orphansFixed: recalc.orphansFixed,
      activeCycleId: recalc.activeCycleId,
    };
  };

  const annotateMergedSourceBuys = (source, merged) => {
    for (const srcId of (source.sourceOrderIds || [])) {
      fillLedger.annotateFillsByOrderId(srcId, { bodyId: merged.id, bodyTier: merged.tier });
    }
    for (const buyOrder of (source.buyOrders || [])) {
      if (buyOrder.orderId && buyOrder.orderId !== 'core-migration') {
        fillLedger.annotateFillsByOrderId(buyOrder.orderId, { bodyId: merged.id, bodyTier: merged.tier });
      }
    }
  };

  /**
   * Manually merge a body into the next-highest body by TP price.
   * Cancels both TPs, combines all buys, re-places a single merged TP.
   * @param {string} bodyId - ID of the source body (lower TP) to roll up
   * @returns {Promise<{success: boolean, message: string, mergedBody?: Object}>}
   */
  // Inner merge primitive — assumes the caller holds the merge lock (see the
  // manualMergeBody wrapper). opts.targetId forces a specific merge target
  // (used by the dust consolidator, which must NOT rely on tpPrice ordering —
  // a restored sub-min body can carry a stale tpPrice); opts.label customises
  // the log prefix (#189).
  const _mergeBodyImpl = async (bodyId, opts = {}) => {
    const { targetId = null, label = 'Manual roll-up' } = opts;
    if (!getIsRunning()) {
      return { success: false, message: 'Engine not running' };
    }
    const bodies = positionState.celestialBodies || [];
    if (bodies.length < 2) {
      return { success: false, message: 'Need at least 2 bodies to merge' };
    }
    const source = bodies.find(b => b.id === bodyId);
    if (!source) {
      return { success: false, message: `Body ${bodyId} not found` };
    }

    let target;
    if (targetId != null) {
      // Explicit target (dust consolidation): merge source INTO this body.
      target = bodies.find(b => b.id === targetId && b.id !== source.id);
      if (!target) {
        return { success: false, message: `Target body ${targetId} not found` };
      }
    } else {
      // Default: merge into the next-highest body by tpPrice (lowest tpPrice above source's).
      const candidates = bodies
        .filter(b => b.id !== source.id && b.tpPrice > source.tpPrice)
        .sort((a, b) => a.tpPrice - b.tpPrice);
      if (candidates.length === 0) {
        return { success: false, message: 'No higher body to merge into (this is the highest)' };
      }
      target = candidates[0];
    }

    // Check both orders for partial fills before merging
    for (const body of [source, target]) {
      if (body.tpOrderId) {
        const orderStatus = await lookupOrNull('getOrder', body.tpOrderId, getAdapter().getOrder(body.tpOrderId));
        if (orderStatus && orderStatus.filledSize > 0) {
          const which = body === source ? 'Source' : 'Target';
          return { success: false, message: `${which} body ${body.id.slice(-8)} has a partially filled TP order (${orderStatus.filledSize} filled) — cannot merge` };
        }
      }
    }

    logger.info(`🔗 [${exchange}] ${label}: merging body ${source.id.slice(-8)} (TP ${fmtPrice(source.tpPrice)}) → ${target.id.slice(-8)} (TP ${fmtPrice(target.tpPrice)})`);

    // Race 3: snapshot both bodies before cancelling TPs
    // If a TP fills between cancel and state removal, the fill handler uses the snapshot
    const sourceSnapshot = snapshotBody(source);
    const targetSnapshot = snapshotBody(target);
    if (source.tpOrderId) pendingMergeTpOrders.set(source.tpOrderId, sourceSnapshot);
    if (target.tpOrderId) pendingMergeTpOrders.set(target.tpOrderId, targetSnapshot);

    // Capture pre-merge TP% so the merged body's TP% can only decrease, never increase.
    // Merging cheaper buys lowers avgPrice; capping at prevTpPct ensures the absolute
    // sell price also decreases (new tpPrice = lowerAvgPrice × cappedTpPct < oldTpPrice).
    const prevTargetTpPct = targetSnapshot.tpPrice > 0 && targetSnapshot.avgPrice > 0
      ? (targetSnapshot.tpPrice / targetSnapshot.avgPrice - 1) * 100
      : null;

    // A body TP that executes a tranche WHILE we're cancelling it (issue #368,
    // mirrors the buy-merge precedent at #227) still reports cancelled: true —
    // classifyBodyTpCancellation is what tells clean cancels apart from
    // execution-bearing ones. The Race-3 snapshots set above (before either
    // cancel call) let handleOrderFillImpl's merge-snapshot branch find the
    // still-live body (neither source nor target has been removed from
    // celestialBodies yet at this point), deduct the sold qty/prorated cost,
    // and re-place a right-sized TP — all in one call, reusing the exact same
    // booking path the buy-merge race already relies on. We call
    // handleOrderFillImpl directly (not the handleOrderFill wrapper) because
    // the wrapper's fill gate waits on this merge hold — going through it
    // would self-stall for its full 15s wait window every time.
    const bookExecutionDuringCancel = async (body, snapshot, cancelResult) => {
      const soldTp = snapshot.tpOrderId;
      completeMergeSnapshot(snapshot);
      body.tpOrderId = null;
      body.tpPrice = 0;
      body.assetOnOrder = 0;
      saveLiveState();
      await handleOrderFillImpl(buildPartialFillData(soldTp, 'sell', {
        status: 'CANCELLED',
        filledSize: cancelResult.filledSize,
        filledValue: cancelResult.filledValue,
        averageFilledPrice: cancelResult.averageFilledPrice,
      }, { totalFees: cancelResult.totalFees || 0 }), { set: null, key: null }).catch((err) => {
        logger.warn(
          `⚠️ [${exchange}] Failed to book body TP partial fill for ${soldTp.slice(0, 8)} immediately: ${err.message} — relying on a later WS/poll event`,
          { orderId: soldTp, error: err.message }
        );
      });
      return soldTp;
    };

    // Snapshot holders are read after cancellation: the source's live TP ID
    // is cleared before the target leg, so that leg uses sourceSnapshot.
    const cancelMergeLeg = async ({ leg, body, snapshot, dropSnapshots, restoreSource }) => {
      const cancelResult = await getOrderExecutor().cancelBodyTpOrder(body.id, body.tpOrderId);
      const outcome = classifyBodyTpCancellation(cancelResult);
      if (outcome === 'filled' || outcome === 'unresolved') {
        for (const pending of dropSnapshots) {
          if (pending.tpOrderId) pendingMergeTpOrders.delete(pending.tpOrderId);
        }
        const reason = outcome === 'filled' ? 'already filled' : 'cancel failed';
        const action = restoreSource ? 'restoring source TP' : 'aborting roll-up';
        logger.warn(`⚠️ [${exchange}] ${leg} body ${body.id.slice(-8)} TP ${reason}, ${action}`);
        if (restoreSource) {
          await placeBodyTp(source);
          saveLiveState();
        }
        return { abort: { success: false, message: `${leg} TP ${reason}${restoreSource ? ', source restored' : ''}` } };
      }
      if (outcome === 'cancelled_with_execution') {
        // Keep the executed body's snapshot until booking moves it to completed;
        // the other leg has either not been touched or needs its TP restored.
        for (const pending of dropSnapshots) {
          if (pending !== body && pending.tpOrderId) pendingMergeTpOrders.delete(pending.tpOrderId);
        }
        const soldTp = await bookExecutionDuringCancel(body, snapshot, cancelResult);
        logger.warn(`⚠️ [${exchange}] ${leg} body ${body.id.slice(-8)} TP filled ${cancelResult.filledSize} ${baseCurrency} during cancel — booked ${soldTp.slice(-8)}, ${restoreSource ? 'restoring source TP, ' : ''}aborting roll-up (#368)`);
        if (restoreSource) {
          await placeBodyTp(source);
          saveLiveState();
        }
        return { abort: { success: false, message: `${leg} TP filled during cancel (${cancelResult.filledSize} ${baseCurrency}) — booked, ${restoreSource ? 'source restored, ' : ''}roll-up aborted` } };
      }
      body.tpOrderId = null;
      body.tpPrice = 0;
      body.assetOnOrder = 0;
      return { outcome };
    };

    // A throw (e.g. a rejected cancelOrder) must not leave the Race-3 snapshots
    // registered: handleOrderFillImpl checks pendingMergeTpOrders BEFORE the live
    // body, so a stale entry would book a later full TP fill without closing the
    // cycle (#1342). Entries already moved by completeMergeSnapshot are gone from
    // pending, so this only drops the unconsumed ones.
    let merged;
    try {
      const sourceCancel = await cancelMergeLeg({
        leg: 'Source', body: source, snapshot: sourceSnapshot,
        dropSnapshots: [source, target], restoreSource: false,
      });
      if (sourceCancel.abort) return sourceCancel.abort;

      const targetCancel = await cancelMergeLeg({
        leg: 'Target', body: target, snapshot: targetSnapshot,
        dropSnapshots: [sourceSnapshot, target], restoreSource: true,
      });
      if (targetCancel.abort) return targetCancel.abort;

      // Merge bodies (pure data)
      merged = celestialHierarchy.mergeBodies(target, source, config.maxUsdcDeployed, logger);

      // Remove source from celestialBodies
      positionState.celestialBodies = positionState.celestialBodies.filter(b => b.id !== source.id);
      dustWaitLoggedQty.delete(source.id);

      // Retain both snapshots for late-arriving fills (5-minute TTL).
      completeMergeSnapshot(sourceSnapshot);
      completeMergeSnapshot(targetSnapshot);
    } catch (err) {
      for (const snap of [sourceSnapshot, targetSnapshot]) {
        if (snap.tpOrderId && pendingMergeTpOrders.get(snap.tpOrderId) === snap) {
          pendingMergeTpOrders.delete(snap.tpOrderId);
        }
      }
      throw err;
    }

    // Check cascading promotions and sync aggregates
    celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

    // Re-annotate source body's fills with merged body's ID
    annotateMergedSourceBuys(source, merged);

    // Place new combined TP (handles holdback, annotation for ALL source buy fills).
    // Cap TP% at the pre-merge target level so the sell price can only go down after merge.
    if (prevTargetTpPct != null) merged._maxTpPct = prevTargetTpPct;
    await placeBodyTpWithRetry(merged, 'Roll-up');

    // Persist
    saveLiveState();
    fillLedger.persist();

    const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
    logger.info(`${tierCfg.emoji} [${exchange}] Roll-up complete: body ${merged.id.slice(-8)} now ${merged.tier} (${merged.assetQty.toFixed(6)} ${baseCurrency}, $${merged.costBasis.toFixed(2)}, ${merged.buyOrders?.length || 0} buys)`);

    tradeEvents.emitTradeEvent('body_rollup', exchange, `${tierCfg.emoji} Merged → ${merged.tier}: ${merged.assetQty.toFixed(6)} ${baseCurrency}`, {
      mergedBodyId: merged.id,
      mergedTier: merged.tier,
      assetQty: merged.assetQty,
      costBasis: merged.costBasis,
      avgPrice: merged.avgPrice,
      sourceBodyId: source.id,
      buyCount: merged.buyOrders?.length || 0,
    });

    // Push updated status via WebSocket so dashboard animation refreshes immediately
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(getState());

    return {
      success: true,
      message: `Merged ${source.id.slice(-8)} → ${merged.id.slice(-8)} (${merged.tier})`,
      mergedBody: {
        id: merged.id,
        tier: merged.tier,
        assetQty: merged.assetQty,
        costBasis: merged.costBasis,
        avgPrice: merged.avgPrice,
        buyCount: merged.buyOrders?.length || 0,
      },
    };
  };

  /**
   * Public single-body merge. Acquires the merge lock (deferring if a merge or
   * reconcile is already running) so a metrics-timer dust merge can't interleave
   * with an operator roll-up or the reconcile loop (#189). Nested callers that
   * already hold the lock (rollupAllBodies) reenter rather than self-deadlocking.
   * @param {string} bodyId
   * @param {{targetId?: string, label?: string}} [opts]
   */
  const manualMergeBody = async (bodyId, opts = {}) =>
    engineLocks.withMergeLock(() => _mergeBodyImpl(bodyId, opts));

  /**
   * Collapse every celestial body into a single body with one TP order.
   * Iteratively rolls up the lowest-TP body into the next-highest using
   * manualMergeBody until only one body remains.
   * @returns {Promise<{success: boolean, message: string, mergedCount?: number, finalBody?: Object}>}
   */
  const rollupAllBodies = async () => {
    if (!getIsRunning()) return { success: false, message: 'Engine not running' };
    const startCount = (positionState.celestialBodies || []).length;
    if (startCount < 2) {
      return { success: false, message: `Need at least 2 bodies to collapse, found ${startCount}` };
    }
    // Acquire the merge lock ONCE for the whole collapse (defer to any in-flight
    // merge/reconcile). Inner manualMergeBody calls reenter that hold (#189).
    return engineLocks.withMergeLock(async () => {
      logger.info(`🔗 [${exchange}] Collapse-all triggered: ${startCount} bodies → 1`);

      let mergedCount = 0;
      let lastResult = null;
      // Safety bound: each iteration removes one body, so we can't need more than startCount-1
      for (let i = 0; i < startCount - 1; i++) {
        const bodies = positionState.celestialBodies || [];
        if (bodies.length < 2) break;
        const lowest = [...bodies].sort((a, b) => (a.tpPrice || 0) - (b.tpPrice || 0))[0];
        const result = await manualMergeBody(lowest.id);
        if (!result.success) {
          return {
            success: false,
            message: `Collapse aborted after ${mergedCount} merges: ${result.message}`,
            mergedCount,
          };
        }
        mergedCount++;
        lastResult = result;
      }

      return {
        success: true,
        message: `Collapsed ${startCount} bodies into 1 (${mergedCount} merges)`,
        mergedCount,
        finalBody: lastResult?.mergedBody || null,
      };
    });
  };

  /**
   * Operator action: reset the accumulation cycle to re-enable buying after the
   * cycle buy-limit (maxCycleBuys) has paused new entries. Reuses the engine's
   * persistent resetCycle() primitive — sets cycleBuys=0, starts a new fill-ledger
   * cycle (so getCurrentCycleAllBuysCount() reads 0 and the reset survives a
   * restart), preserves open celestial bodies and their take-profits, and resets
   * risk-manager cycle tracking. Persists immediately so the new cycle boundary
   * survives a kill.
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const resetCycleBuys = async () => {
    if (!getIsRunning()) return { success: false, message: 'Engine not running' };
    // Also gate on in-flight fills (as consolidateDustBodies does via
    // isMutatingPosition): a fill mid-handling may be ingested into the ledger
    // under the about-to-be-superseded cycle but not yet reflected in
    // positionState.cycleBuys — resetting the cycle boundary underneath it
    // desyncs cycleBuys from the ledger and a restart's auto-correct can
    // silently erase a real buy step (issue #232 follow-up).
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }
    // An operator reset must not queue behind (or, after the wait bound, run
    // alongside) a ladder rebuild/cancel/reset in flight (#766) — refuse like
    // rebuildLadder/cancelLadder. Uncontended, resetCycle below takes the
    // ladder lock synchronously, so nothing can slip in between.
    if (engineLocks.isLadderBusy()) {
      return { success: false, message: engineLocks.describeBusy('ladder') };
    }
    // resetCycle() treats a DRAINING lifecycle as "this cycle boundary is the
    // close trigger" and transitions straight to CLOSED (stopping the engine
    // via onLifecycleClosed) — an operator clicking "resume buying" while the
    // fund happens to also be draining must not silently close/stop it
    // instead (issue #232 follow-up).
    if (positionState.lifecycle === LIFECYCLE.DRAINING || positionState.lifecycle === LIFECYCLE.CLOSED) {
      return { success: false, message: `Fund lifecycle is ${positionState.lifecycle} — cycle reset is not applicable` };
    }
    // resetCycle() unconditionally nulls positionState.activeTpOrderId/assetOnOrder
    // without cancelling the exchange order first — safe when it's called after
    // that TP already filled (its only other call sites), but in legacy core
    // mode (celestialEnabled: false) hitting the cycle-buy cap does NOT imply
    // the TP filled — it's typically still resting live, covering the whole
    // accumulated position. Wiping tracking here would orphan a real order: a
    // later fill would arrive with no positionState.activeTpOrderId to match,
    // and a restart before it fills would lose the ability to restore it
    // (issue #232 follow-up). Celestial mode is unaffected — its TPs live on
    // each body, not on this legacy field.
    if (positionState.activeTpOrderId) {
      return { success: false, message: 'A take-profit order is still resting — cancel or wait for it before resetting the cycle' };
    }
    logger.info(`🔄 [${exchange}] Operator reset-cycle: cycleBuys ${positionState.cycleBuys} -> 0, starting new cycle`);
    await resetCycle({ resetKind: 'operator' });
    await saveLiveState();
    return { success: true, message: 'Cycle reset — buying re-enabled', status: getStatus() };
  };

  /**
   * Manually set the TP% for a specific celestial body.
   * Cancels the existing TP, then re-places it at the specified percentage above avgPrice.
   * The override is subject to the fee floor (cannot be set so low it loses money).
   * @param {string} bodyId
   * @param {number} tpPct - Desired TP% (e.g. 2.5 means 2.5% above avgPrice)
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const setBodyTpPercent = async (bodyId, tpPct) => {
    if (!getIsRunning()) return { success: false, message: 'Engine not running' };

    const body = (positionState.celestialBodies || []).find(b => b.id === bodyId);
    if (!body) return { success: false, message: `Body ${bodyId.slice(-8)} not found` };

    if (body.tpOrderId) {
      const outcome = await cancelBodyTpForReplace(body, 'Manual TP edit');
      if (outcome !== 'cancelled') {
        // A tranche that sold during the cancel was booked by the helper,
        // which also re-placed a right-sized TP — the operator can retry the
        // edit against the reduced body.
        const reason = {
          filled: 'already filled',
          unresolved: 'cancel failed',
          booked: 'sold during cancel — sale booked and the TP re-sized to what the body still holds; retry to apply the new TP',
          booking_failed: 'sold during cancel — booking deferred to reconciliation',
        }[outcome];
        saveLiveState();
        const state = getState();
        if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(state);
        return { success: false, message: `Existing TP ${reason}`, status: state };
      }
    }

    body.manualTpPct = tpPct;
    body._overrideTpPct = tpPct;
    const placed = await placeBodyTp(body);

    if (!placed) {
      return { success: false, message: `Could not place TP at ${tpPct.toFixed(2)}% — below fee floor or invalid` };
    }

    const tierCfg = celestialHierarchy.getTierConfig(body.tier);
    logger.info(`${tierCfg.emoji} [${exchange}] Manual TP% set: body ${body.id.slice(-8)} @ ${tpPct.toFixed(2)}% → ${fmtPrice(body.tpPrice)}`);

    saveLiveState();
    const state = getState();
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(state);

    return {
      success: true,
      message: `TP set to ${body.tpPrice ? fmtPrice(body.tpPrice) : `${tpPct.toFixed(2)}%`} for body ${bodyId.slice(-8)}`,
      status: state,
    };
  };

  /**
   * Manually set the TP limit price for a specific celestial body.
   * Converts to TP% internally and delegates to the same placement flow.
   * @param {string} bodyId
   * @param {number} limitPrice - Desired limit price (must be above avgPrice + fee floor)
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const setBodyTpPrice = async (bodyId, limitPrice) => {
    const body = (positionState.celestialBodies || []).find(b => b.id === bodyId);
    if (!body) return { success: false, message: `Body ${bodyId.slice(-8)} not found` };
    if (body.avgPrice <= 0) return { success: false, message: 'Body has no avg price' };
    if (limitPrice <= body.avgPrice) return { success: false, message: `Price must be above avg cost ${fmtPrice(body.avgPrice)}` };

    const tpPct = ((limitPrice - body.avgPrice) / body.avgPrice) * 100;
    return setBodyTpPercent(bodyId, tpPct);
  };

  /**
   * Force rebuild of TP sell order with current position
   * Useful when position state was corrected manually
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const rebuildTP = async () => {
    if (!getIsRunning()) {
      return { success: false, message: 'Engine not running' };
    }
    if (positionState.totalAsset <= 0) {
      return { success: false, message: 'No position to protect' };
    }
    logger.info(`🔄 [${exchange}] Manual TP rebuild requested for ${positionState.totalAsset.toFixed(8)} ${baseCurrency}`);
    await placeTakeProfitOrder({ forceUpdate: true });
    return { success: true, message: `TP rebuilt for ${positionState.totalAsset.toFixed(8)} ${baseCurrency} @ ${fmtPrice(positionState.lastTpPrice)}` };
  };

  /**
   * Preview what a ladder rebuild would place (dry calculation, no orders)
   * @returns {Promise<{success: boolean, message?: string, preview?: Object}>}
   */
  const previewLadder = async () => {
    if (!getIsRunning()) {
      return { success: false, message: 'Engine not running' };
    }
    if ((config.entryMode || 'reactive') !== 'ladder') {
      return { success: false, message: 'Entry mode is not ladder' };
    }

    const allocatedCapital = getAllocatedCapital();
    let remainingBudget = config.maxUsdcDeployed - allocatedCapital;

    // Fetch actual exchange balance to cap budget at reality
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await lookupOrNull('getAccountBalance', quoteCurrency, getAdapter().getAccountBalance(quoteCurrency));
    const exchangeBalance = quoteBalance ? (parseFloat(quoteBalance.available) || 0) : null;
    if (exchangeBalance !== null && exchangeBalance < remainingBudget) {
      remainingBudget = exchangeBalance;
    }

    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      const budgetRemaining = (config.maxUsdcDeployed - allocatedCapital).toFixed(2);
      const balanceStr = exchangeBalance !== null ? `$${exchangeBalance.toFixed(2)}` : 'unknown';
      return { success: false, message: `Exchange ${quoteCurrency} balance (${balanceStr}) below min order ($${config.baseSizeUsdc || 50}). Budget shows $${budgetRemaining} remaining but exchange only has ${balanceStr} ${quoteCurrency}.` };
    }

    const ladder = buildLadderFromMarket(getMarketState(), remainingBudget, getPriceIncrement(), allocatedCapital);

    return {
      success: true,
      preview: {
        levelCount: ladder.levels.length,
        levels: ladder.levels.map(l => ({
          price: l.price,
          sizeUsdc: l.sizeUsdc,
          assetQty: l.assetQty,
          distancePct: l.distancePct,
        })),
        lowerBound: ladder.lowerBound,
        lowerBoundPct: ladder.lowerBoundPct,
        totalBudget: ladder.totalBudget,
        allocatedCapital,
        exchangeBalance,
        maxUsdcDeployed: config.maxUsdcDeployed,
        currentPrice: getMarketState().lastPrice,
      },
    };
  };

  /**
   * Cancel existing ladder orders and rebuild from scratch
   * Bypasses health/regime guards (user-initiated)
   *
   * Holds the ladder lock from the first check to the last placement (#766),
   * so a TP close's resetCycle that lands mid-rebuild queues behind it and
   * then sweeps the fresh ladder, and a rebuild requested mid-reset runs
   * after the reset. Gives up with a busy message if another sweep is stuck.
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const rebuildLadder = () => engineLocks.withLadderLock(rebuildLadderLocked, {
    onTimeout: 'refuse',
    label: 'Ladder rebuild',
    exchange,
  });

  /** @returns {Promise<{success: boolean, message: string}>} */
  const rebuildLadderLocked = async () => {
    if (!getIsRunning()) {
      return { success: false, message: 'Engine not running' };
    }
    if ((config.entryMode || 'reactive') !== 'ladder') {
      return { success: false, message: 'Entry mode is not ladder' };
    }
    // A draining/closed fund places no new buys — rebuild included (#1009).
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) {
      return { success: false, message: `Fund is ${positionState.lifecycle} — new entries are blocked` };
    }
    const isAdmitted = captureEntryAdmission();
    // A manual rebuild places fresh buy rungs — the drawdown pause (#693)
    // applies; the operator clears it explicitly via Resume first.
    if (riskManager.getState().isDrawdownPaused) {
      return { success: false, message: 'Drawdown pause active — resume from the drawdown pause before rebuilding the ladder' };
    }
    // Don't start a ladder sweep mid-fill/merge/reconcile (same gate as
    // resetCycleBuys): a TP close's resetCycle runs inside a fill and sweeps
    // the ladder itself, and a sweep started underneath it can book a
    // mid-cancel rung while the cycle turns over (issue #711).
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }

    const allocatedCapital = getAllocatedCapital();
    let remainingBudget = config.maxUsdcDeployed - allocatedCapital;
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await lookupOrNull('getAccountBalance', quoteCurrency, getAdapter().getAccountBalance(quoteCurrency));
    if (!quoteBalance) {
      return { success: false, message: 'Could not fetch account balance — skipping ladder' };
    }
    const availableQuote = parseFloat(quoteBalance.available) || 0;
    if (availableQuote < remainingBudget) {
      remainingBudget = availableQuote;
    }
    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      const budgetRemaining = (config.maxUsdcDeployed - allocatedCapital).toFixed(2);
      return { success: false, message: `Exchange ${quoteCurrency} balance ($${availableQuote.toFixed(2)}) below min order size ($${config.baseSizeUsdc || 50}). Budget says $${budgetRemaining} available but only $${availableQuote.toFixed(2)} ${quoteCurrency} on exchange. Deposit more ${quoteCurrency} or lower baseSizeUsdc.` };
    }

    logger.info(`🔄 [${exchange}] Manual ladder rebuild requested, budget=$${remainingBudget.toFixed(2)} (allocated=$${allocatedCapital.toFixed(2)})`);

    // Re-check after the balance await above: don't size a ladder against a
    // position a fill that started meanwhile is still mutating (issue #711).
    // A fill that starts AFTER this point and closes the cycle no longer
    // races the sweep: its resetCycle queues on the ladder lock this rebuild
    // holds, then cancels the ladder placed below (#766).
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }

    // Cancel existing ladder orders
    let midCancelSpend = 0;
    let partialFillReservations = [];
    let unbookedFills = [];
    if (positionState.ladderActive) {
      const cancelResult = await getOrderExecutor().cancelAllLadderOrders();
      // The cost estimate covers newly recorded partial tranches for the
      // balance clamp. The reservation details let the deployed-cap check
      // below distinguish a booked body from a poll callback still in flight.
      midCancelSpend = Number(cancelResult.partialFillsCost) || 0;
      partialFillReservations = Array.isArray(cancelResult.partialFillReservations) ? cancelResult.partialFillReservations : [];
      unbookedFills = Array.isArray(cancelResult.unbookedFills) ? cancelResult.unbookedFills : [];
      const filledDuringCancel = midCancelSpend + unbookedFills.reduce((sum, u) => sum + (Number(u.cost) || 0), 0);
      const spendNote = filledDuringCancel > 0 ? ` ($${filledDuringCancel.toFixed(2)} filled during the cancel)` : '';
      logger.info(`🧹 [${exchange}] Cancelled ${cancelResult.cancelled} existing ladder orders${spendNote}`);
    }

    // Reset ladder state
    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // A rung can partially fill in the race window before the cancel above
    // took, and that fill is now booked into a body synchronously as part of
    // cancelAllLadderOrders (issue #674) — re-derive the budget from the
    // CURRENT state before sizing the new ladder, so a fill discovered
    // mid-cancel isn't missing from the math.
    //
    // Cash: the clamp must not size rungs against quote those fills spent
    // (issue #711). Where filling happened, re-read the balance: on exchanges
    // that hold quote for resting orders the fill was paid from the hold, so
    // the pre-cancel snapshot already excludes it and subtracting again would
    // wrongly starve the rebuild; elsewhere the fresh read reflects the spend.
    // Capped at the pre-cancel snapshot so a rebuild with a fill sizes the
    // same as one without (released holds are not newly counted). If the
    // re-read fails, fall back to subtracting the spend (conservative).
    const cancelTimeSpend = midCancelSpend + unbookedFills.reduce((sum, u) => sum + (Number(u.cost) || 0), 0);
    let postCancelQuote = availableQuote;
    if (cancelTimeSpend > 0) {
      const freshBalance = await lookupOrNull('getAccountBalance', quoteCurrency, getAdapter().getAccountBalance(quoteCurrency));
      postCancelQuote = freshBalance
        ? Math.min(availableQuote, parseFloat(freshBalance.available) || 0)
        : Math.max(0, availableQuote - cancelTimeSpend);
    }
    // Deployed cap: derived after that await, so a fill committed during it
    // is counted and the new ladder can't push deployed capital past
    // maxUsdcDeployed. Partial and fully-filled rungs both reserve only the
    // size the persisted ledger still lacks; any recorded tranche is already
    // represented in a body's costBasis or was sold and its capital returned.
    // A polled partial may still be waiting on its fire-and-forget booking
    // callback when the cancel sweep returns. Reserve that tranche just like a
    // completely-filled rung, re-reading the ledger now so a callback that
    // finished during the sweep is not counted twice. Do not await those
    // callbacks here: a TP-close booking can be queued on the ladder lock this
    // rebuild owns.
    const unbookedSpend = [...unbookedFills, ...partialFillReservations].reduce((sum, u) => {
      const unbookedSize = Math.max(0, (Number(u.filledSize) || 0) - fillLedger.getRecordedSizeForOrder(u.orderId));
      return sum + unbookedSize * (Number(u.unitCost) || 0);
    }, 0);
    const postCancelAllocated = getAllocatedCapital() + unbookedSpend;
    remainingBudget = Math.min(config.maxUsdcDeployed - postCancelAllocated, postCancelQuote);
    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      return { success: false, message: `Budget dropped below min order size after a fill landed during ladder cancel ($${remainingBudget.toFixed(2)} left — $${(config.maxUsdcDeployed - postCancelAllocated).toFixed(2)} under the deployed cap, $${postCancelQuote.toFixed(2)} ${quoteCurrency} available). The old ladder was cancelled but not rebuilt — call rebuildLadder again if appropriate.` };
    }
    if (postCancelAllocated !== allocatedCapital || postCancelQuote !== availableQuote) {
      logger.info(`🔄 [${exchange}] Re-derived ladder budget after a cancel-time fill: $${remainingBudget.toFixed(2)} (allocated=$${postCancelAllocated.toFixed(2)}, was $${allocatedCapital.toFixed(2)}; available ${quoteCurrency}=$${postCancelQuote.toFixed(2)}, was $${availableQuote.toFixed(2)})`);
    }

    // Build new ladder
    const ladder = buildLadderFromMarket(getMarketState(), remainingBudget, getPriceIncrement(), postCancelAllocated);

    if (ladder.levels.length === 0) {
      return { success: false, message: 'Ladder build produced 0 levels — price may be at or below floor' };
    }

    logger.info(`📊 [${exchange}] Rebuilding ladder: ${ladderCalculator.getSummary(ladder)}`);

    // Place ladder orders
    const generationAtPlace = getCycleResetGeneration();
    const result = await getOrderExecutor().placeLadderOrders(ladder.levels, { isAdmitted });
    if (await abandonLadderPlacedAcrossReset(generationAtPlace, 'Ladder rebuild')) {
      return { success: false, message: 'A cycle reset ran while the new ladder was being placed, so it was cancelled — rebuild again if appropriate.' };
    }
    if (result.notAdmitted && result.orders.length === 0) {
      saveLiveState();
      return { success: false, message: 'The engine stopped or the fund started draining before the new ladder was placed — the old ladder was cancelled and no new rungs went out.' };
    }

    // Update position state
    positionState.ladderActive = true;
    positionState.ladderPlacedAt = Date.now();
    positionState.ladderLowerBound = ladder.lowerBound;
    positionState.pendingLadderOrders = result.orders;

    const msg = `Ladder rebuilt: ${result.orders.length} levels from ${fmtPrice(getMarketState().lastPrice)} to ${fmtPrice(ladder.lowerBound)}${result.failedCount > 0 ? ` (${result.failedCount} failed)` : ''}`;
    logger.info(`📊 [${exchange}] ${msg}`);

    tradeEvents.emitTradeEvent('ladder_placed', exchange, `${result.orders.length} levels to ${fmtPrice(ladder.lowerBound)}`, {
      levels: result.orders.length,
      topPrice: getMarketState().lastPrice,
      bottomPrice: ladder.lowerBound,
      lowerBoundPct: ladder.lowerBoundPct,
      totalBudget: ladder.totalBudget,
      failedCount: result.failedCount,
      manual: true,
    });

    // Persist state
    saveLiveState();

    return { success: true, message: msg };
  };

  /**
   * Cancel the ladder and switch to reactive entries. Serialised with the
   * other ladder sweeps on the ladder lock (#766) — see rebuildLadder.
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const cancelLadder = () => engineLocks.withLadderLock(cancelLadderLocked, {
    onTimeout: 'refuse',
    label: 'Ladder cancel',
    exchange,
  });

  /** @returns {Promise<{success: boolean, message: string}>} */
  const cancelLadderLocked = async () => {
    if (!getIsRunning()) return { success: false, message: 'Engine not running' };
    // Same gate as rebuildLadder (issue #711): don't sweep the ladder
    // underneath an in-flight fill/merge/reconcile.
    if (engineLocks.isMutatingPosition()) {
      return { success: false, message: engineLocks.describeBusy('position') };
    }

    const hadLadder = positionState.ladderActive;
    let cancelled = 0;

    if (hadLadder) {
      const result = await getOrderExecutor().cancelAllLadderOrders();
      cancelled = result.cancelled;
      logger.info(`🧹 [${exchange}] Cancelled ${cancelled} ladder orders`);
    }

    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // Switch config to reactive
    config.entryMode = 'reactive';
    updateRegimeConfig(exchange, pair, { entryMode: 'reactive' });

    saveLiveState();

    const msg = hadLadder
      ? `Cancelled ${cancelled} ladder orders, switched to reactive mode`
      : 'No active ladder — switched to reactive mode';
    logger.info(`🔄 [${exchange}] ${msg}`);
    return { success: true, message: msg };
  };

  /**
   * Inject an externally-created celestial body into the running engine.
   * Syncs position aggregates, saves state, places TP, and saves again.
   * @param {Object} body - A body created via celestialHierarchy.createNewBody()
   * @returns {Promise<{success: boolean, bodyId: string, tpPlaced: boolean}>}
   */
  const injectBody = async (body) => {
    if (!getIsRunning()) return { success: false, error: 'Engine not running' };
    positionState.celestialBodies = positionState.celestialBodies || [];
    // Defense in depth (issue #691): the caller (manual-trade-import's
    // importBuy) is expected to guard against re-injecting a body for a
    // retried buy, but a duplicate here would place a second live TP sell
    // for the same fill, eating into other bodies' inventory/holdback. Refuse
    // a body whose id already exists, or whose originating buy order is
    // already committed to a live body — checking the FULL sourceOrderIds/
    // buyOrders collections, not just index [0]: mergeIntoBody
    // (celestial-hierarchy.js) concatenates a merged-away body's
    // sourceOrderIds onto the survivor's, so a since-merged buy order can sit
    // anywhere in that array, not only at the front. Same predicate as
    // isBuyAlreadyCommitted (issue #131), inlined here to keep the matching
    // body reference for the error result.
    const injectedOrderId = body.sourceOrderIds?.[0];
    const duplicate = positionState.celestialBodies.find(
      (b) => b.id === body.id
        || (injectedOrderId && (
          (b.sourceOrderIds || []).includes(injectedOrderId)
          || (b.buyOrders || []).some((bo) => bo.orderId === injectedOrderId)
        ))
    );
    if (duplicate) {
      logger.warn(`⚠️ [${exchange}] Injected body ${body.id} refused: duplicate of existing body ${duplicate.id} (source order ${duplicate.sourceOrderIds?.[0]})`);
      return { success: false, error: 'duplicate body', bodyId: duplicate.id, tpPlaced: !!duplicate.tpOrderId };
    }
    positionState.celestialBodies.push(body);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    // Make the accepted body durable BEFORE the first TP-placement await
    // (issue #1022): a live TP must never exist for a body regime-state.json
    // does not hold. If this save throws, take the body back out so nothing
    // (this call or the next safety-net tick) places a TP for it, and let the
    // throw reach the importer, whose pending intent re-publishes it later.
    try {
      saveLiveState();
    } catch (err) {
      const idx = positionState.celestialBodies.indexOf(body);
      if (idx !== -1) positionState.celestialBodies.splice(idx, 1);
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      throw err;
    }
    const tpResult = await placeBodyTp(body);
    saveLiveState();
    logger.info(`📦 [${exchange}] Injected body ${body.id} (${body.tier}): ${body.assetQty} BTC @ $${body.avgPrice.toFixed(2)}, TP placed: ${!!tpResult}`);
    return { success: true, bodyId: body.id, tpPlaced: !!tpResult };
  };

  /** Body ids with an extendBody in progress. */
  const extendInFlight = new Set();

  /**
   * Extend an already-live body with fills for its OWN buy order that
   * arrived after the body was first created (issue #726): the buy order
   * was still filling at first import, so the body — and its already-placed
   * TP — were sized only to the fills seen at that time. A later retry with
   * the fuller fill set must not silently drop the difference (the omission
   * this function exists to close).
   *
   * Grows assetQty/costBasis/avgPrice via the same celestialHierarchy.
   * mergeIntoBody a live DCA-buy-fill merge uses, then cancels and
   * re-places the body's TP (mirrors setBodyTpPercent/the startup reprice
   * pass, via cancelBodyTpForReplace — issue #670) so it covers the grown
   * assetQty. Per CLAUDE.md, `assetQty - assetOnOrder` IS the designed
   * holdback — but only for the BOUNDED, PLANNED fraction
   * calculateTakeProfitSize computes at TP-placement time. Leaving a stale
   * TP in place after growing assetQty would silently balloon that fraction
   * past what was ever planned: at sell time `proratedCostBasis` shrinks
   * (it's `costBasis × soldQty/assetQty`, and assetQty just grew) while the
   * unsold remainder grows, so the new fill's real cost basis is never
   * charged to `bodyPnl` and the fill's whole value leaks into
   * `bodyHoldbackAsset` as fabricated zero-cost profit — inflating Total
   * P&L.
   *
   * Idempotent across a crash between this call succeeding (saveLiveState
   * below) and the caller's own fill-ledger linkage write, AND across
   * compounding retries where more of the order fills again before the
   * ledger link ever lands (the naive "compare a
   * caller-computed delta's total against already-recorded" version of this
   * check still double-counted: if extend #1 applies d1 but crashes before
   * the ledger link, and MORE fills (d2) arrive before the retry, the
   * retry's caller-computed delta covers d1+d2 again, re-adding the
   * already-applied d1). `totals` is therefore the buy order's FULL current
   * totals — every fill known for it, linked or not — not a delta. This
   * function computes the exact shortfall itself: what `totals` says should
   * be recorded, minus what this body's own `buyOrders` bookkeeping already
   * shows recorded for that orderId. That shortfall is merged (never
   * `totals` directly), so however many times this is called for the same
   * buyOrderId, in whatever order relative to crashes or new fills, the
   * body converges to exactly `totals` — never more.
   *
   * A top-level accounting writer like a fill or a merge (#1959): while a
   * backup holds the fence it parks BEFORE cancelling the body's TP, then
   * re-checks the engine and the body once the hold is released.
   *
   * @param {string} bodyId - Body to extend (must still be live in this engine)
   * @param {{assetQty:number, costBasis:number, avgPrice:number}} totals - buyOrderId's FULL current fill totals (not a delta)
   * @param {string} buyOrderId - The buy order `totals` describes
   * @returns {Promise<{success: boolean, error?: string, bodyId?: string, tier?: string, alreadyApplied?: boolean, tpPlaced?: boolean}>}
   */
  const extendBody = (bodyId, totals, buyOrderId) =>
    engineLocks.withBackupFence(() => extendBodyFenced(bodyId, totals, buyOrderId));

  /**
   * extendBody past the backup fence.
   * @param {string} bodyId
   * @param {{assetQty:number, costBasis:number, avgPrice:number}} totals
   * @param {string} buyOrderId
   * @returns {Promise<{success: boolean, error?: string, bodyId?: string, tier?: string, alreadyApplied?: boolean, tpPlaced?: boolean}>}
   */
  const extendBodyFenced = async (bodyId, totals, buyOrderId) => {
    if (!getIsRunning()) return { success: false, error: 'Engine not running' };
    const body = (positionState.celestialBodies || []).find((b) => b.id === bodyId);
    if (!body) return { success: false, error: 'Body not found' };
    // One extend per body at a time (#752): a second caller (a recalc's
    // recovered-row growth, a manual import) would compute the same shortfall
    // before the first merged it, then merge it again after its own cancel —
    // and its cancel could null a TP the first had just re-placed.
    if (extendInFlight.has(body.id)) {
      return { success: false, error: 'Extend already in progress for this body — retry once it settles' };
    }
    extendInFlight.add(body.id);
    try {
      return await extendBodyLocked(body, totals, buyOrderId);
    } finally {
      extendInFlight.delete(body.id);
    }
  };

  /**
   * extendBody's work, run while the body holds its extendInFlight slot.
   * @param {Object} body
   * @param {{assetQty:number, costBasis:number, avgPrice:number}} totals
   * @param {string} buyOrderId
   * @returns {Promise<{success: boolean, error?: string, bodyId?: string, tier?: string, alreadyApplied?: boolean, tpPlaced?: boolean}>}
   */
  const extendBodyLocked = async (body, totals, buyOrderId) => {
    const { recordedQty, shortfall } = celestialHierarchy.computeBuyOrderShortfall(body, totals, buyOrderId);
    if (!shortfall) {
      logger.info(`📦 [${exchange}] Extend for body ${body.id} / buy ${buyOrderId} already applied (${recordedQty} >= ${totals.assetQty}) — no-op retry`);
      return { success: true, bodyId: body.id, tier: body.tier, alreadyApplied: true };
    }

    // Cancel the existing TP BEFORE growing the body, so the re-place below
    // sizes against the grown assetQty, not the stale one.
    if (body.tpOrderId) {
      const cancelOutcome = await cancelBodyTpForReplace(body, 'Manual buy extend');
      if (cancelOutcome !== 'cancelled') {
        // 'booked' / 'booking_failed': a tranche sold during the cancel —
        // cancelBodyTpForReplace already booked that sale (or deferred it
        // to reconciliation) and re-placed a right-sized TP for the body's
        // NEW (reduced) shape itself, through the normal sell path. Merging
        // this extend on top now would race whatever that path just did.
        // 'filled' / 'unresolved': nothing was touched. Either way, fail
        // this attempt so the caller's ledger rows stay unlinked and
        // retryable (its contract) rather than silently dropping the fill
        // or double-booking against a body that just changed underneath us.
        saveLiveState();
        return { success: false, error: `Existing TP ${cancelOutcome} — retry the extend once reconciled` };
      }
    }

    celestialHierarchy.mergeIntoBody(body, shortfall, config.maxUsdcDeployed, buyOrderId, logger);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    const tpResult = await placeBodyTpWithRetry(body, 'ManualExtend');
    saveLiveState();
    logger.info(`📦 [${exchange}] Extended body ${body.id} (${body.tier}) with ${shortfall.assetQty} additional ${baseCurrency} from buy ${buyOrderId} (now ${body.assetQty} ${baseCurrency} total, TP re-placed: ${!!tpResult})`);
    return { success: true, bodyId: body.id, tier: body.tier, tpPlaced: !!tpResult };
  };

  return {
    updatePosition,
    extendBodiesFromRecoveredBuyRows,
    recalculateAndRefresh,
    _mergeBodyImpl,
    manualMergeBody,
    rollupAllBodies,
    resetCycleBuys,
    setBodyTpPercent,
    setBodyTpPrice,
    rebuildTP,
    previewLadder,
    rebuildLadder,
    cancelLadder,
    injectBody,
    extendBody,
    isExtendInFlight: () => extendInFlight.size > 0,
  };
};

module.exports = { createOperatorActions };
