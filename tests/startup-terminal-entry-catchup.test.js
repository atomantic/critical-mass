// @ts-check
//
// Regression coverage for issue #679 follow-up (coordinator review): engine
// startup's catch-up pass for saved pending entries that went terminal while
// the engine was offline.
//
// startImpl() calls handleOrderFill(buildPartialFillData(...)) for each saved
// entry no longer open on the exchange, to ingest fills it missed while
// down. getOrderFills now rejects (issue #679) instead of silently returning
// a partial/empty set on a failed lookup or an incomplete match — far more
// likely than before. Before this fix, a throw here was only logged, and the
// entry was unconditionally purged from positionState.pendingEntryOrders
// on the very next line regardless of whether catch-up succeeded — losing an
// already-executed buy for good, with markSettled() already having run and
// no executor tracking ever re-armed to pick it up later.
//
// Disk safety: throwaway pair lives under a disposable temp root, removed
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-startup-terminal-catchup-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// regime-engine's connectWebSocket() calls a REAL createWebSocketFeed(...) —
// stub it BEFORE requiring regime-engine (which destructures it at load) so
// start() never attempts a real network connection.
const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine } = require('../src/regime-engine');

const engines = [];
after(async () => {
  // start() schedules production setInterval timers (state save, metrics,
  // reconcile) that _test.clearTimers() does not touch (it only clears the
  // ttlTimers dedup set) — only stop() clears those, in its finally block.
  // Without this the process never goes idle and the run hangs.
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

/**
 * Minimal adapter covering everything a clean (no position, no open orders)
 * engine start() touches, plus the per-test overrides that drive the
 * terminal-saved-entry catch-up path under test.
 * @param {Object} over
 * @returns {Object}
 */
const makeAdapter = (over = {}) => ({
  getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
  getCurrentPrice: async () => 2000,
  getOpenOrders: async () => [],
  getAccountBalance: async () => ({ available: 0, hold: 0 }),
  getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
  getOrderFills: async () => [],
  loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
  ...over,
});

const makeEngine = (pair, adapter) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setAdapter(makeAdapter(adapter));
  eng._test.setOrderExecutor({
    setPriceIncrement: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    restorePendingOrder: () => {},
    markSettled: () => {},
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    handleOrderFill: () => {},
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
    removeBodyTracking: () => {},
    exportState: () => ({}),
    cancelAllEntries: async () => {},
    cancelAllLadderOrders: async () => {},
    cancelTpOrder: async () => ({ cancelled: true }),
    handleOrderCancel: () => {},
  });
  // No prior saved state — recovery starts from a clean slate; the target
  // saved entry is injected onto positionState directly below.
  eng._test.setRecoveryModule({
    recoverState: async () => ({
      position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
      openOrders: new Map(),
      discrepancies: [],
    }),
  });
  engines.push(eng);
  return eng;
};

const RESTORED_ORDER_ID = 'terminal-catchup-1';

describe('startup catch-up for saved entries that went terminal offline (issue #679 follow-up)', () => {
  it('re-arms tracking and retains the entry when catch-up handleOrderFill throws, instead of losing the fill', async () => {
    const pos0RestorePendingCalls = [];
    const eng = makeEngine('__teststartupcatchup_a__', {
      // Not in getOpenOrders — this order is terminal (closed) on the exchange.
      getOrder: async (orderId) => (orderId === RESTORED_ORDER_ID
        ? { status: 'FILLED', filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000 }
        : { status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => [{
        tradeId: 'catchup-t1', orderId: RESTORED_ORDER_ID, side: 'buy',
        size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0,
      }],
    });
    // orderExecutor.handleOrderFill (the retirement call at the end of the
    // buy branch) is a reliable throw point that survives
    // handleOrderFillImpl's own order-status synthetic-fill fallback (a
    // sibling fix — see tests/incomplete-fill-engine-retry.test.js), since
    // that fallback only concerns the getOrderFills call itself, not what
    // happens after fills are successfully aggregated.
    eng._test.setOrderExecutor({
      setPriceIncrement: () => {},
      getPendingCounts: () => ({ total: 0 }),
      getOrderPlacedAt: () => null,
      isLadderOrder: () => false,
      restorePendingOrder: (orderId, opts) => pos0RestorePendingCalls.push({ orderId, opts }),
      markSettled: () => {},
      checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
      handleOrderFill: () => { throw new Error('executor retirement failed'); },
      cancelBodyTpOrder: async () => ({ cancelled: true }),
      placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
      removeBodyTracking: () => {},
      exportState: () => ({}),
    cancelAllEntries: async () => {},
    cancelAllLadderOrders: async () => {},
    cancelTpOrder: async () => ({ cancelled: true }),
    handleOrderCancel: () => {},
    });

    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: RESTORED_ORDER_ID, price: 2000, assetQty: 0.01, sizeUsdc: 20, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must still succeed: ${result.error}`);

    const finalPos = eng._getPositionState();
    assert.ok(
      (finalPos.pendingEntryOrders || []).some(e => e.orderId === RESTORED_ORDER_ID),
      'the entry must be RETAINED (not purged) when its catch-up fill processing failed',
    );
    assert.ok(
      pos0RestorePendingCalls.some(c => c.orderId === RESTORED_ORDER_ID),
      'executor tracking must be re-armed (restorePendingOrder) so a later poll/reconcile can retry it',
    );
  });

  it('books a saved knownFilledSize partial when the startup re-poll under-reports filledSize (issue #764)', async () => {
    // onEntryCancelled stamped a resolved 0.4 partial onto the saved row
    // before the restart; the fresh startup poll hits the adapter quirk that
    // omits filledSize on a cancelled order. Trusting the fresh read alone
    // would purge a real partial as an empty cancel with nothing booked.
    const eng = makeEngine('__teststartupcatchup_c__', {
      getOrder: async (orderId) => (orderId === RESTORED_ORDER_ID
        ? { status: 'CANCELLED', filledSize: 0, averageFilledPrice: 2000 }
        : { status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
    });

    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{
      orderId: RESTORED_ORDER_ID, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() - 60000, knownFilledSize: 0.4,
    }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must still succeed: ${result.error}`);

    const finalPos = eng._getPositionState();
    assert.equal(
      (finalPos.pendingEntryOrders || []).some(e => e.orderId === RESTORED_ORDER_ID),
      false,
      'the caught-up partial is purged from pending entries once booked',
    );
    const bodies = finalPos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(RESTORED_ORDER_ID));
    assert.equal(bodies.length, 1, 'the known partial must be booked into a body, not purged as an empty cancel');
    assert.ok(Math.abs(bodies[0].assetQty - 0.4) < 1e-8, `the body must reflect the known 0.4 partial — got ${bodies[0].assetQty}`);
  });

  it('catches up a saved ladder rung that went terminal offline instead of dropping its known partial (issue #764)', async () => {
    const RUNG_ID = 'terminal-ladder-1';
    const eng = makeEngine('__teststartupcatchup_d__', {
      getOrder: async (orderId) => (orderId === RUNG_ID
        ? { status: 'CANCELLED', filledSize: 0, averageFilledPrice: 2000 }
        : { status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
    });

    const pos = eng._getPositionState();
    pos.ladderActive = true;
    pos.pendingLadderOrders = [{
      orderId: RUNG_ID, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() - 60000, ladderIndex: 0, knownFilledSize: 0.4,
    }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must still succeed: ${result.error}`);

    const finalPos = eng._getPositionState();
    assert.equal((finalPos.pendingLadderOrders || []).length, 0, 'the caught-up rung is cleared once booked');
    assert.equal(finalPos.ladderActive, false, 'with no rungs left, ladder mode must be cleared as the old purge did');
    const bodies = finalPos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(RUNG_ID));
    assert.equal(bodies.length, 1, 'the rung\'s known partial must be booked into a body, not dropped by the ladder restore');
    assert.ok(Math.abs(bodies[0].assetQty - 0.4) < 1e-8, `the body must reflect the known 0.4 partial — got ${bodies[0].assetQty}`);
  });

  it('retains a saved ladder rung whose offline catch-up fails, for the reconcile sweep to retry (issue #764)', async () => {
    const RUNG_ID = 'terminal-ladder-2';
    const restoreCalls = [];
    const eng = makeEngine('__teststartupcatchup_e__', {
      // Status proves a real fill, but no usable price and no trade scan —
      // nothing can be booked on this attempt.
      getOrder: async (orderId) => (orderId === RUNG_ID
        ? { status: 'FILLED', filledSize: 1.5, filledValue: 0, averageFilledPrice: 0 }
        : { status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => { throw new Error('trade scan unavailable'); },
    });
    eng._test.setOrderExecutor({
      setPriceIncrement: () => {},
      getPendingCounts: () => ({ total: 0 }),
      getOrderPlacedAt: () => null,
      isLadderOrder: () => false,
      restorePendingOrder: (orderId, spec) => restoreCalls.push({ orderId, spec }),
      markSettled: () => {},
      checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
      handleOrderFill: () => {},
      cancelBodyTpOrder: async () => ({ cancelled: true }),
      placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
      removeBodyTracking: () => {},
      exportState: () => ({}),
      cancelAllEntries: async () => {},
      cancelAllLadderOrders: async () => {},
      cancelTpOrder: async () => ({ cancelled: true }),
      handleOrderCancel: () => {},
    });

    const pos = eng._getPositionState();
    pos.ladderActive = true;
    pos.pendingLadderOrders = [{
      orderId: RUNG_ID, price: 2000, assetQty: 1.5, sizeUsdc: 3000, placedAt: Date.now() - 60000, ladderIndex: 0,
    }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must still succeed: ${result.error}`);

    const finalPos = eng._getPositionState();
    const kept = (finalPos.pendingLadderOrders || []).find(o => o.orderId === RUNG_ID);
    assert.ok(kept, 'a rung whose catch-up failed must be retained, not purged as no-longer-open');
    assert.equal(finalPos.ladderActive, true, 'a retained rung keeps the ladder active until it is booked');
    assert.equal(kept.knownFilledSize, 1.5, 'the failed catch-up must record the size it observed');
    assert.ok(
      restoreCalls.some(c => c.orderId === RUNG_ID && c.spec.type === 'ladder_entry' && c.spec.ladderIndex === 0),
      'executor tracking must be re-armed as a ladder_entry for the retry',
    );
    assert.equal(finalPos.celestialBodies.filter(b => (b.sourceOrderIds || []).includes(RUNG_ID)).length, 0, 'nothing bookable yet');
  });

  it('purges the entry as before when catch-up succeeds', async () => {
    const eng = makeEngine('__teststartupcatchup_b__', {
      getOrder: async (orderId) => (orderId === RESTORED_ORDER_ID
        ? { status: 'FILLED', filledSize: 0.01, filledValue: 20, averageFilledPrice: 2000 }
        : { status: 'OPEN', filledSize: 0 }),
      getOrderFills: async () => [{
        tradeId: 'catchup-t1', orderId: RESTORED_ORDER_ID, side: 'buy',
        size: 0.01, price: 2000, tradeTime: new Date().toISOString(), netFee: 0,
      }],
    });

    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: RESTORED_ORDER_ID, price: 2000, assetQty: 0.01, sizeUsdc: 20, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must still succeed: ${result.error}`);

    const finalPos = eng._getPositionState();
    assert.equal(
      (finalPos.pendingEntryOrders || []).some(e => e.orderId === RESTORED_ORDER_ID),
      false,
      'a successfully caught-up entry is still purged (unchanged pre-existing behavior)',
    );
    assert.ok(finalPos.celestialBodies.some(b => (b.sourceOrderIds || []).includes(RESTORED_ORDER_ID)), 'the catch-up fill must still be booked into a body');
  });
});
