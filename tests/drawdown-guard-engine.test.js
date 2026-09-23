// @ts-check
//
// Engine-level regression for issue #693: the maxDrawdownPercent guard must be
// evaluated by the running engine (metrics tick), block new entries while
// paused, and forceResumeDrawdown must re-base the peak in the SAME equity unit
// the guard compares against (computeFundEquity).
//
// Uses the real dry-run executor (exchange config dryRun: true) wrapped with a
// placement counter, plus a mock adapter so no network is hit.
//
// Disk safety: a throwaway pair ('__test693__') so any state / ledger
// persistence lands in data/coinbase/__test693__/, deleted in after().
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createRegimeEngine } = require('../src/regime-engine');
const { computeFundEquity } = require('../src/risk-manager');

const TEST_PAIR = '__test693__';
const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  fs.rmSync(JUNK_DIR, { recursive: true, force: true });
});

const makeAdapter = () => ({
  getCandles: async () => { throw new Error('offline (test)'); },
  getAccountBalance: async () => ({ available: 1_000_000 }),
  getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
  getOrderFills: async () => [],
  getPositions: async () => [],
});

/**
 * Dry-run engine with a seeded open body and a placement counter on the real
 * dry-run executor.
 */
const makeEngine = () => {
  const eng = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: true, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  assert.equal(eng.isDryRun, true);

  const config = eng._getConfig();
  config.maxDrawdownPercent = 10;
  config.drawdownResetHours = 0; // no time-based auto-reset in this test
  config.maxUsdcDeployed = 1000;
  config.depositedCapital = 1000;
  config.maxAssetExposure = 0; // uncapped
  config.maxCycleBuys = 100;
  config.minIntervalMs = 0;
  config.maxIntervalMs = 0; // timer trigger always fires
  config.entryMode = 'reactive';
  config.ladderAutoSwitch = false;

  eng._test.setRunning(true);
  eng._test.setAdapter(makeAdapter());

  // Wrap (not replace) the dry-run executor so we can count entry placements.
  const counts = { entries: 0 };
  const realExec = eng._test.getOrderExecutor();
  const origPlace = realExec.placeEntryBid;
  realExec.placeEntryBid = async (...args) => {
    counts.entries += 1;
    return origPlace(...args);
  };

  // Seed an open position: one body, 5 asset bought at $100 (cost $500).
  const pos = eng._getPositionState();
  pos.celestialBodies = [{
    id: 'body-seed',
    tier: 'ASTEROID',
    assetQty: 5,
    costBasis: 500,
    avgPrice: 100,
    tpPrice: 101,
    tpOrderId: 'tp-seed',
    assetOnOrder: 5,
    buyOrders: [{ orderId: 'buy-seed' }],
    sourceOrderIds: [],
  }];
  pos.totalAsset = 5;
  pos.totalCostBasis = 500;
  pos.avgCostBasis = 100;
  pos.realizedPnL = 0;
  pos.realizedAssetPnL = 0;

  return { eng, counts, config };
};

/**
 * Entry evaluation with the health monitor forced ACTIVE: the test has no
 * websocket, so checkHealth() (run by every metrics tick) flips the engine
 * into SAFE (ws_disconnected), which would block entries for an unrelated
 * reason and make the drawdown assertions vacuous.
 */
const evaluateEntry = async (eng) => {
  const health = eng._test.getHealth();
  health.mode = 'ACTIVE';
  health.reason = null;
  await eng._test.evaluateEntryTrigger();
};

const setPrice = (eng, price) => {
  const m = eng._getMarketState();
  m.lastPrice = price;
  m.bid = price - 0.01;
  m.ask = price + 0.01;
};

