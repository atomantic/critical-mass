// @ts-check
// Issue #1607: the fill-booking decisions in regime-engine's sell handlers
// (handleBodyTpFill, commitMergedSnapshotSell, handleUntrackedSellFill,
// ingestOrderFillEvidence) live in src/regime-sell-booking.js as pure
// planners. These tests pin them two ways: named holdback / partial fixtures
// (the P&L model in CLAUDE.md), and a property sweep against reference
// copies of the pre-extraction inline code, so any drift in a formula, a
// rounding call or an annotation key order fails here. The engine-level
// behavior stays covered by body-tp-cancel-execution, merge-fill-concurrency,
// regime-engine and the offline-fill-recovery suites.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/regime-sell-booking');
const { splitTpHoldback } = require('../src/regime-pure-helpers');
const { roundAsset, roundUSDC } = require('../src/volatility-utils');

// The body-tp-cancel-execution fixture: 0.01 asset for $500, TP placed for
// half of it (the other half is designed holdback).
const holdbackBody = (overrides = {}) => ({
  id: 'b1',
  tier: 'ASTEROID',
  assetQty: 0.01,
  costBasis: 500,
  avgPrice: 50000,
  assetOnOrder: 0.005,
  buyOrders: [{ orderId: 'seed-b1', price: 50000, assetQty: 0.01, sizeUsdc: 500, filledAt: 1 }],
  sourceOrderIds: ['seed-b1'],
  ...overrides,
});
const sale = (totalSize, price = 50500, totalFees = 0.02) => ({
  totalSize, totalValue: totalSize * price, totalFees, avgPrice: price,
});

describe('classifyTpFill: designed holdback is not a partial fill', () => {
  it('books a 100% fill of assetOnOrder as a completed TP with the rest as holdback', () => {
    const body = holdbackBody();
    const fill = classifyTpFill({ body, summary: sale(0.005) });
    assert.equal(fill.isPartial, false);
    assert.equal(fill.soldWholeBody, false, 'a healthy fill never sells the whole body');
    assert.equal(fill.soldRatio, 0.5);
    // proratedCostBasis = body.costBasis × (totalSize / assetQty)
    assert.equal(fill.proratedCostBasis, 250);
    assert.equal(fill.proceeds, 0.005 * 50500 - 0.02);
    assert.equal(fill.pnl, fill.proceeds - 250);
    assert.equal(fill.holdbackAsset, 0.005);
    assert.equal(fill.reservesSoldAsset, 0);
  });

  it('treats a fill within 1% of assetOnOrder as complete, and below it as a true partial', () => {
    const body = holdbackBody();
    assert.equal(classifyTpFill({ body, summary: sale(0.00495) }).isPartial, false);
    assert.equal(classifyTpFill({ body, summary: sale(0.0049) }).isPartial, true);
  });

  it('falls back to the soldRatio heuristic for a legacy body with no assetOnOrder', () => {
    const body = holdbackBody({ assetOnOrder: 0 });
    assert.equal(classifyTpFill({ body, summary: sale(0.0095) }).isPartial, false);
    assert.equal(classifyTpFill({ body, summary: sale(0.009) }).isPartial, true);
  });

  it('never classifies a sale of the whole inventory as partial, even from a stale oversized TP (#770)', () => {
    const body = holdbackBody({ assetOnOrder: 0.02 });
    const fill = classifyTpFill({ body, summary: sale(0.012) });
    assert.equal(fill.soldWholeBody, true);
    assert.equal(fill.isPartial, false);
    assert.equal(fill.soldRatio, 1, 'soldRatio is capped at 1');
    assert.equal(fill.proratedCostBasis, 500);
    assert.equal(fill.holdbackAsset, 0);
    assert.equal(fill.reservesSoldAsset, 0.002, 'the excess is drawn from reserves');
  });

  it('honours the fill\'s own partial flag on the body path, but not over a whole-inventory sale', () => {
    const body = holdbackBody();
    assert.equal(classifyTpFill({ body, summary: sale(0.005), isPartialFill: true }).isPartial, true);
    assert.equal(classifyTpFill({ body, summary: sale(0.01), isPartialFill: true }).isPartial, false);
    // The merge-snapshot path passes no flag: only the size rule decides.
    assert.equal(classifyTpFill({ body, summary: sale(0.005) }).isPartial, false);
  });

  it('prices a body with no asset as fully sold', () => {
    const fill = classifyTpFill({ body: holdbackBody({ assetQty: 0, costBasis: 0, assetOnOrder: 0 }), summary: sale(0.001) });
    assert.equal(fill.soldRatio, 1);
    assert.equal(fill.isPartial, false);
  });
});

