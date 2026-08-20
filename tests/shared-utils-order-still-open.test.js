// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isOrderStillOpen } = require('../src/shared-utils');

// 2026-07-15 coinbase incident: body mrkuoyu0's TP 0824cc36 was placed at
// 10:14:23; 6s later the reconcile loop's getOrder() read it as CANCELLED
// (eventually-consistent historical-order endpoint), so the engine cleared
// tracking and re-placed a new TP — orphaning the live 0824cc36, which stayed
// open on the exchange for days and left a duplicate sell (0.279 BTC oversell).
// isOrderStillOpen cross-checks the authoritative open-orders list before a
// terminal status may be trusted.
describe('isOrderStillOpen', () => {
  const orderId = '0824cc36-a526-4447-9b6a-62c1ae4e3b3e';

  it('returns true when the order is present in the open-orders list (false-terminal read)', () => {
    const openOrders = [
      { orderId: 'b48a12b0-2378-449f-9533-54dfa6ceb09c' },
      { orderId },
      { orderId: '4d7d7af5-35de-419f-88d2-a87adff0717a' },
    ];
    assert.equal(isOrderStillOpen(openOrders, orderId), true);
  });

  it('returns false when the order is genuinely absent (safe to clear + re-place)', () => {
    const openOrders = [{ orderId: 'b48a12b0-2378-449f-9533-54dfa6ceb09c' }];
    assert.equal(isOrderStillOpen(openOrders, orderId), false);
    assert.equal(isOrderStillOpen([], orderId), false);
  });

  it('is null/non-array safe (caller treats a failed getOpenOrders as inconclusive, not gone)', () => {
    assert.equal(isOrderStillOpen(null, orderId), false);
    assert.equal(isOrderStillOpen(undefined, orderId), false);
    assert.equal(isOrderStillOpen('nope', orderId), false);
    assert.equal(isOrderStillOpen([null, { orderId: undefined }], orderId), false);
  });
});
