// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reconcileAwaitingSells } = require('../src/dca-engine');
const { createInitialState, recordBuyFill, getPendingOrders } = require('../src/state-tracker');
const stateTracker = require('../src/state-tracker');
const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const orderManager = require('../src/order-manager');
const adapters = require('../src/adapters');
const logger = require('../src/logger');

// ---------------------------------------------------------------------------
// issue #129 — recover durable 'awaiting_sell' rows after a crash between the
// buy-save (recordBuyFill, issue #106) and sell placement. Such rows are
// invisible to getPendingOrders (status filter) and previously had no recovery
// path. reconcileAwaitingSells, run at the top of the cycle before any new buy,
// re-attempts the sell via the same placeSellOrderWithRetry path and either
// promotes the row to 'pending' (sell placed) or marks it 'sell_failed'.
// ---------------------------------------------------------------------------

const config = {
  productId: 'BTC-USD',
  totalAllocation: 6000,
  intervalsToSpread: 60,
  intervalType: 'daily',
  holdbackPercent: 10,
  sellMarkupPercent: 5,
};

const makeBuy = (orderId) => ({
  orderId,
  assetAmount: 0.001,
  price: 100000,
  usdcAmount: 100,
  fees: 0.1,
  rebates: 0,
  netFees: 0.1,
});

// Build a state that has only durable awaiting_sell rows — the exact footprint
// a crash between recordBuyFill+saveState and attachSellOrder would leave.
const stateWithAwaitingSells = (buyOrderIds) => {
  const state = createInitialState(config);
  for (const id of buyOrderIds) {
    recordBuyFill(state, makeBuy(id), config);
  }
  // recordBuyFill leaves every row as awaiting_sell (no sell attached yet)
  assert.equal(state.orders.every(o => o.status === 'awaiting_sell'), true);
  return state;
};

describe('reconcileAwaitingSells (issue #129)', () => {
  it('no awaiting_sell rows → no-op, no adapter calls', async () => {
    const state = createInitialState(config);
    let placeCalls = 0;
    const adapter = {
      getCurrentPrice: async () => { placeCalls++; return 100000; },
      placeLimitSell: async () => { placeCalls++; return { success: true, orderId: 's' }; },
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');
    assert.deepEqual(result, { recovered: 0, failed: 0 });
    assert.equal(placeCalls, 0);
  });

  it('places the sell for an orphaned awaiting_sell row and promotes it to pending', async () => {
    const state = stateWithAwaitingSells(['buy-1']);
    const calls = [];
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async (productId, size, price) => {
        calls.push({ productId, size, price });
        return { success: true, orderId: 'sell-1', baseSize: size, limitPrice: price };
      },
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');

    assert.deepEqual(result, { recovered: 1, failed: 0 });
    assert.equal(calls.length, 1);
    // sell quantity = buyQuantity * (1 - holdback%) = 0.001 * 0.9
    assert.ok(Math.abs(calls[0].size - 0.0009) < 1e-9);
    // sell price = buyPrice * (1 + markup%) = 100000 * 1.05
    assert.ok(calls[0].price > 100000);

    const order = state.orders[0];
    assert.equal(order.status, 'pending');
    assert.equal(order.orderId, 'sell-1');
    assert.equal(getPendingOrders(state).length, 1);
    // outstanding sell totals committed by attachSellOrder
    assert.ok(Math.abs(state.outstandingOrdersAsset - 0.0009) < 1e-9);
  });

  it('sizes the recovery sell from the row, not a since-changed holdbackPercent', async () => {
    const state = stateWithAwaitingSells(['buy-1']);
    const sizes = [];
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async (productId, size, price) => {
        sizes.push(size);
        return { success: true, orderId: 'sell-1', baseSize: size, limitPrice: price };
      },
    };

    await reconcileAwaitingSells(state, { ...config, holdbackPercent: 50 }, adapter, 'coinbase');

    assert.ok(Math.abs(sizes[0] - state.orders[0].sellQuantity) < 1e-12);
    assert.ok(Math.abs(state.outstandingOrdersAsset - sizes[0]) < 1e-12);
  });

  it('marks the row sell_failed when placement keeps failing', async () => {
    const state = stateWithAwaitingSells(['buy-1']);
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async () => ({ success: false, errorMessage: 'exchange 500' }),
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');

    assert.deepEqual(result, { recovered: 0, failed: 1 });
    const order = state.orders[0];
    assert.equal(order.status, 'sell_failed');
    assert.ok(order.sellFailedReason);
    assert.ok(order.sellFailedAt);
    // No phantom sell committed
    assert.equal(state.outstandingOrdersAsset, 0);
    assert.equal(getPendingOrders(state).length, 0);
  });

  it('reconciles each row independently — one recovers, one fails', async () => {
    const state = stateWithAwaitingSells(['buy-ok', 'buy-bad']);
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async (productId, size, price) => {
        // Fail only the second buy's recovery by toggling on call order
        return adapter._calls++ === 0
          ? { success: true, orderId: 'sell-ok', baseSize: size, limitPrice: price }
          : { success: false, errorMessage: 'rejected' };
      },
      _calls: 0,
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');

    assert.equal(result.recovered, 1);
    assert.equal(result.failed, 1);
    const ok = state.orders.find(o => o.buyOrderId === 'buy-ok');
    const bad = state.orders.find(o => o.buyOrderId === 'buy-bad');
    assert.equal(ok.status, 'pending');
    assert.equal(bad.status, 'sell_failed');
  });
});

