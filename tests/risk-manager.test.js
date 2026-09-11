// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRiskManager } = require('../src/risk-manager');

const HOUR_MS = 60 * 60 * 1000;

/** Base config with every field the risk manager reads. Override per-test. */
const makeConfig = (overrides = {}) => ({
  maxAssetExposure: 2,
  maxUsdcDeployed: 1000,
  maxCycleBuys: 3,
  cycleResetHours: 1,
  maxDrawdownPercent: 10,
  drawdownResetHours: 2,
  ...overrides,
});

const makePosition = (overrides = {}) => ({
  totalAsset: 0,
  totalCostBasis: 0,
  cycleBuys: 0,
  ...overrides,
});

/** Enable mocked Date.now() on the test context and return a risk manager. */
const setup = (t, configOverrides = {}, now = 1_000_000) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const riskManager = createRiskManager('coinbase', makeConfig(configOverrides), 'BTC-USDC');
  return riskManager;
};

describe('risk-manager checkAssetCap', () => {
  it('allows an entry that stays under the asset cap', (t) => {
    const riskManager = setup(t, { maxAssetExposure: 2 });
    const result = riskManager.checkAssetCap(0.5, 0.3);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
    assert.equal(result.maxAsset, 2);
  });

  it('rejects an entry that would push total asset over the cap', (t) => {
    const riskManager = setup(t, { maxAssetExposure: 2 });
    const result = riskManager.checkAssetCap(1.5, 1);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'asset_cap_exceeded:2.5>2');
  });

  it('allows an entry exactly at the cap boundary', (t) => {
    const riskManager = setup(t, { maxAssetExposure: 2 });
    const result = riskManager.checkAssetCap(1.5, 0.5);
    assert.equal(result.allowed, true);
  });

  it('bypasses the check entirely when maxAssetExposure is 0 (uncapped)', (t) => {
    const riskManager = setup(t, { maxAssetExposure: 0 });
    const result = riskManager.checkAssetCap(1_000_000, 1_000_000);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
    assert.equal(result.maxAsset, 0);
  });
});

describe('risk-manager checkUSDCCap', () => {
  it('allows an entry that stays under the USDC cap', (t) => {
    const riskManager = setup(t, { maxUsdcDeployed: 1000 });
    const result = riskManager.checkUSDCCap(500, 200);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
    assert.equal(result.maxUsdc, 1000);
  });

  it('rejects an entry that would push total USDC deployed over the cap', (t) => {
    const riskManager = setup(t, { maxUsdcDeployed: 1000 });
    const result = riskManager.checkUSDCCap(900, 200);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'usdc_cap_exceeded:1100>1000');
  });

  it('allows an entry exactly at the cap boundary', (t) => {
    const riskManager = setup(t, { maxUsdcDeployed: 1000 });
    const result = riskManager.checkUSDCCap(800, 200);
    assert.equal(result.allowed, true);
  });
});

describe('risk-manager checkCycleBuysLimit', () => {
  it('allows entries while below the cycle buys limit', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 3 });
    const result = riskManager.checkCycleBuysLimit(2);
    assert.equal(result.allowed, true);
    assert.equal(result.shouldReset, false);
  });

  it('rejects with cycle_buys_limit_reached once at the limit', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 3 });
    const result = riskManager.checkCycleBuysLimit(3);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'cycle_buys_limit_reached:3>=3');
    assert.equal(result.shouldReset, false);
  });

  it('keeps rejecting immediately after hitting the limit (no time elapsed)', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 3, cycleResetHours: 1 });
    riskManager.checkCycleBuysLimit(3); // first hit, starts the reset clock
    const result = riskManager.checkCycleBuysLimit(3);
    assert.equal(result.allowed, false);
  });

  it('auto-resets and signals shouldReset once cycleResetHours has elapsed at the limit', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 3, cycleResetHours: 1 }, 1_000_000);
    riskManager.checkCycleBuysLimit(3); // starts the reset clock at t=1_000_000

    t.mock.timers.setTime(1_000_000 + HOUR_MS - 1); // just under the threshold
    const stillBlocked = riskManager.checkCycleBuysLimit(3);
    assert.equal(stillBlocked.allowed, false);
    assert.equal(stillBlocked.shouldReset, false);

    t.mock.timers.setTime(1_000_000 + HOUR_MS); // reached the threshold
    const reset = riskManager.checkCycleBuysLimit(3);
    assert.equal(reset.allowed, true);
    assert.equal(reset.shouldReset, true);
  });

  it('re-arms the reset clock if the caller has not actually lowered cycleBuys after an auto-reset signal', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 3, cycleResetHours: 1 }, 1_000_000);
    riskManager.checkCycleBuysLimit(3);
    t.mock.timers.setTime(1_000_000 + HOUR_MS);
    const reset = riskManager.checkCycleBuysLimit(3);
    assert.equal(reset.shouldReset, true);

    // Caller ignored the reset signal (still passing currentStep=3 immediately after) —
    // the limiter should re-block rather than keep signalling reset.
    const again = riskManager.checkCycleBuysLimit(3);
    assert.equal(again.allowed, false);
    assert.equal(again.shouldReset, false);
  });

  it('clears the reached-at timestamp once the step count drops back below the limit', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 3, cycleResetHours: 1 }, 1_000_000);
    riskManager.checkCycleBuysLimit(3); // hits limit, starts clock
    riskManager.checkCycleBuysLimit(1); // caller reset cycleBuys down (e.g. after a TP)

    // Advancing well past cycleResetHours should NOT trigger an auto-reset signal,
    // because the clock was cleared when the step count dropped.
    t.mock.timers.setTime(1_000_000 + HOUR_MS * 5);
    const result = riskManager.checkCycleBuysLimit(3);
    assert.equal(result.allowed, false);
    assert.equal(result.shouldReset, false);
  });
});

