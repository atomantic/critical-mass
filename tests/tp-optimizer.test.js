// @ts-check
/**
 * #424 — tpAutoManaged writes tpMinPercent/tpMaxPercent/holdbackRatio straight
 * into live config.json (src/regime-engine.js:776-795), and nothing guarded
 * that write-back: the safety bounds (tpAbsoluteMin/tpAbsoluteMax), the
 * minimum-spread rule (tpMax >= tpMin * 1.5), the per-adjustment rate limiter
 * (tpMaxChangePercent), and the empty-histogram/no-op refusal all lived in
 * src/tp-optimizer.js:calculateAdjustment with zero test coverage. This pins
 * the exact clamp boundaries and the refuse-to-write cases.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createTpOptimizer } = require('../src/tp-optimizer');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Baseline config mirroring src/tp-optimizer.js's defaults. `tpAutoManaged`
 * is off by default so recordCycle()'s internal evaluate() never fires
 * mid-loop while feeding synthetic data — clamp behavior is asserted via the
 * exposed `_calculateAdjustment` test hook instead, so it isn't entangled
 * with the (separately tested) evaluation-trigger/sample-size gating.
 */
const defaultConfig = () => ({
  tpAutoManaged: false,
  tpMinPercent: 0.1,
  tpMaxPercent: 1.0,
  holdbackRatio: 0.5,
  tpAbsoluteMin: 0.05,
  tpAbsoluteMax: 5.0,
  tpMaxChangePercent: 100000, // disabled unless a test overrides it — isolates other clamps from rate limiting
});

const makeOptimizer = (overrides = {}) =>
  createTpOptimizer('test-exchange', { ...defaultConfig(), ...overrides }, {}, 'BTC-USDC');

/**
 * Feed `count` completed cycles all reporting the same optimalTpPct, driven
 * by explicit increasing completedAt timestamps (no real sleeping).
 */
const feedCycles = (optimizer, optimalTpPct, count, startMs = 1_700_000_000_000) => {
  for (let i = 0; i < count; i++) {
    optimizer.recordCycle({
      optimalTpPct,
      actualTpPct: optimalTpPct,
      completedAt: startMs + i * 60_000,
      volBaseline: 0,
    });
  }
};

// ============================================================================
// Absolute bounds: tpAbsoluteMin / tpAbsoluteMax
// ============================================================================
describe('tp-optimizer absolute bounds (tpAbsoluteMin / tpAbsoluteMax)', () => {
  it('clamps a proposal pushed far above tpAbsoluteMax down to the bound', () => {
    const optimizer = makeOptimizer();
    // All samples land in the top histogram bucket [4.75, 5.0] -> p25=4.8125, p75=4.9375
    feedCycles(optimizer, 4.9, 15);

    const adjustment = optimizer._calculateAdjustment();

    assert.ok(adjustment, 'expected an adjustment to be proposed');
    assert.ok(adjustment.tpMinPercent >= 0.05, `tpMinPercent ${adjustment.tpMinPercent} must be >= tpAbsoluteMin`);
    assert.ok(adjustment.tpMaxPercent <= 5.0, `tpMaxPercent ${adjustment.tpMaxPercent} must be <= tpAbsoluteMax`);
    // Pin the exact clamp math (src/tp-optimizer.js:453-455): min is capped
    // at half of tpAbsoluteMax, max is capped at tpAbsoluteMax itself.
    assert.equal(adjustment.tpMinPercent, 2.5);
    assert.equal(adjustment.tpMaxPercent, 5.0);
  });

  it('clamps a proposal pushed far below tpAbsoluteMin up to the bound', () => {
    const optimizer = makeOptimizer();
    // All samples land in the bottom histogram bucket [0, 0.25] -> p25=0.0625, p75=0.1875
    feedCycles(optimizer, 0.01, 15);

    const adjustment = optimizer._calculateAdjustment();

    assert.ok(adjustment);
    assert.ok(adjustment.tpMinPercent >= 0.05, `tpMinPercent ${adjustment.tpMinPercent} must be >= tpAbsoluteMin`);
    assert.equal(adjustment.tpMinPercent, 0.05);
    assert.equal(adjustment.tpMaxPercent, 0.225);
  });
});

