// @ts-check
// issue #546 — the Simple-DCA domain layer was pair-blind.
//
// `POST /api/:exchange/trade?pair=ETH-USDC` and `POST /api/:exchange/consolidate`
// resolved and validated the caller's fund selector, used it for their
// pre-checks and logging, and then called `runIntervalCycle(exchange)` /
// `executeConsolidation(exchange, orderIds)` — both of which re-resolved config
// and state through the exchange's DEFAULT fund. On a two-fund exchange the
// operator pressed "Trade Now" on ETH and a real market buy landed on BTC,
// booked against the BTC fund's cost basis; a consolidation cancelled and
// re-placed the BTC fund's live resting orders.
//
// These tests pin the routing with no live exchange access: the fund named by
// the caller is the fund whose config is read, whose product is traded, whose
// state.json is written and whose pending orders are consolidated — while the
// documented default-fund fallback still serves a caller that names no pair.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const orderManager = require('../src/order-manager');
const adapters = require('../src/adapters');
const logger = require('../src/logger');

const DCA_ENGINE = require.resolve('../src/dca-engine');

const EXCHANGE = 'coinbase';
const DEFAULT_PAIR = 'BTC-USDC';
const OTHER_PAIR = 'ETH-USDC';

// Deliberately different per fund, so an assertion on amount/price/product
// cannot pass by coincidence when the wrong fund's config is loaded.
const FUND_CONFIGS = {
  [DEFAULT_PAIR]: { productId: DEFAULT_PAIR, totalAllocation: 1000, maxBuyPrice: 200000, price: 50000 },
  [OTHER_PAIR]: { productId: OTHER_PAIR, totalAllocation: 400, maxBuyPrice: 20000, price: 3000 },
};

/** @type {string} */
let tmpDir;
/** @type {Object} */
let originals;
/** @type {typeof import('../src/dca-engine')} */
let dcaEngine;
/** @type {Array<{productId: string, amount: number, scope: Object}>} */
let buys;
/** @type {Array<{productId: string, orderIds: string[]}>} */
let consolidations;

const fundDir = (pair) => path.join(tmpDir, EXCHANGE, pair);
const stateFile = (pair) => path.join(fundDir(pair), 'state.json');
const readState = (pair) => JSON.parse(fs.readFileSync(stateFile(pair), 'utf8'));

/** Write a fund's state.json in the post-migration per-fund layout. */
const seedState = (pair, state) => {
  fs.mkdirSync(fundDir(pair), { recursive: true });
  fs.writeFileSync(stateFile(pair), JSON.stringify({
    initialAllocation: FUND_CONFIGS[pair].totalAllocation,
    totalAllocated: 0,
    totalIntervalsRun: 0,
    usdcFundSize: FUND_CONFIGS[pair].totalAllocation,
    assetReserves: 0,
    outstandingOrdersUSDC: 0,
    outstandingOrdersAsset: 0,
    totalFees: 0,
    totalRebates: 0,
    netFees: 0,
    lastRunId: null,
    lastRunTimestamp: null,
    orders: [],
    ...state,
  }, null, 2));
};

