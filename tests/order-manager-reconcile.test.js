// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { executeDailyBuy, placeWithUnknownReconcile, placeSellOrder, placeSellOrderWithRetry, placeFibonacciSellOrder } = require('../src/order-manager');

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

describe('executeDailyBuy — records a partial IOC fill instead of discarding it (issue #208A follow-up)', () => {
  it('records the fill when the order is CANCELLED but filledSize > 0 (Gemini partial-IOC)', async () => {
    // Gemini's IOC market buy reports success with a real filledSize when the
    // remainder is cancelled after a partial execution — but a subsequent
    // getOrder() poll on that SAME order reports status CANCELLED (matching
    // the terminal exchange state). The old poll blindly threw on any
    // CANCELLED status, discarding a fill that already moved funds.
    const adapter = {
      placeMarketBuy: async () => ({
        orderId: 'gem-1', clientOrderId: 'coid-gem-1', success: true,
        filledSize: 0.006, filledPrice: 50500,
      }),
      getOrder: async () => ({
        orderId: 'gem-1', status: 'CANCELLED',
        filledSize: 0.006, filledValue: 303, averageFilledPrice: 50500,
      }),
      getOrderFillSummary: async () => ({ totalFees: 0.3, totalRebates: 0, netFees: 0.3, fills: [{ size: 0.006 }] }),
    };

    const result = await executeDailyBuy({ productId: 'BTC-USD', holdbackPercent: 20 }, 300, adapter);

    assert.equal(result.assetAmount, 0.006, 'the partial fill must be recorded, not discarded');
    assert.equal(result.usdcAmount, 303);
    assert.equal(result.price, 50500);
    assert.ok(Math.abs(result.actualCost - (303 + 0.3)) < 1e-9);
  });

  it('still throws when a CANCELLED order truly has zero fill (no money moved)', async () => {
    const adapter = {
      placeMarketBuy: async () => ({ orderId: 'gem-2', clientOrderId: 'coid-gem-2', success: true, filledSize: 0, filledPrice: 0 }),
      getOrder: async () => ({ orderId: 'gem-2', status: 'CANCELLED', filledSize: 0, filledValue: 0, averageFilledPrice: 0 }),
      getOrderFillSummary: async () => ({ totalFees: 0, totalRebates: 0, netFees: 0, fills: [] }),
    };

    await assert.rejects(
      () => executeDailyBuy({ productId: 'BTC-USD', holdbackPercent: 20 }, 300, adapter),
      /was CANCELLED/
    );
  });
});

describe('sell placement — unknown-outcome reconciliation (issue #226 sell-side follow-up)', () => {
  it('placeSellOrder adopts a reconciled order and fills in the requested size/price', async () => {
    let placeCalls = 0;
    const adapter = {
      placeLimitSell: async () => { placeCalls++; throw unknownError('coid-sell-1'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-sell-1', status: 'OPEN' }),
    };
    const config = { productId: 'BTC-USDC', holdbackPercent: 20, sellMarkupPercent: 5 };
    const buyDetails = { assetAmount: 0.01, price: 50000 };

    const result = await placeSellOrder(config, buyDetails, adapter);

    assert.equal(placeCalls, 1, 'must NOT re-place a possibly-executed sell');
    assert.equal(result.orderId, 'real-sell-1');
    assert.equal(result.reconciled, true);
    // Locally-known request params must be filled in — a reconciled lookup
    // doesn't echo back the limit price/size, and state-tracker's
    // attachSellOrder reads sellOrder.limitPrice directly for accounting.
    assert.equal(result.baseSize, 0.01 * (1 - 20 / 100));
    assert.equal(result.limitPrice, 50000 * (1 + 5 / 100));
  });

  it('placeSellOrder fails cleanly when the sell genuinely never landed', async () => {
    const adapter = {
      placeLimitSell: async () => { throw unknownError('coid-sell-2'); },
      findOrderByClientOrderId: async () => null,
    };
    const config = { productId: 'BTC-USDC', holdbackPercent: 20, sellMarkupPercent: 5 };

    await assert.rejects(
      () => placeSellOrder(config, { assetAmount: 0.01, price: 50000 }, adapter),
      /Limit sell failed/
    );
  });

  it('placeSellOrderWithRetry adopts a reconciled order without exhausting retries', async () => {
    let placeCalls = 0;
    const adapter = {
      getCurrentPrice: async () => 40000,
      placeLimitSell: async () => { placeCalls++; throw unknownError('coid-sell-3'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-sell-3', status: 'OPEN' }),
    };
    const config = { productId: 'BTC-USDC', holdbackPercent: 10, sellMarkupPercent: 10 };
    const buyDetails = { assetAmount: 0.02, price: 50000 };

    const result = await placeSellOrderWithRetry(config, buyDetails, adapter, 3);

    assert.equal(placeCalls, 1, 'reconciled on the first attempt, no blind retry');
    assert.equal(result.orderId, 'real-sell-3');
    assert.equal(result.baseSize, 0.02 * (1 - 10 / 100));
    assert.equal(result.limitPrice, 50000 * 1.1);
  });

  it('placeFibonacciSellOrder adopts a reconciled consolidated sell', async () => {
    let placeCalls = 0;
    const adapter = {
      getCurrentPrice: async () => 1000,
      placeLimitSell: async () => { placeCalls++; throw unknownError('coid-sell-4'); },
      findOrderByClientOrderId: async () => ({ orderId: 'real-sell-4', status: 'OPEN' }),
    };
    const config = { productId: 'ETH-USD', holdbackPercent: 15, sellMarkupPercent: 5 };

    const result = await placeFibonacciSellOrder(config, 1.0, 900, null, adapter);

    assert.equal(placeCalls, 1);
    assert.equal(result.sellOrder.orderId, 'real-sell-4');
    assert.equal(result.sellOrder.reconciled, true);
    assert.ok(result.sellOrder.limitPrice > 0, 'limitPrice filled in from the local request, not left undefined');
    assert.equal(result.sellOrder.baseSize, result.sellQuantity);
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

  it('retries the lookup with backoff before adopting (issue #226 follow-up — eventual consistency)', async () => {
    // The exchange's order-history endpoint can be briefly eventually-consistent
    // right after the network error that produced the unknown outcome — a
    // single immediate lookup risks declaring a real order absent and letting
    // a caller re-place it (double exposure) purely because the lookup raced
    // ahead of propagation.
    let lookups = 0;
    const adapter = {
      findOrderByClientOrderId: async () => {
        lookups++;
        return lookups < 3 ? null : { orderId: 'real-eventual-1', status: 'OPEN' };
      },
    };

    const res = await placeWithUnknownReconcile(
      adapter, 'BTC-USDC', async () => { throw unknownError('coid-eventual-1'); },
      [10, 10] // short overrides so the test doesn't wait through production backoff
    );

    assert.equal(lookups, 3, 'retried until the order became visible');
    assert.equal(res.success, true);
    assert.equal(res.reconciled, true);
    assert.equal(res.orderId, 'real-eventual-1');
  });

  it('gives up as a clean failure once retries are exhausted', async () => {
    let lookups = 0;
    const adapter = { findOrderByClientOrderId: async () => { lookups++; return null; } };

    const res = await placeWithUnknownReconcile(
      adapter, 'BTC-USDC', async () => { throw unknownError('coid-eventual-2'); },
      [10, 10]
    );

    assert.equal(lookups, 3, 'one initial attempt plus 2 retries, matching retryDelaysMs.length');
    assert.equal(res.success, false);
  });
});
