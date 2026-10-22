/**
 * Fill-ledger annotation repair for the regime engine.
 *
 * Extracted verbatim from regime-engine.js (issue #1596): the startup
 * self-healing passes that annotate historical buy/sell rows, recover orphan
 * buys into bodies, re-home recovered-cycle fills and plan body growth from
 * recovered partial rows. They operate on the fill ledger and position state
 * passed in and keep no state of their own. No accounting changes — code move
 * only; per-sell bodyPnl/bodyHoldbackAsset annotations are written exactly as
 * before (see the P&L model in CLAUDE.md).
 */

const celestialHierarchy = require('./celestial-hierarchy');
const { roundAsset, roundUSDC } = require('./volatility-utils');

/**
 * Restore the operator-selected cycle boundary before recovery rebuilds the
 * position from fills. Older state files omit this marker and deliberately
 * fall back to the fill-ledger heuristic.
 * @param {Object} fillLedger
 * @param {RegimePositionState} positionState
 * @param {Object} logger
 * @param {string} exchange
 * @returns {boolean} Whether a valid persisted cycle ID was applied
 */
const restorePersistedCycleId = (fillLedger, positionState, logger, exchange) => {
  const persistedCycleId = positionState?.activeCycleId;
  if (typeof persistedCycleId !== 'string' || !/^cycle-\d+$/.test(persistedCycleId)) {
    return false;
  }

  const previousCycleId = fillLedger.getCurrentCycleId();
  if (previousCycleId !== persistedCycleId) {
    logger.info(`🔄 [${exchange}] Restoring persisted active cycle: ${persistedCycleId}`, {
      previousCycleId,
      cycleId: persistedCycleId,
    });
  }
  // Carry the persisted start time (#705) so recalculateCycles has a live-
  // cycle boundary even while the post-reset cycle holds no fills yet.
  fillLedger.setCurrentCycleId(persistedCycleId, positionState.activeCycleStartedAt ?? null);
  return true;
};

/**
 * Step 0: recover orphan buys — ledger fills from the current cycle that have
 * no bodyId AND aren't referenced by any body. These come from
 * handleOrderFill being interrupted (e.g. SIGINT during pm2 restart)
 * between fillLedger.ingestFill and the body-merge/annotation step.
 * Merge each orphan order into the historically-eligible body whose TP
 * is closest to where the orphan's TP would have landed. The body's
 * reconcile loop will then detect the assetQty/assetOnOrder mismatch
 * on the next tick and cancel-replace the TP at the new size.
 * @returns {number} orphan orders merged into a body
 */
