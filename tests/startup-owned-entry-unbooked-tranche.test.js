// @ts-check
//
// Upgrade-scenario coverage for issue #756: a fund upgrading from a pre-#671
// engine can hold an entry order whose tranches are split between a live
// body and the fill ledger alone.
//
// The live run booked tranche t1 into body B. A pre-#671 restart then found
// the entry still open and ingested its offline tranche t2 straight into the
// ledger, without booking it into any body (and without shrinking the
// persisted entry). On the next boot, annotation repair stamps B onto every
// row of the order (t2 included), and handleOrderFill sees only duplicate
// rows of an order a body owns, so it skips — t2 is in no body and no TP
// covers it.
//
// Each case writes that pre-#671 state to disk (fill-ledger.json +
// regime-state.json) and boots the real engine on it.
//
// Disk safety: throwaway pairs live under a disposable temp root, removed
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-startup-owned-entry-unbooked-test');

// Neutralize the size optimizer's shared-config write BEFORE regime-engine
// is required (it destructures updateRegimeConfig at load).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// Stub the real WebSocket feed so start() never opens a network connection.
const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine, measureUnbookedOrderQty } = require('../src/regime-engine');
const { createFillLedger } = require('../src/fill-ledger');
const { saveRegimeState, loadRegimeState } = require('../src/state-tracker');
const { tradeEvents } = require('../src/trade-events');
const { createRecoveryModule } = require('../src/recovery');
const { createClosedTrades } = require('../src/closed-trades');

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

const EXCHANGE = 'coinbase';
const ORDER_ID = 'entry-756';
const BODY_TP = 'tp-body-b';
const PRICE = 50000;
const near = (a, b) => Math.abs(a - b) < 1e-9;

const buyRow = (tradeId, size, ageMs) => ({
  tradeId, orderId: ORDER_ID, side: 'buy', size, price: PRICE, netFee: 0,
  tradeTime: new Date(Date.now() - ageMs).toISOString(),
});
const T1 = buyRow('entry-756-t1', 0.004, 50000);
const T2 = buyRow('entry-756-t2', 0.006, 40000);
const T3 = buyRow('entry-756-t3', 0.01, 20000);

/**
 * Body B as a pre-#607 engine persisted it: one tranche of the entry order,
 * no consumedQty, a resting TP.
 * @param {number} qty
 * @param {Object} [extra]
 */
const legacyBody = (qty, extra = {}) => ({
  id: 'body-b-756',
  tier: 'satellite',
  assetQty: qty,
  costBasis: qty * PRICE,
  avgPrice: PRICE,
  tpOrderId: BODY_TP,
  tpPrice: 51000,
  assetOnOrder: qty,
  createdAt: Date.now() - 45000,
  lastMergedAt: Date.now() - 45000,
  sourceOrderIds: [ORDER_ID],
  buyOrders: [{ orderId: ORDER_ID, price: PRICE, assetQty: qty, sizeUsdc: qty * PRICE, filledAt: Date.now() - 45000 }],
  mergeCount: 0,
  ...extra,
});

/**
 * Write a pre-#671 fund to disk: the ledger rows, then regime-state.json with
 * the given bodies and the persisted pending entry.
 * @param {string} pair
 * @param {{ ledger: (seed: ReturnType<typeof createFillLedger>) => void, bodies: Object[], entry: Object }} spec
 */
const writePreFixFund = (pair, { ledger, bodies, entry, rung = null }) => {
  const seed = createFillLedger(EXCHANGE, pair, pair, { quiet: true });
  seed.startNewCycle();
  ledger(seed);
  seed.persist();
  const totalAsset = bodies.reduce((sum, b) => sum + b.assetQty, 0);
  const totalCostBasis = bodies.reduce((sum, b) => sum + b.costBasis, 0);
  saveRegimeState({
    totalAsset,
    totalCostBasis,
    avgCostBasis: totalAsset > 0 ? totalCostBasis / totalAsset : 0,
    assetOnOrder: bodies.reduce((sum, b) => sum + b.assetOnOrder, 0),
    cycleBuys: 1,
    cyclesCompleted: 0,
    realizedPnL: 0,
    realizedAssetPnL: 0,
    lastEntryPrice: PRICE,
    lastEntryTime: Date.now() - 45000,
    activeCycleId: seed.getCurrentCycleId(),
    celestialBodies: bodies,
    pendingEntryOrders: entry ? [entry] : [],
    ...(rung && { ladderActive: true, pendingLadderOrders: [rung] }),
  }, null, EXCHANGE, null, null, pair);
};

