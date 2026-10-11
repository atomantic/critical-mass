// @ts-check
//
// Issue #1028: "Cancel Entries on Flash" (regime config cancelEntriesOnFlash,
// default on) was never wired up — a detected flash move published its event
// and forced CAUTION but left resting reactive bids live. These tests drive the
// REAL ticker handler and tail-event monitor of a dry-run engine with synthetic
// prices (ATR 1, a >3x ATR jump) and assert the reactive cancel sweep runs,
// coalesces, fences new reactive placements, spares ladder rungs, survives a
// rejected cancel, and is awaited by stop(). Offline: mock adapter, stubbed
// websocket feed, disposable data root; no persisted configuration is written.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-flash-entry-cancel');
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
const { tradeEvents } = require('../src/trade-events');

let seq = 0;
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

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve: /** @type {(v?: any) => void} */ (resolve) };
};

/** Adapter whose balance reads resolve at once unless `hold` is set. */
const makeAdapter = () => {
  const held = [];
  const adapter = {
    hold: false,
    held,
    getProductDetails: async () => null,
    loadCredentials: () => ({}),
    getCandles: async () => { throw new Error('offline (test)'); },
    getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    getOrderFills: async () => [],
    getAccountBalance: () => (adapter.hold
      ? new Promise((resolve) => { held.push(resolve); })
      : Promise.resolve({ available: 1_000_000 })),
    release: () => { for (const resolve of held.splice(0)) resolve({ available: 1_000_000 }); },
  };
  return adapter;
};

const makeEngine = async ({ entryMode = 'reactive', cancelEntriesOnFlash = true } = {}) => {
  const pair = `__test1028${String.fromCharCode(97 + seq++)}__`;
  const eng = createRegimeEngine('coinbase', pair, { dryRun: true, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  const adapter = makeAdapter();
  eng._test.setAdapter(adapter);
  assert.equal((await eng.start()).success, true);
  eng._test.setFlashEntryWaitMs(2000);

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
    maxSpreadBps: 1000,
    flashMoveMult: 3,
    cancelEntriesOnFlash,
  });
  const m = eng._getMarketState();
  Object.assign(m, { lastPrice: 100, bid: 99.99, ask: 100.01, atr1m: 1, volBaseline: 0.01, realizedVol: 0.01 });
  return { eng, adapter };
};

/** Health forced ACTIVE: no websocket runs in the test. */
const forceActive = (eng) => {
  const health = eng._test.getHealth();
  health.mode = 'ACTIVE';
  health.reason = null;
};

const evaluateEntry = async (eng) => {
  forceActive(eng);
  await eng._test.evaluateEntryTrigger();
};

// Upward moves only: a dry-run bid fills on a tick at or below its price, and
// a downward flash would fill the resting bid before the sweep could see it.
const ticker = (eng, price) => {
  forceActive(eng);
  eng._test.handleTicker({ price, bid: price - 0.01, ask: price + 0.01 });
};

const pending = (eng) => eng._test.getOrderExecutor().getPendingCounts();

/** Count cancelAllEntries calls while still running the real sweep. */
const spyCancel = (eng, { gate = null, failWith = null } = {}) => {
  const exec = eng._test.getOrderExecutor();
  const real = exec.cancelAllEntries;
  const spy = { calls: 0, settled: false };
  exec.cancelAllEntries = async () => {
    spy.calls++;
    if (failWith) throw failWith;
    const cancelled = await real();
    if (gate) await gate.promise;
    spy.settled = true;
    return cancelled;
  };
  return spy;
};

const captureFlashEvents = (t) => {
  const events = [];
  const listener = (event) => { if (event.type === 'flash_move' && event.exchange === 'coinbase') events.push(event); };
  tradeEvents.on('trade', listener);
  t.after(() => tradeEvents.removeListener('trade', listener));
  return events;
};

