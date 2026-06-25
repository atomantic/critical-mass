// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { consolidatePendingOrders } = require('../src/order-manager');

const baseConfig = () => ({ productId: 'BTC-USD' });

const order = (id, qty, price) => ({ orderId: id, sellQuantity: qty, sellPrice: price });

/**
 * Build an adapter whose getOrder() reports no partial fills (so every order is
 * eligible), and whose cancelOrder always succeeds. placeLimitSell behaviour is
 * supplied per-test so we can model a failing consolidated place.
 */
const makeAdapter = ({ placeLimitSell, onCall = () => {} }) => ({
  getOrder: async () => ({ completionPercentage: 0 }),
  cancelOrder: async (orderId) => { onCall({ method: 'cancel', orderId }); return { success: true }; },
  placeLimitSell,
});

describe('consolidatePendingOrders — naked-position recovery (issue #149)', () => {
  it('re-places the original sells when the consolidated order fails to place', async () => {
    const calls = [];
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500)];

    const adapter = makeAdapter({
      onCall: (c) => calls.push(c),
      placeLimitSell: async (productId, qty, price) => {
        calls.push({ method: 'place', qty, price });
        // The single consolidated place (full size 0.3) is rejected; the
        // per-order restore places (0.1 and 0.2) succeed.
        if (qty > 0.25) {
          return { success: false, errorMessage: 'post only would cross' };
        }
        return { success: true, orderId: `restored-${qty}` };
      },
    });

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, false);
    assert.match(result.error, /post only would cross/);
    // Both cancelled orders were re-placed so the position is never left naked.
    // The result maps each cancelled exchange ID to its new ID so the caller can
    // re-point tracked state.
    assert.deepEqual(result.restoredOrders, [
      { oldOrderId: 'a', newOrderId: 'restored-0.1' },
      { oldOrderId: 'b', newOrderId: 'restored-0.2' },
    ]);
    assert.deepEqual(result.failedRestoreOrderIds, []);

    // The consolidated place was attempted before any restore place.
    const placeCalls = calls.filter(c => c.method === 'place');
    assert.equal(placeCalls.length, 3, 'one consolidated attempt + two restores');
    assert.ok(placeCalls[0].qty > 0.25, 'first place is the full consolidated size');
  });

  it('reports orders it could NOT restore so the caller can alert', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500)];

    const adapter = makeAdapter({
      placeLimitSell: async (productId, qty) => {
        if (qty > 0.25) return { success: false, errorMessage: 'rejected' };
        // Only the 0.1 restore succeeds; the 0.2 restore also fails.
        if (qty === 0.1) return { success: true, orderId: 'restored-a' };
        return { success: false, errorMessage: 'still rejected' };
      },
    });

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, false);
    assert.deepEqual(result.restoredOrders, [{ oldOrderId: 'a', newOrderId: 'restored-a' }]);
    assert.deepEqual(result.failedRestoreOrderIds, ['b']);
  });

  it('does not run recovery on the happy path', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2600)];
    let placeCount = 0;

    const adapter = makeAdapter({
      placeLimitSell: async () => { placeCount += 1; return { success: true, orderId: 'consolidated-1' }; },
    });

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, true);
    assert.equal(result.newOrderId, 'consolidated-1');
    assert.equal(placeCount, 1, 'exactly one place — no restores');
    assert.equal(result.restoredOrders, undefined);
  });
});