/**
 * Boot the real engine on the on-disk fund, with a stub exchange.
 * @param {string} pair
 * @param {{ openOrders: Object[], orders: Object<string, Object>, fills: Object[] }} exchange
 *   `orders` answers getOrder by id (anything else reads as a resting TP).
 */
const bootEngine = async (pair, exchange, { realRecovery = false } = {}) => {
  const eng = createRegimeEngine(EXCHANGE, pair, { dryRun: false, productId: pair }, {});
  const adapter = {
    getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
    getCurrentPrice: async () => PRICE,
    getOpenOrders: async () => exchange.openOrders,
    getAccountBalance: async () => ({ available: 0, hold: 0 }),
    getOrder: async (id) => exchange.orders[id] || { orderId: id, status: 'OPEN', filledSize: 0 },
    getOrderFills: async (id) => exchange.fills.filter(f => f.orderId === id),
    cancelOrder: async () => ({ success: true }),
    loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
  };
  eng._test.setAdapter(adapter);
  const placedTps = [];
  let tpSeq = 0;
  eng._test.setOrderExecutor({
    setPriceIncrement: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    restorePendingOrder: () => {},
    restoreBodyTpOrder: () => {},
    markSettled: () => {},
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    handleOrderFill: () => {},
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    getPendingEntries: () => [],
    placeBodyTpOrder: async (qty, price, bodyId) => {
      const orderId = `tp-new-${++tpSeq}`;
      placedTps.push({ bodyId, qty, orderId });
      return { success: true, orderId };
    },
    removeBodyTracking: () => {},
    exportState: () => ({}),
    cancelAllEntries: async () => {},
    cancelAllLadderOrders: async () => {},
    cancelTpOrder: async () => ({ cancelled: true }),
    handleOrderCancel: () => {},
  });
  // The real recovery module ingests every open order's fills into the
  // ledger at boot without booking them — as production does.
  eng._test.setRecoveryModule(realRecovery ? createRecoveryModule(EXCHANGE, adapter, pair) : {
    recoverState: async () => ({
      position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
      openOrders: new Map(),
      discrepancies: [],
    }),
  });
  engines.push(eng);
  const result = await eng.start();
  assert.equal(result.success, true, `start() must succeed: ${result.error}`);
  return { eng, placedTps };
};

/** Stop a booted engine so the next boot reads what it persisted. */
const shutdown = async (eng) => {
  await eng.stop();
  eng._test.clearTimers();
};

const heldBy = (pos) => (pos.celestialBodies || [])
  .filter(b => (b.buyOrders || []).some(bo => bo.orderId === ORDER_ID))
  .reduce((sum, b) => sum + b.assetQty, 0);
/** Quantity of the order the bodies' tranches record. */
const bookedQty = (pos) => (pos.celestialBodies || [])
  .flatMap(b => b.buyOrders || [])
  .filter(bo => bo.orderId === ORDER_ID)
  .reduce((sum, bo) => sum + bo.assetQty, 0);
const entryOf = (pos) => (pos.pendingEntryOrders || []).find(e => e.orderId === ORDER_ID);

/** The entry still resting: placed 0.02, t1 + t2 = 0.01 filled. */
const OPEN_ENTRY = {
  orderId: ORDER_ID, side: 'BUY', status: 'OPEN', price: PRICE, size: 0.01, originalSize: 0.02,
  filledSize: 0.01, filledValue: 500, averageFilledPrice: PRICE,
  createdTime: new Date(Date.now() - 60000).toISOString(),
};

/**
 * The common pre-#671 fund: B booked t1 (the live path shrank the entry to
 * 0.016); the old restart ingested t2 into the ledger alone.
 * @param {string} pair
 * @param {Object} [opts]
 */
const writeSplitFund = (pair, { bodyExtra = {}, ledgerExtra = () => {}, t1Annotation = { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP } } = {}) => {
  writePreFixFund(pair, {
    ledger: (seed) => {
      seed.ingestFill(T1, Date.now() - 60000);
      seed.annotateFillsByOrderId(ORDER_ID, t1Annotation);
      seed.ingestFill(T2); // pre-#671 startup ingest: no placedAt, no body
      ledgerExtra(seed);
    },
    bodies: [legacyBody(0.004, bodyExtra)],
    entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.016, sizeUsdc: 800, placedAt: Date.now() - 60000 },
  });
};

