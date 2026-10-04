// @ts-check
// issue #963 — an accepted DCA market buy must stay owned until its fill is
// known.
//
// placeWithUnknownReconcile used to release the dispatch intent on acceptance,
// and executeDailyBuy then polled the fill. A rejected status read (or an
// exhausted poll) threw out of the cycle before anything was booked: no
// lastRunId, no allocation, no tracked order, no intent — so the next call in
// the same interval bought again, and a buy that did execute was invisible to
// DCA accounting and sell recovery.
//
// These tests drive the real cycle, order manager, placement-intent store and
// state tracker against temporary fund data and a stub adapter. Nothing touches
// a live exchange.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const orderManager = require('../src/order-manager');
const stateTracker = require('../src/state-tracker');
const adapters = require('../src/adapters');
const logger = require('../src/logger');
const { getRunIdentifier } = require('../src/interval-utils');

const DCA_ENGINE = require.resolve('../src/dca-engine');
const EXCHANGE_ROUTES = require.resolve('../src/routes/exchange-routes');
const LEGACY_ROUTES = require.resolve('../src/routes/legacy-routes');

const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const PRICE = 50000;

/** @type {string} */
let tmpDir;
/** @type {Object} */
let originals;
/** @type {Object} */
let fundConfig;
/** @type {typeof import('../src/dca-engine')} */
let dcaEngine;
/** @type {ReturnType<typeof makeExchange>} */
let exchange;

const stateFile = () => path.join(tmpDir, EXCHANGE, PAIR, 'state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const readIntents = () => stateTracker.loadPlacementIntents(EXCHANGE, PAIR);

/** Seed a fund's state.json in the per-fund layout. */
const seedState = (extra = {}) => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({
    ...stateTracker.createInitialState(fundConfig),
    ...extra,
  }, null, 2));
};

/**
 * A stub exchange whose order-status endpoint can be scripted per test.
 * `statusMode`: 'reject' (outage), 'open' (never terminal), 'filled',
 * 'cancelled' (terminal zero fill).
 */
const makeExchange = () => {
  const ex = {
    statusMode: 'reject',
    placedBuys: /** @type {Array<{productId: string, amount: number}>} */ ([]),
    statusReads: 0,
    adapter: {
      name: EXCHANGE,
      getCurrentPrice: async () => PRICE,
      getAccountBalance: async () => ({ available: 100000, hold: 0 }),
      placeMarketBuy: async (productId, amount) => {
        ex.placedBuys.push({ productId, amount });
        return { success: true, orderId: `buy-${ex.placedBuys.length}`, clientOrderId: `coid-${ex.placedBuys.length}` };
      },
      getOrder: async (orderId) => {
        ex.statusReads += 1;
        if (ex.statusMode === 'reject') throw new Error('503 Service Unavailable');
        if (ex.statusMode === 'open') return { orderId, status: 'OPEN', filledSize: 0, filledValue: 0, averageFilledPrice: 0 };
        if (ex.statusMode === 'cancelled') return { orderId, status: 'CANCELLED', filledSize: 0, filledValue: 0, averageFilledPrice: 0 };
        return { orderId, status: 'FILLED', filledSize: 0.0019, filledValue: 99.5, averageFilledPrice: 52368.42 };
      },
      getOrderFillSummary: async () => ({ totalFees: 0.6, totalRebates: 0.1, netFees: 0.5, fills: [] }),
    },
  };
  return ex;
};

