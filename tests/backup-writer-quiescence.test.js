const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performBackup } = require('../src/backup-coordinator');
const { registerEngineBackupHandlers } = require('../src/engine-backup-window');
const { trackPendingWrite, drainPendingWrites, parkPendingWrites, isParkedWrite } = require('../src/pending-writes');
const maintenance = require('../src/restore-maintenance');
const { getEngineMaintenance, setEngineMaintenance, setEngineBackupPaused, refuseDuringMaintenance } = require('../src/engine-maintenance');
const { createBackup, restoreBackup, createFundStateBackup, restoreFundStateBackup } = require('../src/backup-service');
const { fixturePayload } = require('./helpers/ledger-fixture');
const logger = { info() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ipc = (override = {}) => ({ isConnected: () => true, request: async (channel, payload) => {
  if (channel === 'engine:maintenance') return { success: true, maintenance: payload.active ? { reason: payload.reason } : null };
  return { success: true, quiesced: true };
}, ...override });
const run = (over = {}) => performBackup({ kind: 'test', create: () => ({ success: true }), exchangeIPCMap: { coinbase: ipc() }, configuredExchanges: ['coinbase'], drainPendingWrites, logger, ...over });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
afterEach(() => { maintenance.endMaintenance(); setEngineMaintenance({ active: false }); setEngineBackupPaused(false); });

describe('scheduled backup maintenance windows', () => {
  for (const kind of ['archive', 'fund-state']) {
    it(`${kind} restores every accounting file from the drained generation`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-quiescence-'));
      const dataDir = path.join(root, 'data');
      const fundDir = path.join(dataDir, 'coinbase', 'BTC-USDC');
      const baseConfigFile = path.join(root, 'config.json');
      const paths = { dataDir, baseConfigFile };
      const files = ['fill-ledger.json', 'regime-state.json', 'closed-trades.json', 'state.json', 'dry-run-state.json'];
      fs.mkdirSync(fundDir, { recursive: true });
      fs.writeFileSync(baseConfigFile, JSON.stringify({ exchanges: { coinbase: { pairs: { 'BTC-USDC': { enabled: true, productId: 'BTC-USDC' } } } } }));
      const write = (file, generation) => fs.writeFileSync(path.join(fundDir, file), JSON.stringify(fixturePayload(file, { generation })));
      files.forEach((file) => write(file, 0));
      const gate = deferred();
      const entered = deferred();
      const writer = trackPendingWrite('dca-cycle:test', async () => {
        write(files[0], 1);
        entered.resolve();
        await gate.promise;
        files.slice(1).forEach((file) => write(file, 1));
      });
      await entered.promise;
      let copies = 0;
      const backup = run({ kind, create: () => {
        copies++;
        assert.equal(maintenance.isMaintenanceActive(), true);
        let admitted = false;
        maintenance.maintenanceGuard({ method: 'POST', path: '/funds/write' }, { status: () => ({ json() {} }) }, () => { admitted = true; });
        assert.equal(admitted, false, 'new gateway mutation cannot enter during copy');
        return kind === 'archive' ? createBackup({ paths }) : createFundStateBackup({ paths });
      } });
      await new Promise((r) => setImmediate(r));
      assert.equal(copies, 0, 'the copy waits while files span two generations');
      gate.resolve();
      await writer;
      const result = await backup;
      assert.equal(result.success, true, JSON.stringify(result));
      files.forEach((file) => write(file, 2));
      const restored = kind === 'archive' ? restoreBackup(result.filename, { paths }) : restoreFundStateBackup(result.snapshotId, 'coinbase', 'BTC-USDC', { paths });
      assert.equal(restored.success, true, JSON.stringify(restored));
      for (const file of files) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, file))), fixturePayload(file, { generation: 1 }));
      fs.rmSync(root, { recursive: true, force: true });
    });
  }
  it('rejects overlapping full and fund-state schedules with one lock', async () => {
    const gate = deferred();
    const first = run({ kind: 'archive', create: async () => { await gate.promise; return { success: true }; } });
    const second = await run({ kind: 'fund-state', create: () => { assert.fail('overlapping copy'); } });
    assert.equal(second.code, 'maintenance-in-progress');
    gate.resolve(); await first;
    assert.equal(maintenance.isMaintenanceActive(), false);
  });
  for (const acknowledgement of [null, { success: true }, { success: false }, { success: true, quiesced: false }]) {
    it(`publishes no recovery point for unconfirmed engine ack ${JSON.stringify(acknowledgement)}`, async () => {
      const client = ipc(); const base = client.request;
      client.request = (channel, payload) => channel === 'engine:backup-pause' ? Promise.resolve(acknowledgement) : base(channel, payload);
      const result = await run({ exchangeIPCMap: { coinbase: client }, create: () => assert.fail('must not copy') });
      assert.equal(result.success, false);
      assert.equal(result.code, 'writers-not-quiesced');
      assert.equal(maintenance.isMaintenanceActive(), false);
    });
  }
  it('blocks on malformed window ack, disconnected engine, and a failed gateway drain', async () => {
    for (const over of [
      { exchangeIPCMap: { coinbase: ipc({ request: async () => ({ success: true }) }) } },
      { exchangeIPCMap: { coinbase: ipc({ isConnected: () => false }) } },
      { drainPendingWrites: async () => ({ drained: false, pending: [{ label: 'hung' }] }) },
      { gatewayWriters: [{ name: 'writer', stop: async () => { throw Error('stop failed'); }, resume() {} }] },
    ]) {
      const result = await run({ ...over, create: () => assert.fail('must not copy') });
      assert.equal(result.success, false);
      assert.equal(maintenance.isMaintenanceActive(), false);
    }
  });
  it('holds engine windows until copy settles and resumes on a thrown archive error', async () => {
    const events = [];
    const client = ipc(); const base = client.request;
    client.request = (channel, payload) => { events.push(`${channel}:${payload?.active ?? ''}`); return base(channel, payload); };
    const result = await run({ exchangeIPCMap: { coinbase: client }, create: () => { events.push('copy'); throw Error('disk full'); } });
    assert.equal(result.success, false);
    assert.deepEqual(events, ['engine:maintenance:true', 'engine:backup-pause:', 'copy', 'engine:backup-resume:', 'engine:maintenance:false']);
  });
});


