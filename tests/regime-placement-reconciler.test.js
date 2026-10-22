// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPlacementReconciler } = require('../src/regime-placement-reconciler');

const build = (overrides = {}) => createPlacementReconciler({
  exchange: 'coinbase', pair: 'BTC-USD', productId: 'BTC-USD', isDryRun: true,
  getPositionState: () => ({}), getOrderExecutor: () => ({}), getAdapter: () => ({}),
  fillLedger: {}, logger: { info() {}, warn() {}, error() {} }, saveLiveState() {},
  ...overrides,
});

describe('createPlacementReconciler', () => {
  it('exposes the four engine-facing functions', () => {
    const r = build();
    assert.deepEqual(Object.keys(r).sort(), [
      'blockingPlacementIntents', 'reconcilePendingPlacements', 'reconcilePlacementIntent', 'recoverPlacementIntent',
    ]);
  });

  it('dry-run funds never block and never reconcile', async () => {
    const r = build();
    assert.deepEqual(r.blockingPlacementIntents(), []);
    assert.equal(await r.reconcilePendingPlacements(), undefined);
  });

  it('rejects unknown operator actions before touching any state', async () => {
    const r = build();
    const res = await r.reconcilePlacementIntent('x', 'bogus');
    assert.equal(res.success, false);
    assert.match(res.error, /Unknown reconcile action 'bogus'/);
  });
});
