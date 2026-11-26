// @ts-check
// Issue #1980: entry evaluation lives in regime-entry.js. Pins the factory's
// contract in isolation — the exposed surface, the guards and locks an
// evaluation runs under, the order of sizing / risk check / balance preflight /
// executor call, the engine-owned latches it reads and replaces through
// accessors, and the call-time accessors for the bindings the engine
// reassigns. Engine-level behavior stays covered by the entry, ladder,
// flash-cancel, admission and cap-alert suites that drive a real engine.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEntryEvaluator, CAP_ALERT_LABELS } = require('../src/regime-entry');
const { createEngineLocks } = require('../src/engine-locks');
const { createInitialRegimePositionState } = require('../src/regime-state-store');
const { tradeEvents } = require('../src/trade-events');

const make = (overrides = {}) => {
  const calls = [];
  const logs = [];
  const logger = {
    info: (message) => { logs.push(['info', message]); },
    warn: (message) => { logs.push(['warn', message]); },
    error() {}, debug() {},
  };
  const locks = createEngineLocks({ logWarn() {} });
  // Real locks, recorded at the entry points an evaluation is expected to use.
  const engineLocks = {
    ...locks,
    withEntryLock: (fn) => { calls.push('withEntryLock'); return locks.withEntryLock(fn); },
    withLadderLock: (fn, opts) => { calls.push(['withLadderLock', opts]); return locks.withLadderLock(fn, opts); },
  };
  const positionState = createInitialRegimePositionState();
  const live = {
    adapter: { getAccountBalance: async (currency) => { calls.push(['getAccountBalance', currency]); return { available: 1000 }; } },
    orderExecutor: {
      getPendingCounts: () => ({ entries: 0, ladderEntries: 0, total: 0 }),
      placeEntryBid: async (...args) => {
        calls.push(['placeEntryBid', ...args.slice(0, 6)]);
        return { success: true, orderId: 'entry-1', price: 99.9, assetQty: 0.1 };
      },
      placeLadderOrders: async (levels) => {
        calls.push(['placeLadderOrders', levels.length]);
        return { orders: levels.map((level, i) => ({ orderId: `rung-${i}`, ...level })), failedCount: 0 };
      },
    },
    marketState: { lastPrice: 100, bid: 99.95, ask: 100.05, atr1m: 0, realizedVol: 0, volBaseline: 0, momentum: null },
    priceIncrement: 0.01,
    cycleResetGeneration: 0,
    flashCancelSweep: null,
    blockingIntents: [],
    // The latches the engine owns and clears on a cycle reset.
    loggedEntryBlockKinds: new Set(),
    budgetExhaustedWarningLogged: false,
    announcedCaps: new Set(),
    lowBalancePauseLogged: false,
  };
  const riskCheck = { allowed: true, reason: '' };
  const deps = {
    exchange: 'coinbase', productId: 'BTC-USD', isDryRun: false,
    config: {
      entryMode: 'reactive', minIntervalMs: 0, maxIntervalMs: 1, kFactor: 1, entryOffsetBps: 5,
      maxUsdcDeployed: 500, baseSizeUsdc: 10, minOrderSizeUsdc: 1, maxOpenOrders: 50,
    },
    exchangeConfig: {}, logger, fundEventData: { pair: 'BTC-USD' },
    positionState, engineLocks,
    healthMonitor: { canPlaceEntry: () => ({ allowed: true }) },
    tailEvents: { canPlaceEntry: () => ({ allowed: true }) },
    regimeDetector: { allowsEntries: () => true, getMode: () => 'HARVEST' },
    macroRegime: null,
    positionSizer: {
      calculateEntrySize: () => { calls.push('calculateEntrySize'); return { sizeUsdc: 10 }; },
      calculateBTCQuantity: (sizeUsdc, price) => sizeUsdc / price,
    },
    riskManager: {
      canPlaceEntry: () => { calls.push('riskManager.canPlaceEntry'); return riskCheck; },
      getState: () => ({ isDrawdownPaused: false }),
    },
    ladderCalculator: { getSummary: () => 'summary' },
    getAdapter: () => live.adapter,
    getOrderExecutor: () => live.orderExecutor,
    getMarketState: () => live.marketState,
    getPriceIncrement: () => live.priceIncrement,
    getCycleResetGeneration: () => live.cycleResetGeneration,
    getFlashCancelSweep: () => live.flashCancelSweep,
    getLoggedEntryBlockKinds: () => live.loggedEntryBlockKinds,
    setLoggedEntryBlockKinds: (v) => { live.loggedEntryBlockKinds = v; },
    getBudgetExhaustedWarningLogged: () => live.budgetExhaustedWarningLogged,
    setBudgetExhaustedWarningLogged: (v) => { live.budgetExhaustedWarningLogged = v; },
    getAnnouncedCaps: () => live.announcedCaps,
    setAnnouncedCaps: (v) => { live.announcedCaps = v; },
    getLowBalancePauseLogged: () => live.lowBalancePauseLogged,
    setLowBalancePauseLogged: (v) => { live.lowBalancePauseLogged = v; },
    lookupOrNull: (label, subject, lookup) => lookup.catch(() => null),
    blockingPlacementIntents: () => live.blockingIntents,
    captureEntryAdmission: () => { calls.push('captureEntryAdmission'); return () => true; },
    captureReactiveEntryAdmission: () => { calls.push('captureReactiveEntryAdmission'); return () => true; },
    getAllocatedCapital: () => 0,
    buildLadderFromMarket: (marketState, budget, priceIncrement) => {
      calls.push(['buildLadderFromMarket', marketState.lastPrice, budget, priceIncrement]);
      return { levels: [{ price: 99, sizeUsdc: 50 }, { price: 98, sizeUsdc: 50 }], lowerBound: 98, lowerBoundPct: 2, totalBudget: 100 };
    },
    abandonLadderPlacedAcrossReset: async (generation, label) => { calls.push(['abandonLadderPlacedAcrossReset', generation, label]); return false; },
    saveLiveState: () => { calls.push('saveLiveState'); },
    ...overrides,
  };
  return { api: createEntryEvaluator(deps), calls, logs, positionState, live, locks, riskCheck };
};