/** Re-require the engine, as a restarted process would. */
const restartEngine = () => {
  delete require.cache[DCA_ENGINE];
  dcaEngine = require('../src/dca-engine');
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-pending-buy-'));
  exchange = makeExchange();
  fundConfig = {
    productId: PAIR,
    totalAllocation: 1000,
    maxBuyPrice: 200000,
    enabled: true,
    dryRun: false,
    dcaStrategy: 'fixed',
    fibBaseAmount: 10,
    intervalType: 'daily',
    intervalsToSpread: 10,
    minOrderSize: 1,
    holdbackPercent: 10,
    sellMarkupPercent: 2,
    consolidateAfterOrders: 0,
    consolidateInterval: 'never',
  };

  originals = {
    getExchangeDataDir: migration.getExchangeDataDir,
    getFundConfig: configUtils.getFundConfig,
    getDefaultPair: configUtils.getDefaultPair,
    getAdapter: adapters.getAdapter,
    placeSellOrderWithRetry: orderManager.placeSellOrderWithRetry,
    placeFibonacciSellOrder: orderManager.placeFibonacciSellOrder,
    checkFilledOrders: orderManager.checkFilledOrders,
    saveState: stateTracker.saveState,
    logBuy: logger.logBuy,
    logSellOrder: logger.logSellOrder,
    logFibBuy: logger.logFibBuy,
    logFibSellOrder: logger.logFibSellOrder,
    buyPoll: { ...orderManager.BUY_FILL_POLL },
    resumePoll: { ...orderManager.PENDING_BUY_RESUME_POLL },
  };

  migration.getExchangeDataDir = (ex) => {
    const dir = path.join(tmpDir, ex);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  configUtils.getDefaultPair = () => PAIR;
  configUtils.getFundConfig = () => ({ ...fundConfig });
  adapters.getAdapter = () => exchange.adapter;

  // Sells are not under test; the buy-side money move and its accounting are.
  orderManager.placeSellOrderWithRetry = async (_config, buyDetails) => ({
    orderId: `sell-for-${buyDetails.orderId}`,
    success: true,
    baseSize: buyDetails.assetAmount * 0.9,
    limitPrice: buyDetails.price * 1.02,
  });
  orderManager.placeFibonacciSellOrder = async (_config, cumulativeAsset, avgCostBasis) => ({
    sellOrder: { orderId: 'fib-sell-1', success: true, baseSize: cumulativeAsset * 0.9, limitPrice: avgCostBasis * 1.02 },
    sellQuantity: cumulativeAsset * 0.9,
    holdbackAsset: cumulativeAsset * 0.1,
  });
  orderManager.checkFilledOrders = async () => [];
  orderManager.BUY_FILL_POLL.delayMs = 0;
  orderManager.PENDING_BUY_RESUME_POLL.delayMs = 0;

  logger.logBuy = () => {};
  logger.logSellOrder = () => {};
  logger.logFibBuy = () => {};
  logger.logFibSellOrder = () => {};

  restartEngine();
});