describe('risk-manager updateDrawdown', () => {
  it('initializes peak equity on the first observed position', (t) => {
    const riskManager = setup(t);
    const result = riskManager.updateDrawdown(1, 100, 100);
    assert.equal(result.peakEquity, 100);
    assert.equal(result.drawdownPercent, 0);
    assert.equal(result.isPaused, false);
  });

  it('tracks a rising peak as price rises', (t) => {
    const riskManager = setup(t);
    riskManager.updateDrawdown(1, 100, 100);
    const result = riskManager.updateDrawdown(1, 110, 100);
    assert.equal(result.peakEquity, 110);
    assert.equal(result.drawdownPercent, 0);
  });

  it('activates the pause once drawdown reaches maxDrawdownPercent', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100); // peak = 100
    riskManager.updateDrawdown(1, 110, 100); // peak = 110
    const result = riskManager.updateDrawdown(1, 99, 100); // (110-99)/110*100 = 10%
    assert.equal(result.drawdownPercent, 10);
    assert.equal(result.isPaused, true);
  });

  it('does not pause while drawdown stays under the threshold', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100);
    const result = riskManager.updateDrawdown(1, 95, 100); // 5% drawdown
    assert.equal(result.isPaused, false);
  });

  it('resumes automatically once drawdown recovers to <= 50% of the threshold', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100); // peak = 100
    const paused = riskManager.updateDrawdown(1, 89, 100); // 11% drawdown -> paused
    assert.equal(paused.isPaused, true);

    const stillPaused = riskManager.updateDrawdown(1, 96, 100); // 4% drawdown, below 5% (50% of 10) -> resume
    assert.equal(stillPaused.isPaused, false);
    assert.equal(stillPaused.drawdownPercent, 4);
  });

  it('stays paused while drawdown recovery has not yet crossed the 50% threshold', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100);
    riskManager.updateDrawdown(1, 89, 100); // paused, 11% drawdown
    const result = riskManager.updateDrawdown(1, 94, 100); // 6% drawdown, still >= 5%
    assert.equal(result.isPaused, true);
  });

  it('auto-resets the peak after drawdownResetHours of being paused', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10, drawdownResetHours: 2 }, 1_000_000);
    riskManager.updateDrawdown(1, 100, 100); // peak = 100
    const paused = riskManager.updateDrawdown(1, 89, 100); // paused at t=1_000_000
    assert.equal(paused.isPaused, true);

    t.mock.timers.setTime(1_000_000 + HOUR_MS * 2);
    const result = riskManager.updateDrawdown(1, 89, 100); // still depressed price
    assert.equal(result.isPaused, false);
    assert.equal(result.peakEquity, 89); // peak reset to current equity
    assert.equal(result.drawdownPercent, 0);
  });

  it('does not auto-reset before drawdownResetHours has elapsed', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10, drawdownResetHours: 2 }, 1_000_000);
    riskManager.updateDrawdown(1, 100, 100);
    riskManager.updateDrawdown(1, 89, 100); // paused

    t.mock.timers.setTime(1_000_000 + HOUR_MS * 2 - 1);
    const result = riskManager.updateDrawdown(1, 89, 100);
    assert.equal(result.isPaused, true);
  });

  it('skips drawdown tracking entirely when there is no position', (t) => {
    const riskManager = setup(t);
    const result = riskManager.updateDrawdown(0, 100, 0);
    assert.equal(result.drawdownPercent, 0);
    assert.equal(result.isPaused, false);
    assert.equal(result.peakEquity, 0);
  });
});

