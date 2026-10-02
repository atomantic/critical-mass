const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-shutdown-fill-drain');
const configUtils = require('../src/config-utils');
const oldUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const feedModule = require('../src/websocket-feed');
const oldFeed = feedModule.createWebSocketFeed;
feedModule.createWebSocketFeed = () => ({ connect: () => {}, disconnect: () => {} });
const dryRunState = require('../src/dry-run-state');
const oldForceSave = dryRunState.forceSave;
const events = [];
dryRunState.forceSave = () => { events.push('snapshot'); };
const { createRegimeEngine } = require('../src/regime-engine');
const { createEngineLocks, FILL_GATE_CLOSED_CODE } = require('../src/engine-locks');
after(() => { configUtils.updateRegimeConfig = oldUpdate; feedModule.createWebSocketFeed = oldFeed; dryRunState.forceSave = oldForceSave; isolated.cleanup(); });

const tick = () => new Promise((r) => setTimeout(r, 5));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const makeRunningEngine = async (pair) => {
  const engine = createRegimeEngine('coinbase', pair, { dryRun: true, productId: pair }, {});
  engine._test.setAdapter({ getProductDetails: async () => null, loadCredentials: () => ({}) });
  assert.equal((await engine.start()).success, true);
  return engine;
};

describe('engine-locks fill drain', () => {
  it('waitForFillsIdle resolves immediately when no fill is in flight', async () => {
    const locks = createEngineLocks();
    assert.deepEqual(await locks.waitForFillsIdle(50), { idle: true, pending: 0, orderIds: [] });
  });

  it('waitForFillsIdle waits for a deferred fill, then reports idle', async () => {
    const locks = createEngineLocks();
    const gate = deferred();
    const fill = locks.withFillGate(() => gate.promise, { orderId: 'o-1' });
    let idle = null;
    const waiter = locks.waitForFillsIdle(2000).then((r) => { idle = r; });
    await tick();
    assert.equal(idle, null, 'must not resolve while the fill is in flight');
    gate.resolve();
    await fill;
    await waiter;
    assert.equal(idle.idle, true);
  });

  it('waitForFillsIdle times out on a hung fill and names the order ids', async () => {
    const locks = createEngineLocks();
    const hung = locks.withFillGate(() => new Promise(() => {}), { orderId: 'stuck-7' });
    hung.catch(() => {});
    const res = await locks.waitForFillsIdle(40);
    assert.equal(res.idle, false);
    assert.equal(res.pending, 1);
    assert.deepEqual(res.orderIds, ['stuck-7']);
  });

  it('a closed gate refuses new top-level fills but lets a nested fill finish', async () => {
    const locks = createEngineLocks();
    const gate = deferred();
    let nestedRan = false;
    const outer = locks.withFillGate(async () => {
      await gate.promise;
      await locks.withFillGate(async () => { nestedRan = true; }, { orderId: 'nested' });
    }, { orderId: 'outer' });
    locks.closeFillGate();
    await assert.rejects(
      locks.withFillGate(async () => {}, { orderId: 'late' }),
      (err) => err.code === FILL_GATE_CLOSED_CODE
    );
    gate.resolve();
    await outer;
    assert.equal(nestedRan, true);
    assert.equal(locks.getFlags().fillInProgress, 0, 'refused fill must not leak the counter');
    locks.openFillGate();
    await locks.withFillGate(async () => {}, { orderId: 'after-reopen' });
  });
});

describe('regime engine stop() drains in-flight fills', () => {
  it('does not snapshot or resolve until the in-flight fill settles', async () => {
    const engine = await makeRunningEngine('__test903_wait__');
    events.length = 0;
    engine._test.setFillInProgress(1); // a fill handler is mid-await
    let stopped = false;
    const stop = engine.stop().then(() => { stopped = true; });
    await tick();
    await tick();
    assert.equal(stopped, false, 'stop() must wait for the fill');
    assert.deepEqual(events, [], 'no snapshot while a fill is in flight');
    events.push('fill-settled');
    engine._test.setFillInProgress(0);
    await stop;
    assert.deepEqual(events, ['fill-settled', 'snapshot'], 'fill completes -> snapshot -> stop resolves');
    engine._test.clearTimers();
  });

  it('times out on a hung fill, logs it, and still saves state', async () => {
    const engine = await makeRunningEngine('__test903_hung__');
    events.length = 0;
    engine._test.setFillDrainMs(60);
    engine._test.setFillInProgress(1); // never settles
    await engine.stop();
    assert.deepEqual(events, ['snapshot']);
    engine._test.setFillInProgress(0);
    engine._test.clearTimers();
  });

  it('refuses to start a new fill once stop() has begun, and accepts fills again after restart', async () => {
    const engine = await makeRunningEngine('__test903_refuse__');
    engine._test.setFillInProgress(1);
    const stop = engine.stop();
    await tick();
    await assert.rejects(
      engine._test.handleOrderFill({ orderId: 'late-fill', side: 'BUY', status: 'FILLED' }),
      (err) => err.code === FILL_GATE_CLOSED_CODE
    );
    engine._test.setFillInProgress(0);
    await stop;
    assert.equal((await engine.start()).success, true);
    // The fake adapter cannot complete a fill, so it fails — but as a normal
    // fill failure, not a gate refusal.
    const err = await engine._test.handleOrderFill({ orderId: 'x', side: 'BUY', status: 'FILLED' }).then(() => null, (e) => e);
    assert.notEqual(err?.code, FILL_GATE_CLOSED_CODE, 'gate is reopened after start');
    await engine.stop();
    engine._test.clearTimers();
  });
});
