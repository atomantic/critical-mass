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

  it('falls back to geometric scaling when depth is undefined', () => {
    // cycleBuys=3 => 1 + (3 * 0.1) = 1.3
    const factor = sizer.calculateLiquidityFactor(3, undefined, undefined);
    assert.equal(factor, 1.3);
  });

  it('falls back to geometric scaling when baselineDepth is zero', () => {
    // baselineDepth <= 0 triggers fallback; cycleBuys=5 => 1 + 0.5 = 1.5
    const factor = sizer.calculateLiquidityFactor(5, 10000, 0);
    assert.equal(factor, 1.5);
  });

  it('geometric fallback caps at liquidityFactorCap', () => {
    // cycleBuys=30 => 1 + 3.0 = 4.0 => capped at 3.0
    const factor = sizer.calculateLiquidityFactor(30, undefined, undefined);
    assert.equal(factor, 3.0);
  });

  it('returns 1.0 for cycleBuys=0 with no depth data', () => {
    const factor = sizer.calculateLiquidityFactor(0, undefined, undefined);
    assert.equal(factor, 1.0);
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
    // baseSizeUsdc=33, trendScale=1.5 => 33 * 1.5 = 49.5 (already 1 decimal)
    // Let's pick values that produce more decimals:
    // 33.33 * 0.75 * 1.3 = 32.497... => rounds to 32.50
    const sizer = makeSizer({ baseSizeUsdc: 33.33, cautionScale: 0.75 });
    const result = sizer.calculateEntrySize({
      regime: 'CAUTION',
      cycleBuys: 3, // geometric fallback: 1 + 0.3 = 1.3
      totalCostBasis: 0,
    });
    // 33.33 * 0.75 * 1.3 = 32.49675 => roundUSDC => 32.50
    assert.equal(result.sizeUsdc, 32.5);
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
    });
    assert.equal(summary, 'base=$100 regime=TREND(1.5) liq=1.20 buys=2 budget=$4500');
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
    });
    assert.equal(summary, 'base=$0 regime=HARVEST(0) liq=0.00 buys=0 budget=$0');
  });
});

// ============================================================================
// previewLadder
// ============================================================================
describe('previewLadder', () => {
  it('returns an array of steps with increasing sizes (geometric fallback)', () => {
    const sizer = makeSizer();
    const preview = sizer.previewLadder('TREND', 5);
    assert.ok(Array.isArray(preview));
    assert.ok(preview.length > 0);
    assert.equal(preview[0].step, 0);
    // Each step should scale up due to geometric liquidity factor
    for (let i = 1; i < preview.length; i++) {
      assert.ok(preview[i].sizeUsdc >= preview[i - 1].sizeUsdc,
        `step ${i} size ${preview[i].sizeUsdc} >= step ${i - 1} size ${preview[i - 1].sizeUsdc}`);
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
});