describe('pending-write parking for the backup drain (#1945)', () => {
  const notParked = (entry) => !isParkedWrite(entry);
  it('excludes a parked write and every write enclosing it, but still joins running writes', async () => {
    const fence = deferred();
    const running = deferred();
    let parkedEntered = false;
    const outer = trackPendingWrite('engine-fill:test', () => trackPendingWrite('engine-booking:test', async () => {
      parkedEntered = true;
      await parkPendingWrites(fence.promise);
    }));
    const busy = trackPendingWrite('engine-metrics:test', () => running.promise);
    await settle();
    assert.equal(parkedEntered, true);
    let drained = null;
    const draining = drainPendingWrites(5_000, notParked).then((result) => { drained = result; });
    await settle();
    assert.equal(drained, null, 'a running write is still joined');
    running.resolve(); await busy; await draining;
    assert.deepEqual(drained, { drained: true, pending: [] }, 'the parked chain does not hold the drain');
    assert.equal((await drainPendingWrites(0)).drained, false, 'an unfiltered drain still sees the parked chain');
    fence.resolve(); await outer;
  });
  it('re-evaluates the cohort when a running write parks mid-drain', async () => {
    const fence = deferred();
    const reachFence = deferred();
    const writer = trackPendingWrite('engine-merge:test', async () => {
      await reachFence.promise;
      await parkPendingWrites(fence.promise);
    });
    let drained = null;
    const draining = drainPendingWrites(5_000, notParked).then((result) => { drained = result; });
    await settle();
    assert.equal(drained, null);
    reachFence.resolve(); await draining;
    assert.equal(drained.drained, true, 'the write stopped counting once it parked');
    fence.resolve(); await writer;
  });
});

describe('engine backup producer pause and drain', () => {
  it('keeps the writer gate after the transport maintenance window expires', () => {
    setEngineBackupPaused(true);
    setEngineMaintenance({ active: false });
    assert.equal(refuseDuringMaintenance('regime:update-config').code, 'maintenance-in-progress');
    assert.equal(refuseDuringMaintenance('regime:status').code, 'maintenance-in-progress');
    assert.equal(refuseDuringMaintenance('engine:backup-resume'), null);
    setEngineBackupPaused(false);
    assert.equal(refuseDuringMaintenance('regime:status'), null);
  });
  it('drains child work that outlives its initiating operation', async () => {
    const gate = deferred();
    trackPendingWrite('parent', async () => { trackPendingWrite('child', () => gate.promise); });
    const draining = drainPendingWrites();
    let done = false; draining.then(() => { done = true; });
    await new Promise((r) => setImmediate(r)); assert.equal(done, false);
    gate.resolve(); assert.equal((await draining).drained, true);
  });
});