const recoverOrphanBuys = (deps, cycleFills) => {
  const { fillLedger, positionState, config, logger, baseCurrency, priceIncrement, exchange,
    celestialHierarchy, calculateDynamicTpPercent, roundPrice, fmtPrice } = deps;
  const knownBuyOrderIds = new Set();
  for (const body of (positionState.celestialBodies || [])) {
    for (const oid of (body.sourceOrderIds || [])) knownBuyOrderIds.add(oid);
    for (const buy of (body.buyOrders || [])) if (buy.orderId) knownBuyOrderIds.add(buy.orderId);
  }
  // Fills recalculateCycles folded into this cycle purely by timestamp
  // (#705) are excluded: nothing links them to an engine order (sync-fills
  // re-imports manual trades too), so adopting one into a body would place
  // an automatic sell for it — manual review only (R2, pnl-architecture.md).
  const orphanBuyFills = cycleFills.filter(f =>
    f.side === 'buy' && !f.bodyId
    && f.cycleAttribution !== 'timeframe'
    && !String(f.tradeId).startsWith('dca-convert')
    && !knownBuyOrderIds.has(f.orderId)
  );
  const orphansByOrderId = new Map();
  for (const f of orphanBuyFills) {
    if (!orphansByOrderId.has(f.orderId)) orphansByOrderId.set(f.orderId, []);
    orphansByOrderId.get(f.orderId).push(f);
  }

  let recoveredCount = 0;
  for (const [orderId, fills] of orphansByOrderId) {
    const summary = fillLedger.aggregateFills(fills);
    const fillTime = Math.max(...fills.map(f => f.timestamp));
    const newBuy = {
      assetQty: summary.totalSize,
      costBasis: summary.totalValue + (summary.totalFees || 0),
      avgPrice: summary.avgPrice,
      buyOrderId: orderId,
    };
    const candidateTpPrice = roundPrice(summary.avgPrice * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

    // Restrict to bodies that existed at the orphan's fill time
    const eligibleBodies = (positionState.celestialBodies || []).filter(b => !b.createdAt || b.createdAt <= fillTime);
    const target = pickOrphanMergeTarget(eligibleBodies, newBuy, candidateTpPrice, deps);
    if (!target) {
      logger.warn(`⚠️ [${exchange}] Orphan buy ${orderId.slice(0, 8)} (${summary.totalSize.toFixed(8)} ${baseCurrency}): no eligible body to merge into, leaving unattributed`);
      continue;
    }

    const merged = celestialHierarchy.mergeIntoBody(target, newBuy, config.maxUsdcDeployed, orderId, logger);
    // Overwrite mergeIntoBody's Date.now() lastMergedAt with the orphan's
    // actual fill time, and the appended buyOrder's filledAt likewise.
    merged.lastMergedAt = fillTime;
    if (merged.buyOrders && merged.buyOrders.length > 0) {
      merged.buyOrders[merged.buyOrders.length - 1].filledAt = fillTime;
    }

    const annotation = { isBodyOwned: true, bodyId: merged.id, bodyTier: merged.tier };
    if (merged.tpOrderId) annotation.sellOrderId = merged.tpOrderId;
    fillLedger.annotateFillsByOrderId(orderId, annotation);

    // A still-tracked entry (or ladder rung) shrinks by what was just booked
    // from it, as the live fill path does — its remainder is the evidence startup uses to
    // prove a later tranche unbooked (issue #756).
    for (const list of ['pendingEntryOrders', 'pendingLadderOrders']) {
      if (!positionState[list]?.some(e => e.orderId === orderId)) continue;
      positionState[list] = positionState[list].map(e => (e.orderId !== orderId ? e : {
        ...e,
        assetQty: Math.max(0, (Number(e.assetQty) || 0) - newBuy.assetQty),
        sizeUsdc: Math.max(0, (Number(e.sizeUsdc) || 0) - newBuy.costBasis),
      }));
    }

    const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
    logger.info(`🔧 [${exchange}] Recovered orphan buy ${orderId.slice(0, 8)} (${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}) → body ${merged.id.slice(-8)} ${tierCfg.emoji} ${merged.tier}`);
    recoveredCount++;
  }

  if (recoveredCount > 0) {
    celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed, logger);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    logger.info(`🔧 [${exchange}] Recovered ${recoveredCount} orphan buy order(s) into bodies; reconcile loop will re-place affected TPs`);
  }
  return recoveredCount;
};

/**
 * Merge target for an orphan buy: the hierarchy's proximity match, else the
 * eligible body whose tpPrice is closest to where the orphan's TP would land.
 */
const pickOrphanMergeTarget = (eligibleBodies, newBuy, candidateTpPrice, { config, celestialHierarchy }) => {
  const target = celestialHierarchy.findMergeTarget(
    eligibleBodies, newBuy, {
      maxUsdcDeployed: config.maxUsdcDeployed,
      candidateTpPrice,
      maxBodies: config.maxCelestialBodies || 10,
      pendingOrderCount: 0,
      maxOpenOrders: config.maxOpenOrders,
      proximityScale: config.mergeProximityScale ?? 1.0
    }
  );
  if (target) return target;
  let closest = null;
  let bestDist = Infinity;
  for (const b of eligibleBodies) {
    if (!b.tpPrice || b.tpPrice <= 0) continue;
    const d = Math.abs(b.tpPrice - candidateTpPrice);
    if (d < bestDist) { bestDist = d; closest = b; }
  }
  return closest;
};

/**
 * Step 1: annotate buy fills for active celestial bodies (sourceOrderIds and
 * buyOrders). Also fixes fills that have isBodyOwned but are missing bodyId
 * (e.g. from the DCA merge converter).
 * @returns {number} buy fill rows annotated
 */
