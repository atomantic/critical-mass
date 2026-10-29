// Issue #1601: the live startup-recovery sequence lives in
// regime-startup-recovery.js. Pins the factory's contract in isolation — phase
// order, the corrupt-state early return, call-time accessors, and the TP
// re-placement phases. Engine-level behavior stays covered by the startup,
// offline-fill-recovery and restart suites that drive engine.start().
//
// Disk safety: throwaway pair '__test1601__' -> data/coinbase/__test1601__/,
// deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');
const { createFundStateBackup, restoreFundStateBackup } = require('../src/backup-service');
const { createStartupRecovery } = require('../src/regime-startup-recovery');
const { createFillLedger } = require('../src/fill-ledger');
const { createInitialRegimePositionState } = require('../src/state-tracker');

const TEST_PAIR = '__test1601__';
const JUNK_DIR = path.join(require('../src/paths').DATA_DIR, 'coinbase', TEST_PAIR);
after(() => fs.rmSync(JUNK_DIR, { recursive: true, force: true }));

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const make = (overrides = {}, { adapter: adapterOver = {}, executor: executorOver = {} } = {}) => {
  const calls = [];
  const log = (name, value) => (...args) => { calls.push(name); return typeof value === 'function' ? value(...args) : value; };
  const positionState = createInitialRegimePositionState();
  const fillLedger = createFillLedger('coinbase', TEST_PAIR, TEST_PAIR);
  const replacePositionState = (next) => {
    for (const key of Object.keys(positionState)) delete positionState[key];
    Object.assign(positionState, next);
  };
  let adapter = {
    getOpenOrders: log('getOpenOrders', async () => []),
    getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    getCurrentPrice: log('getCurrentPrice', async () => 100),
    cancelOrder: async () => ({ success: false }),
    ...adapterOver,
  };
  const executor = {
    getPendingEntries: () => new Map(),
    getOrderPlacedAt: () => null,
    markSettled: () => {},
    removeBodyTracking: log('removeBodyTracking'),
    restorePendingOrder: () => {},
    restoreBodyTpOrder: () => {},
    ...executorOver,
  };
  const deps = {
    exchange: 'coinbase', pair: TEST_PAIR, productId: TEST_PAIR, baseCurrency: 'BTC',
    fundLabel: `coinbase/${TEST_PAIR}`, config: { celestialEnabled: true, tpMaxPercent: 5, tpMinPercent: 0.5 },
    logger: noopLogger,
    positionState, replacePositionState, createInitialPositionState: createInitialRegimePositionState,
    fillLedger,
    closedTrades: { load: log('closedTrades.load'), migrateFromFills: log('closedTrades.migrateFromFills') },
    pendingMergeTpOrders: new Map(), completedMergeTpOrders: new Map(),
    getAdapter: () => adapter,
    getOrderExecutor: () => executor,
    getRecoveryModule: () => ({
      recoverState: log('recoverState', async () => ({ position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0 } })),
    }),
    getPriceIncrement: () => 0.01,
    lookupOrNull: (label, subject, lookup) => lookup.catch(() => null),
    restoredEntryStaleMs: () => 60_000,
    calculateDynamicTpPercent: () => 1,
    handleOrderFill: log('handleOrderFill', async () => {}),
    knownTpCancelExecution: () => null,
    bookTpCancelExecution: log('bookTpCancelExecution', async () => {}),
    catchUpTerminalEntry: log('catchUpTerminalEntry', async () => ({ outcome: 'empty' })),
    cancelBodyTpForReplace: log('cancelBodyTpForReplace', async () => 'cancelled'),
    placeBodyTp: log('placeBodyTp', async () => {}),
    placeTakeProfitOrder: log('placeTakeProfitOrder', async () => {}),
    recoverUnbookedOwnedEntryTranches: log('recoverUnbookedOwnedEntryTranches', async () => 0),
    sealLegacyClosure: log('sealLegacyClosure', () => 0),
    loadLiveState: log('loadLiveState', () => true),
    saveLiveState: log('saveLiveState'),
    refreshRealizedFromCyclePairs: log('refreshRealizedFromCyclePairs'),
    syncActiveCycleIdAfterRecalc: log('syncActiveCycleIdAfterRecalc', () => false),
    resyncLiveCycleCountersAfterRecalc: log('resyncLiveCycleCountersAfterRecalc', () => false),
    ...overrides,
  };
  return { api: createStartupRecovery(deps), calls, positionState, executor, setAdapter: (v) => { adapter = v; } };
};

