// @ts-check
//
// Regression coverage for issue #679 follow-up (codex review round 3):
// getOrderFills rejects with `{ incompleteFills: true }` when the matched
// fill total falls short of the order's own filled quantity, after its own
// brief internal retry. For a TERMINAL fill detected via polling,
// order-executor's checkPendingOrderFills already deletes the order from
// pendingOrders BEFORE invoking the fill callback — and exchanges like
// Gemini/Crypto.com have no order-event WebSocket to rediscover it — so the
// next reconcile pass can no longer re-poll that order. Without an
// engine-level retry, a rejection here would strand the fill.
//
// regime-engine.js's liveCallbacks.onFillDetected now schedules a bounded
// engine-level retry (default 5 attempts / 10s apart, overridable via
// _test.setIncompleteFillRetryTiming for tests) of itself when
// handleOrderFill rejects with incompleteFills, instead of only logging
// "will retry on next reconcile" (which is not true for this failure mode).
//
// Disk safety: throwaway pair lives under a disposable temp root, removed
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-incomplete-fill-retry-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__testincompletefillretry__';

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

// Permissive orderExecutor stub covering everything a successful buy-fill
// pass (body creation + TP placement) might call, so the "recovery" test
// below can exercise a real happy-path completion without asserting on
// business-logic side effects it isn't about.
const makeExecutor = (over = {}) => ({
  cancelBodyTpOrder: async () => ({ cancelled: true }),
  placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
  checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
  markSettled: () => {},
  removeBodyTracking: () => {},
  handleOrderFill: () => {},
  getPendingCounts: () => ({ total: 0 }),
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
  // Fast, deterministic timing for the test — production keeps 10s/5 attempts.
  eng._test.setIncompleteFillRetryTiming(5, 3);
  engines.push(eng);
  return eng;
};

const incompleteFillsError = () =>
  Object.assign(new Error('fills incomplete: 0.5 of 1.5'), { incompleteFills: true });

const filledBuyStatus = (orderId) => ({
  orderId,
  side: 'BUY',
  status: 'FILLED',
  filledSize: 1.5,
  filledValue: 3000,
  averageFilledPrice: 2000,
  totalFees: 0,
});

describe('synthetic fallback accounts for the GAP, not the stale ledger total (codex convergence review)', () => {
  it('books the remainder when a terminal rescan fails after an earlier partial was already ingested', async () => {
    // 1. A real partial fill ingests 0.01 and creates/owns a body — no
    //    getOrderFills failure yet.
    // 2. A later TERMINAL poll reports 0.03 total filled, but getOrderFills
    //    now fails (both the initial call and its 2s-delayed retry) — the
    //    old fallback reduced to the stale ledger-only total (0.01),
    //    shouldSkipBuyRecommit saw "already owned, nothing new ingested",
    //    and retired the order without ever booking the remaining 0.02.
    const orderId = 'gap-order-1';
    let getOrderFillsCalls = 0;
    const adapter = {
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => {
        getOrderFillsCalls++;
        if (getOrderFillsCalls === 1) {
          return [{ tradeId: 'gap-t1', orderId, side: 'buy', size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }];
        }
        throw new Error('trade scan unavailable');
      },
    };
    const eng = makeEngine(adapter);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'PARTIALLY_FILLED',
      filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000, isPartialFill: true,
    });

    const afterPartial = eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.ok(afterPartial, 'the partial fill must create/own a body');
    assert.ok(Math.abs(afterPartial.assetQty - 0.01) < 1e-8, `body should hold the 0.01 partial, got ${afterPartial.assetQty}`);

    // Terminal poll: order status now reports the full 0.03, but every
    // getOrderFills call from here on fails.
    await eng._test.handleOrderFill({
      orderId, side: 'buy', status: 'FILLED',
      filledSize: 0.03, filledValue: 60, averageFilledPrice: 2000, isPartialFill: false,
    });

    assert.ok(getOrderFillsCalls >= 3, 'must have attempted the terminal rescan and its 2s retry');
    const afterTerminal = eng._getPositionState().celestialBodies.find(b => (b.sourceOrderIds || []).includes(orderId));
    assert.ok(afterTerminal, 'the body must still exist after the terminal rescan failure');
    assert.ok(
      Math.abs(afterTerminal.assetQty - 0.03) < 1e-8,
      `the body must reflect the FULL 0.03 (the gap must be booked, not dropped or double-counted) — got ${afterTerminal.assetQty}`,
    );
  });
});

