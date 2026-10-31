const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performBackup } = require('../src/backup-coordinator');
const { registerEngineBackupHandlers } = require('../src/engine-backup-window');
const { trackPendingWrite, drainPendingWrites } = require('../src/pending-writes');
const maintenance = require('../src/restore-maintenance');
const { getEngineMaintenance, setEngineMaintenance, setEngineBackupPaused, refuseDuringMaintenance } = require('../src/engine-maintenance');
const { createBackup, restoreBackup, createFundStateBackup, restoreFundStateBackup } = require('../src/backup-service');
const { ledgerOf, fixturePayload } = require('./helpers/ledger-fixture');
const logger = { info() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ipc = (override = {}) => ({ isConnected: () => true, request: async (channel, payload) => {
  if (channel === 'engine:maintenance') return { success: true, maintenance: payload.active ? { reason: payload.reason } : null };
  return { success: true, quiesced: true };
}, ...override });
const run = (over = {}) => performBackup({ kind: 'test', create: () => ({ success: true }), exchangeIPCMap: { coinbase: ipc() }, configuredExchanges: ['coinbase'], drainPendingWrites, logger, ...over });
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

// Issue #1025: bridge the real backup handlers to the real lifecycle/startup

// Quiesce in place (#1909): the engine is never stopped or rebuilt.
describe('in-place backup hold', () => {
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const harness = (engines, extra = {}, events = []) => {
    const handlers = new Map();
    const disconnects = [];
    const timers = [];
    registerEngineBackupHandlers({ onRequest: (name, handler) => handlers.set(name, handler) }, {
      regimeEngines: new Map(engines), drainPendingWrites,
      pauseBuffers: () => events.push('pause-buffers'), resumeBuffers: () => events.push('resume-buffers'), logger,
      onGatewayDisconnect: (listener) => disconnects.push(listener),
      setTimer: (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.cleared = true; },
      ...extra,
    });
    return { handlers, disconnects, timers, events, pause: () => handlers.get('engine:backup-pause')(), resume: () => handlers.get('engine:backup-resume')() };
  };
  const fakeEngine = (events, name, over = {}) => ({
    stop: () => assert.fail('backup must not stop an engine'),
    holdForBackup: async () => { events.push(`hold:${name}`); return { quiesced: true }; },
    releaseBackupHold: () => events.push(`release:${name}`),
    flushForBackup: () => events.push(`flush:${name}`),
    ...over,
  });

  it('holds, flushes and resumes every engine without stopping or restarting it', async () => {
    const events = [];
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')], ['coinbase::ETH-USDC', fakeEngine(events, 'eth')]], { stopMarketServices: () => assert.fail('feeds stay connected') }, events);
    assert.equal((await h.pause()).success, false, 'requires maintenance');
    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.deepEqual(await h.pause(), { success: true, quiesced: true });
    assert.deepEqual(events, ['hold:btc', 'hold:eth', 'flush:btc', 'flush:eth', 'pause-buffers']);
    assert.deepEqual(await h.resume(), { success: true });
    assert.deepEqual(events.slice(5), ['release:btc', 'release:eth', 'resume-buffers']);
    assert.deepEqual(await h.resume(), { success: true }, 'repeat resume is idempotent');
    setEngineMaintenance({ active: false });
    assert.equal(refuseDuringMaintenance('regime:start'), null);
  });
  it('fails closed and reopens every gate when one engine cannot quiesce', async () => {
    const events = [];
    const stuck = fakeEngine(events, 'eth', { holdForBackup: async () => ({ quiesced: false, error: '1 fill handler(s) still in flight' }) });
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')], ['coinbase::ETH-USDC', stuck]]);
    setEngineMaintenance({ active: true, reason: 'backup test' });
    const result = await h.pause();
    assert.equal(result.success, false);
    assert.deepEqual(result.failures.map((f) => f.fund), ['coinbase::ETH-USDC']);
    await settle();
    assert.ok(events.includes('release:btc'), 'the healthy engine is released');
    assert.equal(events.includes('flush:btc'), false, 'no recovery point is published');
    assert.deepEqual(await h.resume(), { success: true });
  });
  it('reopens the gates when the gateway disconnects or the window expires', async () => {
    for (const trigger of ['disconnect', 'timer']) {
      const events = [];
      const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], {}, events);
      setEngineMaintenance({ active: true, reason: `gateway ${trigger}`, ttlMs: 60_000 });
      assert.equal((await h.pause()).success, true);
      assert.equal(refuseDuringMaintenance('regime:start').code, 'maintenance-in-progress');
      if (trigger === 'disconnect') h.disconnects.forEach((listener) => listener());
      else h.timers.find((timer) => !timer.cleared).fn();
      await settle();
      assert.deepEqual(events.slice(-2), ['release:btc', 'resume-buffers']);
      assert.equal(refuseDuringMaintenance('regime:start'), null);
      assert.equal(getEngineMaintenance(), null, 'the dead owner window is closed with it');
    }
  });
  it('does not release a newer gateway window from an old pause timer', async () => {
    const events = [];
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]]);
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
  it('excludes queued fill callbacks from the process-wide drain', async () => {
    const gate = deferred();
    const queued = trackPendingWrite('engine-order:coinbase:BTC-USDC', () => gate.promise);
    const events = [];
    const h = harness([['coinbase::BTC-USDC', fakeEngine(events, 'btc')]], { drainPendingWrites: (_, matches) => drainPendingWrites(0, matches) });
    setEngineMaintenance({ active: true, reason: 'backup test' });
    assert.deepEqual(await h.pause(), { success: true, quiesced: true });
    gate.resolve(); await queued; await h.resume();
  });
});
