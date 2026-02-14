// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLadderCalculator } = require('../src/ladder-calculator');

// Helpers
const defaultConfig = () => ({
  ladderMaxAthDropPct: 80,
  ladderSpacingMode: 'sqrt',
  ladderSizeMode: 'fibonacci',
  ladderMinSpacingPct: 0.5,
  baseSizeUsdc: 50,
  minOrderSizeUsdc: 5,
  kFactor: 0.65,
});

const calc = (overrides = {}) =>
  createLadderCalculator('test', { ...defaultConfig(), ...overrides });

const defaultContext = (overrides = {}) => ({
  atr: 2000,
  volBaseline: 0.02,
  athDistance: -0.15,
  ath: 110000,
  ...overrides,
});

// ============================================================================
// calculateLowerBound
// ============================================================================
describe('calculateLowerBound', () => {
  const lc = calc();

  it('returns ATH-based floor when ATH is above current price', () => {
    // ATH=110000, maxDrop=80% => floor = 110000 * 0.20 = 22000
    const floor = lc.calculateLowerBound(100000, 110000, 80);
    assert.equal(floor, 22000);
  });

  it('returns null when current price is at or below floor', () => {
    // ATH=110000, maxDrop=80% => floor = 22000; price = 20000 < floor
    const floor = lc.calculateLowerBound(20000, 110000, 80);
    assert.equal(floor, null);
  });

  it('uses current price as reference when ATH is zero', () => {
    // ATH=0, reference = currentPrice = 50000 => floor = 50000 * 0.20 = 10000
    const floor = lc.calculateLowerBound(50000, 0, 80);
    assert.equal(floor, 10000);
  });

  it('returns null when current price equals floor exactly', () => {
    // ATH=100000, maxDrop=50% => floor = 50000; price = 50000
    const floor = lc.calculateLowerBound(50000, 100000, 50);
    assert.equal(floor, null);
  });

  it('handles small maxAthDropPct values', () => {
    // ATH=100000, maxDrop=10% => floor = 90000
    const floor = lc.calculateLowerBound(100000, 100000, 10);
    assert.equal(floor, 90000);
  });

  it('handles maxAthDropPct of 100 (floor at zero)', () => {
    const floor = lc.calculateLowerBound(50000, 100000, 100);
    assert.equal(floor, 0);
  });
});

// ============================================================================
// calculateDynamicLevelCount
// ============================================================================
describe('calculateDynamicLevelCount', () => {
  const lc = calc();

  it('returns 0 when budget is below baseSizeUsdc', () => {
    const count = lc.calculateDynamicLevelCount(10, 50);
    assert.equal(count, 0);
  });

  it('returns 1 when budget equals baseSizeUsdc', () => {
    const count = lc.calculateDynamicLevelCount(50, 50);
    assert.equal(count, 1);
  });

  it('returns more levels for larger budgets', () => {
    const small = lc.calculateDynamicLevelCount(500, 50);
    const large = lc.calculateDynamicLevelCount(5000, 50);
    assert.ok(large > small, `${large} should be > ${small}`);
  });

  it('caps at 30 levels maximum', () => {
    const count = lc.calculateDynamicLevelCount(1_000_000, 1);
    assert.ok(count <= 30, `count ${count} should be <= 30`);
  });

  it('smallest fibonacci allocation meets baseSizeUsdc threshold', () => {
    const budget = 1000;
    const baseSizeUsdc = 50;
    const count = lc.calculateDynamicLevelCount(budget, baseSizeUsdc);
    // Verify: fib(0)=1, so smallest allocation = 1/fibSum * budget >= baseSizeUsdc
    const { getFibonacciMultiplier } = require('../src/fibonacci-utils');
    let fibSum = 0;
    for (let i = 0; i < count; i++) fibSum += getFibonacciMultiplier(i);
    const smallest = (getFibonacciMultiplier(0) / fibSum) * budget;
    assert.ok(smallest >= baseSizeUsdc, `smallest ${smallest} should be >= ${baseSizeUsdc}`);
  });
});

