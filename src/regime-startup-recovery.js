'use strict';

/**
 * Startup recovery for one live fund: everything the engine runs once, after
 * loading saved state and before it trades — exchange position recovery,
 * offline fill catch-up through the live fill pipeline, legacy and body TP
 * restore/reprice, stale-order cleanup, cycle accounting, pending entry and
 * ladder restore, and missing-TP placement. Extracted verbatim from
 * regime-engine's startImpl (issue #1601); `restoreAll()` runs the sequence in
 * the original order and `startImpl` awaits it.
 *
 * Offline fills are booked through the engine's own `handleOrderFill`, so
 * realized P&L still comes only from the fill ledger's cycle-pair annotations
 * (refreshRealizedFromCyclePairs) — nothing here accumulates it.
 *
 * `positionState` is passed directly: the engine keeps one object identity
 * (replacePositionState, #1594). `getAdapter`, `getOrderExecutor`,
 * `getRecoveryModule` and `getPriceIncrement` are accessors because the engine
 * reassigns those bindings (tests swap the exchange deps; start() sets the
 * price increment from product details).
 */

const celestialHierarchy = require('./celestial-hierarchy');
const { tradeEvents } = require('./trade-events');
const { resolveFundDataDir } = require('./migration');
const { findInvalidManualTradesReason, findInvalidCorrectiveBuysReason } = require('./persisted-payload-validation');
const { backfillEngineStart: _backfillEngineStart } = require('./apy-calculator');
const { roundAsset, roundPrice } = require('./volatility-utils');
const { fmtCurrency: fmtPrice, isFilledStatus, isCancelledStatus, isTerminalStatus, isOrderNotFoundError } = require('./shared-utils');
const { buildPartialFillData, isBuyAlreadyCommitted, isUnsettledBuyRow } = require('./regime-pure-helpers');
const { restorePersistedCycleId, repairHistoricalFillAnnotations } = require('./regime-fill-annotations');

/**
 * @param {Object} deps
 * @returns {{restoreAll: Function, checkOfflineOrderFills: Function}}
 */
