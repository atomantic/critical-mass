/**
 * Pure decision and planning functions for the regime engine's fill booking.
 *
 * Extracted from the fill handlers in regime-engine.js (issue #1607):
 * `handleBodyTpFill`, `commitMergedSnapshotSell`, `handleUntrackedSellFill`
 * and `ingestOrderFillEvidence`. Nothing here awaits, performs I/O or mutates
 * its arguments: each function reads the body / summary / fill rows it is
 * handed and returns numbers or plain objects. The engine applies the result
 * in the same synchronous block it always did, so every commit point (capital
 * credit, per-buy consumption, the sell's booking annotation) still lands
 * before the handler's first await. Formulas are unchanged — code move only.
 *
 * P&L model reminders (see CLAUDE.md): designed holdback is NOT a partial
 * fill. A healthy TP sells `body.assetOnOrder < body.assetQty`; the true
 * partial case is `summary.totalSize < body.assetOnOrder`, and cost basis is
 * prorated by `summary.totalSize / body.assetQty`.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');
const { splitTpHoldback } = require('./regime-pure-helpers');

/**
 * Classify a body TP sale and price it against the body (or a merge snapshot
 * of it) as the body stood before the sale.
 *
 * A TRUE partial is a TP placed for `body.assetOnOrder` that the exchange
 * filled less than (1% tolerance for rounding/fees). This is distinct from
 * designed holdback (totalSize === assetOnOrder < assetQty on a healthy 100%
 * fill). Comparing against assetQty (the old soldRatio<0.95 check)
 * misclassified healthy fills as partial whenever holdback was ≳ 5% of the
 * body — zeroing the reserve and re-listing it for sale (issue #107 M1). The
 * soldRatio heuristic remains only as the fallback when assetOnOrder is
 * missing (legacy bodies / migration) so behavior degrades safely.
 *
 * A sale that took the body's whole inventory is never a partial, even when a
 * stale TP's assetOnOrder (sized for a larger, pre-deduction body) says it
 * filled less than planned: nothing is left to re-list, and the partial path
 * would drive assetQty negative. Designed holdback keeps a healthy fill
 * strictly below assetQty (issue #770).
 *
 * `isPartialFill` is the caller's own partial flag, OR'd in exactly as the
 * live body path always did. The merge-snapshot path passes none: its callers
 * hardcode the flag to true, so it is not a usable signal there.
 *
 * @param {Object} args
 * @param {{assetQty: number, costBasis: number, assetOnOrder?: number}} args.body - Pre-sale body or merge snapshot
 * @param {{totalSize: number, totalValue: number, totalFees: number}} args.summary - aggregateFills result for the sale
 * @param {*} [args.isPartialFill] - The fill's own partial flag (body path only)
 * @returns {{proceeds: number, soldRatio: number, proratedCostBasis: number, pnl: number,
 *   holdbackAsset: number, reservesSoldAsset: number, soldWholeBody: boolean, isPartial: boolean}}
 */
const classifyTpFill = ({ body, summary, isPartialFill }) => {
  const proceeds = summary.totalValue - summary.totalFees;
  // Prorate cost basis when sell doesn't cover full body (stale TP / partial fill)
  const soldRatio = body.assetQty > 0 ? Math.min(summary.totalSize / body.assetQty, 1) : 1;
  const proratedCostBasis = roundUSDC(body.costBasis * soldRatio);
  const pnl = proceeds - proratedCostBasis;
  const { holdbackAsset, reservesSoldAsset } = splitTpHoldback(roundAsset(body.assetQty - summary.totalSize));

  const onOrder = body.assetOnOrder || 0;
  const soldWholeBody = body.assetQty > 0 && summary.totalSize >= body.assetQty;
  const isPartial = !soldWholeBody && (isPartialFill ||
    (onOrder > 0
      ? summary.totalSize < onOrder * 0.99 // 1% tolerance for rounding/fees
      : soldRatio < 0.95));

  return { proceeds, soldRatio, proratedCostBasis, pnl, holdbackAsset, reservesSoldAsset, soldWholeBody, isPartial };
};

