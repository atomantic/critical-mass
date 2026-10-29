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
// order-manager.js routes every such call through safeGetOrderFillSummary.
// When detailed fills stay unavailable it falls back to an authoritative
// non-zero order-level fee, and otherwise reports the fee as UNAVAILABLE
// (issue #1892) so callers keep the order pending instead of finalizing an
// invented, never-repaired zero fee.
// ---------------------------------------------------------------------------
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForBuyFill, checkFilledOrders, checkFibonacciSellFill, placeFibonacciSellOrder,
  safeGetOrderFillSummary, isFeeDetailUnavailable,
} = require('../src/order-manager');
const { getFibonacciSellQuantity } = require('../src/fibonacci-utils');

const incompleteFillsError = (orderId) =>
  Object.assign(new Error(`fills incomplete for ${orderId}: 0.5 of 1.5`), { incompleteFills: true });

describe('safeGetOrderFillSummary — bounded retry before degrading (issue #679 follow-up)', () => {
  it('returns the real summary once a transient failure clears, without degrading', async () => {
    let calls = 0;
    const adapter = {
      getOrderFillSummary: async () => {
        calls++;
        if (calls < 3) throw incompleteFillsError('order-x');
        return { totalFees: 1.5, totalRebates: 0.1, netFees: 1.4, fills: [{ tradeId: 't1' }] };
      },
    };

    const summary = await safeGetOrderFillSummary(adapter, 'order-x', { retries: 3, retryDelayMs: 1 });

    assert.equal(calls, 3);
    assert.equal(summary.totalFees, 1.5);
    assert.equal(summary.netFees, 1.4);
    assert.deepEqual(summary.fills, [{ tradeId: 't1' }]);
  });

  it('throws a feeDetailUnavailable error (never a zero stub) after every retry is exhausted', async () => {
    let calls = 0;
    const adapter = {
      getOrderFillSummary: async () => { calls++; throw incompleteFillsError('order-y'); },
    };

    await assert.rejects(
      safeGetOrderFillSummary(adapter, 'order-y', { retries: 2, retryDelayMs: 1 }),
      (err) => isFeeDetailUnavailable(err) && err.orderId === 'order-y',
    );
    assert.equal(calls, 3, 'must attempt the initial call plus every retry');
  });

  it('uses a signed non-zero order-level fee when fill history is down', async () => {
    const adapter = { name: 'coinbase', getOrderFillSummary: async () => { throw incompleteFillsError('o'); } };
    const fee = await safeGetOrderFillSummary(adapter, 'o', { retries: 0, orderStatus: { totalFees: 2 } });
    assert.deepEqual([fee.totalFees, fee.totalRebates, fee.netFees], [2, 0, 2]);
    const rebate = await safeGetOrderFillSummary(adapter, 'o', { retries: 0, orderStatus: { totalFees: -0.4 } });
    assert.deepEqual([rebate.totalFees, rebate.totalRebates, rebate.netFees], [0, 0.4, -0.4]);
  });

  it('does not treat a zero status fee, or Gemini\'s placeholder, as authoritative', async () => {
    const down = async () => { throw incompleteFillsError('o'); };
    await assert.rejects(
      safeGetOrderFillSummary({ name: 'coinbase', getOrderFillSummary: down }, 'o', { retries: 0, orderStatus: { totalFees: 0 } }),
      isFeeDetailUnavailable,
    );
    await assert.rejects(
      safeGetOrderFillSummary({ name: 'gemini', getOrderFillSummary: down }, 'o', { retries: 0, orderStatus: { totalFees: 3 } }),
      isFeeDetailUnavailable,
    );
  });
});

