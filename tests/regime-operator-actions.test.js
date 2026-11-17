// @ts-check
// Issue #1978: the operator-triggered actions live in
// regime-operator-actions.js. Pins the factory's contract in isolation — the
// exposed surface, the lock / fence each action runs under, and the call-time
// accessors for the bindings the engine reassigns. Engine-level behavior stays
// covered by the merge, ladder, cycle-reset, import and recalc suites that
// drive a real engine.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createOperatorActions } = require('../src/regime-operator-actions');
const { createEngineLocks } = require('../src/engine-locks');
const { createInitialRegimePositionState } = require('../src/state-tracker');
const celestialHierarchy = require('../src/celestial-hierarchy');

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const body = (orderId, qty, price) => celestialHierarchy.createNewBody(
  { assetQty: qty, costBasis: qty * price, avgPrice: price }, orderId
);

const make = (overrides = {}) => {
  const calls = [];
  const locks = createEngineLocks({ logWarn() {} });
  // Real locks, recorded at the entry points the actions are expected to use.
  const engineLocks = {
    ...locks,
    withMergeLock: (fn) => { calls.push('withMergeLock'); return locks.withMergeLock(fn); },
    withLadderLock: (fn, opts) => { calls.push(['withLadderLock', opts]); return locks.withLadderLock(fn, opts); },
    withBackupFence: (fn) => { calls.push('withBackupFence'); return locks.withBackupFence(fn); },
  };
  const positionState = createInitialRegimePositionState();
  const replacePositionState = (next) => {
    for (const key of Object.keys(positionState)) delete positionState[key];
    return Object.assign(positionState, next);
  };
  const live = {
    isRunning: true,
    adapter: { getOrder: async () => ({ status: 'OPEN', filledSize: 0 }), getAccountBalance: async () => ({ available: '1000' }) },
    orderExecutor: {},
    marketState: { lastPrice: 100 },
    priceIncrement: 0.01,
    cycleResetGeneration: 0,
  };
  const deps = {
    exchange: 'coinbase', pair: 'BTC-USD', productId: 'BTC-USD', baseCurrency: 'BTC',
    fundLabel: 'coinbase/BTC-USD', config: { entryMode: 'ladder', maxUsdcDeployed: 500, baseSizeUsdc: 50 },
    logger: noopLogger, callbacks: {},
    positionState, replacePositionState,
    fillLedger: {}, riskManager: {}, ladderCalculator: {}, engineLocks,
    pendingMergeTpOrders: new Map(), dustWaitLoggedQty: new Map(),
    getIsRunning: () => live.isRunning,
    getAdapter: () => live.adapter,
    getOrderExecutor: () => live.orderExecutor,
    getMarketState: () => live.marketState,
    getPriceIncrement: () => live.priceIncrement,
    getCycleResetGeneration: () => live.cycleResetGeneration,
    lookupOrNull: (label, subject, lookup) => lookup.catch(() => null),
    captureEntryAdmission: () => () => true,
    getState: () => ({}), getStatus: () => ({}),
    handleOrderFillImpl: async () => {}, completeMergeSnapshot: () => {},
    cancelBodyTpForReplace: async () => 'cancelled',
    placeBodyTp: async () => true, placeBodyTpWithRetry: async () => true, placeTakeProfitOrder: async () => {},
    resetCycle: async () => {},
    getAllocatedCapital: () => 0,
    buildLadderFromMarket: () => ({ levels: [], lowerBound: 0, lowerBoundPct: 0, totalBudget: 0 }),
    abandonLadderPlacedAcrossReset: async () => false,
    saveLiveState: () => { calls.push('saveLiveState'); },
    refreshRealizedFromCyclePairs: () => {},
    syncActiveCycleIdAfterRecalc: () => false, resyncLiveCycleCountersAfterRecalc: () => false,
    ...overrides,
  };
  return { api: createOperatorActions(deps), calls, positionState, live };
};

