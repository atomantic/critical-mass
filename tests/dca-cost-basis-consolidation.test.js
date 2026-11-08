// @ts-check
// A consolidated Simple DCA sell carries the summed buy cost, quantity and
// holdback of its source orders, which stay in state as 'consolidated' history.
// The Cost Basis panel must count each purchase once.
const { it } = require('node:test');
const assert = require('node:assert/strict');

const { updateAfterConsolidation } = require('../src/state-tracker');
const { calculateCostBasis } = require('../src/shared-utils');

const order = (id, buyPrice) => ({
  orderId: id,
  buyOrderId: `buy-${id}`,
  buyPrice,
  buyQuantity: 0.01,
  buyUSDC: buyPrice * 0.01,
  buyCostBasis: buyPrice * 0.01,
  holdbackAsset: 0.0005,
  sellQuantity: 0.0095,
  sellPrice: buyPrice * 1.1,
  status: 'pending',
});

it('counts each purchase once after its sells are consolidated, including a second consolidation', () => {
  const state = {
    orders: [order('a', 50_000), order('b', 60_000), order('c', 40_000)],
    assetReserves: 0.0015,
    outstandingOrdersAsset: 0.0285,
  };
  const before = calculateCostBasis(state, []);

  updateAfterConsolidation(state, state.orders.slice(0, 2), 'ab', 58_000, 0.019);
  const consolidated = state.orders.find(o => o.orderId === 'ab');
  updateAfterConsolidation(state, [consolidated, state.orders.find(o => o.orderId === 'c')], 'abc', 55_000, 0.0285);
  const after = calculateCostBasis(state, []);

  for (const field of ['totalCostBasis', 'totalAssetBought', 'avgCostPerAsset', 'reservesCostBasis', 'pendingCostBasis', 'pendingAsset']) {
    assert.ok(Math.abs(after[field] - before[field]) < 1e-6, `${field}: ${after[field]} vs ${before[field]}`);
  }
  assert.ok(Math.abs(after.reservesAvgCost - 50_000) < 1e-6, 'reserves average the three buy prices');
  // Source orders stay visible as history.
  assert.equal(after.orderBreakdown.filter(o => o.status === 'consolidated').length, 4);
});

it('counts bought BTC with a failed or unplaced sell as held, not as pending or reserves', () => {
  const base = order('a', 50_000);
  const failed = { ...order('f', 60_000), status: 'sell_failed' };
  const awaiting = { ...order('w', 40_000), status: 'awaiting_sell' };
  const withUnsold = calculateCostBasis({ orders: [base, failed, awaiting], assetReserves: 0.0015 }, []);
  const withoutUnsold = calculateCostBasis({ orders: [base], assetReserves: 0.0005 }, []);

  assert.ok(Math.abs(withUnsold.unsoldAsset - 0.019) < 1e-9);
  assert.ok(Math.abs(withUnsold.unsoldCostBasis - (0.0095 * 60_000 + 0.0095 * 40_000)) < 1e-6);
  // Pending figures only reflect the order that actually has a sell resting.
  assert.equal(withUnsold.pendingAsset, withoutUnsold.pendingAsset);
  assert.equal(withUnsold.pendingCostBasis, withoutUnsold.pendingCostBasis);
  assert.equal(withoutUnsold.unsoldAsset, 0);
  assert.equal(withoutUnsold.unsoldCostBasis, 0);
});
