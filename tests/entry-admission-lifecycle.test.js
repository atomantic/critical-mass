// @ts-check
//
// Issue #1009: an entry evaluation that is still awaiting its account-balance
// preflight when the engine stops, or the fund starts draining, must never
// submit afterwards — not after stop() resolves, not after a restart, and not
// while the fund is DRAINING. Runs the real engine factory in dry-run mode on
// disposable fund storage with a deferred balance response; no network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-entry-admission');
const configUtils = require('../src/config-utils');
const oldUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const feedModule = require('../src/websocket-feed');
const oldFeed = feedModule.createWebSocketFeed;
feedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });
const dryRunState = require('../src/dry-run-state');
const oldForceSave = dryRunState.forceSave;
dryRunState.forceSave = () => {};
const { createRegimeEngine } = require('../src/regime-engine');
const { LIFECYCLE } = require('../src/state-tracker');

const engines = [];
after(async () => {
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = oldUpdate;
  feedModule.createWebSocketFeed = oldFeed;
  dryRunState.forceSave = oldForceSave;
  isolated.cleanup();
});

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Adapter whose balance reads are held until the test releases them. */
const makeAdapter = () => {
  const held = [];
  return {
    held,
    getProductDetails: async () => null,
    loadCredentials: () => ({}),
    getCandles: async () => { throw new Error('offline (test)'); },
    getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    getOrderFills: async () => [],
    getAccountBalance: () => new Promise((resolve) => { held.push(resolve); }),
    release: () => { for (const resolve of held.splice(0)) resolve({ available: 1_000_000 }); },
  };
};

const makeEngine = async (pair, entryMode) => {
  const eng = createRegimeEngine('coinbase', pair, { dryRun: true, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  const adapter = makeAdapter();
  eng._test.setAdapter(adapter);
  assert.equal((await eng.start()).success, true);

  const config = eng._getConfig();
  Object.assign(config, {
    entryMode,
    ladderAutoSwitch: false,
    maxUsdcDeployed: 1000,
    depositedCapital: 1000,
    baseSizeUsdc: 50,
    maxAssetExposure: 0,
    maxCycleBuys: 100,
    minIntervalMs: 0,
    maxIntervalMs: 0, // timer trigger always fires
    maxOpenOrders: 50,
  });
  const m = eng._getMarketState();
  Object.assign(m, { lastPrice: 100, bid: 99.99, ask: 100.01, atr1m: 0.5, volBaseline: 0.01, realizedVol: 0.01 });
  return { eng, adapter };
};

/**
 * Begin an entry evaluation and hold it inside the balance preflight. The
 * health monitor is forced ACTIVE (no websocket in the test) so entries are
 * blocked only by what the test does.
 */
const beginHeldEntry = async (eng, adapter) => {
  const health = eng._test.getHealth();
  health.mode = 'ACTIVE';
  health.reason = null;
  const evaluation = eng._test.evaluateEntryTrigger();
  for (let i = 0; i < 50 && adapter.held.length === 0; i++) await tick();
  assert.equal(adapter.held.length, 1, 'evaluation must be parked on the balance preflight');
  return evaluation;
};

const submitted = (eng) => {
  const counts = eng._test.getOrderExecutor().getPendingCounts();
  return counts.entries + counts.ladderEntries;
};

for (const mode of ['reactive', 'ladder']) {
  describe(`${mode} entry admission across stop/close (issue #1009)`, () => {
    it('places entries normally while the fund is running and ACTIVE', async () => {
      const { eng, adapter } = await makeEngine(`__test1009_${mode}_ok__`, mode);
      if (mode === 'reactive') {
        eng._getConfig().maxIntervalMs = 600000;
        eng._getMarketState().atr1m = 0.05;
      }
      const evaluation = beginHeldEntry(eng, adapter);
      await tick();
      adapter.release();
      await evaluation;
      assert.ok(submitted(eng) > 0, 'control: an admitted evaluation submits');
      if (mode === 'reactive') {
        const entry = eng._test.getOrderExecutor().getDryRunState().pendingOrders.find(order => order.type === 'entry');
        assert.ok(entry?.staleMs > 0, 'the resting entry has its adaptive timeout');
        const status = eng.getStatus();
        assert.ok(entry.staleMs > status.effectiveStaleMs, 'the adaptive timeout exceeds the global fallback');
        assert.equal(status.pendingEntryStaleMs, entry.staleMs);
      }
    });

    it('stop() during the balance preflight results in zero submissions', async () => {
      const { eng, adapter } = await makeEngine(`__test1009_${mode}_stop__`, mode);
      const evaluation = beginHeldEntry(eng, adapter);
      await tick();
      await eng.stop();
      adapter.release();
      await evaluation;
      assert.equal(submitted(eng), 0);
    });

    it('a restart cannot revive an evaluation captured before stop()', async () => {
      const { eng, adapter } = await makeEngine(`__test1009_${mode}_restart__`, mode);
      const evaluation = beginHeldEntry(eng, adapter);
      await tick();
      await eng.stop();
      assert.equal((await eng.start()).success, true);
      adapter.release();
      await evaluation;
      assert.equal(submitted(eng), 0);
    });

    it('close() during the balance preflight stays DRAINING with zero submissions', async () => {
      const { eng, adapter } = await makeEngine(`__test1009_${mode}_close__`, mode);
      const evaluation = beginHeldEntry(eng, adapter);
      await tick();
      assert.equal(eng.close('test').success, true);
      await tick(); // let close's entry cancellation settle
      adapter.release();
      await evaluation;
      assert.equal(submitted(eng), 0);
      assert.equal(eng._getPositionState().lifecycle, LIFECYCLE.DRAINING);
    });
  });
}

describe('entry admission is per engine (issue #1009)', () => {
  it('stopping one fund does not fence another fund\'s pending entry', async () => {
    const a = await makeEngine('__test1009_fund_a__', 'reactive');
    const b = await makeEngine('__test1009_fund_b__', 'reactive');
    const evalA = beginHeldEntry(a.eng, a.adapter);
    const evalB = beginHeldEntry(b.eng, b.adapter);
    await tick();
    await a.eng.stop();
    a.adapter.release();
    b.adapter.release();
    await Promise.all([evalA, evalB]);
    assert.equal(submitted(a.eng), 0);
    assert.equal(submitted(b.eng), 1);
  });
});

describe('manual ladder rebuild respects fund lifecycle (issue #1009)', () => {
  it('refuses to place new rungs while the fund is draining', async () => {
    const { eng } = await makeEngine('__test1009_rebuild__', 'ladder');
    eng.close('test');
    const result = await eng.rebuildLadder();
    assert.equal(result.success, false);
    assert.match(result.message, /draining/);
    assert.equal(submitted(eng), 0);
  });
});