describe('planBodyTpBooking', () => {
  it('consumes and books the whole body on a full fill, holdback as reserves', () => {
    const body = holdbackBody();
    const summary = sale(0.005);
    const fill = classifyTpFill({ body, summary });
    const plan = planBodyTpBooking({ body, summary, fill, sellOrderId: 'sell-1', additive: false });
    assert.deepEqual(plan.consumption, {
      entries: body.buyOrders, bodyQty: 0.01, qty: 0.01, closesBody: true,
      sellOrderId: 'sell-1', bodyId: 'b1', additive: false,
    });
    assert.deepEqual(plan.sellBooking, {
      isBodyOwned: true, bodyId: 'b1', bodyTier: 'ASTEROID', bodyCostBasis: 250,
      bodyAvgPrice: 50000, bodyBtcQty: 0.01, bodyHoldbackAsset: 0.005, bodyPnl: fill.pnl,
    });
  });

  it('consumes and books only what sold on a true partial, with no reserve', () => {
    const body = holdbackBody();
    const summary = sale(0.002);
    const fill = classifyTpFill({ body, summary });
    const plan = planBodyTpBooking({ body, summary, fill, sellOrderId: 'sell-1', additive: true });
    assert.equal(plan.consumption.qty, 0.002);
    assert.equal(plan.consumption.closesBody, false);
    assert.equal(plan.consumption.additive, true);
    assert.equal(plan.sellBooking.bodyBtcQty, 0.002);
    assert.equal(plan.sellBooking.bodyHoldbackAsset, 0);
    assert.equal(plan.sellBooking.bodyCostBasis, 100);
    assert.equal(plan.sellBooking.partialFill, true);
    assert.equal('bodyReservesSoldAsset' in plan.sellBooking, false);
  });

  it('records reserves sold beyond the body on a stale oversized TP (#770)', () => {
    const body = holdbackBody({ assetOnOrder: 0.02 });
    const summary = sale(0.012);
    const fill = classifyTpFill({ body, summary });
    const plan = planBodyTpBooking({ body, summary, fill, sellOrderId: 's', additive: false });
    assert.equal(plan.consumption.qty, 0.01, 'a closing sale consumes exactly the body');
    assert.equal(plan.sellBooking.bodyReservesSoldAsset, 0.002);
    assert.equal(plan.sellBooking.bodyHoldbackAsset, 0);
  });

  it('does not mutate the body', () => {
    const body = holdbackBody();
    const before = JSON.stringify(body);
    const summary = sale(0.002);
    const fill = classifyTpFill({ body, summary });
    planBodyTpBooking({ body, summary, fill, sellOrderId: 's', additive: false });
    planPartialBodyRemainder({ body, summary, soldRatio: fill.soldRatio });
    buildBodyTpClosedTrade({ sellOrderId: 's', stamp: { timestamp: 1, cycleId: 'cycle-1' }, recordedAt: 2, summary, body, fill });
    assert.equal(JSON.stringify(body), before);
  });
});

describe('planPartialBodyRemainder', () => {
  it('composes the consumed cost fraction across partials (#128)', () => {
    const body = holdbackBody({ consumedCostFraction: 0.5 });
    const summary = sale(0.002);
    const { soldRatio } = classifyTpFill({ body, summary });
    const r = planPartialBodyRemainder({ body, summary, soldRatio });
    assert.equal(r.assetQty, 0.008);
    assert.equal(r.costBasis, 400);
    assert.ok(Math.abs(r.consumedCostFraction - (1 - 0.5 * 0.8)) < 1e-12);
  });
});