describe('order-manager fee/fill-summary resilience (issue #679 follow-up)', () => {
  it('waitForBuyFill keeps the accepted buy pending when getOrderFillSummary rejects and no fee is authoritative', async () => {
    const adapter = {
      getOrder: async (orderId) => ({ orderId, status: 'FILLED', filledSize: 0.01, filledValue: 500, averageFilledPrice: 50000 }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    await assert.rejects(
      waitForBuyFill('order-0', adapter, 1, 1),
      (err) => err.buyFillPending === true && err.orderId === 'order-0' && /fee detail unavailable/.test(err.reason),
    );
  });

  it('waitForBuyFill still returns the fill when getOrderFillSummary rejects but the status carries a fee', async () => {
    const adapter = {
      getOrder: async (orderId) => ({
        orderId,
        status: 'FILLED',
        filledSize: 0.01,
        filledValue: 500,
        averageFilledPrice: 50000,
        completionPercentage: 100,
        totalFees: 1.25,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const result = await waitForBuyFill('order-1', adapter, 1, 1);

    assert.equal(result.status, 'FILLED');
    assert.equal(result.assetAmount, 0.01);
    assert.equal(result.usdcAmount, 500);
    assert.equal(result.price, 50000);
    // Order-level fee, not a lost fill and not an invented zero.
    assert.equal(result.fees, 1.25);
    assert.equal(result.rebates, 0);
    assert.equal(result.netFees, 1.25);
    assert.equal(result.actualCost, 501.25);
    assert.deepEqual(result.fills, []);
  });

  it('waitForBuyFill keeps a partially-filled CANCELLED order pending when its fees are unavailable', async () => {
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

    await assert.rejects(waitForBuyFill('order-2', adapter, 1, 1), (err) => err.buyFillPending === true);

    // Once the fill history returns, the same order is finalized with real fees.
    adapter.getOrderFillSummary = async () => ({ totalFees: 0.3, totalRebates: 0, netFees: 0.3, fills: [] });
    const result = await waitForBuyFill('order-2', adapter, 1, 1);
    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.assetAmount, 0.004);
    assert.equal(result.fees, 0.3);
  });

  it('checkFilledOrders leaves a fill pending when getOrderFillSummary rejects and no fee is authoritative', async () => {
    const adapter = {
      name: 'gemini',
      getOrder: async (orderId) => ({ orderId, status: 'FILLED', filledSize: 1.2, filledValue: 3000, averageFilledPrice: 2500, totalFees: 0 }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    assert.deepEqual(await checkFilledOrders([{ orderId: 'sell-0' }], adapter), []);
  });

  it('checkFilledOrders credits the status fee (105 value, 2 fee -> 103) when getOrderFillSummary rejects', async () => {
    const adapter = {
      name: 'coinbase',
      getOrder: async (orderId) => ({
        orderId,
        status: 'FILLED',
        filledSize: 1.2,
        filledValue: 105,
        averageFilledPrice: 87.5,
        totalFees: 2,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const filled = await checkFilledOrders([{ orderId: 'sell-1' }], adapter);

    assert.equal(filled.length, 1);
    assert.equal(filled[0].orderId, 'sell-1');
    assert.equal(filled[0].filledSize, 1.2);
    assert.equal(filled[0].fees, 2);
    assert.equal(filled[0].netProceeds, 103);
  });

  it('checkFibonacciSellFill reports nothing settled while fees are unavailable, then the fill once they return', async () => {
    const adapter = {
      name: 'cryptocom',
      getOrder: async (orderId) => ({ orderId, status: 'FILLED', filledSize: 0.5, filledValue: 1000, averageFilledPrice: 2000 }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };
    assert.equal(await checkFibonacciSellFill('sell-fib-0', adapter), null);

    adapter.getOrderFillSummary = async () => ({ totalFees: 3, totalRebates: 0, netFees: 3, fills: [] });
    const fill = await checkFibonacciSellFill('sell-fib-0', adapter);
    assert.equal(fill?.netProceeds, 997);
  });

  it('checkFibonacciSellFill reports a fill with the status fee when getOrderFillSummary rejects', async () => {
    const adapter = {
      name: 'cryptocom',
      getOrder: async (orderId) => ({
        orderId,
        status: 'FILLED',
        filledSize: 0.5,
        filledValue: 1000,
        averageFilledPrice: 2000,
        totalFees: 4,
      }),
      getOrderFillSummary: async (orderId) => { throw incompleteFillsError(orderId); },
    };

    const fill = await checkFibonacciSellFill('sell-fib-1', adapter);

    assert.ok(fill);
    assert.equal(fill.filledSize, 0.5);
    assert.equal(fill.fees, 4);
    assert.equal(fill.netProceeds, 996);
  });

  it('placeFibonacciSellOrder credits a partially-filled, cancelled previous sell at its status fee when getOrderFillSummary rejects', async () => {
    // Prev cycle sell for 1.0 ETH, 40% executed (0.4 ETH) at 2000, still live —
    // mirrors tests/fibonacci-sell-consolidation.test.js's Bug-B "PARTIALLY_FILLED"
    // case, but with a rejecting getOrderFillSummary instead of a stubbed one.
    const config = { productId: 'ETH-USD', holdbackPercent: 15, sellMarkupPercent: 5 };
    let cancelled = false;
    const adapter = {
      getOrder: async () => ({ status: cancelled ? 'CANCELLED' : 'PARTIALLY_FILLED', filledSize: 0.4, filledValue: 800, averageFilledPrice: 2000, totalFees: 1.5 }),
      cancelOrder: async () => { cancelled = true; return { success: true }; },
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
    assert.equal(result.prevFill.fees, 1.5);
    assert.equal(result.prevFill.netFees, 1.5);
    assert.equal(result.prevFill.netProceeds, 798.5);
    // New sell still correctly shrunk by the already-sold 0.4, independent of
    // the degraded fee detail.
    const target = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
    assert.ok(Math.abs(result.sellQuantity - (target - 0.4)) < 1e-9);
  });
});
