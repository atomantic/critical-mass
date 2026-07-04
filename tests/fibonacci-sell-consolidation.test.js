// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { placeFibonacciSellOrder } = require('../src/order-manager');
const {
  seedFibCycleFromBuy,
  creditFibPartialSell,
} = require('../src/state-tracker');
const { getFibonacciSellQuantity } = require('../src/fibonacci-utils');

// ---------------------------------------------------------------------------
// issue #200 — Fibonacci sell-consolidation state machine
//   Bug A: the alreadyFilled path drops the just-executed buy from cycle
//          accounting (seedFibCycleFromBuy re-seeds it).
//   Bug B: a partially-filled previous sell is left live / re-sold from
//          reserves (placeFibonacciSellOrder now inspects filledSize, cancels
//          the remainder, credits the executed portion, and shrinks the new
//          consolidated sell by the already-sold quantity).
// ---------------------------------------------------------------------------

const baseConfig = () => ({
  productId: 'ETH-USD',
  holdbackPercent: 15,
  sellMarkupPercent: 5,
});

/**
 * Build a fake adapter. getOrder/cancelOrder/getOrderFillSummary behaviour is
 * supplied per-test so we can model Gemini and Coinbase status shapes; the
 * placeLimitSell / getCurrentPrice defaults just let the new order land.
 */
const makeAdapter = ({ getOrder, cancelOrder, getOrderFillSummary, currentPrice = 1000, calls = [] }) => ({
  getOrder: async (orderId) => { calls.push({ method: 'getOrder', orderId }); return getOrder(orderId); },
  cancelOrder: async (orderId) => { calls.push({ method: 'cancelOrder', orderId }); return cancelOrder(orderId); },
  getOrderFillSummary: async (orderId) => { calls.push({ method: 'getOrderFillSummary', orderId }); return getOrderFillSummary(orderId); },
  getCurrentPrice: async () => currentPrice,
  placeLimitSell: async (productId, qty, price) => {
    calls.push({ method: 'placeLimitSell', qty, price });
    return { success: true, orderId: `new-sell-${qty.toFixed(8)}`, baseSize: qty, limitPrice: price };
  },
});

// ===========================================================================
// placeFibonacciSellOrder — prev-sell dispatch (Bug B)
// ===========================================================================
describe('placeFibonacciSellOrder — fully-filled previous sell (alreadyFilled)', () => {
  it('Gemini FILLED status returns alreadyFilled and places no new order', async () => {
    const calls = [];
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'FILLED', filledSize: 1.0, filledValue: 2000, averageFilledPrice: 2000 }),
      cancelOrder: () => ({ success: true }),
      getOrderFillSummary: () => ({ totalFees: 0, totalRebates: 0, netFees: 0 }),
    });

    const result = await placeFibonacciSellOrder(baseConfig(), 1.05, 1900, 'prev-1', adapter);

    assert.equal(result.alreadyFilled, true);
    assert.equal(result.sellOrder, null);
    assert.ok(!calls.some(c => c.method === 'cancelOrder'), 'must not cancel a fully-filled order');
    assert.ok(!calls.some(c => c.method === 'placeLimitSell'), 'must not place a new order');
  });

  it('Coinbase FILLED status returns alreadyFilled', async () => {
    const calls = [];
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'FILLED', filledSize: 1.0, filledValue: 2000, averageFilledPrice: 2000 }),
      cancelOrder: () => ({ success: true }),
      getOrderFillSummary: () => ({ totalFees: 0, totalRebates: 0, netFees: 0 }),
    });

    const result = await placeFibonacciSellOrder(baseConfig(), 1.05, 1900, 'prev-cb', adapter);
    assert.equal(result.alreadyFilled, true);
  });
});

