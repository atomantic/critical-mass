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

/**
 * Adapter that reports an order as eligible (0% filled) at the up-front check but
 * filled on the post-cancel re-fetch, modelling a fill that lands in the gap
 * between the eligibility check and the cancel. `filledIds` maps orderId →
 * completionPercentage seen AFTER its cancel.
 */
const makeGapFillAdapter = ({ filledIds, placeLimitSell, onPlace = () => {} }) => {
  const cancelled = new Set();
  return {
    getOrder: async (orderId) => {
      // Once cancelled, a gap-filled order reports its fill percentage.
      if (cancelled.has(orderId) && filledIds[orderId] != null) {
        return { completionPercentage: filledIds[orderId], status: 'FILLED' };
      }
      return { completionPercentage: 0 };
    },
    cancelOrder: async (orderId) => { cancelled.add(orderId); return { success: true }; },
    placeLimitSell: placeLimitSell || (async (productId, qty, price) => {
      onPlace({ qty, price });
      return { success: true, orderId: 'consolidated-1' };
    }),
  };
};

describe('consolidatePendingOrders — gap-fill double-sell guard (issue #150)', () => {
  it('excludes an order that fills during its cancel from the consolidated total', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500), order('c', 0.3, 2600)];
    const places = [];

    // Order 'b' fully fills in the gap between the check and the cancel.
    const adapter = makeGapFillAdapter({
      filledIds: { b: 100 },
      onPlace: (p) => places.push(p),
    });

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, true);
    // Consolidated total is 0.1 + 0.3 = 0.4 — 'b' (0.2) is excluded, not re-sold.
    assert.equal(places.length, 1);
    assert.ok(Math.abs(places[0].qty - 0.4) < 1e-9, `expected 0.4, got ${places[0].qty}`);
    assert.deepEqual(result.cancelledOrderIds, ['a', 'c']);
    assert.deepEqual(result.filledDuringCancelOrderIds, ['b']);
    assert.equal(result.consolidatedCount, 2);
  });

  // A partial fill in the cancel window excludes the WHOLE order (not just the
  // filled fraction): folding the unfilled remainder into the consolidated order
  // would mis-attribute the order's full cost basis to it. The freed remainder is
  // re-covered by the engine's normal reconciliation.
  it('treats a partial fill during the cancel as gap-filled and excludes it', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500)];
    const places = [];

    const adapter = makeGapFillAdapter({
      filledIds: { a: 40 }, // partial fill — status absent, only completionPercentage
      onPlace: (p) => places.push(p),
    });
    // Override getOrder so the partial fill has no FILLED status.
    const cancelled = new Set();
    adapter.cancelOrder = async (orderId) => { cancelled.add(orderId); return { success: true }; };
    adapter.getOrder = async (orderId) => (cancelled.has('a') && orderId === 'a')
      ? { completionPercentage: 40 }
      : { completionPercentage: 0 };

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, true);
    assert.ok(Math.abs(places[0].qty - 0.2) < 1e-9, `expected 0.2, got ${places[0].qty}`);
    assert.deepEqual(result.cancelledOrderIds, ['b']);
    assert.deepEqual(result.filledDuringCancelOrderIds, ['a']);
  });

  it('excludes an order whose post-cancel re-fetch is indeterminate (null)', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500)];
    const places = [];
    const cancelled = new Set();

    // 'a' returns null on its post-cancel re-fetch (not-found / adapter returns
    // nothing). It must be excluded — not re-sold — and must not throw.
    const adapter = {
      getOrder: async (orderId) => (cancelled.has('a') && orderId === 'a')
        ? null
        : { completionPercentage: 0 },
      cancelOrder: async (orderId) => { cancelled.add(orderId); return { success: true }; },
      placeLimitSell: async (productId, qty) => { places.push(qty); return { success: true, orderId: 'consolidated-1' }; },
    };

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, true);
    assert.ok(Math.abs(places[0] - 0.2) < 1e-9, `expected 0.2, got ${places[0]}`);
    assert.deepEqual(result.cancelledOrderIds, ['b']);
    assert.deepEqual(result.filledDuringCancelOrderIds, ['a']);
  });

  it('places no consolidated order when every eligible order fills during cancel', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500)];
    let placeCount = 0;

    const adapter = makeGapFillAdapter({
      filledIds: { a: 100, b: 100 },
      placeLimitSell: async () => { placeCount += 1; return { success: true, orderId: 'x' }; },
    });

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, true);
    assert.equal(result.newOrderId, null);
    assert.equal(result.consolidatedAsset, 0);
    assert.equal(placeCount, 0, 'no asset held — nothing placed');
    assert.deepEqual(result.filledDuringCancelOrderIds, ['a', 'b']);
  });

  it('recovery re-places only confirmed-cancelled orders, not gap-filled ones', async () => {
    const orders = [order('a', 0.1, 2400), order('b', 0.2, 2500), order('c', 0.3, 2600)];
    const restorePlaces = [];

    // 'b' gap-fills; the consolidated place (0.4) fails, so recovery re-places the
    // confirmed-cancelled 'a' and 'c' only.
    const adapter = makeGapFillAdapter({
      filledIds: { b: 100 },
      placeLimitSell: async (productId, qty) => {
        if (qty > 0.35) return { success: false, errorMessage: 'rejected' };
        restorePlaces.push(qty);
        return { success: true, orderId: `restored-${qty}` };
      },
    });

    const result = await consolidatePendingOrders(baseConfig(), orders, adapter);

    assert.equal(result.success, false);
    assert.deepEqual(result.restoredOrders, [
      { oldOrderId: 'a', newOrderId: 'restored-0.1' },
      { oldOrderId: 'c', newOrderId: 'restored-0.3' },
    ]);
    assert.deepEqual(result.failedRestoreOrderIds, []);
    assert.deepEqual(result.filledDuringCancelOrderIds, ['b']);
    // 'b' (the gap-filled order) is never re-placed.
    assert.ok(!restorePlaces.includes(0.2), 'gap-filled order must not be re-placed');
  });
});