describe('measureUnbookedOrderQty (issue #756)', () => {
  it('reads ledger quantity beyond live tranches and recorded consumption', () => {
    const bodies = [legacyBody(0.004)];
    assert.ok(near(measureUnbookedOrderQty(bodies, ORDER_ID, { size: 0.01 }).shortfall, 0.006));
    // A #607 record of a gone body's sale explains that much of the gap.
    const withRecord = measureUnbookedOrderQty(bodies, ORDER_ID, { size: 0.01, consumedQty: 0.002 });
    assert.ok(near(withRecord.shortfall, 0.004));
    // Consumption the live tranche itself recorded explains nothing extra.
    const own = [legacyBody(0.004, { buyOrders: [{ orderId: ORDER_ID, assetQty: 0.004, consumedQty: 0.002 }] })];
    assert.ok(near(measureUnbookedOrderQty(own, ORDER_ID, { size: 0.01, consumedQty: 0.002 }).shortfall, 0.006));
  });

  it('flags an order a body references without a tranche quantity as unmeasurable', () => {
    const bodies = [legacyBody(0.004, { buyOrders: [] })];
    const m = measureUnbookedOrderQty(bodies, ORDER_ID, { size: 0.01 });
    assert.equal(m.owned, true);
    assert.equal(m.measurable, false);
  });
});

