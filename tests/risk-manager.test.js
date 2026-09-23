// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRiskManager, computeFundEquity, resolveDrawdownCapitalBase } = require('../src/risk-manager');

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
    const result = riskManager.updateDrawdown(100);
    assert.equal(result.peakEquity, 100);
    assert.equal(result.drawdownPercent, 0);
    assert.equal(result.isPaused, false);
  });

  it('tracks a rising peak as price rises', (t) => {
    const riskManager = setup(t);
    riskManager.updateDrawdown(100);
    const result = riskManager.updateDrawdown(110);
    assert.equal(result.peakEquity, 110);
    assert.equal(result.drawdownPercent, 0);
  });

  it('activates the pause once drawdown reaches maxDrawdownPercent', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100); // peak = 100
    riskManager.updateDrawdown(110); // peak = 110
    const result = riskManager.updateDrawdown(99); // (110-99)/110*100 = 10%
    assert.equal(result.drawdownPercent, 10);
    assert.equal(result.isPaused, true);
  });

  it('does not pause while drawdown stays under the threshold', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100);
    const result = riskManager.updateDrawdown(95); // 5% drawdown
    assert.equal(result.isPaused, false);
  });

  it('resumes automatically once drawdown recovers to <= 50% of the threshold', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100); // peak = 100
    const paused = riskManager.updateDrawdown(89); // 11% drawdown -> paused
    assert.equal(paused.isPaused, true);

    const stillPaused = riskManager.updateDrawdown(96); // 4% drawdown, below 5% (50% of 10) -> resume
    assert.equal(stillPaused.isPaused, false);
    assert.equal(stillPaused.drawdownPercent, 4);
  });

  it('stays paused while drawdown recovery has not yet crossed the 50% threshold', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100);
    riskManager.updateDrawdown(89); // paused, 11% drawdown
    const result = riskManager.updateDrawdown(94); // 6% drawdown, still >= 5%
    assert.equal(result.isPaused, true);
  });

  it('auto-resets the peak after drawdownResetHours of being paused', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10, drawdownResetHours: 2 }, 1_000_000);
    riskManager.updateDrawdown(100); // peak = 100
    const paused = riskManager.updateDrawdown(89); // paused at t=1_000_000
    assert.equal(paused.isPaused, true);

    t.mock.timers.setTime(1_000_000 + HOUR_MS * 2);
    const result = riskManager.updateDrawdown(89); // still depressed price
    assert.equal(result.isPaused, false);
    assert.equal(result.peakEquity, 89); // peak reset to current equity
    assert.equal(result.drawdownPercent, 0);
  });

  it('does not auto-reset before drawdownResetHours has elapsed', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10, drawdownResetHours: 2 }, 1_000_000);
    riskManager.updateDrawdown(100);
    riskManager.updateDrawdown(89); // paused

    t.mock.timers.setTime(1_000_000 + HOUR_MS * 2 - 1);
    const result = riskManager.updateDrawdown(89);
    assert.equal(result.isPaused, true);
  });

  it('skips drawdown tracking entirely when equity is not positive', (t) => {
    const riskManager = setup(t);
    const result = riskManager.updateDrawdown(0);
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
    riskManager.updateDrawdown(100);
    riskManager.updateDrawdown(85); // 15% drawdown -> paused

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
    riskManager.updateDrawdown(100); // peak = 100
    riskManager.updateDrawdown(85); // paused
    assert.equal(riskManager.getState().isDrawdownPaused, true);

    riskManager.forceResume(120);

    const state = riskManager.getState();
    assert.equal(state.isDrawdownPaused, false);
    assert.equal(state.peakEquity, 120);
    assert.equal(state.drawdownPausedAt, null);
  });

  it('clears the pause without touching peak equity when called with no argument', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100); // peak = 100
    riskManager.updateDrawdown(85); // paused

    riskManager.forceResume();

    const state = riskManager.getState();
    assert.equal(state.isDrawdownPaused, false);
    assert.equal(state.peakEquity, 100);
  });

  it('is a no-op when not currently paused', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100); // peak = 100, not paused
    riskManager.forceResume(999);

    const state = riskManager.getState();
    assert.equal(state.isDrawdownPaused, false);
    assert.equal(state.peakEquity, 100); // unchanged, forceResume did nothing
  });
});

