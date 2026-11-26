'use strict';

/**
 * The reconcile loop for one fund: one pass (`reconcileTick`) and the steps it
 * dispatches — the entry-fill poll, the orphaned entry/ladder sweep, the legacy
 * single-TP check, the per-body TP check and the recovered-position merge —
 * plus `catchUpTerminalEntry`, which the orphan sweep shares with startup
 * recovery. Extracted verbatim from regime-engine (issue #1979); the engine
 * wires `createReconcileLoop({...})`, keeps the same `_test` entries and passes
 * `catchUpTerminalEntry` on to startup recovery.
 *
 * The engine still owns the cadence: `startReconciliation`, its interval
 * handle and the backup-fence / pending-write wrapper around each tick stay in
 * regime-engine. A pass takes the reconcile lock through the engine's own
 * `engineLocks` and holds it until every dispatched chain settles (#189). The
 * dedup stores the orphan sweep consults (`recentlyProcessedFills`,
 * `incompleteFillRetries`) are the engine's own, passed in by reference.
 *
 * Nothing here books P&L: a fill the loop detects is routed through the
 * engine's own `handleOrderFill` (or `bookTpCancelExecution`), so realized P&L
 * still comes only from the fill ledger's cycle-pair annotations
 * (refreshRealizedFromCyclePairs).
 *
 * `positionState` is passed directly: the engine keeps one object identity
 * (replacePositionState, #1594). `getIsRunning`, `getAdapter`,
 * `getOrderExecutor` and `getRecoveryModule` are accessors because the engine
 * reassigns those bindings (start/stop, tests swapping the exchange deps).
 */

const celestialHierarchy = require('./celestial-hierarchy');
const { isFilledStatus, isCancelledStatus, isTerminalStatus, isOrderNotFoundError, isOrderStillOpen } = require('./shared-utils');
const { buildPartialFillData } = require('./regime-pure-helpers');

/**
 * @param {Object} deps
 * @returns {{catchUpTerminalEntry: Function, reconcileEntryFills: Function, sweepOrphanedSavedOrders: Function, reconcileLegacyTp: Function, reconcileBodyTps: Function, reconcileRecoveredPosition: Function, reconcileTick: Function}}
 */