// ============================================================================
// calculateLadderLevels (spacing modes)
// ============================================================================
describe('calculateLadderLevels', () => {
  const lc = calc({ ladderMinSpacingPct: 0 }); // disable min spacing for clarity

  it('returns single price when numLevels is 1', () => {
    const levels = lc.calculateLadderLevels(100000, 80000, 1, 'linear');
    assert.equal(levels.length, 1);
    assert.equal(levels[0], 100000);
  });

  it('linear spacing produces evenly spaced prices', () => {
    const levels = lc.calculateLadderLevels(100000, 80000, 5, 'linear');
    assert.equal(levels.length, 5);
    // First and last should match top and lower bound
    assert.equal(levels[0], 100000);
    assert.equal(levels[levels.length - 1], 80000);
    // Check equal spacing
    const spacing = levels[0] - levels[1];
    for (let i = 1; i < levels.length - 1; i++) {
      const gap = levels[i] - levels[i + 1];
      assert.ok(Math.abs(gap - spacing) < 0.1, `gap ${gap} should be ~${spacing}`);
    }
  });

  it('sqrt spacing packs more levels near bottom (larger gaps at top)', () => {
    const levels = lc.calculateLadderLevels(100000, 80000, 5, 'sqrt');
    assert.equal(levels[0], 100000);
    assert.equal(levels[levels.length - 1], 80000);
    // sqrt fraction grows fast initially => top gap is LARGER than bottom gap
    const topGap = levels[0] - levels[1];
    const bottomGap = levels[levels.length - 2] - levels[levels.length - 1];
    assert.ok(topGap > bottomGap, `top gap ${topGap} should be > bottom gap ${bottomGap}`);
  });

  it('exponential spacing packs more levels near top (larger gaps at bottom)', () => {
    const levels = lc.calculateLadderLevels(100000, 80000, 5, 'exponential');
    assert.equal(levels[0], 100000);
    assert.equal(levels[levels.length - 1], 80000);
    // exponential fraction grows slowly at first => top gap is SMALLER than bottom gap
    const topGap = levels[0] - levels[1];
    const bottomGap = levels[levels.length - 2] - levels[levels.length - 1];
    assert.ok(topGap < bottomGap, `top gap ${topGap} should be < bottom gap ${bottomGap}`);
  });

  it('all prices are descending', () => {
    const modes = ['linear', 'sqrt', 'exponential'];
    for (const mode of modes) {
      const levels = lc.calculateLadderLevels(100000, 80000, 10, mode);
      for (let i = 1; i < levels.length; i++) {
        assert.ok(levels[i] < levels[i - 1], `${mode}: level ${i} should be < level ${i - 1}`);
      }
    }
  });

  it('minimum spacing enforcement removes levels that are too close', () => {
    // Use a config with large min spacing to force level removal
    const lcSpaced = calc({ ladderMinSpacingPct: 5 });
    const levels = lcSpaced.calculateLadderLevels(100000, 80000, 20, 'linear');
    // With 5% min spacing on 100000 = 5000 gap minimum over 20000 range
    // Should have far fewer than 20 levels
    assert.ok(levels.length < 20, `expected fewer than 20 levels, got ${levels.length}`);
    // Verify all gaps meet minimum
    const minGap = 100000 * 0.05;
    for (let i = 1; i < levels.length; i++) {
      const gap = levels[i - 1] - levels[i];
      assert.ok(gap >= minGap - 1, `gap ${gap} should be >= ${minGap}`);
    }
  });
});

