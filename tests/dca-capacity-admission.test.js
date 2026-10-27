// @ts-check
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const config = require('../src/config-utils');
const adapters = require('../src/adapters');
const tracker = require('../src/state-tracker');
const manager = require('../src/order-manager');
const conversion = require('../src/dca-conversion-transaction');
const logger = require('../src/logger');
const routeUtils = require('../src/routes/route-utils');
const { getPendingWrites } = require('../src/pending-writes');

const EXCHANGE = 'coinbase';
const PAIR = 'ETH-USDC';

const modulePaths = [
  '../src/dca-engine',
  '../src/routes/exchange-routes',
  '../src/routes/legacy-routes',
];

const clearModules = () => {
  for (const name of modulePaths) {
    try {
      delete require.cache[require.resolve(name)];
    } catch {
      // ignore
    }
  }
};

describe('DCA operation capacity and admission bounds (issue #1814)', () => {
  let engine, durable, scopes;

  beforeEach(() => {
    clearModules();
    const fund = {
      productId: PAIR,
      totalAllocation: 1000,
      intervalsToSpread: 10,
      intervalType: 'daily',
      sellMarkupPercent: 2,
      holdbackPercent: 0,
      dcaStrategy: 'fixed',
      dryRun: false,
    };
    mock.method(config, 'getFundConfig', (_ex, pair) => ({ ...fund, productId: pair || PAIR }));
    mock.method(config, 'getExchangeConfig', () => fund);
    mock.method(config, 'getDefaultPair', () => PAIR);
    mock.method(config, 'getGlobalConfig', () => ({ simpleDcaEnabled: true }));
    mock.method(routeUtils, 'resolvePairParam', (req) => ({
      pair: req.query?.pair || req.params?.pair || PAIR,
      error: null,
    }));
    mock.method(adapters, 'getAdapter', () => ({
      getCurrentPrice: async () => 100,
      getAccountBalance: async () => 10000,
      placeMarketBuy: async () => ({ orderId: 'buy-mock-1', filledSize: 1, filledValue: 100 }),
    }));
    mock.method(conversion, 'hasPendingDcaImport', () => false);
    mock.method(logger, 'logSellOrder', () => {});
    mock.method(logger, 'logSellFilled', () => {});

    durable = tracker.createInitialState(fund);
    tracker.recordBuyFill(durable, { orderId: 'failed-buy', assetAmount: 1, price: 100, usdcAmount: 100 }, fund);
    tracker.markSellPlacementFailed(durable, 'failed-buy', 'rejected');
    tracker.recordBuyFill(durable, { orderId: 'other-buy', assetAmount: 1, price: 100, usdcAmount: 100 }, fund);
    tracker.attachSellOrder(durable, 'other-buy', { orderId: 'other-sell', limitPrice: 102 });

    scopes = [];
    mock.method(tracker, 'loadState', (_config, exchange, pair) => {
      scopes.push(['load', exchange, pair]);
      return structuredClone(durable);
    });
    mock.method(tracker, 'saveState', (state, exchange, pair) => {
      scopes.push(['save', exchange, pair]);
      durable = structuredClone(state);
    });
    mock.method(tracker, 'getBlockingPlacementIntents', () => []);
    mock.method(tracker, 'describePlacementIntents', () => []);

    engine = require('../src/dca-engine');
  });

  afterEach(() => {
    mock.restoreAll();
    clearModules();
  });

  it('proves excess requests return promptly without adding pending writers, loading state, or chaining exchange work', async () => {
    let releaseFirst;
    let holding = true;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    let checkCalls = 0;

    mock.method(manager, 'checkFilledOrders', async () => {
      checkCalls++;
      if (holding) await gate;
      return [];
    });

    // Launch 8 operations to saturate the per-fund limit (MAX_FUND_OPERATIONS = 8)
    const admittedPromises = [];
    for (let i = 0; i < 8; i++) {
      admittedPromises.push(engine.syncFundOrders(EXCHANGE, PAIR));
    }

    // Flush microtasks so the first operation enters checkFilledOrders and registers pending writes
    await new Promise((resolve) => setImmediate(resolve));

    // The first 8 requests are admitted: 8 pending writes tracked
    assert.equal(getPendingWrites().length, 8);
    // Only the first call has loaded state so far (the other 7 wait on withFundLock)
    assert.equal(scopes.filter(([op]) => op === 'load').length, 1);
    assert.equal(checkCalls, 1);

    // 9th request must be refused immediately with typed dca-busy failure
    let refusedError = null;
    try {
      await engine.syncFundOrders(EXCHANGE, PAIR);
    } catch (err) {
      refusedError = err;
    }

    assert.ok(refusedError, '9th request should be refused');
    assert.equal(refusedError.code, 'dca-busy');
    assert.equal(refusedError.status, 503);
    assert.equal(refusedError.statusCode, 503);
    assert.equal(refusedError.retryAfter, 1);

    // Excess request did NOT add a pending writer
    assert.equal(getPendingWrites().length, 8);
    // Excess request did NOT load state
    assert.equal(scopes.filter(([op]) => op === 'load').length, 1);
    // Excess request did NOT invoke exchange work
    assert.equal(checkCalls, 1);

    // Release the gate so the 8 admitted operations complete
    holding = false;
    releaseFirst();
    const results = await Promise.all(admittedPromises);
    assert.equal(results.length, 8);

    // Once settled, pending writers return to 0 and all 8 admitted operations completed
    assert.equal(getPendingWrites().length, 0);
    assert.equal(scopes.filter(([op]) => op === 'load').length, 8);
    assert.equal(checkCalls, 8);
  });

  it('saturation across distinct funds respects the gateway-wide cap (32) and saturated funds do not starve others', async () => {
    let holding = true;
    let releaseAll;
    const gate = new Promise((resolve) => { releaseAll = resolve; });

    mock.method(manager, 'checkFilledOrders', async () => {
      if (holding) await gate;
      return [];
    });

    const fundA = 'BTC-USDC';
    const fundB = 'ETH-USDC';
    const fundC = 'SOL-USDC';
    const fundD = 'AVAX-USDC';
    const fundE = 'LINK-USDC';

    // Fund A receives 8 requests (saturating fund A's limit of 8)
    const fundAPromises = [];
    for (let i = 0; i < 8; i++) {
      fundAPromises.push(engine.syncFundOrders(EXCHANGE, fundA));
    }

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(engine._test.getOperationCounts().funds.get(`coinbase::${fundA}`), 8);
    assert.equal(engine._test.getOperationCounts().gateway, 8);

    // Fund A is saturated: 9th request to fund A is refused
    await assert.rejects(
      () => engine.syncFundOrders(EXCHANGE, fundA),
      (err) => err.code === 'dca-busy'
    );

    // Saturated Fund A does NOT consume all capacity: Fund B can still admit requests!
    const fundBPromises = [];
    for (let i = 0; i < 8; i++) {
      fundBPromises.push(engine.syncFundOrders(EXCHANGE, fundB));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(engine._test.getOperationCounts().funds.get(`coinbase::${fundB}`), 8);
    assert.equal(engine._test.getOperationCounts().gateway, 16);

    // Fill remaining gateway capacity up to 32 across funds C and D
    const otherPromises = [];
    for (let i = 0; i < 8; i++) {
      otherPromises.push(engine.syncFundOrders(EXCHANGE, fundC));
      otherPromises.push(engine.syncFundOrders(EXCHANGE, fundD));
    }
    await new Promise((resolve) => setImmediate(resolve));

    // Gateway is now fully saturated at 32
    assert.equal(engine._test.getOperationCounts().gateway, 32);

    // Even though fund E has 0 active requests, it is refused because the gateway-wide cap is 32
    await assert.rejects(
      () => engine.syncFundOrders(EXCHANGE, fundE),
      (err) => err.code === 'dca-busy'
    );

    // Release all gates
    holding = false;
    releaseAll();
    await Promise.all([...fundAPromises, ...fundBPromises, ...otherPromises]);

    // All counters return to 0
    assert.equal(engine._test.getOperationCounts().gateway, 0);
    assert.equal(engine._test.getOperationCounts().funds.size, 0);
  });

  it('releases counters on success, rejection and synchronous failure without leaked or negative counters', async () => {
    let failExchange = false;
    mock.method(manager, 'checkFilledOrders', async () => {
      if (failExchange) throw new Error('simulated exchange network failure');
      return [];
    });

    // 1. Success path
    const successResult = await engine.syncFundOrders(EXCHANGE, PAIR);
    assert.deepEqual(successResult.filledOrders, []);
    assert.equal(engine._test.getOperationCounts().gateway, 0);
    assert.equal(engine._test.getOperationCounts().funds.size, 0);

    // 2. Async rejection path
    failExchange = true;
    await assert.rejects(
      () => engine.syncFundOrders(EXCHANGE, PAIR),
      (err) => err.message === 'simulated exchange network failure'
    );
    assert.equal(engine._test.getOperationCounts().gateway, 0);
    assert.equal(engine._test.getOperationCounts().funds.size, 0);

    // 3. New work is admitted cleanly after previous settlement
    failExchange = false;
    const okAgain = await engine.syncFundOrders(EXCHANGE, PAIR);
    assert.deepEqual(okAgain.filledOrders, []);
    assert.equal(engine._test.getOperationCounts().gateway, 0);
    assert.equal(engine._test.getOperationCounts().funds.size, 0);
  });

  it('exercises real exchange and legacy HTTP handlers and verifies 503, stable code and Retry-After', async () => {
    let release;
    let holding = true;
    const gate = new Promise((resolve) => { release = resolve; });
    mock.method(manager, 'checkFilledOrders', async () => {
      if (holding) await gate;
      return [];
    });

    // Saturate the fund with 8 operations
    const inFlight = [];
    for (let i = 0; i < 8; i++) {
      inFlight.push(engine.syncFundOrders(EXCHANGE, PAIR));
    }
    await new Promise((resolve) => setImmediate(resolve));

    // Register real routes
    const handlers = {};
    const app = {};
    for (const method of ['get', 'put', 'patch', 'post', 'delete']) {
      app[method] = (route, handler) => { handlers[`${method} ${route}`] = handler; };
    }
    require('../src/routes/exchange-routes')(app, {});
    require('../src/routes/legacy-routes')(app, {});

    const invokeHandler = async (routeKey, req) => {
      const headers = {};
      const response = {
        statusCode: 200,
        headers,
        body: null,
        status(code) { this.statusCode = code; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        setHeader(k, v) { this.headers[k] = v; return this; },
        json(b) { this.body = b; return this; },
      };
      await handlers[routeKey](req, response, (err) => { if (err) throw err; });
      return response;
    };

    // 1. POST /api/:exchange/sync
    const syncRes = await invokeHandler('post /api/:exchange/sync', {
      params: { exchange: EXCHANGE },
      query: { pair: PAIR },
    });
    assert.equal(syncRes.statusCode, 503);
    assert.equal(syncRes.headers['Retry-After'], '1');
    assert.equal(syncRes.body.success, false);
    assert.equal(syncRes.body.code, 'dca-busy');
    assert.equal(syncRes.body.retryAfter, 1);

    // 2. POST /api/:exchange/trade
    const tradeRes = await invokeHandler('post /api/:exchange/trade', {
      params: { exchange: EXCHANGE },
      query: { pair: PAIR },
    });
    assert.equal(tradeRes.statusCode, 503);
    assert.equal(tradeRes.headers['Retry-After'], '1');
    assert.equal(tradeRes.body.success, false);
    assert.equal(tradeRes.body.code, 'dca-busy');
    assert.equal(tradeRes.body.retryAfter, 1);

    // 3. POST /api/:exchange/resume-pending-buy
    const resumeRes = await invokeHandler('post /api/:exchange/resume-pending-buy', {
      params: { exchange: EXCHANGE },
      query: { pair: PAIR },
      body: { orderId: 'buy-123' },
    });
    assert.equal(resumeRes.statusCode, 503);
    assert.equal(resumeRes.headers['Retry-After'], '1');
    assert.equal(resumeRes.body.success, false);
    assert.equal(resumeRes.body.code, 'dca-busy');

    // 4. POST /api/:exchange/consolidate
    durable.orders = [
      { orderId: 'o1', status: 'pending' },
      { orderId: 'o2', status: 'pending' },
    ];
    const consolRes = await invokeHandler('post /api/:exchange/consolidate', {
      params: { exchange: EXCHANGE },
      query: { pair: PAIR },
      body: { orderIds: ['o1', 'o2'] },
    });
    assert.equal(consolRes.statusCode, 503);
    assert.equal(consolRes.headers['Retry-After'], '1');
    assert.equal(consolRes.body.success, false);
    assert.equal(consolRes.body.code, 'dca-busy');

    // 5. POST /api/:exchange/retry-failed-sell
    const retrySellRes = await invokeHandler('post /api/:exchange/retry-failed-sell', {
      params: { exchange: EXCHANGE },
      query: { pair: PAIR },
      body: { buyOrderId: 'failed-buy' },
    });
    assert.equal(retrySellRes.statusCode, 503);
    assert.equal(retrySellRes.headers['Retry-After'], '1');
    assert.equal(retrySellRes.body.success, false);
    assert.equal(retrySellRes.body.code, 'dca-busy');

    // 6. POST /api/sync (legacy)
    const legSyncRes = await invokeHandler('post /api/sync', {
      query: {},
    });
    assert.equal(legSyncRes.statusCode, 503);
    assert.equal(legSyncRes.headers['Retry-After'], '1');
    assert.equal(legSyncRes.body.success, false);
    assert.equal(legSyncRes.body.code, 'dca-busy');

    // 7. POST /api/trade (legacy)
    const legTradeRes = await invokeHandler('post /api/trade', {
      query: {},
    });
    assert.equal(legTradeRes.statusCode, 503);
    assert.equal(legTradeRes.headers['Retry-After'], '1');
    assert.equal(legTradeRes.body.success, false);
    assert.equal(legTradeRes.body.code, 'dca-busy');

    holding = false;
    release();
    await Promise.all(inFlight);
  });

  it('an admitted sell retry, sync and cycle remain serialized and preserve durable order ownership', async () => {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    mock.method(manager, 'checkFilledOrders', async () => {
      await gate;
      return [{ orderId: 'other-sell', filledSize: 1, fillValue: 102, fees: 0, netFees: 0 }];
    });

    let placements = 0;
    mock.method(manager, 'placeSellOrderWithRetry', async () => {
      return { orderId: `retry-sell-${++placements}`, baseSize: 1, limitPrice: 102 };
    });

    // 1. Start sync (takes fund lock and runs checkFilledOrders)
    const sync = engine.syncFundOrders(EXCHANGE, PAIR);
    await new Promise((resolve) => setImmediate(resolve));

    // 2. Start retry while sync is in flight (waits on fund lock)
    const retry = engine.retryFailedSell(EXCHANGE, PAIR, 'failed-buy');
    await new Promise((resolve) => setImmediate(resolve));

    // Release sync
    releaseGate();
    const [synced, retried] = await Promise.all([sync, retry]);

    assert.equal(synced.filledOrders.length, 1);
    assert.equal(retried.success, true);
    assert.equal(placements, 1);
    assert.equal(durable.orders.find((o) => o.buyOrderId === 'failed-buy').status, 'pending');
    assert.equal(durable.orders.find((o) => o.buyOrderId === 'other-buy').status, 'filled');
  });

  it('scheduled capacity refusal remains eligible for within-interval retry without recording a buy or spent interval', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const scheduler = source.slice(
      source.indexOf('const schedulerState = {}'),
      source.indexOf('// ============ Start Server')
    );

    const logs = [];
    const events = [];
    const intervalUtils = require('../src/interval-utils');

    const { DcaBusyError } = engine;
    const now = Date.now();
    const key = `${EXCHANGE}/${PAIR}`;

    const context = vm.createContext({
      gatewayShutdown: {
        isStopping: () => false,
        track: (promise) => promise,
      },
      getGlobalConfig: () => ({ simpleDcaEnabled: true }),
      isMaintenanceActive: () => false,
      getEnabledFunds: () => [{ exchange: EXCHANGE, pair: PAIR }],
      getFundConfig: () => ({ intervalType: 'daily' }),
      normalizeConfig: (c) => c,
      fundKey: () => key,
      fundLabel: () => key,
      hasRunThisInterval: (lastRunId, intervalType) => intervalUtils.hasRunThisInterval(lastRunId, intervalType),
      formatInterval: (t) => t,
      getRunIdentifier: (t) => intervalUtils.getRunIdentifier(t, now),
      getNextExecutionTime: (t) => intervalUtils.getNextExecutionTime(t, now),
      planScheduledRetry: (entry, opts) => intervalUtils.planScheduledRetry(entry, opts),
      runIntervalCycle: () => Promise.reject(new DcaBusyError('DCA busy', { exchange: EXCHANGE, pair: PAIR })),
      log: (level, msg) => logs.push({ level, msg }),
      tradeEvents: {
        error: (exchange, msg, meta) => events.push({ exchange, msg, meta }),
      },
      Date: class extends Date {
        static now() { return now; }
      },
    });

    vm.runInContext(`${scheduler}\ncheckAndRunIntervalTrade();`, context);

    // Allow promise rejection microtasks to flush
    await new Promise((resolve) => setImmediate(resolve));

    const state = vm.runInContext(`schedulerState["${key}"]`, context);
    // lastRunId MUST be reset to null so the interval is NOT consumed
    assert.equal(state.lastRunId, null, 'lastRunId must be null so interval is not consumed');
    assert.ok(state.nextExecutionTime > now, 'nextExecutionTime must be set to a future retry within interval');
    assert.equal(state.retryCount, 1, 'retryCount must be incremented');

    // No buy was recorded in tracker
    assert.equal(scopes.filter(([op]) => op === 'save').length, 0);

    // Verify error was logged
    assert.ok(logs.some((l) => l.level === 'ERROR' && l.msg.includes('Scheduled trade failed')));
  });
});
