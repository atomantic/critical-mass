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