describe('drawdown guard wired into the engine (issue #693)', () => {
  it('pauses entries past maxDrawdownPercent, and forceResumeDrawdown re-bases the peak in fund-equity units', async () => {
    const { eng, counts, config } = makeEngine();

    // Baseline: at $100 equity = 1000 − 500 + 5×100 = 1000 → peak 1000.
    setPrice(eng, 100);
    await eng._test.updateMetrics();
    assert.equal(eng.getState().risk.peakEquity, 1000);
    assert.equal(eng.getState().risk.isDrawdownPaused, false);

    // Sanity: the entry path actually places while unpaused (non-vacuous test).
    await evaluateEntry(eng);
    assert.equal(counts.entries, 1, 'baseline entry should be placed while unpaused');
    // Drop the pending entry so the reactive "one pending entry" guard doesn't mask the pause.
    const exec = eng._test.getOrderExecutor();
    await exec.cancelAllEntries();
    eng._getPositionState().pendingEntryOrders = [];
    const pendingAfterCancel = exec.getPendingCounts();
    assert.equal(pendingAfterCancel.entries, 0, 'test setup: pending entry must be cleared');

    // Crash: $70 → equity = 500 + 350 = 850 → 15% drawdown ≥ 10%.
    setPrice(eng, 70);
    await eng._test.updateMetrics();
    const risk = eng.getState().risk;
    assert.equal(risk.isDrawdownPaused, true);

    const caps = eng._test.checkAllCaps();
    assert.ok(caps.reasons.some(r => r.startsWith('drawdown_paused')), `reasons: ${caps.reasons}`);

    // Persisted for the dashboard + restart.
    const pos = eng._getPositionState();
    assert.ok(Math.abs(pos.maxDrawdownSeen - 15) < 1e-9);
    assert.equal(pos.drawdownGuard.isDrawdownPaused, true);

    const before = counts.entries;
    await evaluateEntry(eng);
    assert.equal(counts.entries, before, 'no new entry may be placed while drawdown-paused');

    // Manual resume: peak must equal current fund equity (not P&L units).
    const res = eng.forceResumeDrawdown();
    assert.equal(res.success, true);
    const expected = computeFundEquity(pos, config, 70).equity;
    assert.equal(expected, 850);
    const after = eng.getState().risk;
    assert.equal(after.isDrawdownPaused, false);
    assert.equal(after.peakEquity, expected);
    assert.equal(pos.drawdownGuard.isDrawdownPaused, false);

    // The next metrics tick at the same price must NOT re-pause (unit agreement).
    await eng._test.updateMetrics();
    assert.equal(eng.getState().risk.isDrawdownPaused, false);

    // Entries resume.
    await evaluateEntry(eng);
    assert.equal(counts.entries, before + 1, 'entries resume after forceResumeDrawdown');
  });

  it('a restarted engine restores an active pause from persisted position state', async () => {
    const { eng } = makeEngine();
    setPrice(eng, 100);
    await eng._test.updateMetrics();
    setPrice(eng, 70);
    await eng._test.updateMetrics();
    const snapshot = JSON.parse(JSON.stringify(eng._getPositionState().drawdownGuard));
    assert.equal(snapshot.isDrawdownPaused, true);

    const { eng: eng2 } = makeEngine();
    eng2._getPositionState().drawdownGuard = snapshot;
    setPrice(eng2, 70);
    await eng2._test.updateMetrics();
    const risk = eng2.getState().risk;
    assert.equal(risk.isDrawdownPaused, true);
    assert.equal(risk.peakEquity, 1000);
  });

  it('skips the sample while a fill/merge is mutating the position (no transient false drawdown)', async () => {
    const { eng } = makeEngine();
    setPrice(eng, 100);
    await eng._test.updateMetrics();
    // Simulate a TP mid-flight: body gone, sell not yet paired in the ledger.
    const pos = eng._getPositionState();
    pos.celestialBodies = [];
    pos.totalAsset = 0;
    pos.totalCostBasis = 0;
    eng._test.setFillInProgress(1);
    try {
      assert.equal(eng._test.refreshDrawdownGuard(), null);
      assert.equal(eng.getState().risk.isDrawdownPaused, false);
    } finally {
      eng._test.setFillInProgress(0);
    }
  });
});
