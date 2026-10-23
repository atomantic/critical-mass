// @ts-check
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-engine-status');
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const { createRegimeEngine } = require('../src/regime-engine');
const { DEFAULT_FEE_RATE_PER_SIDE } = require('../shared/fee-defaults.mjs');

const engines = [];
const makeEngine = (dryRun = false) => {
  const engine = createRegimeEngine('coinbase', `__status-${engines.length}__`, {
    productId: 'BTC-USDC', dryRun,
  });
  engines.push(engine);
  return engine;
};

after(() => {
  for (const engine of engines) engine._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  isolatedData.cleanup();
});

describe('engine status projection', () => {
  it('enriches live body TPs and retains each untracked persisted TP once', () => {
    const engine = makeEngine();
    const position = engine._getPositionState();
    const body = {
      id: 'body-1', tier: 'MOON', tpOrderId: 'tp-1', assetQty: 2,
      costBasis: 200, avgPrice: 100, tpPrice: 110, assetOnOrder: 1.9,
    };
    position.celestialBodies = [body, { ...body, id: 'body-2', tpOrderId: 'tp-2' }];
    const orders = [
      { orderId: 'entry-1', type: 'entry', price: 90, staleMs: 0 },
      { orderId: 'tp-1', type: 'take_profit', price: 110, size: 1.9 },
    ];
    engine._test.setOrderExecutor({
      capabilities: { liveReconciliation: true },
      getPendingOrdersList: () => orders,
      getPendingCounts: () => ({ entries: 1, takeProfits: 1, total: 2 }),
      getEffectiveStaleMs: () => 1234,
    });

    const status = engine.getStatus();
    assert.strictEqual(status.position, position);
    assert.strictEqual(status.market, engine._getMarketState());
    assert.strictEqual(status.pendingOrders[0], orders[0]);
    assert.deepEqual(status.pendingOrders.map(order => order.orderId), ['entry-1', 'tp-1', 'tp-2']);
    const tp = status.pendingOrders[1];
    assert.equal(tp.type, 'body_tp');
    assert.equal(tp.tpPercent, '10.00');
    assert.equal(tp.bodyId, body.id);
    assert.equal(tp.bodyCostBasis, 200);
    assert.equal(tp.bodyBtcQty, 2);
    assert.equal(orders[1].type, 'take_profit', 'enrichment must not mutate executor orders');
    assert.equal(status.pendingEntryStaleMs, 0);
    assert.equal(status.effectiveStaleMs, 1234);
    assert.equal(status.isRunning, false, 'an existing stopped engine retains pending TP reporting');
  });

  it('reads replacement executors, runtime flags and updated configuration after refreshing accounting', () => {
    const engine = makeEngine();
    const position = engine._getPositionState();
    engine.getFillLedger().getDerivedRealizedPnL = () => ({
      realizedPnL: 42, realizedAssetPnL: 0.25, heldOpenBuyCostBasis: 80,
    });
    const installExecutor = staleMs => engine._test.setOrderExecutor({
      capabilities: { liveReconciliation: true },
      getPendingOrdersList: () => {
        assert.equal(position.realizedPnL, 42, 'accounting refresh precedes status assembly');
        return [{ orderId: 'entry', type: 'entry', staleMs }];
      },
      getPendingCounts: () => ({ entries: 1, total: 1 }),
      getEffectiveStaleMs: () => staleMs,
    });
    delete engine._getConfig().feeRate;
    installExecutor(123);
    assert.equal(engine.getState().config.feeRatePerSide, DEFAULT_FEE_RATE_PER_SIDE);
    assert.equal(engine.getState().effectiveStaleMs, 123);

    installExecutor(456);
    engine._test.setRunning(true);
    Object.assign(engine._getConfig(), { feeRate: 0, ladderAutoSwitch: true, ladderAutoSwitchVolMult: 2 });
    Object.assign(engine._getMarketState(), { volBaseline: 1, realizedVol: 3 });
    const status = engine.getState();
    assert.equal(status.isRunning, true);
    assert.equal(status.effectiveStaleMs, 456);
    assert.equal(status.pendingEntryStaleMs, 456);
    assert.equal(status.config.feeRatePerSide, 0);
    assert.equal(status.entryMode, 'ladder');
    assert.equal(status.autoSwitch.volExpansion, 3);
    assert.equal(status.position.realizedAssetPnL, 0.25);
    assert.equal(status.position.heldAssetCostBasis, 80);
  });

  it('uses dry-run orders for stale timing while preserving the separate simulated payload', () => {
    const engine = makeEngine(true);
    const dryRun = { pendingOrders: [{ orderId: 'sim-entry', type: 'entry', staleMs: 987 }] };
    engine._getConfig().orderStaleMs = 654;
    engine._test.setOrderExecutor({
      capabilities: { liveReconciliation: false },
      getPendingOrdersList: () => { throw new Error('live order lookup in dry-run'); },
      getDryRunState: () => dryRun,
      getPendingCounts: () => ({ entries: 1, total: 1 }),
    });
    const status = engine.getStatus();
    assert.equal(status.isDryRun, true);
    assert.strictEqual(status.dryRun, dryRun);
    assert.deepEqual(status.pendingOrders, []);
    assert.deepEqual(status.placementIntents, []);
    assert.equal(status.pendingEntryStaleMs, 987);
    assert.equal(status.effectiveStaleMs, 654);
  });
});
