// @ts-check
const { describe, it, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-executor-contract-test');

// Neutralize updateRegimeConfig before requiring regime-engine to avoid writing data/config.json
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const logger = require('../src/logger');
const { REQUIRED_EXECUTOR_METHODS, TEST_ONLY_EXECUTOR_METHODS, validateExecutor } = require('../src/executor-contract');
const { createOrderExecutor } = require('../src/order-executor');
const { createDryRunExecutor } = require('../src/dry-run-executor');
const { createRegimeEngine } = require('../src/regime-engine');

// A SENTINEL pair, never a real one. Constructing an executor/engine for a pair
// writes per-fund state, so the suite binds it to a disposable temp root. This
// file used 'BTC-USDC', the production Coinbase fund, and its cleanup destroyed
// that fund's real fill-ledger.json, regime-state.json and closed-trades.json on
// every `npm test` before anyone connected the two. Match the sibling suites
// (__test201__, __testpartial__) and keep the name impossible to confuse with a
// real pair.
const TEST_PAIR = '__testexec__';
const JUNK_DIR = isolatedData.fundDir('coinbase', TEST_PAIR);

const engines = [];

after(() => {
  for (const eng of engines) {
    if (eng._test?.clearTimers) eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
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
    assert.ok(REQUIRED_EXECUTOR_METHODS.length >= 21);

    const expectedMethods = [
      'placeEntryBid',
      'placeTakeProfitOrder',
      'cancelTpOrder',
      'cancelAllEntries',
      'handleOrderFill',
      'handleOrderCancel',
      'getPendingCounts',
      'getPendingEntries',
      'restorePendingOrder',
      'markSettled',
      'getOrderPlacedAt',
      'placeBodyTpOrder',
      'cancelBodyTpOrder',
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

  it('TEST_ONLY_EXECUTOR_METHODS are implemented by both executors but not contract-required (issue #725)', () => {
    // checkInvariants, getSummary (executor's own) and clearPendingOrders had
    // zero production callers AND zero method-specific test coverage — #678's
    // pattern applied cleanly, so they were deleted outright (see git history
    // for issue #725). getActiveTpOrderId/isBodyTpOrder/getBodyByTpOrderId
    // also have zero production callers, but unlike those three they carry
    // real, still-valuable test coverage (TP-placement concurrency safety;
    // the #133/#213E dry-run cost-basis regression suite) with no clean
    // production-path substitute, so they stay implemented and exported —
    // just no longer part of the required contract. This guards both
    // directions: silently deleting one of them breaks this test, and
    // silently re-adding one to REQUIRED_EXECUTOR_METHODS without wiring it
    // into regime-engine.js (or allowlisting it) fails the next test below.
    assert.ok(Array.isArray(TEST_ONLY_EXECUTOR_METHODS));
    assert.deepEqual([...TEST_ONLY_EXECUTOR_METHODS].sort(), ['getActiveTpOrderId', 'getBodyByTpOrderId', 'isBodyTpOrder']);

    const adapter = makeMockAdapter();
    const liveExec = createOrderExecutor('coinbase', baseConfig(), adapter, TEST_PAIR, {}, TEST_PAIR);
    const dryRunExec = createDryRunExecutor('coinbase', baseConfig(), { lastPrice: 50000, regime: 'NEUTRAL' }, {}, TEST_PAIR);

    for (const method of TEST_ONLY_EXECUTOR_METHODS) {
      assert.ok(!REQUIRED_EXECUTOR_METHODS.includes(method), `${method} should not be contract-required`);
      assert.equal(typeof liveExec[method], 'function', `Live executor missing test-only method: ${method}`);
      assert.equal(typeof dryRunExec[method], 'function', `Dry-run executor missing test-only method: ${method}`);
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

describe('Required methods stay live-called (issue #678)', () => {
  // `refreshStaleOrders`, `atomicReplace` and `cancelAllBodyTpOrders` were
  // required by this contract and implemented (with drifted, stale-fixed
  // behavior) in both executors, but nothing in src/ or scripts/ ever called
  // them — only this test file and order-executor.test.js did. This test
  // guards against that recurring: every REQUIRED_EXECUTOR_METHODS entry
  // must be reachable from src/regime-engine.js, the only production caller
  // of the executor contract, unless explicitly carved out below.
  const regimeEngineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'regime-engine.js'), 'utf8');
  const calledByEngine = new Set(
    [...regimeEngineSource.matchAll(/orderExecutor\.([a-zA-Z]+)/g)].map(m => m[1])
  );

  // Issue #725 resolved every entry this allowlist used to carry:
  // checkInvariants/getSummary/clearPendingOrders had zero production callers
  // AND zero method-specific test coverage, so they were deleted outright
  // (#678's pattern applied cleanly). getActiveTpOrderId/isBodyTpOrder/
  // getBodyByTpOrderId also had zero production callers, but carried real
  // test coverage with no clean production-path substitute (TP-placement
  // concurrency safety; the #133/#213E dry-run cost-basis regression suite),
  // so instead of deleting them they were dropped from
  // REQUIRED_EXECUTOR_METHODS entirely and moved to TEST_ONLY_EXECUTOR_METHODS
  // (see the test above) — they stay implemented and test-only, but are no
  // longer part of this contract, so there is nothing left to allowlist here.
  // This allowlist exists so a FUTURE required-but-truly-unused method fails
  // this test loudly instead of silently drifting. Pin the exact (now empty)
  // set; growing it silently defeats the guard — a new entry should first be
  // wired into regime-engine.js, or handled the way #725 handled these six.
  const ALLOWED_UNCALLED_BY_ENGINE = new Set([]);

  it('every REQUIRED_EXECUTOR_METHODS entry is called by regime-engine.js or explicitly allowlisted', () => {
    const unexplained = REQUIRED_EXECUTOR_METHODS.filter(
      method => !calledByEngine.has(method) && !ALLOWED_UNCALLED_BY_ENGINE.has(method)
    );
    assert.deepEqual(
      unexplained,
      [],
      `REQUIRED_EXECUTOR_METHODS contains methods regime-engine.js never calls and that ` +
      `are not in ALLOWED_UNCALLED_BY_ENGINE: ${unexplained.join(', ')}. Either wire them ` +
      `into regime-engine.js, add them to the allowlist with a reason, or delete them from ` +
      `the contract (see issue #678).`
    );
  });

  it('the allowlist does not carry a method that regime-engine.js actually DOES call', () => {
    // Keeps the allowlist honest — a method that's since been wired up
    // should be dropped from it rather than left as a stale exception.
    const staleAllowlistEntries = [...ALLOWED_UNCALLED_BY_ENGINE].filter(method => calledByEngine.has(method));
    assert.deepEqual(
      staleAllowlistEntries,
      [],
      `These ALLOWED_UNCALLED_BY_ENGINE entries are now called by regime-engine.js — remove them from the allowlist: ${staleAllowlistEntries.join(', ')}`
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
