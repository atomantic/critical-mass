// @ts-check
//
// Regression coverage for issue #673: a polled entry fill that fails
// processing was never retried until the engine restarted.
//
// order-executor's checkPendingOrderFills (and handleCancelledOrder) delete a
// terminal order from its own pendingOrders map BEFORE invoking
// onFillDetected. Issue #679 added a bounded engine-level retry inside that
// callback for a terminal fill, but the retry is bounded: once it gives up,
// the row survives in positionState.pendingEntryOrders /
// pendingLadderOrders (only a SUCCESSFUL handleOrderFill removes it), and
// nothing else re-polled those lists at runtime — only the startup catch-up
// did. A transient failure after a real buy fill left it invisible to both
// the executor and the fill pipeline until the process restarted.
//
// reconcileTick now sweeps positionState.pendingEntryOrders /
// pendingLadderOrders for rows whose orderId is missing from the executor's
// own tracking, and routes any that are already terminal on the exchange
// through the same catch-up handling the startup path uses
// (catchUpTerminalEntry).
//
// Disk safety: throwaway pair lives under a disposable temp root, removed in
// after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-orphaned-entry-sweep-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__testorphanedentrysweep__';

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

// Permissive orderExecutor stub covering everything a successful buy-fill
// pass (body creation + TP placement) might call. getPendingOrdersList
// deliberately returns [] — this is the post-#679-exhaustion state the sweep
// targets: the order-executor has already dropped the order from its own
// pendingOrders map (checkPendingOrderFills deletes it before invoking the
// callback), while positionState.pendingEntryOrders still carries the row.
const makeExecutor = (over = {}) => ({
  capabilities: { liveReconciliation: true },
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
  getPendingOrdersList: () => [],
  getOrderPlacedAt: () => null,
  isLadderOrder: () => false,
  restorePendingOrder: () => {},
  ...over,
});

const makeEngine = (adapter) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(adapter);
  eng._test.setOrderExecutor(makeExecutor());
  eng._test.setRecoveryModule({ reconcile: async () => ({ updated: false }) });
  // Zero retries: the very first callback failure gives up immediately,
  // exercising the "engine-level retry exhausted" state the sweep targets,
  // without waiting through extra 2s getOrderFills retries per attempt.
  eng._test.setIncompleteFillRetryTiming(5, 0);
  engines.push(eng);
  return eng;
};

describe('reconcileTick orphaned entry/ladder sweep (issue #673)', () => {
  it('catches up a terminal buy fill whose engine-level retry (#679) exhausted, once positionState carries it but the executor no longer tracks it', async () => {
    const orderId = 'e1';

    // First (and only, given 0 configured retries) callback attempt: order
    // status shows FILLED, but averageFilledPrice is unusable (0) so the
    // terminal gap-synthesis fallback can't fire and getOrderFills keeps
    // throwing — handleOrderFillImpl has nothing to book and throws,
    // matching a real "could not confirm the trade-level fills" outage.
    const unbookableStatus = {
      orderId,
      side: 'BUY',
      status: 'FILLED',
      filledSize: 1.5,
      filledValue: 0,
      averageFilledPrice: 0,
      totalFees: 0,
    };

    const adapter = {
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
      // Only the reconcile sweep calls getOrder directly (the polled-fill
      // callback path receives its status inline) — by the time it does,
      // the exchange record is fully resolvable.
      getOrder: async (id) => {
        assert.equal(id, orderId);
        return {
          orderId,
          side: 'BUY',
          status: 'FILLED',
          filledSize: 1.5,
          filledValue: 3000,
          averageFilledPrice: 2000,
          totalFees: 0,
        };
      },
    };

    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    // Simulate the saved state left behind once order-executor tracking
    // (mocked with an empty getPendingOrdersList above) already dropped
    // this order but the engine-level retry never booked it.
    pos.pendingEntryOrders = [{
      orderId,
      price: 2000,
      assetQty: 1.5,
      sizeUsdc: 3000,
      placedAt: Date.now(),
    }];

    // 1. Drive the callback path directly, mirroring order-executor's
    //    checkPendingOrderFills invoking onFillDetected fire-and-forget.
    await eng._test.handlePolledFill(orderId, unbookableStatus);

    // Confirm the engine-level retry truly gave up (not still pending) and
    // that the failure left the order an orphan: gone from executor
    // tracking (by construction), still present in positionState.
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the bounded retry must have exhausted/given up, not be scheduled');
    assert.equal(pos.pendingEntryOrders.length, 1, 'the saved entry must still be orphaned in positionState after the callback gives up');
    assert.equal(pos.celestialBodies.length, 0, 'nothing was booked yet — no body must exist');

    // 2. One reconcile pass must now detect the orphan (missing from
    //    orderExecutor.getPendingOrdersList()) and catch it up.
    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 0, 'the orphaned entry must be cleared from positionState once caught up');
    const bodies = pos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(bodies.length, 1, 'exactly one body must own the recovered buy');
    assert.ok(Math.abs(bodies[0].assetQty - 1.5) < 1e-8, `the body must reflect the full 1.5 recovered fill — got ${bodies[0].assetQty}`);
  });

  it('leaves a still-resting (non-terminal) orphaned entry alone', async () => {
    const orderId = 'e2';
    const adapter = {
      getOrderFills: async () => [],
      getOrder: async () => ({ orderId, side: 'BUY', status: 'OPEN', filledSize: 0 }),
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 1, 'a still-open order must not be touched by the sweep');
    assert.equal(pos.celestialBodies.length, 0, 'nothing should be booked for a still-resting order');
  });

  it('purges a saved entry that turns out to be an empty (unfilled) cancel, with nothing to book', async () => {
    const orderId = 'e3';
    const adapter = {
      getOrderFills: async () => [],
      getOrder: async () => ({ orderId, side: 'BUY', status: 'CANCELLED', filledSize: 0 }),
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 0, 'a genuinely empty cancel must be purged, not left stranded');
    assert.equal(pos.celestialBodies.length, 0, 'no body should be created for an empty cancel');
  });
});