/**
 * Plan how a live body's TP sale is recorded: the per-buy consumption (issue
 * #607) and the sell's body-booking annotation. A partial consumes only what
 * sold (no reserve is booked); a full fill consumes the whole body — sold plus
 * the holdback booked as reserves. A closing sale consumes exactly the body;
 * any excess came out of reserves (bodyReservesSoldAsset, issue #770).
 *
 * Reads the PRE-sale body (assetQty/avgPrice before it is reduced). The engine
 * applies both halves synchronously, before any await.
 * @param {Object} args
 * @param {Object} args.body - The live body, before this sale is applied
 * @param {{totalSize: number}} args.summary
 * @param {ReturnType<typeof classifyTpFill>} args.fill
 * @param {string} args.sellOrderId
 * @param {boolean} [args.additive] - A second booking of the same order (issue #777)
 * @returns {{consumption: Object, sellBooking: Object}} `consumption` is the
 *   recordBodyConsumption argument; `sellBooking` the commitSellBooking annotation
 */
const planBodyTpBooking = ({ body, summary, fill, sellOrderId, additive }) => {
  const { isPartial, proratedCostBasis, holdbackAsset, reservesSoldAsset, pnl } = fill;
  return {
    consumption: {
      entries: body.buyOrders,
      bodyQty: body.assetQty,
      qty: isPartial ? summary.totalSize : body.assetQty,
      closesBody: !isPartial,
      sellOrderId,
      bodyId: body.id,
      additive,
    },
    sellBooking: {
      isBodyOwned: true,
      bodyId: body.id,
      bodyTier: body.tier,
      bodyCostBasis: proratedCostBasis,
      bodyAvgPrice: body.avgPrice,
      bodyBtcQty: isPartial ? summary.totalSize : body.assetQty,
      bodyHoldbackAsset: isPartial ? 0 : holdbackAsset,
      ...(!isPartial && reservesSoldAsset > 0 && { bodyReservesSoldAsset: reservesSoldAsset }),
      bodyPnl: pnl,
      ...(isPartial && { partialFill: true }),
    },
  };
};

/**
 * What a body keeps after a true partial TP fill. The cumulative fraction of
 * the body's ORIGINAL cost basis realized via partial sells composes as
 * consumed = 1 − Π(1 − soldRatioᵢ) (issue #128), so heldOpenBuyCostBasis can
 * subtract the already-realized portion while the residual TP rests.
 * avgPrice is unchanged (the weighted average of the buys does not move).
 * @param {Object} args
 * @param {{assetQty: number, costBasis: number, consumedCostFraction?: number}} args.body - Pre-sale body
 * @param {{totalSize: number}} args.summary
 * @param {number} args.soldRatio - From classifyTpFill
 * @returns {{assetQty: number, costBasis: number, consumedCostFraction: number}}
 */
const planPartialBodyRemainder = ({ body, summary, soldRatio }) => {
  const prevConsumed = body.consumedCostFraction || 0;
  return {
    assetQty: roundAsset(body.assetQty - summary.totalSize),
    costBasis: roundUSDC(body.costBasis * (1 - soldRatio)),
    consumedCostFraction: 1 - (1 - prevConsumed) * (1 - soldRatio),
  };
};

/**
 * The buy order ids a fully-sold body links to its sell (buy→sell display
 * linkage): its source orders plus every tranche, minus the synthetic
 * 'core-migration' tranche.
 * @param {{sourceOrderIds?: string[], buyOrders?: Array<{orderId: string}>}} body
 * @returns {Set<string>}
 */
const collectBodyLinkedBuyOrderIds = (body) => {
  const linkedSrcIds = new Set(body.sourceOrderIds || []);
  for (const buyOrder of (body.buyOrders || [])) {
    if (buyOrder.orderId !== 'core-migration') linkedSrcIds.add(buyOrder.orderId);
  }
  return linkedSrcIds;
};

/**
 * The aggregate closed-trade record for a body TP sale. A second booking of
 * the same order adds its newly-booked tranche; a replay stays idempotent
 * (closedTrades.record owns that).
 * @param {Object} args
 * @param {string} args.sellOrderId
 * @param {{timestamp: number, cycleId: string|null}} args.stamp - sellTradeStamp(summary)
 * @param {number} args.recordedAt
 * @param {{totalSize: number, totalFees: number}} args.summary
 * @param {Object} args.body
 * @param {ReturnType<typeof classifyTpFill>} args.fill
 * @returns {Object}
 */
