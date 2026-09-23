// @ts-check
//
// Startup-level regression coverage for issue #726's delta review (round 5):
// the startup reprice pass (regime-engine.js, ~line 1824) cancels and
// re-places a body's TP that either exceeds the configured max TP% or was
// flagged `needsTpReprice` by extendPersistedBody (a manual buy grew the
// body's assetQty while the engine was stopped, with no adapter/executor
// available there to safely cancel the live TP itself).
//
// Two bugs fixed here:
//  1. The pass unconditionally skipped every body carrying a manual TP%
//     override (`body.manualTpPct != null`) BEFORE ever checking
//     needsTpReprice — so a manual-TP body extended while stopped kept its
//     undersized TP forever, and the flag never cleared. placeBodyTp
//     already reapplies body.manualTpPct whenever it re-places, so the
//     manual-TP skip must apply only to the overpriced-vs-max trigger, not
//     to needsTpReprice.
//  2. When the restore loop instead finds the old TP already gone from the
//     exchange (tpOrderId nulled, a fresh TP gets placed later already
//     sized from the current, already-grown assetQty), needsTpReprice must
//     be cleared too — otherwise the next restart does a needless
//     cancel-and-replace of a TP that's already correctly sized.
//
// Disk safety: throwaway pairs live under a disposable temp root, removed
// in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-startup-tp-reprice-test');

// The size optimizer persists per-pair into the SHARED data/config.json, so a
// throwaway pair would register itself as a real fund. Neutralize BEFORE
// regime-engine is required — it destructures updateRegimeConfig at load.
const configUtils = require('../src/config-utils');
const originalUpdateRegimeConfig = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};

// regime-engine's connectWebSocket() calls a REAL createWebSocketFeed(...) —
// stub it BEFORE requiring regime-engine (which destructures it at load) so
// start() never attempts a real network connection.
const websocketFeedModule = require('../src/websocket-feed');
const originalCreateWebSocketFeed = websocketFeedModule.createWebSocketFeed;
websocketFeedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });

const { createRegimeEngine } = require('../src/regime-engine');

