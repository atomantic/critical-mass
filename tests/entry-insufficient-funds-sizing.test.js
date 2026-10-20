// @ts-check
//
// Pins executeEntry's insufficient-funds cooldown, entry sizing and momentum
// offset selection (#1233) through the real engine factory in dry-run mode on
// disposable fund storage. placeEntryBid is stubbed; no network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-entry-sizing');
const configUtils = require('../src/config-utils');
const oldUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const feedModule = require('../src/websocket-feed');
const oldFeed = feedModule.createWebSocketFeed;
feedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });
const dryRunState = require('../src/dry-run-state');
const oldForceSave = dryRunState.forceSave;
dryRunState.forceSave = () => {};
// Capture the engine's context-logger output (regime-engine destructures this at load).
const loggerModule = require('../src/logger');
const oldCreateContextLogger = loggerModule.createContextLogger;
const logLines = [];
loggerModule.createContextLogger = (ctx) => {
  const base = oldCreateContextLogger(ctx);
  const tap = (level) => (message, data) => { logLines.push(`${level} ${message}`); base[level](message, data); };
  return { info: tap('info'), warn: tap('warn'), error: tap('error') };
};
const { createRegimeEngine } = require('../src/regime-engine');

const engines = [];
after(async () => {
  for (const eng of engines) {
    await eng.stop().catch(() => {});
    eng._test.clearTimers();
  }
  configUtils.updateRegimeConfig = oldUpdate;
  feedModule.createWebSocketFeed = oldFeed;
  dryRunState.forceSave = oldForceSave;
  loggerModule.createContextLogger = oldCreateContextLogger;
  isolated.cleanup();
});

let seq = 0;
const makeEngine = async ({ balance = 1_000_000, place, config: overrides = {}, momentum } = {}) => {
  const eng = createRegimeEngine('coinbase', `__test1233_${seq++}__`, { dryRun: true, productId: 'BTC-USDC' }, {});
  engines.push(eng);
  const calls = [];
  eng._test.setAdapter({
    getProductDetails: async () => null,
    loadCredentials: () => ({}),
    getCandles: async () => { throw new Error('offline (test)'); },
    getOrder: async () => ({ filledSize: 0, status: 'OPEN' }),
    getOrderFills: async () => [],
    getAccountBalance: async () => ({ available: balance }),
  });
  assert.equal((await eng.start()).success, true);
  const executor = eng._test.getOrderExecutor();
  executor.placeEntryBid = async (...args) => {
    calls.push(args);
    return place ? place(...args) : { success: false, errorMessage: 'other' };
  };
  Object.assign(eng._getConfig(), {
    entryMode: 'reactive',
    ladderAutoSwitch: false,
    maxUsdcDeployed: 1000,
    depositedCapital: 1000,
    baseSizeUsdc: 50,
    maxAssetExposure: 0,
    maxCycleBuys: 100,
    minIntervalMs: 0,
    maxIntervalMs: 0,
    maxOpenOrders: 50,
    insufficientFundsCooldownMs: 60000,
    ...overrides,
  });
  Object.assign(eng._getMarketState(), {
    lastPrice: 100, bid: 99.99, ask: 100.01, atr1m: 0.5, volBaseline: 0.01, realizedVol: 0.01,
    ...(momentum ? { momentum: { direction: momentum } } : {}),
  });
  const health = eng._test.getHealth();
  health.mode = 'ACTIVE';
  health.reason = null;
  return { eng, calls };
};

const pauseLines = () => logLines.filter((l) => l.includes('pausing entries'));

describe('executeEntry insufficient-funds cooldown (#1233)', () => {
  it('a thrown insufficient_available_balance error sets the cooldown without throwing', async () => {
    const { eng, calls } = await makeEngine({ place: () => { throw new Error('INSUFFICIENT_AVAILABLE_BALANCE'); } });
    logLines.length = 0;
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 1);
    assert.equal(pauseLines().length, 1);
    assert.match(pauseLines()[0], /Insufficient funds — pausing entries for 60s/);
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 1, 'next tick is skipped by the cooldown');
  });

  it('a 406 status error also arms the cooldown', async () => {
    const { eng, calls } = await makeEngine({ place: () => { throw Object.assign(new Error('nope'), { status: 406 }); } });
    await eng._test.evaluateEntryTrigger();
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 1);
  });

  it('a {success:false, INSUFFICIENT_FUND} result arms the cooldown', async () => {
    const { eng, calls } = await makeEngine({ place: () => ({ success: false, errorMessage: 'INSUFFICIENT_FUND' }) });
    logLines.length = 0;
    await eng._test.evaluateEntryTrigger();
    assert.equal(pauseLines().length, 1);
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 1);
  });

  it('other thrown errors propagate and arm no cooldown', async () => {
    const { eng, calls } = await makeEngine({ place: () => { throw new Error('boom'); } });
    await assert.rejects(eng._test.evaluateEntryTrigger(), /boom/);
    await assert.rejects(eng._test.evaluateEntryTrigger(), /boom/);
    assert.equal(calls.length, 2);
  });

  it('a balance below the min order arms the cooldown and logs once across ticks', async () => {
    const { eng, calls } = await makeEngine({ balance: 0.5, config: { insufficientFundsCooldownMs: 1 } });
    logLines.length = 0;
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 0);
    assert.equal(pauseLines().length, 1);
    assert.match(pauseLines()[0], /below min order \$\d+ — pausing entries for 0.001s/);
    await new Promise((r) => setTimeout(r, 5)); // let the 1ms cooldown lapse so the pre-flight re-fires
    await eng._test.evaluateEntryTrigger();
    await new Promise((r) => setTimeout(r, 5));
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 0);
    assert.equal(pauseLines().length, 1, 'pause logged once per low-balance episode');
  });
});

describe('executeEntry sizing (#1233)', () => {
  it('uses the remaining budget when it fits between 1x and 2x the minimum size', async () => {
    const { eng, calls } = await makeEngine({ config: { maxUsdcDeployed: 15, minOrderSizeUsdc: 10 } });
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 15);
  });

  it('floors a sub-minimum size at the minimum order size', async () => {
    const { eng, calls } = await makeEngine({ config: { baseSizeUsdc: 1, minOrderSizeUsdc: 20 } });
    await eng._test.evaluateEntryTrigger();
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0] >= 20);
  });
});

describe('executeEntry momentum offset (#1233)', () => {
  it('passes the matching offset bps for up / down / neutral momentum', async () => {
    const offsets = { entryOffsetBps: 11, entryOffsetUpBps: 3, entryOffsetDownBps: 29 };
    const seen = {};
    for (const [momentum, key] of [['up', 'entryOffsetUpBps'], ['down', 'entryOffsetDownBps'], ['neutral', 'entryOffsetBps']]) {
      const { eng, calls } = await makeEngine({ config: offsets, momentum });
      await eng._test.evaluateEntryTrigger();
      assert.equal(calls.length, 1);
      seen[momentum] = calls[0][4];
      assert.equal(seen[momentum], Math.round(offsets[key] * 1), `${momentum} offset`);
    }
  });
});