afterEach(() => {
  migration.getExchangeDataDir = originals.getExchangeDataDir;
  configUtils.getFundConfig = originals.getFundConfig;
  configUtils.getDefaultPair = originals.getDefaultPair;
  adapters.getAdapter = originals.getAdapter;
  orderManager.placeSellOrderWithRetry = originals.placeSellOrderWithRetry;
  orderManager.placeFibonacciSellOrder = originals.placeFibonacciSellOrder;
  orderManager.checkFilledOrders = originals.checkFilledOrders;
  stateTracker.saveState = originals.saveState;
  logger.logBuy = originals.logBuy;
  logger.logSellOrder = originals.logSellOrder;
  logger.logFibBuy = originals.logFibBuy;
  logger.logFibSellOrder = originals.logFibSellOrder;
  Object.assign(orderManager.BUY_FILL_POLL, originals.buyPoll);
  Object.assign(orderManager.PENDING_BUY_RESUME_POLL, originals.resumePoll);
  delete require.cache[DCA_ENGINE];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Assert the fund booked nothing and still owns exactly `orderId`. */
const assertPendingOnly = (orderId) => {
  const state = readState();
  assert.equal(state.pendingDcaBuy?.orderId, orderId, 'the accepted order must stay owned');
  assert.equal(state.lastRunId, null, 'no guessed booking');
  assert.equal(state.totalAllocated, 0);
  assert.deepEqual(state.orders, []);
};

describe('accepted buy followed by a failed status read (issue #963)', () => {
  it('returns a pending recovery outcome and retains the accepted order durably', async () => {
    seedState();
    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(result.status, 'buy_fill_pending');
    assert.equal(result.pendingBuy.orderId, 'buy-1');
    assert.equal(result.pendingBuy.clientOrderId, 'coid-1');
    assert.equal(result.pendingBuy.runId, getRunIdentifier('daily'));
    assert.equal(result.pendingBuy.requestedUsdc, 100);
    assert.match(result.message, /awaiting fill recovery/);
    assert.match(result.message, /second buy has been withheld/);
    assert.match(result.message, /resumes this same order/);

    assertPendingOnly('buy-1');
    assert.match(readState().pendingDcaBuy.lastError, /503/);
    assert.deepEqual(readIntents(), [], 'ownership moved to the pending record; the dispatch intent is released');
  });

  it('submits no second buy on repeated calls in the same interval or after a restart', async () => {
    seedState();
    await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    const second = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    restartEngine();
    const third = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(exchange.placedBuys.length, 1, 'exactly one buy reached the exchange');
    assert.equal(second.status, 'buy_fill_pending');
    assert.equal(third.status, 'buy_fill_pending');
    assert.equal(third.pendingBuy.orderId, 'buy-1');
    assertPendingOnly('buy-1');
    assert.equal(readState().pendingDcaBuy.statusChecks, 3);
  });

  it('keeps an exhausted fill poll recoverable instead of freeing the fund', async () => {
    seedState();
    exchange.statusMode = 'open';
    const first = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    const second = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(first.status, 'buy_fill_pending');
    assert.match(first.error, /no terminal status after 10 attempt/);
    assert.equal(second.status, 'buy_fill_pending');
    assert.equal(exchange.placedBuys.length, 1);
    assertPendingOnly('buy-1');
  });

  it('books the original order once, with actual fill and fees, when status returns (fixed)', async () => {
    seedState();
    await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    exchange.statusMode = 'filled';

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(result.status, 'success');
    assert.equal(result.recoveredPendingBuy.orderId, 'buy-1');
    assert.equal(exchange.placedBuys.length, 1, 'recovery must not buy again for the same interval');
    const state = readState();
    assert.equal(state.pendingDcaBuy, undefined, 'pending retired in the booking save');
    assert.equal(state.totalAllocated, 99.5, 'actual filled value, not the requested amount');
    assert.equal(state.netFees, 0.5);
    assert.equal(state.totalIntervalsRun, 1);
    assert.equal(state.lastRunId, getRunIdentifier('daily'));
    assert.equal(state.orders.length, 1);
    assert.equal(state.orders[0].buyOrderId, 'buy-1');
    assert.equal(state.orders[0].buyQuantity, 0.0019);
    assert.equal(state.orders[0].runId, getRunIdentifier('daily'));
    assert.equal(state.orders[0].status, 'pending', 'the recovered buy is covered by a sell');

    const again = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    assert.equal(again.status, 'already_ran');
    assert.equal(readState().totalAllocated, 99.5, 'never credited twice');
  });

  it('books the original order once when status returns (Fibonacci)', async () => {
    fundConfig.dcaStrategy = 'fibonacci';
    seedState();
    const pending = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    assert.equal(pending.status, 'buy_fill_pending');
    assert.equal(readState().pendingDcaBuy.strategy, 'fibonacci');
    assert.equal(readState().fibPosition, 0, 'no guessed Fibonacci booking');

    exchange.statusMode = 'filled';
    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(result.status, 'success');
    assert.equal(exchange.placedBuys.length, 1);
    const state = readState();
    assert.equal(state.pendingDcaBuy, undefined);
    assert.equal(state.fibPosition, 1);
    assert.equal(state.fibCumulativeAsset, 0.0019);
    assert.equal(state.fibCumulativeCost, 100, 'filled value + net fees');
    assert.equal(state.totalAllocated, 99.5);
    assert.equal(state.lastRunId, getRunIdentifier('daily'));
    assert.equal(state.fibActiveSellOrderId, 'fib-sell-1');
    assert.deepEqual(state.bookedDcaBuyOrderIds, ['buy-1']);
  });

  it('books a buy recovered in a later interval under its ORIGINAL interval', async () => {
    seedState({
      pendingDcaBuy: {
        orderId: 'old-buy', clientOrderId: 'coid-old', requestedUsdc: 100,
        runId: 'daily-2000-01-01', intervalType: 'daily', strategy: 'fixed',
        acceptedAt: '2000-01-01T00:00:00.000Z', statusChecks: 2, lastError: '503',
      },
    });
    exchange.statusMode = 'filled';
    // Keep the current interval from buying so the recovered booking is observable.
    fundConfig.maxBuyPrice = 1;

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(result.status, 'price_too_high');
    assert.equal(exchange.placedBuys.length, 0);
    const state = readState();
    assert.equal(state.pendingDcaBuy, undefined);
    assert.equal(state.lastRunId, 'daily-2000-01-01');
    assert.equal(state.orders[0].runId, 'daily-2000-01-01');
    assert.equal(state.orders[0].buyOrderId, 'old-buy');
  });

  it('releases a confirmed terminal zero-fill order without fabricating a purchase', async () => {
    seedState();
    await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    exchange.statusMode = 'cancelled';
    // A fresh buy after the release must itself complete for the cycle to finish.
    let reads = 0;
    const getOrder = exchange.adapter.getOrder;
    exchange.adapter.getOrder = async (orderId) => {
      reads += 1;
      if (orderId === 'buy-2') exchange.statusMode = 'filled';
      return getOrder(orderId);
    };

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.ok(reads > 0);
    assert.equal(result.status, 'success');
    assert.equal(exchange.placedBuys.length, 2, 'the released interval may buy');
    const state = readState();
    assert.equal(state.pendingDcaBuy, undefined);
    assert.deepEqual(state.orders.map(o => o.buyOrderId), ['buy-2'], 'buy-1 was never booked');
  });

  it('treats a first-poll terminal zero fill as a definitive non-purchase and releases ownership', async () => {
    seedState();
    exchange.statusMode = 'cancelled';
    await assert.rejects(() => dcaEngine.runIntervalCycle(EXCHANGE, PAIR), /was CANCELLED/);
    const state = readState();
    assert.equal(state.pendingDcaBuy, undefined);
    assert.equal(state.totalAllocated, 0);
    assert.deepEqual(readIntents(), []);
  });
});

describe('handoff and bookkeeping failure boundaries (issue #963)', () => {
  it('a failed accepted-buy handoff leaves a blocking dispatch intent, never a rejection', async () => {
    seedState();
    let saves = 0;
    stateTracker.saveState = (...args) => {
      saves += 1;
      if (saves === 1) throw new Error('ENOSPC: no space left on device');
      return originals.saveState(...args);
    };

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(result.status, 'placement_unresolved');
    assert.equal(result.orderId, 'buy-1');
    assert.match(result.message, /accepted by the exchange/);
    assert.equal(exchange.statusReads, 0, 'the fill is not polled without an owner');

    const intents = readIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, 'unresolved');
    assert.equal(intents[0].orderId, 'buy-1');
    assert.equal(intents[0].clientOrderId, 'coid-1');
    assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 1);

    const again = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    assert.equal(again.status, 'placement_unresolved');
    assert.equal(exchange.placedBuys.length, 1, 'no replacement buy');
  });

  it('a failure during final bookkeeping neither double-credits nor buys again', async () => {
    seedState();
    await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    exchange.statusMode = 'filled';

    stateTracker.saveState = () => { throw new Error('EIO: i/o error'); };
    await assert.rejects(() => dcaEngine.runIntervalCycle(EXCHANGE, PAIR), /EIO/);
    stateTracker.saveState = originals.saveState;
    assertPendingOnly('buy-1');

    restartEngine();
    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);
    assert.equal(result.status, 'success');
    const state = readState();
    assert.equal(state.totalAllocated, 99.5);
    assert.equal(state.orders.length, 1);
    assert.equal(exchange.placedBuys.length, 1);
  });

  it('a pending record for an already-booked buy is retired without a second credit', async () => {
    const config = { ...fundConfig };
    const booked = stateTracker.createInitialState(config);
    stateTracker.bookDcaBuy(booked, {
      orderId: 'old-buy', price: 52368.42, assetAmount: 0.0019, usdcAmount: 99.5, fees: 0.6, rebates: 0.1, netFees: 0.5,
    }, config, { strategy: 'fixed', runId: 'daily-2000-01-01' });
    booked.orders[0].status = 'pending';
    // A stale pending record for the same order (as if retiring it had been lost).
    seedState({ ...booked, pendingDcaBuy: { orderId: 'old-buy', runId: 'daily-2000-01-01', requestedUsdc: 100 } });
    exchange.statusMode = 'filled';

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, PAIR);

    assert.equal(result.status, 'success');
    const state = readState();
    assert.equal(state.pendingDcaBuy, undefined);
    assert.equal(state.orders.filter(o => o.buyOrderId === 'old-buy').length, 1, 'never booked twice');
    assert.equal(state.totalAllocated, 199, 'the old buy once + this interval\'s new buy');
    assert.equal(exchange.placedBuys.length, 1);
  });
});

