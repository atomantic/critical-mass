// @ts-check
//
// Regression coverage for issue #671: engine startup found a pending entry
// still OPEN on the exchange with filledSize > 0 (a restored saved entry, or
// an adopted orphan) and ingested its fills straight into the fill ledger,
// bumping the flat positionState totals and cycleBuys but creating no
// celestial body. When the order later filled completely, handleOrderFill's
// ingestFill deduped the startup rows and built the body from the new
// tranche alone — the startup tranche was never sold, and cycleBuys counted
// the order twice.
//
// The fix routes the partial through handleOrderFill (the standard
// pipeline), so the body is created at startup and the terminal fill
// advances it.
//
// Disk safety: throwaway pairs live under a disposable temp root, removed
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-startup-open-entry-partial-test');

// Neutralize the size optimizer's shared-config write BEFORE regime-engine
// is required (it destructures updateRegimeConfig at load).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// Stub the real WebSocket feed so start() never opens a network connection.
const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine } = require('../src/regime-engine');
const { createFillLedger } = require('../src/fill-ledger');

const engines = [];
after(async () => {
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

const ORDER_ID = 'entry-1';
const T1 = { tradeId: 'entry-1-t1', orderId: ORDER_ID, side: 'buy', size: 0.004, price: 50000, netFee: 0 };
const T2 = { tradeId: 'entry-1-t2', orderId: ORDER_ID, side: 'buy', size: 0.006, price: 50000, netFee: 0 };
const withTime = (f) => ({ ...f, tradeTime: new Date(Date.now() - 30000).toISOString() });

/** The resting entry as getOpenOrders reports it: 0.004 of 0.01 filled. */
const OPEN_PARTIAL = {
  orderId: ORDER_ID, side: 'BUY', status: 'OPEN', price: 50000, size: 0.01,
  filledSize: 0.004, filledValue: 200, averageFilledPrice: 50000,
  createdTime: new Date(Date.now() - 60000).toISOString(),
};

/**
 * @param {string} pair
 * @param {{ fills: Object[] }} fillSource - mutable: getOrderFills returns fillSource.fills
 * @param {Object} [openOrder] - the order getOpenOrders reports
 */
const makeEngine = (pair, fillSource, openOrder = OPEN_PARTIAL) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setAdapter({
    getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
    getCurrentPrice: async () => 50000,
    getOpenOrders: async () => [openOrder],
    getAccountBalance: async () => ({ available: 0, hold: 0 }),
    getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    getOrderFills: async () => fillSource.fills.map(withTime),
    cancelOrder: async () => ({ success: true }),
    loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
  });
  const restored = [];
  let tpSeq = 0;
  eng._test.setOrderExecutor({
    setPriceIncrement: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    restorePendingOrder: (orderId) => restored.push(orderId),
    markSettled: () => {},
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    handleOrderFill: () => {},
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: `tp-${++tpSeq}` }),
    removeBodyTracking: () => {},
    exportState: () => ({}),
    cancelAllEntries: async () => {},
    cancelAllLadderOrders: async () => {},
    cancelTpOrder: async () => ({ cancelled: true }),
    handleOrderCancel: () => {},
  });
  eng._test.setRecoveryModule({
    recoverState: async () => ({
      position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
      openOrders: new Map(),
      discrepancies: [],
    }),
  });
  engines.push(eng);
  return { eng, restored };
};

const bodiesFor = (pos) => (pos.celestialBodies || []).filter(b => (b.sourceOrderIds || []).includes(ORDER_ID));

/** Deliver the terminal fill (t1 + t2) the way the live poll/WS path does. */
const deliverFilled = async (eng, fillSource) => {
  fillSource.fills = [T1, T2];
  await eng._test.handleOrderFill({
    orderId: ORDER_ID, side: 'buy', status: 'FILLED',
    filledSize: 0.01, filledValue: 500, averageFilledPrice: 50000, isPartialFill: false,
  });
};

