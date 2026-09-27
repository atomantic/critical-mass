const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDataDir } = require('./test-data-dir');
const isolated = createIsolatedDataDir('cm-start-cleanup');
const configUtils = require('../src/config-utils');
const oldUpdate = configUtils.updateRegimeConfig;
configUtils.updateRegimeConfig = () => {};
const feedModule = require('../src/websocket-feed');
const oldFeed = feedModule.createWebSocketFeed;
let connect;
let disconnected = 0;
feedModule.createWebSocketFeed = () => ({ connect: () => connect(), disconnect: () => { disconnected++; } });
const { createRegimeEngine } = require('../src/regime-engine');
const dryRunState = require('../src/dry-run-state');
const oldForceSave = dryRunState.forceSave;
let saved = 0;
dryRunState.forceSave = () => { saved++; };
after(() => { configUtils.updateRegimeConfig = oldUpdate; feedModule.createWebSocketFeed = oldFeed; dryRunState.forceSave = oldForceSave; isolated.cleanup(); });
const makeEngine = (pair) => {
  const engine = createRegimeEngine('coinbase', pair, { dryRun: true, productId: pair }, {});
  engine._test.setAdapter({ getProductDetails: async () => null, loadCredentials: () => ({}) });
  return engine;
};

it('stop disposes a websocket created by a failed partial start without saving incomplete state', async () => {
  const engine = makeEngine('__test818_failed__');
  disconnected = saved = 0;
  connect = () => { throw new Error('fetch failed'); };
  await assert.rejects(engine.start(), /fetch failed/);
  await engine.stop();
  assert.equal(disconnected, 1);
  assert.equal(saved, 0);
  await engine.stop();
  assert.equal(disconnected, 1, 'released socket is not disposed twice');
  engine._test.clearTimers();
});

it('stop waits for a pending start, then clears the resources created by its late completion', async () => {
  const engine = makeEngine('__test818_pending__');
  disconnected = saved = 0;
  let finishConnect;
  const pending = new Promise(resolve => { finishConnect = resolve; });
  connect = () => {};
  engine._test.setAdapter({ getProductDetails: () => pending, loadCredentials: () => ({}) });
  const started = engine.start();
  await new Promise(resolve => setImmediate(resolve));
  let stopped = false;
  const stop = engine.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  finishConnect();
  assert.equal((await started).success, true);
  await stop;
  assert.equal(disconnected, 1);
  assert.equal(saved, 1);
  assert.equal(engine._test.getFlags().isRunning, false);
  engine._test.clearTimers();
});
