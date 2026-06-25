// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createInitialState,
  recordBuyFill,
  attachSellOrder,
  markSellPlacementFailed,
  updateAfterBuy,
  getPendingOrders,
} = require('../src/state-tracker');

// ---------------------------------------------------------------------------
// issue #106 — the DCA real-trade cycle must persist the buy BEFORE attempting
// sell placement so a sell-placement throw cannot lose the buy (double-buy on
// the next interval). recordBuyFill records the buy + sets lastRunId; the sell
// order is attached separately once it actually lands.
// ---------------------------------------------------------------------------

const baseConfig = {
  totalAllocation: 6000,
  intervalsToSpread: 60,
  intervalType: 'daily',
  holdbackPercent: 10,
};

const buyResult = {
  orderId: 'buy-abc',
  assetAmount: 0.001,
  price: 100000,
  usdcAmount: 100,
  fees: 0.1,
  rebates: 0,
  netFees: 0.1,
};

describe('state-tracker DCA buy persistence (issue #106)', () => {
  it('recordBuyFill sets lastRunId and records an awaiting_sell order with no sell attached', () => {
    const state = createInitialState(baseConfig);
    recordBuyFill(state, buyResult, baseConfig);

    // lastRunId set → next interval cannot double-buy
    assert.ok(state.lastRunId, 'lastRunId must be set by recordBuyFill');
    assert.equal(state.assetReserves, 0.0001, 'holdback credited to reserves');
    // sell side not yet committed
    assert.equal(state.outstandingOrdersAsset, 0);
    assert.equal(state.outstandingOrdersUSDC, 0);

    assert.equal(state.orders.length, 1);
    const order = state.orders[0];
    assert.equal(order.status, 'awaiting_sell');
    assert.equal(order.orderId, null);
    assert.equal(order.sellPrice, null);
    assert.equal(order.buyOrderId, 'buy-abc');

    // awaiting_sell is excluded from pending-order fill checks
    assert.equal(getPendingOrders(state).length, 0);
  });

  it('attachSellOrder promotes the awaiting_sell entry and commits outstanding sell totals', () => {
    const state = createInitialState(baseConfig);
    recordBuyFill(state, buyResult, baseConfig);
    attachSellOrder(state, 'buy-abc', { orderId: 'sell-xyz', limitPrice: 105000 });

    const order = state.orders[0];
    assert.equal(order.status, 'pending');
    assert.equal(order.orderId, 'sell-xyz');
    assert.equal(order.sellPrice, 105000);
    // sellQuantity = 0.001 - 0.0001 holdback = 0.0009
    assert.equal(state.outstandingOrdersAsset, 0.0009);
    assert.ok(Math.abs(state.outstandingOrdersUSDC - 0.0009 * 105000) < 1e-6);
    assert.equal(getPendingOrders(state).length, 1);
  });

  it('markSellPlacementFailed keeps the buy recorded but out of pending checks', () => {
    const state = createInitialState(baseConfig);
    recordBuyFill(state, buyResult, baseConfig);
    const lastRunId = state.lastRunId;

    markSellPlacementFailed(state, 'buy-abc', 'exchange 500 after 3 retries');

    const order = state.orders[0];
    assert.equal(order.status, 'sell_failed');
    assert.equal(order.sellFailedReason, 'exchange 500 after 3 retries');
    assert.ok(order.sellFailedAt);
    // The buy survived: lastRunId intact → no double-buy; no phantom sell committed
    assert.equal(state.lastRunId, lastRunId);
    assert.equal(state.outstandingOrdersAsset, 0);
    assert.equal(getPendingOrders(state).length, 0);
  });

  it('updateAfterBuy (dry-run/combined path) composes recordBuyFill + attachSellOrder identically', () => {
    const composed = createInitialState(baseConfig);
    updateAfterBuy(composed, buyResult, { orderId: 'sell-xyz', limitPrice: 105000 }, baseConfig);

    const stepwise = createInitialState(baseConfig);
    recordBuyFill(stepwise, buyResult, baseConfig);
    attachSellOrder(stepwise, 'buy-abc', { orderId: 'sell-xyz', limitPrice: 105000 });

    // Same observable outcome (ignoring timestamps)
    assert.equal(composed.orders[0].status, stepwise.orders[0].status);
    assert.equal(composed.orders[0].orderId, stepwise.orders[0].orderId);
    assert.equal(composed.outstandingOrdersAsset, stepwise.outstandingOrdersAsset);
    assert.equal(composed.assetReserves, stepwise.assetReserves);
  });
});