// ---------------------------------------------------------------------------
// issue #1035 — a 'sell_failed' row is terminal for the automatic paths:
// reconcileAwaitingSells selects only awaiting_sell and pending-order sync only
// pending, so a real bought quantity sat with no tracked sell and no operator
// exit. retryFailedSell finishes the ORIGINAL buy's sell without buying,
// booking or crediting again, and refuses whenever an earlier sell for the fund
// may be live.
//
// These drive the real engine, order manager (placeSellOrderWithRetry and the
// durable placement-intent funnel) and state tracker against temporary fund
// data and a stub adapter. Nothing touches a live exchange.
// ---------------------------------------------------------------------------

const DCA_ENGINE = require.resolve('../src/dca-engine');
const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
const PRICE = 50000;

describe('retryFailedSell (issue #1035)', () => {
  /** @type {string} */
  let tmpDir;
  /** @type {Object} */
  let originals;
  /** @type {Object} */
  let fundConfig;
  /** @type {any} */
  let engine;
  /** @type {any} */
  let ex;

  const stateFile = () => path.join(tmpDir, EXCHANGE, PAIR, 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  const writeState = (state) => fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  const readIntents = () => stateTracker.loadPlacementIntents(EXCHANGE, PAIR);
  /** Re-require the engine, as a restarted process would. */
  const restartEngine = () => {
    delete require.cache[DCA_ENGINE];
    engine = require('../src/dca-engine');
  };

  /**
   * Stub exchange. `sellMode`: 'reject' (definitive), 'accept', or 'unknown'
   * (ambiguous POST carrying a client id). `lookup`: what a client-order-id
   * lookup returns — 'throw', null (absent) or an order object.
   */
  const makeExchange = () => {
    const stub = {
      sellMode: 'reject',
      lookup: /** @type {any} */ ('throw'),
      /** @type {Promise<void>|null} */
      sellGate: null,
      placedBuys: 0,
      sellAttempts: /** @type {Array<{size: number, price: number}>} */ ([]),
      acceptedSells: 0,
      adapter: {
        name: EXCHANGE,
        getCurrentPrice: async () => PRICE,
        getAccountBalance: async () => ({ available: 100000, hold: 0 }),
        placeMarketBuy: async () => {
          stub.placedBuys += 1;
          return { success: true, orderId: `buy-${stub.placedBuys}`, clientOrderId: `buy-coid-${stub.placedBuys}` };
        },
        getOrder: async (orderId) => ({ orderId, status: 'FILLED', filledSize: 0.002, filledValue: 100, averageFilledPrice: PRICE }),
        getOrderFillSummary: async () => ({ totalFees: 0.5, totalRebates: 0, netFees: 0.5, fills: [] }),
        placeLimitSell: async (_productId, size, price) => {
          stub.sellAttempts.push({ size, price });
          if (stub.sellGate) await stub.sellGate;
          if (stub.sellMode === 'accept') {
            stub.acceptedSells += 1;
            return { success: true, orderId: `sell-${stub.acceptedSells}`, baseSize: size, limitPrice: price };
          }
          if (stub.sellMode === 'unknown') {
            const err = /** @type {any} */ (new Error('socket hang up'));
            err.unknownOutcome = true;
            err.clientOrderId = `sell-coid-${stub.sellAttempts.length}`;
            throw err;
          }
          return { success: false, errorMessage: 'INSUFFICIENT_FUND' };
        },
        findOrderByClientOrderId: async () => {
          if (stub.lookup === 'throw') throw new Error('lookup 503');
          return stub.lookup;
        },
      },
    };
    return stub;
  };

  /** Run a live cycle whose buy fills and whose covering sell fails. */
  const buyWithFailedSell = async (sellMode = 'reject') => {
    ex.sellMode = sellMode;
    const result = await engine.runIntervalCycle(EXCHANGE, PAIR);
    assert.equal(result.status, 'sell_placement_failed', JSON.stringify(result));
    const [row] = readState().orders;
    assert.equal(row.status, 'sell_failed');
    return row;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-sell-retry-'));
    ex = makeExchange();
    fundConfig = {
      productId: PAIR,
      totalAllocation: 1000,
      maxBuyPrice: 200000,
      enabled: true,
      dryRun: false,
      dcaStrategy: 'fixed',
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
      checkFilledOrders: orderManager.checkFilledOrders,
      buyPoll: { ...orderManager.BUY_FILL_POLL },
      logBuy: logger.logBuy,
      logSellOrder: logger.logSellOrder,
      setTimeout: global.setTimeout,
    };
    migration.getExchangeDataDir = (exchange) => {
      const dir = path.join(tmpDir, exchange);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    configUtils.getDefaultPair = () => PAIR;
    configUtils.getFundConfig = () => ({ ...fundConfig });
    adapters.getAdapter = () => ex.adapter;
    orderManager.checkFilledOrders = async () => [];
    orderManager.BUY_FILL_POLL.delayMs = 0;
    logger.logBuy = () => {};
    logger.logSellOrder = () => {};
    // placeSellOrderWithRetry and the reconcile lookup back off with real
    // timers between attempts; collapse them so failure paths stay fast.
    const realSetTimeout = originals.setTimeout;
    // @ts-ignore — test-only shim
    global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeState(stateTracker.createInitialState(fundConfig));
    restartEngine();
  });

  afterEach(() => {
    global.setTimeout = originals.setTimeout;
    migration.getExchangeDataDir = originals.getExchangeDataDir;
    configUtils.getFundConfig = originals.getFundConfig;
    configUtils.getDefaultPair = originals.getDefaultPair;
    adapters.getAdapter = originals.getAdapter;
    orderManager.checkFilledOrders = originals.checkFilledOrders;
    Object.assign(orderManager.BUY_FILL_POLL, originals.buyPoll);
    logger.logBuy = originals.logBuy;
    logger.logSellOrder = originals.logSellOrder;
    delete require.cache[DCA_ENGINE];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('failure -> cold reload -> retry covers the original buy once, without buying or crediting again', async () => {
    const row = await buyWithFailedSell();
    const booked = readState();
    assert.match(row.sellFailedReason, /INSUFFICIENT_FUND/);

    // The automatic paths leave the row alone: that is the bug being fixed.
    restartEngine();
    const status = await engine.checkStatus(EXCHANGE, PAIR);
    assert.equal(status.state.pendingOrders, 0);
    assert.equal(status.state.failedSells.length, 1, 'the failed step stays visible after reload');
    assert.equal(status.state.failedSells[0].buyOrderId, row.buyOrderId);
    assert.equal(status.state.failedSells[0].buyQuantity, row.buyQuantity);
    assert.match(status.state.failedSells[0].sellFailedReason, /INSUFFICIENT_FUND/);

    ex.sellMode = 'accept';
    const attemptsBefore = ex.sellAttempts.length;
    const result = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.pair, PAIR);
    assert.equal(result.sellOrder.orderId, 'sell-1');
    assert.equal(ex.sellAttempts.length - attemptsBefore, 1, 'exactly one sell placed');
    assert.equal(ex.placedBuys, 1, 'no new buy');
    assert.ok(Math.abs(ex.sellAttempts.at(-1).size - row.sellQuantity) < 1e-12, 'sells the original buy quantity less holdback');

    const after = readState();
    const covered = after.orders.find(o => o.buyOrderId === row.buyOrderId);
    assert.equal(after.orders.length, 1);
    assert.equal(covered.status, 'pending');
    assert.equal(covered.orderId, 'sell-1');
    assert.equal(covered.sellFailedReason, undefined);
    assert.equal(covered.sellRetryCount, 1);
    assert.ok(Math.abs(after.outstandingOrdersAsset - row.sellQuantity) < 1e-12, 'sell accounting restored');
    assert.ok(Math.abs(after.outstandingOrdersUSDC - row.sellQuantity * covered.sellPrice) < 1e-9);
    // Booking is untouched: nothing credited, no interval advanced.
    for (const key of ['totalAllocated', 'usdcFundSize', 'assetReserves', 'lastRunId', 'totalIntervalsRun', 'bookedDcaBuyOrderIds']) {
      assert.deepEqual(after[key], booked[key], `${key} must not change`);
    }
    assert.deepEqual(readIntents(), []);

    const again = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(again.success, false);
    assert.equal(again.code, 'not_failed');
    assert.equal(ex.sellAttempts.length - attemptsBefore, 1, 'a covered buy is never sold twice');
  });

  it('a rejected retry keeps the row sell_failed with its new reason, and it stays retryable', async () => {
    const row = await buyWithFailedSell();
    ex.sellMode = 'reject';

    const rejected = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(rejected.success, false);
    assert.equal(rejected.code, 'sell_rejected');
    let stored = readState().orders[0];
    assert.equal(stored.status, 'sell_failed');
    assert.match(stored.sellFailedReason, /INSUFFICIENT_FUND/);
    assert.equal(stored.sellPlacementUnresolved, undefined, 'a definitive rejection is not an unknown outcome');
    assert.equal(readState().outstandingOrdersAsset, 0);

    ex.sellMode = 'accept';
    const ok = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(ok.success, true, JSON.stringify(ok));
    stored = readState().orders[0];
    assert.equal(stored.status, 'pending');
    assert.equal(stored.sellRetryCount, 2);
  });

  it('an unknown-outcome sell blocks retry until it is ruled out, then a later retry succeeds', async () => {
    // The cycle's own sell is ambiguous and the reconcile lookup is
    // inconclusive: the intent stays on disk, its identity on the row.
    const row = await buyWithFailedSell('unknown');
    const [intent] = readIntents();
    assert.ok(intent, 'the ambiguous sell keeps its placement intent');
    assert.deepEqual(row.sellPlacementUnresolved, { intentId: intent.id, clientOrderId: intent.clientOrderId });
    assert.ok(intent.clientOrderId);

    ex.sellMode = 'accept';
    const attempts = ex.sellAttempts.length;

    const blocked = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(blocked.success, false);
    assert.equal(blocked.code, 'placement_unresolved');
    assert.equal(blocked.intentId, intent.id, 'the reconciliation identity is returned');
    assert.equal(blocked.clientOrderId, intent.clientOrderId);
    assert.equal(ex.sellAttempts.length, attempts, 'no sell while the earlier one may be live');

    // An operator adopts it (the lookup finds it resting): the intent is
    // gone, but the earlier sell is live — still no second sell.
    ex.lookup = { orderId: 'sell-live', status: 'OPEN', filledSize: 0 };
    const adopted = await engine.reconcilePlacementIntent(EXCHANGE, PAIR, intent.id, 'adopt');
    assert.equal(adopted.success, true, JSON.stringify(adopted));
    const live = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(live.code, 'placement_unresolved');
    assert.equal(live.orderId, 'sell-live');
    assert.equal(ex.sellAttempts.length, attempts);

    // A lookup failure is never read as absence.
    ex.lookup = 'throw';
    const unchecked = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(unchecked.code, 'placement_unresolved');
    assert.equal(ex.sellAttempts.length, attempts);

    // The earlier sell ended with nothing executed: safe to cover the buy.
    ex.lookup = { orderId: 'sell-live', status: 'CANCELLED', filledSize: 0 };
    const ok = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(ok.success, true, JSON.stringify(ok));
    assert.equal(ex.sellAttempts.length, attempts + 1);
    assert.equal(readState().orders[0].status, 'pending');
  });

  it("a retry whose own placement is ambiguous stays blocked with the new intent's identity", async () => {
    const row = await buyWithFailedSell();
    ex.sellMode = 'unknown';

    const result = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(result.success, false);
    assert.equal(result.code, 'placement_unresolved');
    const [intent] = readIntents();
    assert.equal(result.intentId, intent.id);
    const stored = readState().orders[0];
    assert.equal(stored.status, 'sell_failed');
    assert.deepEqual(stored.sellPlacementUnresolved, { intentId: intent.id, clientOrderId: intent.clientOrderId });

    ex.sellMode = 'accept';
    const attempts = ex.sellAttempts.length;
    restartEngine();
    const again = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    assert.equal(again.code, 'placement_unresolved');
    assert.equal(ex.sellAttempts.length, attempts);
  });

  it('concurrent duplicate retries place exactly one sell', async () => {
    const row = await buyWithFailedSell();
    ex.sellMode = 'accept';
    /** @type {() => void} */
    let release = () => {};
    ex.sellGate = new Promise((resolve) => { release = resolve; });
    const attempts = ex.sellAttempts.length;

    const first = engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    const second = engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);

    assert.equal(results.filter(r => r.success).length, 1, JSON.stringify(results));
    assert.equal(results.find(r => !r.success).code, 'not_failed');
    assert.equal(ex.sellAttempts.length - attempts, 1);
    assert.equal(readState().orders.filter(o => o.status === 'pending').length, 1);
  });

  it('a cycle started during a retry waits instead of re-placing the reopened buy', async () => {
    const row = await buyWithFailedSell();
    // Next interval, so the cycle would run its awaiting-sell recovery.
    writeState({ ...readState(), lastRunId: 'an-earlier-interval' });
    ex.sellMode = 'accept';
    /** @type {() => void} */
    let release = () => {};
    ex.sellGate = new Promise((resolve) => { release = resolve; });
    const attempts = ex.sellAttempts.length;

    const retry = engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
    const cycle = engine.runIntervalCycle(EXCHANGE, PAIR);
    await new Promise((resolve) => setImmediate(resolve));
    ex.sellGate = null;
    release();
    const [retried, cycled] = await Promise.all([retry, cycle]);

    assert.equal(retried.success, true, JSON.stringify(retried));
    assert.equal(cycled.status, 'success', JSON.stringify(cycled));
    // One sell for the retried buy, one for the cycle's own new buy — never a
    // second sell for the reopened row.
    assert.equal(ex.sellAttempts.length - attempts, 2);
    const orders = readState().orders;
    assert.equal(orders.length, 2);
    assert.deepEqual(orders.map(o => o.status), ['pending', 'pending']);
    assert.equal(new Set(orders.map(o => o.orderId)).size, 2);
  });

  it('sells the quantity booked at buy time even if holdbackPercent changed since', async () => {
    const row = await buyWithFailedSell();
    const booked = readState();
    fundConfig.holdbackPercent = 50;
    ex.sellMode = 'accept';

    const result = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);

    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(Math.abs(ex.sellAttempts.at(-1).size - row.sellQuantity) < 1e-12, 'placed size matches the row');
    const after = readState();
    assert.ok(Math.abs(after.outstandingOrdersAsset - row.sellQuantity) < 1e-12, 'accounting matches the placed size');
    assert.equal(after.assetReserves, booked.assetReserves, 'reserves booked at buy time are untouched');
  });

  it('refuses rows it does not own and funds that cannot place a real sell', async () => {
    const row = await buyWithFailedSell();
    ex.sellMode = 'accept';
    const attempts = ex.sellAttempts.length;

    assert.equal((await engine.retryFailedSell(EXCHANGE, PAIR, 'no-such-buy')).code, 'not_found');
    fundConfig.dryRun = true;
    assert.equal((await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId)).code, 'dry_run');
    fundConfig.dryRun = false;
    fundConfig.dcaStrategy = 'fibonacci';
    assert.equal((await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId)).code, 'unsupported_strategy');
    assert.equal(ex.sellAttempts.length, attempts);
    assert.equal(readState().orders[0].status, 'sell_failed');
  });

  // -------------------------------------------------------------------------
  // issue #1886 — every fixed-DCA sell owner (new buy, awaiting-sell recovery,
  // operator retry) attaches and saves the accepted sell BEFORE its placement
  // intent is released. Previously the intent was cleared first, so a crash or
  // failed save in between left an awaiting_sell row with no sell id and no
  // blocking intent, and restart recovery placed a second sell for the buy.
  // -------------------------------------------------------------------------
  describe('accepted-sell ownership is durable before the intent clears (issue #1886)', () => {
    /** @type {Function} */
    let realSaveState;

    beforeEach(() => {
      realSaveState = stateTracker.saveState;
    });

    afterEach(() => {
      stateTracker.saveState = realSaveState;
    });

    /**
     * Capture what a crash just before each state save would leave on disk,
     * for every save after the exchange accepted a sell, plus the final disk.
     * @param {() => Promise<any>} run - Operation under test
     * @returns {Promise<Array<{stateRaw: string, intents: Object[]}>>} Crash snapshots
     */
    const crashPointsAfterAcceptance = async (run) => {
      const acceptedBefore = ex.acceptedSells;
      const snapshots = [];
      const snapshot = () => snapshots.push({ stateRaw: fs.readFileSync(stateFile(), 'utf8'), intents: readIntents() });
      stateTracker.saveState = (...args) => {
        if (ex.acceptedSells > acceptedBefore) snapshot();
        return realSaveState(...args);
      };
      await run();
      stateTracker.saveState = realSaveState;
      snapshot();
      assert.ok(ex.acceptedSells > acceptedBefore, 'the run accepted a sell');
      return snapshots;
    };

    /**
     * Restore one crash snapshot as a restarted process would find it, run
     * restart recovery, and require that the buy is never sold twice.
     * @param {{stateRaw: string, intents: Object[]}} crash - Crash snapshot
     * @param {string} buyOrderId - Buy whose sell was accepted
     * @param {string} sellOrderId - The accepted sell
     */
    const assertOwnedAfterRestart = async (crash, buyOrderId, sellOrderId) => {
      fs.writeFileSync(stateFile(), crash.stateRaw);
      stateTracker.savePlacementIntents(crash.intents.map(i => ({ ...i, instanceId: 'a-process-that-died' })), EXCHANGE, PAIR);
      restartEngine();

      const state = stateTracker.loadState(fundConfig, EXCHANGE, PAIR);
      const row = state.orders.find(o => o.buyOrderId === buyOrderId);
      const blocking = stateTracker.getBlockingPlacementIntents(EXCHANGE, PAIR);
      assert.ok(row.orderId === sellOrderId || blocking.length > 0,
        `crash leaves a durable owner: row ${row.status}/${row.orderId}, ${blocking.length} blocking intent(s)`);

      ex.sellMode = 'accept';
      const attempts = ex.sellAttempts.length;
      await engine.reconcileAwaitingSells(state, fundConfig, ex.adapter, EXCHANGE, PAIR);
      assert.equal(ex.sellAttempts.length, attempts, 'restart recovery places no second sell for the buy');
    };

    it('new-buy path: no crash point after acceptance loses the sell owner', async () => {
      ex.sellMode = 'accept';
      const crashes = await crashPointsAfterAcceptance(async () => {
        const result = await engine.runIntervalCycle(EXCHANGE, PAIR);
        assert.equal(result.status, 'success', JSON.stringify(result));
      });
      const [row] = readState().orders;
      assert.equal(row.orderId, 'sell-1');
      assert.ok(crashes.length >= 2);
      for (const crash of crashes) await assertOwnedAfterRestart(crash, row.buyOrderId, 'sell-1');
    });

    it('awaiting-sell recovery path: no crash point after acceptance loses the sell owner', async () => {
      const failed = await buyWithFailedSell();
      // Rewrite the failed row into the crash footprint recovery owns.
      const seeded = readState();
      const seededRow = seeded.orders[0];
      seededRow.status = 'awaiting_sell';
      delete seededRow.sellFailedReason;
      delete seededRow.sellFailedAt;
      writeState(seeded);

      ex.sellMode = 'accept';
      const crashes = await crashPointsAfterAcceptance(async () => {
        const state = stateTracker.loadState(fundConfig, EXCHANGE, PAIR);
        const recon = await engine.reconcileAwaitingSells(state, fundConfig, ex.adapter, EXCHANGE, PAIR);
        assert.deepEqual(recon, { recovered: 1, failed: 0 });
      });
      const row = readState().orders[0];
      assert.equal(row.status, 'pending', 'recovery saved the sell itself, without a caller save');
      assert.equal(row.orderId, 'sell-1');
      for (const crash of crashes) await assertOwnedAfterRestart(crash, failed.buyOrderId, 'sell-1');
    });

    it('failed-sell retry path: no crash point after acceptance loses the sell owner', async () => {
      const failed = await buyWithFailedSell();
      ex.sellMode = 'accept';
      const crashes = await crashPointsAfterAcceptance(async () => {
        const result = await engine.retryFailedSell(EXCHANGE, PAIR, failed.buyOrderId);
        assert.equal(result.success, true, JSON.stringify(result));
      });
      assert.equal(readState().orders[0].orderId, 'sell-1');
      for (const crash of crashes) await assertOwnedAfterRestart(crash, failed.buyOrderId, 'sell-1');
    });

    it('a reconciled acceptance goes through the same handoff with its requested size and price', async () => {
      ex.sellMode = 'unknown';
      ex.lookup = { orderId: 'sell-adopted', status: 'OPEN', filledSize: 0 };
      /** @type {any[]} */
      const savedSellPrices = [];
      stateTracker.saveState = (state, ...rest) => {
        const row = state.orders?.[0];
        if (row?.orderId === 'sell-adopted') savedSellPrices.push({ sellPrice: row.sellPrice, intents: readIntents().length });
        return realSaveState(state, ...rest);
      };

      const result = await engine.runIntervalCycle(EXCHANGE, PAIR);

      assert.equal(result.status, 'success', JSON.stringify(result));
      const [attempt] = ex.sellAttempts;
      assert.equal(savedSellPrices[0].sellPrice, attempt.price, 'handoff saw the requested limit price');
      assert.equal(savedSellPrices[0].intents, 1, 'saved while the intent still guarded the order');
      const after = readState();
      assert.equal(after.orders[0].status, 'pending');
      assert.ok(Math.abs(after.outstandingOrdersAsset - attempt.size) < 1e-12);
      assert.ok(Math.abs(after.outstandingOrdersUSDC - attempt.size * attempt.price) < 1e-9);
      assert.deepEqual(readIntents(), []);
    });

    it('a failed handoff save keeps the accepted sell recoverable without crediting it or placing another', async () => {
      ex.sellMode = 'accept';
      let failedOnce = false;
      stateTracker.saveState = (state, ...rest) => {
        if (!failedOnce && state.orders?.some(o => o.orderId === 'sell-1')) {
          failedOnce = true;
          throw new Error('ENOSPC: no space left on device');
        }
        return realSaveState(state, ...rest);
      };

      const result = await engine.runIntervalCycle(EXCHANGE, PAIR);

      assert.equal(failedOnce, true);
      assert.equal(result.status, 'sell_placement_failed', JSON.stringify(result));
      assert.match(result.error, /accepted but not handed off/);
      assert.equal(ex.sellAttempts.length, 1, 'an accepted sell is never retried as a rejection');
      const [intent] = readIntents();
      assert.equal(intent.status, 'unresolved');
      assert.equal(intent.orderId, 'sell-1');
      const stored = readState();
      const [row] = stored.orders;
      assert.equal(row.status, 'sell_failed');
      assert.equal(row.orderId, null);
      assert.deepEqual(row.sellPlacementUnresolved, { intentId: intent.id, clientOrderId: null, orderId: 'sell-1' });
      assert.equal(stored.outstandingOrdersAsset, 0, 'outstanding exposure is not credited for an unowned sell');
      assert.equal(stored.outstandingOrdersUSDC, 0);

      // Restart: the retained intent still blocks a retry.
      stateTracker.savePlacementIntents(readIntents().map(i => ({ ...i, instanceId: 'a-process-that-died' })), EXCHANGE, PAIR);
      restartEngine();
      const blocked = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
      assert.equal(blocked.code, 'placement_unresolved');

      // Even once the operator clears the intent, the accepted sell's own id
      // rules out a second sell while it is live.
      const discarded = await engine.reconcilePlacementIntent(EXCHANGE, PAIR, intent.id, 'discard');
      assert.equal(discarded.success, true, JSON.stringify(discarded));
      const live = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
      assert.equal(live.code, 'placement_unresolved');
      assert.equal(live.orderId, 'sell-1');
      assert.equal(ex.sellAttempts.length, 1);

      // Cancelled with nothing executed: now safe to cover the buy.
      ex.adapter.getOrder = async (orderId) => ({ orderId, status: 'CANCELLED', filledSize: 0 });
      const ok = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
      assert.equal(ok.success, true, JSON.stringify(ok));
      assert.equal(ex.sellAttempts.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // issue #1887 — a sell that ends CANCELLED/EXPIRED after executing part of
  // its size. Fixed DCA credits it once through repeated syncs and reloads and
  // leaves only the unsold remainder as a retryable failed sell; Fibonacci
  // credits it, keeps its cycle and shrinks every replacement.
  // -------------------------------------------------------------------------
  describe('terminal partial sells (issue #1887)', () => {
    /** @type {Record<string, Object>} */
    let sellStatus;
    /** @type {Array<string>} */
    let feeLookups;
    /** @type {Array<Object>} */
    let loggedSellFills;
    /** @type {Function} */
    let originalLogSellFilled;

    beforeEach(() => {
      sellStatus = {};
      feeLookups = [];
      loggedSellFills = [];
      const buyStatus = ex.adapter.getOrder;
      ex.adapter.getOrder = async (orderId) => sellStatus[orderId] ?? buyStatus(orderId);
      // An accepted cancel takes a resting sell off the book; the engine re-reads
      // it to confirm the final execution (issue #1889).
      ex.adapter.cancelOrder = async (orderId) => {
        const resting = sellStatus[orderId];
        if (resting && resting.status === 'OPEN') sellStatus[orderId] = { ...resting, status: 'CANCELLED' };
        return { success: true };
      };
      ex.adapter.getOrderFillSummary = async (orderId) => {
        feeLookups.push(orderId);
        return { totalFees: 0.5, totalRebates: 0, netFees: 0.5, fills: [] };
      };
      // Drive the real fill reconciliation, not the suite's empty stub.
      orderManager.checkFilledOrders = originals.checkFilledOrders;
      originalLogSellFilled = logger.logSellFilled;
      logger.logSellFilled = (fill) => { loggedSellFills.push(fill); };
    });

    afterEach(() => {
      logger.logSellFilled = originalLogSellFilled;
    });

    /** Run a live cycle whose buy fills and whose covering sell rests. */
    const buyWithRestingSell = async () => {
      ex.sellMode = 'accept';
      const result = await engine.runIntervalCycle(EXCHANGE, PAIR);
      assert.equal(result.status, 'success', JSON.stringify(result));
      const [row] = readState().orders;
      assert.equal(row.status, 'pending');
      return row;
    };

    it('fixed DCA: a cancelled partial is credited once across repeated syncs and reloads, and only the remainder is re-sold', async () => {
      const row = await buyWithRestingSell();
      const booked = readState();
      const executed = row.sellQuantity * 0.4;
      const value = executed * row.sellPrice;
      sellStatus[row.orderId] = { orderId: row.orderId, status: 'CANCELLED', filledSize: executed, filledValue: value, averageFilledPrice: row.sellPrice };

      const first = await engine.syncFundOrders(EXCHANGE, PAIR);
      assert.equal(first.filledOrders.length, 1);
      const settled = readState();
      assert.ok(Math.abs(settled.usdcFundSize - (booked.usdcFundSize + value - 0.5)) < 1e-9, 'net proceeds credited');
      assert.ok(Math.abs(settled.netFees - (booked.netFees + 0.5)) < 1e-12);
      assert.ok(Math.abs(settled.outstandingOrdersAsset) < 1e-12, 'no resting sell remains');
      assert.ok(Math.abs(settled.outstandingOrdersUSDC) < 1e-9);
      assert.equal(settled.assetReserves, booked.assetReserves, 'holdback untouched');
      const [failed] = settled.orders;
      assert.equal(failed.status, 'sell_failed');
      assert.ok(Math.abs(failed.sellQuantity - (row.sellQuantity - executed)) < 1e-12);
      assert.equal(loggedSellFills.length, 1, 'the executed portion is logged once');

      // Repeated sync, then a cold restart: nothing is credited again.
      const second = await engine.syncFundOrders(EXCHANGE, PAIR);
      assert.equal(second.filledOrders.length, 0);
      restartEngine();
      const status = await engine.checkStatus(EXCHANGE, PAIR);
      assert.deepEqual(readState(), settled);
      assert.equal(status.state.failedSells.length, 1, 'the unsold remainder stays visible');
      assert.equal(status.state.pendingOrders, 0);

      const attempts = ex.sellAttempts.length;
      const retried = await engine.retryFailedSell(EXCHANGE, PAIR, row.buyOrderId);
      assert.equal(retried.success, true, JSON.stringify(retried));
      assert.equal(ex.sellAttempts.length - attempts, 1);
      assert.ok(Math.abs(ex.sellAttempts.at(-1).size - (row.sellQuantity - executed)) < 1e-12, 'only the unsold remainder is offered');
      const resting = readState();
      assert.ok(Math.abs(resting.outstandingOrdersAsset - (row.sellQuantity - executed)) < 1e-12);

      const remainderOrder = retried.sellOrder.orderId;
      const remainderValue = (row.sellQuantity - executed) * resting.orders[0].sellPrice;
      sellStatus[remainderOrder] = { orderId: remainderOrder, status: 'FILLED', filledSize: row.sellQuantity - executed, filledValue: remainderValue, averageFilledPrice: resting.orders[0].sellPrice };
      await engine.syncFundOrders(EXCHANGE, PAIR);
      const done = readState();
      const [filled] = done.orders;
      assert.equal(filled.status, 'filled');
      assert.ok(Math.abs(filled.sellQuantity - row.sellQuantity) < 1e-12, 'the row reports the whole sold quantity');
      assert.ok(Math.abs(filled.netProceeds - (value - 0.5 + remainderValue - 0.5)) < 1e-9);
      assert.ok(Math.abs(done.usdcFundSize - (booked.usdcFundSize + value + remainderValue - 1)) < 1e-9);
      assert.ok(Math.abs(done.outstandingOrdersAsset) < 1e-12);
      assert.equal(ex.placedBuys, 1, 'no buy along the way');
    });

    it('fixed DCA: a zero-fill expiry credits nothing and leaves the whole sell retryable', async () => {
      const row = await buyWithRestingSell();
      const booked = readState();
      feeLookups.length = 0;
      sellStatus[row.orderId] = { orderId: row.orderId, status: 'EXPIRED', filledSize: 0, filledValue: 0, averageFilledPrice: 0 };

      await engine.syncFundOrders(EXCHANGE, PAIR);

      const after = readState();
      assert.equal(after.usdcFundSize, booked.usdcFundSize);
      assert.equal(after.netFees, booked.netFees);
      assert.equal(after.outstandingOrdersAsset, 0);
      assert.equal(after.orders[0].status, 'sell_failed');
      assert.ok(Math.abs(after.orders[0].sellQuantity - row.sellQuantity) < 1e-12);
      assert.deepEqual(feeLookups, [], 'no fee lookup when nothing executed');
      assert.equal(loggedSellFills.length, 0);
    });

    it('fixed DCA: an UNKNOWN status keeps the sell owned and pending; a full fill books once', async () => {
      const row = await buyWithRestingSell();
      const booked = readState();
      sellStatus[row.orderId] = { orderId: row.orderId, status: 'UNKNOWN', filledSize: row.sellQuantity * 0.4, filledValue: 1, averageFilledPrice: 0 };

      assert.equal((await engine.syncFundOrders(EXCHANGE, PAIR)).filledOrders.length, 0);
      assert.deepEqual(readState(), booked, 'nothing changes while the status is unconfirmed');

      const value = row.sellQuantity * row.sellPrice;
      sellStatus[row.orderId] = { orderId: row.orderId, status: 'FILLED', filledSize: row.sellQuantity, filledValue: value, averageFilledPrice: row.sellPrice };
      await engine.syncFundOrders(EXCHANGE, PAIR);
      await engine.syncFundOrders(EXCHANGE, PAIR);
      const after = readState();
      assert.equal(after.orders[0].status, 'filled');
      assert.ok(Math.abs(after.usdcFundSize - (booked.usdcFundSize + value - 0.5)) < 1e-9, 'credited once');
    });

    it('Fibonacci: an expired partial is credited once, keeps its cycle and holdback, and shrinks every replacement', async () => {
      fundConfig.dcaStrategy = 'fibonacci';
      fundConfig.fibBaseAmount = 100;
      ex.sellMode = 'accept';
      const nextInterval = () => writeState({ ...readState(), lastRunId: 'an-earlier-interval' });

      assert.equal((await engine.runIntervalCycle(EXCHANGE, PAIR)).status, 'success');
      const first = readState();
      const firstSell = first.fibActiveSellOrderId;
      const firstQty = ex.sellAttempts.at(-1).size;
      const executed = firstQty * 0.4;
      const value = executed * 52000;
      sellStatus[firstSell] = { orderId: firstSell, status: 'EXPIRED', filledSize: executed, filledValue: value, averageFilledPrice: 52000 };

      nextInterval();
      assert.equal((await engine.runIntervalCycle(EXCHANGE, PAIR)).status, 'success');
      const second = readState();
      const boughtAsset = second.fibCumulativeAsset - first.fibCumulativeAsset;
      const target = second.fibCumulativeAsset * (1 - fundConfig.holdbackPercent / 100);
      assert.ok(Math.abs(ex.sellAttempts.at(-1).size - (target - executed)) < 1e-12, 'replacement excludes the executed portion');
      assert.ok(Math.abs(second.fibCycleSoldAsset - executed) < 1e-12);
      assert.deepEqual(second.fibCreditedSellOrderIds, [firstSell]);
      assert.equal(second.fibPosition, 2, 'the cycle continues');
      assert.ok(boughtAsset > 0);
      assert.equal(second.assetReserves, first.assetReserves, 'holdback is not realized by a partial');
      assert.ok(Math.abs(second.fibPendingHoldback - second.fibCumulativeAsset * fundConfig.holdbackPercent / 100) < 1e-12);
      const allocated = second.totalAllocated - first.totalAllocated;
      // Fund: + executed proceeds (less 0.5 sell fee) − this interval's buy (plus its 0.5 fee).
      assert.ok(Math.abs(second.usdcFundSize - (first.usdcFundSize + value - 0.5 - allocated - 0.5)) < 1e-9);
      assert.ok(Math.abs(second.outstandingOrdersAsset - (target - executed)) < 1e-12, 'exposure is the resting replacement');

      // A later replacement (the resting sell untouched, another buy) still
      // subtracts what already sold — and credits nothing again.
      const replacement = second.fibActiveSellOrderId;
      sellStatus[replacement] = { orderId: replacement, status: 'OPEN', filledSize: 0, filledValue: 0, averageFilledPrice: 0 };
      restartEngine();
      nextInterval();
      assert.equal((await engine.runIntervalCycle(EXCHANGE, PAIR)).status, 'success');
      const third = readState();
      const thirdTarget = third.fibCumulativeAsset * (1 - fundConfig.holdbackPercent / 100);
      assert.ok(Math.abs(ex.sellAttempts.at(-1).size - (thirdTarget - executed)) < 1e-12);
      assert.ok(Math.abs(third.fibCycleSoldAsset - executed) < 1e-12);
      assert.ok(Math.abs(third.usdcFundSize - (second.usdcFundSize - (third.totalAllocated - second.totalAllocated) - 0.5)) < 1e-9, 'no second credit');

      // An unconfirmed status keeps the resting sell owned: no replacement.
      const owned = third.fibActiveSellOrderId;
      sellStatus[owned] = { orderId: owned, status: 'UNKNOWN', filledSize: 0, filledValue: 0, averageFilledPrice: 0 };
      const attempts = ex.sellAttempts.length;
      nextInterval();
      assert.equal((await engine.runIntervalCycle(EXCHANGE, PAIR)).status, 'sell_placement_failed');
      assert.equal(ex.sellAttempts.length, attempts, 'no second sell beside a possibly-live one');
      assert.equal(readState().fibActiveSellOrderId, owned);
    });
  });
});
