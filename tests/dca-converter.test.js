// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { categorizeOrders } = require('../src/dca-converter');

// issue #106 follow-up — a DCA→regime conversion must not silently drop
// 'awaiting_sell' / 'sell_failed' rows. Those represent a REAL filled buy whose
// sell is pending or failed (asset held with an open obligation), so they
// belong in the `pending` bucket alongside open-sell positions, not dropped.
describe('categorizeOrders (issue #106 follow-up)', () => {
  it('buckets pending and filled as before', () => {
    const { pending, filled, skipped } = categorizeOrders([
      { status: 'pending', orderId: 's1', buyQuantity: 0.01 },
      { status: 'filled', orderId: 's2', buyQuantity: 0.02 },
    ]);
    assert.equal(pending.length, 1);
    assert.equal(filled.length, 1);
    assert.equal(skipped, 0);
  });

  it('treats awaiting_sell and sell_failed as pending (real held positions)', () => {
    const { pending, filled, skipped } = categorizeOrders([
      { status: 'awaiting_sell', orderId: null, buyOrderId: 'b1', buyQuantity: 0.03 },
      { status: 'sell_failed', orderId: null, buyOrderId: 'b2', buyQuantity: 0.04, sellFailedReason: 'x' },
    ]);
    assert.equal(pending.length, 2, 'both must be migrated as pending, not dropped');
    assert.equal(filled.length, 0);
    assert.equal(skipped, 0);
    assert.deepEqual(pending.map(o => o.buyOrderId).sort(), ['b1', 'b2']);
  });

  it('skips consolidated source orders and counts truly-unknown statuses as skipped', () => {
    const { pending, filled, skipped } = categorizeOrders([
      { status: 'pending', consolidatedInto: 'merged-1', buyQuantity: 0.01 },
      { status: 'some_future_status', orderId: 'x', buyQuantity: 0.05 },
    ]);
    assert.equal(pending.length, 0);
    assert.equal(filled.length, 0);
    assert.equal(skipped, 2, 'consolidated + unknown both counted as skipped');
  });
});
