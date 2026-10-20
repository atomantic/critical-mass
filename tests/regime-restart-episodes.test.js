// Offline restart tests: real engine start/stop, disposable fund state, no exchange I/O.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-restart-episodes');
const configUtils = require('../src/config-utils');
const oldUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const feed = require('../src/websocket-feed');
const oldFeed = feed.createWebSocketFeed;
let onConnect = () => {};
feed.createWebSocketFeed = () => ({ connect: () => onConnect(), disconnect: () => {} });
const { createRegimeEngine } = require('../src/regime-engine');
const { saveFundRegimeState, loadFundRegimeState } = require('../src/state-tracker');
const dryRunState = require('../src/dry-run-state');
const { tradeEvents } = require('../src/trade-events');
const engines = [];
after(async () => {
  for (const eng of engines) { await eng.stop(); eng._test.clearTimers(); }
  configUtils.updateRegimeConfig = oldUpdate;
  feed.createWebSocketFeed = oldFeed;
  isolated.cleanup();
});

const makeEngine = (pair, dryRun = true, adapterOverrides = {}) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  Object.assign(eng._getConfig(), {
    maxUsdcDeployed: 1000, maxAssetExposure: 0, maxCycleBuys: 2, cycleResetHours: 1,
    minIntervalMs: 0, maxIntervalMs: 0, entryMode: 'reactive', ladderAutoSwitch: false,
    macroRegimeEnabled: false,
  });
  eng._test.setAdapter({
    getProductDetails: async () => null, loadCredentials: () => ({}),
    getCandles: async () => [], getCurrentPrice: async () => 100,
    getAccountBalance: async () => ({ available: 0, hold: 0 }),
    getOpenOrders: async () => [], getOrder: async () => ({ status: 'OPEN', filledSize: 0 }),
    getOrderFills: async () => [],
    ...adapterOverrides,
  });
  eng._test.setRecoveryModule({ recoverState: async () => ({
    position: { totalAsset: 0, totalCostBasis: 0, avgCostBasis: 0, cycleBuys: 0 },
    openOrders: new Map(), discrepancies: [],
  }) });
  return eng;
};
const evaluate = async (eng) => {
  Object.assign(eng._getMarketState(), { lastPrice: 100, bid: 99.99, ask: 100.01 });
  Object.assign(eng._test.getHealth(), { mode: 'ACTIVE', reason: null });
  await eng._test.evaluateEntryTrigger();
};
const eventsFor = (t, pair) => {
  const events = [];
  const listener = event => { if (event.data?.pair === pair) events.push(event); };
  tradeEvents.on('trade', listener);
  t.after(() => tradeEvents.off('trade', listener));
  return type => events.filter(e => e.type === type);
};

