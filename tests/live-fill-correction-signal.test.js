// @ts-check
// Economic corrections must work after a real live start installs SIGUSR1.
// Keep every persistence target disposable and every exchange/network seam fake.
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-live-correction-signal');
const paths = require('../src/paths');
const originalDataDir = paths.DATA_DIR;
paths.DATA_DIR = isolated.root;

const configUtils = require('../src/config-utils');
const originalGetConfig = configUtils.getRegimeConfig;
const originalUpdateConfig = configUtils.updateRegimeConfig;
configUtils.getRegimeConfig = () => ({
  ...configUtils.REGIME_DEFAULTS,
  macroEnabled: false,
  ladderAutoSwitch: false,
  entryMode: 'reactive',
  fillDriftSweepMs: 0,
  sizeAutoManaged: false,
  tpAutoManaged: false,
});
configUtils.updateRegimeConfig = () => {};

const websocketFeed = require('../src/websocket-feed');
const originalCreateFeed = websocketFeed.createWebSocketFeed;
websocketFeed.createWebSocketFeed = () => ({ connect() {}, disconnect() {} });
const { createRegimeEngine } = require('../src/regime-engine');
const { createNewBody } = require('../src/celestial-hierarchy');
const stateTracker = require('../src/state-tracker');

after(() => {
  websocketFeed.createWebSocketFeed = originalCreateFeed;
  configUtils.getRegimeConfig = originalGetConfig;
  configUtils.updateRegimeConfig = originalUpdateConfig;
  paths.DATA_DIR = originalDataDir;
  isolated.cleanup();
});

for (const side of ['buy', 'sell']) {
  it(`applies a live ${side} correction and accepts the next fill while owning its reload listener`, { timeout: 5000 }, async () => {
    const pair = `__test_live_${side}_correction__`;
    const listenersBefore = process.listeners('SIGUSR1');
    const engine = createRegimeEngine('coinbase', pair, { productId: 'BTC-USDC', dryRun: false });
    engine._test.setAdapter({
      getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
      getCurrentPrice: async () => 100,
      getOpenOrders: async () => [],
      getAccountBalance: async () => ({ available: 0, hold: 0 }),
      getCandles: async () => [],
      loadCredentials: () => ({ apiKey: 'fixture', apiSecret: 'fixture' }),
    });
    engine._test.setOrderExecutor({
      setPriceIncrement() {},
      getPendingCounts: () => ({ total: 0 }),
      getPendingEntries: () => new Map(),
      getPendingLadderOrders: () => [],
      checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
      cancelAllEntries: async () => {},
      cancelAllLadderOrders: async () => {},
      clearTimers() {},
    });
    engine._test.setRecoveryModule({ recoverState: async () => ({
      position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
      openOrders: new Map(), discrepancies: [],
    }) });

    try {
      assert.equal((await engine.start()).success, true);
      const added = process.listeners('SIGUSR1').filter(listener => !listenersBefore.includes(listener));
      assert.equal(added.length, 1, 'the actual live startup installed a reload listener');
      const ledger = engine.getFillLedger();
      const position = engine._getPositionState();
      const synthetic = ledger.ingestFill({ tradeId: 'synthetic-order', orderId: 'order', side, size: 1, price: 100, netFee: 0 }).fill;
      if (side === 'buy') {
        const body = createNewBody({ totalSize: 1, costBasis: 100, avgPrice: 100 }, 'order');
        position.celestialBodies = [body];
        ledger.annotateFillsByOrderId('order', { bodyId: body.id, isBodyOwned: true });
      } else {
        ledger.commitSellBooking('order', { bodyPnl: 10, bodyCostBasis: 90, bodyBtcQty: 1, bodyHoldbackAsset: 0 },
          { soldSize: 1, bookedTradeIds: [synthetic.tradeId] });
      }
      ledger.persist();

      // Attempt both operations even if the correction fails, so the regression
      // captures the pending journal's effect on an unrelated later execution.
      const failures = [];
      for (const fill of [
        { tradeId: 'real-order', orderId: 'order', side, size: 1, price: 101, netFee: 0 },
        { tradeId: 'unrelated-fill', orderId: 'unrelated-order', side: 'buy', size: 1, price: 10, netFee: 0 },
      ]) {
        try { ledger.ingestFill(fill); }
        catch (error) { failures.push({ tradeId: fill.tradeId, name: error.name, message: error.message }); }
      }
      assert.deepEqual(failures, [], 'correction and subsequent unrelated ingestion must both complete');
      const corrections = ledger.getAllFills().flatMap(row => row[`${side}EconomicCorrections`] || []);
      assert.equal(corrections.length, 1);
      assert.equal(corrections[0].status, 'applied');
      assert.equal(ledger.hasProcessedTrade('unrelated-fill'), true);
      const saved = stateTracker.loadFundRegimeState('coinbase', pair).position;
      assert.ok(saved[`applied${side === 'buy' ? 'Buy' : 'Sell'}Corrections`].includes('real-order'));
      if (side === 'buy') {
        assert.equal(position.celestialBodies[0].costBasis, 101);
        assert.equal(saved.celestialBodies[0].costBasis, 101);
      } else {
        assert.equal(ledger.getSellBooking('order').bodyPnl, 11);
        assert.equal(position.realizedPnL, 11);
        assert.equal(saved.realizedPnL, 11);
      }
      assert.ok(process.listeners('SIGUSR1').includes(added[0]), 'correction retains the live reload listener');
    } finally {
      await engine.stop();
      engine._test.clearTimers();
      assert.deepEqual(process.listeners('SIGUSR1'), listenersBefore, 'stop removes only this engine\'s reload listener');
    }
  });
}
