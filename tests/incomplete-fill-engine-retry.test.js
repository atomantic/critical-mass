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

describe('incompleteFills engine-level retry (issue #679 follow-up)', () => {
  it('schedules bounded engine-level retries, then gives up cleanly after exhausting them', async () => {
    let calls = 0;
    const adapter = { getOrderFills: async () => { calls++; throw incompleteFillsError(); } };
    const eng = makeEngine(adapter);
    const orderId = 'order-exhaust-1';

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));
    // First call + 3 scheduled retries at 5ms apart; wait comfortably past
    // all of them, then a bit more to confirm no further retry fires.
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(calls, 4, 'must attempt the initial call plus every configured retry, then stop');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the retry counter must be cleared once exhausted, not leaked');
  });

  it('recovers and stops retrying once a later attempt succeeds', async () => {
    let calls = 0;
    const adapter = {
      getOrderFills: async () => {
        calls++;
        if (calls < 3) throw incompleteFillsError();
        return [{ tradeId: 't1', orderId: 'order-recover-1', side: 'buy', size: 1.5, price: 2000, tradeTime: new Date().toISOString(), netFee: 0 }];
      },
    };
    const eng = makeEngine(adapter);
    const orderId = 'order-recover-1';
    const pos = eng._getPositionState();
    // No pending entry tracked for this order — handleOrderFillImpl's buy
    // path still runs the fill through fillLedger without needing one; the
    // point of this test is the retry/recovery sequencing, not full body
    // accounting.
    pos.pendingEntryOrders = [];

    await eng._test.handlePolledFill(orderId, filledBuyStatus(orderId));
    // 2 failures * 5ms apart, plus slack for the successful pass's own work.
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(calls, 3, 'must stop retrying as soon as a call succeeds');
    assert.equal(eng._test.getIncompleteFillRetryCount(orderId), 0, 'the retry counter must be cleared on success');
  });
});
