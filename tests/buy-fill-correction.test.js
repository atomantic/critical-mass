// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const migration = require('../src/migration');
const configUtils = require('../src/config-utils');
const state = require('../src/state-tracker');
const { createNewBody } = require('../src/celestial-hierarchy');
const { createClosedTrades } = require('../src/closed-trades');
const { projectBuyCorrection } = require('../src/buy-fill-correction');
const originalDir = migration.getExchangeDataDir;
const originalConfig = configUtils.getRegimeConfig;
const originalUpdate = configUtils.updateRegimeConfig;
const originalRename = fs.renameSync;
const EXCHANGE = 'coinbase';
const PAIR = 'BTC-USDC';
let root;
let config;
const createLedger = () => {
  delete require.cache[require.resolve('../src/fill-ledger')];
  return require('../src/fill-ledger').createFillLedger(EXCHANGE, PAIR, PAIR);
};
const real = (tradeId, size, price, fee = 0) => ({ tradeId, orderId: 'buy', side: 'buy', size, price, netFee: fee });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const position = () => state.loadRegimeState(EXCHANGE, PAIR).position;

describe('terminal buy economic reconciliation (#836)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'buy-correction-'));
    migration.getExchangeDataDir = exchange => path.join(root, exchange);
    config = { ...originalConfig(EXCHANGE, PAIR), maxUsdcDeployed: 1000 };
    configUtils.getRegimeConfig = () => ({ ...config });
    configUtils.updateRegimeConfig = (_exchange, _pair, updates) => { config = { ...config, ...updates }; };
  });
  afterEach(() => {
    fs.renameSync = originalRename;
    migration.getExchangeDataDir = originalDir;
    configUtils.getRegimeConfig = originalConfig;
    configUtils.updateRegimeConfig = originalUpdate;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = ({ consumed = 0, holdback = 0, closed = false } = {}) => {
    const ledger = createLedger();
    const cycleId = ledger.startNewCycle();
    ledger.ingestFill({ ...real('synthetic-buy-1', 1, 100), syntheticCoverage: { orderId: 'buy' } });
    const body = createNewBody({ totalSize: 1, costBasis: 100, avgPrice: 100 }, 'buy');
    body.id = 'body';
    body.tpOrderId = 'tp';
    body.tpPrice = 110;
    body.assetOnOrder = 0.9;
    const sold = consumed - holdback;
    if (consumed) {
      ledger.ingestFill({ tradeId: 'sell-row', orderId: 'sale', side: 'sell', size: sold, price: 120 });
      ledger.recordBuyConsumption('buy', 'sale', consumed);
      ledger.commitSellBooking('sale', { bodyPnl: 120 * sold - 100 * sold,
        bodyCostBasis: 100 * sold, bodyBtcQty: sold, bodyHoldbackAsset: holdback, bodyId: 'body' }, { soldSize: sold });
      ledger.claimCapitalCredit('sale', sold);
      body.buyOrders[0].consumedQty = consumed;
      body.assetQty = 1 - consumed;
      body.costBasis = 100 * (1 - consumed);
      const audit = createClosedTrades(EXCHANGE, PAIR);
      audit.record({ sellOrderId: 'sale', timestamp: 1, qtySold: sold,
        sellProceeds: 120 * sold, sellFees: 0, costBasis: 100 * sold,
        pnl: 20 * sold, buyAvgPrice: 100, holdbackAsset: holdback, buyOrderIds: ['buy'] });
    }
    ledger.annotateFillsByOrderId('buy', { bodyId: 'body', isBodyOwned: true });
    ledger.persist();
    state.saveRegimeState({ celestialBodies: closed ? [] : [body], totalAsset: body.assetQty,
      totalCostBasis: body.costBasis, activeCycleId: cycleId, cyclesCompleted: closed ? 1 : 0 }, {}, EXCHANGE, null, null, PAIR);
    return { ledger, cycleId };
  };

  it('replaces higher then lower economics, preserving quantity, residual and TP identity across reload', () => {
    let { ledger, cycleId } = seed();
    ledger.ingestFill(real('higher', 0.4, 110, 1), null, { skipPersist: true });
    near(position().celestialBodies[0].costBasis, 105);
    near(position().celestialBodies[0].assetQty, 1);
    assert.equal(position().celestialBodies[0].needsTpReprice, true);
    assert.equal(position().celestialBodies[0].tpOrderId, 'tp');
    ledger = createLedger();
    ledger.ingestFill(real('lower', 0.6, 90, 0.5));
    near(ledger.getBuyOrderConsumption('buy').cost, 99.5);
    near(position().celestialBodies[0].costBasis, 99.5);
    near(position().celestialBodies[0].buyOrders[0].sizeUsdc, 99.5);
    assert.equal(position().activeCycleId, cycleId);
    ledger = createLedger();
    assert.equal(ledger.ingestFill(real('lower', 0.6, 90, 0.5)).ingested, false);
    near(position().celestialBodies[0].costBasis, 99.5);
  });

  it('converges after successive sub-cent corrections instead of rounding every delta', () => {
    const { ledger } = seed({ consumed: 0.4 });
    ledger.ingestFill(real('first', 0.5, 100.012));
    ledger.ingestFill(real('second', 0.5, 100.012));
    near(position().celestialBodies[0].costBasis, 60.01);
    near(ledger.getBuyOrderConsumption('buy').cost, 100.012);
    near(config.maxUsdcDeployed, 1000);
    const audit = createClosedTrades(EXCHANGE, PAIR);
    audit.load();
    near(audit.getTotalPnL(), 8);
  });

  it('corrects consumed cost, audit P&L and credited capital without changing consumption', () => {
    const { ledger } = seed({ consumed: 0.4 });
    ledger.ingestFill(real('actual', 1, 110, 2));
    near(position().celestialBodies[0].costBasis, 67.2);
    near(position().celestialBodies[0].buyOrders[0].sizeUsdc, 112);
    near(ledger.getSellBooking('sale').bodyCostBasis, 44.8);
    near(ledger.getSellBooking('sale').bodyPnl, 3.2);
    near(position().realizedPnL, 3.2);
    near(config.maxUsdcDeployed, 995.2);
    assert.deepEqual(ledger.getBuyOrderConsumption('buy').consumedBy, { sale: 0.4 });
    const audit = createClosedTrades(EXCHANGE, PAIR);
    audit.load();
    near(audit.getTotalPnL(), 3.2);
    assert.equal(position().cyclesCompleted, 0);
  });

  it('adjusts only the consumed cost whose sell capital watermark was credited', () => {
    const { ledger } = seed({ consumed: 0.4 });
    ledger.annotateFillsByOrderId('sale', { capitalCreditedSize: 0.2 });
    ledger.persist();
    ledger.ingestFill(real('actual', 1, 110));
    near(ledger.getSellBooking('sale').bodyPnl, 4);
    near(config.maxUsdcDeployed, 998);
    createLedger().resumeBuyCorrections();
    near(config.maxUsdcDeployed, 998);
  });

  it('corrects a closed body and preserves the closing TP holdback proration', () => {
    const { ledger, cycleId } = seed({ consumed: 1, holdback: 0.1, closed: true });
    ledger.ingestFill(real('actual', 1, 90));
    assert.deepEqual(position().celestialBodies, []);
    near(ledger.getSellBooking('sale').bodyCostBasis, 81);
    near(ledger.getSellBooking('sale').bodyPnl, 27);
    near(ledger.getSellBooking('sale').bodyHoldbackAsset, 0.1);
    near(config.maxUsdcDeployed, 1009);
    assert.equal(position().activeCycleId, cycleId);
    assert.equal(position().cyclesCompleted, 1);
  });

  it('reconciles crossed coverage and subsequent residual prices against their original baseline', () => {
    const { ledger } = seed();
    // Distinct annotations force preserve mode for the covered rows.
    const synthetic = ledger.getAllFills()[0];
    synthetic.syntheticCoverage.reconciledTrades = [];
    // A crossed execution preserves covered ownership and exposes excess only.
    const result = ledger.ingestFill(real('crossed', 1.2, 110, 1.2));
    near(result.newQuantity, 0.2);
    near(result.bookableFills.reduce((sum, fill) => sum + fill.size, 0), 0.2);
    near(position().celestialBodies[0].costBasis, 111);
    near(ledger.getBuyOrderConsumption('buy').cost, 133.2);
    assert.equal(ledger.ingestFill(real('crossed', 1.2, 110, 1.2)).ingested, false);
  });

  it('uses original residual economics after several preserved allocations', () => {
    let { ledger } = seed();
    const row = ledger.getAllFills()[0];
    row.syntheticCoverage.reconciledTrades = [{ tradeId: 'prior', size: 0.2,
      quoteAmount: 20, fee: 0, netFee: 0, rebate: 0 }];
    ledger.markDirty();
    ledger.persist();
    ledger = createLedger();
    ledger.ingestFill(real('higher', 0.3, 110, 0.3));
    near(position().celestialBodies[0].costBasis, 103.3);
    ledger = createLedger();
    ledger.ingestFill(real('lower', 0.5, 90, 0.5));
    near(position().celestialBodies[0].costBasis, 98.8);
    near(ledger.getBuyOrderConsumption('buy').cost, 98.8);
    assert.equal(ledger.getRecordedSizeForOrder('buy'), 1);
    assert.equal(ledger.getAllFills().length, 1, 'fully covered real identities retain their quantity owner');
    ledger = createLedger();
    assert.equal(ledger.ingestFill(real('higher', 0.3, 110, 0.3)).ingested, false);
    near(position().celestialBodies[0].costBasis, 98.8);
  });

  it('projects cost onto split body tranches and keeps the live retry idempotent', () => {
    const correction = { id: 'actual', orderId: 'buy', size: 1, costDelta: 10,
      consumedQty: 0.2, owned: true, sells: [] };
    const original = { celestialBodies: [
      { id: 'a', assetQty: 0.2, costBasis: 20, buyOrders: [{ orderId: 'buy', assetQty: 0.4, consumedQty: 0.2, sizeUsdc: 40 }] },
      { id: 'b', assetQty: 0.6, costBasis: 60, tpOrderId: 'tp', buyOrders: [{ orderId: 'buy', assetQty: 0.6, consumedQty: 0, sizeUsdc: 60 }] },
    ] };
    const projected = projectBuyCorrection(original, correction);
    near(projected.celestialBodies[0].costBasis, 22);
    near(projected.celestialBodies[1].costBasis, 66);
    near(projected.totalCostBasis, 88);
    assert.equal(projected.celestialBodies[1].needsTpReprice, true);
    assert.deepEqual(projectBuyCorrection(projected, correction), projected);
    near(original.celestialBodies[0].costBasis, 20);
  });

  it('retains a durable pending correction when the position save fails and resumes before dedup', () => {
    let { ledger } = seed({ consumed: 0.4 });
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('regime-state.json')) throw Object.assign(new Error('injected position fault'), { code: 'EIO' });
      return originalRename(from, to);
    };
    assert.throws(() => ledger.ingestFill(real('actual', 1, 110)), /injected position fault/);
    fs.renameSync = originalRename;
    near(position().celestialBodies[0].costBasis, 60);
    ledger = createLedger();
    assert.equal(ledger.getAllFills().some(row => row.buyEconomicCorrections?.some(c => c.status === 'pending')), true);
    assert.equal(ledger.ingestFill(real('actual', 1, 110)).ingested, false);
    near(position().celestialBodies[0].costBasis, 66);
    near(ledger.getSellBooking('sale').bodyPnl, 4);
    near(config.maxUsdcDeployed, 996);
    ledger = createLedger();
    ledger.resumeBuyCorrections();
    near(position().celestialBodies[0].costBasis, 66);
    near(config.maxUsdcDeployed, 996);
  });

  it('retries an audit failure after position and capital publication exactly once', () => {
    let { ledger } = seed({ consumed: 0.4 });
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('closed-trades.json')) throw new Error('injected audit fault');
      return originalRename(from, to);
    };
    assert.throws(() => ledger.ingestFill(real('actual', 1, 110)), /injected audit fault/);
    fs.renameSync = originalRename;
    near(position().celestialBodies[0].costBasis, 66);
    near(config.maxUsdcDeployed, 996);
    ledger = createLedger();
    ledger.resumeBuyCorrections();
    near(position().celestialBodies[0].costBasis, 66);
    near(config.maxUsdcDeployed, 996);
    const audit = createClosedTrades(EXCHANGE, PAIR);
    audit.load();
    near(audit.getTotalPnL(), 4);
  });

  it('rolls back economics and sell annotations if the journal cannot publish', () => {
    const { ledger } = seed({ consumed: 0.4 });
    const before = structuredClone(ledger.getAllFills());
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('fill-ledger.json')) throw new Error('injected ledger fault');
      return originalRename(from, to);
    };
    assert.throws(() => ledger.ingestFill(real('actual', 1, 110)), /injected ledger fault/);
    fs.renameSync = originalRename;
    assert.deepEqual(ledger.getAllFills(), before);
    assert.deepEqual(createLedger().getAllFills(), before);
    near(position().celestialBodies[0].costBasis, 60);
    ledger.ingestFill(real('actual', 1, 110));
    near(position().celestialBodies[0].costBasis, 66);
  });

  it('manual retries refresh corrected totals without injecting or growing another body', async () => {
    const { ledger } = seed();
    const { createManualTradeStore } = require('../src/manual-trades');
    const { createManualTradeImporter } = require('../src/manual-trade-import');
    const store = createManualTradeStore(EXCHANGE, PAIR);
    const trade = store.addManualBuy({ buyOrderId: 'buy', buySize: 1, buyPrice: 100, buyQuoteAmount: 100 });
    store.markTpPlaced(trade.id, 'body');
    const importer = createManualTradeImporter({ exchange: EXCHANGE, pair: PAIR, store,
      fillLedger: ledger, adapter: { getOrderFills: async () => [{ ...real('actual', 1, 110), tradeTime: new Date().toISOString() }] },
      injectBody: async () => assert.fail('must preserve owned quantity'),
      extendBody: async () => assert.fail('cost-only correction must not grow the body'),
    });
    assert.equal((await importer.importBuy({ buyOrderId: 'buy' })).success, true);
    near(store.getById(trade.id).buyQuoteAmount, 110);
    near(store.getById(trade.id).buySize, 1);
    near(position().celestialBodies[0].costBasis, 110);
    assert.equal((await importer.importBuy({ buyOrderId: 'buy' })).success, true);
    near(position().celestialBodies[0].costBasis, 110);
  });

  it('reconciles live ingress and replaces a flagged TP only after a confirmed cancellation', async () => {
    seed();
    const { createRegimeEngine } = require('../src/regime-engine');
    const engine = createRegimeEngine(EXCHANGE, PAIR, { productId: PAIR, dryRun: false }, {});
    Object.assign(engine._getPositionState(), position());
    engine._test.setRunning(true);
    engine._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
    engine._test.setAdapter({ getOrderFills: async () => [real('actual', 1, 110)],
      getOrder: async () => ({ status: 'OPEN', filledSize: 0 }), getOpenOrders: async () => [] });
    let confirmed = false;
    let placements = 0;
    engine._test.setOrderExecutor({ getOrderPlacedAt: () => null, isLadderOrder: () => false,
      checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
      getPendingEntries: () => new Map(), getPendingLadderOrders: () => [],
      getPendingCounts: () => ({ total: 0 }), removeBodyTracking: () => {}, handleOrderFill: () => {},
      cancelBodyTpOrder: async () => ({ cancelled: confirmed }),
      placeBodyTpOrder: async () => { placements++; return { success: true, orderId: 'new-tp' }; },
    });
    engine._test.setRecoveryModule({ reconcile: async () => ({ updated: false }) });
    try {
      const originalBody = engine._getPositionState().celestialBodies[0];
      await engine._test.handleOrderFill({ orderId: 'buy', side: 'buy', status: 'FILLED', filledSize: 1, filledValue: 110 });
      near(originalBody.costBasis, 110);
      near(originalBody.assetQty, 1);
      assert.equal(originalBody.needsTpReprice, true);
      await engine._test.reconcileTick();
      assert.equal(placements, 0);
      assert.equal(originalBody.tpOrderId, 'tp');
      confirmed = true;
      await engine._test.reconcileTick();
      assert.equal(placements, 1);
      assert.equal(originalBody.tpOrderId, 'new-tp');
      assert.equal(originalBody.needsTpReprice, false);
      await engine._test.handleOrderFill({ orderId: 'buy', side: 'buy', status: 'FILLED', filledSize: 1, filledValue: 110 });
      near(originalBody.costBasis, 110);
      assert.equal(engine._getPositionState().celestialBodies.length, 1);
    } finally { engine._test.clearTimers(); }
  });

  it('keeps uncertain ownership pending without hiding it behind duplicate success', () => {
    let { ledger } = seed();
    const saved = position();
    saved.celestialBodies = [];
    state.saveRegimeState(saved, {}, EXCHANGE, null, null, PAIR);
    assert.throws(() => ledger.ingestFill(real('actual', 1, 110)), { buyCorrectionPending: true });
    ledger = createLedger();
    assert.throws(() => ledger.ingestFill(real('actual', 1, 110)), { buyCorrectionPending: true });
  });
});