// ============================================================================
// Minimum spread: tpMaxPercent >= tpMinPercent * 1.5
// ============================================================================
describe('tp-optimizer minimum spread (tpMaxPercent >= tpMinPercent * 1.5)', () => {
  it('holds for a normal wide-spread proposal', () => {
    const optimizer = makeOptimizer();
    feedCycles(optimizer, 4.9, 15);

    const adjustment = optimizer._calculateAdjustment();

    assert.ok(adjustment.tpMaxPercent >= adjustment.tpMinPercent * 1.5);
  });

  it('is force-corrected when the tpAbsoluteMin floor pushes tpMin above what the raw percentiles would otherwise leave for tpMax', () => {
    // Raw percentiles for these cycles give proposedTpMin=0.05, proposedTpMax=0.225
    // (a healthy 4.5x natural ratio). But an operator-configured tpAbsoluteMin
    // of 0.2 floors tpMin to 0.2, which would leave tpMax (still 0.225) BELOW
    // 1.5x the floored tpMin (0.3) — this is the "raw percentiles invert"
    // case the code's explicit re-check (src/tp-optimizer.js:457-460) guards
    // against.
    const optimizer = makeOptimizer({ tpAbsoluteMin: 0.2 });
    feedCycles(optimizer, 0.01, 15);

    const adjustment = optimizer._calculateAdjustment();

    assert.equal(adjustment.tpMinPercent, 0.2);
    assert.equal(adjustment.tpMaxPercent, 0.3, 'tpMax must be forced up to exactly 1.5x the floored tpMin');
  });
});

// ============================================================================
// Rate limiting: tpMaxChangePercent
// ============================================================================
describe('tp-optimizer rate limiting (tpMaxChangePercent)', () => {
  it('bounds an upward move to tpMaxChangePercent of the current value and reports rate_limited', () => {
    const optimizer = makeOptimizer({ tpMaxChangePercent: 25, tpMinPercent: 0.1, tpMaxPercent: 1.0 });
    feedCycles(optimizer, 4.9, 15); // natural proposal (2.5, 5.0) is far above current (0.1, 1.0)

    const adjustment = optimizer._calculateAdjustment();

    assert.ok(adjustment);
    // maxMinChange = 0.1 * 25% = 0.025; maxMaxChange = 1.0 * 25% = 0.25
    assert.equal(adjustment.tpMinPercent, 0.125);
    assert.equal(adjustment.tpMaxPercent, 1.25);
    assert.match(adjustment.reason, /^rate_limited/);
  });

  it('bounds a downward move to tpMaxChangePercent of the current value and reports rate_limited', () => {
    const optimizer = makeOptimizer({ tpMaxChangePercent: 25, tpMinPercent: 1.0, tpMaxPercent: 2.0 });
    feedCycles(optimizer, 0.01, 15); // natural proposal (0.05, 0.225) is far below current (1.0, 2.0)

    const adjustment = optimizer._calculateAdjustment();

    assert.ok(adjustment);
    // maxMinChange = 1.0 * 25% = 0.25; maxMaxChange = 2.0 * 25% = 0.5
    assert.equal(adjustment.tpMinPercent, 0.75);
    assert.equal(adjustment.tpMaxPercent, 1.5);
    assert.match(adjustment.reason, /^rate_limited/);
  });

  it('never triggers rate_limited for a move that stays within the allowed change', () => {
    // Same cycles as the first bounds test, but tpMinPercent/tpMaxPercent
    // start close enough to the natural (2.5, 5.0) proposal that 25% of the
    // current values comfortably covers the gap.
    const optimizer = makeOptimizer({ tpMaxChangePercent: 25, tpMinPercent: 2.4, tpMaxPercent: 4.9 });
    feedCycles(optimizer, 4.9, 15);

    const adjustment = optimizer._calculateAdjustment();

    assert.ok(adjustment);
    assert.equal(adjustment.tpMinPercent, 2.5);
    assert.equal(adjustment.tpMaxPercent, 5.0);
    assert.match(adjustment.reason, /^percentile_based/);
  });
});

