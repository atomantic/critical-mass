// @ts-check
/**
 * #424 — sizeAutoManaged writes baseSizeUsdc/maxUsdcDeployed straight into
 * live config.json (src/regime-engine.js:802-827). maxUsdcDeployed is the
 * capital cap src/risk-manager.js enforces, so the size optimizer can raise
 * the very limit that's supposed to bound it. None of the clamps that guard
 * this write-back — the absolute base-size bounds, the per-adjustment rate
 * limiter, and the (deliberately unbounded) maxUsdcDeployed formula — had
 * test coverage. This pins the exact clamp boundaries and the refuse-to-write
 * cases.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSizeOptimizer } = require('../src/size-optimizer');
const { roundUSDC } = require('../src/volatility-utils');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Baseline config mirroring src/size-optimizer.js's defaults.
 * `sizeAutoManaged` is off by default so recordCycle()/updateBalance()'s
 * internal evaluate() calls never fire unexpectedly while seeding cycle
 * data — clamp behavior is asserted via the exposed `_calculateAdjustment`
 * test hook instead, isolating it from the (separately tested) balance/
 * evaluation-trigger gating.
 */
const defaultConfig = () => ({
  sizeAutoManaged: false,
  baseSizeUsdc: 100,
  maxUsdcDeployed: 1000,
  maxCycleBuys: 10,
  sizeAbsoluteMinBase: 10,
  sizeAbsoluteMaxBase: 500,
  sizeTargetUtilization: 0.9,
  sizeMaxChangePercent: 100000, // disabled unless a test overrides it — isolates other clamps from rate limiting
});

const makeOptimizer = (overrides = {}) =>
  createSizeOptimizer('test-exchange', { ...defaultConfig(), ...overrides }, {}, 'BTC-USDC');

// ============================================================================
// Absolute bounds: sizeAbsoluteMinBase / sizeAbsoluteMaxBase
// ============================================================================
describe('size-optimizer absolute bounds (sizeAbsoluteMinBase / sizeAbsoluteMaxBase)', () => {
  it('floors baseSizeUsdc to sizeAbsoluteMinBase for a zero balance', () => {
    const optimizer = makeOptimizer();

    const adjustment = optimizer._calculateAdjustment(0);

    assert.ok(adjustment);
    assert.ok(adjustment.baseSizeUsdc >= 10, `baseSizeUsdc ${adjustment.baseSizeUsdc} must be >= sizeAbsoluteMinBase`);
    assert.equal(adjustment.baseSizeUsdc, 10);
  });

  it('caps baseSizeUsdc to sizeAbsoluteMaxBase for a balance far exceeding capacity', () => {
    const optimizer = makeOptimizer();

    // 1,000,000 * 0.9 / 10 steps = 90,000 target base size, far above the 500 cap.
    const adjustment = optimizer._calculateAdjustment(1_000_000);

    assert.ok(adjustment);
    assert.ok(adjustment.baseSizeUsdc <= 500, `baseSizeUsdc ${adjustment.baseSizeUsdc} must be <= sizeAbsoluteMaxBase`);
    assert.equal(adjustment.baseSizeUsdc, 500);
  });
});

// ============================================================================
// Rate limiting: sizeMaxChangePercent
// ============================================================================
describe('size-optimizer rate limiting (sizeMaxChangePercent)', () => {
  it('bounds an upward move to sizeMaxChangePercent of the current value and reports rate_limited', () => {
    const optimizer = makeOptimizer({ sizeMaxChangePercent: 25 });

    // Naturally clamps to the 500 absolute cap, far above the current 100.
    const adjustment = optimizer._calculateAdjustment(1_000_000);

    assert.ok(adjustment);
    assert.equal(adjustment.baseSizeUsdc, 125); // 100 + 100 * 25%
    assert.match(adjustment.reason, /^rate_limited/);
  });

  it('bounds a downward move to sizeMaxChangePercent of the current value and reports rate_limited', () => {
    const optimizer = makeOptimizer({ sizeMaxChangePercent: 25 });

    // Naturally floors to the 10 absolute min, far below the current 100.
    const adjustment = optimizer._calculateAdjustment(0);

    assert.ok(adjustment);
    assert.equal(adjustment.baseSizeUsdc, 75); // 100 - 100 * 25%
    assert.match(adjustment.reason, /^rate_limited/);
  });

  it('never triggers rate_limited for a move that stays within the allowed change', () => {
    // Balance chosen so the natural (unclamped) proposal sits close to the
    // current baseSizeUsdc: 500 * 0.9 / 10 = 45, within 25% of 40.
    const optimizer = makeOptimizer({ sizeMaxChangePercent: 25, baseSizeUsdc: 40 });

    const adjustment = optimizer._calculateAdjustment(500);

    assert.ok(adjustment);
    assert.equal(adjustment.baseSizeUsdc, 45);
    assert.match(adjustment.reason, /^balance_based/);
  });
});