describe('state-tracker pending-buy helpers (issue #963)', () => {
  const config = { productId: PAIR, totalAllocation: 1000, intervalsToSpread: 10, intervalType: 'daily', holdbackPercent: 10 };
  const fill = { orderId: 'b1', price: 50000, assetAmount: 0.002, usdcAmount: 100, fees: 0.2, rebates: 0, netFees: 0.2 };

  it('bookDcaBuy books once and retires the pending record in the same mutation', () => {
    const state = stateTracker.createInitialState(config);
    stateTracker.recordPendingDcaBuy(state, { orderId: 'b1', requestedUsdc: 100, runId: 'daily-x' });

    assert.equal(stateTracker.bookDcaBuy(state, fill, config, { strategy: 'fixed', runId: 'daily-x' }), true);
    assert.equal(state.pendingDcaBuy, undefined);
    assert.equal(state.lastRunId, 'daily-x');
    assert.equal(state.totalAllocated, 100);

    assert.equal(stateTracker.bookDcaBuy(state, fill, config, { strategy: 'fixed', runId: 'daily-x' }), false);
    assert.equal(state.totalAllocated, 100);
    assert.equal(state.orders.length, 1);
  });

  it('recognises buys booked before the booked-id history existed', () => {
    const state = stateTracker.createInitialState(config);
    stateTracker.recordBuyFill(state, fill, config);
    delete state.bookedDcaBuyOrderIds;
    assert.equal(stateTracker.isDcaBuyBooked(state, 'b1'), true);
  });

  it('a retained intent blocks this process even while its row reads as our own dispatch', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retain-intent-'));
    const prev = migration.getExchangeDataDir;
    migration.getExchangeDataDir = () => tmp;
    try {
      const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: PAIR, action: 'dca_buy' });
      assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 0, 'own in-flight dispatch does not block');
      stateTracker.retainPlacementIntentInProcess(intent.id);
      assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 1);
      stateTracker.resolvePlacementIntent(EXCHANGE, PAIR, intent.id);
      assert.equal(stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR).length, 0);
    } finally {
      migration.getExchangeDataDir = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('trade endpoints distinguish pending recovery from rejection (issue #963)', () => {
  const createFakeApp = () => {
    const handlers = {};
    const register = (method) => (route, handler) => { handlers[`${method} ${route}`] = handler; };
    return { handlers, get: register('GET'), put: register('PUT'), patch: register('PATCH'), post: register('POST'), delete: register('DELETE') };
  };
  const invoke = async (app, key, req = {}) => {
    const res = {
      statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await app.handlers[key]({ body: {}, params: {}, query: {}, ...req }, res);
    return res;
  };

  /** Register a route module with runIntervalCycle stubbed to `result`. */
  const withStubbedCycle = (routesPath, result) => {
    const engine = require('../src/dca-engine');
    const saved = { runIntervalCycle: engine.runIntervalCycle, getGlobalConfig: configUtils.getGlobalConfig, resolveConfiguredPair: configUtils.resolveConfiguredPair };
    engine.runIntervalCycle = async () => ({ pair: PAIR, ...result });
    configUtils.getGlobalConfig = () => ({ ...saved.getGlobalConfig(), simpleDcaEnabled: true });
    configUtils.resolveConfiguredPair = () => ({ pair: PAIR, error: null });
    delete require.cache[routesPath];
    delete require.cache[require.resolve('../src/routes/route-utils')];
    const app = createFakeApp();
    require(routesPath)(app, {
      exchangeIPCMap: {},
      parseTSV: () => [],
      calculateCostBasis: () => ({}),
      getNextTradeInfo: () => ({}),
    });
    return {
      app,
      restore: () => {
        engine.runIntervalCycle = saved.runIntervalCycle;
        configUtils.getGlobalConfig = saved.getGlobalConfig;
        configUtils.resolveConfiguredPair = saved.resolveConfiguredPair;
        delete require.cache[routesPath];
        delete require.cache[require.resolve('../src/routes/route-utils')];
      },
    };
  };

  const pending = {
    status: 'buy_fill_pending',
    pendingBuy: { orderId: 'buy-1', runId: 'daily-x' },
    message: 'Buy order buy-1 (interval daily-x) was accepted by the exchange … awaiting fill recovery and a second buy has been withheld.',
  };

  for (const [label, routesPath, key, req] of [
    ['POST /api/:exchange/trade', EXCHANGE_ROUTES, 'POST /api/:exchange/trade', { params: { exchange: EXCHANGE } }],
    ['POST /api/trade (legacy)', LEGACY_ROUTES, 'POST /api/trade', {}],
  ]) {
    it(`${label} answers 202 with the pending order and recovery message`, async () => {
      const { app, restore } = withStubbedCycle(routesPath, pending);
      try {
        const res = await invoke(app, key, req);
        assert.equal(res.statusCode, 202);
        assert.equal(res.body.status, 'buy_fill_pending');
        assert.equal(res.body.pendingBuy.orderId, 'buy-1');
        assert.match(res.body.message, /awaiting fill recovery/);
      } finally {
        restore();
      }
    });

    it(`${label} keeps 200 for a completed cycle`, async () => {
      const { app, restore } = withStubbedCycle(routesPath, { status: 'success' });
      try {
        const res = await invoke(app, key, req);
        assert.equal(res.statusCode, 200);
      } finally {
        restore();
      }
    });
  }
});