describe('flash move cancels resting reactive entries (issue #1028)', () => {
  it('enabled: a detected flash cancels the resting reactive bid, keeping the event and CAUTION transition', async (t) => {
    const { eng } = await makeEngine();
    const events = captureFlashEvents(t);
    await evaluateEntry(eng);
    assert.equal(pending(eng).entries, 1, 'control: a reactive bid is resting');
    const spy = spyCancel(eng);

    ticker(eng, 100); // seeds the flash anchor
    assert.equal(eng._test.getFlashCancelSweep(), null, 'a quiet tick does not sweep');
    ticker(eng, 110); // 10x ATR
    const sweep = eng._test.getFlashCancelSweep();
    assert.ok(sweep, 'the fence is raised synchronously with the flash');
    await sweep;

    assert.equal(spy.calls, 1);
    assert.equal(pending(eng).entries, 0, 'the resting reactive bid was cancelled');
    assert.equal(eng._test.getFlashCancelSweep(), null, 'the fence lifts once the sweep settles');
    assert.ok(events.length >= 1, 'flash_move event still published');
    assert.equal(eng.getState().regime.mode, 'CAUTION', 'forced CAUTION transition retained');
  });

  it('disabled: the same flash leaves the reactive bid resting and never sweeps', async () => {
    const { eng } = await makeEngine({ cancelEntriesOnFlash: false });
    await evaluateEntry(eng);
    const spy = spyCancel(eng);

    ticker(eng, 100);
    ticker(eng, 110);
    assert.equal(eng._test.getFlashCancelSweep(), null);
    await tick();

    assert.equal(spy.calls, 0);
    assert.equal(pending(eng).entries, 1);
    assert.equal(eng.getState().regime.mode, 'CAUTION', 'the flash itself is still handled');
  });

  it('coalesces repeated flashes onto one sweep and fences new reactive placements until it settles', async () => {
    const { eng } = await makeEngine();
    await evaluateEntry(eng);
    const gate = deferred();
    const spy = spyCancel(eng, { gate });

    ticker(eng, 100);
    ticker(eng, 110);
    const sweep = eng._test.getFlashCancelSweep();
    for (let i = 0; i < 50 && pending(eng).entries > 0; i++) await tick();
    assert.equal(pending(eng).entries, 0, 'the bid is already pulled; the sweep is still in flight');

    // Another flash, plus direct evaluations, while the sweep is in flight.
    ticker(eng, 120);
    assert.equal(eng._test.getFlashCancelSweep(), sweep, 'overlapping flashes join the in-flight sweep');
    await evaluateEntry(eng);
    await evaluateEntry(eng);
    await tick();
    assert.equal(spy.calls, 1, 'no concurrent sweep');
    assert.equal(pending(eng).entries, 0, 'no reactive bid slipped past the fence');

    gate.resolve();
    await sweep;
    assert.equal(spy.calls, 1);
    await evaluateEntry(eng);
    assert.equal(pending(eng).entries, 1, 'reactive entries resume once the sweep settles');
  });

  it('an evaluation already in its balance preflight cannot submit after the flash, and the sweep waits for it', async () => {
    const { eng, adapter } = await makeEngine();
    const spy = spyCancel(eng);
    adapter.hold = true;

    ticker(eng, 100); // seeds the anchor; its evaluation parks on the balance read
    for (let i = 0; i < 50 && adapter.held.length === 0; i++) await tick();
    assert.equal(adapter.held.length, 1, 'evaluation parked inside the entry lock');

    ticker(eng, 110);
    const sweep = eng._test.getFlashCancelSweep();
    assert.ok(sweep);
    await tick();
    await tick();
    assert.equal(spy.calls, 0, 'the sweep waits for the in-flight placement to settle');

    adapter.hold = false;
    adapter.release();
    await sweep;
    assert.equal(spy.calls, 1);
    assert.equal(pending(eng).entries, 0, 'the pre-flash evaluation was refused admission');
  });

  for (const stopMidFlight of [false, true]) {
    it(`a dispatched placement that outlives the wait bound is swept once it lands${stopMidFlight ? ', even after stop()' : ''}`, async () => {
      const { eng } = await makeEngine();
      eng._test.setFillDrainMs(50);
      eng._test.setFlashEntryWaitMs(20);
      const exec = eng._test.getOrderExecutor();
      // Model a bid already on the exchange whose response is slow: once the
      // gate opens it lands regardless of admission (no isAdmitted forwarded).
      const realPlace = exec.placeEntryBid;
      const response = deferred();
      let dispatched = false;
      exec.placeEntryBid = async (...args) => {
        dispatched = true;
        await response.promise;
        return realPlace(...args.slice(0, 6));
      };
      const spy = spyCancel(eng);

      ticker(eng, 100); // seeds the anchor; its evaluation dispatches and waits
      for (let i = 0; i < 50 && !dispatched; i++) await tick();
      assert.equal(dispatched, true);

      ticker(eng, 110);
      const sweep = eng._test.getFlashCancelSweep();
      for (let i = 0; i < 50 && spy.calls === 0; i++) await tick();
      assert.equal(spy.calls, 1, 'the bounded wait expired and swept without the slow bid');
      assert.equal(eng._test.getFlashCancelSweep(), sweep, 'the fence stays up while that bid is in flight');

      // stop()'s bounded wait gives up on the sweep; the sweep must not give up on the bid.
      if (stopMidFlight) await eng.stop();
      response.resolve();
      await sweep;
      assert.ok(spy.calls >= 2, 'a follow-up sweep ran after the bid landed (one per expired wait while it was in flight)');
      assert.equal(pending(eng).entries, 0, 'the late bid was cancelled');
      assert.equal(eng._test.getFlashCancelSweep(), null);
    });
  }

  it('leaves ladder rungs alone', async () => {
    const { eng } = await makeEngine({ entryMode: 'ladder' });
    await evaluateEntry(eng);
    const before = pending(eng).ladderEntries;
    assert.ok(before > 0, 'control: a ladder is resting');
    const spy = spyCancel(eng);

    ticker(eng, 100);
    ticker(eng, 110);
    await eng._test.getFlashCancelSweep();

    assert.equal(spy.calls, 1, 'the reactive sweep ran');
    assert.equal(pending(eng).ladderEntries, before, 'ladder rungs are exempt');
  });

  it('a rejected cancel is logged, not leaked as an unhandled rejection, and the fence still lifts', async (t) => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.removeListener('unhandledRejection', onUnhandled));

    const { eng } = await makeEngine();
    const spy = spyCancel(eng, { failWith: new Error('exchange 503') });
    ticker(eng, 100);
    ticker(eng, 110);
    await eng._test.getFlashCancelSweep();
    await tick();

    assert.equal(spy.calls, 1);
    assert.equal(eng._test.getFlashCancelSweep(), null);
    assert.deepEqual(unhandled, []);
  });

  it('stop() waits for the in-flight sweep before saving state', async () => {
    const { eng } = await makeEngine();
    await evaluateEntry(eng);
    const gate = deferred();
    const spy = spyCancel(eng, { gate });

    ticker(eng, 100);
    ticker(eng, 110);
    let stopped = false;
    const stopping = eng.stop().then(() => { stopped = true; });
    await tick();
    await tick();
    assert.equal(stopped, false, 'stop() is still waiting on the sweep');

    gate.resolve();
    await stopping;
    assert.equal(spy.settled, true, 'the sweep finished before stop() resolved');
  });
});