describe('startup recovery of an unbooked tranche of a body-owned entry (issue #756)', () => {
  it('books the ledger-only tranche into its own body, shrinks the entry, and is idempotent across restarts', async () => {
    const pair = '__teststartupowned756_a__';
    writeSplitFund(pair);
    const exchange = { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] };

    const { eng, placedTps } = await bootEngine(pair, exchange);
    let pos = eng._getPositionState();
    assert.ok(near(heldBy(pos), 0.01), `bodies hold t1 + t2 (got ${heldBy(pos)})`);
    const recovered = pos.celestialBodies.find(b => b.id !== 'body-b-756');
    assert.ok(recovered, 'the unbooked tranche becomes a body');
    assert.ok(near(recovered.assetQty, 0.006));
    assert.ok(near(recovered.costBasis, 300));
    assert.equal(recovered.buyOrders[0].consumedQty, 0, 'the recovered tranche is tracked per #607');
    assert.ok(placedTps.some(t => t.bodyId === recovered.id), 'the recovered body gets its own TP');
    assert.equal(pos.cycleBuys, 1, 'one order is still one cycle buy');
    assert.ok(near(entryOf(pos).assetQty, 0.01), `entry shrinks to the exchange remainder (got ${entryOf(pos).assetQty})`);
    assert.ok(near(entryOf(pos).sizeUsdc, 500));
    const pnl = eng.getFillLedger().computeRealizedFromCyclePairs();
    assert.ok(near(pnl.heldOpenAssetQty, 0.01), `ledger holds the whole order open (got ${pnl.heldOpenAssetQty})`);
    assert.equal(pos.realizedPnL, 0);

    // What was persisted is what the next boot reads.
    const disk = loadRegimeState(EXCHANGE, pair).position;
    assert.ok(near(heldBy(disk), 0.01));
    assert.ok(near(entryOf(disk).assetQty, 0.01));

    await shutdown(eng);
    const second = await bootEngine(pair, exchange);
    pos = second.eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 2, 'a restart books nothing again');
    assert.ok(near(heldBy(pos), 0.01));
    assert.ok(near(entryOf(pos).assetQty, 0.01));

    // The rest of the order fills: every unit ends up held by a body.
    exchange.fills = [T1, T2, T3];
    await second.eng._test.handleOrderFill({
      orderId: ORDER_ID, side: 'buy', status: 'FILLED',
      filledSize: 0.02, filledValue: 1000, averageFilledPrice: PRICE, isPartialFill: false,
    });
    pos = second.eng._getPositionState();
    assert.ok(near(heldBy(pos), 0.02), `bodies hold the full 0.02 (got ${heldBy(pos)})`);
    assert.equal(entryOf(pos), undefined, 'the terminal fill retires the entry');
    assert.equal(pos.cycleBuys, 1);
  });

  it('recovers the tranche when the entry filled completely while the engine was down', async () => {
    const pair = '__teststartupowned756_b__';
    writeSplitFund(pair);
    const exchange = {
      openOrders: [],
      orders: { [ORDER_ID]: { orderId: ORDER_ID, status: 'FILLED', filledSize: 0.02, filledValue: 1000, averageFilledPrice: PRICE } },
      fills: [T1, T2, T3],
    };
    const { eng } = await bootEngine(pair, exchange);
    const pos = eng._getPositionState();
    assert.ok(near(heldBy(pos), 0.02), `bodies hold all three tranches (got ${heldBy(pos)})`);
    assert.equal(entryOf(pos), undefined, 'the terminal entry is retired');
    assert.equal(pos.cycleBuys, 1);
  });

  it('seals the order\'s earlier partial sale without swallowing the recovered tranche', async () => {
    const pair = '__teststartupowned756_c__';
    // B's first TP sold 0.001 of t1 (a pre-#607 partial fill: the sold
    // fraction is stamped on the order, and its link still names that TP),
    // so the #607 seal runs for this order on this boot.
    writeSplitFund(pair, {
      bodyExtra: { assetQty: 0.003, costBasis: 150, assetOnOrder: 0.003 },
      t1Annotation: { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: 'tp-body-b-old', consumedCostFraction: 0.25 },
      ledgerExtra: (seed) => {
        seed.ingestFill({ tradeId: 'tp-old-p1', orderId: 'tp-body-b-old', side: 'sell', size: 0.001, price: 51000, netFee: 0, tradeTime: new Date(Date.now() - 45000).toISOString() });
        seed.annotateFillsByOrderId('tp-body-b-old', { isBodyOwned: true, bodyId: 'body-b-756', bodyPnl: 1, bodyHoldbackAsset: 0, partialFill: true });
      },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    const consumption = eng.getFillLedger().getBuyOrderConsumption(ORDER_ID);
    assert.ok(consumption.consumedBy, 'the order was sealed');
    assert.ok(near(consumption.consumedQty, 0.001), `only the sold 0.001 is consumed (got ${consumption.consumedQty})`);
    assert.ok(near(heldBy(eng._getPositionState()), 0.009), 'bodies hold the unsold 0.003 of t1 plus t2');
  });

  it('does not rebook a tranche a closed body already sold', async () => {
    const pair = '__teststartupowned756_d__';
    // t1 went to a body that sold it and closed (pre-#607: no record of
    // that); t3 filled later and is held by live body B. Nothing is
    // unbooked, though the bodies alone show 0.004 of ledger not held.
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.ingestFill({ tradeId: 'tp-gone-1', orderId: 'tp-gone', side: 'sell', size: 0.004, price: 51000, netFee: 0, tradeTime: new Date(Date.now() - 30000).toISOString() });
        seed.annotateFillsByOrderId('tp-gone', { isBodyOwned: true, bodyId: 'body-gone', bodyPnl: 4, bodyHoldbackAsset: 0 });
        seed.ingestFill(buyRow('entry-756-t3', 0.006, 20000), Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
      },
      bodies: [legacyBody(0.006)],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.01, sizeUsdc: 500, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, {
      openOrders: [OPEN_ENTRY],
      orders: {},
      fills: [T1, buyRow('entry-756-t3', 0.006, 20000)],
    });
    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 1, 'no body is created for asset that was sold');
    assert.ok(near(heldBy(pos), 0.006));
    assert.ok(near(entryOf(pos).assetQty, 0.01), 'the entry is untouched');
  });

  it('leaves the gap alone when the entry\'s own tracking cannot confirm it', async () => {
    const pair = '__teststartupowned756_e__';
    // The entry was never shrunk for t1 (a body commit that threw before the
    // shrink), so it cannot prove what the live path booked.
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
        seed.ingestFill(T2);
      },
      bodies: [legacyBody(0.004)],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.02, sizeUsdc: 1000, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 1, 'nothing is booked on unproven evidence');
    assert.ok(near(heldBy(pos), 0.004));
  });

  it('leaves the gap alone when a terminal entry\'s placed size is unknown', async () => {
    const pair = '__teststartupowned756_f__';
    writeSplitFund(pair);
    const { eng } = await bootEngine(pair, {
      openOrders: [],
      orders: { [ORDER_ID]: { orderId: ORDER_ID, status: 'CANCELLED', filledSize: 0.01, filledValue: 500, averageFilledPrice: PRICE } },
      fills: [T1, T2],
    });
    assert.ok(near(heldBy(eng._getPositionState()), 0.004), 'a cancelled order with no placed size is not guessed at');
  });
});

