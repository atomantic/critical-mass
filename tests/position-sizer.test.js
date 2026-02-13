// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createPositionSizer } = require('../src/position-sizer');

// ============================================================================
// Helpers
// ============================================================================

/** Standard config for most tests */
const defaultConfig = () => ({
  baseSizeUsdc: 100,
  maxUsdcDeployed: 5000,
  harvestScale: 0.5,
  cautionScale: 0.75,
  trendScale: 1.5,
  liquidityFactorCap: 3.0,
  divergenceScalePct: 5,
  holdbackRatio: 0.5,
});

/** Convenience: create a sizer with default config */
const makeSizer = (overrides = {}) =>
  createPositionSizer('test-exchange', { ...defaultConfig(), ...overrides });

// ============================================================================
// getRegimeScale
// ============================================================================
describe('getRegimeScale', () => {
  const sizer = makeSizer();

  it('returns harvestScale for HARVEST regime', () => {
    assert.equal(sizer.getRegimeScale('HARVEST'), 0.5);
  });

  it('returns cautionScale for CAUTION regime', () => {
    assert.equal(sizer.getRegimeScale('CAUTION'), 0.75);
  });

  it('returns trendScale for TREND regime', () => {
    assert.equal(sizer.getRegimeScale('TREND'), 1.5);
  });

  it('returns 1.0 for unknown regime', () => {
    assert.equal(sizer.getRegimeScale('UNKNOWN'), 1.0);
  });
});

// ============================================================================
// calculateLiquidityFactor
// ============================================================================
describe('calculateLiquidityFactor', () => {
  const sizer = makeSizer();

  it('uses sqrt scaling when L2 depth is available', () => {
    // depth / baseline = 4, sqrt(4) = 2.0
    const factor = sizer.calculateLiquidityFactor(0, 40000, 10000);
    assert.equal(factor, 2.0);
  });

  it('caps liquidity factor at liquidityFactorCap', () => {
    // depth / baseline = 100, sqrt(100) = 10 => capped at 3.0
    const factor = sizer.calculateLiquidityFactor(0, 1000000, 10000);
    assert.equal(factor, 3.0);
  });

  it('returns sqrt(1) = 1.0 when depth equals baseline', () => {
    const factor = sizer.calculateLiquidityFactor(0, 50000, 50000);
    assert.equal(factor, 1.0);
  });

  it('returns 1.0 for first entry (cycleBuys=0)', () => {
    const factor = sizer.calculateLiquidityFactor(0, undefined, undefined, 100000, 100000);
    assert.equal(factor, 1.0);
  });

  it('returns 1.0 when no avgCostBasis provided', () => {
    const factor = sizer.calculateLiquidityFactor(3, undefined, undefined, 100000, undefined);
    assert.equal(factor, 1.0);
  });

  it('returns 1.0 when price is at avg cost basis', () => {
    const factor = sizer.calculateLiquidityFactor(3, undefined, undefined, 100000, 100000);
    assert.equal(factor, 1.0);
  });

  it('scales proportionally when price is below avg cost', () => {
    // avgCost=100000, price=97500 => divergence=2.5%, scalePct=5
    // factor = 1 + (2.5/5) * (3.0-1) = 1 + 0.5 * 2 = 2.0
    const factor = sizer.calculateLiquidityFactor(3, undefined, undefined, 97500, 100000);
    assert.equal(factor, 2.0);
  });

  it('caps at liquidityFactorCap when divergence exceeds scale', () => {
    // avgCost=100000, price=90000 => divergence=10%, scalePct=5
    // factor = 1 + (10/5) * (3.0-1) = 1 + 2 * 2 = 5.0 => capped at 3.0
    const factor = sizer.calculateLiquidityFactor(3, undefined, undefined, 90000, 100000);
    assert.equal(factor, 3.0);
  });

  it('returns 1.0 when price is above avg cost (no negative divergence)', () => {
    const factor = sizer.calculateLiquidityFactor(3, undefined, undefined, 105000, 100000);
    assert.equal(factor, 1.0);
  });

  it('falls back to divergence path when baselineDepth is zero', () => {
    // baselineDepth <= 0 triggers divergence fallback; price 2.5% below avg
    const factor = sizer.calculateLiquidityFactor(5, 10000, 0, 97500, 100000);
    assert.equal(factor, 2.0);
  });

  it('handles fractional depth ratios (< 1.0)', () => {
    // depth / baseline = 0.25, sqrt(0.25) = 0.5
    const factor = sizer.calculateLiquidityFactor(0, 2500, 10000);
    assert.equal(factor, 0.5);
  });
});

