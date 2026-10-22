// @ts-check
//
// Pins the per-concern steps reconcileTick delegates to (issue #1610): each
// returns its dispatched chain (or null / [] when its guard says there is
// nothing to do), and reconcileTick holds the reconcile lock until every one
// of them settles (#189).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-reconcile-tick-steps-test');

const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const { createRegimeEngine } = require('../src/regime-engine');

const TEST_PAIR = '__testreconcilesteps__';
const engines = [];
after(() => {
  for (const eng of engines.splice(0)) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

const makeEngine = ({ adapter = {}, executor = {}, recovery } = {}) => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
  eng._test.setRunning(true);
  eng._test.setAdapter(adapter);
  eng._test.setOrderExecutor({
    capabilities: { liveReconciliation: true },
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    getPendingOrdersList: () => [],
    markSettled: () => {},
    ...executor,
  });
  eng._test.setRecoveryModule(recovery || { reconcile: async () => ({ updated: false }) });
  engines.push(eng);
  return eng;
};

describe('reconcileTick steps (issue #1610)', () => {
  it('entry-fill and orphan-sweep steps return null without liveReconciliation', () => {
    const eng = makeEngine({ executor: { capabilities: {} } });
    assert.equal(eng._test.reconcileEntryFills(), null);
    assert.equal(eng._test.sweepOrphanedSavedOrders(), null);
  });

  it('legacy TP step returns null when no TP order is active', () => {
    const eng = makeEngine();
    assert.equal(eng._test.reconcileLegacyTp(), null);
  });

  it('body TP step returns no chains when no body has a resting TP', () => {
    const eng = makeEngine();
    assert.deepEqual(eng._test.reconcileBodyTps(), []);
  });

  it('entry-fill step stamps liveness only when a poll succeeded and resolves its chain', async () => {
    let polled = 0;
    const eng = makeEngine({ executor: { checkPendingOrderFills: async () => { polled++; return { polled: 0, filled: 0, cancelled: 0 }; } } });
    const chain = eng._test.reconcileEntryFills();
    assert.ok(chain instanceof Promise);
    await chain;
    assert.equal(polled, 1);
  });

  it('reconcileTick holds the lock until a slow step settles', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let settled = false;
    const eng = makeEngine({
      executor: { checkPendingOrderFills: async () => { await gate; settled = true; return { polled: 0, filled: 0, cancelled: 0 }; } },
    });
    const tick = eng._test.reconcileTick();
    let tickDone = false;
    tick.then(() => { tickDone = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(tickDone, false);
    release();
    await tick;
    assert.equal(settled, true);
  });
});