describe('body linkage and closed trade', () => {
  it('links source orders and tranches but never core-migration', () => {
    const ids = collectBodyLinkedBuyOrderIds({
      sourceOrderIds: ['a', 'b'],
      buyOrders: [{ orderId: 'b' }, { orderId: 'c' }, { orderId: 'core-migration' }],
    });
    assert.deepEqual([...ids], ['a', 'b', 'c']);
  });

  it('records the closed trade with the stamp, prorated cost and holdback', () => {
    const body = holdbackBody();
    const summary = sale(0.005);
    const fill = classifyTpFill({ body, summary });
    const trade = buildBodyTpClosedTrade({
      sellOrderId: 's', stamp: { timestamp: 10, cycleId: 'cycle-3' }, recordedAt: 20, summary, body, fill,
    });
    assert.deepEqual(Object.keys(trade), [
      'sellOrderId', 'timestamp', 'cycleId', 'recordedAt', 'qtySold', 'sellProceeds', 'sellFees',
      'costBasis', 'buyAvgPrice', 'pnl', 'holdbackAsset', 'isPartial', 'bodyId', 'bodyTier',
      'buyOrderIds', 'source',
    ]);
    assert.equal(trade.costBasis, 250);
    assert.equal(trade.holdbackAsset, 0.005);
    assert.equal(trade.isPartial, false);
    assert.deepEqual(trade.buyOrderIds, ['seed-b1', 'seed-b1']);
    assert.equal(trade.source, 'live');
  });
});

describe('merge-snapshot planners', () => {
  it('a snapshot closes unless the live body owns a partial remainder, or another body holds its tranches', () => {
    const tranche = { orderId: 'x' };
    const snapshotTranches = new Set([tranche]);
    const other = { buyOrders: [tranche] };
    assert.equal(isMergedSnapshotClosed({ snapshotTranches, bodies: [], liveMerged: {}, liveOwnsRemainder: false }), true);
    assert.equal(isMergedSnapshotClosed({ snapshotTranches, bodies: [], liveMerged: {}, liveOwnsRemainder: true }), false);
    assert.equal(isMergedSnapshotClosed({ snapshotTranches, bodies: [], liveMerged: undefined, liveOwnsRemainder: false }), true);
    assert.equal(isMergedSnapshotClosed({ snapshotTranches, bodies: [other], liveMerged: undefined, liveOwnsRemainder: false }), false);
  });

  it('removes the whole snapshot from the live body on a close, priced by dollars (#718)', () => {
    const mergeSnapshot = holdbackBody();
    // A fold-in of 0.004 at a different price joined the live body.
    const liveMerged = { assetQty: 0.014, costBasis: 700, consumedCostFraction: 0 };
    const summary = sale(0.005);
    const { proratedCostBasis } = classifyTpFill({ body: mergeSnapshot, summary });
    const d = planLiveMergedDeduction({ liveMerged, mergeSnapshot, summary, proratedCostBasis, snapshotClosed: true });
    assert.equal(d.assetQty, 0.004);
    assert.equal(d.costBasis, 200);
    assert.ok(Math.abs(d.liveConsumedRatio - 500 / 700) < 1e-12);
    const partial = planLiveMergedDeduction({ liveMerged, mergeSnapshot, summary, proratedCostBasis, snapshotClosed: false });
    assert.equal(partial.assetQty, 0.009);
    assert.equal(partial.costBasis, 450);
  });

  it('detaches closed tranches and keeps the fold-in', () => {
    const closed = { orderId: 'old' };
    const fold = { orderId: 'fold' };
    const mergeSnapshot = { buyOrders: [closed], sourceOrderIds: ['old', 'core-migration'] };
    const liveMerged = { buyOrders: [closed, fold], sourceOrderIds: ['old', 'fold', 'core-migration'] };
    const d = planClosedSnapshotDetach({ liveMerged, mergeSnapshot, snapshotTranches: new Set(mergeSnapshot.buyOrders) });
    assert.deepEqual(d.buyOrders, [fold]);
    assert.deepEqual(d.sourceOrderIds, ['fold']);
    assert.deepEqual(d.closedOnlyIds, ['old']);
    assert.deepEqual(liveMerged.buyOrders, [closed, fold], 'input not mutated');
  });

  it('books a closing snapshot sale with holdback, and a live-owned remainder as partial', () => {
    const mergeSnapshot = holdbackBody();
    const summary = sale(0.005);
    const fill = classifyTpFill({ body: mergeSnapshot, summary });
    const closedBooking = buildMergedSnapshotSellBooking({ mergeSnapshot, summary, fill, liveOwnsRemainder: false });
    assert.equal(closedBooking.bodyBtcQty, 0.01);
    assert.equal(closedBooking.bodyHoldbackAsset, 0.005);
    assert.equal(closedBooking.mergeSnapshot, true);
    const partialBooking = buildMergedSnapshotSellBooking({ mergeSnapshot, summary, fill, liveOwnsRemainder: true });
    assert.equal(partialBooking.bodyBtcQty, 0.005);
    assert.equal(partialBooking.bodyHoldbackAsset, 0);
    assert.equal(partialBooking.partialFill, true);
  });
});