// ============================================================================
// calculateEntrySize
// ============================================================================
describe('calculateEntrySize', () => {
  it('computes basic size from base * regimeScale * liquidityFactor', () => {
    const sizer = makeSizer();
    const result = sizer.calculateEntrySize({
      regime: 'TREND',
      cycleBuys: 0,
      totalCostBasis: 0,
    });
    // 100 * 1.5 * 1.0 = 150
    assert.equal(result.sizeUsdc, 150);
    assert.equal(result.factors.regimeScale, 1.5);
    assert.equal(result.factors.liquidityFactor, 1.0);
  });

  it('caps size at remaining budget', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 200 });
    const result = sizer.calculateEntrySize({
      regime: 'TREND',
      cycleBuys: 0,
      totalCostBasis: 100,
    });
    // remaining = 200 - 100 = 100, raw = 100 * 1.5 = 150 => capped at 100
    assert.equal(result.sizeUsdc, 100);
    assert.equal(result.factors.remainingBudget, 100);
  });

  it('returns zero when budget is fully exhausted', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 500 });
    const result = sizer.calculateEntrySize({
      regime: 'TREND',
      cycleBuys: 0,
      totalCostBasis: 500,
    });
    assert.equal(result.sizeUsdc, 0);
  });

  it('returns zero when totalCostBasis exceeds maxUsdcDeployed', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 500 });
    const result = sizer.calculateEntrySize({
      regime: 'TREND',
      cycleBuys: 0,
      totalCostBasis: 600,
    });
    // remaining = max(0, 500-600) = 0
    assert.equal(result.sizeUsdc, 0);
  });

  it('includes bidDepth in liquidity factor when provided', () => {
    const sizer = makeSizer();
    const result = sizer.calculateEntrySize({
      regime: 'HARVEST',
      cycleBuys: 0,
      totalCostBasis: 0,
      bidDepthUsdc: 40000,
      baselineDepth: 10000,
    });
    // base=100, harvestScale=0.5, liquidityFactor=sqrt(4)=2.0
    // 100 * 0.5 * 2.0 = 100
    assert.equal(result.sizeUsdc, 100);
  });

  it('sizeBTC is always 0 (calculated later after price known)', () => {
    const sizer = makeSizer();
    const result = sizer.calculateEntrySize({
      regime: 'TREND',
      cycleBuys: 0,
      totalCostBasis: 0,
    });
    assert.equal(result.sizeBTC, 0);
  });

  it('rounds sizeUsdc to 2 decimal places', () => {
    // Without avgCostBasis, divergence factor is 1.0
    // 33.33 * 0.75 * 1.0 = 24.9975 => roundUSDC => 25.00
    const sizer = makeSizer({ baseSizeUsdc: 33.33, cautionScale: 0.75 });
    const result = sizer.calculateEntrySize({
      regime: 'CAUTION',
      cycleBuys: 3,
      totalCostBasis: 0,
    });
    assert.equal(result.sizeUsdc, 25);
  });
});

// ============================================================================
// calculateBTCQuantity
// ============================================================================
describe('calculateBTCQuantity', () => {
  const sizer = makeSizer();

  it('calculates correct BTC quantity at a given price', () => {
    // 100 USDC / 100000 price = 0.001 BTC
    assert.equal(sizer.calculateBTCQuantity(100, 100000), 0.001);
  });

  it('returns 0 when price is zero', () => {
    assert.equal(sizer.calculateBTCQuantity(100, 0), 0);
  });

  it('returns 0 when price is negative', () => {
    assert.equal(sizer.calculateBTCQuantity(100, -50000), 0);
  });

  it('rounds to 8 decimal places (satoshi precision)', () => {
    // 1 / 3 = 0.33333333... => 0.33333333
    const qty = sizer.calculateBTCQuantity(1, 3);
    const decimals = qty.toString().split('.')[1]?.length ?? 0;
    assert.ok(decimals <= 8, `Expected at most 8 decimals, got ${decimals}`);
  });

  it('handles very small USDC amounts', () => {
    // 0.01 / 100000 = 0.0000001 BTC = 10 sats
    assert.equal(sizer.calculateBTCQuantity(0.01, 100000), 0.0000001);
  });
});

// ============================================================================
// meetsMinimum
// ============================================================================
describe('meetsMinimum', () => {
  const sizer = makeSizer();

  it('returns true when size equals minimum', () => {
    assert.equal(sizer.meetsMinimum(10, 10), true);
  });

  it('returns true when size exceeds minimum', () => {
    assert.equal(sizer.meetsMinimum(15, 10), true);
  });

  it('returns false when size is below minimum', () => {
    assert.equal(sizer.meetsMinimum(5, 10), false);
  });

  it('returns true for zero size when minimum is zero', () => {
    assert.equal(sizer.meetsMinimum(0, 0), true);
  });
});