const createReconcileLoop = ({
  exchange, productId, isDryRun, config, logger,
  positionState, fillLedger, healthMonitor, positionSizer, engineLocks,
  // Dedup stores owned by the engine's polled-fill path
  recentlyProcessedFills, incompleteFillRetries,
  getIsRunning, getAdapter, getOrderExecutor, getRecoveryModule,
  lookupOrNull, restoredEntryStaleMs, stampKnownFilledSize,
  // Live fill pipeline and TP placement
  handleOrderFill, knownTpCancelExecution, bookTpCancelExecution,
  cancelBodyTpForReplace, placeBodyTp,
  // Steps a pass runs before it dispatches its own
  reconcilePendingPlacements, completeOwedCycleReset,
  // State persistence (regime-state-persistence)
  saveLiveState,
}) => {
  /**
   * Build the payload orderExecutor.restorePendingOrder expects from a saved
   * pendingEntryOrders/pendingLadderOrders row, shared by catchUpTerminalEntry's
   * failure path and reconcileTick's still-resting orphan re-arm.
   * @param {{price?: number, assetQty?: number, sizeUsdc?: number, placedAt?: number, staleMs?: number, ladderIndex?: number}} savedEntry
   * @param {'entry'|'ladder_entry'} entryType
   */
  const buildRestoreSpec = (savedEntry, entryType) => {
    const restoreSpec = {
      type: entryType,
      price: savedEntry.price,
      size: savedEntry.assetQty,
      sizeUsdc: savedEntry.sizeUsdc,
      placedAt: savedEntry.placedAt || Date.now(),
    };
    if (entryType === 'entry') restoreSpec.staleMs = restoredEntryStaleMs(savedEntry);
    if (entryType === 'ladder_entry' && savedEntry.ladderIndex !== undefined) {
      restoreSpec.ladderIndex = savedEntry.ladderIndex;
    }
    return restoreSpec;
  };

  /**
   * Route a single already-terminal (FILLED, or CANCELLED/EXPIRED with a
   * partial) saved entry/ladder order through the canonical fill pipeline —
   * or report it safe to retire when it's a genuinely empty cancel.
   *
   * Shared by startImpl's offline entry catch-up and reconcileTick's orphan
   * sweep (issues #673, #764), so both honor a saved row's knownFilledSize
   * and handle a failed handleOrderFill the same retry-safe way (issue #679's
   * stricter getOrderFills contract: a throw must not silently drop a real
   * fill).
   *
   * @param {{orderId: string, price?: number, assetQty?: number, sizeUsdc?: number, placedAt?: number, ladderIndex?: number, knownFilledSize?: number}} savedEntry
   * @param {Parameters<typeof buildPartialFillData>[2]} orderStatus - already known to be terminal (FILLED/CANCELLED/EXPIRED/FAILED)
   * @param {'entry'|'ladder_entry'} [entryType]
   * @returns {Promise<{outcome: 'filled'|'empty'|'failed', error?: Error}>}
   */
  const catchUpTerminalEntry = async (savedEntry, orderStatus, entryType = 'entry') => {
    const isFullFilled = isFilledStatus(orderStatus);
    // A later independent poll of an already-cancelled order can under-report
    // filledSize versus what was already resolved (via order-executor's own
    // partialFillTracker high-water mark) at the moment it was first detected
    // cancelled — the same adapter quirk handleCancelledOrder's own fallback
    // exists for. onEntryCancelled stamps that resolved value onto the saved
    // row as knownFilledSize before this function ever sees it; never trust a
    // fresh read that's SMALLER than what's already confirmed known (issue #673).
    const partialSize = Math.max(parseFloat(String(orderStatus.filledSize || 0)), savedEntry.knownFilledSize || 0);
    if (!isFullFilled && partialSize <= 0) {
      return { outcome: 'empty' }; // truly empty cancel — safe for the caller to purge, no fill to record
    }
    logger.info(
      `📥 [${exchange}] Catching up terminal ${entryType} ${savedEntry.orderId.slice(0, 8)}: status=${orderStatus.status}, filled=${partialSize}`,
      { orderId: savedEntry.orderId, entryType, status: orderStatus.status, filledSize: partialSize }
    );
    getOrderExecutor().markSettled(savedEntry.orderId);
    try {
      await handleOrderFill(buildPartialFillData(savedEntry.orderId, 'buy', orderStatus, {
        status: isFullFilled ? 'FILLED' : orderStatus.status,
        isPartialFill: !isFullFilled,
        placedAt: savedEntry.placedAt,
        // Override with the max-of-known size computed above — orderStatus's
        // own (possibly stale) filledSize must not silently win over a
        // confirmed higher known value.
        filledSize: partialSize,
      }));
      return { outcome: 'filled' };
    } catch (err) {
      // The status lookup above already proved this order has a real fill —
      // losing this catch-up attempt must not silently drop it. Re-arm
      // executor tracking for the SAME orderId so the ordinary live polling
      // path (checkPendingOrderFills → onFillDetected, with its own #679
      // bounded engine-level retry) rediscovers and re-processes it on the
      // next tick, instead of leaving it an orphan indefinitely.
      logger.warn(
        `⚠️ [${exchange}] Failed to catch up terminal ${entryType} ${savedEntry.orderId.slice(0, 8)}: ${err.message} — re-arming tracking for retry instead of dropping it`,
        { orderId: savedEntry.orderId, entryType, error: err.message, incompleteFills: err.incompleteFills === true }
      );
      // Persist the size this attempt resolved onto the saved row (issue
      // #764): restorePendingOrder does not repopulate the executor's
      // partialFillTracker, so if the re-armed order is later re-detected
      // cancelled through checkPendingOrderFills → handleCancelledOrder with
      // an under-reporting status, knownFilledSize is the only record of the
      // partial. Stamp the caller's row object too — startImpl re-adds its
      // pre-catch-up snapshot row when handleOrderFill already dropped the
      // live one before throwing.
      if (partialSize > 0) {
        savedEntry.knownFilledSize = Math.max(savedEntry.knownFilledSize || 0, partialSize);
        stampKnownFilledSize(savedEntry.orderId, partialSize);
      }
      getOrderExecutor().restorePendingOrder(savedEntry.orderId, buildRestoreSpec(savedEntry, entryType));
      return { outcome: 'failed', error: err };
    }
  };

  /**
   * Reconcile step: poll the executor for entry fills the WebSocket may have
   * missed and stamp order-status liveness. Returns the dispatched chain, or null.
   */
  const reconcileEntryFills = () => {
    // Check for entry fills that WebSocket might have missed
    if (!getOrderExecutor().capabilities?.liveReconciliation) return null;
    return getOrderExecutor().checkPendingOrderFills()
      .then(result => {
        // A SUCCESSFUL order-status poll proves the order-status REST path
        // is alive even when no WS order event has arrived. lastOrderUpdateMs
        // was otherwise refreshed ONLY by WS order events, so a resting TP
        // that legitimately goes quiet for >staleOrdersMs (default 60s, equal
        // to reconcileIntervalMs) tripped stale_orders → SAFE during normal
        // operation. Gate on result.polled > 0 (at least one getOrder
        // round-trip actually returned) — NOT on mere promise resolution:
        // getOrder failures are swallowed to null, so resolving with zero
        // successful polls (REST down, or no pending orders) must NOT stamp
        // liveness, or the stale-orders net couldn't detect a simultaneously
        // dead WS feed + dead REST poll (issue #110 M6).
        if (result.polled > 0) healthMonitor.recordOrderUpdate();
        if (result.filled > 0 || result.cancelled > 0) {
          logger.info(`🔄 [${exchange}] Reconcile fill check: ${result.filled} filled, ${result.cancelled} cancelled`);
        }
      })
      .catch(err => {
        logger.error(`❌ [${exchange}] Fill check failed: ${err.message}`, { error: err.message });
      });
  };

  /**
   * Reconcile step: re-detect saved entry/ladder orders that fell out of executor
   * tracking (issue #673). Returns the dispatched chain, or null.
   */
  const sweepOrphanedSavedOrders = () => {
    // Sweep for saved entry/ladder orders that have fallen out of the
    // executor's own tracking without ever reaching a terminal outcome in
    // positionState (issue #673). checkPendingOrderFills (above) and
    // handleCancelledOrder both delete a terminal order from
    // orderExecutor's pendingOrders BEFORE invoking onFillDetected, and
    // onFillDetected's engine-level retry (issue #679) is bounded — once it
    // exhausts its retries it gives up, but only a SUCCESSFUL
    // handleOrderFill removes the row from positionState.pendingEntryOrders
    // / pendingLadderOrders. Nothing else re-polled those lists at
    // runtime — only the startup catch-up did — so a transient error after
    // a buy fill could leave it invisible to both the executor and the
    // fill pipeline until the process restarted. This sweep re-detects the
    // gap every reconcile tick instead.
    if (!getOrderExecutor().capabilities?.liveReconciliation) return null;
    return (async () => {
      const trackedIds = new Set(
        getOrderExecutor().getPendingOrdersList()
          .filter(o => o.type === 'entry' || o.type === 'ladder_entry')
          .map(o => o.orderId)
      );
      // Dedupe by orderId (entry list wins ties) rather than concatenating
      // both lists directly — an orderId should never legitimately sit in
      // both, but if a stray duplicate row ever did, processing it twice
      // in the same pass would waste a redundant getOrder/handleOrderFill
      // round trip and, on a failure, let the second restorePendingOrder
      // call silently overwrite the first with the wrong type/ladderIndex
      // (issue #673).
      const orphanMap = new Map();
      for (const savedEntry of positionState.pendingEntryOrders || []) {
        if (!orphanMap.has(savedEntry.orderId)) orphanMap.set(savedEntry.orderId, { savedEntry, entryType: 'entry' });
      }
      for (const savedEntry of positionState.pendingLadderOrders || []) {
        if (!orphanMap.has(savedEntry.orderId)) orphanMap.set(savedEntry.orderId, { savedEntry, entryType: 'ladder_entry' });
      }
      const orphans = [...orphanMap.values()].filter(({ savedEntry }) => !trackedIds.has(savedEntry.orderId));

      for (const { savedEntry, entryType } of orphans) {
        // The dedup key for any terminal buy collapses to the bare
        // orderId (makeFillDedupKey), regardless of isPartialFill/size.
        // If the polling callback path is already mid-flight or
        // engine-level-retrying (issue #679) this exact order, skip it
        // BEFORE spending a getOrder round trip — let it finish instead
        // of racing a second handleOrderFill call for the same orderId.
        // shouldSkipOwnedBuyRecommit dedups any true overlap that slips past
        // this, but avoiding the race (and the wasted network call) is
        // cheaper than relying on that alone. If it eventually exhausts
        // its retries, both maps clear the key and this sweep catches it
        // up on a later tick.
        if (recentlyProcessedFills.has(savedEntry.orderId) || incompleteFillRetries.has(savedEntry.orderId)) {
          continue;
        }

        let orderStatus;
        try {
          orderStatus = await getAdapter().getOrder(savedEntry.orderId);
        } catch (err) {
          logger.warn(
            `⚠️ [${exchange}] Reconcile: could not check orphaned ${entryType} ${savedEntry.orderId.slice(0, 8)} (untracked by executor): ${err.message} — will retry next tick`,
            { orderId: savedEntry.orderId, entryType, error: err.message }
          );
          continue;
        }
        if (!isTerminalStatus(orderStatus)) {
          // Still live on the exchange (OPEN/PARTIALLY_FILLED) — re-arm
          // executor tracking instead of merely skipping it, so the
          // ordinary checkPendingOrderFills polling path (with its own
          // advancing-partial routing via partialFillTracker) picks it
          // back up on the next tick. Without this, an order that fell
          // out of tracking while still resting would only ever be
          // re-checked by THIS sweep's own terminal-only gate, silently
          // missing any intermediate partial fill until it eventually
          // reaches a terminal state (issue #673).
          getOrderExecutor().restorePendingOrder(savedEntry.orderId, buildRestoreSpec(savedEntry, entryType));
          continue;
        }

        logger.warn(
          `⚠️ [${exchange}] Reconcile: orphaned ${entryType} ${savedEntry.orderId.slice(0, 8)} is ${orderStatus.status} but missing from executor tracking — catching up`,
          { orderId: savedEntry.orderId, entryType, status: orderStatus.status }
        );
        const result = await catchUpTerminalEntry(savedEntry, orderStatus, entryType);
        if (result.outcome === 'empty') {
          // Truly empty cancel — safe to purge, nothing to record.
          if (entryType === 'ladder_entry') {
            positionState.pendingLadderOrders = (positionState.pendingLadderOrders || [])
              .filter(o => o.orderId !== savedEntry.orderId);
          } else {
            positionState.pendingEntryOrders = (positionState.pendingEntryOrders || [])
              .filter(e => e.orderId !== savedEntry.orderId);
          }
          saveLiveState();
        }
      }
    })().catch(err => {
      logger.error(`❌ [${exchange}] Orphaned entry/ladder sweep failed: ${err.message}`, { error: err.message });
    });
  };

  /**
   * Reconcile step: detect a fill/not-found on the legacy single TP order the
   * WebSocket may have missed. Returns the dispatched chain, or null.
   */
  const reconcileLegacyTp = () => {
    // Check for TP order fill that WebSocket might have missed
    if (isDryRun || !positionState.activeTpOrderId) return null;
    return getAdapter().getOrder(positionState.activeTpOrderId)
      .then(async (orderStatus) => {
        // Coinbase can flip completionPercentage to 100 a tick before status
        // flips to FILLED — match the rest of the codebase's fill detection so
        // the reconcile backstop acts during that window (issue #155).
        if (isFilledStatus(orderStatus)) {
          logger.info(
            `✅ [${exchange}] Reconcile detected TP order ${positionState.activeTpOrderId} filled (WebSocket missed)`,
            { orderId: positionState.activeTpOrderId, orderType: 'take_profit', status: orderStatus.status }
          );
          // Build fill data in the format handleOrderFill expects
          const fillData = {
            orderId: positionState.activeTpOrderId,
            side: 'sell',
            status: 'FILLED',
            filledSize: parseFloat(orderStatus.filledSize || 0),
            filledValue: parseFloat(orderStatus.filledValue || 0),
            averageFilledPrice: parseFloat(orderStatus.averageFilledPrice || 0),
          };
          getOrderExecutor().markSettled(positionState.activeTpOrderId);
          await handleOrderFill(fillData);
        }
      })
      .catch(err => {
        // Order not found might mean it was cancelled or doesn't exist
        if (isOrderNotFoundError(err)) {
          logger.warn(
            `⚠️ [${exchange}] TP order ${positionState.activeTpOrderId} not found on exchange, clearing`,
            { orderId: positionState.activeTpOrderId, orderType: 'take_profit', error: err.message }
          );
          const cancelledTpId = positionState.activeTpOrderId;
          positionState.activeTpOrderId = null;
          getOrderExecutor().handleOrderCancel(cancelledTpId);
        } else {
          logger.error(
            `❌ [${exchange}] TP order check failed: ${err.message}`,
            { orderId: positionState.activeTpOrderId, orderType: 'take_profit', error: err.message }
          );
        }
      });
  };

  /**
   * Reconcile step: check each celestial body TP for fills/cancellations the
   * WebSocket may have missed. Returns one dispatched chain per body with a TP.
   */
  const reconcileBodyTps = () => {
    // Check celestial body TP orders for fills/cancellations that WebSocket might have missed
    const chains = [];
    for (const body of [...(positionState.celestialBodies || [])]) {
      if (!body.tpOrderId) continue;
      chains.push(getAdapter().getOrder(body.tpOrderId)
        .then(async (bodyStatus) => {
          if (isFilledStatus(bodyStatus)) {
            const tierCfg = celestialHierarchy.getTierConfig(body.tier);
            logger.info(
              `${tierCfg.emoji} [${exchange}] Reconcile detected body TP ${body.tpOrderId} filled`,
              { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', status: bodyStatus.status }
            );
            const fillData = {
              orderId: body.tpOrderId,
              side: 'sell',
              status: 'FILLED',
              filledSize: parseFloat(bodyStatus.filledSize || 0),
              filledValue: parseFloat(bodyStatus.filledValue || 0),
              averageFilledPrice: parseFloat(bodyStatus.averageFilledPrice || 0),
            };
            getOrderExecutor().markSettled(body.tpOrderId);
            await handleOrderFill(fillData);
          } else if (isCancelledStatus(bodyStatus)) {
            const tierCfg = celestialHierarchy.getTierConfig(body.tier);
            // A cancel-for-replace whose booking failed (#670) left the
            // execution it knew about on the body; retry with it rather
            // than trusting a status that may omit the filled size.
            const knownExecution = knownTpCancelExecution(body, bodyStatus);
            if (knownExecution) {
              getOrderExecutor().markSettled(body.tpOrderId);
              await bookTpCancelExecution(body, body.tpOrderId, knownExecution, 'Reconcile retry');
            } else if (bodyStatus.filledSize > 0) {
              // Route partials through handleOrderFill before re-placing — otherwise
              // they're lost (Gemini has no order-events WS, and polling drops the
              // order from pendingOrders once it sees CANCELLED).
              logger.warn(
                `⚠️ [${exchange}] Reconcile detected body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${bodyStatus.status} with ${bodyStatus.filledSize} partial fill — routing through handleOrderFill`,
                {
                  bodyId: body.id,
                  orderId: body.tpOrderId,
                  status: bodyStatus.status,
                  filledSize: bodyStatus.filledSize,
                }
              );
              getOrderExecutor().markSettled(body.tpOrderId);
              await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', bodyStatus));
            } else {
              // A freshly-placed TP can transiently read CANCELLED/FAILED from
              // Coinbase's eventually-consistent historical-order endpoint
              // (getOrder), even while the order is genuinely live on the book.
              // Trusting that single read here clears tracking AND re-places —
              // orphaning the live order and leaving a duplicate sell (the
              // 0824cc36 incident: getOrder said CANCELLED 6s after placement,
              // order stayed open for days). The startup path is immune because
              // it cross-checks getOpenOrders (openOrderIds) first; mirror that
              // here before acting on a terminal status.
              const openOrders = await lookupOrNull('getOpenOrders', productId, getAdapter().getOpenOrders(productId));
              // openOrders === null → getOpenOrders failed; treat as
              // inconclusive and keep the order (never orphan on a failed check).
              const stillOpen = openOrders === null || isOrderStillOpen(openOrders, body.tpOrderId);
              if (stillOpen) {
                logger.warn(
                  `⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} read ${bodyStatus.status} but still OPEN on exchange — ignoring false terminal status`,
                  { bodyId: body.id, orderId: body.tpOrderId, status: bodyStatus.status, stillOpen: true }
                );
              } else {
                logger.warn(
                  `⚠️ [${exchange}] Reconcile detected body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${bodyStatus.status} — clearing for re-placement`,
                  { bodyId: body.id, orderId: body.tpOrderId, status: bodyStatus.status }
                );
                getOrderExecutor().removeBodyTracking(body.tpOrderId);
                body.tpOrderId = null;
                body.tpPrice = 0;
                body.assetOnOrder = 0;
                saveLiveState();
                await placeBodyTp(body);
              }
            }
          } else if (bodyStatus.status === 'OPEN' || bodyStatus.status === 'PENDING' || bodyStatus.status === 'PARTIALLY_FILLED') {
            if (bodyStatus.filledSize > 0) {
              // Route partials through handleOrderFill — cancelPartialFillOrder
              // freezes the order and the partial-fill branch resizes the body,
              // which also handles the stale-size case implicitly.
              logger.warn(
                `⚠️ [${exchange}] Reconcile: body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} has ${bodyStatus.filledSize} partial fill while OPEN — routing through handleOrderFill`,
                {
                  bodyId: body.id,
                  orderId: body.tpOrderId,
                  status: bodyStatus.status,
                  filledSize: bodyStatus.filledSize,
                }
              );
              getOrderExecutor().markSettled(body.tpOrderId);
              await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', bodyStatus));
            } else {
              // Pure stale-size detection (body merged/modified, TP placed for old size).
              const tierCfg = celestialHierarchy.getTierConfig(body.tier);
              const { sellQty } = positionSizer.calculateTakeProfitSize(
                body.assetQty, body.avgPrice, body.tpPrice, tierCfg.holdbackScale
              );
              if (body.needsTpReprice || Math.abs(sellQty - body.assetOnOrder) > 0.00000001) {
                logger.warn(`⚠️ [${exchange}] Reconcile: body ${body.id.slice(-8)} TP stale (onOrder=${body.assetOnOrder}, expected=${sellQty}) — cancelling for re-place`);
                if (await cancelBodyTpForReplace(body, 'Reconcile stale-size') === 'cancelled') {
                  body.needsTpReprice = false;
                  saveLiveState();
                  await placeBodyTp(body);
                }
              }
            }
          }
        })
        .catch(async (err) => {
          // Order not found or invalid — likely cancelled externally or ID no longer valid
          if (isOrderNotFoundError(err)) {
            logger.warn(
              `⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} not found on exchange — clearing for re-placement`,
              { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
            );
            getOrderExecutor().removeBodyTracking(body.tpOrderId);
            body.tpOrderId = null;
            body.tpPrice = 0;
            body.assetOnOrder = 0;
            saveLiveState();
            await placeBodyTp(body);
          }
        })
        // Terminal guard: this getOrder chain is fire-and-forget inside the
        // loop, and both the .then and .catch handlers above await
        // handleOrderFill / placeBodyTp, which can themselves reject. Without
        // this, such a rejection escapes as an unhandled rejection and
        // crashes the process (Node ≥15) — the reconcile loop re-checks this
        // body on the next tick anyway (issue #99).
        .catch(err => {
          logger.error(
            `❌ [${exchange}] Body ${body.id.slice(-8)} TP reconcile handler error: ${err.message}`,
            { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
          );
        }));
    }
    return chains;
  };

  /**
   * Reconcile step: recompute balance/qty fields from the fill ledger and merge
   * them into the live position. Returns the dispatched chain.
   */
  const reconcileRecoveredPosition = () => {
    return getRecoveryModule().reconcile(positionState, fillLedger)
      .then(result => {
        if (result.updated) {
          // MERGE the recomputed balance/qty fields into the EXISTING state —
          // do NOT wholesale-replace. rebuildPositionFromFills returns a
          // minimal object (activeTpOrderId:null, cyclesCompleted:0, no
          // lifecycle / ladder / pending-order / macroRegime fields), so a
          // wholesale swap would: flip a DRAINING fund back to ACTIVE, null
          // activeTpOrderId while the core TP still rests (→ duplicate sell),
          // drop ladderActive/pendingLadderOrders/pendingEntryOrders (→ double
          // ladders + orphaned orders), and reset cyclesCompleted. Only the
          // fields rebuildPositionFromFills authoritatively recomputes from
          // the ledger are copied over (issue #97).
          const rebuilt = result.position;
          const RECONCILED_FIELDS = [
            'totalAsset', 'totalCostBasis', 'avgCostBasis', 'cycleBuys',
            'lastEntryPrice', 'lastEntryTime', 'anchorPrice',
          ];
          for (const field of RECONCILED_FIELDS) {
            if (rebuilt[field] !== undefined) positionState[field] = rebuilt[field];
          }
          // Re-sync totals from bodies (celestial mode): rebuildPositionFromFills
          // skips body-owned fills, so when bodies exist the body-derived
          // aggregate is authoritative and overrides the core-only totals above.
          const bodies = positionState.celestialBodies || [];
          if (bodies.length > 0) {
            celestialHierarchy.syncPositionState(positionState, bodies);
          }
          // rebuildPositionFromFills excludes body-owned buys, so the cycleBuys
          // copied above is 0 in celestial mode — restore it from the all-buys
          // count so a reconcile-triggered rebuild doesn't wipe the live counter
          // and re-open per-cycle step exposure (issue #210-A).
          if (config.celestialEnabled !== false) {
            positionState.cycleBuys = fillLedger.getCurrentCycleAllBuysCount();
          }
          logger.info(`🔄 [${exchange}] Position reconciled from exchange (${bodies.length} bodies, lifecycle=${positionState.lifecycle || 'n/a'} preserved)`);
        }
      })
      .catch(err => {
        logger.error(`❌ [${exchange}] Reconciliation failed: ${err.message}`, { error: err.message });
      });
  };

  /**
   * One reconciliation pass. Extracted from the setInterval callback so the
   * #196 lock-release integration test can drive a single tick directly (via the
   * _test hooks) without a lingering interval. Behaviour is identical to the
   * inlined callback it replaced.
   */
  const reconcileTick = () => {
    if (!getIsRunning()) return; // Guard against firing after stop
    return engineLocks.withReconcileLock(async () => {
      // Collect every async chain this tick dispatches so the reconcile lock is
      // held until ALL of them settle — the body-TP chains cancel/replace
      // TPs fire-and-forget, and clearing the flag on the recovery promise alone
      // would let a merge (or the next reconcile tick) race an in-flight TP
      // re-placement (#189 review).
      fillLedger.resumeBuyCorrections();
      fillLedger.resumeSellCorrections();
      await reconcilePendingPlacements();
      await completeOwedCycleReset().catch((err) => {
        logger.error(`❌ [${exchange}] Owed cycle reset failed (will retry next reconcile): ${err.message}`, { error: err.message });
      });
      const pending = [];
      for (const chain of [reconcileEntryFills(), sweepOrphanedSavedOrders(), reconcileLegacyTp()]) {
        if (chain) pending.push(chain);
      }
      pending.push(...reconcileBodyTps());
      pending.push(reconcileRecoveredPosition());

      // Release the lock only after every dispatched chain settles (#189 review).
      return Promise.allSettled(pending);
    });
  };

  return {
    catchUpTerminalEntry,
    reconcileEntryFills,
    sweepOrphanedSavedOrders,
    reconcileLegacyTp,
    reconcileBodyTps,
    reconcileRecoveredPosition,
    reconcileTick,
  };
};

module.exports = { createReconcileLoop };