describe('createStartupRecovery (issue #1601)', () => {
  it('exposes restoreAll and checkOfflineOrderFills', () => {
    const { api } = make();
    assert.deepEqual(Object.keys(api).sort(), ['checkOfflineOrderFills', 'restoreAll']);
  });

  it('restoreAll runs the recovery phases in the original startImpl order and resolves null', async () => {
    const { api, calls } = make();
    assert.equal(await api.restoreAll(), null);
    assert.deepEqual(calls, [
      'loadLiveState',
      'recoverState',
      'recoverUnbookedOwnedEntryTranches',
      'sealLegacyClosure',
      'getOpenOrders', // offline-fill snapshot
      'getCurrentPrice',
      'getOpenOrders', // orphan-sell / entry-restore snapshot
      'closedTrades.load',
      'closedTrades.migrateFromFills',
      'syncActiveCycleIdAfterRecalc',
      'resyncLiveCycleCountersAfterRecalc',
      'saveLiveState',
    ]);
  });

  it('a corrupt saved state returns the structured start failure before touching the exchange', async () => {
    const { api, calls } = make({
      loadLiveState: () => { throw new Error('regime-state.json is corrupt'); },
    });
    assert.deepEqual(await api.restoreAll(), {
      success: false, error: 'regime-state.json is corrupt', needsOperator: true,
    });
    assert.deepEqual(calls, []);
  });

  it('resolves the adapter at call time, so a swapped adapter is the one queried', async () => {
    const { api, setAdapter, calls, positionState } = make();
    positionState.celestialBodies = [{ id: 'body-aaaaaaaa', tier: 'ASTEROID', assetQty: 0.01, tpOrderId: 'tp-dead-1', tpPrice: 101, assetOnOrder: 0.01, needsTpReprice: true }];
    setAdapter({
      getOpenOrders: async () => { calls.push('swapped.getOpenOrders'); return []; },
      getOrder: async () => ({ status: 'CANCELLED', filledSize: 0 }),
    });
    assert.deepEqual(await api.checkOfflineOrderFills(), { tpFilled: false, entriesFilled: 0 });
    assert.ok(calls.includes('swapped.getOpenOrders'));
    // Cancelled without partials: tracking cleared for re-placement.
    assert.ok(calls.includes('removeBodyTracking'));
    const [body] = positionState.celestialBodies;
    assert.equal(body.tpOrderId, null);
    assert.equal(body.tpPrice, 0);
    assert.equal(body.assetOnOrder, 0);
    assert.equal(body.needsTpReprice, false);
  });

  it('offline-filled body TPs route through the live handleOrderFill pipeline', async () => {
    const { api, calls, positionState } = make({}, {
      adapter: { getOrder: async () => ({ status: 'FILLED', filledSize: 0.01, filledValue: 1.02, averageFilledPrice: 102 }) },
    });
    positionState.celestialBodies = [{ id: 'body-bbbbbbbb', tier: 'ASTEROID', assetQty: 0.01, tpOrderId: 'tp-filled-1', tpPrice: 102 }];
    await api.checkOfflineOrderFills();
    assert.deepEqual(calls.filter(c => c === 'handleOrderFill'), ['handleOrderFill']);
  });

  it('a body left without a TP gets one placed during restoreAll', async () => {
    const { api, calls, positionState } = make({
      loadLiveState: () => {
        positionState.celestialBodies = [{ id: 'body-cccccccc', tier: 'ASTEROID', assetQty: 0.01, costBasis: 1, avgPrice: 100, tpOrderId: null, buyOrders: [] }];
        return true;
      },
    });
    await api.restoreAll();
    assert.ok(calls.indexOf('placeBodyTp') > calls.indexOf('closedTrades.migrateFromFills'));
    assert.ok(calls.indexOf('placeBodyTp') < calls.lastIndexOf('saveLiveState'));
  });
});

