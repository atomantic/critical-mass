// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeAutoSizeMultiplier, capitalGovernor } = require('../src/auto-aggressiveness');
const { validateRegimeConfig } = require('../src/config-validator');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

describe('capitalGovernor', () => {
  it('is 1 up to start, 0 from end, linear between', () => {
    assert.equal(capitalGovernor(0, 0.4, 0.9), 1);
    assert.equal(capitalGovernor(0.4, 0.4, 0.9), 1);
    near(capitalGovernor(0.65, 0.4, 0.9), 0.5);
    assert.equal(capitalGovernor(0.9, 0.4, 0.9), 0);
    assert.equal(capitalGovernor(1.2, 0.4, 0.9), 0);
  });
});

describe('computeAutoSizeMultiplier', () => {
  it('is neutral when not ready', () => {
    const r = computeAutoSizeMultiplier({ score: 1, ready: false, deployedRatio: 0 });
    assert.equal(r.active, false);
    assert.equal(r.multiplier, 1);
  });

  it('maps score linearly onto the 0.5x-1.5x range with low deployment', () => {
    near(computeAutoSizeMultiplier({ score: 0, ready: true, deployedRatio: 0 }).multiplier, 0.5);
    near(computeAutoSizeMultiplier({ score: 0.5, ready: true, deployedRatio: 0 }).multiplier, 1);
    near(computeAutoSizeMultiplier({ score: 1, ready: true, deployedRatio: 0 }).multiplier, 1.5);
  });

  it('clamps out-of-range scores', () => {
    near(computeAutoSizeMultiplier({ score: 7, ready: true, deployedRatio: 0 }).multiplier, 1.5);
    near(computeAutoSizeMultiplier({ score: -3, ready: true, deployedRatio: 0 }).multiplier, 0.5);
  });

  it('dampens the boost as capital deploys and removes it at full deployment', () => {
    const half = computeAutoSizeMultiplier({ score: 1, ready: true, deployedRatio: 0.65 });
    near(half.multiplier, 1.25);
    const full = computeAutoSizeMultiplier({ score: 1, ready: true, deployedRatio: 1 });
    near(full.multiplier, 1);
    assert.equal(full.governor, 0);
  });

  it('never shrinks a below-neutral multiplier via the governor', () => {
    near(computeAutoSizeMultiplier({ score: 0, ready: true, deployedRatio: 1 }).multiplier, 0.5);
  });

  it('lets the governor remove the whole boost even when minMult exceeds 1', () => {
    near(computeAutoSizeMultiplier({ score: 0.5, ready: true, deployedRatio: 1, minMult: 1.2, maxMult: 1.8 }).multiplier, 1);
  });

  it('respects widened and narrowed ranges', () => {
    near(computeAutoSizeMultiplier({ score: 1, ready: true, deployedRatio: 0, maxMult: 2 }).multiplier, 2);
    near(computeAutoSizeMultiplier({ score: 1, ready: true, deployedRatio: 0, maxMult: 1.2 }).multiplier, 1.2);
  });

  it('never exceeds maxMult or goes below minMult', () => {
    for (let s = 0; s <= 1; s += 0.05) {
      for (let d = 0; d <= 1.2; d += 0.05) {
        const m = computeAutoSizeMultiplier({ score: s, ready: true, deployedRatio: d }).multiplier;
        assert.ok(m >= 0.5 - 1e-9 && m <= 1.5 + 1e-9);
      }
    }
  });
});

describe('config validation', () => {
  it('rejects inverted ranges and governor bounds', () => {
    const errs = validateRegimeConfig({
      autoAggressivenessMinMult: 1.5, autoAggressivenessMaxMult: 0.5,
      autoAggressivenessGovernorStart: 0.9, autoAggressivenessGovernorEnd: 0.4,
    });
    const text = JSON.stringify(errs);
    assert.match(text, /MinMult must not exceed/);
    assert.match(text, /GovernorStart must be less than/);
  });
});
