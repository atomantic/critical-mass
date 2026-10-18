// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const adapters = require('../src/adapters');
const celestial = require('../src/celestial-hierarchy');

const originalDir = migration.getExchangeDataDir;
const originalConfig = configUtils.getRegimeConfig;
const originalUpdate = configUtils.updateRegimeConfig;
const originalAdapter = adapters.getAdapter;
const PAIR = 'BTC-USDC';
let root;
let config;
let engine;

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `expected ${expected}, got ${actual}`);

const setupSell = (previousSize = 0) => {
  delete require.cache[require.resolve('../src/fill-ledger')];
  delete require.cache[require.resolve('../src/regime-engine')];
  const { createRegimeEngine } = require('../src/regime-engine');
  engine = createRegimeEngine('coinbase', PAIR, { productId: PAIR, dryRun: false });
  const ledger = engine.getFillLedger();
  const position = engine._getPositionState();
  const body = celestial.createNewBody({ assetQty: 1, costBasis: 100, avgPrice: 100 }, 'buy');
  body.tpOrderId = 'sell';
  body.tpPrice = 110;
  body.assetQty = 1 - previousSize;
  body.costBasis = 100 * body.assetQty;
  body.assetOnOrder = body.assetQty;
  body.buyOrders[0].consumedQty = previousSize;
  position.celestialBodies = [body];
  celestial.syncPositionState(position, position.celestialBodies);
  ledger.ingestFill({ tradeId: 'buy-fill', orderId: 'buy', side: 'buy', size: 1, price: 100 });
  ledger.annotateFillsByOrderId('buy', { bodyId: body.id, isBodyOwned: true, sellOrderId: 'sell' });
  const rawFills = [];
  if (previousSize > 0) {
    const old = { tradeId: 'previous-sell', orderId: 'sell', side: 'sell', size: previousSize, price: 110 };
    rawFills.push(old);
    ledger.ingestFill(old);
    ledger.recordBuyConsumption('buy', 'sell', previousSize);
    ledger.commitSellBooking('sell', { isBodyOwned: true, bodyId: body.id,
      bodyPnl: 10 * previousSize, bodyCostBasis: 100 * previousSize,
      bodyBtcQty: previousSize, bodyHoldbackAsset: 0, partialFill: true },
    { soldSize: previousSize, bookedTradeIds: [old.tradeId] });
    ledger.claimCapitalCredit('sell', previousSize);
    config.maxUsdcDeployed += 10 * previousSize;
  }
  const validSize = previousSize > 0 ? 0.2 : 0.4;
  rawFills.push({ tradeId: 'valid-sell', orderId: 'sell', side: 'sell', size: validSize, price: 110 });
  rawFills.push({ tradeId: 'malformed-sell', orderId: 'sell', side: 'sell',
    size: 1 - previousSize - validSize, price: 110, fee: 'malformed' });
  ledger.persist();
  const replacementTps = [];
  engine._test.setOrderExecutor({
    getOrderPlacedAt: () => null,
    getPendingLadderOrders: () => [],
    removeBodyTracking: () => {},
    handleOrderFill: () => {},
    placeBodyTpOrder: async (qty) => {
      replacementTps.push(qty);
      return { success: true, orderId: 'replacement-sell' };
    },
  });
  engine._test.setAdapter({ getOrderFills: async () => rawFills });
  const fill = { orderId: 'sell', side: 'sell', status: 'FILLED', filledSize: 1,
    filledValue: 110, averageFilledPrice: 110, totalFees: 0 };
  return { ledger, position, replacementTps, fill };
};

describe('terminal sell booking after malformed trade evidence', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-sell-gap-'));
    migration.getExchangeDataDir = exchange => path.join(root, exchange);
    config = { ...originalConfig('coinbase', PAIR), maxUsdcDeployed: 1000,
      tpAutoManaged: false, sizeAutoManaged: false };
    configUtils.getRegimeConfig = () => config;
    configUtils.updateRegimeConfig = (_exchange, _pair, updates) => Object.assign(config, updates);
    adapters.getAdapter = exchange => ({ name: exchange, capabilities: {} });
  });
  afterEach(() => {
    engine?._test.clearTimers();
    engine = null;
    migration.getExchangeDataDir = originalDir;
    configUtils.getRegimeConfig = originalConfig;
    configUtils.updateRegimeConfig = originalUpdate;
    adapters.getAdapter = originalAdapter;
    delete require.cache[require.resolve('../src/regime-engine')];
    delete require.cache[require.resolve('../src/fill-ledger')];
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const previousSize of [0, 0.4]) {
    it(`${previousSize ? 'advancing' : 'first'} sell books valid evidence plus its terminal gap once`, async () => {
      const { ledger, position, replacementTps, fill } = setupSell(previousSize);
      await engine._test.handleOrderFill(fill);
      near(ledger.getRecordedSizeForOrder('sell'), 1);
      near(ledger.getSellBooking('sell').bookedSize, 1);
      near(ledger.getSellBooking('sell').bodyPnl, 10);
      near(ledger.getBuyOrderConsumption('buy').consumedQty, 1);
      assert.equal(position.celestialBodies.length, 0, 'the exchange sold the entire body');
      assert.deepEqual(replacementTps, [], 'already-sold asset must not be listed again');
      assert.ok(ledger.getFillsForOrder('sell').every(row => row.bodyBooked));
      const capital = config.maxUsdcDeployed;
      await engine._test.handleOrderFill(fill);
      near(ledger.getSellBooking('sell').bookedSize, 1);
      near(ledger.getSellBooking('sell').bodyPnl, 10);
      near(config.maxUsdcDeployed, capital);
      assert.deepEqual(replacementTps, []);
    });
  }
});
