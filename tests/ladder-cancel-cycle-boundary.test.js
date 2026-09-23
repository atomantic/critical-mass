// @ts-check
//
// Issue #711: cancelAllLadderOrders books a rung that partially filled during
// its own cancel sweep (#674) — synchronously, before the sweep returns. The
// regime-engine callers that sweep (resetCycle, rebuildLadder, cancelLadder)
// must expect a new body to appear underneath them:
//   1. resetCycle must count that body's buy toward the NEW cycle's cycleBuys
//      (it used to zero the counter unconditionally after the sweep);
//   2. the buy's ledger rows must be tagged with the NEW cycle (ingestFill
//      stamps the cycle live at ingest time — the closing one), so a restart's
//      ledger auto-correct agrees with the live counter;
//   3. a cycle turnover while a buy is between ingest and commit (a TP close
//      racing a concurrent booking) moves the rows to the cycle it commits in;
//   4. rebuildLadder's exchange-balance clamp subtracts the quote the
//      mid-cancel fills spent;
//   5. rebuildLadder/cancelLadder refuse to sweep mid-fill/merge/reconcile.
//
// Disk safety: throwaway pairs under a disposable temp data root.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-ladder-cancel-cycle-boundary-test');

// updateRegimeConfig persists per-pair into the shared config — neutralize it
// BEFORE regime-engine is required (it destructures the function at load).
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const adapters = require('../src/adapters');
const originalGetAdapter = adapters.getAdapter;
adapters.getAdapter = () => ({ getReconciliationFills: async () => [] });

const { createRegimeEngine } = require('../src/regime-engine');
const celestialHierarchy = require('../src/celestial-hierarchy');

let pairSeq = 0;
const nextPair = () => `__test711${String.fromCharCode(97 + pairSeq++)}__`;

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  adapters.getAdapter = originalGetAdapter;
  isolatedData.cleanup();
});

const PRODUCT_DETAILS = { baseMinSize: '0.0001', baseIncrement: '0.00000001' };

const rawFill = (side, orderId, tradeId, size, price) => ({
  tradeId,
  orderId,
  side,
  price: String(price),
  size: String(size),
  totalCommission: '0',
  rebate: '0',
  liquidityIndicator: side === 'buy' ? 'TAKER' : 'MAKER',
  tradeTime: new Date().toISOString(),
});

/**
 * Live-mode engine with a mock adapter/executor. `fillsByOrder` backs
 * adapter.getOrderFills so a booked order finds its trade rows.
 * @param {{ fillsByOrder?: Record<string, any[]>, executor?: Object, adapter?: Object }} [opts]
 */
const makeEngine = ({ fillsByOrder = {}, executor = {}, adapter = {} } = {}) => {
  let tp = 0;
  const pair = nextPair();
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setRunning(true);
  eng._test.setProductDetails(PRODUCT_DETAILS);
  eng._test.setAdapter({
    getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    getOrderFills: async (orderId) => fillsByOrder[orderId] || [],
    getPositions: async () => [],
    ...adapter,
  });
  eng._test.setOrderExecutor({
    cancelBodyTpOrder: async () => ({ cancelled: true }),
    placeBodyTpOrder: async () => ({ success: true, orderId: `tp-new-${++tp}` }),
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    cancelAllLadderOrders: async () => ({ cancelled: 0, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0 }),
    getPendingLadderOrders: () => [],
    markSettled: () => {},
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    ...executor,
  });
  engines.push(eng);
  return eng;
};

const makeBody = (id, orderId, qty, price, tpOrderId) => ({
  ...celestialHierarchy.createNewBody({ assetQty: qty, costBasis: qty * price, avgPrice: price }, orderId),
  id,
  tier: 'satellite',
  tpOrderId,
  tpPrice: price * 1.04,
  assetOnOrder: qty,
});

/** What handleCancelledOrder hands onFillDetected for a mid-cancel rung. */
const midCancelBuy = (orderId, size, price) => ({
  orderId, side: 'buy', status: 'CANCELLED', filledSize: size, filledValue: size * price,
  averageFilledPrice: price, totalFees: 0, isPartialFill: true,
});

