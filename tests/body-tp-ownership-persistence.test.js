// @ts-check
//
// A body's accepted TP must be on disk before its dispatch intent is released.
// The safety-net placement paths (manual TP rebuild, reconcile, metrics) never
// saved after placeBodyTp, so the new tpOrderId lived only in memory until the
// 5-minute save: a crash in that window restarted the body with no TP, and
// startup placed a second sell beside the untracked original.
//
// Disk safety: throwaway pair under a disposable temp root removed in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-body-tp-ownership-test');

const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine } = require('../src/regime-engine');
const { loadFundRegimeState } = require('../src/state-tracker');

const TEST_PAIR = '__testtpown__';

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

const savedBody = () => loadFundRegimeState('coinbase', TEST_PAIR)?.position?.celestialBodies?.find((b) => b.id === 'b1');

describe('body TP ownership is durable before the placement intent is released', () => {
  it('persists the accepted TP order id from the placement handoff', async () => {
    let onDiskAtHandoff;
    const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: false, productId: TEST_PAIR }, {});
    engines.push(eng);
    eng._test.setRunning(true);
    eng._test.setProductDetails({ baseMinSize: '0.0001', baseIncrement: '0.00000001' });
    eng._test.setAdapter({ getOpenOrders: async () => [] });
    eng._test.setOrderExecutor({
      // Mirrors placeWithUnknownReconcile: the handoff runs after the exchange
      // accepts and before the intent clears; the call returns afterwards.
      placeBodyTpOrder: async (size, price, bodyId, avgPrice, { onAccepted } = {}) => {
        assert.equal(typeof onAccepted, 'function', 'live placements hand the accepted order to its body');
        await onAccepted({ orderId: 'tp-accepted-1', clientOrderId: 'coid-1' });
        onDiskAtHandoff = savedBody();
        return { success: true, orderId: 'tp-accepted-1' };
      },
      cancelTpOrder: async () => ({ success: true }),
      getPendingCounts: () => ({ total: 0 }),
    });
    const pos = eng._getPositionState();
    pos.celestialBodies = [{
      id: 'b1', tier: 'ASTEROID', assetQty: 0.01, costBasis: 500, avgPrice: 50000,
      tpPrice: 0, tpOrderId: null, assetOnOrder: 0,
      buyOrders: [{ orderId: 'seed-b1', price: 50000, assetQty: 0.01, sizeUsdc: 500, filledAt: 1 }],
      sourceOrderIds: ['seed-b1'],
    }];
    pos.totalAsset = 0.01;
    pos.totalCostBasis = 500;
    pos.activeTpOrderId = null;

    const result = await eng.rebuildTP();

    assert.equal(result.success, true);
    assert.equal(onDiskAtHandoff?.tpOrderId, 'tp-accepted-1', 'a crash right after the handoff restarts with the TP owned');
    assert.ok(onDiskAtHandoff.tpPrice > onDiskAtHandoff.avgPrice);
    assert.ok(onDiskAtHandoff.assetOnOrder > 0);
    assert.equal(pos.celestialBodies[0].tpOrderId, 'tp-accepted-1');
  });
});