describe('untracked sell planners', () => {
  it('detects a sell already booked as a body or satellite TP', () => {
    assert.equal(isSellBookedAsBody([{ isBodyOwned: true }]), true);
    assert.equal(isSellBookedAsBody([{ isSatellite: true }]), true);
    assert.equal(isSellBookedAsBody([{}]), false);
  });

  it('proves core TP ownership in order and only asks the executor when ids do not match', () => {
    let asked = 0;
    const isTrackedTpOrder = () => { asked++; return true; };
    const base = { sellOrderId: 's', entryCoreTpOrderId: null, activeTpOrderId: null, isTrackedTpOrder, existingFills: [] };
    assert.equal(isOwnLegacyCoreTp({ ...base, entryCoreTpOrderId: 's' }), true);
    assert.equal(isOwnLegacyCoreTp({ ...base, activeTpOrderId: 's' }), true);
    assert.equal(asked, 0);
    assert.equal(isOwnLegacyCoreTp(base), true);
    assert.equal(asked, 1);
    assert.equal(isOwnLegacyCoreTp({ ...base, isTrackedTpOrder: undefined }), false);
    assert.equal(isOwnLegacyCoreTp({ ...base, isTrackedTpOrder: undefined, existingFills: [{ capitalCredited: true }] }), true);
    assert.equal(isOwnLegacyCoreTp({ ...base, sellOrderId: '' }), false);
  });

  it('rejects while bodies remain, then a foreign sell, else allows the close', () => {
    assert.equal(untrackedSellRejectReason({ remainingBodies: 2, isOwnCoreTp: true }), '2 celestial bodies still active');
    assert.equal(untrackedSellRejectReason({ remainingBodies: 0, isOwnCoreTp: false }), 'not the engine\'s take-profit order (manual/external sell?)');
    assert.equal(untrackedSellRejectReason({ remainingBodies: 0, isOwnCoreTp: true }), null);
  });

  it('collects only unowned, non-timeframe current-cycle buys', () => {
    const ids = collectCoreCycleBuyOrderIds([
      { side: 'buy', orderId: 'a' },
      { side: 'buy', orderId: 'b', isBodyOwned: true },
      { side: 'buy', orderId: 'c', bodyId: 'x' },
      { side: 'buy', orderId: 'd', cycleAttribution: 'timeframe' },
      { side: 'sell', orderId: 'e' },
      { side: 'buy', orderId: 'a' },
    ]);
    assert.deepEqual([...ids], ['a']);
  });
});