// ============================================================================
// calculateTakeProfitSize
// ============================================================================
describe('calculateTakeProfitSize', () => {
  it('splits profit between sell and holdback with default holdbackRatio', () => {
    const sizer = makeSizer({ holdbackRatio: 0.5 });
    const result = sizer.calculateTakeProfitSize(0.01, 100000, 110000);

    // profitPerBTC = 10000, totalProfit = 100
    // profitToHoldAsBtcValue = 100 * 0.5 = 50
    // holdbackQty = 50 / 110000 = 0.00045454... => roundBTC => 0.00045455
    // sellQty = 0.01 - 0.00045455 = 0.00954545
    assert.ok(result.sellQty > 0);
    assert.ok(result.holdbackQty > 0);
    assert.ok(result.profitUsdc > 0);
    assert.ok(result.profitBtcValue > 0);
    // sellQty + holdbackQty should approximate totalBTC (rounding may cause tiny diff)
    const total = result.sellQty + result.holdbackQty;
    assert.ok(Math.abs(total - 0.01) < 0.000001, `sellQty + holdbackQty ~ 0.01: ${total}`);
  });

  it('respects tierHoldbackScale multiplier', () => {
    const sizer = makeSizer({ holdbackRatio: 0.5 });
    const base = sizer.calculateTakeProfitSize(0.01, 100000, 120000, 1.0);
    const scaled = sizer.calculateTakeProfitSize(0.01, 100000, 120000, 1.5);

    // Higher tierHoldbackScale => more holdback => less sell
    assert.ok(scaled.holdbackQty > base.holdbackQty,
      `scaled holdback ${scaled.holdbackQty} > base ${base.holdbackQty}`);
    assert.ok(scaled.sellQty < base.sellQty,
      `scaled sellQty ${scaled.sellQty} < base ${base.sellQty}`);
  });

  it('caps effective holdback ratio at 95%', () => {
    const sizer = makeSizer({ holdbackRatio: 0.8 });
    // tierHoldbackScale=2.0 => 0.8 * 2.0 = 1.6 => capped at 0.95
    const result = sizer.calculateTakeProfitSize(0.01, 100000, 120000, 2.0);
    // Even at 95%, sellQty should still be positive
    assert.ok(result.sellQty > 0, `sellQty should be > 0: ${result.sellQty}`);
    assert.ok(result.holdbackQty > 0, `holdbackQty should be > 0: ${result.holdbackQty}`);
  });

  it('enforces minimum 1 satoshi holdback', () => {
    // Create conditions where raw holdback would round to 0
    // Very low profit, very high sell price => profitToHoldAsBtcValue is tiny
    const sizer = makeSizer({ holdbackRatio: 0.01 });
    const result = sizer.calculateTakeProfitSize(0.00000100, 100000, 100001, 1.0);
    // holdbackQty should be at least 1 satoshi
    assert.ok(result.holdbackQty >= 0.00000001,
      `holdbackQty >= 1 sat: ${result.holdbackQty}`);
  });

  it('handles zero profit (sell price equals cost basis)', () => {
    const sizer = makeSizer({ holdbackRatio: 0.5 });
    const result = sizer.calculateTakeProfitSize(0.01, 100000, 100000);
    // profitPerBTC = 0, so holdback of profit=0 but min 1 sat holdback applies
    assert.ok(result.holdbackQty >= 0.00000001);
  });
});

// ============================================================================
// getSizingSummary
// ============================================================================
describe('getSizingSummary', () => {
  it('formats factors into a readable summary string', () => {
    const sizer = makeSizer();
    const summary = sizer.getSizingSummary({
      base: 100,
      regimeScale: 1.5,
      liquidityFactor: 1.2,
      remainingBudget: 4500,
      regime: 'TREND',
      cycleBuys: 2,
      currentPrice: 97500,
      avgCostBasis: 100000,
    });
    assert.equal(summary, 'base=$100 regime=TREND(1.5) liq=1.20 div=2.5% buys=2 budget=$4500');
  });

  it('handles zero values gracefully', () => {
    const sizer = makeSizer();
    const summary = sizer.getSizingSummary({
      base: 0,
      regimeScale: 0,
      liquidityFactor: 0,
      remainingBudget: 0,
      regime: 'HARVEST',
      cycleBuys: 0,
      currentPrice: undefined,
      avgCostBasis: undefined,
    });
    assert.equal(summary, 'base=$0 regime=HARVEST(0) liq=0.00 div=0.0% buys=0 budget=$0');
  });
});

