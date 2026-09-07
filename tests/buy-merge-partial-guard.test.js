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

// The size optimizer persists its output per-pair into the SHARED
// data/config.json, so constructing an engine on a throwaway pair would
// register that pair as a real fund in a production install (and race a
// running engine's own config writes). Neutralize the write BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__test201__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
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

  it('routes buy to its own body AND immediately books the sold tranche when the target TP partially fills DURING the cancel (issue #227 follow-up)', async () => {
    // The pre-check sees the target TP clean, so the merge proceeds to cancel it —
    // but the TP partially fills in the cancel race. safeCancelOrder now surfaces
    // that sold qty (plus value/price/fees) via cancelResult, so the merge path
    // reacts twice: (1) does NOT fold the buy onto the target's stale qty — routes
    // it to its own body; (2) books the sold tranche itself immediately, rather
    // than deferring to a future WS/poll event that may never arrive once
    // cancelBodyTpOrder has already removed the order from executor tracking.
    let getOrderCalls = 0;
    let cancelCalls = 0;
    const target = makeBody('target', 50000, 0.01, 'tp-target');
    const eng = makeEngine({
      bodies: [target],
      adapter: {
        // Pre-check is clean — the partial only surfaces from the cancel result.
        getOrder: async () => {
          getOrderCalls++;
          return getOrderCalls === 1
            ? { filledSize: 0, status: 'OPEN' }
            : { filledSize: 0.004, status: 'CANCELLED', averageFilledPrice: 50500 };
        },
        getOpenOrders: async () => [],
        // Fills are keyed by orderId: the buy's own fill for 'buy-new', and the
        // target TP's partial sell fill for 'tp-target' (the immediate booking).
        getOrderFills: async (orderId) => {
          if (orderId === 'tp-target') {
            return [{
              tradeId: 'tp-target-t1',
              orderId: 'tp-target',
              side: 'sell',
              price: '50500',
              size: '0.004',
              totalCommission: '0.02',
              rebate: '0',
              liquidityIndicator: 'MAKER',
              tradeTime: new Date().toISOString(),
            }];
          }
          return buyFills('buy-new', 0.01, 50000);
        },
      },
      executor: {
        cancelBodyTpOrder: async () => {
          cancelCalls++;
          return { cancelled: true, filled: false, filledSize: 0.004, filledValue: 202, averageFilledPrice: 50500, totalFees: 0.02 };
        },
      },
    });

    await eng._test.handleOrderFill({ orderId: 'buy-new', side: 'buy', filledSize: 0.01, averageFilledPrice: 50000 });

    const bodies = eng._getPositionState().celestialBodies;
    assert.equal(getOrderCalls, 2, 'pre-check saw a clean target, then terminal status was verified');
    assert.equal(cancelCalls, 1, 'the merge proceeded to cancel the clean target TP');

    assert.equal(bodies.length, 2, 'the buy became its own body instead of folding onto the partially-sold target');
    const liveTarget = bodies.find(b => b.id === 'target');
    assert.ok(liveTarget, 'target body survives');
    // 0.01 - 0.004 sold = 0.006 remaining — deducted immediately, not deferred.
    assert.ok(Math.abs(liveTarget.assetQty - 0.006) < 1e-9, `sold tranche deducted immediately, got ${liveTarget.assetQty}`);
    assert.ok(liveTarget.tpOrderId && liveTarget.tpOrderId !== 'tp-target', 'a fresh, correctly-sized TP was re-placed on the deducted body');

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