describe('the #607 seal and an unowned entry\'s ledger-only rows (issue #756)', () => {
  it('counts rows the old startup ingest left unbooked as open, not as sold', async () => {
    const pair = '__teststartupowned756_g__';
    // t1's body sold it and closed; the old restart then ingested t2 alone.
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-gone', sellOrderId: 'tp-gone' });
        seed.ingestFill({ tradeId: 'tp-gone-1', orderId: 'tp-gone', side: 'sell', size: 0.004, price: 51000, netFee: 0, tradeTime: new Date(Date.now() - 45000).toISOString() });
        seed.annotateFillsByOrderId('tp-gone', { isBodyOwned: true, bodyId: 'body-gone', bodyPnl: 4, bodyHoldbackAsset: 0 });
        seed.ingestFill(T2);
      },
      bodies: [legacyBody(0.001, { id: 'body-other', sourceOrderIds: ['other-buy'], buyOrders: [{ orderId: 'other-buy', price: PRICE, assetQty: 0.001, sizeUsdc: 50, filledAt: Date.now() }] })],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.016, sizeUsdc: 800, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    const consumption = eng.getFillLedger().getBuyOrderConsumption(ORDER_ID);
    assert.ok(consumption.consumedBy, 'the order was sealed');
    assert.ok(near(consumption.consumedQty, 0.004), `only the sold t1 is consumed (got ${consumption.consumedQty})`);
    const booked = (eng._getPositionState().celestialBodies || [])
      .flatMap(b => b.buyOrders || [])
      .filter(bo => bo.orderId === ORDER_ID)
      .reduce((sum, bo) => sum + bo.assetQty, 0);
    assert.ok(near(booked, 0.006), `t2 is booked into a body (got ${booked})`);
  });
});

describe('a startup booking that throws after committing (issue #756)', () => {
  it('shrinks the entry by exactly the tranche it committed', async () => {
    const pair = '__teststartupowned756_h__';
    // No body owns the order; the old restart left t1 in the ledger alone.
    writePreFixFund(pair, {
      ledger: (seed) => { seed.ingestFill(T1); },
      bodies: [],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.02, sizeUsdc: 1000, placedAt: Date.now() - 60000 },
    });
    const T2A = buyRow('entry-756-t2a', 0.002, 30000);
    // Fail the first booking right after its body is committed.
    const originalEmit = tradeEvents.emitTradeEvent;
    let failed = false;
    tradeEvents.emitTradeEvent = function (type, ...rest) {
      if (type === 'buy_filled' && !failed) { failed = true; throw new Error('event bus down'); }
      return originalEmit.call(this, type, ...rest);
    };
    let eng;
    try {
      ({ eng } = await bootEngine(pair, {
        openOrders: [{ ...OPEN_ENTRY, size: 0.014, filledSize: 0.006, filledValue: 300 }],
        orders: {},
        fills: [T1, T2A],
      }));
    } finally {
      tradeEvents.emitTradeEvent = originalEmit;
    }
    assert.equal(failed, true, 'the booking failed after its commit');
    const pos = eng._getPositionState();
    const booked = (pos.celestialBodies || [])
      .flatMap(b => b.buyOrders || [])
      .filter(bo => bo.orderId === ORDER_ID)
      .reduce((sum, bo) => sum + bo.assetQty, 0);
    // The legacy tranche's body was committed before the pass threw; the
    // newer 0.002 was never booked and stays in the tracked remainder.
    assert.ok(near(booked, 0.004), `the legacy tranche is in a body (got ${booked})`);
    assert.ok(near(entryOf(pos).assetQty, 0.016), `entry shrinks by the committed 0.004 only (got ${entryOf(pos).assetQty})`);
    assert.ok(near(entryOf(pos).sizeUsdc, 800));
  });
});