const annotateBodyBuyFills = (positionState, fillLedger, cycleFills) => {
  let annotatedCount = 0;
  for (const body of (positionState.celestialBodies || [])) {
    const annotation = { isBodyOwned: true, bodyId: body.id, bodyTier: body.tier };
    if (body.tpOrderId) annotation.sellOrderId = body.tpOrderId;
    const orderIds = new Set([
      ...(body.sourceOrderIds || []),
      ...(body.buyOrders || []).map(b => b.orderId).filter(oid => oid !== 'core-migration'),
    ]);
    for (const orderId of orderIds) {
      const buyFills = cycleFills.filter(f => f.orderId === orderId && !(f.isSatellite) && (!f.isBodyOwned || !f.bodyId));
      if (buyFills.length > 0) {
        fillLedger.annotateFillsByOrderId(orderId, annotation);
        annotatedCount += buyFills.length;
      }
    }
  }
  return annotatedCount;
};

/**
 * Collapse execution rows into one record per orderId (size/quote/fee summed,
 * timestamp = last row) so a multi-row order is matched and annotated once.
 */
const groupFillsByOrder = (fills) => {
  const byOrder = new Map();
  for (const f of fills) {
    const fee = f.netFee || f.fee || 0;
    const agg = byOrder.get(f.orderId);
    if (!agg) {
      byOrder.set(f.orderId, { orderId: f.orderId, size: f.size, quoteAmount: f.quoteAmount, fee, timestamp: f.timestamp, price: f.price, rows: 1 });
      continue;
    }
    agg.size += f.size;
    agg.quoteAmount += f.quoteAmount;
    agg.fee += fee;
    agg.timestamp = Math.max(agg.timestamp, f.timestamp);
    agg.rows++;
  }
  return [...byOrder.values()].map(o => (o.rows > 1 && o.size > 0 ? { ...o, price: o.quoteAmount / o.size } : o));
};

/**
 * Buy matching a sell: similar asset size (±1%), earlier than the sell, not
 * unavailable (already paired this pass, consumed, or owned by a live body),
 * and closest in time (a body TP is placed right after its buy).
 */
const matchBuyForSell = (sellFill, buyFills, unavailable) => {
  let best = null;
  for (const buy of buyFills) {
    if (unavailable.has(buy.orderId)) continue;
    const sizeRatio = buy.size / sellFill.size;
    if (!(sizeRatio > 0.99 && sizeRatio < 1.01) || !(buy.timestamp < sellFill.timestamp)) continue;
    if (!best || (sellFill.timestamp - buy.timestamp) < (sellFill.timestamp - best.timestamp)) best = buy;
  }
  return best;
};

/**
 * Step 2: re-derive PnL/holdback for unannotated or badly-annotated body sells
 * (non-core-TP sells missing isBodyOwned, or with negative PnL/holdback).
 * @param {Object} deps - repairHistoricalFillAnnotations deps
 * @param {Iterable<string>} [deps.mergeSnapshotTpOrderIds] - TP order ids held
 *   by a pending/completed merge snapshot (still owed a snapshot booking)
 * @param {Object[]} cycleFills - Current-cycle ledger rows
 * @returns {number} annotation operations applied
 */