describe('risk-manager resetCycleTracking', () => {
  // Fund equity is continuous across a TP / cycle reset (issue #693), so the
  // cycle boundary no longer wipes the drawdown baseline.
  it('keeps the peak and an active pause across a cycle reset', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(100);
    riskManager.updateDrawdown(85); // paused, peak = 100

    riskManager.resetCycleTracking();

    const stateAfterReset = riskManager.getState();
    assert.equal(stateAfterReset.peakEquity, 100);
    assert.equal(stateAfterReset.isDrawdownPaused, true);

    const result = riskManager.updateDrawdown(88);
    assert.equal(result.peakEquity, 100);
    assert.equal(result.isPaused, true);
  });
});

it('rejected regime updates cannot replace the drawdown safety threshold (#495)', () => {
  const { validateAndSanitizeRegimeConfig } = require('../src/config-validator');
  const config = makeConfig({ maxDrawdownPercent: 20 });
  const risk = createRiskManager('coinbase', config, 'BTC-USDC');
  assert.equal(risk.updateDrawdown(100).isPaused, false);
  for (const maxDrawdownPercent of ['oops', '20', {}, [], true, null, NaN, Infinity]) {
    const result = validateAndSanitizeRegimeConfig({ maxDrawdownPercent }, config);
    if (result.valid) Object.assign(config, result.value);
    assert.equal(result.valid, false);
    assert.equal(config.maxDrawdownPercent, 20);
  }
  const drawdown = risk.updateDrawdown(50);
  assert.equal(drawdown.drawdownPercent, 50);
  assert.equal(drawdown.isPaused, true);
});

describe('risk-manager fund equity (issue #693)', () => {
  it('equity = capital − open cost + realized + (body asset + reserves) × price', () => {
    const { equity, capitalBase } = computeFundEquity(
      { depositedCapital: 1000, totalCostBasis: 300, realizedPnL: 20, totalAsset: 3, realizedAssetPnL: 0.5 },
      { maxUsdcDeployed: 5000 },
      100,
    );
    assert.equal(capitalBase, 1000);
    assert.equal(equity, 1000 - 300 + 20 + 3.5 * 100);
  });

  it('capital base prefers explicit deposits and falls back to the budget, never the realized-derived value', () => {
    // engine-tracked deposit (kept current by updateConfig) beats the config value
    assert.equal(resolveDrawdownCapitalBase({ depositedCapital: 500 }, { depositedCapital: 800, maxUsdcDeployed: 1000 }), 500);
    assert.equal(resolveDrawdownCapitalBase({}, { depositedCapital: 800, maxUsdcDeployed: 1000 }), 800);
    assert.equal(resolveDrawdownCapitalBase({ depositedCapital: 500 }, { maxUsdcDeployed: 1000 }), 500);
    assert.equal(resolveDrawdownCapitalBase({ originalCapital: 400 }, { maxUsdcDeployed: 1000 }), 400);
    // realizedPnL must not leak into the base (APY auto-derive would give 900)
    assert.equal(resolveDrawdownCapitalBase({ realizedPnL: 100 }, { maxUsdcDeployed: 1000 }), 1000);
  });

  it('does not drop when a body TP converts asset to quote (holdback retained)', () => {
    const config = { maxUsdcDeployed: 1000 };
    // One body: 1 asset bought for $100. Mark = $110.
    const before = computeFundEquity(
      { totalAsset: 1, totalCostBasis: 100, realizedPnL: 0, realizedAssetPnL: 0 }, config, 110,
    ).equity;
    // TP sells 0.95 @ 110 (proceeds 104.5), keeps 0.05 holdback. Prorated cost
    // = 100 × 0.95 = 95 → bodyPnl 9.5. Body closes: cost + qty leave the body.
    const after = computeFundEquity(
      { totalAsset: 0, totalCostBasis: 0, realizedPnL: 9.5, realizedAssetPnL: 0.05 }, config, 110,
    ).equity;
    assert.ok(after >= before, `equity fell across a TP: ${before} -> ${after}`);
    // The difference is exactly the holdback's prorated cost (booked zero-cost).
    assert.ok(Math.abs(after - before - 5) < 1e-9);
  });

  it('a TP does not trip the guard even when it is most of the position', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    const config = { maxUsdcDeployed: 100 };
    const pre = computeFundEquity({ totalAsset: 1, totalCostBasis: 100 }, config, 110);
    riskManager.updateDrawdown(pre.equity, pre.capitalBase);
    const post = computeFundEquity({ totalAsset: 0, totalCostBasis: 0, realizedPnL: 9.5, realizedAssetPnL: 0.05 }, config, 110);
    const result = riskManager.updateDrawdown(post.equity, post.capitalBase);
    assert.equal(result.drawdownPercent, 0);
    assert.equal(result.isPaused, false);
  });
});