// ============================================================================
// calculateLevelSizes (sizing modes)
// ============================================================================
describe('calculateLevelSizes', () => {
  const lc = calc();

  it('flat sizing allocates equal amounts', () => {
    const sizes = lc.calculateLevelSizes(1000, 5, 'flat');
    assert.equal(sizes.length, 5);
    // Each should be 200
    for (const s of sizes) {
      assert.equal(s, 200);
    }
  });

  it('linear sizing increases with index', () => {
    const sizes = lc.calculateLevelSizes(1000, 5, 'linear');
    assert.equal(sizes.length, 5);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] >= sizes[i - 1], `size[${i}] should be >= size[${i - 1}]`);
    }
  });

  it('sqrt sizing increases with index but slower than linear', () => {
    const sizes = lc.calculateLevelSizes(1000, 5, 'sqrt');
    assert.equal(sizes.length, 5);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] >= sizes[i - 1], `size[${i}] should be >= size[${i - 1}]`);
    }
  });

  it('fibonacci sizing largest at bottom', () => {
    const sizes = lc.calculateLevelSizes(1000, 5, 'fibonacci');
    assert.equal(sizes.length, 5);
    // Fibonacci: weights 1,1,2,3,5 => last should be largest
    assert.ok(sizes[sizes.length - 1] > sizes[0], 'last fib size should exceed first');
  });

  it('all sizing modes sum to total budget (rounding drift corrected)', () => {
    const budget = 1234.56;
    const modes = ['flat', 'linear', 'sqrt', 'fibonacci'];
    for (const mode of modes) {
      const sizes = lc.calculateLevelSizes(budget, 7, mode);
      const sum = Math.round(sizes.reduce((a, b) => a + b, 0) * 100) / 100;
      assert.equal(sum, budget, `${mode} sum ${sum} should equal budget ${budget}`);
    }
  });

  it('single level gets full budget', () => {
    const modes = ['flat', 'linear', 'sqrt', 'fibonacci'];
    for (const mode of modes) {
      const sizes = lc.calculateLevelSizes(500, 1, mode);
      assert.equal(sizes.length, 1);
      assert.equal(sizes[0], 500);
    }
  });
});

// ============================================================================
// buildLadder (integration)
// ============================================================================
describe('buildLadder', () => {
  it('produces ladder with descending prices and increasing sizes for fibonacci', () => {
    const lc = calc();
    const result = lc.buildLadder(100000, 1000, defaultContext());
    assert.ok(result.levels.length > 0, 'should produce at least one level');
    // Prices descending
    for (let i = 1; i < result.levels.length; i++) {
      assert.ok(result.levels[i].price < result.levels[i - 1].price);
    }
    // Sizes increasing (fibonacci)
    for (let i = 1; i < result.levels.length; i++) {
      assert.ok(result.levels[i].sizeUsdc >= result.levels[i - 1].sizeUsdc,
        `sizeUsdc[${i}]=${result.levels[i].sizeUsdc} should be >= sizeUsdc[${i - 1}]=${result.levels[i - 1].sizeUsdc}`);
    }
  });

  it('returns empty levels when budget is zero', () => {
    const lc = calc();
    const result = lc.buildLadder(100000, 0, defaultContext());
    assert.equal(result.levels.length, 0);
  });

  it('returns empty levels when price is below ATH floor', () => {
    const lc = calc();
    // ATH=110000, maxDrop=80% => floor=22000; price=20000 < floor
    const result = lc.buildLadder(20000, 1000, defaultContext({ ath: 110000 }));
    assert.equal(result.levels.length, 0);
    assert.equal(result.lowerBound, 0);
  });

  it('lowerBound matches expected ATH-based floor', () => {
    const lc = calc({ ladderMaxAthDropPct: 80 });
    const result = lc.buildLadder(100000, 5000, defaultContext({ ath: 110000 }));
    assert.equal(result.lowerBound, 22000);
  });

  it('lowerBoundPct reflects distance from current price to floor', () => {
    const lc = calc({ ladderMaxAthDropPct: 80 });
    const result = lc.buildLadder(100000, 5000, defaultContext({ ath: 110000 }));
    // lowerBoundPct = (100000 - 22000) / 100000 * 100 = 78%
    assert.equal(result.lowerBoundPct, 78);
  });

  it('uses currentPrice as reference when ATH is zero', () => {
    const lc = calc({ ladderMaxAthDropPct: 80 });
    const result = lc.buildLadder(100000, 5000, defaultContext({ ath: 0 }));
    // floor = 100000 * 0.2 = 20000
    assert.equal(result.lowerBound, 20000);
  });

  it('filters out levels below minOrderSizeUsdc', () => {
    // Small budget with fibonacci means top levels get tiny allocations
    const lc = calc({ minOrderSizeUsdc: 100, baseSizeUsdc: 10 });
    const result = lc.buildLadder(100000, 500, defaultContext());
    for (const level of result.levels) {
      assert.ok(level.sizeUsdc >= 100, `sizeUsdc ${level.sizeUsdc} should be >= 100`);
    }
  });

  it('each level has correct distancePct from current price', () => {
    const lc = calc();
    const currentPrice = 100000;
    const result = lc.buildLadder(currentPrice, 2000, defaultContext());
    for (const level of result.levels) {
      const expected = Math.round(((currentPrice - level.price) / currentPrice) * 10000) / 100;
      assert.ok(Math.abs(level.distancePct - expected) < 0.02,
        `distancePct ${level.distancePct} should be ~${expected}`);
    }
  });

  it('each level has assetQty = sizeUsdc / price', () => {
    const lc = calc();
    const result = lc.buildLadder(100000, 2000, defaultContext());
    for (const level of result.levels) {
      const expected = Math.round((level.sizeUsdc / level.price) * 1e8) / 1e8;
      assert.equal(level.assetQty, expected);
    }
  });

  it('returns empty levels when topPrice <= lowerBound', () => {
    // Very high kFactor pushes topPrice way down, potentially below floor
    const lc = calc({ kFactor: 100 });
    const result = lc.buildLadder(100000, 1000, defaultContext({ atr: 50000 }));
    assert.equal(result.levels.length, 0);
  });

  it('non-fibonacci sizeMode uses fixed level count based on budget/baseSizeUsdc', () => {
    const lc = calc({ ladderSizeMode: 'flat', baseSizeUsdc: 100 });
    const result = lc.buildLadder(100000, 1000, defaultContext());
    // Expected levels = floor(1000/100) = 10, capped at 30
    // Some may be removed by min spacing, but there should be reasonable count
    assert.ok(result.levels.length > 0);
    assert.ok(result.levels.length <= 10);
  });

  it('athDistance field is passed through from context', () => {
    const lc = calc();
    const result = lc.buildLadder(100000, 1000, defaultContext({ athDistance: -0.25 }));
    assert.equal(result.athDistance, -0.25);
  });
});