// ============================================================================
// Refuse-to-write cases: empty histogram and sub-threshold change
// ============================================================================
describe('tp-optimizer refuses to propose an adjustment', () => {
  it('returns null for an empty histogram (p50 === 0)', () => {
    const optimizer = makeOptimizer();
    assert.equal(optimizer._calculateAdjustment(), null);
  });

  it('returns null when the change is at or under the 0.01 no-op threshold', () => {
    // Cycles at 1.0% give natural proposedTpMin=0.85, proposedTpMax=1.425
    // with no clamping active (defaults leave plenty of headroom).
    const optimizer = makeOptimizer({ tpMinPercent: 0.85, tpMaxPercent: 1.425 });
    feedCycles(optimizer, 1.0, 15);

    assert.equal(optimizer._calculateAdjustment(), null, 'an exact match to the current config must not re-write it');
  });

  it('returns a real adjustment once the change clears the 0.01 boundary', () => {
    const optimizer = makeOptimizer({ tpMinPercent: 0.82, tpMaxPercent: 1.425 }); // |0.85 - 0.82| == 0.03
    feedCycles(optimizer, 1.0, 15);

    assert.notEqual(optimizer._calculateAdjustment(), null);
  });
});

// ============================================================================
// tpAutoManaged master switch
// ============================================================================
describe('tp-optimizer tpAutoManaged off-switch', () => {
  it('evaluate()/evaluateVol()/recordCycle() only ever propose an adjustment when tpAutoManaged is true', () => {
    const cycleData = { optimalTpPct: 4.9, actualTpPct: 4.9, completedAt: 1_700_000_000_000, volBaseline: 0 };
    const enabled = makeOptimizer({ tpAutoManaged: true, tpMinSampleSize: 1, tpEvaluationCycles: 1 });
    const disabled = makeOptimizer({ tpAutoManaged: false, tpMinSampleSize: 1, tpEvaluationCycles: 1 });

    assert.notEqual(enabled.recordCycle(cycleData), null, 'tpAutoManaged:true must be able to produce an adjustment');
    assert.equal(disabled.recordCycle(cycleData), null, 'tpAutoManaged:false must never write an adjustment');
    assert.equal(disabled.evaluate(), null);
    assert.equal(disabled.evaluateVol(), null);
  });
});

// ============================================================================
// exportState / importState round trip
// ============================================================================
describe('tp-optimizer exportState / importState round trip', () => {
  it('restores sampleCount, recentCycleCount, volSampleCount, and percentiles exactly', () => {
    const source = makeOptimizer();
    feedCycles(source, 2.0, 8);
    source.recordVolatilitySample({ atr5m: 50, lastPrice: 60000, realizedVol: 0.02, volBaseline: 0.02 });
    source.recordVolatilitySample({ atr5m: 60, lastPrice: 60000, realizedVol: 0.02, volBaseline: 0.02 });

    const exported = source.exportState();
    const target = makeOptimizer();
    target.importState(exported);

    const sourceStatus = source.getStatus();
    const targetStatus = target.getStatus();

    assert.equal(targetStatus.sampleCount, sourceStatus.sampleCount);
    assert.equal(targetStatus.sampleCount, 8);
    assert.equal(targetStatus.recentCycleCount, sourceStatus.recentCycleCount);
    assert.equal(targetStatus.recentCycleCount, 8);
    assert.equal(targetStatus.volSampleCount, sourceStatus.volSampleCount);
    assert.equal(targetStatus.volSampleCount, 2);
    assert.deepEqual(targetStatus.percentiles, sourceStatus.percentiles);
    assert.equal(targetStatus.histogramShapeMismatch, false);
  });

  it('discards a persisted histogram with the wrong bucket count, warns, and surfaces it via getStatus()', () => {
    const optimizer = makeOptimizer();
    const before = optimizer._getHistogram().map(b => ({ ...b }));

    const lines = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (line) => lines.push(line);
    console.warn = (line) => lines.push(line);
    console.error = (line) => lines.push(line);
    try {
      // BUCKET_COUNT is 20; a length-1 histogram simulates a stale/incompatible persisted state.
      optimizer.importState({ histogram: [{ min: 0, max: 1, weight: 5, count: 5 }] });
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }

    assert.deepEqual(optimizer._getHistogram(), before, 'a mismatched histogram must be discarded, not applied');
    assert.equal(optimizer.getStatus().histogramShapeMismatch, true);
    assert.ok(
      lines.some(line => line.includes('histogram shape mismatch')),
      'expected a warn log naming the discarded histogram'
    );
  });

  it('clears histogramShapeMismatch after a subsequent successful import', () => {
    const optimizer = makeOptimizer();
    optimizer.importState({ histogram: [{ min: 0, max: 1, weight: 5, count: 5 }] });
    assert.equal(optimizer.getStatus().histogramShapeMismatch, true);

    optimizer.importState(makeOptimizer().exportState());

    assert.equal(optimizer.getStatus().histogramShapeMismatch, false);
  });
});
