// @ts-check
const { describe, it, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Neutralize updateRegimeConfig before requiring regime-engine to avoid writing data/config.json
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const logger = require('../src/logger');
const { REQUIRED_EXECUTOR_METHODS, validateExecutor } = require('../src/executor-contract');
const { createOrderExecutor } = require('../src/order-executor');
const { createDryRunExecutor } = require('../src/dry-run-executor');
const { createRegimeEngine } = require('../src/regime-engine');

// A SENTINEL pair, never a real one. Constructing an executor/engine for a pair
// creates data/<exchange>/<pair>/ and the after() hook below recursively deletes
// it — so naming a live fund here rm -rf's that fund's real fill-ledger.json,
// regime-state.json and closed-trades.json on every `npm test`. This file used
// 'BTC-USDC', the production Coinbase fund, and destroyed it repeatedly before
// anyone connected the two. Match the sibling suites (__test201__,
// __testpartial__) and keep the name impossible to confuse with a real pair.
const TEST_PAIR = '__testexec__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];

after(() => {
  for (const eng of engines) {
    if (eng._test?.clearTimers) eng._test.clearTimers();
  }
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
});

const baseConfig = (overrides = {}) => ({
  entryOffsetBps: 0,
  orderStaleMs: 60_000,
  tpUpdateThresholdPct: 0.5,
  holdbackRatio: 0.5,
  maxOpenOrders: 100,
  feeRate: 0.001,
  baseSizeUsdc: 50,
  maxUsdcDeployed: 500,
  entryMode: 'ladder',
  ladderSpacingMode: 'sqrt',
  ladderSizeMode: 'fibonacci',
  ladderMaxAthDropPct: 50,
  ...overrides,
});

const makeMockAdapter = (overrides = {}) => ({
  name: 'coinbase',
  placeOrder: async () => ({ orderId: 'mock-order-1' }),
  cancelOrder: async () => ({ success: true }),
  getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
  getOrderFills: async () => [],
  getPositions: async () => [],
  getAccountBalance: async () => ({ available: '10000', total: '10000' }),
  getProductDetails: async () => ({
    baseMinSize: '0.0001',
    baseIncrement: '0.0001',
    quoteIncrement: '0.01',
    priceIncrement: '0.01',
  }),
  ...overrides,
});

describe('Order Executor Contract - Interface Parity', () => {
  it('declares all required methods in REQUIRED_EXECUTOR_METHODS', () => {
    assert.ok(Array.isArray(REQUIRED_EXECUTOR_METHODS));
    assert.ok(REQUIRED_EXECUTOR_METHODS.length >= 30);

    const expectedMethods = [
      'placeEntryBid',
      'placeTakeProfitOrder',
      'cancelTpOrder',
      'refreshStaleOrders',
      'atomicReplace',
      'cancelAllEntries',
      'handleOrderFill',
      'handleOrderCancel',
      'getPendingCounts',
      'getPendingEntries',
      'checkInvariants',
      'getActiveTpOrderId',
      'getSummary',
      'clearPendingOrders',
      'restorePendingOrder',
      'markSettled',
      'getOrderPlacedAt',
      'placeBodyTpOrder',
      'cancelBodyTpOrder',
      'cancelAllBodyTpOrders',
      'isBodyTpOrder',
      'getBodyByTpOrderId',
      'restoreBodyTpOrder',
      'removeBodyTracking',
      'placeLadderOrders',
      'cancelAllLadderOrders',
      'getPendingLadderOrders',
      'isLadderOrder',
      'setPriceIncrement',
      'clearTimers',
    ];

    for (const method of expectedMethods) {
      assert.ok(
        REQUIRED_EXECUTOR_METHODS.includes(method),
        `REQUIRED_EXECUTOR_METHODS should include ${method}`
      );
    }
  });

  it('both live and dry-run executors implement every required contract method', () => {
    const adapter = makeMockAdapter();
    const liveExec = createOrderExecutor('coinbase', baseConfig(), adapter, TEST_PAIR, {}, TEST_PAIR);
    const dryRunExec = createDryRunExecutor('coinbase', baseConfig(), { lastPrice: 50000, regime: 'NEUTRAL' }, {}, TEST_PAIR);

    // Neither should throw validation errors
    assert.doesNotThrow(() => validateExecutor(liveExec, 'live'));
    assert.doesNotThrow(() => validateExecutor(dryRunExec, 'dry-run'));

    // Check individual methods are all functions
    for (const method of REQUIRED_EXECUTOR_METHODS) {
      assert.equal(
        typeof liveExec[method],
        'function',
        `Live executor missing method: ${method}`
      );
      assert.equal(
        typeof dryRunExec[method],
        'function',
        `Dry-run executor missing method: ${method}`
      );
    }
  });

  it('both executors return identical pendingCounts key sets', () => {
    const adapter = makeMockAdapter();
    const liveExec = createOrderExecutor('coinbase', baseConfig(), adapter, TEST_PAIR, {}, TEST_PAIR);
    const dryRunExec = createDryRunExecutor('coinbase', baseConfig(), { lastPrice: 50000, regime: 'NEUTRAL' }, {}, TEST_PAIR);

    const expectedKeys = ['bodies', 'entries', 'ladderEntries', 'takeProfits', 'total'];

    const liveCounts = liveExec.getPendingCounts();
    const dryRunCounts = dryRunExec.getPendingCounts();

    assert.deepStrictEqual(Object.keys(liveCounts).sort(), expectedKeys);
    assert.deepStrictEqual(Object.keys(dryRunCounts).sort(), expectedKeys);
    assert.deepStrictEqual(Object.keys(liveCounts).sort(), Object.keys(dryRunCounts).sort());

    for (const key of expectedKeys) {
      assert.equal(typeof liveCounts[key], 'number');
      assert.equal(typeof dryRunCounts[key], 'number');
    }
  });

  it('validateExecutor validates argument types and reports missing methods', () => {
    assert.throws(() => validateExecutor(null, 'test'), /must be an object/);
    assert.throws(() => validateExecutor(undefined, 'test'), /must be an object/);
    assert.throws(() => validateExecutor('executor', 'test'), /must be an object/);
    assert.throws(() => validateExecutor(123, 'test'), /must be an object/);

    assert.throws(
      () => validateExecutor({}, 'custom-exec'),
      (err) => {
        assert.ok(err.message.includes("Executor 'custom-exec' missing required methods:"));
        assert.ok(err.message.includes('placeLadderOrders'));
        assert.ok(err.message.includes('placeEntryBid'));
        return true;
      }
    );

    // Incomplete executor missing only a few methods
    const partial = {};
    for (const method of REQUIRED_EXECUTOR_METHODS) {
      if (method !== 'placeLadderOrders' && method !== 'cancelAllLadderOrders') {
        partial[method] = () => {};
      }
    }

    assert.throws(
      () => validateExecutor(partial, 'partial-exec'),
      (err) => {
        assert.ok(err.message.includes('placeLadderOrders'));
        assert.ok(err.message.includes('cancelAllLadderOrders'));
        assert.ok(!err.message.includes('placeEntryBid'));
        return true;
      }
    );
  });
});

describe('Dry-Run Ladder Execution and Simulation', () => {
  const makeEngine = (configOverrides = {}) => {
    const eng = createRegimeEngine('coinbase', TEST_PAIR, {
      dryRun: true,
      productId: TEST_PAIR,
    }, {});
    eng.updateConfig({
      entryMode: 'ladder',
      baseSizeUsdc: 50,
      maxUsdcDeployed: 500,
      ladderMaxAthDropPct: 50,
      ...configOverrides,
    });
    eng._test.setRunning(true);
    eng._test.setProductDetails({
      baseMinSize: '0.0001',
      baseIncrement: '0.0001',
      quoteIncrement: '0.01',
      priceIncrement: '0.01',
    });
    eng._test.setAdapter(makeMockAdapter());
    engines.push(eng);
    return eng;
  };

  it('dry-run engine places ladder orders on ticker without entry evaluation warning', async () => {
    const warnings = [];
    const originalLog = logger.log;
    mock.method(logger, 'log', (level, message, data, options) => {
      if (level === 'WARN') {
        warnings.push({ message, data });
      }
      return originalLog(level, message, data, options);
    });

    const eng = makeEngine({ entryMode: 'ladder' });

    // Send ticker update to trigger ladder evaluation
    eng._test.handleTicker({ price: 50000, bid: 49990, ask: 50010 });

    // Allow async ladder placement to finish
    await new Promise(r => setTimeout(r, 100));

    // Verify NO warning about entry evaluation failure occurred
    const failedWarnings = warnings.filter(w => w.message && w.message.includes('Entry evaluation failed'));
    assert.deepStrictEqual(failedWarnings, [], 'Entry evaluation must not fail on dry-run ladder');

    const state = eng.getState();
    assert.equal(state.isDryRun, true);
    assert.equal(state.position.ladderActive, true, 'Ladder should be active in position state');
    assert.ok(state.position.pendingLadderOrders.length > 0, 'Should have pending ladder orders');
    assert.equal(state.orders.ladderEntries, state.position.pendingLadderOrders.length);
  });

  it('simulates ladder fill when ticker price drops through a rung and creates body TP', async () => {
    const eng = makeEngine({ entryMode: 'ladder' });

    // Initial ticker sets market price and places ladder
    eng._test.handleTicker({ price: 50000, bid: 49990, ask: 50010 });
    await new Promise(r => setTimeout(r, 100));

    const initialState = eng.getState();
    const initialLadderOrders = initialState.position.pendingLadderOrders;
    assert.ok(initialLadderOrders.length > 0, 'Ladder orders should be placed');
    const initialLadderCount = initialLadderOrders.length;

    // Pick the top rung (highest price among ladder levels)
    const topRung = initialLadderOrders.reduce((highest, o) => (o.price > highest.price ? o : highest), initialLadderOrders[0]);
    assert.ok(topRung.price > 0, 'Top rung should have a valid price');

    // Feed a ticker at the top rung price to fill it
    eng._test.handleTicker({
      price: topRung.price,
      bid: topRung.price - 5,
      ask: topRung.price + 5,
    });
    await new Promise(r => setTimeout(r, 100));

    const stateAfterFill = eng.getState();

    // The filled rung should be removed from pending ladder orders
    assert.equal(
      stateAfterFill.position.pendingLadderOrders.length,
      initialLadderCount - 1,
      'Pending ladder orders count should decrease by 1'
    );
    assert.ok(
      !stateAfterFill.position.pendingLadderOrders.some(o => o.orderId === topRung.orderId),
      'Filled rung must no longer be in pending ladder orders'
    );
    assert.equal(stateAfterFill.orders.ladderEntries, initialLadderCount - 1);

    // Position state should record the buy fill
    assert.equal(stateAfterFill.position.cycleBuys, 1, 'cycleBuys should increment');
    assert.equal(stateAfterFill.position.lastEntryPrice, topRung.price);

    // A celestial body should be created for the filled buy
    const bodies = stateAfterFill.position.celestialBodies;
    assert.ok(Array.isArray(bodies) && bodies.length > 0, 'Celestial body should be created');
    const body = bodies[0];
    assert.equal(body.assetQty, topRung.assetQty);
    assert.ok(body.tpOrderId, 'Body should have a TP order placed');

    // Body order count should be 1
    assert.equal(stateAfterFill.orders.bodies, 1, 'Body count should be 1');
  });
});