/** A strict exchange script pins both call order and the absence of later calls. */
const scriptedAdapter = (steps) => {
  let cursor = 0;
  const adapter = Object.fromEntries(['getOrder', 'cancelOrder', 'placeLimitSell'].map(method => [
    method,
    async (...args) => {
      const step = steps[cursor++];
      assert.ok(step, `Unexpected ${method} call`);
      assert.deepEqual([method, ...args], step.call);
      if (step.error) throw step.error;
      return step.result;
    },
  ]));
  return { adapter, assertComplete: () => assert.equal(cursor, steps.length) };
};
const getStep = (id, result = { completionPercentage: 0 }) => ({ call: ['getOrder', id], result });
const cancelStep = (id) => ({ call: ['cancelOrder', id], result: { success: true } });
const placeStep = (qty, price, result) => ({ call: ['placeLimitSell', 'BTC-USD', qty, price], result });

describe('consolidatePendingOrders — ordered public contracts', () => {
  it('aborts after a rejected cancel, preserving only the existing failure keys', async () => {
    const orders = [order('skip', 1, 90), order('a', 1, 100), order('gap', 1, 150), order('b', 2, 250), order('c', 1, 300)];
    const script = scriptedAdapter([
      getStep('skip', { completionPercentage: 10 }), ...['a', 'gap', 'b', 'c'].map(id => getStep(id)),
      cancelStep('a'), getStep('a'),
      cancelStep('gap'), getStep('gap', { completionPercentage: 100, status: 'FILLED' }),
      { call: ['cancelOrder', 'b'], result: { success: false } },
    ]);
    assert.deepEqual(await consolidatePendingOrders(baseConfig(), orders, script.adapter), {
      success: false, error: 'Failed to cancel order b', cancelledOrderIds: ['a'], skippedOrderIds: ['skip'],
    });
    script.assertComplete();
  });

  for (const { name, orders, steps, expected } of [
    { name: 'too few input orders', orders: [order('a', 1, 100)], steps: [],
      expected: { success: false, error: 'At least 2 pending orders required for consolidation' } },
    { name: 'too few real orders', orders: [order('dry-run-a', 1, 100), order('b', 1, 100)], steps: [],
      expected: { success: false, error: 'Only 1 real orders after filtering dry-run orders' } },
    { name: 'too few unfilled orders', orders: [order('dry-run-a', 1, 100), order('a', 1, 100), order('b', 1, 100), order('c', 1, 100)],
      steps: [getStep('a', { completionPercentage: 5 }), getStep('b'), getStep('c', { completionPercentage: 100 })],
      expected: { success: false, error: 'Only 1 eligible orders after filtering partial fills', skippedOrderIds: ['a', 'c'] } },
  ]) {
    it(`returns the exact eligibility result for ${name} without cancelling`, async () => {
      const script = scriptedAdapter(steps);
      assert.deepEqual(await consolidatePendingOrders(baseConfig(), orders, script.adapter), expected);
      script.assertComplete();
    });
  }

  it('excludes FILLED at zero percent and undefined responses while preserving weighted placement', async () => {
    const orders = [order('a', 1, 100), order('filled', 9, 999), order('missing', 8, 888), order('b', 2, 250)];
    const script = scriptedAdapter([
      ...orders.map(o => getStep(o.orderId)),
      cancelStep('a'), getStep('a'),
      cancelStep('filled'), getStep('filled', { completionPercentage: 0, status: 'FILLED' }),
      cancelStep('missing'), { call: ['getOrder', 'missing'], result: undefined },
      cancelStep('b'), getStep('b'),
      placeStep(3, 200, { success: true, orderId: 'merged' }),
    ]);
    assert.deepEqual(await consolidatePendingOrders(baseConfig(), orders, script.adapter), {
      success: true, newOrderId: 'merged', consolidatedPrice: 200, consolidatedAsset: 3, consolidatedCount: 2,
      skippedOrderIds: [], cancelledOrderIds: ['a', 'b'], filledDuringCancelOrderIds: ['filled', 'missing'],
    });
    script.assertComplete();
  });

  it('returns the exact all-excluded result without placing anything', async () => {
    const script = scriptedAdapter([
      getStep('a'), getStep('b'), cancelStep('a'),
      getStep('a', { completionPercentage: 0, status: 'FILLED' }),
      cancelStep('b'), { call: ['getOrder', 'b'], result: undefined },
    ]);
    assert.deepEqual(await consolidatePendingOrders(baseConfig(), [order('a', 1, 100), order('b', 2, 250)], script.adapter), {
      success: true, newOrderId: null, consolidatedPrice: 0, consolidatedAsset: 0, consolidatedCount: 0,
      skippedOrderIds: [], cancelledOrderIds: [], filledDuringCancelOrderIds: ['a', 'b'],
    });
    script.assertComplete();
  });

  it('restores only confirmed orders in order and returns the exact recovery envelope', async () => {
    const orders = [order('a', 1, 100), order('gap', 9, 900), order('b', 2, 250), order('c', 1, 200)];
    const script = scriptedAdapter([
      ...orders.map(o => getStep(o.orderId)),
      cancelStep('a'), getStep('a'), cancelStep('gap'), getStep('gap', { completionPercentage: 20 }),
      cancelStep('b'), getStep('b'), cancelStep('c'), getStep('c'),
      placeStep(4, 200, { success: false, errorMessage: 'rejected' }),
      placeStep(1, 100, { success: true, orderId: 'restored-a' }),
      placeStep(2, 250, { success: false, errorMessage: 'restore rejected' }),
      placeStep(1, 200, { success: true, orderId: 'restored-c' }),
    ]);
    assert.deepEqual(await consolidatePendingOrders(baseConfig(), orders, script.adapter), {
      success: false, error: 'Failed to place consolidated order: rejected',
      cancelledOrderIds: ['a', 'b', 'c'], skippedOrderIds: [], filledDuringCancelOrderIds: ['gap'],
      restoredOrders: [{ oldOrderId: 'a', newOrderId: 'restored-a' }, { oldOrderId: 'c', newOrderId: 'restored-c' }],
      failedRestoreOrderIds: ['b'],
    });
    script.assertComplete();
  });

  for (const phase of ['cancel', 're-fetch', 'restore']) {
    it(`propagates the original ${phase} exception and stops exchange calls`, async () => {
      const error = new Error(`${phase} unavailable`);
      const steps = [getStep('a'), getStep('b'), getStep('c'), cancelStep('a'), getStep('a')];
      if (phase === 'cancel') steps.push({ call: ['cancelOrder', 'b'], error });
      if (phase === 're-fetch') steps.push(cancelStep('b'), { call: ['getOrder', 'b'], error });
      if (phase === 'restore') steps.push(
        cancelStep('b'), getStep('b'), cancelStep('c'), getStep('c'),
        placeStep(4, 200, { success: false, errorMessage: 'rejected' }),
        placeStep(1, 100, { success: true, orderId: 'restored-a' }),
        { call: ['placeLimitSell', 'BTC-USD', 2, 250], error },
      );
      const script = scriptedAdapter(steps);
      await assert.rejects(consolidatePendingOrders(baseConfig(), [order('a', 1, 100), order('b', 2, 250), order('c', 1, 200)], script.adapter), thrown => thrown === error);
      script.assertComplete();
    });
  }
});