// ---------------------------------------------------------------------------
// issue #149 — when consolidation cancels the original sells but fails to place
// the consolidated order, the recovery re-places the originals under NEW
// exchange IDs. applyConsolidationRecovery re-points tracked state at those IDs
// and flags any sell that couldn't be re-placed so it isn't treated as pending.
// ---------------------------------------------------------------------------
const { applyConsolidationRecovery } = require('../src/state-tracker');

describe('applyConsolidationRecovery (issue #149)', () => {
  const stateWithPendingSells = () => ({
    // old-a: 0.1 @ 2400, old-b: 0.2 @ 2500 → outstanding 0.3 asset / 740 USDC
    outstandingOrdersAsset: 0.3,
    outstandingOrdersUSDC: 0.1 * 2400 + 0.2 * 2500,
    orders: [
      { orderId: 'old-a', status: 'pending', sellQuantity: 0.1, sellPrice: 2400 },
      { orderId: 'old-b', status: 'pending', sellQuantity: 0.2, sellPrice: 2500 },
    ],
  });

  it('re-points restored sells at their new exchange IDs (stays pending, exposure unchanged)', () => {
    const state = stateWithPendingSells();
    applyConsolidationRecovery(state, [
      { oldOrderId: 'old-a', newOrderId: 'new-a' },
      { oldOrderId: 'old-b', newOrderId: 'new-b' },
    ], []);

    assert.deepEqual(getPendingOrders(state).map(o => o.orderId), ['new-a', 'new-b']);
    assert.equal(state.orders[0].restoredFrom, 'old-a');
    // Restored at the same qty/price, so pending-sell exposure is unchanged.
    assert.ok(Math.abs(state.outstandingOrdersAsset - 0.3) < 1e-9);
    assert.ok(Math.abs(state.outstandingOrdersUSDC - 740) < 1e-9);
  });

  it('flags un-restorable sells sell_failed and removes their exposure from outstanding', () => {
    const state = stateWithPendingSells();
    applyConsolidationRecovery(state, [{ oldOrderId: 'old-a', newOrderId: 'new-a' }], ['old-b']);

    assert.deepEqual(getPendingOrders(state).map(o => o.orderId), ['new-a']);
    const naked = state.orders.find(o => o.orderId === 'old-b');
    assert.equal(naked.status, 'sell_failed');
    assert.match(naked.sellFailedReason, /could not be re-placed/);
    // old-b (0.2 @ 2500) no longer has a resting sell → exposure drops to old-a's.
    assert.ok(Math.abs(state.outstandingOrdersAsset - 0.1) < 1e-9);
    assert.ok(Math.abs(state.outstandingOrdersUSDC - 240) < 1e-9);
  });

  it('is a no-op on empty inputs', () => {
    const state = stateWithPendingSells();
    applyConsolidationRecovery(state);
    assert.equal(getPendingOrders(state).length, 2);
  });
});

// ---------------------------------------------------------------------------
// updateAfterConsolidation must not push a phantom consolidated order when
// nothing was consolidated. issue #150 returns { success: true, newOrderId: null }
// (every eligible order filled during its cancel window); calling this helper
// with an empty source set / null id previously pushed an orderId:null 'pending'
// order that crashes the next sync's adapter.getOrder(null).
// ---------------------------------------------------------------------------
const { updateAfterConsolidation } = require('../src/state-tracker');

describe('updateAfterConsolidation no-consolidation guard (issue #150)', () => {
  it('pushes no phantom order when newOrderId is null and there are no source orders', () => {
    const state = { orders: [{ orderId: 'old-a', status: 'pending', sellQuantity: 0.1, sellPrice: 2400 }] };
    const before = state.orders.length;
    updateAfterConsolidation(state, [], null, 0, 0);
    assert.equal(state.orders.length, before, 'no order should be added');
    assert.ok(!state.orders.some(o => o.orderId == null), 'no orderId:null phantom');
  });

  it('still consolidates normally when given real source orders and a new id', () => {
    const state = {
      orders: [
        { orderId: 'old-a', status: 'pending', buyQuantity: 0.1, buyCostBasis: 240, sellQuantity: 0.1, sellPrice: 2400 },
        { orderId: 'old-b', status: 'pending', buyQuantity: 0.2, buyCostBasis: 500, sellQuantity: 0.2, sellPrice: 2500 },
      ],
    };
    updateAfterConsolidation(state, [...state.orders], 'new-consolidated', 2466, 0.3);
    const consolidated = state.orders.find(o => o.orderId === 'new-consolidated');
    assert.ok(consolidated, 'consolidated order added');
    assert.equal(consolidated.status, 'pending');
    assert.deepEqual(consolidated.sourceOrderIds, ['old-a', 'old-b']);
    assert.equal(state.orders.find(o => o.orderId === 'old-a').status, 'consolidated');
  });
});