/** A resting sell tracked against a buy, as recordBuyFill+attachSellOrder leave it. */
const pendingOrder = (pair, n) => ({
  orderId: `sell-${pair}-${n}`,
  buyOrderId: `buy-${pair}-${n}`,
  buyPrice: FUND_CONFIGS[pair].price,
  buyQuantity: 0.01,
  buyUSDC: 100,
  buyFees: 0,
  buyRebates: 0,
  buyNetFees: 0,
  buyCostBasis: 100,
  sellPrice: FUND_CONFIGS[pair].price * 1.02,
  sellQuantity: 0.009,
  holdbackAsset: 0.001,
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-pair-scoping-'));
  buys = [];
  consolidations = [];

  originals = {
    getExchangeDataDir: migration.getExchangeDataDir,
    getFundConfig: configUtils.getFundConfig,
    getDefaultPair: configUtils.getDefaultPair,
    getAdapter: adapters.getAdapter,
    executeDailyBuy: orderManager.executeDailyBuy,
    placeSellOrderWithRetry: orderManager.placeSellOrderWithRetry,
    checkFilledOrders: orderManager.checkFilledOrders,
    consolidatePendingOrders: orderManager.consolidatePendingOrders,
    logBuy: logger.logBuy,
    logSellOrder: logger.logSellOrder,
    logConsolidation: logger.logConsolidation,
  };

  migration.getExchangeDataDir = (exchange) => {
    const dir = path.join(tmpDir, exchange);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  configUtils.getDefaultPair = () => DEFAULT_PAIR;
  configUtils.getFundConfig = (_exchange, pair) => {
    const fund = FUND_CONFIGS[pair || DEFAULT_PAIR];
    return {
      ...fund,
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
  };

  adapters.getAdapter = () => ({
    name: EXCHANGE,
    getCurrentPrice: async (productId) => FUND_CONFIGS[productId].price,
    getAccountBalance: async () => ({ available: 100000, hold: 0 }),
  });

  // The buy is the money move: record exactly which product, how much, and
  // which fund scope the engine handed to the order manager.
  orderManager.executeDailyBuy = async (config, amount, _adapter, scope) => {
    buys.push({ productId: config.productId, amount, scope });
    return {
      orderId: `buy-${config.productId}-${buys.length}`,
      price: FUND_CONFIGS[config.productId].price,
      assetAmount: amount / FUND_CONFIGS[config.productId].price,
      usdcAmount: amount,
      fees: 0,
      rebates: 0,
      netFees: 0,
      actualCost: amount,
      status: 'FILLED',
    };
  };
  orderManager.placeSellOrderWithRetry = async (config, buyDetails) => ({
    orderId: `sell-for-${buyDetails.orderId}`,
    success: true,
    baseSize: buyDetails.assetAmount * 0.9,
    limitPrice: FUND_CONFIGS[config.productId].price * 1.02,
    status: 'OPEN',
  });
  orderManager.checkFilledOrders = async () => [];
  orderManager.consolidatePendingOrders = async (config, pendingOrders) => {
    consolidations.push({ productId: config.productId, orderIds: pendingOrders.map(o => o.orderId) });
    return {
      success: true,
      newOrderId: `consolidated-${config.productId}`,
      consolidatedCount: pendingOrders.length,
      consolidatedPrice: FUND_CONFIGS[config.productId].price * 1.02,
      consolidatedAsset: pendingOrders.reduce((sum, o) => sum + o.sellQuantity, 0),
      cancelledOrderIds: pendingOrders.map(o => o.orderId),
      skippedOrderIds: [],
    };
  };

  // logger destructures its data dir at require time, so it cannot be pointed
  // at the tmp dir — silence the TSV writers instead (the transactions.tsv
  // path is issue #543's, not this one's).
  logger.logBuy = () => {};
  logger.logSellOrder = () => {};
  logger.logConsolidation = () => {};

  // dca-engine destructures its config helpers at require time.
  delete require.cache[DCA_ENGINE];
  dcaEngine = require('../src/dca-engine');
});

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (key === 'getExchangeDataDir') migration.getExchangeDataDir = value;
    else if (key in configUtils) configUtils[key] = value;
    else if (key in adapters) adapters[key] = value;
    else if (key in orderManager) orderManager[key] = value;
    else logger[key] = value;
  }
  delete require.cache[DCA_ENGINE];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runIntervalCycle fund scoping (issue #546)', () => {
  it('buys the NAMED fund\'s product with the NAMED fund\'s amount', async () => {
    seedState(DEFAULT_PAIR);
    seedState(OTHER_PAIR);

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, OTHER_PAIR);

    assert.equal(result.status, 'success');
    assert.equal(buys.length, 1);
    assert.equal(buys[0].productId, OTHER_PAIR, 'a manual trade on ETH must not buy BTC');
    // 400 total / 10 intervals — the ETH fund's budget, not BTC's 1000/10.
    assert.equal(buys[0].amount, 40);
  });

  it('scopes the placement intent to the named fund, not the default one', async () => {
    seedState(OTHER_PAIR);
    await dcaEngine.runIntervalCycle(EXCHANGE, OTHER_PAIR);
    assert.deepEqual(buys[0].scope, { exchange: EXCHANGE, pair: OTHER_PAIR });
  });

  it('persists the fill to the NAMED fund\'s state.json and leaves the default fund untouched', async () => {
    seedState(DEFAULT_PAIR);
    seedState(OTHER_PAIR);
    const defaultBefore = fs.readFileSync(stateFile(DEFAULT_PAIR), 'utf8');

    await dcaEngine.runIntervalCycle(EXCHANGE, OTHER_PAIR);

    const other = readState(OTHER_PAIR);
    assert.equal(other.totalAllocated, 40);
    assert.equal(other.totalIntervalsRun, 1);
    assert.equal(other.orders.length, 1);
    assert.equal(other.orders[0].status, 'pending');

    assert.equal(
      fs.readFileSync(stateFile(DEFAULT_PAIR), 'utf8'),
      defaultBefore,
      'the default fund\'s accounting must not move when another fund trades',
    );
  });

  it('echoes the fund it acted on so a future drift is visible to the caller', async () => {
    seedState(OTHER_PAIR);
    const result = await dcaEngine.runIntervalCycle(EXCHANGE, OTHER_PAIR);
    assert.equal(result.pair, OTHER_PAIR);
  });

  it('still falls back to the default fund when no pair is named (single-fund installs)', async () => {
    seedState(DEFAULT_PAIR);
    seedState(OTHER_PAIR);

    const result = await dcaEngine.runIntervalCycle(EXCHANGE);

    assert.equal(result.pair, DEFAULT_PAIR);
    assert.equal(buys[0].productId, DEFAULT_PAIR);
    assert.equal(buys[0].amount, 100, 'the default fund\'s own 1000/10 budget');
    assert.equal(readState(DEFAULT_PAIR).totalAllocated, 100);
    assert.equal(readState(OTHER_PAIR).totalAllocated, 0);
  });

  it('reads the named fund\'s "already ran this interval" marker, not the default fund\'s', async () => {
    const { getRunIdentifier } = require('../src/interval-utils');
    seedState(DEFAULT_PAIR, { lastRunId: getRunIdentifier('daily') });
    seedState(OTHER_PAIR);

    const result = await dcaEngine.runIntervalCycle(EXCHANGE, OTHER_PAIR);

    assert.equal(result.status, 'success', 'the BTC fund having run today must not skip the ETH fund');
    assert.equal(buys.length, 1);
  });
});

