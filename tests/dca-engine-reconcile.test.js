// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { reconcileAwaitingSells } = require('../src/dca-engine');
const { createInitialState, recordBuyFill, getPendingOrders } = require('../src/state-tracker');

// ---------------------------------------------------------------------------
// issue #129 — recover durable 'awaiting_sell' rows after a crash between the
// buy-save (recordBuyFill, issue #106) and sell placement. Such rows are
// invisible to getPendingOrders (status filter) and previously had no recovery
// path. reconcileAwaitingSells, run at the top of the cycle before any new buy,
// re-attempts the sell via the same placeSellOrderWithRetry path and either
// promotes the row to 'pending' (sell placed) or marks it 'sell_failed'.
// ---------------------------------------------------------------------------

const config = {
  productId: 'BTC-USD',
  totalAllocation: 6000,
  intervalsToSpread: 60,
  intervalType: 'daily',
  holdbackPercent: 10,
  sellMarkupPercent: 5,
};

const makeBuy = (orderId) => ({
  orderId,
  assetAmount: 0.001,
  price: 100000,
  usdcAmount: 100,
  fees: 0.1,
  rebates: 0,
  netFees: 0.1,
});

// Build a state that has only durable awaiting_sell rows — the exact footprint
// a crash between recordBuyFill+saveState and attachSellOrder would leave.
const stateWithAwaitingSells = (buyOrderIds) => {
  const state = createInitialState(config);
  for (const id of buyOrderIds) {
    recordBuyFill(state, makeBuy(id), config);
  }
  // recordBuyFill leaves every row as awaiting_sell (no sell attached yet)
  assert.equal(state.orders.every(o => o.status === 'awaiting_sell'), true);
  return state;
};

describe('reconcileAwaitingSells (issue #129)', () => {
  it('no awaiting_sell rows → no-op, no adapter calls', async () => {
    const state = createInitialState(config);
    let placeCalls = 0;
    const adapter = {
      getCurrentPrice: async () => { placeCalls++; return 100000; },
      placeLimitSell: async () => { placeCalls++; return { success: true, orderId: 's' }; },
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');
    assert.deepEqual(result, { recovered: 0, failed: 0 });
    assert.equal(placeCalls, 0);
  });

  it('places the sell for an orphaned awaiting_sell row and promotes it to pending', async () => {
    const state = stateWithAwaitingSells(['buy-1']);
    const calls = [];
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async (productId, size, price) => {
        calls.push({ productId, size, price });
        return { success: true, orderId: 'sell-1', baseSize: size, limitPrice: price };
      },
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');

    assert.deepEqual(result, { recovered: 1, failed: 0 });
    assert.equal(calls.length, 1);
    // sell quantity = buyQuantity * (1 - holdback%) = 0.001 * 0.9
    assert.ok(Math.abs(calls[0].size - 0.0009) < 1e-9);
    // sell price = buyPrice * (1 + markup%) = 100000 * 1.05
    assert.ok(calls[0].price > 100000);

    const order = state.orders[0];
    assert.equal(order.status, 'pending');
    assert.equal(order.orderId, 'sell-1');
    assert.equal(getPendingOrders(state).length, 1);
    // outstanding sell totals committed by attachSellOrder
    assert.ok(Math.abs(state.outstandingOrdersAsset - 0.0009) < 1e-9);
  });

  it('marks the row sell_failed when placement keeps failing', async () => {
    const state = stateWithAwaitingSells(['buy-1']);
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async () => ({ success: false, errorMessage: 'exchange 500' }),
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');

    assert.deepEqual(result, { recovered: 0, failed: 1 });
    const order = state.orders[0];
    assert.equal(order.status, 'sell_failed');
    assert.ok(order.sellFailedReason);
    assert.ok(order.sellFailedAt);
    // No phantom sell committed
    assert.equal(state.outstandingOrdersAsset, 0);
    assert.equal(getPendingOrders(state).length, 0);
  });

  it('reconciles each row independently — one recovers, one fails', async () => {
    const state = stateWithAwaitingSells(['buy-ok', 'buy-bad']);
    const adapter = {
      getCurrentPrice: async () => 100000,
      placeLimitSell: async (productId, size, price) => {
        // Fail only the second buy's recovery by toggling on call order
        return adapter._calls++ === 0
          ? { success: true, orderId: 'sell-ok', baseSize: size, limitPrice: price }
          : { success: false, errorMessage: 'rejected' };
      },
      _calls: 0,
    };

    const result = await reconcileAwaitingSells(state, config, adapter, 'coinbase');

    assert.equal(result.recovered, 1);
    assert.equal(result.failed, 1);
    const ok = state.orders.find(o => o.buyOrderId === 'buy-ok');
    const bad = state.orders.find(o => o.buyOrderId === 'buy-bad');
    assert.equal(ok.status, 'pending');
    assert.equal(bad.status, 'sell_failed');
  });
});