describe('startup booking of partially-filled open entries (issue #671)', () => {
  it('restored saved entry: startup tranche joins a body, and the terminal fill advances that same body', async () => {
    const fillSource = { fills: [T1] };
    const { eng, restored } = makeEngine('__teststartuppartial_a__', fillSource);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: ORDER_ID, price: 50000, assetQty: 0.01, sizeUsdc: 500, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);

    let p = eng._getPositionState();
    assert.ok(restored.includes(ORDER_ID), 'the open entry stays tracked by the executor');
    let bodies = bodiesFor(p);
    assert.equal(bodies.length, 1, 'startup must commit the filled tranche into a body');
    assert.equal(bodies[0].assetQty, 0.004);
    assert.equal(p.cycleBuys, 1);
    const tracked = (p.pendingEntryOrders || []).find(e => e.orderId === ORDER_ID);
    assert.ok(tracked, 'the still-open entry must remain in pendingEntryOrders');
    assert.ok(Math.abs(tracked.assetQty - 0.006) < 1e-9, `entry shrinks to its unfilled remainder (got ${tracked.assetQty})`);

    await deliverFilled(eng, fillSource);

    p = eng._getPositionState();
    bodies = bodiesFor(p);
    assert.equal(bodies.length, 1, 'exactly one body owns the order');
    assert.ok(Math.abs(bodies[0].assetQty - 0.01) < 1e-9, `body holds the full 0.01 (got ${bodies[0].assetQty})`);
    assert.equal(p.cycleBuys, 1, 'one order is one cycle buy');
    assert.equal((p.pendingEntryOrders || []).some(e => e.orderId === ORDER_ID), false, 'terminal fill retires the entry');
  });

  it('legacy ledger rows from the old startup ingest are adopted into the body without double-counting cycleBuys', async () => {
    const pair = '__teststartuppartial_b__';
    // Simulate the pre-fix startup path: t1 already in the ledger, no body.
    const seed = createFillLedger('coinbase', pair, pair, { quiet: true });
    seed.startNewCycle();
    seed.ingestFill(withTime(T1));
    seed.persist();

    const fillSource = { fills: [T1] };
    const { eng } = makeEngine(pair, fillSource);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: ORDER_ID, price: 50000, assetQty: 0.01, sizeUsdc: 500, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);
    let p = eng._getPositionState();
    assert.equal(bodiesFor(p).length, 1, 'the orphaned legacy tranche is committed into a body');
    assert.equal(p.cycleBuys, 1);

    await deliverFilled(eng, fillSource);

    p = eng._getPositionState();
    const bodies = bodiesFor(p);
    assert.equal(bodies.length, 1);
    assert.ok(Math.abs(bodies[0].assetQty - 0.01) < 1e-9, `body holds the full 0.01 (got ${bodies[0].assetQty})`);
    assert.equal(p.cycleBuys, 1);
  });

  it('legacy rows plus a tranche that filled after the old restart are booked together, and the order stays fully held', async () => {
    const pair = '__teststartuppartial_e__';
    const seed = createFillLedger('coinbase', pair, pair, { quiet: true });
    seed.startNewCycle();
    seed.ingestFill(withTime(T1));
    seed.persist();

    // Since the old restart the order advanced by 0.002 (T2A) and is still open.
    const T2A = { tradeId: 'entry-1-t2a', orderId: ORDER_ID, side: 'buy', size: 0.002, price: 50000, netFee: 0 };
    const T3 = { tradeId: 'entry-1-t3', orderId: ORDER_ID, side: 'buy', size: 0.004, price: 50000, netFee: 0 };
    const fillSource = { fills: [T1, T2A] };
    const { eng } = makeEngine(pair, fillSource, { ...OPEN_PARTIAL, filledSize: 0.006, filledValue: 300 });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: ORDER_ID, price: 50000, assetQty: 0.01, sizeUsdc: 500, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);
    let p = eng._getPositionState();
    const bodies = bodiesFor(p);
    assert.equal(bodies.length, 1);
    assert.ok(Math.abs(bodies[0].assetQty - 0.006) < 1e-9, `body holds legacy + new tranche (got ${bodies[0].assetQty})`);
    assert.equal(p.cycleBuys, 1);
    const tracked = (p.pendingEntryOrders || []).find(e => e.orderId === ORDER_ID);
    assert.ok(tracked && Math.abs(tracked.assetQty - 0.004) < 1e-9, `entry shrinks to 0.004 remainder (got ${tracked && tracked.assetQty})`);

    fillSource.fills = [T1, T2A, T3];
    await eng._test.handleOrderFill({
      orderId: ORDER_ID, side: 'buy', status: 'FILLED',
      filledSize: 0.01, filledValue: 500, averageFilledPrice: 50000, isPartialFill: false,
    });
    p = eng._getPositionState();
    // The terminal tranche may merge into that body or open its own (the
    // body's promotion moved its TP, so merge proximity decides) — either
    // way every unit of the order is held by a body.
    const held = bodiesFor(p).reduce((sum, b) => sum + b.assetQty, 0);
    assert.ok(Math.abs(held - 0.01) < 1e-9, `bodies hold the full 0.01 (got ${held})`);
    assert.equal(p.cycleBuys, 1);
  });

  it('a tranche whose body already sold is not rebooked; only trades the ledger lacks are', async () => {
    const pair = '__teststartuppartial_f__';
    // Live run: T1 was booked into a body, whose TP then sold it and closed
    // the body — while the entry kept resting.
    const seed = createFillLedger('coinbase', pair, pair, { quiet: true });
    seed.startNewCycle();
    seed.ingestFill(withTime(T1));
    seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-old', sellOrderId: 'tp-old' });
    seed.ingestFill(withTime({ tradeId: 'tp-old-t1', orderId: 'tp-old', side: 'sell', size: 0.004, price: 51000, netFee: 0 }));
    seed.persist();

    const T2A = { tradeId: 'entry-1-t2a', orderId: ORDER_ID, side: 'buy', size: 0.002, price: 50000, netFee: 0 };
    const fillSource = { fills: [T1, T2A] };
    const { eng } = makeEngine(pair, fillSource, { ...OPEN_PARTIAL, filledSize: 0.006, filledValue: 300 });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: ORDER_ID, price: 50000, assetQty: 0.006, sizeUsdc: 300, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);
    const p = eng._getPositionState();
    const held = bodiesFor(p).reduce((sum, b) => sum + b.assetQty, 0);
    assert.ok(Math.abs(held - 0.002) < 1e-9, `only the unsold new tranche is held (got ${held})`);
  });

  it('a settled tranche with nothing new since is left alone', async () => {
    const pair = '__teststartuppartial_g__';
    const seed = createFillLedger('coinbase', pair, pair, { quiet: true });
    seed.startNewCycle();
    seed.ingestFill(withTime(T1));
    seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-old', sellOrderId: 'tp-old' });
    seed.ingestFill(withTime({ tradeId: 'tp-old-t1', orderId: 'tp-old', side: 'sell', size: 0.004, price: 51000, netFee: 0 }));
    seed.persist();

    const fillSource = { fills: [T1] };
    const { eng } = makeEngine(pair, fillSource);
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: ORDER_ID, price: 50000, assetQty: 0.006, sizeUsdc: 300, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);
    const p = eng._getPositionState();
    assert.equal(bodiesFor(p).length, 0, 'no body is created for asset that was already sold');
    assert.ok((p.pendingEntryOrders || []).some(e => e.orderId === ORDER_ID), 'the resting entry stays tracked');
  });

  it('adopted orphan entry: persisted to pendingEntryOrders and its tranche booked into a body', async () => {
    const fillSource = { fills: [T1] };
    const { eng, restored } = makeEngine('__teststartuppartial_c__', fillSource);

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);

    let p = eng._getPositionState();
    assert.ok(restored.includes(ORDER_ID));
    const tracked = (p.pendingEntryOrders || []).find(e => e.orderId === ORDER_ID);
    assert.ok(tracked, 'the adopted orphan must be persisted so it survives the next restart');
    assert.ok(Math.abs(tracked.assetQty - 0.006) < 1e-9, `persisted at its unfilled remainder (got ${tracked.assetQty})`);
    assert.equal(bodiesFor(p).length, 1);
    assert.equal(bodiesFor(p)[0].assetQty, 0.004);

    await deliverFilled(eng, fillSource);

    p = eng._getPositionState();
    assert.ok(Math.abs(bodiesFor(p)[0].assetQty - 0.01) < 1e-9);
    assert.equal(p.cycleBuys, 1);
  });

  it('a failed booking does not abort startup and leaves the order tracked for the live path', async () => {
    const fillSource = { fills: [T1] };
    const { eng, restored } = makeEngine('__teststartuppartial_d__', fillSource);
    // placeBodyTpOrder rejecting is a throw inside handleOrderFill's commit.
    const exec = eng._test.getOrderExecutor();
    eng._test.setOrderExecutor({ ...exec, placeBodyTpOrder: async () => { throw new Error('tp placement down'); } });
    const pos = eng._getPositionState();
    pos.pendingEntryOrders = [{ orderId: ORDER_ID, price: 50000, assetQty: 0.01, sizeUsdc: 500, placedAt: Date.now() - 60000 }];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must still succeed: ${result.error}`);
    const p = eng._getPositionState();
    assert.ok(restored.includes(ORDER_ID));
    assert.ok((p.pendingEntryOrders || []).some(e => e.orderId === ORDER_ID), 'entry stays in pendingEntryOrders');
  });
});