// ============================================================================
// maxUsdcDeployed: deliberately unbounded — pin the formula, not a cap
// ============================================================================
describe('size-optimizer maxUsdcDeployed formula (deliberately unbounded — no cap, no rate limit)', () => {
  it('always equals roundUSDC(availableBalance * sizeTargetUtilization)', () => {
    // maxUsdcDeployed starts far from every proposed value below so the
    // >1% deployChanged threshold always fires and an adjustment is returned.
    const optimizer = makeOptimizer({ sizeTargetUtilization: 0.8, maxUsdcDeployed: 1 });
    const balances = [500, 12_345.678, 987_654_321];

    for (const balance of balances) {
      const adjustment = optimizer._calculateAdjustment(balance);
      assert.ok(adjustment, `expected an adjustment for balance ${balance}`);
      assert.equal(adjustment.maxUsdcDeployed, roundUSDC(balance * 0.8));
    }
  });

  it('is not clamped even when it would exceed sizeAbsoluteMaxBase (a base-size-only bound)', () => {
    const optimizer = makeOptimizer({ maxUsdcDeployed: 1 });

    const adjustment = optimizer._calculateAdjustment(1_000_000); // maxUsdcDeployed = 900,000, base clamps to 500

    assert.equal(adjustment.baseSizeUsdc, 500, 'baseSizeUsdc is bound by sizeAbsoluteMaxBase');
    assert.equal(adjustment.maxUsdcDeployed, 900_000, 'maxUsdcDeployed carries no such bound');
  });
});

// ============================================================================
// sizeAutoManaged master switch
// ============================================================================
describe('size-optimizer sizeAutoManaged off-switch', () => {
  it('recordCycle()/evaluate() only ever propose an adjustment when sizeAutoManaged is true', () => {
    const cycleData = { stepsUsed: 20, capitalDeployed: 5000, completedAt: 1_700_000_000_000, availableBalance: 50000 };
    const enabled = makeOptimizer({ sizeAutoManaged: true, sizeMinSampleSize: 1, sizeEvaluationCycles: 1 });
    const disabled = makeOptimizer({ sizeAutoManaged: false, sizeMinSampleSize: 1, sizeEvaluationCycles: 1 });

    assert.notEqual(enabled.recordCycle(cycleData), null, 'sizeAutoManaged:true must be able to produce an adjustment');
    assert.equal(disabled.recordCycle(cycleData), null, 'sizeAutoManaged:false must never write an adjustment');
  });

  it('updateBalance()/evaluateForBalance() only ever propose an adjustment when sizeAutoManaged is true', () => {
    const enabled = makeOptimizer({ sizeAutoManaged: true });
    const disabled = makeOptimizer({ sizeAutoManaged: false });

    enabled.updateBalance(1000); // seed lastKnownBalance; first call never evaluates (no prior balance)
    disabled.updateBalance(1000);

    assert.notEqual(enabled.updateBalance(1_000_000), null, 'a >=10% balance swing with sizeAutoManaged:true must be able to propose');
    assert.equal(disabled.updateBalance(1_000_000), null, 'a >=10% balance swing with sizeAutoManaged:false must never write an adjustment');
  });
});

// ============================================================================
// adjustmentHistory cap
// ============================================================================
describe('size-optimizer adjustmentHistory cap', () => {
  it('never grows past 50 entries even after many triggering balance swings', () => {
    const optimizer = makeOptimizer({ sizeAutoManaged: true, sizeMaxChangePercent: 25 });
    optimizer.updateBalance(500); // seed; distinct from both alternating values below so every loop iteration swings >=10%

    for (let i = 0; i < 60; i++) {
      const result = optimizer.updateBalance(i % 2 === 0 ? 100 : 1_000_000);
      assert.notEqual(result, null, `iteration ${i} was expected to trigger an adjustment`);
    }

    const { adjustmentHistory } = optimizer.exportState();
    assert.equal(adjustmentHistory.length, 50);
  });
});

// ============================================================================
// exportState / importState round trip
// ============================================================================
describe('size-optimizer exportState / importState round trip', () => {
  it('restores cycle stats, balance, and adjustment history exactly', () => {
    const source = makeOptimizer();
    source.recordCycle({ stepsUsed: 4, capitalDeployed: 300, completedAt: 1_700_000_000_000, availableBalance: 5000 });
    source.recordCycle({ stepsUsed: 6, capitalDeployed: 500, completedAt: 1_700_000_060_000, availableBalance: 5200 });

    const exported = source.exportState();
    const target = makeOptimizer();
    target.importState(exported);

    assert.deepEqual(target.exportState(), exported);

    const sourceStatus = source.getStatus();
    const targetStatus = target.getStatus();
    assert.equal(targetStatus.totalCycleCount, sourceStatus.totalCycleCount);
    assert.equal(targetStatus.totalCycleCount, 2);
    assert.equal(targetStatus.recentCycleCount, sourceStatus.recentCycleCount);
    assert.equal(targetStatus.lastKnownBalance, sourceStatus.lastKnownBalance);
    assert.equal(targetStatus.lastKnownBalance, 5200);
  });
});