describe('executeConsolidation fund scoping (issue #546)', () => {
  it('consolidates only the NAMED fund\'s pending orders when the body carries no orderIds', async () => {
    seedState(DEFAULT_PAIR, { orders: [pendingOrder(DEFAULT_PAIR, 1), pendingOrder(DEFAULT_PAIR, 2), pendingOrder(DEFAULT_PAIR, 3)] });
    seedState(OTHER_PAIR, { orders: [pendingOrder(OTHER_PAIR, 1), pendingOrder(OTHER_PAIR, 2)] });
    const defaultBefore = fs.readFileSync(stateFile(DEFAULT_PAIR), 'utf8');

    const result = await dcaEngine.executeConsolidation(EXCHANGE, OTHER_PAIR);

    assert.equal(result.success, true);
    assert.equal(result.pair, OTHER_PAIR);
    assert.equal(consolidations.length, 1);
    assert.equal(consolidations[0].productId, OTHER_PAIR);
    assert.deepEqual(
      consolidations[0].orderIds,
      [`sell-${OTHER_PAIR}-1`, `sell-${OTHER_PAIR}-2`],
      'the default fund\'s live resting orders must never be cancelled by another fund\'s consolidation',
    );

    assert.equal(
      fs.readFileSync(stateFile(DEFAULT_PAIR), 'utf8'),
      defaultBefore,
      'the default fund\'s state must not be rewritten',
    );
    assert.ok(readState(OTHER_PAIR).orders.some(o => o.orderId === `consolidated-${OTHER_PAIR}`));
  });

  it('reports the named fund\'s own shortfall rather than the default fund\'s order count', async () => {
    seedState(DEFAULT_PAIR, { orders: [pendingOrder(DEFAULT_PAIR, 1), pendingOrder(DEFAULT_PAIR, 2)] });
    seedState(OTHER_PAIR, { orders: [pendingOrder(OTHER_PAIR, 1)] });

    const result = await dcaEngine.executeConsolidation(EXCHANGE, OTHER_PAIR);

    assert.equal(result.success, false);
    assert.match(result.error, /found 1/);
    assert.equal(consolidations.length, 0, 'nothing may be cancelled on any fund');
  });

  it('still falls back to the default fund when no pair is named', async () => {
    seedState(DEFAULT_PAIR, { orders: [pendingOrder(DEFAULT_PAIR, 1), pendingOrder(DEFAULT_PAIR, 2)] });
    seedState(OTHER_PAIR, { orders: [pendingOrder(OTHER_PAIR, 1), pendingOrder(OTHER_PAIR, 2)] });

    const result = await dcaEngine.executeConsolidation(EXCHANGE);

    assert.equal(result.pair, DEFAULT_PAIR);
    assert.equal(consolidations[0].productId, DEFAULT_PAIR);
  });

  it('honours an explicit orderIds filter within the named fund', async () => {
    seedState(OTHER_PAIR, { orders: [pendingOrder(OTHER_PAIR, 1), pendingOrder(OTHER_PAIR, 2), pendingOrder(OTHER_PAIR, 3)] });

    await dcaEngine.executeConsolidation(EXCHANGE, OTHER_PAIR, [`sell-${OTHER_PAIR}-1`, `sell-${OTHER_PAIR}-3`]);

    assert.deepEqual(consolidations[0].orderIds, [`sell-${OTHER_PAIR}-1`, `sell-${OTHER_PAIR}-3`]);
  });
});