const createStartupRecovery = ({
  exchange, pair, productId, baseCurrency, fundLabel, config, logger,
  positionState, replacePositionState, createInitialPositionState,
  fillLedger, closedTrades, pendingMergeTpOrders, completedMergeTpOrders,
  getAdapter, getOrderExecutor, getRecoveryModule, getPriceIncrement,
  lookupOrNull, restoredEntryStaleMs, calculateDynamicTpPercent,
  // Live fill pipeline and TP placement
  handleOrderFill, knownTpCancelExecution, bookTpCancelExecution, catchUpTerminalEntry,
  cancelBodyTpForReplace, placeBodyTp, placeTakeProfitOrder,
  recoverUnbookedOwnedEntryTranches, sealLegacyClosure,
  // State persistence (regime-state-persistence)
  loadLiveState, saveLiveState, refreshRealizedFromCyclePairs,
  syncActiveCycleIdAfterRecalc, resyncLiveCycleCountersAfterRecalc,
}) => {
  /**
   * Check for orders that filled while offline
   * @returns {Promise<{tpFilled: boolean, entriesFilled: number}>}
   */
  const checkOfflineOrderFills = async () => {
    const openOrders = await getAdapter().getOpenOrders(productId);
    const openOrderIds = new Set(openOrders.map(o => o.orderId));

    let tpFilled = false;
    let entriesFilled = 0;

    // Recover legacy/core TPs through the same accounting and dedup as live fills.
    const legacyTpOrderId = positionState.activeTpOrderId;
    if (legacyTpOrderId && !openOrderIds.has(legacyTpOrderId)) {
      try {
        const orderStatus = await getAdapter().getOrder(legacyTpOrderId);
        if (isFilledStatus(orderStatus)) {
          await handleOrderFill(buildPartialFillData(legacyTpOrderId, 'sell', orderStatus, {
            source: 'offline',
          }));
          tpFilled = true;
        }
      } catch (err) {
        logger.error(
          `❌ [${exchange}] TP ${legacyTpOrderId} offline fill recovery failed: ${err.message} — retaining tracking for retry`,
          { orderId: legacyTpOrderId, orderType: 'take_profit', error: err.message }
        );
      }
    }

    // Check for celestial body TP orders that filled or were cancelled while offline
    // Prefetch order statuses for all body TPs no longer in openOrderIds in
    // parallel — sequential awaits made startup O(N) round-trips on a fund
    // with many bodies (the 51-orphan ETHUSD case took ~25s on Gemini).
    const offlineBodies = positionState.celestialBodies || [];
    const bodiesToCheck = offlineBodies.filter(b => b.tpOrderId && !openOrderIds.has(b.tpOrderId));
    const bodyStatuses = await Promise.all(
      bodiesToCheck.map(b => lookupOrNull('getOrder', b.tpOrderId, getAdapter().getOrder(b.tpOrderId)))
    );
    const bodyStatusByOrderId = new Map(
      bodiesToCheck.map((b, i) => [b.tpOrderId, bodyStatuses[i]])
    );

    for (const body of [...offlineBodies]) {
      if (body.tpOrderId && !openOrderIds.has(body.tpOrderId)) {
        const orderStatus = bodyStatusByOrderId.get(body.tpOrderId);

        // A cancel-for-replace whose booking failed before the restart (#670)
        // persisted the execution it knew about. Book from it rather than
        // from a CANCELLED status that may omit (or understate) the filled
        // size — otherwise the branches below would book too little, or clear
        // the TP and re-place against the unreduced body, losing the sale.
        const knownExecution = isCancelledStatus(orderStatus) ? knownTpCancelExecution(body, orderStatus) : null;
        if (knownExecution) {
          getOrderExecutor().markSettled(body.tpOrderId);
          // bookTpCancelExecution contains its own failure (keeps the marker
          // and the TP identity for the reconcile retry).
          await bookTpCancelExecution(body, body.tpOrderId, knownExecution, 'Startup recovery');
          continue;
        }

        // Catch CANCELLED-with-partials at startup (Gemini heartbeat-cancels
        // open orders during downtime). The interval reconciler would catch
        // this too, but only after reconcileIntervalMs.
        if (isCancelledStatus(orderStatus) && orderStatus.filledSize > 0) {
          const tierCfg = celestialHierarchy.getTierConfig(body.tier);
          logger.info(
            `${tierCfg.emoji} [${exchange}] Body TP ${body.tpOrderId} ${orderStatus.status} while offline with ${orderStatus.filledSize} partial fill — routing through handleOrderFill`,
            { bodyId: body.id, orderId: body.tpOrderId, status: orderStatus.status, filledSize: orderStatus.filledSize }
          );
          getOrderExecutor().markSettled(body.tpOrderId);
          // Contain per body. handleOrderFill THROWS when the partial sell's
          // cancellation is unresolved (issue #316) — e.g. the open-order
          // cross-check failed. Without this, one unresolved body aborts the
          // whole offline-recovery pass and every remaining body is skipped.
          // The reconcile loop re-checks each body on its own tick anyway, so
          // logging and moving on is the correct degradation (mirrors the
          // reconcile loop's terminal guard, issue #99).
          try {
            await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', orderStatus));
          } catch (err) {
            logger.error(
              `❌ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} offline partial-fill recovery failed: ${err.message} — retrying on next reconcile`,
              { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
            );
          }
          continue;
        }

        // Cancelled-without-partials: clear the stale tpOrderId so the engine
        // places a fresh TP on first tick. Without this, body.tpOrderId points
        // at a dead order and placeBodyTp would skip (it gates on !tpOrderId).
        if (isCancelledStatus(orderStatus)) {
          logger.warn(
            `⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${orderStatus.status} while offline (no partials) — clearing for re-placement`,
            { bodyId: body.id, orderId: body.tpOrderId, status: orderStatus.status }
          );
            getOrderExecutor().removeBodyTracking(body.tpOrderId);
            body.tpOrderId = null;
          body.tpPrice = 0;
          body.assetOnOrder = 0;
          // The old TP is already gone — whatever fresh TP gets placed next
          // (ensureTakeProfitPlaced, sized from the CURRENT assetQty) is
          // already correct. Clear needsTpReprice here too, or the later
          // savedBodies reprice pass (issue #726) would skip this body
          // entirely on THIS startup (its guard requires a tpOrderId), and a
          // future restart would needlessly cancel+replace the
          // freshly-placed, already-correctly-sized TP.
          if (body.needsTpReprice) body.needsTpReprice = false;
          continue;
        }

        // Same FILLED-or-completion=100 pattern as the core TP path above.
        if (isFilledStatus(orderStatus)) {
          const tierCfg = celestialHierarchy.getTierConfig(body.tier);
          logger.info(
            `${tierCfg.emoji} [${exchange}] Body TP ${body.tpOrderId} filled while offline — routing through handleOrderFill`,
            { bodyId: body.id, orderId: body.tpOrderId, status: orderStatus.status }
          );
          getOrderExecutor().markSettled(body.tpOrderId);
          // Contain per body (issue #316), same as the cancelled-with-partials
          // branch above: one unresolved body must not abort recovery of the
          // rest. Routing through the canonical pipeline (#367) — instead of
          // duplicating its ~90 lines of fill aggregation, prorated cost basis,
          // holdback, capital growth credit, source-buy linking and
          // closedTrades.record inline — also picks up the cycle reset when
          // this was the last body, which the old inline path omitted entirely.
          try {
            await handleOrderFill(buildPartialFillData(body.tpOrderId, 'sell', orderStatus));
          } catch (err) {
            logger.error(
              `❌ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} offline full-fill recovery failed: ${err.message} — retrying on next reconcile`,
              { bodyId: body.id, orderId: body.tpOrderId, orderType: 'body_tp', error: err.message }
            );
          }
        }
      }
    }

    // Check for entry orders that filled while offline
    const pendingEntries = getOrderExecutor().getPendingEntries();
    for (const [orderId] of pendingEntries) {
      if (!openOrderIds.has(orderId)) {
        const orderStatus = await getAdapter().getOrder(orderId);
        if (isFilledStatus(orderStatus)) {
          logger.info(
            `✅ [${exchange}] Entry order ${orderId} filled while offline — routing through handleOrderFill`,
            { orderId, orderType: 'entry', status: orderStatus.status }
          );
          entriesFilled++;

          // Contain per entry (issue #316): one unresolved entry must not abort
          // recovery of subsequent pending entries/bodies. Routing through the
          // canonical pipeline (#367) — instead of mutating flat totalAsset/
          // totalCostBasis with no celestial body and falling back to the legacy
          // monolithic TP — creates/merges the proper celestial body and places
          // its dynamic TP, keeping the hierarchy in sync with position state.
          try {
            await handleOrderFill(buildPartialFillData(orderId, 'buy', orderStatus, {
              placedAt: getOrderExecutor().getOrderPlacedAt(orderId),
            }));
          } catch (err) {
            logger.error(
              `❌ [${exchange}] Entry ${orderId.slice(0, 8)} offline fill recovery failed: ${err.message} — retrying on next reconcile`,
              { orderId, orderType: 'entry', error: err.message }
            );
          }
        }
      }
    }

    return { tpFilled, entriesFilled };
  };

  /**
   * Re-evaluate position after downtime
   * Checks if market has moved significantly and adjusts strategy accordingly
   * @param {number} currentPrice - Current market price
   */
  const reEvaluateAfterDowntime = (currentPrice) => {
    if (positionState.totalAsset <= 0) {
      logger.info(`ℹ️ [${exchange}] No position to re-evaluate`);
      return;
    }

    const lastEntryPrice = positionState.lastEntryPrice || positionState.avgCostBasis;
    if (lastEntryPrice <= 0) return;

    const priceChange = ((currentPrice - lastEntryPrice) / lastEntryPrice) * 100;
    const priceChangeAbs = Math.abs(priceChange);

    logger.info(`📊 [${exchange}] Re-evaluating position: price moved ${priceChange.toFixed(2)}% since last entry (${fmtPrice(lastEntryPrice)} -> ${fmtPrice(currentPrice)})`);

    // Re-anchor price for volatility triggers
    positionState.anchorPrice = currentPrice;
    logger.info(`⚓ [${exchange}] Re-anchored price to ${fmtPrice(currentPrice)}`);

    // If price dropped significantly (>5%), consider the position may need attention
    if (priceChange < -5) {
      logger.warn(`⚠️ [${exchange}] Price dropped ${priceChangeAbs.toFixed(2)}% while offline - position unrealized P&L affected`);
    }

    // If price rose significantly and we have a position, TP might need updating
    if (priceChange > 3 && positionState.totalAsset > 0) {
      logger.info(`📈 [${exchange}] Price rose ${priceChangeAbs.toFixed(2)}% while offline - TP order may need adjustment`);
      // TP order will be re-evaluated naturally on next metrics update
    }
  };

  /** Collect independently persisted corrective/manual buys before classifying orphans. */
  const collectStartupBuyExclusions = () => {
    // Load corrective buy order IDs to avoid cancelling them as orphans
    const correctiveBuyIds = new Set();
    try {
      const cbPath = require('path').join(resolveFundDataDir(exchange, pair), 'pending-corrective-buys.json');
      const cbData = JSON.parse(require('fs').readFileSync(cbPath, 'utf8'));
      const invalid = findInvalidCorrectiveBuysReason(cbData);
      if (invalid) throw new Error(`pending-corrective-buys.json ${invalid}`);
      for (const cb of cbData) {
        if (!cb.filled && !cb.cancelled) correctiveBuyIds.add(cb.buyOrderId);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error(
          `[regime-engine] Error reading pending-corrective-buys.json: ${err.message}`,
          { error: err.message, errorCode: err.code, path: 'pending-corrective-buys.json' }
        );
      }
    }

    // Load manual trade recovery buy order IDs to avoid cancelling them as orphans
    try {
      const mtPath = require('path').join(resolveFundDataDir(exchange, pair), 'manual-trades.json');
      const mtData = JSON.parse(require('fs').readFileSync(mtPath, 'utf8'));
      const invalid = findInvalidManualTradesReason(mtData);
      if (invalid) throw new Error(`manual-trades.json ${invalid}`);
      for (const mt of (mtData.trades || [])) {
        if (mt.buyOrderId && mt.status === 'buy_pending') correctiveBuyIds.add(mt.buyOrderId);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error(
          `[regime-engine] Error reading manual-trades.json: ${err.message}`,
          { error: err.message, errorCode: err.code, path: 'manual-trades.json' }
        );
      }
    }
    return correctiveBuyIds;
  };

  /**
   * Book the already-filled tranche of an entry that is still open on the
   * exchange through the standard fill pipeline (issue #671), so it joins
   * a celestial body, gets a TP, and shrinks the tracked pending entry.
   * A failure is logged, not thrown: the caller has already restored the
   * order's executor tracking, so the live poll/WS path books the fills
   * once the engine is running — and since nothing was ingested here,
   * that later pass sees every row as new instead of a deduped remainder.
   * @param {Object} order - Open order from getOpenOrders
   * @param {number} placedAt - Order placement time (ms)
   * @param {string} label - Log label for the calling branch
   * @returns {Promise<void>}
   */
  const bookStartupOpenEntryPartial = async (order, placedAt, label) => {
    const fillArgs = { status: order.status || 'OPEN', isPartialFill: true, placedAt };
    // Rows no body ever booked were ingested by the pre-#671 startup path.
    // The normal pass below would dedup them away and build the body from
    // only the newer tranches, so commit them into a body first, on their
    // own. Rows a body already booked are settled and never rebooked.
    const legacyRows = isBuyAlreadyCommitted(positionState.celestialBodies, order.orderId)
      ? []
      : fillLedger.getFillsForOrder(order.orderId)
        .filter(isUnsettledBuyRow);
    // What this call commits is measured from the order's tranches, so a
    // throw can shrink the entry by exactly that (issue #756).
    const tranchesOf = () => (positionState.celestialBodies || [])
      .flatMap(b => (b.buyOrders || []).filter(bo => bo && bo.orderId === order.orderId));
    const tranchesBefore = new Set(tranchesOf());
    const entryBefore = (positionState.pendingEntryOrders || []).find(e => e.orderId === order.orderId);
    try {
      if (legacyRows.length > 0) {
        // A current-cycle order was already counted by the cycleBuys
        // auto-correct above; a first commit here would count it again.
        const alreadyCounted = fillLedger.getCurrentCycleFills()
          .some(f => f.side === 'buy' && f.orderId === order.orderId);
        const cycleBuysBefore = positionState.cycleBuys;
        try {
          await handleOrderFill(buildPartialFillData(order.orderId, 'buy', order, {
            ...fillArgs,
            filledSize: legacyRows.reduce((sum, f) => sum + Number(f.size || 0), 0),
            confirmedFills: legacyRows,
          }));
        } finally {
          if (alreadyCounted && positionState.cycleBuys === cycleBuysBefore + 1) {
            positionState.cycleBuys = cycleBuysBefore;
          }
        }
      }
      await handleOrderFill(buildPartialFillData(order.orderId, 'buy', order, fillArgs));
    } catch (err) {
      logger.error(`❌ [${exchange}] Could not book offline partial fills for ${label} ${order.orderId}: ${err.message} — will pick them up on the next reconcile/poll`, {
        orderId: order.orderId,
        error: err.message,
        incompleteFills: err.incompleteFills === true,
      });
      // A throw after a body took a tranche but before the pending entry
      // shrank would leave the entry at its full notional beside that
      // body, overstating deployed capital. Shrink it by exactly the
      // tranches this call committed — not to the exchange's remainder,
      // which would also subtract tranches that are still unbooked (a
      // legacy-row pass that committed and then threw leaves the main
      // pass's tranches to the live path, which shrinks the entry
      // itself when it books them).
      if (entryBefore) {
        const committed = tranchesOf().filter(bo => !tranchesBefore.has(bo));
        const qty = committed.reduce((sum, bo) => sum + (Number(bo.assetQty) || 0), 0);
        const cost = committed.reduce((sum, bo) => sum + (Number(bo.sizeUsdc) || 0), 0);
        positionState.pendingEntryOrders = (positionState.pendingEntryOrders || []).map(e => (
          e.orderId !== order.orderId ? e : {
            ...e,
            assetQty: Math.max(0, (Number(entryBefore.assetQty) || 0) - qty),
            sizeUsdc: Math.max(0, (Number(entryBefore.sizeUsdc) || 0) - cost),
          }
        ));
      }
    }
  };

  /** Restore open entries sequentially, booking offline partials before moving on. */
  const restoreStartupOpenEntries = async (savedPendingEntries, savedOrderIds, savedLadderIds, openEntries, correctiveBuyIds) => {
    let restoredEntries = 0;
    let orphanedEntries = 0;

    for (const order of openEntries) {
      if (savedOrderIds.has(order.orderId)) {
        // This is our order - restore tracking instead of canceling
        const savedEntry = savedPendingEntries.find(e => e.orderId === order.orderId);
        const restoredPlacedAt = order.createdTime ? new Date(order.createdTime).getTime() : (savedEntry.placedAt || Date.now());
        getOrderExecutor().restorePendingOrder(order.orderId, {
          type: 'entry',
          price: savedEntry.price,
          size: savedEntry.assetQty,
          sizeUsdc: savedEntry.sizeUsdc,
          placedAt: restoredPlacedAt,
          staleMs: restoredEntryStaleMs(savedEntry),
        });
        restoredEntries++;
        logger.info(`🔄 [${exchange}] Restored pending entry: ${order.orderId} @ ${fmtPrice(savedEntry.price)}`);

        // Check if order has any fills while offline (partial fills).
        // Route them through the standard fill pipeline (issue #671) so the
        // tranche lands in a celestial body (with a TP) and shrinks the
        // tracked entry. Ingesting straight into the ledger here left the
        // tranche in no body: the later terminal fill deduped those rows
        // and built its body from the new tranche alone.
        if (order.filledSize && order.filledSize > 0) {
          logger.info(`✅ [${exchange}] Entry ${order.orderId} has partial fills (${order.filledSize})`);
          await bookStartupOpenEntryPartial(order, restoredPlacedAt, 'entry');
        }
      } else if (correctiveBuyIds.has(order.orderId)) {
        logger.info(`📋 [${exchange}] Skipping corrective buy order ${order.orderId.slice(0, 8)} (tracked in pending-corrective-buys)`);
      } else if (!savedLadderIds.has(order.orderId)) {
        // Check if this "orphan" has partial fills — if so, restore it instead of cancelling
        if (order.filledSize && order.filledSize > 0) {
          logger.info(`📦 [${exchange}] Orphan entry ${order.orderId.slice(0, 8)} has partial fills (${order.filledSize} ${baseCurrency}) — restoring instead of cancelling`);
          // Every sibling restorePendingOrder({type: 'entry', ...}) call in
          // this file sets `size` to the order's ORIGINAL placed quantity
          // (e.g. savedEntry.assetQty above), not what's left unfilled —
          // the dashboard reads it as the "of N" denominator alongside
          // filledSize (RegimeDashboard.jsx: "X of Y filled"). order.size
          // is now the REMAINING unfilled quantity (issue #684); use
          // order.originalSize here to match the established convention.
          const orphanPlacedAt = order.createdTime ? new Date(order.createdTime).getTime() : Date.now();
          getOrderExecutor().restorePendingOrder(order.orderId, {
            type: 'entry',
            price: order.price,
            size: order.originalSize,
            sizeUsdc: order.originalSize * order.price,
            placedAt: orphanPlacedAt,
            staleMs: restoredEntryStaleMs(),
          });
          // Keep the adopted order in the persisted pending list so it
          // survives the next restart, then book its filled tranche through
          // the standard pipeline (issue #671) — which also shrinks this
          // entry from its original quantity to its unfilled remainder.
          if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
          if (!positionState.pendingEntryOrders.some(e => e.orderId === order.orderId)) {
            // The orphan-buy recovery above may already have booked some of
            // it into a body; track only what no body holds (issue #756).
            const held = (positionState.celestialBodies || [])
              .flatMap(b => b.buyOrders || [])
              .filter(bo => bo && bo.orderId === order.orderId);
            const heldQty = held.reduce((sum, bo) => sum + (Number(bo.assetQty) || 0), 0);
            const heldCost = held.reduce((sum, bo) => sum + (Number(bo.sizeUsdc) || 0), 0);
            positionState.pendingEntryOrders.push({
              orderId: order.orderId,
              price: order.price,
              assetQty: Math.max(0, order.originalSize - heldQty),
              sizeUsdc: Math.max(0, order.originalSize * order.price - heldCost),
              placedAt: orphanPlacedAt,
              staleMs: restoredEntryStaleMs(),
            });
          }
          await bookStartupOpenEntryPartial(order, orphanPlacedAt, 'orphan entry');
          restoredEntries++;
        } else {
          // Orphan entry with no fills — cancel it
          orphanedEntries++;
          logger.info(`🧹 [${exchange}] Cancelling orphan entry order ${order.orderId} (not tracked by regime engine)`);
          const cancelResult = await getAdapter().cancelOrder(order.orderId);
          if (cancelResult.success) {
            logger.info(`✅ [${exchange}] Cancelled orphan entry ${order.orderId.slice(0, 8)}`);
          } else {
            const orphanStatus = await lookupOrNull('getOrder', order.orderId, getAdapter().getOrder(order.orderId));
            if (orphanStatus?.status === 'FILLED') {
              logger.info(`📋 [${exchange}] Orphan entry ${order.orderId.slice(0, 8)} already filled — recovery will process`);
            } else {
              logger.warn(
                `⚠️ [${exchange}] Failed to cancel orphan entry ${order.orderId.slice(0, 8)}: ${cancelResult.errorMessage || 'unknown'}`,
                { orderId: order.orderId, orderType: 'entry', error: cancelResult.errorMessage || 'unknown' }
              );
            }
          }
        }
      }
    }

    if (restoredEntries > 0) {
      logger.info(`✅ [${exchange}] Restored ${restoredEntries} pending entry orders from state`);
    }
    if (orphanedEntries > 0) {
      logger.info(`🧹 [${exchange}] Cancelled ${orphanedEntries} orphan entry orders`);
    }
  };

  /** Catch up absent saved entries, then purge against the post-booking live list. */
  const catchUpStartupSavedEntries = async (savedPendingEntries, exchangeOpenOrders) => {
    const allOpenIds = new Set(exchangeOpenOrders.map(o => o.orderId));

    // Catch up fills for saved entries that became terminal during downtime.
    // The for-loop above only iterates exchangeOpenOrders, so saved entries
    // that already cleared on the exchange skip its partial-fill ingest path;
    // without this catch-up they would be purged below with no ledger record.
    const terminalSavedEntries = savedPendingEntries.filter(e => !allOpenIds.has(e.orderId));
    // Prefetch statuses in parallel; handleOrderFill is still sequential
    // since it mutates positionState.
    const entryStatuses = await Promise.all(
      terminalSavedEntries.map(e => getAdapter().getOrder(e.orderId).catch(err => ({ __err: err })))
    );
    let caughtUpEntries = 0;
    // Orders whose catch-up handleOrderFill threw (issue #679's stricter
    // getOrderFills contract) — must NOT be purged below with no ledger
    // record. Re-armed via restorePendingOrder (inside catchUpTerminalEntry) so the
    // next reconcile's checkPendingOrderFills polls this (already-terminal
    // on the exchange) order again and routes it through the
    // retry-hardened live polling fill path.
    const failedCatchUpIds = new Set();
    for (let i = 0; i < terminalSavedEntries.length; i++) {
      const savedEntry = terminalSavedEntries[i];
      const orderStatus = entryStatuses[i];
      if (!orderStatus || orderStatus.__err) {
        if (orderStatus?.__err) {
          logger.warn(
            `⚠️ [${exchange}] Failed to catch up offline entry ${savedEntry.orderId.slice(0, 8)}: ${orderStatus.__err.message}`,
            { orderId: savedEntry.orderId, error: orderStatus.__err.message }
          );
        }
        continue;
      }
      // Shared with reconcileTick's orphan sweep (issue #764): honors the
      // saved row's knownFilledSize high-water mark, so a restart during the
      // exposure window can't misread a real partial as an empty cancel just
      // because this fresh poll under-reports filledSize. On a throw (issue
      // #679's stricter getOrderFills contract) it has already re-armed
      // executor tracking for the SAME orderId and stamped the resolved size
      // onto the row; keep it in pendingEntryOrders (below) instead of
      // purging it.
      const result = await catchUpTerminalEntry(savedEntry, orderStatus, 'entry');
      if (result.outcome === 'filled') caughtUpEntries++;
      else if (result.outcome === 'failed') failedCatchUpIds.add(savedEntry.orderId);
      // 'empty': truly empty cancel, ok to purge below
    }
    if (caughtUpEntries > 0) {
      logger.info(`📥 [${exchange}] Caught up ${caughtUpEntries} offline-terminal entries before purge`);
    }
    if (failedCatchUpIds.size > 0) {
      logger.info(`🔁 [${exchange}] Re-armed ${failedCatchUpIds.size} offline-terminal entries whose fill catch-up failed, for retry`);
    }

    // Remove saved pending entries that are no longer open on the exchange
    // (filled or cancelled while engine was offline — fills already ingested above).
    // A failed catch-up (failedCatchUpIds) is retained even though it is
    // also not open on the exchange — it needs a retry, not a purge.
    // Filters the LIVE list, not the savedPendingEntries snapshot: the
    // handleOrderFill calls above shrank partially-filled entries to their
    // unfilled remainder and appended adopted orphans (issue #671), and
    // re-filtering the stale snapshot would silently undo both. A failed
    // catch-up may have thrown AFTER handleOrderFill already dropped its
    // entry from the live list, so those are re-added from the snapshot.
    const livePendingEntries = positionState.pendingEntryOrders || [];
    const liveIds = new Set(livePendingEntries.map(e => e.orderId));
    const currentPendingEntries = [
      ...livePendingEntries,
      ...savedPendingEntries.filter(e => failedCatchUpIds.has(e.orderId) && !liveIds.has(e.orderId)),
    ];
    if (currentPendingEntries.length > 0) {
      positionState.pendingEntryOrders = currentPendingEntries.filter(
        e => allOpenIds.has(e.orderId) || failedCatchUpIds.has(e.orderId)
      );
      const purged = currentPendingEntries.length - positionState.pendingEntryOrders.length;
      if (purged > 0) {
        logger.info(`🧹 [${exchange}] Purged ${purged} stale pending entry orders (filled/cancelled while offline)`);
      }
    }
    return allOpenIds;
  };

  /** Snapshot ladder state only after entry catch-up; preserve its distinct retry policy. */
  const restoreStartupLadderOrders = async (savedLadderIds, openEntries, allOpenIds) => {
    // Catch up saved ladder rungs that went terminal while offline, the same
    // way as entries above (issue #764): the restore block below keeps only
    // rungs still open on the exchange, so without this a rung that filled —
    // or was cancelled with a partial, possibly recorded only as its
    // knownFilledSize — would be dropped with nothing booked. A failed
    // catch-up is retained (re-armed by catchUpTerminalEntry) for the
    // reconcile sweep to retry, exactly like failedCatchUpIds for entries.
    const savedLadderSnapshot = positionState.pendingLadderOrders || [];
    const terminalSavedLadder = savedLadderSnapshot.filter(o => !allOpenIds.has(o.orderId));
    const failedLadderCatchUpIds = new Set();
    if (terminalSavedLadder.length > 0) {
      const ladderStatuses = await Promise.all(
        terminalSavedLadder.map(o => getAdapter().getOrder(o.orderId).catch(err => ({ __err: err })))
      );
      for (let i = 0; i < terminalSavedLadder.length; i++) {
        const savedRung = terminalSavedLadder[i];
        const orderStatus = ladderStatuses[i];
        if (!orderStatus || orderStatus.__err) {
          // Unknown status — keep the row rather than drop a possible fill;
          // the reconcile sweep re-polls it.
          logger.warn(
            `⚠️ [${exchange}] Failed to check offline ladder rung ${savedRung.orderId.slice(0, 8)}: ${orderStatus?.__err?.message || 'no status'} — keeping it for the reconcile sweep`,
            { orderId: savedRung.orderId, orderType: 'ladder_entry', error: orderStatus?.__err?.message }
          );
          failedLadderCatchUpIds.add(savedRung.orderId);
          continue;
        }
        if (!isTerminalStatus(orderStatus)) {
          // Missing from the open-orders snapshot but not terminal (a
          // listing race) — keep it for the sweep, which re-arms live rungs.
          failedLadderCatchUpIds.add(savedRung.orderId);
          continue;
        }
        const result = await catchUpTerminalEntry(savedRung, orderStatus, 'ladder_entry');
        if (result.outcome === 'failed') failedLadderCatchUpIds.add(savedRung.orderId);
      }
      // A catch-up that threw after handleOrderFill already dropped the live
      // row must not lose it — re-add from the snapshot (as entries do).
      const liveLadderIds = new Set((positionState.pendingLadderOrders || []).map(o => o.orderId));
      const droppedRetained = savedLadderSnapshot.filter(
        o => failedLadderCatchUpIds.has(o.orderId) && !liveLadderIds.has(o.orderId)
      );
      if (droppedRetained.length > 0) {
        positionState.pendingLadderOrders = [...(positionState.pendingLadderOrders || []), ...droppedRetained];
      }
    }

    // Restore or cancel persisted ladder orders. Gated on the PRE-catch-up
    // snapshot: a catch-up that booked (and so removed) every rung must still
    // reach the ladderActive=false reset below, exactly as the old purge of
    // those same no-longer-open rungs did.
    const savedLadderOrders = positionState.pendingLadderOrders || [];
    if (positionState.ladderActive && savedLadderSnapshot.length > 0) {
      let restoredLadder = 0;
      let cancelledLadder = 0;

      for (const order of openEntries) {
        if (savedLadderIds.has(order.orderId)) {
          const savedOrder = savedLadderOrders.find(o => o.orderId === order.orderId);
          getOrderExecutor().restorePendingOrder(order.orderId, {
            type: 'ladder_entry',
            price: savedOrder.price,
            size: savedOrder.assetQty,
            sizeUsdc: savedOrder.sizeUsdc,
            ladderIndex: savedOrder.ladderIndex,
            placedAt: order.createdTime ? new Date(order.createdTime).getTime() : (savedOrder.placedAt || Date.now()),
          });
          restoredLadder++;
        }
      }

      // Remove any saved ladder orders that are no longer open on the exchange
      // — except rungs whose offline catch-up above must be retried.
      const openOrderIds = new Set(openEntries.map(o => o.orderId));
      positionState.pendingLadderOrders = savedLadderOrders.filter(
        o => openOrderIds.has(o.orderId) || failedLadderCatchUpIds.has(o.orderId)
      );

      cancelledLadder = savedLadderOrders.length - positionState.pendingLadderOrders.length;

      if (positionState.pendingLadderOrders.length === 0) {
        positionState.ladderActive = false;
      }

      if (restoredLadder > 0) logger.info(`✅ [${exchange}] Restored ${restoredLadder} pending ladder orders`);
      if (cancelledLadder > 0) logger.info(`ℹ️ [${exchange}] ${cancelledLadder} saved ladder orders no longer open on exchange`);
    }
  };

  /** Restore saved legacy TP ownership without replacing uncertain exchange orders. */
  const restoreStartupLegacyTakeProfit = async () => {
    // Restore TP order tracking if we have an active TP order ID - but validate it exists first.
    // EXPIRED is a terminal cancellation per order-manager.js:49 — without
    // excluding it here, an EXPIRED order would be restored as an open TP
    // and block placement of a replacement. Same precedent across the
    // codebase: order-manager / order-executor / market-data-service all
    // treat EXPIRED as terminal-cancelled.
    if (positionState.activeTpOrderId) {
      let tpOrderStatus = null;
      let tpLookupFailed = false;
      try {
        tpOrderStatus = await getAdapter().getOrder(positionState.activeTpOrderId);
      } catch (err) {
        // Same rule as the body-TP restore below: only definitive not-found
        // clears tracking; transient failures must not orphan a live order.
        tpLookupFailed = !isOrderNotFoundError(err);
      }
      const tpOrderExists = tpLookupFailed || (tpOrderStatus
        && tpOrderStatus.status !== 'CANCELLED'
        && tpOrderStatus.status !== 'FAILED'
        && tpOrderStatus.status !== 'EXPIRED');

      if (tpOrderExists) {
        // Check if a celestial body owns this TP — restore as body_tp if so
        const bodyOwner = (positionState.celestialBodies || []).find(b => b.tpOrderId === positionState.activeTpOrderId);
        if (bodyOwner) {
          const placedAt = tpOrderStatus?.createdTime ? new Date(tpOrderStatus.createdTime).getTime() : (positionState.lastEntryTime || Date.now());
          getOrderExecutor().restoreBodyTpOrder(bodyOwner.id, positionState.activeTpOrderId, bodyOwner.assetQty, positionState.lastTpPrice, placedAt);
          logger.info(`📋 [${exchange}] Restored legacy TP as body_tp: ${positionState.activeTpOrderId.slice(0, 8)} → body ${bodyOwner.id.slice(-8)}`);
          positionState.activeTpOrderId = null;
          positionState.lastTpPrice = 0;
          positionState.assetOnOrder = 0;
        } else {
          getOrderExecutor().restorePendingOrder(positionState.activeTpOrderId, {
            type: 'take_profit',
            price: positionState.lastTpPrice,
            size: positionState.assetOnOrder || positionState.totalAsset,
            sizeUsdc: (positionState.lastTpPrice || 0) * (positionState.assetOnOrder || positionState.totalAsset),
            placedAt: tpOrderStatus?.createdTime ? new Date(tpOrderStatus.createdTime).getTime() : (positionState.lastEntryTime || Date.now()),
            status: 'open',
          });
          logger.info(`📋 [${exchange}] Restored TP order tracking: ${positionState.activeTpOrderId} @ ${fmtPrice(positionState.lastTpPrice)}`);
        }
      } else {
        // TP order no longer exists on exchange - clear tracking so a new one gets placed.
        //
        // KNOWN LIMITATION: cancelled-with-fills recovery is incomplete here.
        // The exchange may report status=CANCELLED with completionPercentage
        // anywhere in (0, 100] — both the partial case (cancel won the race
        // before all the asset filled) AND the full case (completion=100,
        // cancel-after-fill: the order completed in full before the cancel
        // was processed) land in this branch. checkOfflineOrderFills (which
        // ran earlier in startup) is the canonical fill-ingest path; if it
        // succeeded, positionState.totalAsset already reflects the sale and
        // clearing activeTpOrderId here is correct (no replacement TP gets
        // placed because totalAsset is 0). If it MISSED fills (REST call
        // failed, recent-trade window aged out, etc.), this branch will
        // clear the tracking and a subsequent regime tick can place a
        // replacement TP for an already-(partially-)sold position — even
        // ingesting fills here is insufficient on its own, because a
        // correct fix must also reduce positionState.totalAsset, recompute
        // avgCostBasis, and account for realized P&L from the sell.
        //
        // The same gap applies if the API process restarted while a market-
        // data-service cancel-retry was still pending — those retries live
        // in-memory only, so a restart loses them.
        //
        // The market-data-service catch-up retry covers the common case
        // while the engine is stopped. Engine-side recovery on startup +
        // disk-persisted retry markers are deferred; do not extend this
        // branch to ingest fills until that bookkeeping is in place.
        logger.warn(`⚠️ [${exchange}] Saved TP order ${positionState.activeTpOrderId} not found on exchange, clearing`);
        positionState.activeTpOrderId = null;
        positionState.lastTpPrice = 0;
        positionState.assetOnOrder = 0;
      }
    }
  };

  /** Reprice restored body orders only after all body tracking has been rebuilt. */
  const repriceStartupBodyTakeProfits = async (savedBodies) => {
    // Reprice any restored body TPs whose TP% exceeds the effective max
    // (fixes bodies that were placed with uncapped holdback floor), OR
    // that a manual buy extend flagged needsTpReprice while this engine
    // was stopped (issue #726 — extendPersistedBody grew the body's
    // assetQty but had no adapter/executor to safely cancel the live TP
    // itself, so it left a marker for this pass to pick up instead).
    // Every body that still carries a tpOrderId here had its executor
    // tracking restored just above, so cancel through the executor —
    // cancelBodyTpForReplace books any tranche sold during the cancel
    // instead of re-listing it (issue #670).
    for (const body of [...savedBodies]) {
      if (!body.tpOrderId || body.avgPrice <= 0) continue;
      const currentTpPct = ((body.tpPrice - body.avgPrice) / body.avgPrice) * 100;
      const bTierCfg = celestialHierarchy.getTierConfig(body.tier);
      const bEffectiveMax = config.tpMaxPercent * (bTierCfg.tpMaxScale || 1);
      // A manual TP override means the operator intentionally set this
      // PERCENTAGE — never second-guess it via the overpriced-vs-max
      // check below. But needsTpReprice is about SIZE, not price:
      // placeBodyTp reapplies body.manualTpPct whenever it re-places
      // (~line 5452), so a manual-TP body extended while the engine was
      // stopped must still go through this cancel+replace — skipping it
      // here left its TP undersized forever and the flag never cleared
      const overpriced = body.manualTpPct == null && currentTpPct > bEffectiveMax * 1.01;
      if (overpriced || body.needsTpReprice) {
        const reason = overpriced
          ? `TP% ${currentTpPct.toFixed(2)}% exceeds max ${bEffectiveMax.toFixed(2)}%`
          : 'extended by a manual buy import while stopped';
        logger.warn(`⚠️ [${exchange}] Body ${body.id.slice(-8)} needs TP reprice (${reason}) — cancelling and repricing`);
        const oldTp = body.tpOrderId;
        const outcome = await cancelBodyTpForReplace(body, 'Startup reprice');
        if (outcome === 'cancelled') {
          body.needsTpReprice = false;
          await placeBodyTp(body);
        } else if (outcome === 'booked') {
          // cancelBodyTpForReplace already booked the tranche that sold
          // during the cancel and re-placed a right-sized TP for the
          // body's new (reduced) shape itself — nothing left to do.
          body.needsTpReprice = false;
        } else if (outcome === 'filled') {
          logger.info(`📋 [${exchange}] Body TP ${oldTp.slice(0, 8)} needing reprice already filled — polling will process`);
        } else if (outcome === 'unresolved') {
          logger.warn(
            `⚠️ [${exchange}] Failed to cancel body TP ${oldTp} needing reprice`,
            { bodyId: body.id, orderId: oldTp }
          );
        }
        // 'booking_failed': leave needsTpReprice set — the reconcile
        // loop retries the booking independently, and a future startup
        // retries this pass too.
      }
    }
  };

  /** Restore body TP tracking and repair saved body metadata before repricing. */
  const restoreStartupBodyTakeProfits = async () => {
    // Restore celestial body TP order tracking from saved state
    const savedBodies = positionState.celestialBodies || [];
    if (savedBodies.length > 0) {
      let restoredBodies = 0;
      let expiredBodies = 0;

      // Backfill buyOrders for bodies that predate the tracking field
      for (const body of savedBodies) {
        if (!body.buyOrders) {
          body.buyOrders = (body.sourceOrderIds || []).map(oid => ({
            orderId: oid,
            price: body.avgPrice,
            assetQty: 0,
            sizeUsdc: 0,
            filledAt: body.createdAt || Date.now(),
          }));
        }
      }

      // Self-heal avgPrice for bodies where roundUSDC truncated precision
      for (const body of savedBodies) {
        if (body.assetQty > 0 && body.costBasis > 0) {
          const correctedAvg = body.costBasis / body.assetQty;
          if (Math.abs(correctedAvg - body.avgPrice) / correctedAvg > 0.001) {
            logger.info(`🔧 [${exchange}] correcting body avgPrice bodyId=${body.id} old=${body.avgPrice} new=${correctedAvg}`);
            body.avgPrice = correctedAvg;
          }
        }
      }

      for (const body of [...savedBodies]) {
        if (!body.tpOrderId) continue;

        let bodyStatus = null;
        let bodyLookupFailed = false;
        try {
          bodyStatus = await getAdapter().getOrder(body.tpOrderId);
        } catch (err) {
          // Only a definitive not-found means the order is gone. Network/
          // API failures keep the saved tpOrderId and restore tracking from
          // saved state below; the interval reconciler re-checks once
          // connectivity returns (see isOrderNotFoundError).
          bodyLookupFailed = !isOrderNotFoundError(err);
        }
        // Mirror the core-TP exists check: EXPIRED is terminal cancellation.
        const bodyExists = bodyLookupFailed || (bodyStatus
          && bodyStatus.status !== 'CANCELLED'
          && bodyStatus.status !== 'FAILED'
          && bodyStatus.status !== 'EXPIRED');

        if (bodyExists && isFilledStatus(bodyStatus)) {
          // Body filled while offline — handled in checkOfflineOrderFills above
          continue;
        }

        if (bodyExists) {
          const bodyPlacedAt = bodyStatus?.createdTime ? new Date(bodyStatus.createdTime).getTime() : Date.now();
          getOrderExecutor().restoreBodyTpOrder(
            body.id,
            body.tpOrderId,
            body.assetOnOrder || body.assetQty,
            body.tpPrice,
            bodyPlacedAt
          );
          restoredBodies++;
        } else {
          // Body TP no longer on exchange — re-place TP.
          // Same KNOWN LIMITATION as the core-TP branch above: cancelled-
          // with-fills recovery is incomplete. Both the partial case
          // (completion in (0,100)) and the full case (completion=100,
          // cancel-after-fill where the order finished before the cancel
          // was processed) land here — bodyExists filters out CANCELLED/
          // FAILED/EXPIRED before the FILLED-or-completion=100 short-
          // circuit at the top of this if. A body TP that filled before
          // cancellation needs body.assetQty / body.costBasis proration
          // and realized-P&L accounting; without it the replacement TP
          // would be sized incorrectly. checkOfflineOrderFills handles the
          // happy path; engine-side recovery is deferred.
          body.tpOrderId = null;
          expiredBodies++;
          // The old TP is already gone — whatever fresh TP gets placed
          // below (ensureTakeProfitPlaced, or the reprice pass below for
          // an overpriced %) will size against the CURRENT (already-grown)
          // assetQty. Nothing left for the reprice pass to cancel, so
          // clear the flag here too; otherwise a needless cancel+re-place
          // of the freshly-placed, already-correctly-sized TP would fire
          // on the NEXT restart.
          if (body.needsTpReprice) body.needsTpReprice = false;
        }
      }

      if (restoredBodies > 0) logger.info(`🌌 [${exchange}] Restored ${restoredBodies} celestial body TP orders`);
      if (expiredBodies > 0) logger.warn(`⚠️ [${exchange}] ${expiredBodies} body TP orders need re-placement`);

      await repriceStartupBodyTakeProfits(savedBodies);
    }
  };

  /**
   * Reconcile the recovered position with durable cycle boundaries and TP
   * tracking, then restore the entry-limit counter from the live ledger.
   * @param {import('./types').RegimePositionState} position
   * @param {boolean} hasSavedState
   */
  const reconcileStartupPosition = (position, hasSavedState) => {
    // Merge recovered position with any saved state
    // IMPORTANT: If saved state shows totalAsset=0 with cyclesCompleted>0, this means
    // a cycle was properly completed and reset. The recovery from fills will show
    // the "holdback" BTC as position (sum of buys minus sells), but this is NOT
    // an active position - it's accumulated BTC reserves from completed cycles.
    // Trust the saved state in this case.
    const savedTpOrderId = positionState.activeTpOrderId;
    const savedTpPrice = positionState.lastTpPrice;
    const savedTotalBTC = positionState.totalAsset;
    const savedCyclesCompleted = positionState.cyclesCompleted;
    // Cross-validate: if fill ledger has buys in the current cycle, the cycle is NOT completed
    // (saved state may have been corrupted by a previous buggy restart). In celestial mode
    // every engine buy is body-owned, so count ALL buys — getCurrentCycleBuysCount excludes
    // body-owned buys and would wrongly report an active cycle as completed (issue #210-A).
    const celestialMode = config.celestialEnabled !== false;
    const fillLedgerHasBuys = celestialMode
      ? fillLedger.getCurrentCycleAllBuysCount() > 0
      : fillLedger.getCurrentCycleBuysCount() > 0;
    const cycleWasCompleted = hasSavedState && savedTotalBTC === 0 && savedCyclesCompleted > 0
      && !fillLedgerHasBuys;

    if (cycleWasCompleted) {
      logger.info(`ℹ️ [${exchange}] Saved state shows completed cycle (${savedCyclesCompleted} cycles, 0 ${baseCurrency} position) - trusting saved state over recovery`);
    }

    replacePositionState({
      ...createInitialPositionState(),
      ...positionState, // Keep saved fields (realizedPnL, cyclesCompleted, celestialBodies, etc.)
      // Only override position fields that come from fill-ledger rebuild
      // (NOT realizedPnL, cyclesCompleted, celestialBodies, celestialState, etc.)
      totalAsset: cycleWasCompleted ? 0 : position.totalAsset,
      totalCostBasis: cycleWasCompleted ? 0 : position.totalCostBasis,
      avgCostBasis: cycleWasCompleted ? 0 : position.avgCostBasis,
      cycleBuys: cycleWasCompleted ? 0 : position.cycleBuys,
      lastEntryPrice: position.lastEntryPrice || positionState.lastEntryPrice,
      lastEntryTime: position.lastEntryTime || positionState.lastEntryTime,
      anchorPrice: position.anchorPrice || positionState.anchorPrice,
      activeTpOrderId: savedTpOrderId, // Restore TP tracking (not in fills)
      lastTpPrice: savedTpPrice,
    });

    // Auto-correct cycleBuys from fill ledger (source of truth). In celestial
    // mode all engine buys are body-owned, so count ALL current-cycle buys —
    // getCurrentCycleBuysCount excludes them and would zero the restored
    // counter, letting a mid-cycle restart double the per-cycle step exposure
    // (issue #210-A).
    const actualCycleBuys = celestialMode
      ? fillLedger.getCurrentCycleAllBuysCount()
      : fillLedger.getCurrentCycleBuysCount();
    if (positionState.cycleBuys !== actualCycleBuys) {
      logger.info(`🔧 [${exchange}] Auto-correcting cycleBuys: ${positionState.cycleBuys} -> ${actualCycleBuys} (from fill ledger)`);
      positionState.cycleBuys = actualCycleBuys;
    }
  };

  const cancelStaleStartupOrders = async () => {
    for (const staleOrderId of [...positionState._cancelOnStartup]) {
      const cancelResult = await getAdapter().cancelOrder(staleOrderId).catch(() => ({ success: false }));
      if (cancelResult.success) {
        logger.info(`🗑️ [${exchange}] Cancelled stale order from _cancelOnStartup: ${staleOrderId}`);
      } else {
        const status = await lookupOrNull('getOrder', staleOrderId, getAdapter().getOrder(staleOrderId));
        if (status && (status.status === 'FILLED' || status.status === 'CANCELLED')) {
          logger.info(`ℹ️ [${exchange}] Stale order ${staleOrderId} already ${status.status}`);
        } else {
          logger.warn(`⚠️ [${exchange}] Failed to cancel stale order ${staleOrderId}`);
          continue; // Keep failed IDs for next startup
        }
      }
      positionState._cancelOnStartup = positionState._cancelOnStartup.filter(id => id !== staleOrderId);
    }
    if (positionState._cancelOnStartup.length === 0) {
      delete positionState._cancelOnStartup;
    }
  };

  const restoreStartupCycleAccounting = (sealedLegacy) => {
    // Recalculate cycles from fill ledger for cycle counting and per-cycle details.
    const recalcResult = fillLedger.recalculateCycles();
    // Orphan recovery may renumber cycles. Re-point the durable boundary
    // (#606) at the ledger's live cycle and persist it now, or the next
    // restart restores a stale ID that names a different cycle (#675).
    // Folding null-cycle fills into the live cycle (#705) changes its
    // membership, so the counters restored above must be re-derived too.
    const cycleIdChanged = syncActiveCycleIdAfterRecalc(recalcResult);
    if (resyncLiveCycleCountersAfterRecalc(recalcResult) || cycleIdChanged) saveLiveState();
    if (recalcResult.cyclesCompleted > 0 || recalcResult.orphansFixed > 0 || sealedLegacy > 0) {
      positionState.cyclesCompleted = recalcResult.cyclesCompleted;
      refreshRealizedFromCyclePairs();
      logger.info(`📋 [${exchange}] Cycle-pair realized: $${positionState.realizedPnL.toFixed(2)} USD, ${positionState.realizedAssetPnL.toFixed(6)} ${baseCurrency} reserves (${recalcResult.cyclesCompleted} cycles)`);
    }

    // Backfill APY tracking start time from earliest fill in ledger
    const allFills = fillLedger.getAllFills();
    if (allFills.length > 0) {
      const earliestFillTime = allFills.reduce((earliest, fill) => {
        return fill.timestamp < earliest ? fill.timestamp : earliest;
      }, Infinity);
      if (earliestFillTime !== Infinity && _backfillEngineStart(positionState, config, earliestFillTime)) {
        logger.info(`📊 [${exchange}] APY tracking backfilled to first fill: ${new Date(earliestFillTime).toISOString()}, original=$${positionState.originalCapital}`);
      }
    }
  };

  const warnUntrackedExchangeSells = (exchangeOpenOrders) => {
    const trackedSellIds = new Set();
    if (positionState.activeTpOrderId) trackedSellIds.add(positionState.activeTpOrderId);
    for (const body of (positionState.celestialBodies || [])) {
      if (body.tpOrderId) trackedSellIds.add(body.tpOrderId);
    }
    const orphanedSells = exchangeOpenOrders.filter(o =>
      o.side.toUpperCase() === 'SELL' && !trackedSellIds.has(o.orderId) && o.size > 0
    );

    // Log orphaned sell orders but do NOT adopt them. Automatic reclamation
    // is unsafe — it can sell non-engine assets (user holdings, other bots).
    if (orphanedSells.length > 0) {
      for (const order of orphanedSells) {
        logger.warn(`⚠️ [${exchange}] Untracked sell order on exchange: ${order.orderId.slice(0, 8)} ${order.size.toFixed(8)} ${baseCurrency} @ ${fmtPrice(order.price)} — NOT adopting (manual review required)`);
      }
    }
  };

  const placeMissingBodyTakeProfits = async () => {
    // Ensure all celestial bodies have TP orders
    // (covers bodies with null tpOrderId from saved state, e.g. after a cancelled TP wasn't re-placed)
    const bodiesNeedingTp = (positionState.celestialBodies || []).filter(b => !b.tpOrderId && b.assetQty > 0);
    if (bodiesNeedingTp.length > 0) {
      logger.info(`🔧 [${exchange}] ${bodiesNeedingTp.length} celestial bodies need TP orders`);
      for (const body of bodiesNeedingTp) {
        await placeBodyTp(body);
      }
    }
  };

  const warnUntrackedPositionAsset = () => {
    // Log untracked position asset but do NOT create recovery bodies or place sells.
    // Automatic sell placement for untracked assets is unsafe — it can sell non-engine holdings.
    const allRecoveryBodies = positionState.celestialBodies || [];
    if (allRecoveryBodies.length > 0 && positionState.totalAsset > 0) {
      const trackedBtc = allRecoveryBodies.reduce((sum, b) => sum + b.assetQty, 0);
      const untrackedAsset = roundAsset(positionState.totalAsset - trackedBtc);
      if (untrackedAsset > 0.00000100) {
        logger.warn(`⚠️ [${exchange}] ${untrackedAsset.toFixed(8)} ${baseCurrency} in position not tracked by any body — manual review required`);
      }
    }
  };

  const ensureStartupLegacyTakeProfit = async () => {
    // Update TP if we have position but no order, OR if existing TP has drifted below minimum
    if (positionState.totalAsset > 0) {
      if (!positionState.activeTpOrderId) {
        await placeTakeProfitOrder();
      } else if (positionState.lastTpPrice > 0 && positionState.avgCostBasis > 0) {
        const currentTpPct = ((positionState.lastTpPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100;
        if (currentTpPct < config.tpMinPercent) {
          logger.warn(`⚠️ [${exchange}] TP has drifted below minimum: ${currentTpPct.toFixed(3)}% < ${config.tpMinPercent}% — rebuilding`);
          await placeTakeProfitOrder({ forceUpdate: true });
        }
      }
    }
  };

  const restoreStartupEntryOrders = async (exchangeOpenOrders) => {
    // Restore pending entry orders from saved state (instead of canceling them)
    const savedPendingEntries = positionState.pendingEntryOrders || [];
    const savedOrderIds = new Set(savedPendingEntries.map(e => e.orderId));

    // Reuse the exchange snapshot from orphan sell detection
    const openEntries = exchangeOpenOrders.filter(o => o.side.toUpperCase() === 'BUY');

    // Pre-build ladder order ID set so we don't flag them as orphans
    const savedLadderIds = new Set((positionState.pendingLadderOrders || []).map(o => o.orderId));

    const correctiveBuyIds = collectStartupBuyExclusions();
    await restoreStartupOpenEntries(savedPendingEntries, savedOrderIds, savedLadderIds, openEntries, correctiveBuyIds);
    const allOpenIds = await catchUpStartupSavedEntries(savedPendingEntries, exchangeOpenOrders);
    await restoreStartupLadderOrders(savedLadderIds, openEntries, allOpenIds);
  };

  const restoreStartupUnbookedEntryTranches = async () => {
    // Book entry tranches the ledger holds but no owning body records
    // (issue #756) first, so the seal counts them as open.
    const recoveredEntryTranches = await recoverUnbookedOwnedEntryTranches().catch(err => {
      logger.warn(`⚠️ [${exchange}] Unbooked entry tranche recovery failed: ${err.message}`, { error: err.message });
      return 0;
    });
    if (recoveredEntryTranches > 0) {
      logger.info(`🔧 [${exchange}] Booked unrecorded tranches of ${recoveredEntryTranches} entry order(s) into their own bodies`);
    }
  };

  /**
   * Run the live-fund startup recovery sequence, in order, before the engine
   * trades. Returns the structured start failure when saved state cannot be
   * loaded (the caller returns it from start()), or null once recovered.
   * @returns {Promise<{success: false, error: string, needsOperator: true}|null>}
   */
  const restoreAll = async () => {
    // First, try to load saved state for faster startup.
    // A corrupt regime-state.json throws by design (issue #108 — booting with
    // a zeroed position would abandon a live one). Refusing to trade is right;
    // throwing out of start() is not: it propagates to the engine process's
    // `startup().catch` → process.exit(1) → PM2 restart → the same corrupt
    // file, burning the restart budget in under a minute and leaving resting
    // orders with no process watching them. Return a structured failure
    // instead so the process stays up and regime:status can report it (#532).
    let hasSavedState;
    try {
      hasSavedState = loadLiveState();
      fillLedger.resumeBuyCorrections();
      fillLedger.resumeSellCorrections();
    } catch (err) {
      logger.error(
        `❌ [${fundLabel}] Cannot start — operator must repair state before trading resumes: ${err.message}`,
        { action: 'start', error: err.message }
      );
      tradeEvents.emitTradeEvent('error', exchange, `Engine start blocked: ${err.message}`, {
        action: 'start', pair, error: err.message,
      });
      return { success: false, error: err.message, needsOperator: true };
    }

    // An operator reset is a durable boundary, not a new fill. Restore it
    // before exchange recovery and cycleBuys auto-correction; otherwise the
    // fill ledger's active-cycle heuristic can resurrect the pre-reset cycle
    // and immediately re-apply the buy limit after a restart.
    if (hasSavedState) {
      restorePersistedCycleId(fillLedger, positionState, logger, exchange);
    }

    // Then recover/validate from exchange (source of truth)
    const { position } = await getRecoveryModule().recoverState(fillLedger, getOrderExecutor());

    reconcileStartupPosition(position, hasSavedState);

    await restoreStartupUnbookedEntryTranches();

    // Seal legacy closure into per-buy consumption records while the
    // sellOrderId links still say which orders were closed (issue #607).
    // Must run BEFORE anything that can place a body TP — offline fill
    // recovery, TP repricing — because placeBodyTp re-stamps sellOrderId
    // on every row of the order, erasing the evidence.
    const sealedLegacy = sealLegacyClosure();
    if (sealedLegacy > 0) {
      fillLedger.persist();
      logger.info(`🔒 [${exchange}] Sealed legacy closure of ${sealedLegacy} buy order(s) into consumption records`);
    }

    // Check for orders that filled while we were offline (non-critical, continue on error)
    const offlineFills = await checkOfflineOrderFills().catch(err => {
      logger.warn(`⚠️ [${exchange}] Failed to check offline fills: ${err.message}`, { error: err.message });
      return { tpFilled: false, entriesFilled: 0 };
    });
    if (offlineFills.tpFilled || offlineFills.entriesFilled > 0) {
      logger.info(`📋 [${exchange}] Processed offline fills: TP=${offlineFills.tpFilled}, entries=${offlineFills.entriesFilled}`);
    }

    // Get current price and re-evaluate position. A ticker without a usable
    // price (adapter throws PRICE_UNAVAILABLE) skips the re-evaluation, as a
    // NaN price did before the adapters started rejecting it; the next tick
    // re-evaluates anyway, and this must not block the fund's start.
    const currentPrice = await getAdapter().getCurrentPrice(productId).catch((err) => {
      if (err?.code !== 'PRICE_UNAVAILABLE') throw err;
      logger.warn(`⚠️ [${exchange}] ${err.message} — skipping post-restart re-evaluation`, { productId });
      return null;
    });
    if (currentPrice > 0 && positionState.totalAsset > 0) {
      reEvaluateAfterDowntime(currentPrice);
    }

    // If we have position but no TP order, place one
    if (positionState.totalAsset > 0 && !positionState.activeTpOrderId) {
      logger.info(`📝 [${exchange}] Position exists but no TP order, will place after metrics update`);
    }

    await restoreStartupLegacyTakeProfit();

    // Cancel stale orders flagged for cleanup (e.g. partially-filled TPs from prior crashes)
    if (positionState._cancelOnStartup?.length > 0) {
      await cancelStaleStartupOrders();
    }

    await restoreStartupBodyTakeProfits();

    // Detect orphaned sell orders on exchange that we lost track of
    const exchangeOpenOrders = await getAdapter().getOpenOrders(productId);
    warnUntrackedExchangeSells(exchangeOpenOrders);

    // Repair historical fill annotations (orphan recovery, size fuzzy-match, -recovered- cycle rewrites)
    repairHistoricalFillAnnotations({
      fillLedger, positionState, config, logger, baseCurrency, priceIncrement: getPriceIncrement(), exchange,
      celestialHierarchy, calculateDynamicTpPercent, roundPrice, roundAsset, fmtPrice,
      mergeSnapshotTpOrderIds: [
        ...pendingMergeTpOrders.keys(),
        ...[...completedMergeTpOrders].map(([orderId]) => orderId),
      ],
    });

    // Sync position totals from celestial bodies (ensures recovery didn't zero them out)
    if ((positionState.celestialBodies || []).length > 0) {
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    }

    // Load closed-trades audit log, then always attempt migration. migrateFromFills
    // is a no-op when trades.length > 0, so this is safe to call unconditionally
    // and it self-heals the case where closed-trades.json was cleared to "[]" but
    // the file still exists (load() returns true for empty file → migrate was
    // skipped, leaving the audit log permanently out-of-sync with the ledger).
    closedTrades.load();
    closedTrades.migrateFromFills(fillLedger);

    restoreStartupCycleAccounting(sealedLegacy);

    await restoreStartupEntryOrders(exchangeOpenOrders);

    await placeMissingBodyTakeProfits();

    warnUntrackedPositionAsset();

    await ensureStartupLegacyTakeProfit();

    // Save initial state after recovery
    saveLiveState();
    return null;
  };

  return { restoreAll, checkOfflineOrderFills };
};

module.exports = { createStartupRecovery };