const annotateBodySells = ({ fillLedger, positionState, logger, baseCurrency, exchange, roundAsset, mergeSnapshotTpOrderIds }, cycleFills) => {
  const coreTpOrderId = positionState.activeTpOrderId;
  const liveBodies = positionState.celestialBodies || [];
  // Ownership is decided per ORDER, not per row: annotateFillsByOrderId writes
  // every row of an order, but a row ingested after an annotation carries none
  // of it. Foreign sells (`untrackedSell`, #750) and timestamp-folded rows
  // (`cycleAttribution: 'timeframe'`, #705) were deliberately left unattributed,
  // and an order with a valid annotation is already booked; re-booking either
  // would turn it into realized P&L or overwrite the correct per-order bodyPnl.
  // A live body's TP (or a merge snapshot's) is still owed its real booking:
  // rows recovered while the engine was down (a partial of a still-resting
  // TP) are booked by the fill path, which a guessed annotation here would
  // corrupt (issue #1398).
  const skippedOrderIds = new Set([
    ...liveBodies.map(b => b.tpOrderId),
    ...(mergeSnapshotTpOrderIds || []),
  ].filter(Boolean));
  // A buy a live body owns is still held; one with a consumption record was
  // already closed by the sell(s) it names. Neither may be paired again.
  const liveBodyIds = new Set(liveBodies.map(b => b.id));
  const unavailableBuyOrderIds = new Set(liveBodies.flatMap(b => [
    ...(b.sourceOrderIds || []),
    ...(b.buyOrders || []).map(e => e && e.orderId),
  ]).filter(Boolean));
  for (const f of cycleFills) {
    if (f.side !== 'buy') continue;
    if ((f.bodyId && liveBodyIds.has(f.bodyId)) || (f.consumedBy && typeof f.consumedBy === 'object')) {
      unavailableBuyOrderIds.add(f.orderId);
    }
  }
  const sellRowsByOrder = new Map();
  for (const f of cycleFills) {
    if (f.side !== 'sell' || f.orderId === coreTpOrderId) continue;
    if (!sellRowsByOrder.has(f.orderId)) sellRowsByOrder.set(f.orderId, []);
    sellRowsByOrder.get(f.orderId).push(f);
    const isBooked = f.bodyBookedSize != null || f.bodyBooked;
    const invalidAnnotation = (f.bodyPnl ?? f.satellitePnl) < 0 || (f.bodyHoldbackAsset ?? f.satelliteHoldbackAsset) < 0;
    if (f.untrackedSell || f.cycleAttribution === 'timeframe'
      || isBooked || ((f.isBodyOwned || f.isSatellite) && !invalidAnnotation)) skippedOrderIds.add(f.orderId);
  }
  // Chronological by aggregate (last-row) timestamp: grouping keeps each order at
  // its first row's position, so interleaved partial fills of two orders would
  // otherwise let the later-completing order claim the nearer buy first.
  const sellsToAnnotate = groupFillsByOrder([...sellRowsByOrder]
    .filter(([orderId]) => !skippedOrderIds.has(orderId))
    .flatMap(([, rows]) => rows))
    .sort((a, b) => a.timestamp - b.timestamp);
  const buyFills = groupFillsByOrder(cycleFills.filter(f => f.side === 'buy'));
  const rejectedSellOrderIds = [];
  let annotatedCount = 0;

  for (const sellFill of sellsToAnnotate) {
    const matchingBuy = matchBuyForSell(sellFill, buyFills, unavailableBuyOrderIds);
    if (!matchingBuy) continue;

    const costBasis = matchingBuy.quoteAmount + matchingBuy.fee;
    const proceeds = sellFill.quoteAmount - sellFill.fee;
    const pnl = proceeds - costBasis;
    const holdbackAsset = roundAsset(matchingBuy.size - sellFill.size);

    // Sanity check: body PnL should be positive and holdback non-negative
    if (pnl >= 0 && holdbackAsset >= 0) {
      unavailableBuyOrderIds.add(matchingBuy.orderId);
      fillLedger.annotateFillsByOrderId(sellFill.orderId, {
        isBodyOwned: true,
        bodyCostBasis: costBasis,
        bodyAvgPrice: matchingBuy.price,
        bodyBtcQty: matchingBuy.size,
        bodyHoldbackAsset: holdbackAsset,
        bodyPnl: pnl,
      });
      fillLedger.annotateFillsByOrderId(matchingBuy.orderId, { isBodyOwned: true, sellOrderId: sellFill.orderId });
      annotatedCount += 2;
      logger.info(`🔧 [${exchange}] Annotated body sell: ${sellFill.orderId.slice(0, 8)} PnL=$${pnl.toFixed(4)}, holdback=${holdbackAsset.toFixed(8)} ${baseCurrency}`);
    } else {
      // A size match with an impossible P&L is no pairing, and no proof the
      // sell is the engine's: leave it unannotated. Stamping isBodyOwned would
      // make the fill path skip a foreign sell as "already booked" instead of
      // flagging it untrackedSell (issue #1398). The buy stays available.
      // Such a sell is re-examined every boot, so it is logged once in total.
      rejectedSellOrderIds.push(sellFill.orderId);
    }
  }
  if (rejectedSellOrderIds.length > 0) {
    logger.warn(`⚠️ [${exchange}] Left ${rejectedSellOrderIds.length} sell(s) unannotated — size-matched buy gives no valid PnL: ${rejectedSellOrderIds.map(id => id.slice(0, 8)).join(', ')}`);
  }
  return annotatedCount;
};

