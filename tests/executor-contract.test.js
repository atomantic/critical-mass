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
const { REQUIRED_EXECUTOR_METHODS, validateExecutor } = require('../src/executor-contract');
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

  it('test-only accessors live under _test, not on the executor contract (issue #1611)', () => {
    const adapter = makeMockAdapter();
    const liveExec = createOrderExecutor('coinbase', baseConfig(), adapter, TEST_PAIR, {}, TEST_PAIR);
    const dryRunExec = createDryRunExecutor('coinbase', baseConfig(), { lastPrice: 50000, regime: 'NEUTRAL' }, {}, TEST_PAIR);

    for (const method of ['getActiveTpOrderId', 'getBodyByTpOrderId']) {
      assert.ok(!REQUIRED_EXECUTOR_METHODS.includes(method), `${method} should not be contract-required`);
      assert.equal(liveExec[method], undefined, `Live executor exposes ${method} at top level`);
      assert.equal(dryRunExec[method], undefined, `Dry-run executor exposes ${method} at top level`);
      assert.equal(typeof liveExec._test[method], 'function', `Live executor missing _test.${method}`);
      assert.equal(typeof dryRunExec._test[method], 'function', `Dry-run executor missing _test.${method}`);
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

  it('isLadderOrder classifies ladder, entry, TP, unknown and settled ids identically on both executors', async () => {
    const adapter = makeMockAdapter({
      placeLimitBuy: async () => ({ success: true, orderId: `live-buy-${adapter.placeLimitBuy.calls++}` }),
      placeLimitSell: async () => ({ success: true, orderId: 'live-tp-1' }),
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    });
    adapter.placeLimitBuy.calls = 1;
    const liveExec = createOrderExecutor('coinbase', baseConfig(), adapter, TEST_PAIR, {}, TEST_PAIR);
    const dryRunExec = createDryRunExecutor('coinbase', baseConfig(), { lastPrice: 50000, regime: 'NEUTRAL' }, {}, TEST_PAIR);
    engines.push({ _test: { clearTimers: () => { liveExec.clearTimers(); dryRunExec.clearTimers(); } } });

    const place = async (exec) => {
      const { orders } = await exec.placeLadderOrders([{ index: 0, price: 49000, sizeUsdc: 100, assetQty: 0.002 }]);
      const entry = await exec.placeEntryBid(100, 50000, 50010);
      const tp = await exec.placeTakeProfitOrder(0.002, 52000, { forceUpdate: true });
      const settled = await exec.placeLadderOrders([{ index: 1, price: 48000, sizeUsdc: 100, assetQty: 0.002 }]);
      exec.handleOrderCancel(settled.orders[0].orderId);
      exec.markSettled(settled.orders[0].orderId);
      return {
        ladderId: orders[0].orderId,
        entryId: entry.orderId,
        tpId: tp.orderId,
        settledId: settled.orders[0].orderId,
      };
    };
    const live = await place(liveExec);
    const dry = await place(dryRunExec);
    assert.ok(live.entryId && live.tpId && dry.entryId && dry.tpId, 'fixtures must place every order kind');

    const classify = (exec, ids) => ({
      ladder: exec.isLadderOrder(ids.ladderId),
      entry: exec.isLadderOrder(ids.entryId),
      tp: exec.isLadderOrder(ids.tpId),
      unknown: exec.isLadderOrder('no-such-order'),
      settled: exec.isLadderOrder(ids.settledId),
    });
    const expected = { ladder: true, entry: false, tp: false, unknown: false, settled: false };
    assert.deepStrictEqual(classify(liveExec, live), expected, 'live executor');
    assert.deepStrictEqual(classify(dryRunExec, dry), expected, 'dry-run executor');
    assert.deepStrictEqual(classify(liveExec, live), classify(dryRunExec, dry));
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
  // of the executor contract, unless explicitly carved out below. The engine's
  // extracted sub-modules (src/regime-*.js) reach the executor through a
  // `getOrderExecutor()` accessor; startup recovery (issue #1601) is the only
  // caller of the restore* methods, so they count as engine calls too.
  const srcDir = path.join(__dirname, '..', 'src');
  const regimeEngineSource = fs.readdirSync(srcDir)
    .filter(name => /^regime-.*\.js$/.test(name))
    .map(name => fs.readFileSync(path.join(srcDir, name), 'utf8'))
    .join('\n');
  const calledByEngine = new Set(
    [...regimeEngineSource.matchAll(/(?:orderExecutor|getOrderExecutor\(\))\.([a-zA-Z]+)/g)].map(m => m[1])
  );

  // Issue #725 resolved every entry this allowlist used to carry; the remaining
  // test-only accessors moved under `_test` (issue #1611), so nothing is left to allowlist.
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

describe('Order Executor Contract - Order state policies', () => {
  const makeExecutor = (mode) => {
    const exec = mode === 'live'
      ? createOrderExecutor('coinbase', baseConfig(), makeMockAdapter(), TEST_PAIR, {}, TEST_PAIR)
      : createDryRunExecutor('coinbase', baseConfig(), { lastPrice: 50000, regime: 'NEUTRAL' }, {}, TEST_PAIR);
    engines.push({ _test: { clearTimers: exec.clearTimers } });
    return exec;
  };
  const order = (orderId, type, status = 'open', price = 50000) => ({
    orderId, type, status, side: type.endsWith('entry') ? 'buy' : 'sell',
    price, size: 0.002, sizeUsdc: price * 0.002, placedAt: 1000, staleMs: Infinity,
    ladderIndex: 2, filledAt: null, fillPrice: null,
  });

  for (const mode of ['live', 'dry-run']) {
    it(`${mode} keeps its count/filter policy, raw lookups, ladder ordering and entry references`, () => {
      const exec = makeExecutor(mode);
      const orders = [
        order('entry-open', 'entry'), order('entry-filled', 'entry', 'filled'),
        order('ladder-low', 'ladder_entry', 'open', 40000),
        order('ladder-closed', 'ladder_entry', 'cancelled', 49000),
        order('ladder-top', 'ladder_entry', 'open', 50000),
        order('tp-filled', 'take_profit', 'filled'), order('body-closed', 'body_tp', 'cancelled'),
      ];
      if (mode === 'live') {
        for (const item of orders) exec.restorePendingOrder(item.orderId, item);
      } else {
        exec.importState({ pendingOrders: orders });
      }
      assert.deepEqual(exec.getPendingCounts(), mode === 'live'
        ? { entries: 2, ladderEntries: 3, takeProfits: 1, bodies: 1, total: 7 }
        : { entries: 1, ladderEntries: 2, takeProfits: 0, bodies: 0, total: 7 });
      const entries = exec.getPendingEntries();
      assert.deepEqual([...entries.keys()], mode === 'live' ? ['entry-open', 'entry-filled'] : ['entry-open']);
      assert.equal(entries.get('entry-open'), orders[0], 'views retain the tracked order identity');
      entries.clear();
      assert.equal(exec.getPendingEntries().has('entry-open'), true, 'view map is independent');
      assert.deepEqual(exec.getPendingLadderOrders().map(o => o.orderId), mode === 'live'
        ? ['ladder-top', 'ladder-closed', 'ladder-low'] : ['ladder-top', 'ladder-low']);
      assert.deepEqual(exec.getPendingLadderOrders()[0], {
        orderId: 'ladder-top', price: 50000, size: 0.002, sizeUsdc: 100, ladderIndex: 2, placedAt: 1000,
      });
      assert.equal(exec.isLadderOrder('ladder-closed'), true, 'classification is independent of visibility');
      assert.equal(exec.getOrderPlacedAt('entry-filled'), 1000);
      assert.equal(exec.isTrackedTpOrder('tp-filled'), true, 'TP identity is independent of visibility');
      exec.handleOrderCancel('entry-open');
      exec.handleOrderCancel('entry-open');
      assert.equal(exec.getPendingCounts().total, 6);
      assert.equal(orders[0].status, mode === 'live' ? 'open' : 'cancelled');
    });

    it(`${mode} restores and removes body TP tracking with duplicate cancels and cleanup`, () => {
      const exec = makeExecutor(mode);
      exec.restoreBodyTpOrder('body-a', 'body-tp-a', 0.002, 52000, 1234);
      exec.restoreBodyTpOrder('body-b', 'body-tp-b', 0.003, 53000, 2345);
      assert.equal(exec.getPendingCounts().bodies, 2);
      assert.equal(exec.getOrderPlacedAt('body-tp-a'), 1234);
      assert.equal(exec.isBodyTpOrder('body-tp-a'), true);
      const body = exec._test.getBodyByTpOrderId('body-tp-a');
      assert.equal(body.bodyId, 'body-a');
      assert.equal(body.assetQty, 0.002);
      assert.equal(body.tpPrice, 52000);
      exec.handleOrderCancel('body-tp-a');
      exec.handleOrderCancel('body-tp-a');
      exec.removeBodyTracking('body-tp-a');
      assert.equal(exec.isBodyTpOrder('body-tp-a'), false);
      assert.equal(exec._test.getBodyByTpOrderId('body-tp-a'), null);
      assert.equal(exec.getPendingCounts().bodies, 1);
      exec.removeBodyTracking('body-tp-b');
      exec.removeBodyTracking('unknown');
      assert.equal(exec.getPendingCounts().total, 0);
    });
  }

  it('live remembers core TP settlements through duplicate fills and expires recognition after five minutes', (t) => {
    let now = 1000000;
    const errors = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'error', message => errors.push(message));
    const exec = makeExecutor('live');
    exec.restorePendingOrder('core-tp', order('core-tp', 'take_profit'));
    assert.equal(exec._test.getActiveTpOrderId(), 'core-tp');
    exec.handleOrderFill('core-tp');
    exec.handleOrderFill('core-tp');
    assert.equal(exec._test.getActiveTpOrderId(), null);
    assert.equal(exec.getPendingCounts().total, 0);
    assert.equal(exec.isTrackedTpOrder('core-tp'), true);
    assert.equal(exec.isTrackedTpOrder('foreign-sell'), false);
    exec.markSettled('offline-tp', 'take_profit');
    exec.markSettled('offline-entry', 'entry');
    assert.equal(exec.isTrackedTpOrder('offline-tp'), true);
    assert.equal(exec.isTrackedTpOrder('offline-entry'), false);
    now += 5 * 60 * 1000;
    assert.equal(exec.isTrackedTpOrder('core-tp'), false);
    assert.equal(exec.isTrackedTpOrder('offline-tp'), false);
    exec.restoreBodyTpOrder('body-a', 'body-tp-a', 0.002, 52000);
    exec.handleOrderFill('body-tp-a');
    exec.handleOrderFill('body-tp-a');
    assert.equal(exec.isBodyTpOrder('body-tp-a'), false);
    assert.equal(exec.getPendingCounts().total, 0);
    assert.equal(exec.isTrackedTpOrder('body-tp-a'), false);
    assert.deepEqual(errors, [], 'duplicate cleanup must not warn about settled orders');
    exec.handleOrderFill('foreign-sell');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /WS fill for untracked order foreign-sell/);
  });

  it('dry-run keeps external fills/restore/settlement as no-ops and retains simulation persistence and reset', async () => {
    const exec = makeExecutor('dry-run');
    exec.restorePendingOrder('external', order('external', 'entry'));
    assert.equal(exec.getPendingCounts().total, 0);
    const entry = await exec.placeEntryBid(100, 50000, 50010);
    const tp = await exec.placeTakeProfitOrder(0.002, 52000, { forceUpdate: true });
    exec.restoreBodyTpOrder('body-a', 'body-tp-a', 0.003, 53000, 1234);
    exec.handleOrderFill(entry.orderId);
    exec.handleOrderFill(tp.orderId);
    exec.handleOrderFill('body-tp-a');
    exec.markSettled('offline-tp', 'take_profit');
    assert.equal(exec.getPendingCounts().total, 3);
    assert.equal(exec.isTrackedTpOrder('offline-tp'), false);
    assert.equal(exec._test.getActiveTpOrderId(), tp.orderId);
    assert.equal(exec.getFilledOrders().length, 0);
    const state = exec.exportState();
    const restored = makeExecutor('dry-run');
    restored.importState(state);
    assert.deepEqual(restored.exportState(), state);
    assert.equal(restored._test.getActiveTpOrderId(), tp.orderId);
    assert.equal(restored._test.getBodyByTpOrderId('body-tp-a').bodyId, 'body-a');
    restored.checkEntryFills(49000);
    restored.checkTpFills(54000);
    assert.equal(restored.getPendingCounts().total, 0);
    assert.equal(restored.getFilledOrders().length, 3);
    assert.equal(restored._test.getActiveTpOrderId(), null);
    assert.equal(restored.isTrackedTpOrder(tp.orderId), false, 'simulation does not retain live settlement memory');
    assert.equal(restored.isBodyTpOrder('body-tp-a'), false);
    restored.importState(state);
    restored.resetDryRunState();
    assert.deepEqual(restored.getPendingCounts(), { entries: 0, ladderEntries: 0, takeProfits: 0, bodies: 0, total: 0 });
    assert.equal(restored._test.getActiveTpOrderId(), null);
    assert.equal(restored.isBodyTpOrder('body-tp-a'), false);
    assert.equal(restored.getFilledOrders().length, 0);
    assert.deepEqual(restored.exportState().bodyTpOrders, []);
  });
});