describe('offline tranches the boot-time recovery ingests (issue #756)', () => {
  it('a tranche that filled while a current engine was down is booked on restart', async () => {
    const pair = '__teststartupowned756_i__';
    // Current-engine state: the live path booked t1 and shrank the entry.
    // While stopped, t2 filled; the recovery module ingests it at boot
    // before the entry is booked, so the booking pass sees only duplicates.
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
      },
      bodies: [legacyBody(0.004, { buyOrders: [{ orderId: ORDER_ID, price: PRICE, assetQty: 0.004, sizeUsdc: 200, filledAt: Date.now() - 45000, consumedQty: 0 }] })],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.016, sizeUsdc: 800, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] }, { realRecovery: true });
    const pos = eng._getPositionState();
    assert.ok(near(heldBy(pos), 0.01), `bodies hold t1 + t2 (got ${heldBy(pos)})`);
    assert.ok(near(entryOf(pos).assetQty, 0.01));
  });

  it('a first tranche adopted by the orphan-buy recovery shrinks the entry, so the next offline tranche is provable', async () => {
    const pair = '__teststartupowned756_j__';
    // A body for another order gives the orphan recovery a merge target.
    const other = legacyBody(0.004, {
      id: 'body-other-756', tpOrderId: 'tp-other', sourceOrderIds: ['other-buy'],
      buyOrders: [{ orderId: 'other-buy', price: PRICE, assetQty: 0.004, sizeUsdc: 200, filledAt: Date.now() - 45000 }],
    });
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill({ ...T1, orderId: 'other-buy', tradeId: 'other-buy-t1' }, Date.now() - 60000);
        seed.annotateFillsByOrderId('other-buy', { isBodyOwned: true, bodyId: 'body-other-756', sellOrderId: 'tp-other' });
      },
      bodies: [other],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.02, sizeUsdc: 1000, placedAt: Date.now() - 60000 },
    });
    // Boot 1: t1 filled while stopped.
    const exchange = { openOrders: [{ ...OPEN_ENTRY, size: 0.016, filledSize: 0.004, filledValue: 200 }], orders: {}, fills: [T1] };
    const first = await bootEngine(pair, exchange, { realRecovery: true });
    let pos = first.eng._getPositionState();
    assert.ok(near(bookedQty(pos), 0.004), `t1 is booked (got ${bookedQty(pos)})`);
    assert.ok(near(entryOf(pos).assetQty, 0.016), `entry shrinks by t1 (got ${entryOf(pos).assetQty})`);
    await shutdown(first.eng);

    // Boot 2: t2 filled while stopped.
    exchange.openOrders = [OPEN_ENTRY];
    exchange.fills = [T1, T2];
    const second = await bootEngine(pair, exchange, { realRecovery: true });
    pos = second.eng._getPositionState();
    assert.ok(near(bookedQty(pos), 0.01), `t1 + t2 are booked (got ${bookedQty(pos)})`);
    assert.ok(near(entryOf(pos).assetQty, 0.01));
  });

  it('never books for an unowned entry whose every row a gone body stamped', async () => {
    const pair = '__teststartupowned756_k__';
    // B held t1 and was stamped onto t2 as well, then sold and closed.
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.ingestFill(T2);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-gone', sellOrderId: 'tp-gone' });
        seed.ingestFill({ tradeId: 'tp-gone-1', orderId: 'tp-gone', side: 'sell', size: 0.004, price: 51000, netFee: 0, tradeTime: new Date(Date.now() - 30000).toISOString() });
        seed.annotateFillsByOrderId('tp-gone', { isBodyOwned: true, bodyId: 'body-gone', bodyPnl: 4, bodyHoldbackAsset: 0 });
      },
      bodies: [legacyBody(0.001, { id: 'body-other', tpOrderId: 'tp-other', sourceOrderIds: ['other-buy'], buyOrders: [{ orderId: 'other-buy', price: PRICE, assetQty: 0.001, sizeUsdc: 50, filledAt: Date.now() }] })],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.016, sizeUsdc: 800, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    const pos = eng._getPositionState();
    const booked = pos.celestialBodies.flatMap(b => b.buyOrders || []).filter(bo => bo.orderId === ORDER_ID).length;
    assert.equal(booked, 0, 'reported for manual review, never booked');
  });
});

