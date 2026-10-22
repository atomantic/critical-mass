// Issue #1604: the persistence cluster lives in regime-state-persistence.js.
// Pins the factory's contract in isolation; the engine-level behavior is
// covered by engine-persistence-resilience / sigusr1-reload-inflight tests.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createEngineStatePersistence, RELOADABLE_STATE_FIELDS } = require('../src/regime-state-persistence');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const make = (overrides = {}) => {
  const positionState = { realizedPnL: 999, realizedAssetPnL: 999, heldAssetCostBasis: 999, celestialState: {} };
  const derived = { realizedPnL: 12.5, realizedAssetPnL: 0.25, heldOpenBuyCostBasis: 80 };
  const flags = { mutating: false, ladderBusy: false };
  const deps = {
    exchange: 'coinbase', pair: '__test1604__', baseCurrency: 'BTC', fundLabel: 'coinbase/__test1604__',
    isDryRun: false, config: {}, logger: noopLogger,
    positionState, replacePositionState: () => {}, createInitialPositionState: () => ({}),
    fillLedger: { getDerivedRealizedPnL: () => derived, isDirty: () => false },
    tpOptimizer: {}, sizeOptimizer: {}, regimeDetector: {}, macroRegime: null,
    healthMonitor: {},
    engineLocks: { isMutatingPosition: () => flags.mutating, isLadderBusy: () => flags.ladderBusy, getFlags: () => ({}) },
    tpPlacementInFlight: new Set(), isExtendInFlight: () => false,
    getOrderExecutor: () => ({}),
    persistEpisodeState: () => {}, restoreEpisodeState: () => {},
    ...overrides,
  };
  return { api: createEngineStatePersistence(deps), positionState, derived, flags };
};

describe('createEngineStatePersistence (issue #1604)', () => {
  it('exposes the extracted persistence functions', () => {
    const { api } = make();
    for (const name of [
      'snapshotDryRunState', 'saveDryRunState', 'saveDryRunStateGuarded', 'loadDryRunState',
      'refreshRealizedFromCyclePairs', 'syncActiveCycleIdAfterRecalc', 'resyncLiveCycleCountersAfterRecalc',
      'saveLiveState', 'saveLiveStateGuarded', 'describeReloadBlocker', 'reloadStateFromDisk', 'loadLiveState',
    ]) assert.equal(typeof api[name], 'function', name);
    assert.deepEqual([...RELOADABLE_STATE_FIELDS], ['realizedPnL', 'realizedAssetPnL', 'celestialState']);
  });

  it('refreshRealizedFromCyclePairs assigns (never accumulates) the ledger-derived P&L', () => {
    const { api, positionState } = make();
    api.refreshRealizedFromCyclePairs();
    api.refreshRealizedFromCyclePairs();
    assert.equal(positionState.realizedPnL, 12.5);
    assert.equal(positionState.realizedAssetPnL, 0.25);
    assert.equal(positionState.heldAssetCostBasis, 80);
    assert.equal(positionState.celestialState.bodiesRealizedPnL, 12.5);
    assert.equal(positionState.celestialState.bodiesRealizedAssetPnL, 0.25);
  });

  it('describeReloadBlocker reports the first blocker in priority order, else null', () => {
    const tpPlacementInFlight = new Set();
    let extending = false;
    let dirty = false;
    const { api, flags } = make({
      tpPlacementInFlight, isExtendInFlight: () => extending,
      fillLedger: { getDerivedRealizedPnL: () => ({}), isDirty: () => dirty },
    });
    assert.equal(api.describeReloadBlocker(), null);
    dirty = true;
    assert.match(api.describeReloadBlocker(), /unsaved/);
    extending = true;
    assert.match(api.describeReloadBlocker(), /extend/);
    tpPlacementInFlight.add('x');
    assert.match(api.describeReloadBlocker(), /take-profit placement/);
    flags.ladderBusy = true;
    assert.match(api.describeReloadBlocker(), /ladder/);
    flags.mutating = true;
    assert.match(api.describeReloadBlocker(), /merge, reconcile, or fill/);
  });

  it('live save/load are no-ops for a dry-run fund, and dry-run save/load for a live fund', () => {
    const dry = make({ isDryRun: true }).api;
    assert.equal(dry.loadLiveState(), false);
    assert.equal(dry.saveLiveState(), undefined);
    const live = make().api;
    assert.equal(live.loadDryRunState(), false);
    assert.equal(live.saveDryRunState(), undefined);
  });

  it('syncActiveCycleIdAfterRecalc translates an existing marker through the rename map', () => {
    const { api, positionState } = make();
    positionState.activeCycleId = 'cycle-1';
    assert.equal(api.syncActiveCycleIdAfterRecalc({ idMap: { 'cycle-1': 'cycle-4' } }), true);
    assert.equal(positionState.activeCycleId, 'cycle-4');
    assert.equal(api.syncActiveCycleIdAfterRecalc({ idMap: {} }), false);
  });

  it('resyncLiveCycleCountersAfterRecalc does nothing without attributed orphans', () => {
    const { api } = make();
    assert.equal(api.resyncLiveCycleCountersAfterRecalc({ liveCycleOrphansAttributed: 0 }), false);
    assert.equal(api.resyncLiveCycleCountersAfterRecalc(undefined), false);
  });
});