describe('terminal fill gap', () => {
  it('returns null for a non-terminal fill or a ledger that already covers the order', () => {
    const fillData = { filledSize: 1, filledValue: 100, totalFees: 0.1 };
    assert.equal(planTerminalFillGap({ fillData, existingFills: [], isTerminalFill: false }), null);
    assert.equal(planTerminalFillGap({ fillData, existingFills: [{ size: 1, quoteAmount: 100 }], isTerminalFill: true }), null);
  });

  it('prices only the unrecorded tranche and charges only the unbooked fee', () => {
    const fillData = { orderId: 'o', side: 'BUY', filledSize: 1, filledValue: 100, totalFees: 0.3 };
    const existingFills = [{ size: 0.4, quoteAmount: 38, netFee: 0.1 }];
    const gap = planTerminalFillGap({ fillData, existingFills, isTerminalFill: true });
    assert.ok(gap && gap.valid);
    assert.ok(Math.abs(gap.fillGap - 0.6) < 1e-12);
    assert.equal(gap.remainingQuote, 62);
    assert.ok(Math.abs(gap.feeDelta - 0.2) < 1e-12);
    const row = buildSyntheticGapFill({ fillData, gap, timestamp: 5 });
    assert.equal(row.tradeId, 'synthetic-o-1');
    assert.equal(row.side, 'buy');
    assert.equal(row.size, gap.fillGap);
    assert.equal(row.totalFees, row.netFee);
    assert.ok(Math.abs(row.syntheticCoverage.cumulativeFees - 0.3) < 1e-12);
  });

  it('flags an inconsistent cumulative quote as invalid instead of averaging', () => {
    const fillData = { orderId: 'o', side: 'sell', filledSize: 1, filledValue: 30 };
    const gap = planTerminalFillGap({ fillData, existingFills: [{ size: 0.5, quoteAmount: 50 }], isTerminalFill: true });
    assert.ok(gap);
    assert.equal(gap.valid, false);
    assert.equal('feeDelta' in gap, false);
  });
});

