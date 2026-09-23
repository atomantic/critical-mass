// @ts-check
//
// Regression coverage for issue #684 (round-2 review finding): when startup
// finds an untracked ("orphan") BUY order with partial fills already on the
// exchange, it restores executor tracking for it via
// `orderExecutor.restorePendingOrder({ type: 'entry', size, sizeUsdc, ... })`.
//
// Every OTHER restorePendingOrder({type: 'entry', ...}) call in
// regime-engine.js sets `size` to the order's ORIGINAL placed quantity (e.g.
// `savedEntry.assetQty`) — the dashboard reads it as the "of N" denominator
// alongside `filledSize` ("X of Y filled" in RegimeDashboard.jsx). Before
// issue #684, `getOpenOrders()`'s `size` field happened to already BE the
// original placed quantity on Coinbase, so sourcing this one call site
// straight from `order.size` worked by accident. #684 repointed `size` to
// mean the REMAINING unfilled quantity across all adapters — so this call
// site must use the new `order.originalSize` field instead, or the restored
// entry's `size` would silently mean something different than every sibling
// restore, and a partially-filled orphan would show/track the wrong total
// order size.
//
// Disk safety: throwaway pair lives under a disposable temp root, removed in
// after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-orphan-entry-restore-test');

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
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = originalUpdateRegimeConfig;
  websocketFeedModule.createWebSocketFeed = originalCreateWebSocketFeed;
  isolatedData.cleanup();
});

const ORPHAN_ORDER_ID = 'orphan-entry-partial-1';
// Placed for 1.0, 0.25 filled — remaining (post-#684 `size`) is 0.75.
const ORIGINAL_SIZE = 1;
const FILLED_SIZE = 0.25;
const REMAINING_SIZE = ORIGINAL_SIZE - FILLED_SIZE;
const PRICE = 2000;

const makeAdapter = (over = {}) => ({
  getProductDetails: async () => ({ baseMinSize: '0.0001', baseIncrement: '0.00000001', quoteIncrement: '0.01' }),
  getCurrentPrice: async () => PRICE,
  getOpenOrders: async () => [{
    orderId: ORPHAN_ORDER_ID,
    productId: '__testorphanentry__',
    side: 'BUY',
    status: 'OPEN',
    size: REMAINING_SIZE,
    originalSize: ORIGINAL_SIZE,
    price: PRICE,
    filledSize: FILLED_SIZE,
    createdTime: new Date(Date.now() - 60000).toISOString(),
  }],
  getAccountBalance: async () => ({ available: 0, hold: 0 }),
  getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
  getOrderFills: async () => [],
  loadCredentials: () => ({ apiKey: 'test', apiSecret: 'test' }),
  ...over,
});

describe('orphan entry with partial fills is restored at ORIGINAL size, not remaining (issue #684 follow-up)', () => {
  it('restorePendingOrder receives order.originalSize, not the now-remaining order.size', async () => {
    const restoreCalls = [];
    const eng = createRegimeEngine('coinbase', '__testorphanentry__', { dryRun: false, productId: '__testorphanentry__' }, {});
    eng._test.setAdapter(makeAdapter());
    eng._test.setOrderExecutor({
      setPriceIncrement: () => {},
      getPendingCounts: () => ({ total: 0 }),
      getOrderPlacedAt: () => null,
      isLadderOrder: () => false,
      restorePendingOrder: (orderId, opts) => restoreCalls.push({ orderId, opts }),
      markSettled: () => {},
      checkPendingOrderFills: async () => ({ polled: 0, filled: 0, cancelled: 0 }),
      handleOrderFill: () => {},
      cancelBodyTpOrder: async () => ({ cancelled: true }),
      placeBodyTpOrder: async () => ({ success: true, orderId: 'tp-1' }),
      removeBodyTracking: () => {},
      exportState: () => ({}),
      cancelAllEntries: async () => {},
      cancelAllLadderOrders: async () => {},
      cancelTpOrder: async () => ({ cancelled: true }),
      handleOrderCancel: () => {},
    });
    eng._test.setRecoveryModule({
      recoverState: async () => ({
        position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0, lastEntryPrice: 0, lastEntryTime: 0 },
        openOrders: new Map(),
        discrepancies: [],
      }),
    });
    engines.push(eng);

    const result = await eng.start();
    assert.equal(result.success, true, `start() must succeed: ${result.error}`);

    const call = restoreCalls.find(c => c.orderId === ORPHAN_ORDER_ID);
    assert.ok(call, 'orphan entry with partial fills must be restored via restorePendingOrder');
    assert.equal(call.opts.type, 'entry');
    assert.equal(call.opts.size, ORIGINAL_SIZE, 'size must be the ORIGINAL placed quantity, matching every sibling restorePendingOrder({type:"entry"}) call — not the post-#684 remaining-unfilled order.size');
    assert.equal(call.opts.sizeUsdc, ORIGINAL_SIZE * PRICE);
  });
});
