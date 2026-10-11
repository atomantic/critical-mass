// @ts-check
//
// Issue #1030: the Notifications page advertises SAFE Mode Activated, Active
// Mode Restored, Cap Reached, Cycle Reset, Spread Pause and Hourly Summary,
// but no production path published those event types. These tests drive the
// REAL engine transitions (health monitor, tail-event monitor, risk caps,
// cycle turnover, metrics tick) and assert each reaches the trade bus once
// per transition with the fund's pair — and that the notifier applies its
// event toggles and quiet-hour/critical-bypass rules to them.
//
// Offline: dry-run engine, mock adapter, stubbed fetch. Disk: a disposable
// data root, and the notifier config is served from a stub (no config writes).
const { describe, it, after, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createIsolatedDataDir } = require('./test-data-dir');
const isolatedData = createIsolatedDataDir('cm-regime-notification-events-test');

// Notifier config comes from this stub, installed BEFORE notifier.js
// destructures getNotificationConfig at load.
const configUtils = require('../src/config-utils');
let notificationConfig = null;
const originalGetNotificationConfig = configUtils.getNotificationConfig;
configUtils.getNotificationConfig = () => notificationConfig || originalGetNotificationConfig();

const { createRegimeEngine } = require('../src/regime-engine');
const { tradeEvents } = require('../src/trade-events');
const { createNotifier } = require('../src/notifier');

const NOTIFICATION_TYPES = new Set(['safe_mode', 'active_mode', 'cap_reached', 'cycle_reset', 'spread_pause', 'regime_hourly']);

let pairSeq = 0;
const engines = [];
after(() => {
  for (const eng of engines) eng._test.clearTimers();
  configUtils.getNotificationConfig = originalGetNotificationConfig;
  isolatedData.cleanup();
});