// ---------------------------------------------------------------------------
// Reference copies of the pre-extraction inline code (origin/main before
// #1607), kept verbatim apart from variable plumbing. The sweep below asserts
// the planners reproduce them exactly — values, rounding and key order.
// ---------------------------------------------------------------------------
const referenceBodyTp = (fillData, summary, body, booking) => {
  const proceeds = summary.totalValue - summary.totalFees;
  const soldRatio = body.assetQty > 0 ? Math.min(summary.totalSize / body.assetQty, 1) : 1;
  const proratedCostBasis = roundUSDC(body.costBasis * soldRatio);
  const pnl = proceeds - proratedCostBasis;
  const { holdbackAsset, reservesSoldAsset } = splitTpHoldback(roundAsset(body.assetQty - summary.totalSize));
  const onOrder = body.assetOnOrder || 0;
  const soldWholeBody = body.assetQty > 0 && summary.totalSize >= body.assetQty;
  const isPartial = !soldWholeBody && (fillData.isPartialFill ||
    (onOrder > 0
      ? summary.totalSize < onOrder * 0.99
      : soldRatio < 0.95));
  const consumption = {
    entries: body.buyOrders,
    bodyQty: body.assetQty,
    qty: isPartial ? summary.totalSize : body.assetQty,
    closesBody: !isPartial,
    sellOrderId: fillData.orderId,
    bodyId: body.id,
    additive: booking.additive,
  };
  const sellBooking = {
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
  };
  const prevConsumed = body.consumedCostFraction || 0;
  const remainder = {
    assetQty: roundAsset(body.assetQty - summary.totalSize),
    costBasis: roundUSDC(body.costBasis * (1 - soldRatio)),
    consumedCostFraction: 1 - (1 - prevConsumed) * (1 - soldRatio),
  };
  const closedTrade = {
    sellOrderId: fillData.orderId,
    ...{ timestamp: 1, cycleId: 'cycle-1' },
    recordedAt: 2,
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
  return { isPartial, pnl, holdbackAsset, reservesSoldAsset, soldRatio, consumption, sellBooking, remainder, closedTrade };
};

const referenceSnapshot = (summary, mergeSnapshot, liveMerged, liveCostBasis) => {
  const soldRatio = mergeSnapshot.assetQty > 0 ? Math.min(summary.totalSize / mergeSnapshot.assetQty, 1) : 1;
  const proratedCostBasis = roundUSDC(mergeSnapshot.costBasis * soldRatio);
  const pnl = summary.totalValue - summary.totalFees - proratedCostBasis;
  const { holdbackAsset, reservesSoldAsset } = splitTpHoldback(roundAsset(mergeSnapshot.assetQty - summary.totalSize));
  const onOrder = mergeSnapshot.assetOnOrder || 0;
  const isPartialSnapshotFill = !(mergeSnapshot.assetQty > 0 && summary.totalSize >= mergeSnapshot.assetQty)
    && (onOrder > 0
      ? summary.totalSize < onOrder * 0.99
      : soldRatio < 0.95);
  const liveOwnsRemainder = !!liveMerged && isPartialSnapshotFill;
  const snapshotClosed = liveMerged ? !liveOwnsRemainder : true;
  const removedQty = snapshotClosed ? mergeSnapshot.assetQty : summary.totalSize;
  const removedCost = snapshotClosed ? mergeSnapshot.costBasis : proratedCostBasis;
  const liveConsumedRatio = liveCostBasis > 0 ? Math.min(removedCost / liveCostBasis, 1) : 1;
  const sellBooking = {
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
  return { isPartialSnapshotFill, liveOwnsRemainder, snapshotClosed, removedQty, removedCost, liveConsumedRatio, sellBooking };
};

// Deterministic LCG so a failure reproduces.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe('planners match the pre-extraction inline code', () => {
  const random = rng(1607);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const cases = [];
  for (let i = 0; i < 3000; i++) {
    const assetQty = pick([0, 0.01, 0.123456, 1.5, roundAsset(random() * 2)]);
    const plannedHoldback = pick([0, 0.1, 0.5, random()]);
    const assetOnOrder = pick([0, roundAsset(assetQty * (1 - plannedHoldback)), roundAsset(assetQty * 2), roundAsset(random() * 2)]);
    const soldFraction = pick([1, 0.995, 0.99, 0.98, 0.5, 0.01, 1.2, random() * 1.3]);
    const basis = assetOnOrder > 0 ? assetOnOrder : assetQty;
    const totalSize = roundAsset(Math.max(1e-8, basis * soldFraction));
    const price = 100 + random() * 100000;
    const body = {
      id: `b${i}`, tier: pick(['ASTEROID', 'MOON', 'PLANET']),
      assetQty, costBasis: roundUSDC(assetQty * price * (0.9 + random() * 0.2)), avgPrice: price,
      assetOnOrder,
      consumedCostFraction: pick([undefined, 0, 0.3, random()]),
      buyOrders: [{ orderId: `buy-${i}` }, { orderId: 'core-migration' }],
      sourceOrderIds: pick([undefined, [`src-${i}`], [`buy-${i}`]]),
    };
    const summary = { totalSize, totalValue: totalSize * price * (1 + random() * 0.05), totalFees: random() * 2, avgPrice: price };
    cases.push({ body, summary, isPartialFill: pick([undefined, false, true]), additive: random() > 0.5 });
  }

  it('body TP booking: classification, consumption, annotation, remainder, closed trade', () => {
    let partials = 0;
    let fulls = 0;
    for (const { body, summary, isPartialFill, additive } of cases) {
      const fillData = { orderId: 'sell-x', isPartialFill };
      const ref = referenceBodyTp(fillData, summary, body, { additive });
      const fill = classifyTpFill({ body, summary, isPartialFill });
      assert.equal(fill.isPartial, ref.isPartial);
      assert.equal(fill.pnl, ref.pnl);
      assert.equal(fill.soldRatio, ref.soldRatio);
      assert.equal(fill.holdbackAsset, ref.holdbackAsset);
      assert.equal(fill.reservesSoldAsset, ref.reservesSoldAsset);
      const plan = planBodyTpBooking({ body, summary, fill, sellOrderId: 'sell-x', additive });
      assert.deepEqual(plan.consumption, ref.consumption);
      assert.equal(plan.consumption.entries, body.buyOrders, 'tranche array passed by reference');
      assert.deepEqual(plan.sellBooking, ref.sellBooking);
      assert.deepEqual(Object.keys(plan.sellBooking), Object.keys(ref.sellBooking));
      assert.deepEqual(planPartialBodyRemainder({ body, summary, soldRatio: fill.soldRatio }), ref.remainder);
      const trade = buildBodyTpClosedTrade({
        sellOrderId: 'sell-x', stamp: { timestamp: 1, cycleId: 'cycle-1' }, recordedAt: 2, summary, body, fill,
      });
      assert.deepEqual(trade, ref.closedTrade);
      assert.deepEqual(Object.keys(trade), Object.keys(ref.closedTrade));
      if (fill.isPartial) partials++; else fulls++;
    }
    assert.ok(partials > 100 && fulls > 100, `sweep covers both branches (${partials} partial, ${fulls} full)`);
  });

  it('merge-snapshot booking: classification ignores the partial flag; deduction and annotation match', () => {
    for (const { body: mergeSnapshot, summary } of cases) {
      const liveCostBasis = roundUSDC(mergeSnapshot.costBasis * 1.3);
      const liveMerged = { id: mergeSnapshot.id, assetQty: roundAsset(mergeSnapshot.assetQty * 1.3), costBasis: liveCostBasis, consumedCostFraction: 0.1 };
      for (const live of [liveMerged, undefined]) {
        const ref = referenceSnapshot(summary, mergeSnapshot, live, liveCostBasis);
        const fill = classifyTpFill({ body: mergeSnapshot, summary });
        assert.equal(fill.isPartial, ref.isPartialSnapshotFill);
        const liveOwnsRemainder = !!live && fill.isPartial;
        assert.equal(liveOwnsRemainder, ref.liveOwnsRemainder);
        const snapshotClosed = isMergedSnapshotClosed({ snapshotTranches: new Set(), bodies: [], liveMerged: live, liveOwnsRemainder });
        assert.equal(snapshotClosed, ref.snapshotClosed);
        const booking = buildMergedSnapshotSellBooking({ mergeSnapshot, summary, fill, liveOwnsRemainder });
        assert.deepEqual(booking, ref.sellBooking);
        assert.deepEqual(Object.keys(booking), Object.keys(ref.sellBooking));
        if (live) {
          const d = planLiveMergedDeduction({ liveMerged: live, mergeSnapshot, summary, proratedCostBasis: fill.proratedCostBasis, snapshotClosed });
          assert.equal(d.liveConsumedRatio, ref.liveConsumedRatio);
          assert.equal(d.assetQty, roundAsset(Math.max(0, live.assetQty - ref.removedQty)));
          assert.equal(d.costBasis, roundUSDC(Math.max(0, live.costBasis - ref.removedCost)));
          assert.equal(d.consumedCostFraction, 1 - (1 - 0.1) * (1 - ref.liveConsumedRatio));
        }
      }
    }
  });

  it('legacy core TP close: pricing and closed trade', () => {
    for (const { body, summary } of cases.slice(0, 500)) {
      const avgCostBasis = body.avgPrice;
      const totalAsset = body.assetQty;
      const close = planCoreTpClose({ summary, avgCostBasis, totalAsset });
      const proceeds = summary.totalValue - summary.totalFees;
      const soldCostBasis = summary.totalSize * avgCostBasis;
      assert.deepEqual(close, {
        proceeds, soldCostBasis, pnl: proceeds - soldCostBasis, holdbackAsset: roundAsset(totalAsset - summary.totalSize),
      });
      const buyOrderIds = new Set(['a', 'b']);
      const trade = buildCoreTpClosedTrade({
        sellOrderId: 's', stamp: { timestamp: 1, cycleId: null }, recordedAt: 2, summary, close, avgCostBasis, buyOrderIds, source: undefined,
      });
      assert.deepEqual(trade, {
        sellOrderId: 's', timestamp: 1, cycleId: null, recordedAt: 2,
        qtySold: summary.totalSize,
        sellProceeds: roundUSDC(proceeds),
        sellFees: roundUSDC(summary.totalFees),
        costBasis: roundUSDC(soldCostBasis),
        buyAvgPrice: roundUSDC(avgCostBasis),
        pnl: roundUSDC(proceeds - soldCostBasis),
        holdbackAsset: roundAsset(totalAsset - summary.totalSize),
        isPartial: false, bodyId: null, bodyTier: null, buyOrderIds: ['a', 'b'], source: 'live',
      });
    }
  });
});