describe('a closed body that may have held part of the order (issue #756)', () => {
  /** A closed body's sale after the entry started filling. */
  const goneSale = (seed) => {
    seed.ingestFill({ tradeId: 'tp-gone-1', orderId: 'tp-gone', side: 'sell', size: 0.004, price: 51000, netFee: 0, tradeTime: new Date(Date.now() - 42000).toISOString() });
    seed.annotateFillsByOrderId('tp-gone', { isBodyOwned: true, bodyId: 'body-gone', bodyPnl: 4, bodyHoldbackAsset: 0 });
  };

  it('books nothing when a gone body\'s sale is not proven to exclude the order', async () => {
    const pair = '__teststartupowned756_l__';
    // t1 went to a body that sold and closed while the entry was never shrunk
    // for it; t2 is held by B, and the entry shrank for t2 only. Both
    // measures read t1 as missing — it was sold.
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        goneSale(seed);
        seed.ingestFill(T2, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
      },
      bodies: [legacyBody(0.006)],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.014, sizeUsdc: 700, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    const pos = eng._getPositionState();
    assert.equal(pos.celestialBodies.length, 1, 'the sold tranche is not rebooked');
    assert.ok(near(bookedQty(pos), 0.006));
  });

  it('still books when the gone body\'s closed-trade record lists other buys only', async () => {
    const pair = '__teststartupowned756_m__';
    writeSplitFund(pair, { ledgerExtra: goneSale });
    const trades = createClosedTrades(EXCHANGE, pair);
    trades.record({ sellOrderId: 'tp-gone', timestamp: Date.now() - 42000, qtySold: 0.004, bodyId: 'body-gone', buyOrderIds: ['other-buy'], source: 'live' });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    assert.ok(near(bookedQty(eng._getPositionState()), 0.01), 'the unbooked t2 is recovered');
  });
});

describe('a ladder rung a live body owns (issue #756)', () => {
  it('books the rung\'s ledger-only tranche and shrinks the rung', async () => {
    const pair = '__teststartupowned756_n__';
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
        seed.ingestFill(T2);
      },
      bodies: [legacyBody(0.004)],
      entry: null,
      rung: { orderId: ORDER_ID, ladderIndex: 0, price: PRICE, assetQty: 0.016, sizeUsdc: 800, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    const pos = eng._getPositionState();
    assert.ok(near(bookedQty(pos), 0.01), `t1 + t2 are booked (got ${bookedQty(pos)})`);
    const rung = (pos.pendingLadderOrders || []).find(o => o.orderId === ORDER_ID);
    assert.ok(rung && near(rung.assetQty, 0.01), `the rung shrinks to its remainder (got ${rung && rung.assetQty})`);
  });
});

describe('codex review coverage (issue #756)', () => {
  it('a gone body\'s sale known only by its closed-trade record still blocks booking', async () => {
    const pair = '__teststartupowned756_o__';
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        // The sell carries no body annotation yet.
        seed.ingestFill({ tradeId: 'tp-gone-1', orderId: 'tp-gone', side: 'sell', size: 0.004, price: 51000, netFee: 0, tradeTime: new Date(Date.now() - 42000).toISOString() });
        seed.ingestFill(T2, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
      },
      bodies: [legacyBody(0.006)],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.014, sizeUsdc: 700, placedAt: Date.now() - 60000 },
    });
    createClosedTrades(EXCHANGE, pair).record({ sellOrderId: 'tp-gone', timestamp: Date.now() - 42000, qtySold: 0.004, bodyId: 'body-gone', buyOrderIds: [ORDER_ID], source: 'live' });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2] });
    assert.ok(near(bookedQty(eng._getPositionState()), 0.006), 'the sold tranche is not rebooked');
  });

  it('the recovered tranche carries its own cost, not the order average', async () => {
    const pair = '__teststartupowned756_p__';
    const T2CHEAP = { ...T2, price: 49000 };
    writePreFixFund(pair, {
      ledger: (seed) => {
        seed.ingestFill(T1, Date.now() - 60000);
        seed.annotateFillsByOrderId(ORDER_ID, { isBodyOwned: true, bodyId: 'body-b-756', sellOrderId: BODY_TP });
        seed.ingestFill(T2CHEAP);
      },
      bodies: [legacyBody(0.004)],
      entry: { orderId: ORDER_ID, price: PRICE, assetQty: 0.016, sizeUsdc: 800, placedAt: Date.now() - 60000 },
    });
    const { eng } = await bootEngine(pair, { openOrders: [OPEN_ENTRY], orders: {}, fills: [T1, T2CHEAP] });
    const recovered = eng._getPositionState().celestialBodies.find(b => b.id !== 'body-b-756');
    assert.ok(recovered && near(recovered.costBasis, 294), `basis is t2's own 0.006 × 49000 (got ${recovered && recovered.costBasis})`);
    assert.equal(recovered.buyOrders[0].filledAt, new Date(T2CHEAP.tradeTime).getTime(), 'the tranche is dated by its fill, not by startup');
  });
});
