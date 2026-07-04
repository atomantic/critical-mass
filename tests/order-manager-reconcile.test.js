// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { executeDailyBuy, placeWithUnknownReconcile } = require('../src/order-manager');

// ---------------------------------------------------------------------------
// #226 — order-manager reconciles an ambiguous 'unknown' placement by
// client_order_id: adopt the exchange order if it landed (never re-place →
// no double-spend), fail cleanly only if it genuinely never landed.
// ---------------------------------------------------------------------------

/** An ambiguous order-POST outcome, exactly as the coinbase adapter throws it. */
const unknownError = (clientOrderId = 'coid-abc') =>
  Object.assign(new Error('unknown order outcome — reconcile by client_order_id'), {
    status: 'unknown',
    unknownOutcome: true,
    clientOrderId,
  });

/**
 * Minimal buy-side adapter: placeMarketBuy + findOrderByClientOrderId are
 * supplied per-test; getOrder/getOrderFillSummary model a filled order so
 * waitForBuyFill resolves once a placement is adopted.
 */
const makeBuyAdapter = ({ placeMarketBuy, findOrderByClientOrderId }) => ({
  placeMarketBuy,
  findOrderByClientOrderId,
  getOrder: async (orderId) => ({
    orderId,
    status: 'FILLED',
    filledSize: 0.01,
    filledValue: 500,
    averageFilledPrice: 50000,
    completionPercentage: 100,
  }),
  getOrderFillSummary: async () => ({ totalFees: 1, totalRebates: 0, netFees: 1, fills: [] }),
});

describe('executeDailyBuy — unknown-outcome reconciliation (issue #226)', () => {
  it('adopts an order found on the exchange and does NOT re-place it', async () => {
    let placeCalls = 0;
    let lookups = 0;
    const adapter = makeBuyAdapter({
      placeMarketBuy: async () => { placeCalls++; throw unknownError('coid-1'); },
      findOrderByClientOrderId: async (coid, productId) => {
        lookups++;
        assert.equal(coid, 'coid-1');
        assert.equal(productId, 'BTC-USDC');
        return { orderId: 'real-1', status: 'FILLED' };
      },
    });

    const result = await executeDailyBuy({ productId: 'BTC-USDC', holdbackPercent: 20 }, 100, adapter);

    assert.equal(placeCalls, 1, 'must NOT re-place a possibly-executed order');
    assert.equal(lookups, 1, 'reconciled exactly once by client_order_id');
    assert.equal(result.orderId, 'real-1', 'adopted the real exchange order id');
    assert.equal(result.status, 'FILLED');
  });

  it('fails cleanly (throws) when no order with the client_order_id exists', async () => {
    let placeCalls = 0;
    const adapter = makeBuyAdapter({
      placeMarketBuy: async () => { placeCalls++; throw unknownError('coid-2'); },
      findOrderByClientOrderId: async () => null,
    });

    await assert.rejects(
      () => executeDailyBuy({ productId: 'BTC-USDC', holdbackPercent: 20 }, 100, adapter),
      /Market buy failed/
    );
    assert.equal(placeCalls, 1, 'placement attempted exactly once, never blind-retried');
  });

  it('does NOT adopt an order that reconciled to a terminal (CANCELLED) status', async () => {
    const adapter = makeBuyAdapter({
      placeMarketBuy: async () => { throw unknownError('coid-3'); },
      findOrderByClientOrderId: async () => ({ orderId: 'x', status: 'CANCELLED' }),
    });

    await assert.rejects(
      () => executeDailyBuy({ productId: 'BTC-USDC', holdbackPercent: 20 }, 100, adapter),
      /Market buy failed/
    );
  });
});

describe('placeWithUnknownReconcile — helper contract (issue #226)', () => {
  it('passes a normal successful placement straight through', async () => {
    const res = await placeWithUnknownReconcile({}, 'BTC-USDC', async () => ({ success: true, orderId: 'ok-1' }));
    assert.equal(res.orderId, 'ok-1');
    assert.equal(res.success, true);
  });

  it('re-throws a non-unknown error unchanged (no reconcile attempt)', async () => {
    await assert.rejects(
      () => placeWithUnknownReconcile({ findOrderByClientOrderId: async () => { throw new Error('nope'); } },
        'BTC-USDC', async () => { throw new Error('boom'); }),
      /boom/
    );
  });

  it('adopts on unknown→found and never calls the placement thunk again', async () => {
    let placeCalls = 0;
    const adapter = { findOrderByClientOrderId: async () => ({ orderId: 'real-1', status: 'OPEN' }) };
    const res = await placeWithUnknownReconcile(adapter, 'BTC-USDC', async () => {
      placeCalls++;
      throw unknownError('coid-9');
    });

    assert.equal(placeCalls, 1);
    assert.equal(res.success, true);
    assert.equal(res.reconciled, true);
    assert.equal(res.orderId, 'real-1');
  });

  it('fails safely (no lookup) when the unknown error carries no client_order_id', async () => {
    let lookups = 0;
    const adapter = { findOrderByClientOrderId: async () => { lookups++; return null; } };
    const err = Object.assign(new Error('x'), { status: 'unknown', unknownOutcome: true });

    const res = await placeWithUnknownReconcile(adapter, 'BTC-USDC', async () => { throw err; });
    assert.equal(res.success, false);
    assert.equal(lookups, 0, 'no lookup is possible without a client_order_id');
  });
});