describe('placeFibonacciSellOrder — partially-filled previous sell (Bug B)', () => {
  it('Gemini PARTIALLY_FILLED: cancels remainder, credits executed portion, shrinks new sell', async () => {
    const calls = [];
    const config = baseConfig();
    // Prev cycle sell for 1.0 ETH, 40% executed (0.4 ETH) at 2000, still live.
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'PARTIALLY_FILLED', filledSize: 0.4, filledValue: 800, averageFilledPrice: 2000 }),
      cancelOrder: () => ({ success: true }),
      getOrderFillSummary: () => ({ totalFees: 1.6, totalRebates: 0.2, netFees: 1.4 }),
    });

    const cumulativeAsset = 1.05;
    const result = await placeFibonacciSellOrder(config, cumulativeAsset, 1900, 'prev-partial', adapter);

    // Remainder cancelled
    assert.ok(calls.some(c => c.method === 'cancelOrder' && c.orderId === 'prev-partial'));
    assert.equal(result.alreadyFilled, false);

    // New sell sized from full-cycle target MINUS already-sold 0.4
    const target = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
    assert.ok(Math.abs(result.sellQuantity - (target - 0.4)) < 1e-9, `sell qty should exclude already-sold portion (got ${result.sellQuantity})`);

    // Holdback still a fraction of the FULL cumulative (design intent)
    assert.ok(Math.abs(result.holdbackAsset - cumulativeAsset * 0.15) < 1e-9);

    // Executed-portion fill details returned for the caller to book
    assert.ok(result.prevFill, 'prevFill must be returned');
    assert.equal(result.prevFill.filledSize, 0.4);
    assert.equal(result.prevFill.fillValue, 800);
    assert.ok(Math.abs(result.prevFill.netProceeds - (800 - 1.4)) < 1e-9);
  });

  it('Coinbase OPEN with filled_size>0 is treated as partial (not a clean cancel-and-replace)', async () => {
    const calls = [];
    const config = baseConfig();
    // Coinbase labels a live partial as OPEN with a non-zero filled_size.
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'OPEN', filledSize: 0.4, filledValue: 820, averageFilledPrice: 2050 }),
      cancelOrder: () => ({ success: true }),
      getOrderFillSummary: () => ({ totalFees: 2.0, totalRebates: 0, netFees: 2.0 }),
    });

    const cumulativeAsset = 1.05;
    const result = await placeFibonacciSellOrder(config, cumulativeAsset, 1900, 'cb-partial', adapter);

    assert.equal(result.alreadyFilled, false);
    assert.ok(result.prevFill, 'Coinbase partial must also produce prevFill');
    assert.equal(result.prevFill.filledSize, 0.4);

    const target = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
    assert.ok(Math.abs(result.sellQuantity - (target - 0.4)) < 1e-9, 'new sell is not oversized (no dip into reserves)');
  });

  it('partial where cancel is refused (filled between check and cancel) routes through fill path', async () => {
    const calls = [];
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'PARTIALLY_FILLED', filledSize: 0.4, filledValue: 800, averageFilledPrice: 2000 }),
      cancelOrder: () => ({ success: false }), // filled in the race
      getOrderFillSummary: () => ({ totalFees: 0, totalRebates: 0, netFees: 0 }),
    });

    const result = await placeFibonacciSellOrder(baseConfig(), 1.05, 1900, 'raced', adapter);

    assert.equal(result.alreadyFilled, true, 'refused cancel must route through the fill path');
    assert.ok(!calls.some(c => c.method === 'placeLimitSell'), 'no new order placed when treated as filled');
  });
});