const makeEngine = () => {
  const pair = `__test1030${String.fromCharCode(97 + pairSeq++)}__`;
  const eng = createRegimeEngine('coinbase', pair, { dryRun: true, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  const config = eng._getConfig();
  config.maxUsdcDeployed = 1000;
  config.maxAssetExposure = 0;
  config.maxCycleBuys = 100;
  config.cycleResetHours = 0;
  config.minIntervalMs = 0;
  config.maxIntervalMs = 0; // timer trigger always fires
  config.entryMode = 'reactive';
  config.ladderAutoSwitch = false;
  eng._test.setRunning(true);
  eng._test.setAdapter({
    getCandles: async () => { throw new Error('offline (test)'); },
    getAccountBalance: async () => ({ available: 1_000_000 }),
    getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    getOrderFills: async () => [],
    getPositions: async () => [],
  });
  const m = eng._getMarketState();
  m.lastPrice = 100;
  m.bid = 99.99;
  m.ask = 100.01;
  return { eng, pair, config };
};

/** Capture this fund's notification-type events from the process trade bus. */
const captureEvents = (t, pair) => {
  const events = [];
  const listener = (event) => {
    if (NOTIFICATION_TYPES.has(event.type) && event.data?.pair === pair) events.push(event);
  };
  tradeEvents.on('trade', listener);
  t.after(() => tradeEvents.removeListener('trade', listener));
  return events;
};

const ofType = (events, type) => events.filter(e => e.type === type);

/** Entry evaluation with health forced ACTIVE (no websocket in the test). */
const evaluateEntry = async (eng) => {
  const health = eng._test.getHealth();
  health.mode = 'ACTIVE';
  health.reason = null;
  await eng._test.evaluateEntryTrigger();
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('regime engine publishes advertised notification events (issue #1030)', () => {
  it('publishes SAFE before a stalled cancel resolves, and SAFE/ACTIVE once per transition', async (t) => {
    const { eng, pair } = makeEngine();
    const events = captureEvents(t, pair);
    const exec = eng._test.getOrderExecutor();
    const cancel = deferred();
    exec.cancelAllEntries = () => cancel.promise;

    eng._test.healthMonitor.enterSafeMode('ws_disconnected');
    // Synchronous: the cancel sweep has not even been allowed to run yet.
    assert.deepEqual(ofType(events, 'safe_mode').map(e => [e.exchange, e.data.reason]), [['coinbase', 'ws_disconnected']]);

    eng._test.healthMonitor.enterSafeMode('ws_disconnected');
    assert.equal(ofType(events, 'safe_mode').length, 1, 'already SAFE: no repeat alert');

    eng._test.healthMonitor.exitSafeMode();
    eng._test.healthMonitor.exitSafeMode();
    assert.equal(ofType(events, 'active_mode').length, 1, 'one ACTIVE alert per real recovery');
    cancel.resolve({ cancelled: 0 });
  });

  it('still publishes SAFE when the cancel sweep rejects, without an unhandled rejection', async (t) => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.removeListener('unhandledRejection', onUnhandled));

    const healthChanges = [];
    const pair = `__test1030${String.fromCharCode(97 + pairSeq++)}__`;
    const eng = createRegimeEngine('coinbase', pair, { dryRun: true, productId: 'BTC-USDC' }, {
      onHealthChange: (mode) => healthChanges.push(mode),
    });
    engines.push(eng);
    const events = captureEvents(t, pair);
    eng._test.getOrderExecutor().cancelAllEntries = async () => { throw new Error('exchange 503'); };

    eng._test.healthMonitor.enterSafeMode('rest_errors');
    assert.equal(ofType(events, 'safe_mode').length, 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(healthChanges, ['SAFE'], 'the dashboard health callback still fires');
    assert.deepEqual(unhandled, []);
  });

  it('publishes spread_pause once per pause, not once per breaching ticker', async (t) => {
    const { eng, pair, config } = makeEngine();
    const events = captureEvents(t, pair);
    config.maxSpreadBps = 10;
    const wide = { price: 100, bid: 99, ask: 101 }; // 200 bps
    eng._test.handleTicker(wide);
    eng._test.handleTicker(wide);
    eng._test.handleTicker(wide);
    const spread = ofType(events, 'spread_pause');
    assert.equal(spread.length, 1);
    assert.equal(spread[0].data.threshold, 10);
    assert.ok(spread[0].data.spreadBps > 10);
  });

  it('publishes cap_reached once per cap episode and again after the cap clears', async (t) => {
    const { eng, pair, config } = makeEngine();
    const events = captureEvents(t, pair);
    const pos = eng._getPositionState();
    config.maxCycleBuys = 2;

    pos.cycleBuys = 2;
    await evaluateEntry(eng);
    await evaluateEntry(eng);
    await evaluateEntry(eng);
    let caps = ofType(events, 'cap_reached');
    assert.equal(caps.length, 1, 'repeated blocked checks do not flood');
    assert.deepEqual([caps[0].data.capType, caps[0].data.current, caps[0].data.limit], ['Cycle buys', 2, 2]);

    // Leave the cap: an allowed entry check clears the episode.
    pos.cycleBuys = 0;
    await evaluateEntry(eng);
    const exec = eng._test.getOrderExecutor();
    await exec.cancelAllEntries();
    pos.pendingEntryOrders = [];

    pos.cycleBuys = 2;
    await evaluateEntry(eng);
    caps = ofType(events, 'cap_reached');
    assert.equal(caps.length, 2, 're-entering the cap alerts again');
  });

  it('publishes cycle_reset once for a committed turnover and never for a stale queued reset', async (t) => {
    const { eng, pair } = makeEngine();
    const events = captureEvents(t, pair);
    const sweeps = [deferred(), deferred()];
    let n = 0;
    const exec = eng._test.getOrderExecutor();
    exec.cancelAllLadderOrders = async () => {
      await sweeps[n++].promise;
      return { cancelled: 0, partialFills: 0 };
    };
    const pos = eng._getPositionState();
    pos.ladderActive = true;
    pos.cyclesCompleted = 4;

    // Two resets that both timed out on the ladder lock: only one turns over.
    const a = eng._test.resetCycleUnserialised();
    const b = eng._test.resetCycleUnserialised();
    sweeps[0].resolve();
    assert.equal((await a).turnedOver, true);
    sweeps[1].resolve();
    assert.equal((await b).turnedOver, false);

    const resets = ofType(events, 'cycle_reset');
    assert.equal(resets.length, 1);
    assert.equal(resets[0].data.cyclesCompleted, 4);
    assert.equal(resets[0].data.resetKind, 'close');
    assert.equal(resets[0].data.cycleId, pos.activeCycleId);
  });

  it('publishes regime_hourly at most once per hour of metrics ticks', async (t) => {
    const { eng, pair } = makeEngine();
    const events = captureEvents(t, pair);
    const realNow = Date.now();
    let now = realNow;
    mock.method(Date, 'now', () => now);
    t.after(() => mock.restoreAll());

    await eng._test.updateMetrics();
    assert.equal(ofType(events, 'regime_hourly').length, 0, 'no summary before the first hour elapses');
    now = realNow + 60 * 60 * 1000;
    await eng._test.updateMetrics();
    now += 60 * 1000;
    await eng._test.updateMetrics();
    const hourly = ofType(events, 'regime_hourly');
    assert.equal(hourly.length, 1);
    assert.equal(typeof hourly[0].data.regime, 'string');
  });
});

describe('notifier delivers the real producer events (issue #1030)', () => {
  it('applies event toggles and quiet-hour critical bypass to engine transitions', async (t) => {
    const { eng, pair } = makeEngine();
    eng._test.getOrderExecutor().cancelAllEntries = async () => ({ cancelled: 0 });
    const telegram = [];
    mock.method(global, 'fetch', async (url, options) => {
      telegram.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    });
    t.after(() => mock.restoreAll());

    const notify = async (events, quietAllDay, run) => {
      notificationConfig = {
        ...originalGetNotificationConfig(),
        enabled: true,
        telegram: { botToken: 'FAKE:TEST-TOKEN', chatId: 'test-chat' },
        events: { ...originalGetNotificationConfig().events, ...events },
        rateLimitMs: 60000,
        quietHours: { enabled: quietAllDay, start: 0, end: 24 },
      };
      const notifier = createNotifier();
      notifier.start();
      try {
        run();
        await notifier.flush();
      } finally {
        await notifier.stop();
        notificationConfig = null;
      }
    };

    // Explicit opt-out wins even for a critical event.
    await notify({ safe_mode: false }, false, () => eng._test.healthMonitor.enterSafeMode('ws_disconnected'));
    assert.equal(telegram.length, 0, 'safe_mode opt-out suppresses delivery');
    eng._test.healthMonitor.exitSafeMode();

    // Quiet hours: critical SAFE bypasses, informational ACTIVE is held back.
    await notify({}, true, () => {
      eng._test.healthMonitor.enterSafeMode('ws_disconnected');
      eng._test.healthMonitor.exitSafeMode();
    });
    assert.equal(telegram.length, 1);
    assert.match(telegram[0], /SAFE mode: ws\\_disconnected/);
    assert.ok(telegram[0].includes(pair.replace(/_/g, '\\_')), 'alert names the fund pair');
    assert.doesNotMatch(telegram[0], /ACTIVE/);

    // Outside quiet hours the recovery is delivered.
    await notify({}, false, () => {
      eng._test.healthMonitor.enterSafeMode('ws_disconnected');
      eng._test.healthMonitor.exitSafeMode();
    });
    assert.equal(telegram.length, 2);
    assert.match(telegram[1], /SAFE mode/);
    assert.match(telegram[1], /Returned to ACTIVE mode/);
  });
});
