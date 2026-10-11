// @ts-check
//
// Issue #1010: a drained fund's live cycle turnover hands the host an async
// onLifecycleClosed callback. It must be owned — tracked as a pending write
// from scheduling until teardown settles, deferred to the next tick, and with
// sync throws / async rejections contained (an unowned rejection reaches the
// fatal process guard and kills every fund in the exchange process).
//
// Disk safety: throwaway pair under a disposable temp data root.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-lifecycle-close-callback-test');

const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const adapters = require('../src/adapters');
const originalGetAdapter = adapters.getAdapter;
adapters.getAdapter = () => ({ getReconciliationFills: async () => [] });

const { createRegimeEngine } = require('../src/regime-engine');
const { getPendingWrites } = require('../src/pending-writes');

let seq = 0;
const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  adapters.getAdapter = originalGetAdapter;
  isolatedData.cleanup();
});

/** Draining engine whose next resetCycle() closes the fund. */
const makeDrainingEngine = (callbacks) => {
  const pair = `__test1010${String.fromCharCode(97 + seq++)}__`;
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, callbacks);
  eng._test.setRunning(true);
  eng._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
  eng._test.setAdapter({ getOrder: async () => ({ filledSize: 0, status: 'OPEN' }), getOrderFills: async () => [], getPositions: async () => [] });
  eng._test.setOrderExecutor({
    cancelAllLadderOrders: async () => ({ cancelled: 0, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [] }),
    getPendingLadderOrders: () => [],
    getPendingCounts: () => ({ total: 0 }),
    removeBodyTracking: () => {},
  });
  eng._getPositionState().lifecycle = 'draining';
  engines.push(eng);
  return { eng, pair };
};

const closeLabels = () => getPendingWrites().map((w) => w.label).filter((l) => l.startsWith('engine-lifecycle-close:'));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const watchUnhandled = () => {
  const seen = [];
  const handler = (err) => seen.push(err);
  process.on('unhandledRejection', handler);
  return { seen, stop: () => process.off('unhandledRejection', handler) };
};

describe('live drained-fund close owns the onLifecycleClosed callback (#1010)', () => {
  it('async rejection after the callback awaits is contained', async () => {
    const watch = watchUnhandled();
    let calls = 0;
    const { eng } = makeDrainingEngine({
      onLifecycleClosed: async () => {
        calls++;
        await tick();
        throw new Error('EACCES: unlink running flag');
      },
    });
    const result = await eng._test.resetCycle();
    assert.equal(result.turnedOver, true);
    assert.equal(eng._getPositionState().lifecycle, 'closed');
    assert.equal(calls, 0, 'callback deferred to the next tick');
    assert.equal(closeLabels().length, 1, 'close is tracked before the immediate fires');

    await tick(); // callback starts
    assert.equal(calls, 1);
    assert.equal(closeLabels().length, 1, 'still tracked while teardown is in flight');
    await tick(); await tick(); await tick();
    assert.equal(closeLabels().length, 0, 'untracked once teardown settles');
    watch.stop();
    assert.deepEqual(watch.seen, [], 'no unhandled rejection');
  });

  it('synchronous callback throw is contained', async () => {
    const watch = watchUnhandled();
    const { eng } = makeDrainingEngine({
      onLifecycleClosed: () => { throw new Error('sync boom'); },
    });
    await eng._test.resetCycle();
    await tick(); await tick(); await tick();
    assert.equal(closeLabels().length, 0);
    watch.stop();
    assert.deepEqual(watch.seen, []);
  });

  it('successful close runs exactly once; a non-draining fund never schedules it', async () => {
    let calls = 0;
    const draining = makeDrainingEngine({ onLifecycleClosed: async () => { calls++; } });
    const active = makeDrainingEngine({ onLifecycleClosed: async () => { calls += 100; } });
    active.eng._getPositionState().lifecycle = 'active';
    await draining.eng._test.resetCycle();
    await active.eng._test.resetCycle();
    await tick(); await tick(); await tick();
    assert.equal(calls, 1);
    assert.equal(closeLabels().length, 0);
  });
});
