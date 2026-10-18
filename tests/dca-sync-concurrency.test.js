// @ts-check
// Reconciliation owns a load/await/save transaction just like sell retries.
// A stale sync snapshot must never erase an accepted retry and permit another.
const { it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
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
const modulePaths = ['../src/dca-engine', '../src/routes/exchange-routes', '../src/routes/legacy-routes'];
const clearModules = () => { for (const name of modulePaths) delete require.cache[require.resolve(name)]; };
let engine, durable, placements, releaseSync, syncEntered, scopes;

beforeEach(() => {
  clearModules();
  const fund = { productId: PAIR, totalAllocation: 1000, intervalsToSpread: 10,
    intervalType: 'daily', sellMarkupPercent: 2, holdbackPercent: 0, dcaStrategy: 'fixed', dryRun: false };
  mock.method(config, 'getFundConfig', () => fund);
  mock.method(config, 'getExchangeConfig', () => fund);
  mock.method(config, 'getDefaultPair', () => PAIR);
  mock.method(config, 'getGlobalConfig', () => ({ simpleDcaEnabled: true }));
  mock.method(routeUtils, 'resolvePairParam', () => ({ pair: PAIR, error: null }));
  mock.method(adapters, 'getAdapter', () => ({ getCurrentPrice: async () => 100 }));
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
  let entered;
  syncEntered = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { releaseSync = resolve; });
  mock.method(manager, 'checkFilledOrders', async orders => {
    assert.deepEqual(orders.map(order => order.orderId), ['other-sell']);
    entered();
    await gate;
    return [{ orderId: 'other-sell', filledSize: 1, fillValue: 102, fees: 0, netFees: 0 }];
  });
  placements = 0;
  mock.method(manager, 'placeSellOrderWithRetry', async (_config, _buy, _adapter, _retries, scope) => {
    assert.deepEqual(scope, { exchange: EXCHANGE, pair: PAIR });
    return { orderId: `retry-sell-${++placements}`, baseSize: 1, limitPrice: 102 };
  });
  engine = require('../src/dca-engine');
});

afterEach(() => { mock.restoreAll(); clearModules(); });

const invokeSyncRoute = async legacy => {
  const handlers = {};
  const app = {};
  for (const method of ['get', 'put', 'patch', 'post', 'delete']) {
    app[method] = (route, handler) => { handlers[`${method} ${route}`] = handler; };
  }
  require(legacy ? '../src/routes/legacy-routes' : '../src/routes/exchange-routes')(app, {});
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handlers[legacy ? 'post /api/sync' : 'post /api/:exchange/sync'](
    { params: { exchange: EXCHANGE }, query: { pair: PAIR } }, response,
    error => { throw error; },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.filledOrders, 1);
  assert.ok(Number.isFinite(Date.parse(response.body.lastSyncTime)));
  if (!legacy) {
    assert.equal(response.body.exchange, EXCHANGE);
    assert.equal(response.body.pair, PAIR);
  }
  return response.body;
};

for (const entry of ['checkStatus', 'syncFundOrders', 'exchange sync route', 'legacy sync route']) {
  it(`${entry} serializes reconciliation with failed-sell retries`, { timeout: 5000 }, async () => {
    const sync = entry === 'exchange sync route' ? invokeSyncRoute(false)
      : entry === 'legacy sync route' ? invokeSyncRoute(true) : engine[entry](EXCHANGE, PAIR);
    await syncEntered;
    const retry = engine.retryFailedSell(EXCHANGE, PAIR, 'failed-buy');
    // Flush runnable promise callbacks while the exchange response is withheld.
    await new Promise(resolve => setImmediate(resolve));
    const placementsWhileSyncPending = placements;
    const trackedSync = getPendingWrites().some(write => write.label.startsWith(
      entry === 'checkStatus' ? 'dca-status:' : 'dca-sync:',
    ));
    releaseSync();
    const [synced, first] = await Promise.all([sync, retry]);
    const second = await engine.retryFailedSell(EXCHANGE, PAIR, 'failed-buy');
    assert.equal(placementsWhileSyncPending, 0, 'retry must wait for reconciliation to save its snapshot');
    assert.equal(trackedSync, true, 'reconciliation must remain visible to backup maintenance');
    assert.equal(first.success, true);
    assert.equal(first.pair, PAIR);
    assert.equal(second.success, false);
    assert.equal(second.code, 'not_failed');
    assert.equal(placements, 1, 'only one sell may be accepted for the failed buy');
    assert.equal(durable.orders.find(order => order.buyOrderId === 'failed-buy').orderId, 'retry-sell-1');
    assert.equal(durable.orders.find(order => order.buyOrderId === 'failed-buy').status, 'pending');
    assert.equal(durable.orders.find(order => order.buyOrderId === 'other-buy').status, 'filled');
    assert.ok(scopes.every(([_operation, exchange, pair]) => exchange === EXCHANGE && pair === PAIR));
    if (entry === 'syncFundOrders') {
      assert.equal(synced.pair, PAIR);
      assert.deepEqual(synced.filledOrders.map(order => order.orderId), ['other-sell']);
    }
    assert.equal(getPendingWrites().length, 0);
  });
}
