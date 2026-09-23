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
//   4. rebuildLadder's budget accounts for quote spent by fills during the
//      cancel (a post-cancel balance re-read, and a reserve for rungs that
//      filled completely and polling has yet to book);
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
    unbookedFills: [],
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

  it('counts an already-owned order\'s advancing partial in the new cycle it moves into', async () => {
    // buy-e's first tranche already has a body (counted in the old cycle).
    // Its next tranche is mid-pass when an operator reset turns the cycle
    // over; the moved rows make buy-e one of the NEW cycle's buy orders.
    const eng = makeEngine({
      fillsByOrder: { 'buy-e': [rawFill('buy', 'buy-e', 't-buy-e-2', 0.002, 45000)] },
    });
    const ledger = eng.getFillLedger();
    const oldCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-e', 't-buy-e-1', 0.002, 45000));
    const pos = eng._getPositionState();
    pos.celestialBodies = [makeBody('body-eeeeeeee', 'buy-e', 0.002, 45000, 'tp-e')];
    pos.cycleBuys = 1;

    // Operator reset (bodies preserved, no ladder → runs synchronously) lands
    // between this pass's ingest and its commit.
    let reset = false;
    const realAggregate = ledger.aggregateFills;
    ledger.aggregateFills = (rows) => {
      if (!reset) { reset = true; eng._test.resetCycle(); }
      return realAggregate(rows);
    };
    try {
      await eng._test.handleOrderFill({ orderId: 'buy-e', side: 'buy', status: 'OPEN', filledSize: 0.004, averageFilledPrice: 45000, isPartialFill: true });
    } finally {
      ledger.aggregateFills = realAggregate;
    }

    assert.ok(reset, 'the cycle turned over mid-pass');
    const newCycle = ledger.getCurrentCycleId();
    assert.notEqual(newCycle, oldCycle);
    assert.equal(ledger.getFillsForOrder('buy-e').find(f => f.tradeId === 't-buy-e-2').cycleId, newCycle);
    assert.equal(ledger.getFillsForOrder('buy-e').find(f => f.tradeId === 't-buy-e-1').cycleId, oldCycle);
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 1);
    assert.equal(pos.cycleBuys, 1, 'the live counter matches the ledger for the new cycle');
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

describe('rebuildLadder — budget after a fill during the cancel (#711)', () => {
  /**
   * `balances` is the sequence getAccountBalance returns: [pre-cancel, post-cancel].
   * An Error entry models a failed fetch. `cancel` overrides the sweep result.
   */
  const setupLadderEngine = ({ balances, maxUsdc, rungs = [], cancel }) => {
    let eng;
    const placed = [];
    const fillsByOrder = {};
    for (const r of rungs) fillsByOrder[r.orderId] = [rawFill('buy', r.orderId, `t-${r.orderId}`, r.size, r.price)];
    let call = 0;
    eng = makeEngine({
      fillsByOrder,
      adapter: {
        getAccountBalance: async () => {
          const b = balances[Math.min(call++, balances.length - 1)];
          if (b instanceof Error) throw b;
          return { available: String(b) };
        },
      },
      executor: {
        cancelAllLadderOrders: cancel ? () => cancel(eng) : sweepBooking(() => eng, rungs),
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
    return { eng, placed, balanceCalls: () => call };
  };
  const placedTotal = (placed) => placed.reduce((sum, l) => sum + l.sizeUsdc, 0);
  const RUNG_300 = [{ orderId: 'rung-r', size: 0.006, price: 50000 }]; // $300 bought mid-cancel

  it('sizes against the post-cancel balance when the exchange does not hold quote for resting orders', async () => {
    // Cash binds (the cap is far away); the fresh read reflects the $300 spend.
    const { eng, placed, balanceCalls } = setupLadderEngine({ balances: [1000, 700], maxUsdc: 100000, rungs: RUNG_300 });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    assert.equal(balanceCalls(), 2, 'balance re-read after a fill during the cancel');
    const total = placedTotal(placed);
    assert.ok(total > 0, 'a ladder was placed');
    assert.ok(total <= 700 + 1e-6, `must fit the $700 left after the $300 fill, got $${total.toFixed(2)}`);
  });

  it('is not starved when the fill was paid from the resting-order hold', async () => {
    // Pre-cancel $1000 already excluded the ladder's hold; the cancel released
    // the rest of it. Subtracting $300 from the snapshot would wrongly shrink it.
    const { eng, placed } = setupLadderEngine({ balances: [1000, 1400], maxUsdc: 100000, rungs: RUNG_300 });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placedTotal(placed);
    assert.ok(total > 700 + 1e-6, `the hold-paid fill must not come off the snapshot again, got $${total.toFixed(2)}`);
    assert.ok(total <= 1000 + 1e-6, `capped at the pre-cancel snapshot — released holds are not newly counted, got $${total.toFixed(2)}`);
  });

  it('falls back to subtracting the spend when the re-read fails', async () => {
    const { eng, placed } = setupLadderEngine({ balances: [1000, new Error('rate limited')], maxUsdc: 100000, rungs: RUNG_300 });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placedTotal(placed);
    assert.ok(total > 0 && total <= 700 + 1e-6, `conservative fallback, got $${total.toFixed(2)}`);
  });

  it('does not re-read the balance when nothing filled during the cancel', async () => {
    const { eng, balanceCalls } = setupLadderEngine({
      balances: [1000],
      maxUsdc: 100000,
      cancel: async () => ({ cancelled: 3, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [] }),
    });
    const res = await eng.rebuildLadder();
    assert.equal(res.success, true, res.message);
    assert.equal(balanceCalls(), 1);
  });

  it('aborts gracefully when the fill leaves less than a min order of cash', async () => {
    const { eng, placed } = setupLadderEngine({ balances: [305, 5], maxUsdc: 100000, rungs: RUNG_300 });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, false);
    assert.match(res.message, /below min order size after a fill landed during ladder cancel/);
    assert.equal(placed.length, 0, 'no rung is sized against cash that is gone');
  });

  it('reserves a completely-filled rung polling has yet to book against the deployed cap', async () => {
    const { eng, placed } = setupLadderEngine({
      balances: [100000],
      maxUsdc: 1000, // the deployed cap binds, not cash
      cancel: async () => ({ cancelled: 2, remainingTracked: 1, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-u', filledSize: 0.008, cost: 400 }] }),
    });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placedTotal(placed);
    assert.ok(total > 0);
    assert.ok(total <= 600 + 1e-6, `must leave room for the $400 polling has yet to book, got $${total.toFixed(2)}`);
  });

  it('still reserves the unbooked remainder of a rung whose earlier partial already has a body', async () => {
    // rung-p: $200 booked earlier as a polled partial (body + ledger rows),
    // then filled completely during the cancel. cost = the $200 remainder only.
    const { eng, placed } = setupLadderEngine({
      balances: [100000],
      maxUsdc: 1000,
      cancel: async () => ({ cancelled: 2, remainingTracked: 1, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-p', filledSize: 0.008, cost: 200 }] }),
    });
    eng.getFillLedger().ingestFill(rawFill('buy', 'rung-p', 't-rung-p-1', 0.004, 50000));
    eng._getPositionState().celestialBodies = [makeBody('body-pppppppp', 'rung-p', 0.004, 50000, 'tp-p')];

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placedTotal(placed);
    assert.ok(total > 0);
    assert.ok(total <= 600 + 1e-6, `$200 booked + $200 still unbooked must both be reserved, got $${total.toFixed(2)}`);
  });

  it('counts a fill committed while the post-cancel balance re-read was in flight', async () => {
    let eng;
    let call = 0;
    const placed = [];
    eng = makeEngine({
      adapter: {
        getAccountBalance: async () => {
          if (++call === 2) {
            // A concurrent buy commits a $300 body during the re-read.
            eng._getPositionState().celestialBodies = [makeBody('body-cccccccc', 'buy-x', 0.006, 50000, 'tp-x')];
          }
          return { available: '100000' };
        },
      },
      executor: {
        cancelAllLadderOrders: async () => ({ cancelled: 1, remainingTracked: 0, partialFills: 1, partialFillOrderIds: ['rung-z'], partialFillsCost: 50, unbookedFills: [] }),
        placeLadderOrders: async (levels) => {
          placed.push(...levels);
          return { orders: levels.map((l, i) => ({ orderId: `new-rung-${i}`, ...l })), failedCount: 0 };
        },
      },
    });
    const config = eng._getConfig();
    config.entryMode = 'ladder';
    config.maxUsdcDeployed = 1000;
    config.baseSizeUsdc = 10;
    const m = eng._getMarketState();
    m.lastPrice = 50000;
    m.bid = 49999.99;
    m.ask = 50000.01;
    eng.getFillLedger().startNewCycle();
    eng._getPositionState().ladderActive = true;

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    assert.equal(call, 2);
    const total = placedTotal(placed);
    assert.ok(total > 0 && total <= 700 + 1e-6, `the $300 committed during the await must count, got $${total.toFixed(2)}`);
  });

  it('does not count a completely-filled rung twice once polling booked it during the sweep', async () => {
    // Polling committed rung-u to a body while the sweep awaited: its $400 is
    // in getAllocatedCapital() now, so it must not be added again.
    const { eng, placed } = setupLadderEngine({
      balances: [100000],
      maxUsdc: 1000,
      cancel: async (e) => {
        e.getFillLedger().ingestFill(rawFill('buy', 'rung-u', 't-rung-u', 0.008, 50000));
        e._getPositionState().celestialBodies = [makeBody('body-uuuuuuuu', 'rung-u', 0.008, 50000, 'tp-u')];
        return { cancelled: 2, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-u', filledSize: 0.008, cost: 400 }] };
      },
    });

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placedTotal(placed);
    assert.ok(total > 200 + 1e-6, `the booked rung counts once ($600 left), got $${total.toFixed(2)}`);
    assert.ok(total <= 600 + 1e-6, `got $${total.toFixed(2)}`);
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

  it('rebuildLadder re-checks after the balance fetch, before sweeping', async () => {
    let sweeps = 0;
    let eng;
    eng = makeEngine({
      adapter: {
        getAccountBalance: async () => {
          // A fill (e.g. a TP close) starts while the balance is in flight.
          eng._test.setFillInProgress(1);
          return { available: '1000' };
        },
      },
      executor: { cancelAllLadderOrders: async () => { sweeps++; return { cancelled: 0, remainingTracked: 0 }; } },
    });
    const config = eng._getConfig();
    config.entryMode = 'ladder';
    config.maxUsdcDeployed = 1000;
    config.baseSizeUsdc = 10;
    eng._getPositionState().ladderActive = true;
    try {
      const rebuild = await eng.rebuildLadder();
      assert.equal(rebuild.success, false);
      assert.match(rebuild.message, /in progress/);
    } finally {
      eng._test.setFillInProgress(0);
    }
    assert.equal(sweeps, 0, 'no sweep started underneath the fill');
    assert.equal(eng._getPositionState().ladderActive, true);
  });
});
