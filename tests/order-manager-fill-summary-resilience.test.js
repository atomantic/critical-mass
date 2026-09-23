// @ts-check
// ---------------------------------------------------------------------------
// Regression coverage for issue #679 follow-up: getOrderFills/
// getOrderFillSummary now reject (instead of silently returning a partial
// set) when an order lookup fails or the matched fills fall short of the
// exchange's own filled quantity. order-manager.js's legacy buy/sell-fill
// helpers (waitForBuyFill, checkFilledOrders, checkFibonacciSellFill —
// still reachable via the Simple-DCA engine) called adapter.getOrderFillSummary
// directly with no try/catch, so that throw would have cost the caller the
// entire fill record for an order whose funds had already moved — the same
// "money moved, engine recorded nothing" leak class as issue #208A.
//
// order-manager.js now routes every such call through safeGetOrderFillSummary,
// which degrades to a $0-fee stub instead of losing the fill. These tests
// assert the degraded path still returns the core price/size/value record
// (sourced from adapter.getOrder, unaffected by the throw) rather than
// rejecting the whole call.
// ---------------------------------------------------------------------------
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { waitForBuyFill, checkFilledOrders, checkFibonacciSellFill, placeFibonacciSellOrder } = require('../src/order-manager');
const { getFibonacciSellQuantity } = require('../src/fibonacci-utils');

const incompleteFillsError = (orderId) =>
  Object.assign(new Error(`fills incomplete for ${orderId}: 0.5 of 1.5`), { incompleteFills: true });

describe('order-manager fee/fill-summary resilience (issue #679 follow-up)', () => {
  it('waitForBuyFill still returns the fill when getOrderFillSummary rejects', async () => {
    const adapter = {
      getOrder: async (orderId) => ({
        orderId,
        status: 'FILLED',
        filledSize: 0.01,
        filledValue: 500,
        averageFilledPrice: 50000,
        completionPercentage: 100,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const result = await waitForBuyFill('order-1', adapter, 1, 1);

    assert.equal(result.status, 'FILLED');
    assert.equal(result.assetAmount, 0.01);
    assert.equal(result.usdcAmount, 500);
    assert.equal(result.price, 50000);
    // Degraded fee detail, not a lost fill.
    assert.equal(result.fees, 0);
    assert.equal(result.rebates, 0);
    assert.equal(result.netFees, 0);
    assert.equal(result.actualCost, 500);
    assert.deepEqual(result.fills, []);
  });

  it('waitForBuyFill still records a partially-filled CANCELLED order when getOrderFillSummary rejects', async () => {
    const adapter = {
      getOrder: async (orderId) => ({
        orderId,
        status: 'CANCELLED',
        filledSize: 0.004,
        filledValue: 200,
        averageFilledPrice: 50000,
        completionPercentage: 40,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const result = await waitForBuyFill('order-2', adapter, 1, 1);

    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.assetAmount, 0.004);
    assert.equal(result.fees, 0);
  });

  it('checkFilledOrders still reports a fill when getOrderFillSummary rejects', async () => {
    const adapter = {
      name: 'gemini',
      getOrder: async (orderId) => ({
        orderId,
        status: 'FILLED',
        filledSize: 1.2,
        filledValue: 3000,
        averageFilledPrice: 2500,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const filled = await checkFilledOrders([{ orderId: 'sell-1' }], adapter);

    assert.equal(filled.length, 1);
    assert.equal(filled[0].orderId, 'sell-1');
    assert.equal(filled[0].filledSize, 1.2);
    assert.equal(filled[0].fees, 0);
    assert.equal(filled[0].netProceeds, 3000);
  });

  it('checkFibonacciSellFill still reports a fill when getOrderFillSummary rejects', async () => {
    const adapter = {
      name: 'cryptocom',
      getOrder: async (orderId) => ({
        orderId,
        status: 'FILLED',
        filledSize: 0.5,
        filledValue: 1000,
        averageFilledPrice: 2000,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const fill = await checkFibonacciSellFill('sell-fib-1', adapter);

    assert.ok(fill);
    assert.equal(fill.filledSize, 0.5);
    assert.equal(fill.fees, 0);
    assert.equal(fill.netProceeds, 1000);
  });

  it('placeFibonacciSellOrder still credits a partially-filled, cancelled previous sell when getOrderFillSummary rejects', async () => {
    // Prev cycle sell for 1.0 ETH, 40% executed (0.4 ETH) at 2000, still live —
    // mirrors tests/fibonacci-sell-consolidation.test.js's Bug-B "PARTIALLY_FILLED"
    // case, but with a rejecting getOrderFillSummary instead of a stubbed one.
    const config = { productId: 'ETH-USD', holdbackPercent: 15, sellMarkupPercent: 5 };
    const adapter = {
      getOrder: async () => ({ status: 'PARTIALLY_FILLED', filledSize: 0.4, filledValue: 800, averageFilledPrice: 2000 }),
      cancelOrder: async () => ({ success: true }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
      getCurrentPrice: async () => 2000,
      placeLimitSell: async (productId, qty, price) => ({ success: true, orderId: `new-sell-${qty.toFixed(8)}`, baseSize: qty, limitPrice: price }),
    };

    const cumulativeAsset = 1.05;
    const result = await placeFibonacciSellOrder(config, cumulativeAsset, 1900, 'prev-partial', adapter);

    assert.equal(result.alreadyFilled, false);
    assert.ok(result.prevFill, 'the executed portion of the cancelled prev sell must still be credited');
    assert.equal(result.prevFill.filledSize, 0.4);
    assert.equal(result.prevFill.fillValue, 800);
    assert.equal(result.prevFill.fees, 0);
    assert.equal(result.prevFill.netFees, 0);
    // netProceeds = fillValue - netFees, degraded netFees is 0.
    assert.equal(result.prevFill.netProceeds, 800);
    // New sell still correctly shrunk by the already-sold 0.4, independent of
    // the degraded fee detail.
    const target = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
    assert.ok(Math.abs(result.sellQuantity - (target - 0.4)) < 1e-9);
  });
});
