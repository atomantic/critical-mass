// @ts-check
// Issue #1979: the reconcile loop lives in regime-reconcile.js. Pins the
// factory's contract in isolation — the exposed surface, the lock a pass runs
// under and the order of its steps, the engine-owned dedup stores the orphan
// sweep consults, and the call-time accessors for the bindings the engine
// reassigns. Engine-level behavior stays covered by the reconcile-tick,
// orphan-sweep, body-TP and startup suites that drive a real engine.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createReconcileLoop } = require('../src/regime-reconcile');
const { createEngineLocks } = require('../src/engine-locks');
const { createInitialRegimePositionState } = require('../src/state-tracker');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const make = (overrides = {}) => {
  const calls = [];
  const locks = createEngineLocks({ logWarn() {} });
  // Real locks, recorded at the entry point a pass is expected to use.
  const engineLocks = {
    ...locks,
    withReconcileLock: (fn) => { calls.push('withReconcileLock'); return locks.withReconcileLock(fn); },
  };
  const positionState = createInitialRegimePositionState();
  const live = {
    isRunning: true,
    adapter: { getOrder: async () => ({ status: 'OPEN', filledSize: 0 }) },
    orderExecutor: {
      capabilities: { liveReconciliation: true },
      checkPendingOrderFills: async () => { calls.push('checkPendingOrderFills'); return { polled: 0, filled: 0, cancelled: 0 }; },
      getPendingOrdersList: () => [],
      markSettled: (orderId) => { calls.push(['markSettled', orderId]); },
      restorePendingOrder: (orderId, spec) => { calls.push(['restorePendingOrder', orderId, spec]); },
    },
    recoveryModule: { reconcile: async () => { calls.push('recovery.reconcile'); return { updated: false }; } },
  };
  const deps = {
    exchange: 'coinbase', productId: 'BTC-USD', isDryRun: false, config: {}, logger: noopLogger,
    positionState,
    fillLedger: {
      resumeBuyCorrections: () => { calls.push('resumeBuyCorrections'); },
      resumeSellCorrections: () => { calls.push('resumeSellCorrections'); },
    },
    healthMonitor: { recordOrderUpdate: () => { calls.push('recordOrderUpdate'); } },
    positionSizer: {}, engineLocks,
    recentlyProcessedFills: new Set(), incompleteFillRetries: new Map(),
    getIsRunning: () => live.isRunning,
    getAdapter: () => live.adapter,
    getOrderExecutor: () => live.orderExecutor,
    getRecoveryModule: () => live.recoveryModule,
    lookupOrNull: (label, subject, lookup) => lookup.catch(() => null),
    restoredEntryStaleMs: () => 30000,
    stampKnownFilledSize: (orderId, size) => { calls.push(['stampKnownFilledSize', orderId, size]); },
    handleOrderFill: async (fillData) => { calls.push(['handleOrderFill', fillData.orderId]); },
    knownTpCancelExecution: () => null, bookTpCancelExecution: async () => {},
    cancelBodyTpForReplace: async () => 'cancelled', placeBodyTp: async () => true,
    reconcilePendingPlacements: async () => { calls.push('reconcilePendingPlacements'); },
    completeOwedCycleReset: async () => { calls.push('completeOwedCycleReset'); },
    saveLiveState: () => { calls.push('saveLiveState'); },
    ...overrides,
  };
  return { api: createReconcileLoop(deps), calls, positionState, live, locks, deps };
};