describe('risk-manager drawdown capital re-basing / persistence (issue #693)', () => {
  it('a withdrawal re-bases the peak instead of reading as a drawdown', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1000, 1000);
    const result = riskManager.updateDrawdown(500, 500); // operator withdrew $500
    assert.equal(result.peakEquity, 500);
    assert.equal(result.drawdownPercent, 0);
    assert.equal(result.isPaused, false);
  });

  it('a deposit re-bases the peak so later losses are measured against the new capital', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1000, 1000);
    riskManager.updateDrawdown(1500, 1500); // +$500 deposit
    const result = riskManager.updateDrawdown(1350, 1500); // −$150 = 10% of 1500
    assert.equal(result.peakEquity, 1500);
    assert.equal(result.drawdownPercent, 10);
    assert.equal(result.isPaused, true);
  });

  it('depleted equity against a known peak pauses (100% drawdown) instead of being skipped', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1000, 1000);
    const result = riskManager.updateDrawdown(-5, 1000);
    assert.equal(result.isPaused, true);
    assert.equal(result.drawdownPercent, 100);
    assert.match(riskManager.canPlaceEntry(makePosition(), 0, 0).reason, /drawdown_paused/);
  });

  it('forceResume records the capital base so a deposit is not re-applied on the next tick', (t) => {
    const riskManager = setup(t, { maxDrawdownPercent: 10 });
    riskManager.updateDrawdown(1000, 1000);
    riskManager.updateDrawdown(850, 1000); // paused
    // Operator deposits $500 and resumes before the next metrics tick.
    riskManager.forceResume(1350, 1500);
    const result = riskManager.updateDrawdown(1350, 1500);
    assert.equal(result.peakEquity, 1350);
    assert.equal(result.drawdownPercent, 0);
    assert.equal(result.isPaused, false);
    assert.equal(riskManager.getState().currentDrawdownPercent, 0);
  });

  it('round-trips an active pause and the peak through getPersistedState / restoreState', (t) => {
    const a = setup(t, { maxDrawdownPercent: 10 });
    a.updateDrawdown(1000, 1000);
    a.updateDrawdown(850, 1000); // 15% → paused
    const snapshot = JSON.parse(JSON.stringify(a.getPersistedState()));

    const b = createRiskManager('coinbase', makeConfig({ maxDrawdownPercent: 10 }), 'BTC-USDC');
    b.restoreState(snapshot);
    const state = b.getState();
    assert.equal(state.isDrawdownPaused, true);
    assert.equal(state.peakEquity, 1000);
    assert.equal(state.maxDrawdownSeen, 15);
    assert.match(b.canPlaceEntry(makePosition(), 0, 0).reason, /drawdown_paused/);
  });

  it('restoreState ignores missing / malformed snapshots', () => {
    const rm = createRiskManager('coinbase', makeConfig(), 'BTC-USDC');
    rm.restoreState(null);
    rm.restoreState({ peakEquity: 'x', maxDrawdownSeen: NaN, isDrawdownPaused: 'yes' });
    const state = rm.getState();
    assert.equal(state.peakEquity, null);
    assert.equal(state.maxDrawdownSeen, 0);
    assert.equal(state.isDrawdownPaused, false);
  });
});