const buildBodyTpClosedTrade = ({ sellOrderId, stamp, recordedAt, summary, body, fill }) => {
  const { isPartial, proceeds, proratedCostBasis, pnl, holdbackAsset, reservesSoldAsset } = fill;
  return {
    sellOrderId,
    ...stamp,
    recordedAt,
    qtySold: summary.totalSize,
    sellProceeds: roundUSDC(proceeds),
    sellFees: roundUSDC(summary.totalFees),
    costBasis: proratedCostBasis,
    buyAvgPrice: roundUSDC(body.avgPrice),
    pnl: roundUSDC(pnl),
    holdbackAsset: isPartial ? 0 : holdbackAsset,
    ...(!isPartial && reservesSoldAsset > 0 && { reservesSoldAsset }),
    isPartial,
    bodyId: body.id,
    bodyTier: body.tier,
    buyOrderIds: [...(body.sourceOrderIds || []), ...(body.buyOrders || []).map(b => b.orderId)].filter(id => id !== 'core-migration'),
    source: 'live',
  };
};

/**
 * Whether a merge-snapshot sale closed the snapshot body (issue #607). With a
 * live merged body it closed unless the live body owns the remainder of a
 * true partial. With no live body, it closed only if no other body holds its
 * tranches: a roll-up moves the snapshot's tranche objects into the surviving
 * target, so "the snapshot body's id is gone" does not mean its asset left the
 * model — a late fill of the source's old TP must not close tranches a live
 * body still carries.
 * @param {Object} args
 * @param {Set<Object>} args.snapshotTranches - The snapshot's buyOrders entries
 * @param {Array<Object>} args.bodies - positionState.celestialBodies
 * @param {Object|undefined} args.liveMerged - The live body with the snapshot's id
 * @param {boolean} args.liveOwnsRemainder
 * @returns {boolean}
 */
const isMergedSnapshotClosed = ({ snapshotTranches, bodies, liveMerged, liveOwnsRemainder }) => {
  const heldElsewhere = (bodies || [])
    .some(b => (b.buyOrders || []).some(e => snapshotTranches.has(e)));
  return liveMerged ? !liveOwnsRemainder : !heldElsewhere;
};

/**
 * What a merge-snapshot sale removes from the LIVE merged body (issue #201).
 * A true partial removes the sold tranche at its prorated cost; a closing sale
 * removes the WHOLE snapshot (sold + booked holdback) at its full cost, so the
 * holdback is not left in the live body as well as in reserves (issue #718).
 * The consumed ratio is priced off the dollar cost removed, not quantity, so
 * Σ buy.cost × (1 − consumedCostFraction) reconciles to the live costBasis
 * even when a fold-in arrived at a different price.
 * @param {Object} args
 * @param {{assetQty: number, costBasis: number, consumedCostFraction?: number}} args.liveMerged - Pre-deduction live body
 * @param {{assetQty: number, costBasis: number}} args.mergeSnapshot
 * @param {{totalSize: number}} args.summary
 * @param {number} args.proratedCostBasis - From classifyTpFill(mergeSnapshot)
 * @param {boolean} args.snapshotClosed
 * @returns {{liveConsumedRatio: number, assetQty: number, costBasis: number, consumedCostFraction: number}}
 */
const planLiveMergedDeduction = ({ liveMerged, mergeSnapshot, summary, proratedCostBasis, snapshotClosed }) => {
  const removedQty = snapshotClosed ? mergeSnapshot.assetQty : summary.totalSize;
  const removedCost = snapshotClosed ? mergeSnapshot.costBasis : proratedCostBasis;
  const liveConsumedRatio = liveMerged.costBasis > 0
    ? Math.min(removedCost / liveMerged.costBasis, 1)
    : 1;
  const prevConsumed = liveMerged.consumedCostFraction || 0;
  return {
    liveConsumedRatio,
    assetQty: roundAsset(Math.max(0, liveMerged.assetQty - removedQty)),
    costBasis: roundUSDC(Math.max(0, liveMerged.costBasis - removedCost)),
    consumedCostFraction: 1 - (1 - prevConsumed) * (1 - liveConsumedRatio),
  };
};

