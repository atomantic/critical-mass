// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeAdaptiveStaleMs } = require('../src/volatility-utils');
const { DEFAULT_AGGRESSIVENESS_PRESETS } = require('../src/config-utils');

// BTC-USDC reference: price 63000, ATR ≈ 6bps → atr = 63000 * 0.0006
const PRICE = 63000;
const ATR_6BPS = PRICE * 6 / 10000;

describe('computeAdaptiveStaleMs', () => {
  const config = { orderStaleMs: 120000, maxIntervalMs: 600000 };

  it('scales quadratically with offset/ATR ratio', () => {
    // offset == ATR (6bps) → 4min base window
    const atOneAtr = computeAdaptiveStaleMs(6, ATR_6BPS, PRICE, config);
    assert.equal(atOneAtr, 240000);
    // offset == 2×ATR → 4× the window (quadratic), but capped at maxIntervalMs
    const atTwoAtr = computeAdaptiveStaleMs(12, ATR_6BPS, PRICE, { ...config, maxIntervalMs: 3600000 });
    assert.equal(atTwoAtr, 960000);
  });

  it('floors at orderStaleMs when volatility is high relative to the offset', () => {
    // ATR 30bps, offset 5bps → raw window ~6.7s, floored at configured 120s
    const atr30bps = PRICE * 30 / 10000;
    assert.equal(computeAdaptiveStaleMs(5, atr30bps, PRICE, config), 120000);
  });

  it('caps at maxIntervalMs so a resting bid cannot starve the entry cadence', () => {
    // 18bps deep at 6bps ATR → raw ~36min, capped at 10min
    assert.equal(computeAdaptiveStaleMs(18, ATR_6BPS, PRICE, config), 600000);
  });

  it('cap never falls below the floor even if maxIntervalMs < orderStaleMs', () => {
    const cfg = { orderStaleMs: 120000, maxIntervalMs: 60000 };
    assert.equal(computeAdaptiveStaleMs(18, ATR_6BPS, PRICE, cfg), 120000);
  });

  it('falls back to orderStaleMs when ATR or price is unavailable', () => {
    assert.equal(computeAdaptiveStaleMs(10, 0, PRICE, config), 120000);
    assert.equal(computeAdaptiveStaleMs(10, NaN, PRICE, config), 120000);
    assert.equal(computeAdaptiveStaleMs(10, ATR_6BPS, 0, config), 120000);
    assert.equal(computeAdaptiveStaleMs(0, ATR_6BPS, PRICE, config), 120000);
    assert.equal(computeAdaptiveStaleMs(10, ATR_6BPS, PRICE, {}), 30000);
  });
});

describe('DEFAULT_AGGRESSIVENESS_PRESETS entry-offset consistency', () => {
  it('every level defines momentum offsets and a stale floor', () => {
    for (const [level, preset] of Object.entries(DEFAULT_AGGRESSIVENESS_PRESETS)) {
      assert.ok(preset.entryOffsetUpBps > 0, `${level}: entryOffsetUpBps missing`);
      assert.ok(preset.entryOffsetDownBps > 0, `${level}: entryOffsetDownBps missing`);
      assert.ok(preset.orderStaleMs >= 30000, `${level}: orderStaleMs missing`);
      // Momentum offsets must bracket the neutral offset — the pre-fix state
      // (global 5/15 defaults for every level) let a conservative fund bid
      // tighter on up-momentum than its own neutral offset.
      assert.ok(preset.entryOffsetUpBps < preset.entryOffsetBps, `${level}: up offset must be tighter than neutral`);
      assert.ok(preset.entryOffsetDownBps > preset.entryOffsetBps, `${level}: down offset must be deeper than neutral`);
    }
  });

  it('stale floor scales with offset depth across levels', () => {
    const { conservative, moderate, aggressive, maximum } = DEFAULT_AGGRESSIVENESS_PRESETS;
    assert.ok(conservative.orderStaleMs > moderate.orderStaleMs);
    assert.ok(moderate.orderStaleMs > aggressive.orderStaleMs);
    assert.ok(aggressive.orderStaleMs > maximum.orderStaleMs);
  });
});