/**
 * Step 3: fix fills with wrong cycle IDs (recovered-* cycles that belong in the
 * current one). Only fills within the current cycle's timeframe move.
 * @returns {number} fills moved
 */
const moveRecoveredCycleFills = ({ fillLedger, logger, exchange }, currentCycleId) => {
  const currentCycleFills = fillLedger.getCurrentCycleFills();
  const cycleStartTs = currentCycleFills.length > 0
    ? Math.min(...currentCycleFills.map(f => f.timestamp))
    : Date.now();
  let movedCount = 0;
  for (const fill of fillLedger.getAllFills()) {
    if (fill.cycleId && fill.cycleId.includes('-recovered-')
      && fill.cycleId !== currentCycleId && fill.timestamp >= cycleStartTs) {
      const oldCycleId = fill.cycleId;
      fillLedger.updateFillCycleId(fill.tradeId, currentCycleId);
      movedCount++;
      logger.info(`🔧 [${exchange}] Moved fill ${fill.tradeId.slice(0, 8)} from ${oldCycleId} to ${currentCycleId}`);
    }
  }
  return movedCount;
};

/**
 * Repair historical fill annotations from ledger.
 * Performs four steps of self-healing for fills that predate annotation code:
 * 0. recoverOrphanBuys — merge orphan buys into historical bodies
 * 1. annotateBodyBuyFills — stamp buy fills of active celestial bodies
 * 2. annotateBodySells — match unannotated body sells to buys (1% size fuzzy-match)
 * 3. moveRecoveredCycleFills — rewrite -recovered- cycle IDs to current cycle
 * @param {Object} deps - Helper dependencies
 * @param {Object} deps.fillLedger - Fill ledger instance
 * @param {Object} deps.positionState - Current position state
 * @param {Object} deps.config - Engine configuration
 * @param {Object} deps.logger - Logger instance
 * @param {string} deps.baseCurrency - Asset symbol (e.g., 'BTC')
 * @param {number} deps.priceIncrement - Min price increment for TP rounding
 * @param {string} deps.exchange - Exchange name for logging
 * @param {Object} deps.celestialHierarchy - Celestial body manager
 * @param {Function} deps.calculateDynamicTpPercent - TP % calculator
 * @param {Function} deps.roundPrice - Price rounding utility
 * @param {Function} deps.roundAsset - Asset qty rounding utility
 * @param {Function} deps.fmtPrice - Price formatting utility
 * @param {Iterable<string>} [deps.mergeSnapshotTpOrderIds] - TP order ids of
 *   pending/completed merge snapshots; their sells are never re-derived
 */
const repairHistoricalFillAnnotations = (deps) => {
  const { fillLedger, positionState, logger, exchange } = deps;
  // Retroactively annotate body fills that are missing isBodyOwned flag
  // This fixes historical fills that were processed before annotation code was deployed
  const currentCycleId = fillLedger.getCurrentCycleId();
  if (!currentCycleId) return;
  const cycleFills = fillLedger.getCurrentCycleFills();

  // Orphan recovery is counted separately in its own log line, not in the annotated total.
  recoverOrphanBuys(deps, cycleFills);
  const annotatedCount = annotateBodyBuyFills(positionState, fillLedger, cycleFills)
    + annotateBodySells(deps, cycleFills)
    + moveRecoveredCycleFills(deps, currentCycleId);

  if (annotatedCount > 0) {
    fillLedger.persist();
    logger.info(`🔧 [${exchange}] Annotated ${annotatedCount} satellite fills for correct tracking`);
  }
};

/** Ledger rows the engine synthesized in place of real exchange fills. */
const PSEUDO_FILL_TRADE_ID = /^(synthetic-|consolidated-sell-)/;