/**
 * Detach a closed snapshot's tranches from the live merged body: the live body
 * keeps only the fold-in tranches the snapshot's TP never covered, its source
 * ids drop the closed-only orders, and `closedOnlyIds` are the buys to link to
 * this sell (never the 'core-migration' tranche).
 * @param {Object} args
 * @param {{buyOrders?: Array<Object>, sourceOrderIds?: string[]}} args.liveMerged
 * @param {{buyOrders?: Array<Object>, sourceOrderIds?: string[]}} args.mergeSnapshot
 * @param {Set<Object>} args.snapshotTranches
 * @returns {{buyOrders: Array<Object>, sourceOrderIds: string[], closedOnlyIds: string[]}}
 */
const planClosedSnapshotDetach = ({ liveMerged, mergeSnapshot, snapshotTranches }) => {
  const buyOrders = (liveMerged.buyOrders || []).filter(e => !snapshotTranches.has(e));
  const keptIds = new Set(buyOrders.map(e => e && e.orderId));
  const closedIds = new Set([
    ...(mergeSnapshot.sourceOrderIds || []),
    ...(mergeSnapshot.buyOrders || []).map(e => e && e.orderId),
  ]);
  const sourceOrderIds = (liveMerged.sourceOrderIds || [])
    .filter(id => keptIds.has(id) || !closedIds.has(id));
  const closedOnlyIds = [...closedIds].filter(id => id && id !== 'core-migration' && !keptIds.has(id));
  return { buyOrders, sourceOrderIds, closedOnlyIds };
};

/**
 * The commitSellBooking annotation for a merge-snapshot sale. bodyCostBasis is
 * the prorated cost of the SOLD tranche, matching the live body path (it equals
 * the full snapshot cost when soldRatio is 1).
 * @param {Object} args
 * @param {Object} args.mergeSnapshot
 * @param {{totalSize: number}} args.summary
 * @param {ReturnType<typeof classifyTpFill>} args.fill
 * @param {boolean} args.liveOwnsRemainder
 * @returns {Object}
 */
const buildMergedSnapshotSellBooking = ({ mergeSnapshot, summary, fill, liveOwnsRemainder }) => {
  const { proratedCostBasis, holdbackAsset, reservesSoldAsset, pnl } = fill;
  return {
    isBodyOwned: true,
    bodyId: mergeSnapshot.id,
    bodyTier: mergeSnapshot.tier,
    bodyCostBasis: proratedCostBasis,
    bodyAvgPrice: mergeSnapshot.avgPrice,
    bodyBtcQty: liveOwnsRemainder ? summary.totalSize : mergeSnapshot.assetQty,
    bodyHoldbackAsset: liveOwnsRemainder ? 0 : holdbackAsset,
    ...(!liveOwnsRemainder && reservesSoldAsset > 0 && { bodyReservesSoldAsset: reservesSoldAsset }),
    bodyPnl: pnl,
    mergeSnapshot: true,
    ...(liveOwnsRemainder && { partialFill: true }),
  };
};

/**
 * Whether an untracked sell's ledger rows already carry a body/satellite
 * booking — the duplicate body-TP fill from a cancel-and-replace race.
 * @param {Array<Object>} existingFills - Ledger rows for the order
 * @returns {boolean}
 */
const isSellBookedAsBody = (existingFills) => existingFills.some(f => f.isBodyOwned || f.isSatellite);

/**
 * Whether an untracked sell is the engine's OWN legacy core TP (issue #672):
 * the core TP id snapshotted before any await or still current; tracked by the
 * executor as `take_profit`; or a prior pass already claimed its capital
 * credit. Short-circuits in that order, so the executor is only asked when the
 * ids do not match.
 * @param {Object} args
 * @param {string} args.sellOrderId
 * @param {string|null|undefined} args.entryCoreTpOrderId
 * @param {string|null|undefined} args.activeTpOrderId
 * @param {((orderId: string) => boolean)|undefined} args.isTrackedTpOrder
 * @param {Array<Object>} args.existingFills
 * @returns {boolean}
 */