// ============================================================================
// previewLadder
// ============================================================================
describe('previewLadder', () => {
  it('returns an array of uniform steps (no divergence data in preview)', () => {
    const sizer = makeSizer();
    const preview = sizer.previewLadder('TREND', 5);
    assert.ok(Array.isArray(preview));
    assert.ok(preview.length > 0);
    assert.equal(preview[0].step, 0);
    // Without price/avgCostBasis, all steps have factor=1.0 (uniform sizing)
    for (let i = 1; i < preview.length; i++) {
      assert.equal(preview[i].sizeUsdc, preview[0].sizeUsdc,
        `step ${i} size ${preview[i].sizeUsdc} === step 0 size ${preview[0].sizeUsdc}`);
    }
  });

  it('stops when budget is exhausted', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 200, baseSizeUsdc: 100 });
    const preview = sizer.previewLadder('TREND', 20);
    const totalDeployed = preview.reduce((sum, s) => sum + s.sizeUsdc, 0);
    assert.ok(totalDeployed <= 200, `Total deployed ${totalDeployed} <= 200`);
  });

  it('defaults to 10 max steps', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 1000000 });
    const preview = sizer.previewLadder('TREND');
    assert.ok(preview.length <= 10);
  });

  it('returns empty array when budget is zero', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 0 });
    const preview = sizer.previewLadder('TREND', 5);
    assert.equal(preview.length, 0);
  });
});

// ============================================================================
// calculateTotalLadder
// ============================================================================
describe('calculateTotalLadder', () => {
  it('sums all step sizes from previewLadder', () => {
    const sizer = makeSizer();
    const total = sizer.calculateTotalLadder('TREND', 5);
    const preview = sizer.previewLadder('TREND', 5);
    const expectedTotal = preview.reduce((sum, s) => sum + s.sizeUsdc, 0);
    assert.equal(total, expectedTotal);
  });

  it('returns 0 when budget is zero', () => {
    const sizer = makeSizer({ maxUsdcDeployed: 0 });
    const total = sizer.calculateTotalLadder('TREND', 5);
    assert.equal(total, 0);
  });

  it('respects regime differences in total deployment', () => {
    const sizer = makeSizer();
    const harvestTotal = sizer.calculateTotalLadder('HARVEST', 10);
    const trendTotal = sizer.calculateTotalLadder('TREND', 10);
    // TREND (scale 1.5) should deploy more than HARVEST (scale 0.5)
    assert.ok(trendTotal > harvestTotal,
      `TREND total ${trendTotal} > HARVEST total ${harvestTotal}`);
  });
});

// ============================================================================
// Integration / cross-function tests
// ============================================================================
describe('Integration: full sizing workflow', () => {
  it('entry size -> BTC quantity -> meets minimum check', () => {
    const sizer = makeSizer();
    const entry = sizer.calculateEntrySize({
      regime: 'TREND',
      cycleBuys: 0,
      totalCostBasis: 0,
    });
    const btcQty = sizer.calculateBTCQuantity(entry.sizeUsdc, 100000);
    // 150 USDC / 100000 = 0.0015 BTC
    assert.equal(btcQty, 0.0015);
    assert.equal(sizer.meetsMinimum(entry.sizeUsdc, 10), true);
    assert.equal(sizer.meetsMinimum(entry.sizeUsdc, 200), false);
  });

  it('sizes up when price drops below avg cost basis', () => {
    const sizer = makeSizer({ liquidityFactorCap: 2.0, divergenceScalePct: 5 });
    // First entry: no avg cost, factor=1.0
    const first = sizer.calculateEntrySize({
      regime: 'HARVEST',
      cycleBuys: 0,
      totalCostBasis: 0,
    });
    assert.equal(first.factors.liquidityFactor, 1.0);

    // Second entry: price at avg cost, factor=1.0
    const atCost = sizer.calculateEntrySize({
      regime: 'HARVEST',
      cycleBuys: 1,
      totalCostBasis: 50,
      currentPrice: 100000,
      avgCostBasis: 100000,
    });
    assert.equal(atCost.factors.liquidityFactor, 1.0);

    // Third entry: price 5% below avg, factor=2.0 (capped)
    const belowCost = sizer.calculateEntrySize({
      regime: 'HARVEST',
      cycleBuys: 2,
      totalCostBasis: 100,
      currentPrice: 95000,
      avgCostBasis: 100000,
    });
    assert.equal(belowCost.factors.liquidityFactor, 2.0);
    assert.ok(belowCost.sizeUsdc > atCost.sizeUsdc,
      `Below-cost size ${belowCost.sizeUsdc} > at-cost size ${atCost.sizeUsdc}`);
  });
});