// Quiesce in place (#1909, #1945): live engines are held, never stopped or rebuilt.
describe('in-place backup hold', () => {
  const harness = (engines, extra = {}, events = []) => {
    const handlers = new Map();
    const disconnects = [];
    const timers = [];
    const errors = [];
    let clock = 1_000_000;
    const recovery = registerEngineBackupHandlers({ onRequest: (name, handler) => handlers.set(name, handler) }, {
      regimeEngines: new Map(engines), drainPendingWrites,
      getMarketFunds: () => [{ exchange: 'coinbase', pair: 'SOL-USDC' }],
      stopMarketServices: () => events.push('stop-market'), drainMarketStarts: async () => {},
      startMarketService: async (_, pair) => { events.push(`start-market:${pair}`); return { success: true }; },
      pauseBuffers: () => events.push('pause-buffers'), resumeBuffers: () => events.push('resume-buffers'),
      logger: { ...logger, error: (message, details) => errors.push({ message, details }) },
      onGatewayDisconnect: (listener) => disconnects.push(listener),
      now: () => clock,
      setTimer: (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.cleared = true; },
      ...extra,
    });
    return {
      handlers, disconnects, timers, events, errors, recovery,
      pause: () => handlers.get('engine:backup-pause')(),
      resume: () => handlers.get('engine:backup-resume')(),
      liveTimers: () => timers.filter((timer) => !timer.cleared),
      fire: async (timer) => { timer.cleared = true; clock += timer.delay; await timer.fn(); },
    };
  };
  const fakeEngine = (events, name, over = {}) => {
    let held = false;
    return {
      stop: () => assert.fail('backup must not stop an engine'),
      holdForBackup: async () => { events.push(`hold:${name}`); held = true; return { quiesced: true }; },
      releaseBackupHold: () => { if (held) events.push(`release:${name}`); held = false; },
      isBackupHeld: () => held,
      flushForBackup: () => events.push(`flush:${name}`),
      ...over,
    };
  };
  const btcAndEth = (events) => [['coinbase::BTC-USDC', fakeEngine(events, 'btc')], ['coinbase::ETH-USDC', fakeEngine(events, 'eth')]];

  it('holds, flushes and resumes every engine without stopping it, and restarts standalone market services', async () => {
    const events = [];
    const h = harness(btcAndEth(events), {}, events);
    assert.equal((await h.pause()).success, false, 'requires maintenance');
    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.deepEqual(await h.pause(), { success: true, quiesced: true });
    assert.deepEqual(events, ['stop-market', 'hold:btc', 'hold:eth', 'flush:btc', 'flush:eth', 'pause-buffers']);
    assert.equal(refuseDuringMaintenance('regime:start').code, 'maintenance-in-progress');
    events.length = 0;
    assert.deepEqual(await h.resume(), { success: true, failures: [] });
    assert.deepEqual(events, ['release:btc', 'release:eth', 'start-market:SOL-USDC', 'resume-buffers']);
    assert.deepEqual(await h.resume(), { success: true }, 'repeat resume is idempotent');
    setEngineMaintenance({ active: false });
    assert.equal(refuseDuringMaintenance('regime:start'), null);
    assert.equal(h.liveTimers().length, 0);
  });
  it('fails closed and reopens every fence when one engine cannot quiesce', async () => {
    const events = [];
    const stuck = fakeEngine(events, 'eth', { holdForBackup: async () => ({ quiesced: false, error: '1 engine writer(s) still in flight' }) });
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')], ['coinbase::ETH-USDC', stuck]], {}, events);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    const result = await h.pause();
    assert.equal(result.success, false);
    assert.deepEqual(result.failures, [{ fund: 'coinbase::ETH-USDC', error: '1 engine writer(s) still in flight' }]);
    await settle();
    assert.ok(events.includes('release:btc'), 'the healthy engine is released before resume');
    assert.equal(events.some((event) => event.startsWith('flush:')), false, 'no recovery point is published');
    assert.deepEqual(await h.resume(), { success: true, failures: [] });
    assert.ok(events.includes('start-market:SOL-USDC'), 'market services restart on the resume');
  });
  it('refuses the pause when a fund stops during the hold', async () => {
    const events = [];
    const btc = fakeEngine(events, 'btc');
    btc.holdForBackup = async () => { events.push('hold:btc'); return { quiesced: true }; }; // a stop already reopened it
    const h = harness([['coinbase::BTC-USDC', btc]], {}, events);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    const result = await h.pause();
    assert.equal(result.success, false);
    assert.equal(result.error, 'A fund stopped during the backup hold');
    assert.equal(events.includes('flush:btc'), false);
    assert.equal((await h.resume()).success, true);
  });
  it('joins a running writer before the final flush but never a parked one', async () => {
    const events = [];
    const running = deferred();
    const fence = deferred();
    const parked = trackPendingWrite('engine-booking:coinbase:BTC-USDC', () => parkPendingWrites(fence.promise));
    const writer = trackPendingWrite('engine-flash-cancel:coinbase:BTC-USDC', () => running.promise.then(() => events.push('write')));
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], {}, events);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    const pausing = h.pause();
    await settle();
    assert.equal(events.includes('flush:btc'), false, 'the flush waits for the running writer');
    running.resolve(); await writer;
    assert.deepEqual(await pausing, { success: true, quiesced: true });
    assert.ok(events.indexOf('write') < events.indexOf('flush:btc'));
    fence.resolve(); await parked;
    await h.resume();
  });
  it('reopens the fences and restarts producers when the gateway disconnects or the window expires', async () => {
    for (const trigger of ['disconnect', 'timer']) {
      const events = [];
      const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], {}, events);
      setEngineMaintenance({ active: true, reason: `gateway ${trigger}`, ttlMs: 60_000 });
      assert.equal((await h.pause()).success, true);
      assert.equal(refuseDuringMaintenance('regime:start').code, 'maintenance-in-progress');
      if (trigger === 'disconnect') h.disconnects.forEach((listener) => listener());
      else await h.fire(h.liveTimers()[0]);
      await settle();
      assert.deepEqual(events.slice(-3), ['release:btc', 'start-market:SOL-USDC', 'resume-buffers']);
      assert.equal(refuseDuringMaintenance('regime:start'), null);
      assert.equal(getEngineMaintenance(), null, 'the dead owner window is closed with it');
    }
  });
  it('does not release a newer gateway window from an old pause timer', async () => {
    const events = [];
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], {}, events);
    setEngineMaintenance({ active: true, reason: 'first gateway' });
    assert.equal((await h.pause()).success, true);
    setEngineMaintenance({ active: true, reason: 'second gateway' });
    h.disconnects.forEach((listener) => listener());
    await settle();
    assert.equal(getEngineMaintenance()?.reason, 'second gateway');
  });
  it('ignores a disconnect when no pause is held', async () => {
    const events = [];
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], {}, events);
    h.disconnects.forEach((listener) => listener());
    await settle();
    assert.equal(events.length, 0);
  });
  for (const mode of ['reject', 'negative acknowledgement']) {
    it(`reports a market restart ${mode} and retries it with backoff after maintenance ends`, async () => {
      const events = [];
      let attempts = 0;
      const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], {
        startMarketService: async (_, pair) => {
          events.push(`start-market:${pair}`);
          if (++attempts > 1) return { success: true };
          if (mode === 'reject') throw Error('restart failed');
          return { success: false, error: 'restart failed' };
        },
      }, events);
      setEngineMaintenance({ active: true, reason: 'backup test' });
      assert.equal((await h.pause()).success, true);
      const failures = [{ exchange: 'coinbase', pair: 'SOL-USDC', error: 'restart failed' }];
      assert.deepEqual(await h.resume(), { success: false, failures });
      assert.deepEqual(h.errors.find(({ message }) => message === 'Backup completed but some engine writers could not resume').details, { failures });
      assert.ok(events.includes('release:btc'), 'a producer failure never keeps fills parked');
      assert.ok(events.includes('resume-buffers'));
      setEngineMaintenance({ active: false });
      const [retry] = h.liveTimers();
      assert.ok(retry, 'a retry is scheduled');
      await h.fire(retry);
      assert.equal(events.filter((event) => event === 'start-market:SOL-USDC').length, 2);
      assert.equal(h.liveTimers().length, 0, 'recovered producers schedule nothing further');
      assert.deepEqual(await h.resume(), { success: true });
    });
  }
  it('defers a producer retry while a newer maintenance window owns writes', async () => {
    const events = [];
    let fail = true;
    const h = harness([], { startMarketService: async (_, pair) => { events.push(`start-market:${pair}`); return fail ? { success: false, error: 'down' } : { success: true }; } }, events);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.equal((await h.pause()).success, true);
    assert.equal((await h.resume()).success, false);
    setEngineMaintenance({ active: true, kind: 'restore', reason: 'restore newer' });
    fail = false;
    await h.fire(h.liveTimers()[0]);
    assert.equal(events.filter((event) => event === 'start-market:SOL-USDC').length, 1, 'no restart inside a newer window');
    setEngineMaintenance({ active: false });
    await h.fire(h.liveTimers()[0]);
    assert.equal(events.filter((event) => event === 'start-market:SOL-USDC').length, 2);
  });
  it('cancelFund reopens only that fund\'s fence', async () => {
    const events = [];
    const h = harness(btcAndEth(events), {}, events);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.equal((await h.pause()).success, true);
    await h.recovery.cancelFund('coinbase::BTC-USDC');
    assert.ok(events.includes('release:btc'));
    assert.equal(events.includes('release:eth'), false);
    events.length = 0;
    await h.resume();
    assert.deepEqual(events, ['release:eth', 'start-market:SOL-USDC', 'resume-buffers']);
  });
});