const isOwnLegacyCoreTp = ({ sellOrderId, entryCoreTpOrderId, activeTpOrderId, isTrackedTpOrder, existingFills }) =>
  !!sellOrderId && (
    sellOrderId === entryCoreTpOrderId
    || sellOrderId === activeTpOrderId
    || (typeof isTrackedTpOrder === 'function' && isTrackedTpOrder(sellOrderId))
    || existingFills.some(f => f.capitalCredited)
  );

/**
 * Why an untracked sell must not close the cycle, or null when it may.
 * @param {Object} args
 * @param {number} args.remainingBodies
 * @param {boolean} args.isOwnCoreTp
 * @returns {string|null}
 */
const untrackedSellRejectReason = ({ remainingBodies, isOwnCoreTp }) => {
  if (remainingBodies > 0) return `${remainingBodies} celestial bodies still active`;
  if (!isOwnCoreTp) return 'not the engine\'s take-profit order (manual/external sell?)';
  return null;
};

/**
 * Price a legacy core TP close against the aggregate position.
 * @param {Object} args
 * @param {{totalSize: number, totalValue: number, totalFees: number}} args.summary
 * @param {number} args.avgCostBasis - positionState.avgCostBasis
 * @param {number} args.totalAsset - positionState.totalAsset
 * @returns {{proceeds: number, soldCostBasis: number, pnl: number, holdbackAsset: number}}
 */
const planCoreTpClose = ({ summary, avgCostBasis, totalAsset }) => {
  const proceeds = summary.totalValue - summary.totalFees;
  const soldCostBasis = summary.totalSize * avgCostBasis;
  const pnl = proceeds - soldCostBasis;
  const holdbackAsset = roundAsset(totalAsset - summary.totalSize);
  return { proceeds, soldCostBasis, pnl, holdbackAsset };
};

/**
 * The current-cycle buy orders a legacy core TP sold: unowned buys, skipping
 * body/satellite-owned rows and timestamp-folded buys (#705), which are not in
 * the core position.
 * @param {Array<Object>} cycleFills
 * @returns {Set<string>}
 */
const collectCoreCycleBuyOrderIds = (cycleFills) => {
  const buyOrderIds = new Set();
  for (const fill of cycleFills) {
    if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId && fill.cycleAttribution !== 'timeframe') {
      buyOrderIds.add(fill.orderId);
    }
  }
  return buyOrderIds;
};

/**
 * The legacy audit record for a core TP close, built before resetCycle clears
 * its cost basis.
 * @param {Object} args
 * @param {string} args.sellOrderId
 * @param {{timestamp: number, cycleId: string|null}} args.stamp - sellTradeStamp(summary)
 * @param {number} args.recordedAt
 * @param {{totalSize: number, totalFees: number}} args.summary
 * @param {ReturnType<typeof planCoreTpClose>} args.close
 * @param {number} args.avgCostBasis
 * @param {Set<string>} args.buyOrderIds
 * @param {string|undefined} args.source - fillData.source
 * @returns {Object}
 */
const buildCoreTpClosedTrade = ({ sellOrderId, stamp, recordedAt, summary, close, avgCostBasis, buyOrderIds, source }) => ({
  sellOrderId,
  ...stamp,
  recordedAt,
  qtySold: summary.totalSize,
  sellProceeds: roundUSDC(close.proceeds),
  sellFees: roundUSDC(summary.totalFees),
  costBasis: roundUSDC(close.soldCostBasis),
  buyAvgPrice: roundUSDC(avgCostBasis),
  pnl: roundUSDC(close.pnl),
  holdbackAsset: close.holdbackAsset,
  isPartial: false,
  bodyId: null,
  bodyTier: null,
  buyOrderIds: [...buyOrderIds],
  source: source || 'live',
});

/**
 * Measure the gap between what order status says filled (cumulative) and what
 * the ledger holds for the order, and price that gap from the cumulative quote
 * left after earlier executions. Only a TERMINAL fill with a positive gap is
 * synthesized: a still-live partial must stay retryable.
 *
 * Returns null when there is nothing to synthesize. Otherwise `valid` is false
 * when the cumulative quote/quantity is inconsistent (the engine then throws an
 * `incompleteFills` error so the gap stays retryable); an explicitly supplied
 * invalid value never falls back to an average.
 *
 * The fee owed on just this gap is the cumulative status fee minus the fee the
 * order's prior rows already booked, never the whole cumulative fee again.
 * @param {Object} args
 * @param {{filledSize?: number, filledValue?: number, averageFilledPrice?: number, totalFees?: number}} args.fillData
 * @param {Array<Object>} args.existingFills - Ledger rows for the order
 * @param {boolean} args.isTerminalFill
 * @returns {null|{ledgerTotalForOrder: number, fillGap: number, cumulativeQuantity: number,
 *   cumulativeQuote: number, recordedQuote: number, remainingQuote: number, gapPrice: number,
 *   valid: boolean, alreadyBookedFees?: number, feeDelta?: number}}
 */