describe('restore-to-startup recovery-buy ownership (#1893)', () => {
  const OPEN_BUY = 'recovery-buy-open-1893';
  const openBuy = { orderId: OPEN_BUY, side: 'BUY', price: 90, size: 1, originalSize: 1, filledSize: 0, status: 'OPEN' };
  const runStartup = async () => {
    const cancelled = [];
    const { api } = make({}, { adapter: {
      getOpenOrders: async () => [openBuy],
      cancelOrder: async (id) => { cancelled.push(id); return { success: true }; },
    } });
    await api.restoreAll();
    return cancelled;
  };

  it('never cancels the recovery buy: unreadable snapshot metadata is refused, the valid destination record survives', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-1893-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
    const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
    write(paths.baseConfigFile, { exchanges: { coinbase: { pairs: { [TEST_PAIR]: {} } } } });
    const fund = path.join(paths.dataDir, 'coinbase', TEST_PAIR);
    write(path.join(fund, 'fill-ledger.json'), []);
    write(path.join(fund, 'regime-state.json'), {});
    write(path.join(fund, 'manual-trades.json'), 'null');
    // Hourly publication of the invalid sidecar is refused.
    assert.equal(createFundStateBackup({ paths, now: new Date('2026-10-03') }).success, false);
    // A transferred point whose sidecar became unreadable after publication.
    write(path.join(fund, 'manual-trades.json'), { trades: [] });
    const created = createFundStateBackup({ paths, now: new Date('2026-10-04') });
    assert.equal(created.success, true, created.error);
    write(path.join(paths.dataDir, 'backups', 'fund-state', created.snapshotId, 'coinbase', TEST_PAIR, 'manual-trades.json'), 'null');
    const validRecord = { trades: [{ id: 'mt-1', buyOrderId: OPEN_BUY, status: 'buy_pending' }] };
    write(path.join(fund, 'manual-trades.json'), validRecord);
    const restored = restoreFundStateBackup(created.snapshotId, 'coinbase', TEST_PAIR, { paths });
    assert.equal(restored.success, false);
    const survived = JSON.parse(fs.readFileSync(path.join(fund, 'manual-trades.json'), 'utf8'));
    assert.deepEqual(survived, validRecord);

    // Startup against the surviving destination record (valid-sidecar control).
    fs.mkdirSync(JUNK_DIR, { recursive: true });
    fs.writeFileSync(path.join(JUNK_DIR, 'manual-trades.json'), JSON.stringify(survived));
    assert.deepEqual(await runStartup(), []);
    fs.rmSync(path.join(JUNK_DIR, 'manual-trades.json'));
  });

  it('a valid corrective-buy sidecar spares its open buy at startup (control)', async () => {
    fs.mkdirSync(JUNK_DIR, { recursive: true });
    fs.writeFileSync(path.join(JUNK_DIR, 'pending-corrective-buys.json'), JSON.stringify([{ buyOrderId: OPEN_BUY, filled: false, cancelled: false }]));
    assert.deepEqual(await runStartup(), []);
    fs.rmSync(path.join(JUNK_DIR, 'pending-corrective-buys.json'));
  });

  it('keeps ownership from readable rows when a sibling row is unreadable', async () => {
    fs.mkdirSync(JUNK_DIR, { recursive: true });
    fs.writeFileSync(path.join(JUNK_DIR, 'manual-trades.json'), JSON.stringify({ trades: [{ id: 'mt-1', buyOrderId: OPEN_BUY, status: 'buy_pending' }, null] }));
    assert.deepEqual(await runStartup(), []);
    fs.writeFileSync(path.join(JUNK_DIR, 'manual-trades.json'), JSON.stringify({ trades: [{ id: 'mt-1', buyOrderId: OPEN_BUY, status: 'buy_pending' }] }));
    fs.writeFileSync(path.join(JUNK_DIR, 'pending-corrective-buys.json'), JSON.stringify([null, { buyOrderId: 'other', filled: false }]));
    assert.deepEqual(await runStartup(), []);
    fs.rmSync(path.join(JUNK_DIR, 'manual-trades.json'));
    fs.rmSync(path.join(JUNK_DIR, 'pending-corrective-buys.json'));
  });
});