/**
 * Plan how live bodies must grow to cover recovered partial rows of their own
 * buy orders (issue #752). recalculateCycles places a null-cycle buy row
 * that shares its orderId with a body-owned order into that order's cycle
 * and copies its ownership (`cycleAttribution: 'order'`, #705) — but the
 * body's assetQty/costBasis were sized from the rows known when the fill was
 * handled, so its TP stays sized for less than the position actually held.
 *
 * Guards — this is the engine's OWN linked order, never an unlinked import
 * (R2 in docs/pnl-architecture.md):
 *   - only orders with at least one `'order'`-attributed buy row are
 *     considered ('link' / 'timeframe' rows never grow a body);
 *   - the order has no synthetic gap row (which recovered rows may duplicate);
 *   - every owned row of the order names ONE bodyId, and exactly one live
 *     body — that one — records the order in its `buyOrders`;
 *   - growth is the exact shortfall of the order's full ledger totals over
 *     the body's recorded share (computeBuyOrderShortfall), so repeated
 *     calls converge, and it may not exceed the attributed rows' own size —
 *     a larger gap is some other discrepancy and is left for manual review.
 * Pure: never mutates the ledger or a body.
 * @param {Object} params
 * @param {Object} params.fillLedger - Fill ledger instance
 * @param {Object[]} params.celestialBodies - Live bodies
 * @returns {{ plans: Array<{body: Object, buyOrderId: string, totals: {assetQty: number, costBasis: number, avgPrice: number}, shortfall: {assetQty: number, costBasis: number, avgPrice: number}}>, skipped: Array<{buyOrderId: string, reason: string}> }}
 */
const planBodyGrowthFromRecoveredBuyRows = ({ fillLedger, celestialBodies }) => {
  const plans = [];
  const skipped = [];
  const bodies = celestialBodies || [];
  const candidateOrderIds = new Set();
  for (const f of fillLedger.getAllFills()) {
    if (f.side === 'buy' && f.cycleAttribution === 'order' && f.bodyId && f.orderId
      && !String(f.tradeId).startsWith('dca-convert')) {
      candidateOrderIds.add(f.orderId);
    }
  }
  for (const buyOrderId of candidateOrderIds) {
    const rows = fillLedger.getFillsForOrder(buyOrderId).filter(r => r.side === 'buy');
    // A pseudo row (`synthetic-<orderId>-<size>`, handleOrderFill's gap fill
    // when the exchange returned no fills) stands in for real executions that
    // sync-fills may since have re-imported under their real tradeIds — the
    // very rows attributed here. Summing both would grow the body by asset it
    // never bought, so leave such an order for manual review
    // (scripts/backfill-missing-fills.js replaces pseudo rows).
    if (rows.some(r => PSEUDO_FILL_TRADE_ID.test(String(r.tradeId)))) {
      skipped.push({ buyOrderId, reason: 'order has a synthetic gap row that recovered rows may duplicate' });
      continue;
    }
    const bodyIds = new Set(rows.map(r => r.bodyId).filter(Boolean));
    if (bodyIds.size !== 1) {
      skipped.push({ buyOrderId, reason: `rows name ${bodyIds.size} bodies` });
      continue;
    }
    const [bodyId] = bodyIds;
    const owners = bodies.filter(b => (b.buyOrders || []).some(bo => bo.orderId === buyOrderId));
    // No owner: the body already closed (its TP sold) — nothing live to grow.
    if (owners.length === 0) continue;
    if (owners.length !== 1 || owners[0].id !== bodyId) {
      skipped.push({ buyOrderId, reason: `order recorded by ${owners.length} live bodies, not only ${bodyId}` });
      continue;
    }
    const body = owners[0];
    const qty = rows.reduce((sum, r) => sum + (r.size || 0), 0);
    const quote = rows.reduce((sum, r) => sum + (r.quoteAmount || 0), 0);
    const totals = {
      assetQty: roundAsset(qty),
      costBasis: roundUSDC(rows.reduce((sum, r) => sum + (r.quoteAmount || 0) + (r.netFee || 0), 0)),
      avgPrice: qty > 0 ? quote / qty : 0,
    };
    const { shortfall } = celestialHierarchy.computeBuyOrderShortfall(body, totals, buyOrderId);
    if (!shortfall) continue;
    const attributedQty = rows
      .filter(r => r.cycleAttribution === 'order')
      .reduce((sum, r) => sum + (r.size || 0), 0);
    if (shortfall.assetQty > attributedQty + 0.00000001) {
      skipped.push({ buyOrderId, reason: `shortfall ${shortfall.assetQty} exceeds recovered rows ${roundAsset(attributedQty)}` });
      continue;
    }
    plans.push({ body, buyOrderId, totals, shortfall });
  }
  return { plans, skipped };
};

module.exports = {
  restorePersistedCycleId,
  repairHistoricalFillAnnotations,
  planBodyGrowthFromRecoveredBuyRows,
};