describe('reconcilePlacementIntent fund scoping (issue #546)', () => {
  const stateTracker = require('../src/state-tracker');

  it('resolves an intent recorded against the named fund', async () => {
    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: OTHER_PAIR, action: 'dca_buy', side: 'buy' });
    stateTracker.markPlacementIntentUnresolved(EXCHANGE, OTHER_PAIR, intent.id, { reason: 'socket hang up' });

    const result = await dcaEngine.reconcilePlacementIntent(EXCHANGE, OTHER_PAIR, intent.id, 'discard');

    assert.equal(result.success, true);
    assert.deepEqual(stateTracker.loadPlacementIntents(EXCHANGE, OTHER_PAIR), []);
  });

  it('does not reach into another fund\'s intents', async () => {
    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: OTHER_PAIR, action: 'dca_buy', side: 'buy' });
    stateTracker.markPlacementIntentUnresolved(EXCHANGE, OTHER_PAIR, intent.id, { reason: 'socket hang up' });

    const result = await dcaEngine.reconcilePlacementIntent(EXCHANGE, DEFAULT_PAIR, intent.id, 'discard');

    assert.equal(result.success, false);
    assert.equal(stateTracker.loadPlacementIntents(EXCHANGE, OTHER_PAIR).length, 1, 'the other fund\'s intent is untouched');
  });

  it('blocks a cycle on the named fund\'s unresolved intent only', async () => {
    seedState(DEFAULT_PAIR);
    seedState(OTHER_PAIR);
    const intent = stateTracker.recordPlacementIntent({ exchange: EXCHANGE, pair: OTHER_PAIR, action: 'dca_buy', side: 'buy' });
    stateTracker.markPlacementIntentUnresolved(EXCHANGE, OTHER_PAIR, intent.id, { reason: 'socket hang up' });

    assert.equal((await dcaEngine.runIntervalCycle(EXCHANGE, OTHER_PAIR)).status, 'placement_unresolved');
    assert.equal((await dcaEngine.runIntervalCycle(EXCHANGE, DEFAULT_PAIR)).status, 'success');
  });
});