// ============================================================================
// calculateATHFromCandles
// ============================================================================
describe('calculateATHFromCandles', () => {
  const lc = calc();

  it('returns the highest high from candles', () => {
    const candles = [{ high: 100000 }, { high: 110000 }, { high: 105000 }];
    assert.equal(lc.calculateATHFromCandles(candles), 110000);
  });

  it('returns 0 for empty array', () => {
    assert.equal(lc.calculateATHFromCandles([]), 0);
  });

  it('returns 0 for null/undefined input', () => {
    assert.equal(lc.calculateATHFromCandles(null), 0);
    assert.equal(lc.calculateATHFromCandles(undefined), 0);
  });

  it('handles single candle', () => {
    assert.equal(lc.calculateATHFromCandles([{ high: 50000 }]), 50000);
  });
});

// ============================================================================
// calculateATHDistance
// ============================================================================
describe('calculateATHDistance', () => {
  const lc = calc();

  it('returns negative value when price is below ATH', () => {
    const dist = lc.calculateATHDistance(80000, 100000);
    assert.equal(dist, -0.2);
  });

  it('returns 0 when price equals ATH', () => {
    assert.equal(lc.calculateATHDistance(100000, 100000), 0);
  });

  it('returns positive when price exceeds ATH (new ATH)', () => {
    const dist = lc.calculateATHDistance(120000, 100000);
    assert.equal(dist, 0.2);
  });

  it('returns 0 when ATH is zero', () => {
    assert.equal(lc.calculateATHDistance(100000, 0), 0);
  });

  it('returns 0 when currentPrice is zero', () => {
    assert.equal(lc.calculateATHDistance(0, 100000), 0);
  });
});

// ============================================================================
// getSummary
// ============================================================================
describe('getSummary', () => {
  const lc = calc();

  it('produces human-readable summary string', () => {
    const ladder = {
      lowerBoundPct: 78,
      levels: [
        { index: 0, price: 99000, sizeUsdc: 50, assetQty: 0.0005, distancePct: 1 },
        { index: 1, price: 80000, sizeUsdc: 200, assetQty: 0.0025, distancePct: 20 },
      ],
    };
    const summary = lc.getSummary(ladder);
    assert.ok(summary.includes('2 levels'));
    assert.ok(summary.includes('99000'));
    assert.ok(summary.includes('80000'));
    assert.ok(summary.includes('78.0%'));
  });

  it('handles empty levels gracefully', () => {
    const ladder = { lowerBoundPct: 0, levels: [] };
    const summary = lc.getSummary(ladder);
    assert.ok(summary.includes('0 levels'));
  });
});