describe('incompleteFills engine-level retry (issue #679 follow-up)', () => {
  it('a persistently-incomplete getOrderFills still succeeds via the order-status fallback, with no engine-level retry needed', async () => {
    // handleOrderFillImpl's own order-status synthetic-fill fallback (a
    // sibling fix to this one) already absorbs a getOrderFills rejection
    // when order status (filledSize + averageFilledPrice, known independent
    // of the failed call) is usable — so the common case never needs to
    // reach this engine-level retry mechanism at all.
    let calls = 0;
    const adapter = { getOrderFills: async () => { calls++; throw incompleteFillsError(); } };
    const eng = makeEngine(adapter);
    const orderId = 'order-fallback-1';
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));

    assert.equal(calls, 2, 'getOrderFills is attempted (and its own internal empty-rawFills retry runs) before falling back');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'no engine-level retry needed — the fallback already succeeded');
  });

  it('a non-getOrderFills failure on a terminal fill still gets a bounded engine-level retry, then gives up cleanly', async () => {
    // Codex + coordinator review: the engine-level retry originally only
    // fired for an err.incompleteFills-flagged error, but a terminal fill
    // (already removed from orderExecutor's pendingOrders before this
    // callback runs) has the identical "next reconcile can't rediscover it"
    // problem for ANY failure, not just a getOrderFills one — e.g. a
    // rethrown order-detail/status lookup failure carries no such flag, and
    // neither does a downstream placement failure. The gate is now
    // isTerminal (FILLED/CANCELLED), not the error type.
    let calls = 0;
    const adapter = {
      getOrderFills: async () => [{ tradeId: 't1', orderId: 'order-exhaust-1', side: 'buy', size: 1.5, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }],
    };
    const eng = makeEngine(adapter);
    // orderExecutor.handleOrderFill (the retirement call at the end of the
    // buy branch) is a reliable throw point that is NOT internally swallowed
    // the way a TP-placement failure is (that path logs and lets the body
    // persist without a TP instead of propagating) — good for isolating the
    // retry mechanism itself from unrelated pipeline resilience.
    eng._test.setOrderExecutor(makeExecutor({
      handleOrderFill: () => { calls++; throw new Error('executor retirement failed'); },
    }));
    const orderId = 'order-exhaust-1';
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));
    // First call + 3 scheduled retries at 5ms apart; wait comfortably past
    // all of them, then a bit more to confirm no further retry fires.
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(calls, 4, 'must attempt the initial call plus every configured retry, then stop');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the retry counter must be cleared once exhausted, not leaked');
  });

  it('a non-getOrderFills failure on a terminal fill recovers and stops retrying once a later attempt succeeds', async () => {
    let calls = 0;
    const adapter = {
      getOrderFills: async () => [{ tradeId: 't1', orderId: 'order-recover-1', side: 'buy', size: 1.5, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }],
    };
    const eng = makeEngine(adapter);
    eng._test.setOrderExecutor(makeExecutor({
      handleOrderFill: () => {
        calls++;
        if (calls < 3) throw new Error('executor retirement failed');
      },
    }));
    const orderId = 'order-recover-1';
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));
    // 2 failures * 5ms apart, plus slack for the successful pass's own work.
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(calls, 3, 'must stop retrying as soon as a call succeeds');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the retry counter must be cleared on success');
  });
});
