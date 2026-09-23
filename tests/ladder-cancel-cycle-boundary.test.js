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

  it('fresh ledger (no live cycle yet): the first reset still carries the mid-cancel buy', async () => {
    let eng;
    eng = makeEngine({
      fillsByOrder: { 'rung-f': [rawFill('buy', 'rung-f', 't-rung-f', 0.002, 40000)] },
      executor: { cancelAllLadderOrders: sweepBooking(() => eng, [{ orderId: 'rung-f', size: 0.002, price: 40000 }]) },
    });
    const ledger = eng.getFillLedger();
    assert.equal(ledger.getCurrentCycleId(), null, 'no cycle started yet');
    ledger.ingestFill(rawFill('buy', 'buy-0', 't-buy-0', 0.01, 50000)); // stamped null
    const pos = eng._getPositionState();
    pos.cycleBuys = 1;
    pos.ladderActive = true;

    await eng._test.resetCycle();

    const newCycle = ledger.getCurrentCycleId();
    assert.ok(newCycle);
    assert.equal(ledger.getFillsForOrder('rung-f')[0].cycleId, newCycle, 'the null-stamped sweep buy moved into the first cycle');
    assert.equal(ledger.getFillsForOrder('buy-0')[0].cycleId, null, 'pre-sweep rows are left alone');
    assert.equal(pos.cycleBuys, 1);
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 1);
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

  it('fresh ledger (no live cycle yet): moves the null-stamped rows into the cycle the buy commits in (#774)', async () => {
    // The fund's first-ever cycle close: buy-f is ingested (stamped null —
    // no cycle exists yet) before the sweep, waits inside the merge path,
    // and a nested TP close's resetCycle runs the first-ever cycle while
    // this pass is between ingest and commit — mirroring the "moves the
    // rows it books into the cycle it commits in" case above, but starting
    // from a null ingestCycleId instead of an already-live one.
    const eng = makeEngine({
      fillsByOrder: { 'buy-f': [rawFill('buy', 'buy-f', 't-buy-f', 0.003, 45000)] },
    });
    const ledger = eng.getFillLedger();
    assert.equal(ledger.getCurrentCycleId(), null, 'no cycle started yet');
    const pos = eng._getPositionState();

    // Turn the cycle over between ingest and commit — the first-ever
    // resetCycle, exactly as a nested TP close would trigger it.
    let newCycle = null;
    const realAggregate = ledger.aggregateFills;
    ledger.aggregateFills = (rows) => {
      if (!newCycle) newCycle = ledger.startNewCycle();
      return realAggregate(rows);
    };
    try {
      await eng._test.handleOrderFill({ orderId: 'buy-f', side: 'buy', status: 'FILLED', filledSize: 0.003, averageFilledPrice: 45000 });
    } finally {
      ledger.aggregateFills = realAggregate;
    }

    assert.ok(newCycle, 'the first-ever cycle started mid-pass');
    assert.equal(pos.celestialBodies.length, 1);
    assert.equal(pos.cycleBuys, 1);
    assert.equal(ledger.getFillsForOrder('buy-f')[0].cycleId, newCycle,
      'the null-stamped row follows the commit into the live cycle, not left null');
    // Restart's ledger auto-correct reconstructs cycleBuys from rows whose
    // cycleId matches the live cycle — it must read the same count as the
    // live in-memory counter, or cycleBuys silently drifts after a restart
    // (the bug: the row stayed null, so this read 0 while pos.cycleBuys was 1).
    assert.equal(ledger.getCurrentCycleAllBuysCount(), pos.cycleBuys,
      'a restart\'s ledger auto-correct reads the same count as the live counter');
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
      cancel: async () => ({ cancelled: 2, remainingTracked: 1, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-u', filledSize: 0.008, unitCost: 50000, cost: 400 }] }),
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
      cancel: async () => ({ cancelled: 2, remainingTracked: 1, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-p', filledSize: 0.008, unitCost: 50000, cost: 200 }] }),
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

  it('reserves only the unbooked tranche after a restart emptied the executor\'s partial tracker', async () => {
    // rung-q's earlier $200 partial was booked before a restart, so the
    // executor's tracker is empty and its `cost` covers the full $400. The
    // persisted ledger still says 0.004 is booked — reserve only the rest.
    const { eng, placed } = setupLadderEngine({
      balances: [100000],
      maxUsdc: 1000,
      cancel: async () => ({ cancelled: 1, remainingTracked: 1, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-q', filledSize: 0.008, unitCost: 50000, cost: 400 }] }),
    });
    eng.getFillLedger().ingestFill(rawFill('buy', 'rung-q', 't-rung-q-1', 0.004, 50000));
    eng._getPositionState().celestialBodies = [makeBody('body-qqqqqqqq', 'rung-q', 0.004, 50000, 'tp-q')];

    const res = await eng.rebuildLadder();

    assert.equal(res.success, true, res.message);
    const total = placedTotal(placed);
    assert.ok(total > 400 + 1e-6, `the booked $200 must not be reserved twice, got $${total.toFixed(2)}`);
    assert.ok(total <= 600 + 1e-6, `got $${total.toFixed(2)}`);
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
        return { cancelled: 2, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [{ orderId: 'rung-u', filledSize: 0.008, unitCost: 50000, cost: 400 }] };
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

describe('ladder sweeps serialise on the ladder lock (#766)', () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const until = async (cond, what) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  /**
   * Ladder-mode engine whose placeLadderOrders and cancelAllLadderOrders can
   * be held open. `holdPlace` / `holdCancel` are consumed once each, in call order.
   */
  const setupSerialEngine = ({ fillsByOrder = {}, holdPlace = [], holdCancel = [] } = {}) => {
    const calls = { cancel: 0, place: 0 };
    const eng = makeEngine({
      fillsByOrder,
      adapter: { getAccountBalance: async () => ({ available: '1000' }) },
      executor: {
        cancelAllLadderOrders: async () => {
          calls.cancel++;
          const hold = holdCancel.shift();
          if (hold) await hold.promise;
          return { cancelled: 1, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [] };
        },
        placeLadderOrders: async (levels) => {
          calls.place++;
          const hold = holdPlace.shift();
          if (hold) await hold.promise;
          return { orders: levels.map((l, i) => ({ orderId: `new-rung-${calls.place}-${i}`, ...l })), failedCount: 0 };
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
    return { eng, calls };
  };

  it('a TP close that lands mid-rebuild waits for it, then sweeps the ladder it placed', async () => {
    const placement = deferred();
    const { eng, calls } = setupSerialEngine({
      fillsByOrder: {
        'tp-a': [rawFill('sell', 'tp-a', 't-sell-a', 0.0099, 52000)],
        'new-rung-1-0': [rawFill('buy', 'new-rung-1-0', 't-new-rung', 0.002, 49000)],
      },
      holdPlace: [placement],
    });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-a', 't-buy-a', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.celestialBodies = [makeBody('body-aaaaaaaa', 'buy-a', 0.01, 50000, 'tp-a')];
    pos.cycleBuys = 1;
    pos.ladderActive = true;
    pos.pendingLadderOrders = [{ orderId: 'old-rung', price: 49000 }];

    const rebuild = eng.rebuildLadder();
    await until(() => calls.place === 1, 'the rebuild to start placing');
    assert.equal(calls.cancel, 1, 'the rebuild swept the old ladder');

    // The body's TP sells while the new rungs are still being placed.
    const tp = eng._test.handleOrderFill({ orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.0099, averageFilledPrice: 52000 });
    await until(() => pos.celestialBodies.length === 0, 'the TP to close the last body');
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(calls.cancel, 1, 'the reset did not sweep underneath the in-flight rebuild');
    assert.equal(ledger.getCurrentCycleId(), closingCycle, 'the reset is queued, not run');
    assert.equal(ledger.getFillsForOrder('tp-a')[0].bodyPnl != null, true,
      'the sell\'s P&L annotation is committed before the reset waits on the ladder lock');

    // A rung the rebuild already got onto the book fills while the reset waits.
    await eng._test.handleOrderFill({ orderId: 'new-rung-1-0', side: 'buy', status: 'FILLED', filledSize: 0.002, averageFilledPrice: 49000, filledValue: 98 });

    placement.resolve();
    const rebuilt = await rebuild;
    assert.equal(rebuilt.success, true, rebuilt.message);
    await tp;

    assert.equal(calls.cancel, 2, 'the reset swept the freshly placed ladder after the rebuild finished');
    assert.equal(pos.ladderActive, false, 'no stale "active" ladder pointing at cancelled rungs');
    assert.deepEqual(pos.pendingLadderOrders, []);
    const newCycle = ledger.getCurrentCycleId();
    assert.notEqual(newCycle, closingCycle);
    assert.equal(ledger.getFillsForOrder('new-rung-1-0')[0].cycleId, newCycle,
      'a buy that landed while the reset queued opens the new cycle, like a sweep buy (#711)');
    assert.equal(ledger.getFillsForOrder('tp-a')[0].cycleId, closingCycle);
    assert.equal(pos.cycleBuys, 1, 'the surviving rung body counts toward the new cycle');
    assert.equal(ledger.getCurrentCycleAllBuysCount(), pos.cycleBuys);
    assert.equal(eng._test.getFlags().ladderPending, 0);
  });

  it('a window buy whose own TP sold while the reset queued stays with that sell in the closing cycle', async () => {
    const placement = deferred();
    const fillsByOrder = {
      'tp-a': [rawFill('sell', 'tp-a', 't-sell-a', 0.0099, 52000)],
      'new-rung-1-0': [rawFill('buy', 'new-rung-1-0', 't-new-rung', 0.002, 49000)],
    };
    const { eng, calls } = setupSerialEngine({ fillsByOrder, holdPlace: [placement] });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-a', 't-buy-a', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.celestialBodies = [makeBody('body-aaaaaaaa', 'buy-a', 0.01, 50000, 'tp-a')];
    pos.cycleBuys = 1;
    pos.ladderActive = true;

    const rebuild = eng.rebuildLadder();
    await until(() => calls.place === 1, 'the rebuild to start placing');
    const tp = eng._test.handleOrderFill({ orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.0099, averageFilledPrice: 52000 });
    await until(() => pos.celestialBodies.length === 0, 'the TP to close the last body');

    // While the reset waits: a new rung fills, and its own TP sells in full.
    await eng._test.handleOrderFill({ orderId: 'new-rung-1-0', side: 'buy', status: 'FILLED', filledSize: 0.002, averageFilledPrice: 49000, filledValue: 98 });
    const rungBody = pos.celestialBodies[0];
    const rungTp = rungBody.tpOrderId;
    const rungTpSize = rungBody.assetOnOrder;
    assert.ok(rungTp && rungTpSize > 0, 'the rung body got a TP');
    fillsByOrder[rungTp] = [rawFill('sell', rungTp, 't-sell-rung', rungTpSize, 51000)];
    const rungClose = eng._test.handleOrderFill({ orderId: rungTp, side: 'sell', status: 'FILLED', filledSize: rungTpSize, averageFilledPrice: 51000 });
    await until(() => pos.celestialBodies.length === 0, 'the rung TP to close its body');

    placement.resolve();
    assert.equal((await rebuild).success, true);
    await tp;
    await rungClose;

    const rungBuyCycle = ledger.getFillsForOrder('new-rung-1-0')[0].cycleId;
    assert.equal(rungBuyCycle, ledger.getFillsForOrder(rungTp)[0].cycleId, 'buy and the sell that closed it share a cycle');
    assert.equal(rungBuyCycle, closingCycle);
    assert.notEqual(ledger.getCurrentCycleId(), closingCycle);
    assert.equal(pos.cycleBuys, 0, 'nothing open carried into the new cycle');
    assert.equal(ledger.getCurrentCycleAllBuysCount(), 0);
  });

  it('a second TP close queued behind the same rebuild does not close the cycle the first reset opened', async () => {
    const placement = deferred();
    const fillsByOrder = {
      'tp-a': [rawFill('sell', 'tp-a', 't-sell-a', 0.0099, 52000)],
      'new-rung-1-0': [rawFill('buy', 'new-rung-1-0', 't-w1', 0.002, 49000)],
      'new-rung-1-1': [rawFill('buy', 'new-rung-1-1', 't-w2', 0.002, 48000)],
    };
    const { eng, calls } = setupSerialEngine({ fillsByOrder, holdPlace: [placement] });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-a', 't-buy-a', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.celestialBodies = [makeBody('body-aaaaaaaa', 'buy-a', 0.01, 50000, 'tp-a')];
    pos.cycleBuys = 1;
    pos.ladderActive = true;
    const cyclesStarted = [];
    const origStart = ledger.startNewCycle;
    ledger.startNewCycle = (...args) => { const id = origStart(...args); cyclesStarted.push(id); return id; };

    const rebuild = eng.rebuildLadder();
    await until(() => calls.place === 1, 'the rebuild to start placing');
    const resetA = eng._test.handleOrderFill({ orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.0099, averageFilledPrice: 52000 });
    await until(() => pos.celestialBodies.length === 0, 'the TP to close the last body');

    // W1 fills and its TP sells (a second close → reset B queues), then W2 fills and stays open.
    await eng._test.handleOrderFill({ orderId: 'new-rung-1-0', side: 'buy', status: 'FILLED', filledSize: 0.002, averageFilledPrice: 49000, filledValue: 98 });
    const w1 = pos.celestialBodies[0];
    fillsByOrder[w1.tpOrderId] = [rawFill('sell', w1.tpOrderId, 't-sell-w1', w1.assetOnOrder, 51000)];
    const resetB = eng._test.handleOrderFill({ orderId: w1.tpOrderId, side: 'sell', status: 'FILLED', filledSize: w1.assetOnOrder, averageFilledPrice: 51000 });
    await until(() => pos.celestialBodies.length === 0, 'W1\'s TP to close its body');
    await eng._test.handleOrderFill({ orderId: 'new-rung-1-1', side: 'buy', status: 'FILLED', filledSize: 0.002, averageFilledPrice: 48000, filledValue: 96 });
    assert.equal(pos.celestialBodies.length, 1, 'W2 is an open body');

    placement.resolve();
    assert.equal((await rebuild).success, true);
    await resetA;
    await resetB;

    assert.equal(cyclesStarted.length, 1, 'exactly one cycle turnover for the one closed cycle');
    const newCycle = cyclesStarted[0];
    assert.equal(ledger.getCurrentCycleId(), newCycle);
    assert.equal(ledger.getFillsForOrder('new-rung-1-1')[0].cycleId, newCycle, 'the open W2 buy opens the new cycle');
    assert.equal(ledger.getFillsForOrder('new-rung-1-0')[0].cycleId, closingCycle, 'W1 stays with its sell');
    assert.equal(pos.cycleBuys, 1, 'W2 is the new cycle\'s one buy step — not zeroed by a stale reset');
    assert.equal(pos.celestialBodies.length, 1);
    assert.equal(pos.pendingCycleResetFor, null);
  });

  it('a TP close whose cycle reset throws is completed by the fill\'s retry, not skipped as already processed', async () => {
    let failSweep = true;
    let sweeps = 0;
    const eng = makeEngine({
      fillsByOrder: { 'tp-a': [rawFill('sell', 'tp-a', 't-sell-a', 0.0099, 52000)] },
      executor: {
        cancelAllLadderOrders: async () => {
          sweeps++;
          if (failSweep) { failSweep = false; throw new Error('exchange down'); }
          return { cancelled: 1, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [] };
        },
      },
    });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-a', 't-buy-a', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.celestialBodies = [makeBody('body-aaaaaaaa', 'buy-a', 0.01, 50000, 'tp-a')];
    pos.cycleBuys = 3;
    pos.ladderActive = true;
    const tpFill = { orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.0099, averageFilledPrice: 52000 };

    await assert.rejects(eng._test.handleOrderFill(tpFill), /exchange down/);
    assert.equal(ledger.getCurrentCycleId(), closingCycle, 'the failed reset changed nothing');
    assert.equal(ledger.getFillsForOrder('tp-a')[0].bodyPnl != null, true, 'the sell itself is booked');
    assert.equal(pos.pendingCycleResetFor, 'tp-a', 'the owed reset is recorded');
    const pnlAfterFirst = ledger.getFillsForOrder('tp-a')[0].bodyPnl;

    await eng._test.handleOrderFill(tpFill);
    assert.equal(sweeps, 2);
    assert.notEqual(ledger.getCurrentCycleId(), closingCycle, 'the retry turned the cycle over');
    assert.equal(pos.cycleBuys, 0);
    assert.equal(pos.ladderActive, false);
    assert.equal(pos.pendingCycleResetFor, null);
    assert.equal(ledger.getFillsForOrder('tp-a')[0].bodyPnl, pnlAfterFirst, 'the sell was not re-booked');
    assert.equal(pos.cyclesCompleted, 1, 'the close is counted once');
  });

  it('an owed reset whose fill is never re-delivered is completed by the next reconcile tick', async () => {
    let failSweep = true;
    const eng = makeEngine({
      fillsByOrder: { 'tp-a': [rawFill('sell', 'tp-a', 't-sell-a', 0.0099, 52000)] },
      executor: {
        cancelAllLadderOrders: async () => {
          if (failSweep) { failSweep = false; throw new Error('exchange down'); }
          return { cancelled: 1, remainingTracked: 0, partialFills: 0, partialFillOrderIds: [], partialFillsCost: 0, unbookedFills: [] };
        },
      },
    });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    ledger.ingestFill(rawFill('buy', 'buy-a', 't-buy-a', 0.01, 50000));
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.celestialBodies = [makeBody('body-aaaaaaaa', 'buy-a', 0.01, 50000, 'tp-a')];
    pos.cycleBuys = 3;
    pos.ladderActive = true;

    // WS delivery: one attempt, no retry.
    await assert.rejects(eng._test.handleOrderFill({ orderId: 'tp-a', side: 'sell', status: 'FILLED', filledSize: 0.0099, averageFilledPrice: 52000 }), /exchange down/);
    assert.equal(pos.pendingCycleResetFor, 'tp-a');

    await eng._test.reconcileTick();
    assert.notEqual(ledger.getCurrentCycleId(), closingCycle, 'the reconcile tick paid the owed reset');
    assert.equal(pos.cycleBuys, 0);
    assert.equal(pos.ladderActive, false);
    assert.equal(pos.pendingCycleResetFor, null);
    assert.equal(pos.cyclesCompleted, 1);

    // Nothing owed any more: the next tick does not turn the cycle over again.
    const cycleAfter = ledger.getCurrentCycleId();
    await eng._test.reconcileTick();
    assert.equal(ledger.getCurrentCycleId(), cycleAfter);
  });

  it('any completed cycle turnover pays off an owed reset', async () => {
    const eng = makeEngine();
    const ledger = eng.getFillLedger();
    ledger.startNewCycle();
    const pos = eng._getPositionState();
    pos.pendingCycleResetFor = 'tp-z';
    const result = await eng.resetCycleBuys();
    assert.equal(result.success, true, result.message);
    assert.equal(pos.pendingCycleResetFor, null, 'a later retry of tp-z will not reset again');
  });

  it('an operator cycle reset refuses while a ladder sweep is in flight', async () => {
    const placement = deferred();
    const { eng, calls } = setupSerialEngine({ holdPlace: [placement] });
    const ledger = eng.getFillLedger();
    const cycle = ledger.startNewCycle();
    const pos = eng._getPositionState();
    pos.activeCycleId = cycle;
    pos.ladderActive = true;

    const rebuild = eng.rebuildLadder();
    await until(() => calls.place === 1, 'the rebuild to start placing');
    const reset = await eng.resetCycleBuys();
    assert.equal(reset.success, false);
    assert.match(reset.message, /ladder rebuild, cancel, or cycle reset is in progress/);
    assert.equal(ledger.getCurrentCycleId(), cycle, 'no cycle turnover');

    placement.resolve();
    assert.equal((await rebuild).success, true);
    assert.equal(pos.ladderActive, true);
  });

  it('a rebuild requested mid-reset runs after the reset instead of refusing or interleaving', async () => {
    const sweep = deferred();
    const { eng, calls } = setupSerialEngine({ holdCancel: [sweep] });
    const ledger = eng.getFillLedger();
    const closingCycle = ledger.startNewCycle();
    const pos = eng._getPositionState();
    pos.activeCycleId = closingCycle;
    pos.ladderActive = true;

    const reset = eng._test.resetCycle();
    await until(() => calls.cancel === 1, 'the reset to start sweeping');
    const rebuild = eng.rebuildLadder();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(calls.place, 0, 'the rebuild waits for the reset\'s sweep');

    sweep.resolve();
    await reset;
    const rebuilt = await rebuild;
    assert.equal(rebuilt.success, true, rebuilt.message);
    assert.equal(calls.cancel, 1, 'nothing left to sweep after the reset');
    assert.equal(calls.place, 1);
    assert.equal(pos.ladderActive, true, 'the rebuild\'s ladder is the live one');
    assert.equal(pos.pendingLadderOrders.length > 0, true);
    assert.notEqual(ledger.getCurrentCycleId(), closingCycle);
  });

  it('cancelLadder waits for an in-flight rebuild, then cancels the ladder it placed', async () => {
    const placement = deferred();
    const { eng, calls } = setupSerialEngine({ holdPlace: [placement] });
    const pos = eng._getPositionState();
    pos.ladderActive = true;

    const rebuild = eng.rebuildLadder();
    await until(() => calls.place === 1, 'the rebuild to start placing');
    const cancel = eng.cancelLadder();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(calls.cancel, 1, 'only the rebuild\'s own sweep so far');

    placement.resolve();
    assert.equal((await rebuild).success, true);
    const cancelled = await cancel;
    assert.equal(cancelled.success, true, cancelled.message);
    assert.equal(calls.cancel, 2);
    assert.equal(pos.ladderActive, false);
    assert.deepEqual(pos.pendingLadderOrders, []);
    assert.equal(eng._getConfig().entryMode, 'reactive');
  });

  it('tick-driven ladder placement skips while a rebuild owns the ladder', async () => {
    const placement = deferred();
    const { eng, calls } = setupSerialEngine({ holdPlace: [placement] });
    const pos = eng._getPositionState();
    pos.ladderActive = true;

    const rebuild = eng.rebuildLadder();
    await until(() => calls.place === 1, 'the rebuild to start placing');
    assert.equal(pos.ladderActive, false, 'mid-rebuild the ladder reads as inactive');
    await eng._test.evaluateLadderEntry();
    assert.equal(calls.place, 1, 'no second ladder stacked on the one being placed');
    assert.equal(eng._test.getFlags().entryInProgress, false, 'the skip released the entry gate');

    placement.resolve();
    assert.equal((await rebuild).success, true);
    assert.equal(pos.ladderActive, true);
  });
});