describe('risk-manager canPlaceEntry / checkAllCaps', () => {
  it('aggregates every violated cap into the reasons list', (t) => {
    const riskManager = setup(t, {
      maxAssetExposure: 1,
      maxUsdcDeployed: 100,
      maxCycleBuys: 2,
      cycleResetHours: 1,
      maxDrawdownPercent: 10,
      drawdownResetHours: 1,
    });

    // Trigger a drawdown pause first.
    riskManager.updateDrawdown(1, 100, 100);
    riskManager.updateDrawdown(1, 85, 100); // 15% drawdown -> paused

    const position = makePosition({ totalAsset: 0.9, totalCostBasis: 90, cycleBuys: 2 });
    const result = riskManager.canPlaceEntry(position, 0.5, 50);

    assert.equal(result.allowed, false);
    assert.match(result.reason, /asset_cap_exceeded/);
    assert.match(result.reason, /usdc_cap_exceeded/);
    assert.match(result.reason, /cycle_buys_limit_reached/);
    assert.match(result.reason, /drawdown_paused/);
    assert.equal(result.reason.split(', ').length, 4);
  });

  it('allows entry when every cap is satisfied', (t) => {
    const riskManager = setup(t, { maxAssetExposure: 2, maxUsdcDeployed: 1000, maxCycleBuys: 3 });
    const position = makePosition({ totalAsset: 0.5, totalCostBasis: 500, cycleBuys: 1 });
    const result = riskManager.canPlaceEntry(position, 0.2, 100);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
  });

  it('propagates shouldResetCycleBuys through canPlaceEntry once the cycle reset window elapses', (t) => {
    const riskManager = setup(t, { maxCycleBuys: 2, cycleResetHours: 1 }, 1_000_000);
    const position = makePosition({ totalAsset: 0, totalCostBasis: 0, cycleBuys: 2 });
    riskManager.canPlaceEntry(position, 0, 0); // starts the reset clock

    t.mock.timers.setTime(1_000_000 + HOUR_MS);
    const result = riskManager.canPlaceEntry(position, 0, 0);
    assert.equal(result.shouldResetCycleBuys, true);
    assert.equal(result.allowed, true);
  });
});

describe('risk-manager forceResume', () => {
  it('clears the pause and resets peak equity to the supplied current equity', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100); // peak = 100
    riskManager.updateDrawdown(1, 85, 100); // paused
    assert.equal(riskManager.getState().isDrawdownPaused, true);

    riskManager.forceResume(120);

    const state = riskManager.getState();
    assert.equal(state.isDrawdownPaused, false);
    assert.equal(state.peakEquity, 120);
    assert.equal(state.drawdownPausedAt, null);
  });

  it('clears the pause without touching peak equity when called with no argument', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100); // peak = 100
    riskManager.updateDrawdown(1, 85, 100); // paused

    riskManager.forceResume();

    const state = riskManager.getState();
    assert.equal(state.isDrawdownPaused, false);
    assert.equal(state.peakEquity, 100);
  });

  it('is a no-op when not currently paused', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100); // peak = 100, not paused
    riskManager.forceResume(999);

    const state = riskManager.getState();
    assert.equal(state.isDrawdownPaused, false);
    assert.equal(state.peakEquity, 100); // unchanged, forceResume did nothing
  });
});

describe('risk-manager resetCycleTracking', () => {
  it('resets peak equity to uninitialized without clearing an active pause', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1, 100, 100);
    riskManager.updateDrawdown(1, 85, 100); // paused, peak = 100

    riskManager.resetCycleTracking();

    const stateAfterReset = riskManager.getState();
    assert.equal(stateAfterReset.peakEquity, null);

    // Next observation re-initializes peak from scratch.
    const result = riskManager.updateDrawdown(1, 50, 50);
    assert.equal(result.peakEquity, 50);
  });
});

it('rejected regime updates cannot replace the drawdown safety threshold (#495)', () => {
  const { validateAndSanitizeRegimeConfig } = require('../src/config-validator');
  const config = makeConfig({ maxDrawdownPercent: 20 });
  const risk = createRiskManager('coinbase', config, 'BTC-USDC');
  assert.equal(risk.updateDrawdown(1, 100, 100).isPaused, false);
  for (const maxDrawdownPercent of ['oops', '20', {}, [], true, null, NaN, Infinity]) {
    const result = validateAndSanitizeRegimeConfig({ maxDrawdownPercent }, config);
    if (result.valid) Object.assign(config, result.value);
    assert.equal(result.valid, false);
    assert.equal(config.maxDrawdownPercent, 20);
  }
  const drawdown = risk.updateDrawdown(1, 50, 100);
  assert.equal(drawdown.drawdownPercent, 50);
  assert.equal(drawdown.isPaused, true);
});
