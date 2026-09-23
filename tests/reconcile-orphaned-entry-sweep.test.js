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

const makeEngine = (adapter, executorOverrides = {}) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter(adapter);
  eng._test.setOrderExecutor(makeExecutor(executorOverrides));
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
    const restoreCalls = [];
    const eng = makeEngine(adapter, { restorePendingOrder: (id, spec) => restoreCalls.push({ id, spec }) });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 1, 'a still-open order stays in positionState untouched');
    assert.equal(pos.celestialBodies.length, 0, 'nothing should be booked for a still-resting order');
    // codex review round 2: a still-live orphan must be re-armed into
    // executor tracking, not just left alone — otherwise the ordinary
    // checkPendingOrderFills polling path (with its own advancing-partial
    // routing) never picks it back up, and only this sweep's terminal-only
    // gate would ever re-check it.
    assert.deepEqual(restoreCalls.map(c => c.id), [orderId], 'a still-open orphan must be re-armed into executor tracking so normal polling resumes');
    assert.equal(restoreCalls[0].spec.type, 'entry');
  });

  it('books a known partial instead of purging it, when a later re-poll under-reports filledSize (codex review round 3)', async () => {
    // handleCancelledOrder resolves a partial via order-executor's own
    // partialFillTracker high-water mark when the cancel-status response
    // omits filledSize, then deletes that tracker. onEntryCancelled stamps
    // the resolved value onto the saved row as knownFilledSize BEFORE that
    // happens (see regime-engine.js's onEntryCancelled handler). A LATER
    // independent re-poll of the same already-cancelled order — exactly
    // what this sweep does — can hit the identical adapter quirk and read
    // filledSize back as 0/missing. Without consulting knownFilledSize, the
    // sweep would misclassify a real 0.4 partial as an empty cancel and
    // purge it with nothing booked.
    const orderId = 'e6';
    const adapter = {
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
      // The exchange forgot filledSize on this later lookup — the exact
      // quirk handleCancelledOrder's own partialFillTracker fallback exists
      // for — but still reports a valid averageFilledPrice, letting the
      // gap-synthesis fallback book the KNOWN size once the sweep supplies it.
      getOrder: async () => ({ orderId, side: 'BUY', status: 'CANCELLED', filledSize: 0, averageFilledPrice: 2000 }),
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{
      orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now(), knownFilledSize: 0.4,
    }];

    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 0, 'the row must be cleared once the known partial is caught up');
    const bodies = pos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(bodies.length, 1, 'the known partial must be booked into a body, not silently dropped');
    assert.ok(Math.abs(bodies[0].assetQty - 0.4) < 1e-8, `the body must reflect the known 0.4 partial — got ${bodies[0].assetQty}`);
  });

  it('stamps knownFilledSize on a cancelled ladder rung too, so an under-reporting re-poll books it instead of purging (issue #764)', async () => {
    // order-executor's handleCancelledOrder fires onEntryCancelled for
    // 'ladder_entry' orders as well as 'entry' ones. The stamp used to search
    // only pendingEntryOrders, so a rung whose resolved partial then failed to
    // book had no high-water mark for this sweep to fall back on.
    const orderId = 'l1';
    const adapter = {
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
      getOrder: async () => ({ orderId, side: 'BUY', status: 'CANCELLED', filledSize: 0, averageFilledPrice: 2000 }),
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingLadderOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now(), ladderIndex: 0 }];

    // The executor resolved a 0.4 partial (from its partialFillTracker) on cancel.
    eng._test.handleEntryCancelled(orderId, { filledSize: 0.4 });
    assert.equal(pos.pendingLadderOrders[0].knownFilledSize, 0.4, 'the ladder rung row must carry the resolved partial as knownFilledSize');

    await eng._test.reconcileTick();

    assert.equal(pos.pendingLadderOrders.length, 0, 'the rung must be cleared once its known partial is caught up');
    const bodies = pos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(bodies.length, 1, 'the known ladder partial must be booked into a body, not purged as empty');
    assert.ok(Math.abs(bodies[0].assetQty - 0.4) < 1e-8, `the body must reflect the known 0.4 partial — got ${bodies[0].assetQty}`);
  });

  it('keeps a failed catch-up\'s observed partial through a later empty-looking re-cancel, and books it (issue #764)', async () => {
    // 1st sweep: the status shows a real 0.4 partial, but it can't be booked
    // (no usable price, trade scan down) — catchUpTerminalEntry re-arms the
    // executor via restorePendingOrder, which does NOT repopulate the
    // executor's partialFillTracker. When that re-armed order is re-detected
    // cancelled with an under-reporting status, onEntryCancelled sees
    // filledSize 0. Without a persisted knownFilledSize the row would be
    // purged as an empty cancel, losing the real partial.
    const orderId = 'e7';
    let pollNo = 0;
    const adapter = {
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
      getOrder: async () => (++pollNo === 1
        ? { orderId, side: 'BUY', status: 'CANCELLED', filledSize: 0.4, filledValue: 0, averageFilledPrice: 0 }
        : { orderId, side: 'BUY', status: 'CANCELLED', filledSize: 0, averageFilledPrice: 2000 }),
    };
    const restoreCalls = [];
    const eng = makeEngine(adapter, { restorePendingOrder: (id, spec) => restoreCalls.push({ id, spec }) });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    await eng._test.reconcileTick();

    assert.deepEqual(restoreCalls.map(c => c.id), [orderId], 'the failed catch-up must re-arm executor tracking');
    assert.equal(pos.celestialBodies.length, 0, 'nothing was bookable on the first attempt');
    assert.equal(pos.pendingEntryOrders.length, 1, 'the row survives the failed catch-up');
    assert.equal(pos.pendingEntryOrders[0].knownFilledSize, 0.4, 'the failed catch-up must persist the partial size it observed');

    // The re-armed order is re-detected cancelled; the status omits filledSize
    // and the executor's tracker is empty, so it reports an "empty" cancel.
    eng._test.handleEntryCancelled(orderId, { filledSize: 0 });
    assert.equal(pos.pendingEntryOrders.length, 1, 'a row with a known partial must not be purged by an empty-looking re-cancel');

    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 0, 'the row must be cleared once the known partial is booked');
    const bodies = pos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(bodies.length, 1, 'the known partial must be booked into a body');
    assert.ok(Math.abs(bodies[0].assetQty - 0.4) < 1e-8, `the body must reflect the known 0.4 partial — got ${bodies[0].assetQty}`);
  });

  it('still purges a genuinely empty cancel via onEntryCancelled when no partial is known', () => {
    const orderId = 'e8';
    const eng = makeEngine({ getOrderFills: async () => [], getOrder: async () => ({ status: 'CANCELLED', filledSize: 0 }) });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    eng._test.handleEntryCancelled(orderId, { filledSize: 0 });

    assert.equal(pos.pendingEntryOrders.length, 0, 'an empty cancel with no known partial is still purged immediately');
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

  it('books a genuinely non-empty CANCELLED partial instead of purging it', async () => {
    // The "empty cancel" purge only applies when NOTHING filled. A cancel
    // with a real partial fill still owes an accounting entry — it must be
    // routed through catchUpTerminalEntry's fill path (gap-synthesized from
    // order-status data here, since getOrderFills is unavailable), not
    // treated as safe to drop.
    const orderId = 'e4';
    const adapter = {
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
      getOrder: async () => ({
        orderId, side: 'BUY', status: 'CANCELLED', filledSize: 0.7, filledValue: 1400, averageFilledPrice: 2000,
      }),
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    await eng._test.reconcileTick();

    assert.equal(pos.pendingEntryOrders.length, 0, 'the terminal cancel-with-partial must be cleared from positionState once caught up');
    const bodies = pos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(orderId));
    assert.equal(bodies.length, 1, 'exactly one body must own the recovered partial');
    assert.ok(Math.abs(bodies[0].assetQty - 0.7) < 1e-8, `the body must reflect the real 0.7 partial, not be purged as empty — got ${bodies[0].assetQty}`);
  });

  it('does not race an in-flight #679 engine-level retry for the same orderId', async () => {
    // While the callback path's own bounded retry (issue #679) is still
    // scheduled for this exact orderId, the sweep must not ALSO call
    // adapter.getOrder/handleOrderFill for it — that would race a second
    // handleOrderFillImpl pass against the pending retry. Use a long retry
    // delay so the scheduled retry never actually fires during this test;
    // clearTimers() in after() cancels it.
    const orderId = 'e5';
    let getOrderCalls = 0;
    const adapter = {
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
      getOrder: async () => { getOrderCalls++; return { orderId, side: 'BUY', status: 'FILLED', filledSize: 1.5, averageFilledPrice: 2000, filledValue: 3000 }; },
    };
    const eng = makeEngine(adapter);
    // Long delay (never fires within this test) + 1 allowed retry, so the
    // first callback failure schedules a pending retry instead of giving up.
    eng._test.setIncompleteFillRetryTiming(60000, 1);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() }];

    // averageFilledPrice: 0 so this attempt is unbookable and fails, exactly
    // like the first test, scheduling an engine-level retry instead of
    // giving up outright.
    await eng._test.handlePolledFill(orderId, {
      orderId, side: 'BUY', status: 'FILLED', filledSize: 1.5, filledValue: 0, averageFilledPrice: 0, totalFees: 0,
    });

    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 1, 'a retry must be scheduled (not yet exhausted) for this test to be meaningful');
    assert.equal(pos.pendingEntryOrders.length, 1, 'still orphaned going into the reconcile pass');

    await eng._test.reconcileTick();

    assert.equal(getOrderCalls, 0, 'the sweep must not call adapter.getOrder while a callback-path retry is pending for this orderId');
    assert.equal(pos.pendingEntryOrders.length, 1, 'the sweep must leave the order alone while a retry is pending');
    assert.equal(pos.celestialBodies.length, 0, 'nothing should be booked while the race guard defers to the pending retry');
  });
});