const engines = [];
after(async () => {
  // start() schedules production setInterval timers (state save, metrics,
  // reconcile) that _test.clearTimers() does not touch — only stop() clears
  // those, in its finally block.
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

const TP_ORDER_ID = 'tp-manual-old';

/**
 * Minimal adapter covering everything a clean engine start() touches, plus
 * the per-test override for the restored body's TP order lookup.
 */
const makeAdapter = (over = {}) => ({
  getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
  getCurrentPrice: async () => 92000,
  getOpenOrders: async () => [],
  getAccountBalance: async () => ({ available: 0, hold: 0 }),
  getOrder: async (orderId) => (orderId === TP_ORDER_ID ? { status: 'OPEN', filledSize: 0 } : { status: 'OPEN', filledSize: 0 }),
  getOrderFills: async () => [],
  loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
  ...over,
});

const makeBody = () => ({
  id: 'body-manual-1',
  tier: 'satellite',
  assetQty: 0.006, // already grown by extendPersistedBody while the engine was stopped
  avgPrice: 90333.33,
  costBasis: 542,
  tpOrderId: TP_ORDER_ID,
  tpPrice: 92700, // sized against the OLD (pre-extend) assetQty — now stale
  assetOnOrder: 0.004, // stale: the resting order was never resized to 0.006
  manualTpPct: 2.5, // operator-set override — must survive the reprice
  needsTpReprice: true, // set by extendPersistedBody (manual-trade-import.js)
  sourceOrderIds: ['buy-1', 'buy-1'],
  buyOrders: [
    { orderId: 'buy-1', price: 90000, assetQty: 0.005, sizeUsdc: 450 },
    { orderId: 'buy-1', price: 92000, assetQty: 0.001, sizeUsdc: 92 },
  ],
  mergeCount: 1,
});

const makeEngine = (pair, adapterOverrides, executorOverrides = {}) => {
  const cancels = [];
  const placed = [];
  const restores = [];
  const eng = createRegimeEngine('coinbase', pair, { dryRun: false, productId: pair }, {});
  eng._test.setAdapter(makeAdapter(adapterOverrides));
  eng._test.setOrderExecutor({
    setPriceIncrement: () => {},
    getPendingCounts: () => ({ total: 0 }),
    getOrderPlacedAt: () => null,
    isLadderOrder: () => false,
    restorePendingOrder: () => {},
    markSettled: () => {},
    checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
    handleOrderFill: () => {},
    restoreBodyTpOrder: (bodyId, tpOrderId, assetOnOrder, tpPrice, placedAt) => {
      restores.push({ bodyId, tpOrderId, assetOnOrder, tpPrice, placedAt });
    },
    cancelBodyTpOrder: async (bodyId, orderId) => { cancels.push(orderId); return { cancelled: true, filled: false, filledSize: 0 }; },
    placeBodyTpOrder: async (size, price) => { placed.push([size, price]); return { success: true, orderId: 'tp-manual-new' }; },
    removeBodyTracking: () => {},
    exportState: () => ({}),
    cancelAllEntries: async () => {},
    cancelAllLadderOrders: async () => {},
    cancelTpOrder: async () => ({ cancelled: true }),
    handleOrderCancel: () => {},
    ...executorOverrides,
  });
  eng._test.setRecoveryModule({
    recoverState: async () => ({
      position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
      openOrders: new Map(),
      discrepancies: [],
    }),
  });
  engines.push(eng);
  return { eng, cancels, placed, restores };
};

describe('startup TP reprice for a manual-TP body flagged needsTpReprice (issue #726 delta review, round 5)', () => {
  it('cancels and re-places the TP at the grown assetQty, reapplies manualTpPct, and clears the flag', async () => {
    const { eng, cancels, placed, restores } = makeEngine('__test726reprice_a__');
    const pos = eng._getPositionState();
    pos.celestialBodies = [makeBody()];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);

    // The restore loop found the old TP still live on the exchange first.
    assert.equal(restores.length, 1);
    assert.equal(restores[0].tpOrderId, TP_ORDER_ID);

    // The reprice pass then cancelled it and placed a new one — a manual-TP
    // override must NOT skip needsTpReprice.
    assert.deepEqual(cancels, [TP_ORDER_ID], 'the stale manual-TP body\'s TP must still be cancelled');
    assert.equal(placed.length, 1, 'a replacement TP must be placed');

    const body = eng._getPositionState().celestialBodies.find(b => b.id === 'body-manual-1');
    assert.equal(body.tpOrderId, 'tp-manual-new');
    assert.notEqual(body.tpOrderId, TP_ORDER_ID, 'the stale TP must not survive the reprice');
    assert.equal(body.needsTpReprice, false, 'the flag must clear once the reprice lands');
    assert.equal(body.manualTpPct, 2.5, 'the operator\'s manual override must survive the reprice');
    // placeBodyTp reapplies manualTpPct — the new TP price must reflect
    // 2.5% above avgPrice (90333.33), not whatever the dynamic/tier TP% is.
    const [, placedPrice] = placed[0];
    assert.ok(
      Math.abs(placedPrice - body.avgPrice * 1.025) < 1,
      `replacement TP must be priced at the manual 2.5% override, got ${placedPrice}`
    );
  });

  it('clears needsTpReprice without any cancel/replace when the old TP is already gone at boot', async () => {
    // The exchange reports the TP order as CANCELLED — the restore loop's
    // own "TP no longer on exchange" branch fires, nulls tpOrderId, and a
    // fresh TP gets placed later already sized from the grown assetQty.
    const { eng, cancels } = makeEngine('__test726reprice_b__', {
      getOrder: async (orderId) => (orderId === TP_ORDER_ID ? { status: 'CANCELLED', filledSize: 0 } : { status: 'OPEN', filledSize: 0 }),
    });
    const pos = eng._getPositionState();
    pos.celestialBodies = [makeBody()];

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);

    // Nothing left for the reprice pass to cancel — the old TP was already gone.
    assert.deepEqual(cancels, [], 'no cancel needed when the stale TP is already off the book');

    const body = eng._getPositionState().celestialBodies.find(b => b.id === 'body-manual-1');
    assert.equal(
      body.needsTpReprice,
      false,
      'the flag must clear here too, or the NEXT restart would needlessly cancel+replace the freshly-placed, already-correctly-sized TP'
    );
  });
});