/**
 * A cancelAllLadderOrders stand-in that books `rungs` the way the real one
 * does — awaiting the engine's fill handler inside the sweep (#674).
 */
const sweepBooking = (getEng, rungs) => async () => {
  let cost = 0;
  for (const r of rungs) {
    await getEng()._test.handleOrderFill(midCancelBuy(r.orderId, r.size, r.price));
    cost += r.size * r.price;
  }
  return {
    cancelled: rungs.length,
    remainingTracked: 0,
    partialFills: rungs.length,
    partialFillOrderIds: rungs.map(r => r.orderId),
    partialFillsCost: cost,
  };
};

describe('resetCycle — a rung that fills during its own cancel sweep (#711)', () => {
  it('TP close: the mid-cancel body counts toward the new cycle, and its rows are tagged with it', async () => {
    let eng;
    const fillsByOrder = {
      'tp-a': [rawFill('sell', 'tp-a', 't-sell-a', 0.0099, 52000)],
      'rung-1': [rawFill('buy', 'rung-1', 't-rung-1', 0.002, 49000)],
    };
    eng = makeEngine({
      fillsByOrder,
      executor: { cancelAllLadderOrders: sweepBooking(() => eng, [{ orderId: 'rung-1', size: 0.002, price: 49000 }]) },
    });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-a', 't-buy-a', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.celestialBodies = [makeBody('body-aaaaaaaa', 'buy-a', 0.01, 50000, 'tp-a')];
    pos.cycleBuys = 1;
    pos.ladderActive = true;
    pos.pendingLadderOrders = [{ orderId: 'rung-1', price: 49000 }];

    // The body's TP sells → no bodies left → resetCycle → ladder sweep books rung-1.
    await eng._test.handleOrderFill({ orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.0099, averageFilledPrice: 52000 });

    const newCycle = ledger.getCurrentCycleId();
    assert.notEqual(newCycle, closingCycle, 'the TP close started a new cycle');
    assert.equal(pos.activeCycleId, newCycle);
    assert.equal(pos.celestialBodies.length, 1, 'the mid-cancel rung became a body that survives the reset');
    assert.ok(pos.celestialBodies[0].buyOrders.some(b => b.orderId === 'rung-1'));
    assert.equal(pos.cycleBuys, 1, 'the surviving body is one buy step of the new cycle, not 0');
    assert.equal(ledger.getFillsForOrder('rung-1')[0].cycleId, newCycle, 'rung rows moved to the new cycle');
    assert.equal(ledger.getFillsForOrder('buy-a')[0].cycleId, closingCycle, 'the closed cycle keeps its own buy');
    assert.equal(ledger.getFillsForOrder('tp-a')[0].cycleId, closingCycle, 'and the sell that closed it');
    assert.equal(ledger.getCurrentCycleAllBuysCount(), pos.cycleBuys,
      'a restart\'s ledger auto-correct reads the same count as the live counter');
    assert.ok(pos.totalAsset > 0 && pos.totalCostBasis > 0, 'aggregates re-derived from the surviving body');
  });

  it('operator reset with preserved bodies counts only the mid-cancel buy, not the carried-over bodies', async () => {
    let eng;
    eng = makeEngine({
      fillsByOrder: { 'rung-2': [rawFill('buy', 'rung-2', 't-rung-2', 0.002, 40000)] },
      executor: { cancelAllLadderOrders: sweepBooking(() => eng, [{ orderId: 'rung-2', size: 0.002, price: 40000 }]) },
    });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-p', 't-buy-p', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    // Far from the rung's price so the rung gets its own body, not a merge.
    pos.celestialBodies = [makeBody('body-pppppppp', 'buy-p', 0.01, 50000, 'tp-p')];
    pos.cycleBuys = 3;
    pos.ladderActive = true;

    await eng._test.resetCycle();

    assert.equal(pos.celestialBodies.length, 2, 'preserved body + mid-cancel body');
    assert.equal(pos.cycleBuys, 1, 'only the buy that landed during the sweep opens the new cycle');
    const newCycle = ledger.getCurrentCycleId();
    assert.equal(ledger.getFillsForOrder('rung-2')[0].cycleId, newCycle);
    assert.equal(ledger.getFillsForOrder('buy-p')[0].cycleId, closingCycle, 'a preserved body\'s rows are not carried');
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 1);
  });

  it('a clean sweep (no mid-cancel fill) still zeroes cycleBuys', async () => {
    const eng = makeEngine({
      executor: { cancelAllLadderOrders: async () => ({ cancelled: 4, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0 }) },
    });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-z', 't-buy-z', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.cycleBuys = 2;
    pos.ladderActive = true;

    await eng._test.resetCycle();

    assert.equal(pos.cycleBuys, 0);
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 0);
    assert.equal(pos.ladderActive, false);
  });

  it('a sweep row whose booking was deferred is carried, and counted by its own later commit', async () => {
    // The mid-cancel booking ingested the rows but never committed a body
    // (e.g. it threw after ingest) — nothing owns rung-3 when the reset ends.
    const rung3 = rawFill('buy', 'rung-3', 't-rung-3', 0.002, 30000);
    const eng = makeEngine({
      fillsByOrder: { 'rung-3': [rung3] },
      executor: {
        cancelAllLadderOrders: async () => {
          eng.getFillLedger().ingestFill(rung3);
          return { cancelled: 1, remainingTracked: 0, partialFills: 1, partialFillOrderIds: ['rung-3'], partialFillsCost: 60 };
        },
      },
    });
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    const pos = eng._getPositionState();
    pos.cycleBuys = 2;
    pos.ladderActive = true;

    await eng._test.resetCycle();
    const newCycle = ledger.getCurrentCycleId();
    assert.equal(ledger.getFillsForOrder('rung-3')[0].cycleId, newCycle, 'rows follow the buy into the new cycle');
    assert.equal(pos.cycleBuys, 0, 'no body owns it yet — its commit will count it');

    // The retry books the already-ingested rows (the #671 unsettled fallback).
    await eng._test.handleOrderFill(midCancelBuy('rung-3', 0.002, 30000));
    assert.equal(pos.celestialBodies.length, 1);
    assert.equal(pos.cycleBuys, 1);
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 1, 'ledger and counter agree after the deferred commit');
  });
});