const planTerminalFillGap = ({ fillData, existingFills, isTerminalFill }) => {
  const ledgerTotalForOrder = existingFills.reduce((sum, f) => sum + Number(f.size || 0), 0);
  const fillGap = fillData.filledSize > 0 ? fillData.filledSize - ledgerTotalForOrder : 0;
  if (!(isTerminalFill && fillGap > 1e-9)) return null;
  const cumulativeQuantity = Number(fillData.filledSize);
  const cumulativeQuote = fillData.filledValue != null
    ? Number(fillData.filledValue)
    : cumulativeQuantity * Number(fillData.averageFilledPrice);
  const recordedQuote = existingFills.reduce((sum, row) => sum + Number(row.quoteAmount), 0);
  const remainingQuote = cumulativeQuote - recordedQuote;
  const gapPrice = remainingQuote / fillGap;
  const valid = !(!Number.isFinite(cumulativeQuantity) || !Number.isFinite(fillGap)
    || !Number.isFinite(cumulativeQuote) || cumulativeQuote <= 0
    || !Number.isFinite(recordedQuote) || recordedQuote < 0
    || !Number.isFinite(remainingQuote) || remainingQuote <= 0
    || !Number.isFinite(gapPrice) || gapPrice <= 0);
  const plan = { ledgerTotalForOrder, fillGap, cumulativeQuantity, cumulativeQuote, recordedQuote, remainingQuote, gapPrice, valid };
  if (!valid) return plan;
  const alreadyBookedFees = existingFills.reduce((sum, f) => sum + Number(f.netFee || 0), 0);
  const feeDelta = Math.max(0, (fillData.totalFees || 0) - alreadyBookedFees);
  return { ...plan, alreadyBookedFees, feeDelta };
};

/**
 * The synthetic terminal-coverage row for a valid fill gap. Its tradeId is
 * suffixed with the cumulative filledSize so a later pass computing a larger
 * gap ingests as a new row instead of a duplicate. The fee is carried in both
 * totalFees and netFee so ingestFill persists it (issue #210-C).
 * @param {Object} args
 * @param {{orderId: string, side: string, filledSize: number}} args.fillData
 * @param {ReturnType<typeof planTerminalFillGap>} args.gap - A valid gap plan
 * @param {number} args.timestamp
 * @returns {Object}
 */
const buildSyntheticGapFill = ({ fillData, gap, timestamp }) => ({
  tradeId: `synthetic-${fillData.orderId}-${fillData.filledSize}`,
  syntheticCoverage: {
    orderId: fillData.orderId,
    cumulativeQuantity: fillData.filledSize,
    cumulativeQuote: gap.cumulativeQuote,
    cumulativeFees: gap.alreadyBookedFees + gap.feeDelta,
  },
  orderId: fillData.orderId,
  side: fillData.side.toLowerCase(),
  price: gap.gapPrice,
  size: gap.fillGap,
  quoteAmount: gap.remainingQuote,
  totalFees: gap.feeDelta,
  netFee: gap.feeDelta,
  timestamp,
});

module.exports = {
  classifyTpFill,
  planBodyTpBooking,
  planPartialBodyRemainder,
  collectBodyLinkedBuyOrderIds,
  buildBodyTpClosedTrade,
  isMergedSnapshotClosed,
  planLiveMergedDeduction,
  planClosedSnapshotDetach,
  buildMergedSnapshotSellBooking,
  isSellBookedAsBody,
  isOwnLegacyCoreTp,
  untrackedSellRejectReason,
  planCoreTpClose,
  collectCoreCycleBuyOrderIds,
  buildCoreTpClosedTrade,
  planTerminalFillGap,
  buildSyntheticGapFill,
};
