// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { placeFibonacciSellOrder } = require('../src/order-manager');
const {
  creditFibPartialSell,
  updateAfterFibSellOrder,
  updateAfterFibSellFill,
  updateAfterFibBuy,
} = require('../src/state-tracker');
const { getFibonacciSellQuantity, createInitialFibState } = require('../src/fibonacci-utils');

// ---------------------------------------------------------------------------
// issue #200 — Fibonacci sell-consolidation state machine
//   Bug A: the alreadyFilled path drops the just-executed buy from cycle
//          accounting (updateAfterFibSellFill's excess-detection re-seed
//          handles this generically — see the "top-of-cycle path" describe
//          block below, which covers both call sites uniformly).
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
//
// The Bug A re-seed itself is covered by the "updateAfterFibSellFill (Bug A,
// top-of-cycle path)" describe block below — it re-seeds excess generically
// (any buy folded into cumulative after the last successful consolidation
// snapshot, not just a single named buy), which is what both the in-cycle
// and top-of-cycle call sites actually rely on in production.
// ===========================================================================

describe('updateAfterFibSellFill (Bug A, top-of-cycle path) — re-seed excess from a stale-order fill', () => {
  it('re-seeds a later buy that never got re-consolidated into the sell that just filled', () => {
    // interval 1: buy_1, then a consolidated sell is placed and snapshots
    // fibSellOrderCovered* at buy_1's totals.
    const state = { ...createInitialFibState(), usdcFundSize: 5000, outstandingOrdersAsset: 0, outstandingOrdersUSDC: 0, assetReserves: 0 };
    const config = {};
    const buy1 = { assetAmount: 0.5, usdcAmount: 1000, netFees: 2 };
    updateAfterFibBuy(state, buy1, config);
    const sellOrder1 = { orderId: 'sell-1', limitPrice: 2200 };
    updateAfterFibSellOrder(state, sellOrder1, 0.4, 0.1);

    // interval 2: buy_2 folds into cumulative, but the retry to re-consolidate
    // the sell (placeFibonacciSellOrder) throws — state.fibActiveSellOrderId
    // and fibSellOrderCovered* are left pointing at the buy_1-only snapshot.
    const buy2 = { assetAmount: 0.3, usdcAmount: 600, netFees: 1 };
    updateAfterFibBuy(state, buy2, config);

    assert.equal(state.fibCumulativeAsset, 0.8, 'cumulative folds both buys');
    assert.equal(state.fibSellOrderCoveredAsset, 0.5, 'covered snapshot still only reflects buy_1');

    // interval 3 (top-of-cycle check): the STALE sell_1 (sized only for
    // buy_1) fills. It must not wipe out buy_2's uncovered contribution.
    const fibFill = { filledSize: 0.4, fillValue: 880, fees: 0, rebates: 0, netFees: 0, netProceeds: 880 };
    updateAfterFibSellFill(state, fibFill);

    assert.ok(Math.abs(state.fibCumulativeAsset - 0.3) < 1e-9, 'buy_2 survives as the seed of the fresh cycle, not dropped');
    assert.ok(Math.abs(state.fibCumulativeCost - 601) < 1e-9, "buy_2's cost basis (usdcAmount + netFees) is preserved");
    assert.equal(state.fibPosition, 1, 'one uncovered buy accumulated → next buy is Fibonacci position 1');
    assert.ok(state.fibCycleStartTime, 'a fresh cycle start time is stamped');
  });

  it('is a no-op reset when the fill fully covers current cumulative (normal path)', () => {
    const state = { ...createInitialFibState(), usdcFundSize: 5000, outstandingOrdersAsset: 0, outstandingOrdersUSDC: 0, assetReserves: 0 };
    const config = {};
    const buy1 = { assetAmount: 0.5, usdcAmount: 1000, netFees: 2 };
    updateAfterFibBuy(state, buy1, config);
    const sellOrder1 = { orderId: 'sell-1', limitPrice: 2200 };
    updateAfterFibSellOrder(state, sellOrder1, 0.4, 0.1);

    // No further buys — the sell that fills fully covers current cumulative.
    const fibFill = { filledSize: 0.4, fillValue: 880, fees: 0, rebates: 0, netFees: 0, netProceeds: 880 };
    updateAfterFibSellFill(state, fibFill);

    assert.equal(state.fibCumulativeAsset, 0, 'cycle fully resets when nothing was left uncovered');
    assert.equal(state.fibCumulativeCost, 0);
    assert.equal(state.fibPosition, 0);
  });

  it('treats a pre-migration state with no coverage snapshot as fully covered (no spurious re-seed)', () => {
    // A state persisted before fibSellOrderCovered* existed has the field
    // missing entirely (undefined), not 0 — must not be treated as "nothing
    // covered", or the first fill after upgrading mid-cycle would wrongly
    // re-seed its whole current cumulative as spurious excess.
    const state = {
      fibCumulativeAsset: 0.8,
      fibCumulativeCost: 1600,
      fibPosition: 2,
      fibPendingHoldback: 0.1,
      outstandingOrdersAsset: 0.4,
      outstandingOrdersUSDC: 880,
      usdcFundSize: 5000,
      assetReserves: 0,
      // fibSellOrderCoveredAsset/Cost/Position intentionally absent
    };
    const fibFill = { filledSize: 0.4, fillValue: 880, fees: 0, rebates: 0, netFees: 0, netProceeds: 880 };
    updateAfterFibSellFill(state, fibFill);

    assert.equal(state.fibCumulativeAsset, 0, 'no snapshot → treated as fully covered, cycle resets cleanly');
    assert.equal(state.fibCumulativeCost, 0);
    assert.equal(state.fibPosition, 0);
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