describe('createEntryEvaluator (issue #1980)', () => {
  it('exposes the engine-facing entry points and the cap alert labels', () => {
    const { api } = make();
    assert.deepEqual(Object.keys(api).sort(), ['evaluateEntryTrigger', 'evaluateLadderEntry']);
    assert.deepEqual(CAP_ALERT_LABELS, {
      asset_cap_exceeded: 'Asset', usdc_cap_exceeded: 'USDC', cycle_buys_limit_reached: 'Cycle buys',
    });
  });

  it('a reactive entry sizes, checks risk, verifies the balance and places under the entry lock, then persists the bid', async () => {
    const { api, calls, positionState, locks } = make();
    await api.evaluateEntryTrigger();
    assert.deepEqual(calls, [
      'captureReactiveEntryAdmission',
      'withEntryLock',
      'calculateEntrySize',
      'riskManager.canPlaceEntry',
      ['getAccountBalance', 'USD'],
      // sizeUsdc, bid, ask, stepIndex, offsetBps, staleMs (the orderStaleMs floor: no ATR)
      ['placeEntryBid', 10, 99.95, 100.05, 0, 5, 30000],
      'saveLiveState',
    ]);
    assert.equal(locks.isEntryInProgress(), false);
    assert.equal(positionState.anchorPrice, 100);
    assert.equal(positionState.pendingEntryOrders.length, 1);
    const { placedAt, ...saved } = positionState.pendingEntryOrders[0];
    assert.deepEqual(saved, { orderId: 'entry-1', price: 99.9, assetQty: 0.1, sizeUsdc: 10, staleMs: 30000 });
    assert.equal(typeof placedAt, 'number');
  });

  it('holds every new entry while the entry lock is taken or a placement intent is unresolved', async () => {
    const { api, calls, live, locks } = make();
    let release;
    const held = locks.withEntryLock(() => new Promise((resolve) => { release = resolve; }));
    await api.evaluateEntryTrigger();
    assert.deepEqual(calls, []);
    release();
    await held;
    live.blockingIntents = [{ intentId: 'intent-1' }];
    await api.evaluateEntryTrigger();
    assert.deepEqual(calls, []);
    live.blockingIntents = [];
    await api.evaluateEntryTrigger();
    assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'placeEntryBid'));
  });

  it('a reactive evaluation refuses to start while a flash-cancel sweep is in flight, read at call time', async () => {
    const { api, calls, live } = make();
    live.flashCancelSweep = Promise.resolve();
    await api.evaluateEntryTrigger();
    assert.deepEqual(calls, []);
    live.flashCancelSweep = null;
    await api.evaluateEntryTrigger();
    assert.equal(calls[0], 'captureReactiveEntryAdmission');
  });

  it('reads the swapped executor, adapter and market state at call time', async () => {
    const { api, live } = make();
    const seen = [];
    live.adapter = { getAccountBalance: async () => { seen.push('swapped-adapter'); return { available: 1000 }; } };
    live.orderExecutor = {
      getPendingCounts: () => ({ entries: 0, ladderEntries: 0, total: 0 }),
      placeEntryBid: async (sizeUsdc, bid) => { seen.push(['swapped-executor', bid]); return { success: false, notAdmitted: true }; },
    };
    live.marketState = { ...live.marketState, bid: 50, ask: 51, lastPrice: 50.5 };
    await api.evaluateEntryTrigger();
    assert.deepEqual(seen, ['swapped-adapter', ['swapped-executor', 50]]);
  });

  it('a blocked entry logs once per block episode and announces each cap once, through the engine-owned latches', async () => {
    const { api, calls, logs, live, riskCheck } = make();
    const capEvents = [];
    const onTrade = (event) => { if (event.type === 'cap_reached') capEvents.push(event); };
    tradeEvents.on('trade', onTrade);
    try {
      riskCheck.allowed = false;
      riskCheck.reason = 'usdc_cap_exceeded:500>=500';
      await api.evaluateEntryTrigger();
      await api.evaluateEntryTrigger();
      assert.equal(logs.filter(([, message]) => message.includes('Entry blocked')).length, 1);
      assert.deepEqual([...live.announcedCaps], ['usdc_cap_exceeded']);
      assert.deepEqual([...live.loggedEntryBlockKinds], ['usdc_cap_exceeded']);
      assert.equal(capEvents.length, 1);
      // The engine clears the latches on a cycle reset: the same cap alerts and logs again.
      live.announcedCaps = new Set();
      live.loggedEntryBlockKinds = new Set();
      await api.evaluateEntryTrigger();
      assert.equal(logs.filter(([, message]) => message.includes('Entry blocked')).length, 2);
      assert.equal(capEvents.length, 2);
      assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'placeEntryBid'));
      // A check that passes forgets both.
      riskCheck.allowed = true;
      riskCheck.reason = '';
      await api.evaluateEntryTrigger();
      assert.equal(live.announcedCaps.size, 0);
      assert.equal(live.loggedEntryBlockKinds.size, 0);
    } finally {
      tradeEvents.off('trade', onTrade);
    }
  });

  it('an exhausted budget logs once until the engine clears the latch', async () => {
    const { api, logs, live } = make({
      positionSizer: { calculateEntrySize: () => ({ sizeUsdc: 0 }), calculateBTCQuantity: () => 0 },
    });
    await api.evaluateEntryTrigger();
    await api.evaluateEntryTrigger();
    assert.equal(logs.filter(([, message]) => message.includes('Budget exhausted')).length, 1);
    assert.equal(live.budgetExhaustedWarningLogged, true);
    live.budgetExhaustedWarningLogged = false;
    await api.evaluateEntryTrigger();
    assert.equal(logs.filter(([, message]) => message.includes('Budget exhausted')).length, 2);
  });

  it('an insufficient-funds rejection arms a cooldown that holds the next evaluation', async () => {
    const { api, calls, live } = make();
    live.orderExecutor = {
      getPendingCounts: () => ({ entries: 0, ladderEntries: 0, total: 0 }),
      placeEntryBid: async () => { calls.push('placeEntryBid'); return { success: false, errorMessage: 'INSUFFICIENT_FUND' }; },
    };
    await api.evaluateEntryTrigger();
    await api.evaluateEntryTrigger();
    await api.evaluateLadderEntry();
    assert.equal(calls.filter((call) => call === 'placeEntryBid').length, 1);
    // The second reactive pass captured admission, then stopped at the cooldown; the ladder likewise.
    assert.deepEqual(calls.slice(-2), ['captureReactiveEntryAdmission', 'captureEntryAdmission']);
  });

  it('a wallet below the minimum order pauses entries and logs once per low-balance episode', async () => {
    const { api, calls, logs, live } = make();
    live.adapter = { getAccountBalance: async () => ({ available: 0.5 }) };
    await api.evaluateEntryTrigger();
    assert.equal(live.lowBalancePauseLogged, true);
    assert.equal(logs.filter(([, message]) => message.includes('below min order')).length, 1);
    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'placeEntryBid'));
  });

  it('a ladder takes the entry lock, then the ladder lock without waiting, and records the placed rungs', async () => {
    const { api, calls, positionState, live, locks } = make();
    live.cycleResetGeneration = 7;
    live.priceIncrement = 0.5;
    await api.evaluateLadderEntry();
    assert.deepEqual(calls, [
      'captureEntryAdmission',
      'withEntryLock',
      ['withLadderLock', { wait: false }],
      ['getAccountBalance', 'USD'],
      ['buildLadderFromMarket', 100, 500, 0.5],
      ['placeLadderOrders', 2],
      ['abandonLadderPlacedAcrossReset', 7, 'Ladder placement'],
      'saveLiveState',
    ]);
    assert.equal(locks.isEntryInProgress(), false);
    assert.equal(locks.isLadderBusy(), false);
    assert.equal(positionState.ladderActive, true);
    assert.equal(positionState.ladderLowerBound, 98);
    assert.deepEqual(positionState.pendingLadderOrders.map((order) => order.orderId), ['rung-0', 'rung-1']);
    // A resting ladder is left alone by the next evaluation.
    calls.length = 0;
    await api.evaluateLadderEntry();
    assert.deepEqual(calls, ['captureEntryAdmission']);
  });

  it('halts automatic entries at zero macro size, including a halt during preflight', async () => {
    let sizeMult = 0;
    const macroRegime = { getMultipliers: () => ({ sizeMult, tpMult: 1, offsetMult: 1 }) };
    const { api, calls, live } = make({ macroRegime });
    await api.evaluateEntryTrigger();
    await api.evaluateLadderEntry();
    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'getAccountBalance'));

    live.adapter.getAccountBalance = async () => {
      sizeMult = 0;
      return { available: 1000 };
    };
    sizeMult = 1;
    await api.evaluateEntryTrigger();
    sizeMult = 1;
    await api.evaluateLadderEntry();
    assert.ok(!calls.some((call) => Array.isArray(call) && ['placeEntryBid', 'placeLadderOrders'].includes(call[0])));
  });

  it('the trigger routes to the ladder path in ladder mode and stays reactive once a reactive position is open', async () => {
    const { api, calls, positionState } = make({ config: {
      entryMode: 'ladder', minIntervalMs: 0, maxIntervalMs: 1, kFactor: 1, entryOffsetBps: 5,
      maxUsdcDeployed: 500, baseSizeUsdc: 10, minOrderSizeUsdc: 1, maxOpenOrders: 50,
    } });
    positionState.totalAsset = 0.5;
    positionState.ladderActive = false;
    await api.evaluateEntryTrigger();
    assert.equal(calls[0], 'captureReactiveEntryAdmission');
    calls.length = 0;
    positionState.totalAsset = 0;
    await api.evaluateEntryTrigger();
    assert.equal(calls[0], 'captureEntryAdmission');
    assert.deepEqual(calls[2], ['withLadderLock', { wait: false }]);
  });
});
