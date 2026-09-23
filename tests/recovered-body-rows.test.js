// @ts-check
//
// Issue #752: a recovered (null-cycle) partial row of a body's OWN buy order
// that recalculateCycles attributes by order (cycleAttribution: 'order', #705)
// must grow that body, so its TP is re-sized for the position actually held.
//
// Disk safety: every ledger/engine uses a throwaway pair under data/coinbase/,
// deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createRegimeEngine,
  planBodyGrowthFromRecoveredBuyRows,
} = require('../src/regime-engine');
const { createFillLedger } = require('../src/fill-ledger');

const PAIRS = [];
const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  for (const pair of PAIRS) fs.rmSync(path.join(__dirname, '..', 'data', 'coinbase', pair), { recursive: true, force: true });
});

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (h) => new Date(T0 + h * 3600_000).toISOString();
const noop = () => {};

/**
 * Body `body-A` bought order `a-buy` for 0.01 @ 50000 (row a-1). A second
 * partial row a-2 (0.005 @ 50000) was missed and later re-imported null.
 * @param {Object} ledger
 * @returns {Object} the body
 */
const seed = (ledger) => {
  ledger.setCurrentCycleId('cycle-1', T0);
  const ingest = (tradeId, orderId, side, h, size, cycleId) => ledger.ingestFill(
    { tradeId, orderId, side, price: '50000', size, tradeTime: at(h) }, null, { cycleId, skipPersist: true });
  ingest('a-1', 'a-buy', 'buy', 1, '0.01', 'cycle-1');
  ledger.annotateFillsByOrderId('a-buy', { isBodyOwned: true, bodyId: 'body-A', bodyTier: 'asteroid', sellOrderId: 'a-tp' });
  ingest('a-2', 'a-buy', 'buy', 1.1, '0.005', null);
  return {
    id: 'body-A',
    tier: 'asteroid',
    assetQty: 0.01,
    costBasis: 500,
    avgPrice: 50000,
    tpPrice: 50500,
    tpOrderId: 'a-tp',
    assetOnOrder: 0.009,
    mergeCount: 0,
    sourceOrderIds: ['a-buy'],
    buyOrders: [{ orderId: 'a-buy', price: 50000, assetQty: 0.01, sizeUsdc: 500, filledAt: T0, consumedQty: 0 }],
  };
};

const makeLedger = (name) => {
  const pair = `__test752${name}__`;
  PAIRS.push(pair);
  return createFillLedger('coinbase', pair, pair);
};

describe('planBodyGrowthFromRecoveredBuyRows (#752)', () => {
  it('plans exactly the recovered shortfall for the owning live body', () => {
    const ledger = makeLedger('plan');
    const body = seed(ledger);
    ledger.recalculateCycles();
    const row = ledger.getAllFills().find(f => f.tradeId === 'a-2');
    assert.equal(row.cycleAttribution, 'order');
    assert.equal(row.bodyId, 'body-A');

    const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger: ledger, celestialBodies: [body] });

    assert.deepStrictEqual(skipped, []);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].buyOrderId, 'a-buy');
    assert.equal(plans[0].shortfall.assetQty, 0.005);
    assert.equal(plans[0].totals.assetQty, 0.015, 'totals are the order\'s FULL fills (extendBody contract)');
  });

  it('does nothing when the owning body already closed', () => {
    const ledger = makeLedger('closed');
    seed(ledger);
    ledger.recalculateCycles();
    const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger: ledger, celestialBodies: [] });
    assert.deepStrictEqual(plans, []);
    assert.deepStrictEqual(skipped, []);
  });

  it('skips when more than one live body records the order', () => {
    const ledger = makeLedger('twobodies');
    const body = seed(ledger);
    ledger.recalculateCycles();
    const other = { ...body, id: 'body-Z', buyOrders: [{ orderId: 'a-buy', assetQty: 0.001, sizeUsdc: 50 }] };
    const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger: ledger, celestialBodies: [body, other] });
    assert.deepStrictEqual(plans, []);
    assert.equal(skipped.length, 1);
  });

  it('skips a gap larger than the recovered rows (some other discrepancy — manual review)', () => {
    const ledger = makeLedger('gap');
    const body = seed(ledger);
    ledger.recalculateCycles();
    body.buyOrders[0].assetQty = 0.004; // body records less than even the original row
    const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger: ledger, celestialBodies: [body] });
    assert.deepStrictEqual(plans, []);
    assert.equal(skipped.length, 1);
  });

  it('skips an order whose body took a synthetic gap row the recovered rows may duplicate', () => {
    const ledger = makeLedger('synthetic');
    const body = seed(ledger);
    // handleOrderFill booked 0.005 as a synthetic gap row when the exchange
    // returned no fills; sync-fills later re-imported the real execution (a-2).
    ledger.ingestFill({ tradeId: 'synthetic-a-buy-0.015', orderId: 'a-buy', side: 'buy', price: '50000', size: '0.005', tradeTime: at(1.05) },
      null, { cycleId: 'cycle-1', skipPersist: true });
    ledger.annotateFillsByOrderId('a-buy', { isBodyOwned: true, bodyId: 'body-A' });
    body.buyOrders.push({ orderId: 'a-buy', price: 50000, assetQty: 0.005, sizeUsdc: 250 });
    ledger.recalculateCycles();
    assert.equal(ledger.getAllFills().find(f => f.tradeId === 'a-2').cycleAttribution, 'order');

    const { plans, skipped } = planBodyGrowthFromRecoveredBuyRows({ fillLedger: ledger, celestialBodies: [body] });

    assert.deepStrictEqual(plans, [], 'never grow a body by a duplicate of what it already holds');
    assert.equal(skipped.length, 1);
  });

  it('never considers a timestamp-folded buy (no linkage to an engine order — R2)', () => {
    const ledger = makeLedger('timeframe');
    const body = seed(ledger);
    ledger.ingestFill({ tradeId: 'm-1', orderId: 'manual-buy', side: 'buy', price: '50000', size: '0.02', tradeTime: at(2) },
      null, { cycleId: null, skipPersist: true });
    ledger.recalculateCycles();
    assert.equal(ledger.getAllFills().find(f => f.tradeId === 'm-1').cycleAttribution, 'timeframe');
    const { plans } = planBodyGrowthFromRecoveredBuyRows({ fillLedger: ledger, celestialBodies: [body] });
    assert.deepStrictEqual(plans.map(p => p.buyOrderId), ['a-buy']);
  });
});

