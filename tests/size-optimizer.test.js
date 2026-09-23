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
 * `sizeAutoManaged` is off by default so recordCycle()'s internal evaluate()
 * calls never fire unexpectedly while seeding cycle data — clamp behavior is
 * asserted via the exposed `_calculateAdjustment` test hook instead,
 * isolating it from the (separately tested) evaluation-trigger gating.
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
});

// ============================================================================
// adjustmentHistory cap
// ============================================================================
describe('size-optimizer adjustmentHistory cap', () => {
  it('never grows past 50 entries even after many triggering cycle completions', () => {
    // sizeEvaluationCycles/sizeMinSampleSize:1 make every recordCycle() call
    // eligible to evaluate; config.baseSizeUsdc is never written back here,
    // so each alternating availableBalance recomputes against the same fixed
    // current base (100) and rate-limits to a different value every time —
    // guaranteeing a non-null adjustment on every iteration.
    const optimizer = makeOptimizer({
      sizeAutoManaged: true,
      sizeMaxChangePercent: 25,
      sizeEvaluationCycles: 1,
      sizeMinSampleSize: 1,
    });

    for (let i = 0; i < 60; i++) {
      const result = optimizer.recordCycle({
        stepsUsed: 5,
        capitalDeployed: 100,
        completedAt: 1_700_000_000_000 + i * 60_000,
        availableBalance: i % 2 === 0 ? 100 : 1_000_000,
      });
      assert.notEqual(result, null, `iteration ${i} was expected to trigger an adjustment`);
    }

    const { adjustmentHistory } = optimizer.exportState();
    assert.equal(adjustmentHistory.length, 50);
  });
});

// ============================================================================
// issue #694 — no compounding maxUsdcDeployed shrink across evaluations
// ============================================================================
describe('size-optimizer no-compounding-shrink regression (issue #694)', () => {
  it('does not ratchet maxUsdcDeployed down across repeated evaluations when fed a stable real balance', () => {
    // Mirrors what regime-engine.js's recordCycleForSizeOptimizer() now does:
    // feed the REAL (externally-sourced) available balance — here modeled as
    // a fixed value equal to the starting config.maxUsdcDeployed, i.e. a real
    // exchange balance that happens to equal the configured cap — and, like
    // the engine's handleSizeAdjustment(), write any returned adjustment back
    // into config before the next cycle. Before the fix, the engine instead
    // fed the (already-shrunk) cap back in as "availableBalance" every time,
    // so each evaluation computed 90% of the previous evaluation's OWN
    // output — a compounding decrease. With a stable real balance instead,
    // the cap should settle near targetUtilization * realBalance on the
    // first evaluation and then hold — never decrease again afterward.
    const config = { ...defaultConfig(), sizeAutoManaged: true, sizeEvaluationCycles: 5, sizeMinSampleSize: 5 };
    const optimizer = createSizeOptimizer('test-exchange', config, {}, 'BTC-USDC');
    const realBalance = config.maxUsdcDeployed; // availableBalance = config.maxUsdcDeployed, per the issue's repro

    const caps = [];
    for (let i = 0; i < 20; i++) {
      // Flat +$1/cycle profit tracked as capitalDeployed growth — independent
      // of the (constant) balance reading, exactly like the real engine.
      const adjustment = optimizer.recordCycle({
        stepsUsed: 5,
        capitalDeployed: 100 + i,
        completedAt: 1_700_000_000_000 + i * 60_000,
        availableBalance: realBalance,
      });

      if (adjustment) {
        config.baseSizeUsdc = adjustment.baseSizeUsdc;
        if (adjustment.maxUsdcDeployed !== undefined) {
          config.maxUsdcDeployed = adjustment.maxUsdcDeployed;
        }
      }

      caps.push(config.maxUsdcDeployed);
    }

    // A single equilibrating correction toward targetUtilization * realBalance
    // is expected and fine (the cap starts at the RAW config value, not yet
    // at 90% of the real balance). What issue #694 must never reproduce is a
    // SECOND decrease once the cap has already converged — that's the
    // compounding "$1005 → $905 → $819 → …" pattern from the bug report,
    // which only happens when the cap is fed back in as its own "balance".
    const decreases = caps.slice(1).filter((cap, i) => cap < caps[i]);
    assert.ok(
      decreases.length <= 1,
      `expected at most one (initial, equilibrating) decrease, saw ${decreases.length}: ${JSON.stringify(caps)}`
    );
    // And the cap must settle, not keep drifting down cycle after cycle.
    assert.equal(caps[caps.length - 1], caps[caps.length - 2], 'cap must have stabilized by the last cycle, not still be shrinking');
  });
});

// ============================================================================
// issue #694 — evaluate() skips rather than zero-floors on an unverified balance
// ============================================================================
describe('size-optimizer evaluate() with no verified balance yet (issue #694)', () => {
  it('never proposes an adjustment while every recordCycle() call has arrived with availableBalance <= 0', () => {
    const optimizer = makeOptimizer({ sizeAutoManaged: true, sizeMinSampleSize: 3, sizeEvaluationCycles: 3 });

    let lastAdjustment;
    for (let i = 0; i < 10; i++) {
      // Models every balance fetch failing (the engine now passes 0 in that
      // case) — lastKnownBalance never becomes a verified positive reading.
      lastAdjustment = optimizer.recordCycle({
        stepsUsed: 5,
        capitalDeployed: 100,
        completedAt: 1_700_000_000_000 + i * 60_000,
        availableBalance: 0,
      });
      assert.equal(lastAdjustment, null, `iteration ${i} must not propose an adjustment with no verified balance`);
    }

    // Once a real balance arrives, evaluation resumes normally.
    const adjustment = optimizer.recordCycle({
      stepsUsed: 5,
      capitalDeployed: 100,
      completedAt: 1_700_000_001_000,
      availableBalance: 1000,
    });
    assert.ok(adjustment, 'a verified positive balance must allow evaluation to proceed');
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
