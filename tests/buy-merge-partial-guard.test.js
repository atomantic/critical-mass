// @ts-check
//
// Integration tests for #201: the buy-fill merge path must NOT fold a new buy
// into a merge target whose TP has already partially filled. Folding onto the
// target's stale assetQty/costBasis (which still include the sold tranche) would
// leave the body claiming asset the account no longer holds and double-attribute
// the sold tranche's cost. The guard mirrors _mergeBodyImpl's filledSize>0 check.
//
// Disk safety: throwaway pair '__test201__' → data/coinbase/__test201__/, deleted
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test201__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

/** One buy fill for the incoming order, returned by getOrderFills. */
const buyFills = (orderId, size, price) => [{
  tradeId: `${orderId}-t1`,
  orderId,
  side: 'buy',
  price: String(price),
  size: String(size),
  totalCommission: '0.05',
  rebate: '0',
  liquidityIndicator: 'TAKER',
  tradeTime: new Date().toISOString(),
}];

const makeExecutor = (over = {}) => {
  let tp = 0;
  return {
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: `tp-new-${++tp}` }),
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    markSettled: () => {},
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    // Force findMergeTarget down the "order budget full" branch so the single
    // existing body is deterministically selected as the merge target.
    getPendingCounts: () => ({ total: 1_000_000 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    ...over,
  };
};

const makeBody = (id, avgPrice, qty, tpOrderId) => ({
  id,
  tier: 'ASTEROID',
  assetQty: qty,
  costBasis: qty * avgPrice,
  avgPrice,
  tpPrice: avgPrice * 1.01,
  tpOrderId,
  assetOnOrder: qty * 0.9,
  buyOrders: [{ orderId: `seed-${id}` }],
  sourceOrderIds: [`seed-${id}`],
});

const makeEngine = ({ bodies, adapter, executor }) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(adapter);
  eng._test.setOrderExecutor(makeExecutor(executor || {}));
  const pos = eng._getPositionState();
  pos.celestialBodies = bodies;
  pos.totalAsset = bodies.reduce((s, b) => s + b.assetQty, 0);
  pos.totalCostBasis = bodies.reduce((s, b) => s + b.costBasis, 0);
  engines.push(eng);
  return eng;
};

describe('#201 buy-fill merge — partial-fill pre-check', () => {
  it('does NOT merge into a target whose TP partially filled; routes buy to its own body', async () => {
    let getOrderCalls = 0;
    let cancelCalls = 0;
    const target = makeBody('target', 50000, 0.01, 'tp-target');
    const eng = makeEngine({
      bodies: [target],
      adapter: {
        // Target TP has partially filled 0.003 — the exact #201 hazard.
        getOrder: async (orderId) => {
          getOrderCalls++;
          assert.equal(orderId, 'tp-target', 'pre-check must query the target TP');
          return { filledSize: 0.003, status: 'OPEN' };
        },
        getOrderFills: async () => buyFills('buy-new', 0.01, 50000),
      },
      executor: { cancelBodyTpOrder: async () => { cancelCalls++; return { cancelled: true }; } },
    });

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    const bodies = eng._getPositionState().celestialBodies;
    assert.equal(getOrderCalls, 1, 'the partial-fill pre-check ran');
    assert.equal(cancelCalls, 0, 'a partially-filled target TP must never be cancelled for merge');

    const liveTarget = bodies.find(b => b.id === 'target');
    assert.ok(liveTarget, 'target body survives');
    assert.ok(Math.abs(liveTarget.assetQty - 0.01) < 1e-9, `target qty unchanged (not merged), got ${liveTarget.assetQty}`);

    assert.equal(bodies.length, 2, 'the new buy became its own body instead of merging');
    const newBody = bodies.find(b => b.id !== 'target');
    assert.ok(
      (newBody.sourceOrderIds || []).includes('buy-new') || (newBody.buyOrders || []).some(o => o.orderId === 'buy-new'),
      'the new body owns the incoming buy order',
    );
  });

  it('DOES merge when the target TP has no partial fill (guard is specific)', async () => {
    const target = makeBody('target', 50000, 0.01, 'tp-target');
    const eng = makeEngine({
      bodies: [target],
      adapter: {
        getOrder: async () => ({ filledSize: 0, status: 'OPEN' }), // clean target
        getOrderFills: async () => buyFills('buy-new', 0.01, 50000),
      },
    });

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    const bodies = eng._getPositionState().celestialBodies;
    assert.equal(bodies.length, 1, 'clean target absorbs the buy (one merged body)');
    assert.ok(bodies[0].assetQty > 0.019, `merged qty ~0.02, got ${bodies[0].assetQty}`);
  });
});
