// @ts-check
//
// Tests for the operator resetCycleBuys() action (issue #232).
//
// Exercises the REAL resetCycleBuys() closure inside createRegimeEngine via the
// engine's _test hooks, with mock exchange deps injected so no network is hit.
//
// Disk safety: the engine is constructed with a throwaway pair/productId
// ('__test232__') so any state / fill-ledger persistence lands in
// data/coinbase/__test232__/, which the suite deletes in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test232__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];

after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const makeAdapter = (over = {}) => ({
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  getPositions: async () => [],
  ...over,
});

const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-new-1' }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  cancelAllLadderOrders: async () => ({ cancelled: 0 }),
  getPendingLadderOrders: () => [],
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
  isLadderOrder: () => false,
  getOrderPlacedAt: () => null,
  ...over,
});

const makeBody = (id, avgPrice, qty, tpOrderId = 'tp-1') => ({
  id,
  tier: 'ASTEROID',
  assetQty: qty,
  costBasis: qty * avgPrice,
  avgPrice,
  tpPrice: avgPrice * 1.01,
  tpOrderId,
  assetOnOrder: qty,
  buyOrders: [{ orderId: `buy-${id}` }],
  sourceOrderIds: [],
});

/**
 * Build a running engine with mock deps, a filled cycle, and cycleBuys at the cap.
 * @param {{ maxCycleBuys?: number, bodies?: Array }} [opts]
 */
const makeEngine = ({ maxCycleBuys = 3, bodies } = {}) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR, maxCycleBuys }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(makeAdapter());
  eng._test.setOrderExecutor(makeExecutor());

  const ledger = eng.getFillLedger();
  ledger.startNewCycle();
  // Ingest buy fills so getCurrentCycleAllBuysCount() reflects a busy cycle.
  for (let i = 0; i < maxCycleBuys; i++) {
    ledger.ingestFill({ tradeId: `t-${i}`, orderId: `buy-${i}`, side: 'buy', price: '50000', size: '0.01' }, null, { skipPersist: true });
  }

  const pos = eng._getPositionState();
  pos.celestialBodies = bodies || [makeBody('bodyA', 50000, 0.05), makeBody('bodyB', 50100, 0.03)];
  pos.totalAsset = pos.celestialBodies.reduce((s, b) => s + b.assetQty, 0);
  pos.cycleBuys = maxCycleBuys; // at the cap → buys paused

  engines.push(eng);
  return eng;
};

describe('#232 resetCycleBuys() — operator reset to resume buying', () => {
  it('refuses when the engine is not running', async () => {
    const eng = makeEngine();
    eng._test.setRunning(false);
    const result = await eng.resetCycleBuys();
    assert.equal(result.success, false);
    assert.match(result.message, /not running/i);
  });

  it('refuses while a merge is in progress', async () => {
    const eng = makeEngine();
    eng._test.setMergeInProgress(true);
    const result = await eng.resetCycleBuys();
    assert.equal(result.success, false);
    assert.match(result.message, /merge, reconcile, or fill/i);
    // Cycle counter untouched by the refusal.
    assert.equal(eng._getPositionState().cycleBuys, 3);
  });

  it('refuses while a reconcile is in progress', async () => {
    const eng = makeEngine();
    eng._test.setReconcileInProgress(true);
    const result = await eng.resetCycleBuys();
    assert.equal(result.success, false);
    assert.match(result.message, /merge, reconcile, or fill/i);
  });

  it('refuses while a fill is in progress (issue #232 follow-up)', async () => {
    // A fill mid-handling may already be ingested into the ledger under the
    // about-to-be-superseded cycle but not yet reflected in cycleBuys —
    // resetting the cycle boundary underneath it would desync cycleBuys from
    // the ledger (see consolidateDustBodies' identical gate at line ~3350).
    const eng = makeEngine();
    eng._test.setFillInProgress(1);
    const result = await eng.resetCycleBuys();
    assert.equal(result.success, false);
    assert.match(result.message, /merge, reconcile, or fill/i);
    // Cycle counter untouched by the refusal.
    assert.equal(eng._getPositionState().cycleBuys, 3);
  });

  it('on success resets cycleBuys to 0, starts a new cycle, and preserves bodies', async () => {
    const eng = makeEngine({ maxCycleBuys: 3 });
    const ledger = eng.getFillLedger();
    const cycleIdBefore = ledger.getCurrentCycleId();

    // Sanity: the pre-reset cycle is at the cap (buys paused).
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 3);
    assert.equal(eng._getPositionState().cycleBuys, 3);
    const bodiesBefore = eng._getPositionState().celestialBodies.map(b => b.id);
    assert.deepEqual(bodiesBefore, ['bodyA', 'bodyB']);

    const result = await eng.resetCycleBuys();

    assert.equal(result.success, true);
    assert.match(result.message, /re-enabled/i);
    assert.ok(result.status, 'returns engine status');

    // cycleBuys reset to 0 in position state and in the returned status.
    assert.equal(eng._getPositionState().cycleBuys, 0);
    assert.equal(result.status.position.cycleBuys, 0);

    // A NEW fill-ledger cycle was started → the fresh cycle has 0 buys, and the
    // old cycle's fills no longer count toward the current-cycle buy limit.
    assert.notEqual(ledger.getCurrentCycleId(), cycleIdBefore);
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 0);

    // Open celestial bodies (and their TPs) are preserved across the reset.
    const bodiesAfter = eng._getPositionState().celestialBodies.map(b => b.id);
    assert.deepEqual(bodiesAfter, ['bodyA', 'bodyB']);
    assert.ok(eng._getPositionState().celestialBodies.every(b => b.tpOrderId), 'TP orders preserved');
  });
});