describe('recalculateAndRefresh — running engine (#752)', () => {
  /**
   * @param {string} name
   * @returns {{ eng: any, body: any, cancelled: Array<{bodyId: string, tpOrderId: string}> }}
   */
  const makeRunningEngine = (name) => {
    const pair = `__test752${name}__`;
    PAIRS.push(pair);
    const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair, maxCycleBuys: 5 }, {});
    engines.push(eng);
    const cancelled = [];
    eng._test.setRunning(true);
    eng._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
    eng._test.setAdapter({ getOrder: async () => ({ filledSize: 0, status: 'OPEN' }), getOrderFills: async () => [], getPositions: async () => [] });
    eng._test.setOrderExecutor({
      cancelBodyTpOrder: async (bodyId, tpOrderId) => { cancelled.push({ bodyId, tpOrderId }); return { cancelled: true }; },
      placeBodyTpOrder: async () => ({ success: true, orderId: 'a-tp-2' }),
      removeBodyTracking: noop,
      markSettled: noop,
      getPendingCounts: () => ({ total: 0 }),
      getPendingLadderOrders: () => [],
      isLadderOrder: () => false,
      getOrderPlacedAt: () => null,
    });
    const body = seed(eng.getFillLedger());
    const pos = eng._getPositionState();
    pos.celestialBodies = [body];
    pos.activeCycleId = 'cycle-1';
    pos.activeCycleStartedAt = T0;
    return { eng, body, cancelled };
  };

  it('never runs two extends of one body at once (no double growth, no clobbered TP)', async () => {
    const { eng, body } = makeRunningEngine('concurrent');
    const totals = { assetQty: 0.015, costBasis: 750, avgPrice: 50000 };
    const [first, second] = await Promise.all([
      eng.extendBody('body-A', totals, 'a-buy'),
      eng.extendBody('body-A', totals, 'a-buy'),
    ]);
    assert.equal(first.success, true);
    assert.equal(second.success, false, 'the overlapping extend is refused, not merged twice');
    assert.equal(body.assetQty, 0.015);
    const retry = await eng.extendBody('body-A', totals, 'a-buy');
    assert.equal(retry.alreadyApplied, true, 'a retry after it settles converges');
  });

  it('grows the body through extendBody, cancelling its TP before growing it', async () => {
    const { eng, body, cancelled } = makeRunningEngine('run');

    eng.recalculateAndRefresh();
    for (let i = 0; i < 200 && body.assetQty === 0.01; i++) await new Promise(r => setImmediate(r));

    assert.deepStrictEqual(cancelled, [{ bodyId: 'body-A', tpOrderId: 'a-tp' }], 'the stale TP is cancelled first');
    assert.equal(body.assetQty, 0.015);
    assert.equal(body.costBasis, 750);
  });
});