describe('createReconcileLoop (issue #1979)', () => {
  it('exposes the engine-facing reconcile steps', () => {
    const { api } = make();
    assert.deepEqual(Object.keys(api).sort(), [
      'catchUpTerminalEntry', 'reconcileBodyTps', 'reconcileEntryFills', 'reconcileLegacyTp',
      'reconcileRecoveredPosition', 'reconcileTick', 'sweepOrphanedSavedOrders',
    ]);
  });

  it('reads the running flag at call time and skips the pass on a stopped engine', async () => {
    const { api, calls, live } = make();
    live.isRunning = false;
    assert.equal(api.reconcileTick(), undefined);
    assert.deepEqual(calls, []);
    live.isRunning = true;
    await api.reconcileTick();
    assert.equal(calls[0], 'withReconcileLock');
  });

  it('a pass runs its steps in order under the reconcile lock and holds it until every chain settles', async () => {
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
    const { api, calls, live, locks } = make();
    live.recoveryModule = { reconcile: () => { calls.push('recovery.reconcile'); return recoveryGate; } };
    const pass = api.reconcileTick();
    assert.equal(locks.getFlags().reconcileInProgress, true);
    // A second pass under the held lock is skipped rather than queued.
    assert.equal(api.reconcileTick(), undefined);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(locks.getFlags().reconcileInProgress, true);
    releaseRecovery({ updated: false });
    const settled = await pass;
    // Entry-fill poll, orphan sweep and recovered-position merge; no legacy or body TP is resting.
    assert.deepEqual(settled.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(locks.getFlags().reconcileInProgress, false);
    // The skipped second pass asked for the lock while the first was parked on its first await.
    assert.deepEqual(calls, [
      'withReconcileLock',
      'resumeBuyCorrections', 'resumeSellCorrections', 'reconcilePendingPlacements',
      'withReconcileLock',
      'completeOwedCycleReset', 'checkPendingOrderFills', 'recovery.reconcile',
    ]);
  });

  it('a failed owed cycle reset does not stop the pass', async () => {
    const { api, calls } = make({ completeOwedCycleReset: async () => { throw new Error('reset boom'); } });
    const settled = await api.reconcileTick();
    assert.equal(settled.length, 3);
    assert.ok(calls.includes('checkPendingOrderFills'));
    assert.ok(calls.includes('recovery.reconcile'));
  });

  it('the steps read the swapped adapter, executor and recovery module at call time', async () => {
    const { api, positionState, live } = make();
    const seen = [];
    live.orderExecutor = { capabilities: {} };
    assert.equal(api.reconcileEntryFills(), null);
    assert.equal(api.sweepOrphanedSavedOrders(), null);
    live.orderExecutor = {
      capabilities: { liveReconciliation: true },
      checkPendingOrderFills: async () => { seen.push('swapped-executor'); return { polled: 1, filled: 0, cancelled: 0 }; },
    };
    await api.reconcileEntryFills();
    live.adapter = { getOrder: async (orderId) => { seen.push(['swapped-adapter', orderId]); return { status: 'OPEN', filledSize: 0 }; } };
    positionState.activeTpOrderId = 'tp-legacy';
    await api.reconcileLegacyTp();
    live.recoveryModule = { reconcile: async () => { seen.push('swapped-recovery'); return { updated: false }; } };
    await api.reconcileRecoveredPosition();
    assert.deepEqual(seen, ['swapped-executor', ['swapped-adapter', 'tp-legacy'], 'swapped-recovery']);
  });

  it('the orphan sweep skips an order the engine dedup stores already own, then re-arms it once they clear', async () => {
    const { api, calls, positionState, live, deps } = make();
    const looked = [];
    live.adapter = { getOrder: async (orderId) => { looked.push(orderId); return { status: 'OPEN', filledSize: 0 }; } };
    positionState.pendingEntryOrders = [{ orderId: 'entry-1', price: 100, assetQty: 0.01, sizeUsdc: 1, placedAt: 5 }];
    positionState.pendingLadderOrders = [{ orderId: 'ladder-1', price: 90, assetQty: 0.02, sizeUsdc: 1.8, placedAt: 6, ladderIndex: 2 }];
    deps.recentlyProcessedFills.add('entry-1');
    deps.incompleteFillRetries.set('ladder-1', 1);
    await api.sweepOrphanedSavedOrders();
    assert.deepEqual(looked, []);
    deps.recentlyProcessedFills.delete('entry-1');
    deps.incompleteFillRetries.delete('ladder-1');
    await api.sweepOrphanedSavedOrders();
    assert.deepEqual(looked, ['entry-1', 'ladder-1']);
    // Still resting on the exchange: tracking is re-armed, nothing is booked or purged.
    assert.deepEqual(calls, [
      ['restorePendingOrder', 'entry-1', { type: 'entry', price: 100, size: 0.01, sizeUsdc: 1, placedAt: 5, staleMs: 30000 }],
      ['restorePendingOrder', 'ladder-1', { type: 'ladder_entry', price: 90, size: 0.02, sizeUsdc: 1.8, placedAt: 6, ladderIndex: 2 }],
    ]);
    assert.equal(positionState.pendingEntryOrders.length, 1);
    assert.equal(positionState.pendingLadderOrders.length, 1);
  });

  it('catchUpTerminalEntry books the larger known size through the fill pipeline and re-arms on a failed booking', async () => {
    const booked = [];
    const { api, calls } = make({ handleOrderFill: async (fillData) => { booked.push(fillData); } });
    const saved = { orderId: 'entry-1', price: 100, assetQty: 0.01, sizeUsdc: 1, placedAt: 5, knownFilledSize: 0.004 };
    assert.deepEqual(await api.catchUpTerminalEntry({ orderId: 'entry-0' }, { status: 'CANCELLED', filledSize: 0 }), { outcome: 'empty' });
    assert.deepEqual(calls, []);
    assert.deepEqual(await api.catchUpTerminalEntry(saved, { status: 'CANCELLED', filledSize: 0.001 }), { outcome: 'filled' });
    assert.equal(booked.length, 1);
    assert.equal(booked[0].orderId, 'entry-1');
    assert.equal(booked[0].side, 'buy');
    assert.equal(booked[0].filledSize, 0.004);
    assert.equal(booked[0].isPartialFill, true);
    assert.deepEqual(calls, [['markSettled', 'entry-1']]);

    const boom = new Error('fills incomplete');
    const failing = make({ handleOrderFill: async () => { throw boom; } });
    const row = { orderId: 'entry-2', price: 100, assetQty: 0.01, sizeUsdc: 1, placedAt: 7 };
    assert.deepEqual(await failing.api.catchUpTerminalEntry(row, { status: 'CANCELLED', filledSize: 0.002 }), { outcome: 'failed', error: boom });
    assert.equal(row.knownFilledSize, 0.002);
    assert.deepEqual(failing.calls, [
      ['markSettled', 'entry-2'],
      ['stampKnownFilledSize', 'entry-2', 0.002],
      ['restorePendingOrder', 'entry-2', { type: 'entry', price: 100, size: 0.01, sizeUsdc: 1, placedAt: 7, staleMs: 30000 }],
    ]);
  });
});