describe('buy commit after a mid-pass cycle turnover (#711, concurrent framing)', () => {
  it('moves the rows it books into the cycle it commits in', async () => {
    const eng = makeEngine({
      fillsByOrder: { 'buy-c': [rawFill('buy', 'buy-c', 't-buy-c', 0.003, 45000)] },
    });
    const ledger = eng.getFillLedger();
    const oldCycle = ledger.startNewCycle();
    const pos = eng._getPositionState();

    // Turn the cycle over between ingest and commit — what a TP close's
    // resetCycle does when it runs while this buy's handler is mid-await.
    let newCycle = null;
    const realAggregate = ledger.aggregateFills;
    ledger.aggregateFills = (rows) => {
      if (!newCycle) newCycle = ledger.startNewCycle();
      return realAggregate(rows);
    };
    try {
      await eng._test.handleOrderFill({ orderId: 'buy-c', side: 'buy', status: 'FILLED', filledSize: 0.003, averageFilledPrice: 45000 });
    } finally {
      ledger.aggregateFills = realAggregate;
    }

    assert.ok(newCycle && newCycle !== oldCycle);
    assert.equal(pos.celestialBodies.length, 1);
    assert.equal(pos.cycleBuys, 1);
    assert.equal(ledger.getFillsForOrder('buy-c')[0].cycleId, newCycle, 'rows follow the commit into the live cycle');
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 1);
  });

  it('leaves rows alone when the cycle did not turn over', async () => {
    const eng = makeEngine({
      fillsByOrder: { 'buy-d': [rawFill('buy', 'buy-d', 't-buy-d', 0.003, 45000)] },
    });
    const ledger = eng.getFillLedger();
    const cycle = ledger.startNewCycle();
    await eng._test.handleOrderFill({ orderId: 'buy-d', side: 'buy', status: 'FILLED', filledSize: 0.003, averageFilledPrice: 45000 });
    assert.equal(ledger.getFillsForOrder('buy-d')[0].cycleId, cycle);
  });
});