describe('placeFibonacciSellOrder — fully-open previous sell (cancel and replace)', () => {
  it('OPEN with zero fills cancels and places a full consolidated sell', async () => {
    const calls = [];
    const config = baseConfig();
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'OPEN', filledSize: 0, filledValue: 0, averageFilledPrice: 0 }),
      cancelOrder: () => ({ success: true }),
      getOrderFillSummary: () => ({ totalFees: 0, totalRebates: 0, netFees: 0 }),
    });

    const cumulativeAsset = 1.05;
    const result = await placeFibonacciSellOrder(config, cumulativeAsset, 1900, 'open-1', adapter);

    assert.ok(calls.some(c => c.method === 'cancelOrder'));
    assert.equal(result.alreadyFilled, false);
    assert.equal(result.prevFill, null);
    const target = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
    assert.ok(Math.abs(result.sellQuantity - target) < 1e-9, 'full consolidated size when nothing was executed');
  });

  it('a terminal (CANCELLED) prev order with a residual fill is NOT re-cancelled — places new full sell', async () => {
    const calls = [];
    const config = baseConfig();
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'CANCELLED', filledSize: 0.1, filledValue: 200, averageFilledPrice: 2000 }),
      cancelOrder: () => ({ success: true }),
      getOrderFillSummary: () => ({ totalFees: 0, totalRebates: 0, netFees: 0 }),
    });

    const cumulativeAsset = 1.05;
    const result = await placeFibonacciSellOrder(config, cumulativeAsset, 1900, 'cancelled-1', adapter);

    assert.ok(!calls.some(c => c.method === 'cancelOrder'), 'must not cancel a terminal order');
    assert.equal(result.alreadyFilled, false);
    assert.equal(result.prevFill, null);
    const target = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
    assert.ok(Math.abs(result.sellQuantity - target) < 1e-9, 'falls through to a full consolidated sell');
  });

  it('OPEN cancel refused (filled in race) routes through fill path', async () => {
    const calls = [];
    const adapter = makeAdapter({
      calls,
      getOrder: () => ({ status: 'OPEN', filledSize: 0, filledValue: 0, averageFilledPrice: 0 }),
      cancelOrder: () => ({ success: false }),
      getOrderFillSummary: () => ({ totalFees: 0, totalRebates: 0, netFees: 0 }),
    });

    const result = await placeFibonacciSellOrder(baseConfig(), 1.05, 1900, 'open-raced', adapter);
    assert.equal(result.alreadyFilled, true);
    assert.ok(!calls.some(c => c.method === 'placeLimitSell'));
  });
});

// ===========================================================================
// state-tracker helpers (Bug A re-seed + Bug B partial credit)
// ===========================================================================
describe('seedFibCycleFromBuy (Bug A) — re-seed after mid-cycle reset', () => {
  it('re-seeds cumulative cost/asset/position from the just-executed buy', () => {
    // Simulate: reset zeroed the cycle, but buy_n must not be dropped.
    const state = {
      fibCycleStartTime: null,
      fibCumulativeCost: 0,
      fibCumulativeAsset: 0,
      fibPosition: 0,
      usdcFundSize: 5000,
    };
    const buyResult = { assetAmount: 0.5, usdcAmount: 1000, netFees: 2 };

    seedFibCycleFromBuy(state, buyResult);

    assert.equal(state.fibCumulativeCost, 1002, 'cost basis = usdcAmount + netFees');
    assert.equal(state.fibCumulativeAsset, 0.5);
    assert.equal(state.fibPosition, 1, 'one buy accumulated → next buy is Fibonacci position 1');
    assert.ok(state.fibCycleStartTime, 'a fresh cycle start time is stamped');
    assert.equal(state.usdcFundSize, 5000, 'must NOT re-debit the fund (buy already debited upstream)');
  });
});

describe('creditFibPartialSell (Bug B) — book executed portion without resetting cycle', () => {
  it('credits net proceeds to the fund and does not reset the cycle or credit reserves', () => {
    const state = {
      usdcFundSize: 1000,
      outstandingOrdersAsset: 0.9,
      outstandingOrdersUSDC: 1800,
      assetReserves: 0.2,
      fibCumulativeCost: 2000,
      fibCumulativeAsset: 1.05,
      fibPosition: 4,
      fibPendingHoldback: 0.15,
      totalFees: 5,
      totalRebates: 1,
      netFees: 4,
    };
    const prevFill = { filledSize: 0.4, fillValue: 800, fees: 1.6, rebates: 0.2, netFees: 1.4, netProceeds: 798.6 };

    creditFibPartialSell(state, prevFill);

    assert.ok(Math.abs(state.usdcFundSize - (1000 + 798.6)) < 1e-9, 'net proceeds credited to fund');
    assert.ok(Math.abs(state.outstandingOrdersAsset - 0.5) < 1e-9);
    assert.ok(Math.abs(state.outstandingOrdersUSDC - 1000) < 1e-9);
    // Cycle must continue: cumulative + position untouched, reserves NOT credited
    assert.equal(state.fibCumulativeAsset, 1.05, 'cycle cumulative untouched (cycle continues)');
    assert.equal(state.fibPosition, 4, 'cycle position untouched');
    assert.equal(state.assetReserves, 0.2, 'holdback reserves NOT credited on a partial');
    // Fees accumulated
    assert.ok(Math.abs(state.netFees - (4 + 1.4)) < 1e-9);
    assert.ok(Math.abs(state.totalFees - (5 + 1.6)) < 1e-9);
  });
});