describe('createOperatorActions (issue #1978)', () => {
  it('exposes the engine-facing actions', () => {
    const { api } = make();
    assert.deepEqual(Object.keys(api).sort(), [
      '_mergeBodyImpl', 'cancelLadder', 'extendBodiesFromRecoveredBuyRows', 'extendBody', 'injectBody',
      'isExtendInFlight', 'manualMergeBody', 'previewLadder', 'rebuildLadder', 'rebuildTP',
      'recalculateAndRefresh', 'resetCycleBuys', 'rollupAllBodies', 'setBodyTpPercent', 'setBodyTpPrice',
      'updatePosition',
    ]);
  });

  it('reads the running flag at call time and refuses every action on a stopped engine', async () => {
    const { api, live } = make();
    live.isRunning = false;
    const stopped = { success: false, message: 'Engine not running' };
    assert.deepEqual(await api._mergeBodyImpl('b'), stopped);
    assert.deepEqual(await api.manualMergeBody('b'), stopped);
    assert.deepEqual(await api.rollupAllBodies(), stopped);
    assert.deepEqual(await api.resetCycleBuys(), stopped);
    assert.deepEqual(await api.setBodyTpPercent('b', 2), stopped);
    assert.deepEqual(await api.rebuildTP(), stopped);
    assert.deepEqual(await api.previewLadder(), stopped);
    assert.deepEqual(await api.rebuildLadder(), stopped);
    assert.deepEqual(await api.cancelLadder(), stopped);
    assert.deepEqual(await api.injectBody(body('buy-1', 0.01, 100)), { success: false, error: 'Engine not running' });
    assert.deepEqual(await api.extendBody('b', { assetQty: 1, costBasis: 100, avgPrice: 100 }, 'buy-1'),
      { success: false, error: 'Engine not running' });
    live.isRunning = true;
    assert.deepEqual(await api.rebuildTP(), { success: false, message: 'No position to protect' });
  });

  it('runs each action under the lock or fence it used inside the engine', async () => {
    const { api, calls, live } = make();
    live.isRunning = false;
    await api.manualMergeBody('b');
    await api.rebuildLadder();
    await api.cancelLadder();
    await api.extendBody('b', { assetQty: 1, costBasis: 100, avgPrice: 100 }, 'buy-1');
    await api.rollupAllBodies(); // refused before it takes the merge lock
    assert.deepEqual(calls, [
      'withMergeLock',
      ['withLadderLock', { onTimeout: 'refuse', label: 'Ladder rebuild', exchange: 'coinbase' }],
      ['withLadderLock', { onTimeout: 'refuse', label: 'Ladder cancel', exchange: 'coinbase' }],
      'withBackupFence',
    ]);
  });

  it('Collapse All holds the merge lock once and each roll-up re-enters it through the swapped adapter', async () => {
    const { api, calls, positionState, live } = make();
    const low = { ...body('buy-1', 0.01, 100), tpOrderId: 'tp-low', tpPrice: 101 };
    const high = { ...body('buy-2', 0.01, 110), tpOrderId: 'tp-high', tpPrice: 112 };
    positionState.celestialBodies = [low, high];
    const looked = [];
    live.adapter = { getOrder: async (id) => { looked.push(id); return { status: 'OPEN', filledSize: 0.004 }; } };
    const res = await api.rollupAllBodies();
    assert.equal(res.success, false);
    assert.equal(res.mergedCount, 0);
    assert.match(res.message, /^Collapse aborted after 0 merges: Source body .* has a partially filled TP order \(0\.004 filled\) — cannot merge$/);
    assert.deepEqual(looked, ['tp-low']);
    assert.deepEqual(calls, ['withMergeLock', 'withMergeLock']);
    assert.equal(positionState.celestialBodies.length, 2);
  });

  it('previewLadder sizes against the current adapter, market state and price increment', async () => {
    const seen = [];
    const { api, live } = make({
      getAllocatedCapital: () => 100,
      buildLadderFromMarket: (...args) => {
        seen.push(args);
        return { levels: [{ price: 99, sizeUsdc: 50, assetQty: 0.5, distancePct: 1 }], lowerBound: 99, lowerBoundPct: 1, totalBudget: 50 };
      },
    });
    live.adapter = { getAccountBalance: async () => ({ available: '250' }) };
    live.marketState = { lastPrice: 123 };
    live.priceIncrement = 0.5;
    const res = await api.previewLadder();
    assert.equal(res.success, true);
    assert.deepEqual(seen, [[live.marketState, 250, 0.5, 100]]);
    assert.equal(res.preview.currentPrice, 123);
    assert.equal(res.preview.exchangeBalance, 250);
    assert.equal(res.preview.levelCount, 1);
  });

  it('extendBody holds one in-flight slot per body until the TP is re-placed', async () => {
    let releaseTp;
    const tpGate = new Promise((resolve) => { releaseTp = resolve; });
    const { api, positionState } = make({ placeBodyTpWithRetry: () => tpGate });
    const grown = body('buy-1', 0.01, 100);
    positionState.celestialBodies = [grown];
    const totals = { assetQty: 0.03, costBasis: 3, avgPrice: 100 };
    assert.equal(api.isExtendInFlight(), false);
    const first = api.extendBody(grown.id, totals, 'buy-1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(api.isExtendInFlight(), true);
    assert.deepEqual(await api.extendBody(grown.id, totals, 'buy-1'),
      { success: false, error: 'Extend already in progress for this body — retry once it settles' });
    releaseTp(true);
    assert.deepEqual(await first, { success: true, bodyId: grown.id, tier: grown.tier, tpPlaced: true });
    assert.equal(api.isExtendInFlight(), false);
    assert.equal(grown.assetQty, 0.03);
    // The same totals again are already recorded on the body: nothing is re-added.
    assert.equal((await api.extendBody(grown.id, totals, 'buy-1')).alreadyApplied, true);
    assert.equal(grown.assetQty, 0.03);
  });

  it('updatePosition replaces the shared position object in place and saves it', () => {
    const { api, calls, positionState } = make();
    positionState.cycleBuys = 1;
    api.updatePosition({ cycleBuys: 4, cyclesCompleted: 2 });
    assert.equal(positionState.cycleBuys, 4);
    assert.equal(positionState.cyclesCompleted, 2);
    assert.deepEqual(calls, ['saveLiveState']);
  });
});
