// @ts-check
//
// Issue #1398: a body take-profit that partially filled while the engine was
// down is still resting at boot. recoverState ingests its rows without a
// booking; the startup annotation repair must leave them alone (no guessed
// pairing against a ladder rung), and the fill path must later book every row
// of the order once — not only the rows that pass ingested.
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
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (h) => new Date(T0 + h * 3600_000).toISOString();
let root;
let config;
let engine;

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `expected ${expected}, got ${actual}`);

/**
 * A live body of two equal-price ladder rungs (0.7 + 0.3 BTC @ 100) with its
 * TP `sell` resting for the whole body; 0.3 BTC of it filled while offline.
 */
const setup = () => {
  delete require.cache[require.resolve('../src/fill-ledger')];
  delete require.cache[require.resolve('../src/regime-engine')];
  const { createRegimeEngine, repairHistoricalFillAnnotations } = require('../src/regime-engine');
  engine = createRegimeEngine('coinbase', PAIR, { productId: PAIR, dryRun: false });
  const ledger = engine.getFillLedger();
  ledger.setCurrentCycleId('cycle-1', T0);
  const position = engine._getPositionState();
  const body = celestial.createNewBody({ assetQty: 0.7, costBasis: 70, avgPrice: 100 }, 'buy-a');
  body.buyOrders.push({ orderId: 'buy-b', price: 100, assetQty: 0.3, sizeUsdc: 30, filledAt: T0, consumedQty: 0 });
  body.sourceOrderIds.push('buy-b');
  body.assetQty = 1;
  body.costBasis = 100;
  body.tpOrderId = 'sell';
  body.tpPrice = 110;
  body.assetOnOrder = 1;
  position.celestialBodies = [body];
  celestial.syncPositionState(position, position.celestialBodies);
  ledger.ingestFill({ tradeId: 'buy-a-fill', orderId: 'buy-a', side: 'buy', size: 0.7, price: 100, tradeTime: at(1) });
  ledger.ingestFill({ tradeId: 'buy-b-fill', orderId: 'buy-b', side: 'buy', size: 0.3, price: 100, tradeTime: at(2) });
  for (const id of ['buy-a', 'buy-b']) {
    ledger.annotateFillsByOrderId(id, { bodyId: body.id, isBodyOwned: true, sellOrderId: 'sell' });
  }
  // What recoverState ingested at boot: the offline partial, unannotated.
  const offlinePartial = { tradeId: 'sell-p1', orderId: 'sell', side: 'sell', size: 0.3, price: 110, tradeTime: at(3) };
  ledger.ingestFill(offlinePartial);
  ledger.persist();

  const repair = () => repairHistoricalFillAnnotations({
    fillLedger: ledger,
    positionState: position,
    config: {},
    logger: { info: () => {}, warn: () => {} },
    baseCurrency: 'BTC',
    priceIncrement: 0.01,
    exchange: 'coinbase',
    celestialHierarchy: { findMergeTarget: () => null },
    calculateDynamicTpPercent: () => 1,
    roundPrice: (p) => p,
    roundAsset: (q) => Math.round(q * 1e8) / 1e8,
    fmtPrice: String,
  });

  const rawFills = [offlinePartial,
    { tradeId: 'sell-p2', orderId: 'sell', side: 'sell', size: 0.7, price: 110, tradeTime: at(4) }];
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
  return { ledger, position, body, repair, replacementTps, fill };
};

describe('boot repair of a still-resting body TP with an offline partial (issue #1398)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-repair-live-tp-'));
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

  it('repair leaves the live TP\'s recovered partial unannotated, even when a rung matches its size', () => {
    const { ledger, repair } = setup();
    repair();
    const partial = ledger.getFillsForOrder('sell')[0];
    assert.equal(partial.bodyPnl, undefined);
    assert.equal(partial.bodyHoldbackAsset, undefined);
    assert.equal(partial.isBodyOwned, undefined);
    assert.equal(ledger.getSellBooking('sell'), null);
    for (const id of ['buy-a', 'buy-b']) {
      assert.equal(ledger.getBuyOrderConsumption(id).consumedBy, null, `${id} is not consumed`);
    }
  });

  it('the later booking books the full filled quantity once', async () => {
    const { ledger, position, repair, replacementTps, fill } = setup();
    repair();
    await engine._test.handleOrderFill(fill);

    const booking = ledger.getSellBooking('sell');
    near(booking.bookedSize, 1);
    near(booking.bodyPnl, 10);
    near(booking.bodyCostBasis, 100);
    assert.ok(ledger.getFillsForOrder('sell').every(row => row.bodyBooked), 'every row is covered by the booking');
    near(ledger.getBuyOrderConsumption('buy-a').consumedQty, 0.7);
    near(ledger.getBuyOrderConsumption('buy-b').consumedQty, 0.3);
    assert.equal(position.celestialBodies.length, 0, 'the exchange sold the entire body');
    assert.deepEqual(replacementTps, [], 'already-sold asset must not be listed again');

    // A replay of the same terminal fill books nothing more.
    const capital = config.maxUsdcDeployed;
    await engine._test.handleOrderFill(fill);
    near(ledger.getSellBooking('sell').bookedSize, 1);
    near(ledger.getSellBooking('sell').bodyPnl, 10);
    near(config.maxUsdcDeployed, capital);
  });
});