describe('durable engine episodes (#1297)', () => {
  it('hydrates the limit clock before the first entry, and stop saves without a metrics tick', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const pair = '__restart_clock__';
    let eng = makeEngine(pair);
    await eng.start();
    eng._getPositionState().cycleBuys = 2;
    await evaluate(eng);
    await eng.stop();
    assert.equal(dryRunState.loadState('coinbase', pair).position.drawdownGuard.cycleBuysLimitReachedAt, now);
    now += 59 * 60 * 1000;
    eng = makeEngine(pair);
    await eng.start();
    await evaluate(eng); // no metrics hydrate before this entry
    assert.equal(eng._getPositionState().cycleBuys, 2);
    now += 60 * 1000;
    await evaluate(eng);
    assert.equal(eng._getPositionState().cycleBuys, 0);
    await eng.stop();
    assert.equal(dryRunState.loadState('coinbase', pair).position.drawdownGuard.cycleBuysLimitReachedAt, null);
  });

  it('alerts once across pause/resume and again after a cleared cap recurs across another restart', async (t) => {
    const pair = '__restart_cap__';
    const events = eventsFor(t, pair);
    let eng = makeEngine(pair);
    eng._getConfig().cycleResetHours = 0;
    await eng.start();
    eng._getPositionState().cycleBuys = 2;
    await evaluate(eng);
    await eng.stop();
    eng = makeEngine(pair);
    eng._getConfig().cycleResetHours = 0;
    await eng.start();
    await evaluate(eng);
    assert.equal(events('cap_reached').length, 1);
    eng._getPositionState().cycleBuys = 0;
    await evaluate(eng);
    await eng.stop();
    eng = makeEngine(pair);
    await eng.start();
    eng._getPositionState().cycleBuys = 2;
    await evaluate(eng);
    assert.equal(events('cap_reached').length, 2);
    assert.equal((await eng.resetCycleBuys()).success, true);
    // A metrics tick must not rehydrate the old episode after an operator reset.
    await eng._test.updateMetrics();
    await eng.stop();
    const cleared = dryRunState.loadState('coinbase', pair).position;
    assert.deepEqual(cleared.announcedCaps, []);
    assert.equal(cleared.drawdownGuard.cycleBuysLimitReachedAt, null);
    eng = makeEngine(pair);
    await eng.start();
    eng._getPositionState().cycleBuys = 2;
    await evaluate(eng);
    assert.equal(eng._getPositionState().cycleBuys, 2, 'a fresh episode does not inherit an expired clock');
    assert.equal(events('cap_reached').length, 3, 'operator reset ends the cap episode too');
    await eng.stop();
  });

  it('emits hourly summaries on wall time when replaced every 59 minutes', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const began = now;
    const pair = '__restart_hourly__';
    const events = eventsFor(t, pair);
    let eng = makeEngine(pair);
    await eng.start();
    // Drive each minute's real metrics tick; replacements never live an hour.
    for (let minute = 1; minute <= 180; minute++) {
      now = began + minute * 60 * 1000;
      await eng._test.updateMetrics();
      if (minute % 59 === 0) {
        await eng.stop();
        eng = makeEngine(pair);
        await eng.start();
      }
      assert.equal(events('regime_hourly').length, Math.floor(minute / 60), `minute ${minute}`);
    }
    await eng.stop();
  });

  it('restores live risk before WebSocket connection and preserves empty-fund cadence on every live save', async (t) => {
    const now = 10_000_000;
    t.mock.method(Date, 'now', () => now);
    const pair = '__restart_live__';
    const clock = now - 59 * 60 * 1000;
    saveFundRegimeState('coinbase', pair, { position: {
      drawdownGuard: { cycleBuysLimitReachedAt: clock },
      announcedCaps: ['cycle_buys_limit_reached', 'invalid'], lastHourlySummaryEventAt: clock,
    } });
    const eng = makeEngine(pair, false);
    onConnect = () => {
      const saved = loadFundRegimeState('coinbase', pair).position;
      assert.equal(saved.drawdownGuard.cycleBuysLimitReachedAt, clock);
      assert.equal(saved.lastHourlySummaryEventAt, clock);
      assert.deepEqual(saved.announcedCaps, ['cycle_buys_limit_reached']);
    };
    try { assert.equal((await eng.start()).success, true); } finally { onConnect = () => {}; }
    // Clear and save a completed episode before any metrics tick.
    eng._test.checkAllCaps();
    eng._test.saveLiveStateGuarded('test');
    assert.equal(loadFundRegimeState('coinbase', pair).position.drawdownGuard.cycleBuysLimitReachedAt, null);
    await eng.stop();
    assert.equal(loadFundRegimeState('coinbase', pair).position.drawdownGuard.cycleBuysLimitReachedAt, null);
  });

  it('loads legacy live position state and gives invalid new fields legacy defaults', async (t) => {
    const pair = '__restart_legacy__';
    const now = 10_000_000;
    t.mock.method(Date, 'now', () => now);
    saveFundRegimeState('coinbase', pair, { position: {
      cyclesCompleted: 7, lastHourlySummaryEventAt: 'invalid', announcedCaps: 'invalid',
    } });
    const eng = makeEngine(pair, false);
    assert.equal((await eng.start()).success, true);
    await eng.stop();
    const pos = JSON.parse(fs.readFileSync(path.join(isolated.fundDir('coinbase', pair), 'regime-state.json'))).position;
    assert.equal(pos.cyclesCompleted, 7);
    assert.equal(pos.lastHourlySummaryEventAt, now);
    assert.deepEqual(pos.announcedCaps, []);
    assert.equal(pos.drawdownGuard.cycleBuysLimitReachedAt, null);
  });
});

describe('restored TREND engine protection (#1298)', () => {
  it('does not emit a regime change or place entries during restart warmup', async (t) => {
    const pair = '__restart_trend__';
    saveFundRegimeState('coinbase', pair, { position: { cyclesCompleted: 1 }, regime: {
      mode: 'TREND', transitionCount: 7, trendConfirmationCount: 5, trendDirection: 'down',
    } });
    const changes = [];
    const listener = event => { if (event.type === 'regime_change') changes.push(event); };
    tradeEvents.on('trade', listener);
    t.after(() => tradeEvents.off('trade', listener));
    let placements = 0;
    const eng = makeEngine(pair, false, {
      getAccountBalance: async () => ({ available: 1000, hold: 0 }),
    });
    Object.assign(eng._getConfig(), { trendConfirmationPeriods: 5, trendScale: 0 });
    assert.equal((await eng.start()).success, true);
    t.mock.method(eng._test.getOrderExecutor(), 'placeEntryBid', async () => {
      placements++;
      return { success: false };
    });
    t.mock.method(eng._test.getOrderExecutor(), 'placeLadderOrders', async () => {
      placements++;
      return { placed: [], failed: [] };
    });
    await eng._test.updateMetrics(); // the no-ticker classification must be inert
    assert.equal(eng._getMarketState().lastPrice, 0);
    assert.equal(eng.getState().regime.mode, 'TREND');
    for (let reading = 0; reading < 7; reading++) {
      Object.assign(eng._getMarketState(), {
        lastPrice: 100, bid: 99.99, ask: 100.01, vwap: 103, atr1m: 1,
        realizedVol: 0.5, volBaseline: 0.5,
      });
      await eng._test.updateMetrics();
      Object.assign(eng._test.getHealth(), { mode: 'ACTIVE', reason: null });
      await eng._test.evaluateEntryTrigger();
      await eng._test.evaluateLadderEntry();
      assert.equal(eng.getState().regime.mode, 'TREND', `reading ${reading + 1}`);
      assert.equal(placements, 0);
      assert.equal(eng.getState().orders.total, 0);
    }
    assert.equal(changes.length, 0);
    assert.equal(eng.getState().regime.transitionCount, 7);
    // Positive control: the same funded, healthy fixture reaches placement
    // when the regime guard is deliberately relaxed. No exchange I/O occurs.
    eng.forceRegime('CAUTION', 'test positive control');
    await eng._test.evaluateEntryTrigger();
    assert.equal(placements, 1);
    await eng.stop();
  });
});