describe('rebuildLadder — budget after a mid-cancel fill (#711)', () => {
  const setupLadderEngine = ({ available, maxUsdc, rungs }) => {
    let eng;
    const placed = [];
    const fillsByOrder = {};
    for (const r of rungs) fillsByOrder[r.orderId] = [rawFill('buy', r.orderId, `t-${r.orderId}`, r.size, r.price)];
    eng = makeEngine({
      fillsByOrder,
      adapter: { getAccountBalance: async () => ({ available: String(available) }) },
      executor: {
        cancelAllLadderOrders: sweepBooking(() => eng, rungs),
        placeLadderOrders: async (levels) => {
          placed.push(...levels);
          return { orders: levels.map((l, i) => ({ orderId: `new-rung-${i}`, ...l })), failedCount: 0 };
        },
      },
    });
    const config = eng._getConfig();
    config.entryMode = 'ladder';
    config.maxUsdcDeployed = maxUsdc;
    config.baseSizeUsdc = 10;
    const m = eng._getMarketState();
    m.lastPrice = 50000;
    m.bid = 49999.99;
    m.ask = 50000.01;
    eng.getFillLedger().startNewCycle();
    eng._getPositionState().ladderActive = true;
    return { eng, placed };
  };

  it('sizes the new ladder against the cash left after the mid-cancel fill when cash binds', async () => {
    // Deployed cap is far away; the exchange balance is the binding term.
    const { eng, placed } = setupLadderEngine({
      available: 1000,
      maxUsdc: 100000,
      rungs: [{ orderId: 'rung-r', size: 0.006, price: 50000 }], // $300 spent mid-cancel
    });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placed.reduce((sum, l) => sum + l.sizeUsdc, 0);
    assert.ok(total > 0, 'a ladder was placed');
    assert.ok(total <= 700 + 1e-6, `new ladder must fit the $700 left after the $300 mid-cancel fill, got $${total.toFixed(2)}`);
  });

  it('aborts gracefully when the mid-cancel fill leaves less than a min order of cash', async () => {
    const { eng, placed } = setupLadderEngine({
      available: 305,
      maxUsdc: 100000,
      rungs: [{ orderId: 'rung-s', size: 0.006, price: 50000 }], // $300 spent → $5 left < $10 min
    });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, false);
    assert.match(res.message, /below min order size after a fill landed during ladder cancel/);
    assert.equal(placed.length, 0, 'no rung is sized against cash that is gone');
  });
});

describe('rebuildLadder / cancelLadder refuse to sweep mid-mutation (#711)', () => {
  for (const [label, setFlag] of [
    ['an in-flight fill', (eng, v) => eng._test.setFillInProgress(v ? 1 : 0)],
    ['a merge', (eng, v) => eng._test.setMergeInProgress(v)],
    ['a reconcile', (eng, v) => eng._test.setReconcileInProgress(v)],
  ]) {
    it(`during ${label}`, async () => {
      let sweeps = 0;
      const eng = makeEngine({
        adapter: { getAccountBalance: async () => ({ available: '1000' }) },
        executor: { cancelAllLadderOrders: async () => { sweeps++; return { cancelled: 0, remainingTracked: 0 }; } },
      });
      const config = eng._getConfig();
      config.entryMode = 'ladder';
      config.maxUsdcDeployed = 1000;
      eng._getPositionState().ladderActive = true;

      setFlag(eng, true);
      try {
        const rebuild = await eng.rebuildLadder();
        assert.equal(rebuild.success, false);
        assert.match(rebuild.message, /in progress/);
        const cancel = await eng.cancelLadder();
        assert.equal(cancel.success, false);
        assert.match(cancel.message, /in progress/);
      } finally {
        setFlag(eng, false);
      }
      assert.equal(sweeps, 0, 'no sweep started');
      assert.equal(eng._getPositionState().ladderActive, true, 'ladder state untouched');
      assert.equal(config.entryMode, 'ladder', 'cancelLadder did not switch modes');
    });
  }
});
