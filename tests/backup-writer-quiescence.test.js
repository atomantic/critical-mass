const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performBackup } = require('../src/backup-coordinator');
const { registerEngineBackupHandlers } = require('../src/engine-backup-window');
const { trackPendingWrite, drainPendingWrites } = require('../src/pending-writes');
const maintenance = require('../src/restore-maintenance');
const { setEngineMaintenance, setEngineBackupPaused, refuseDuringMaintenance } = require('../src/engine-maintenance');
const { createBackup, restoreBackup, createFundStateBackup, restoreFundStateBackup } = require('../src/backup-service');
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
      const write = (file, generation) => fs.writeFileSync(path.join(fundDir, file), JSON.stringify({ generation }));
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
      for (const file of files) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fundDir, file))), { generation: 1 });
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
  it('joins accepted IPC then background work, flushes once, and restarts only captured funds', async () => {
    const handlers = new Map();
    const events = [];
    const gate = deferred();
    const registry = new Map([['coinbase::BTC-USDC', { stop: async () => { events.push('stop'); }, flushForBackup: () => events.push('flush') }]]);
    const pending = trackPendingWrite('engine-booking:test', () => gate.promise.then(() => events.push('write')));
    registerEngineBackupHandlers({ onRequest: (name, handler) => handlers.set(name, handler) }, {
      regimeEngines: registry, getMarketFunds: () => [{ exchange: 'coinbase', pair: 'ETH-USDC' }],
      stopMarketServices: () => events.push('stop-market'), drainMarketStarts: async () => {}, drainPendingWrites,
      startFund: async (_, exchange, pair) => { events.push(`start:${pair}`); registry.set(`${exchange}::${pair}`, {}); return { success: true }; },
      startMarketService: async (_, pair) => { events.push(`start-market:${pair}`); return { success: true }; }, logger,
    });
    assert.equal((await handlers.get('engine:backup-pause')()).success, false, 'requires maintenance');
    setEngineMaintenance({ active: true, reason: 'backup test' });
    const pausing = handlers.get('engine:backup-pause')();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, ['stop-market', 'stop']);
    gate.resolve(); await pending;
    assert.deepEqual(await pausing, { success: true, quiesced: true });
    assert.deepEqual(events, ['stop-market', 'stop', 'write', 'flush']);
    assert.equal((await handlers.get('engine:backup-resume')()).success, true);
    assert.deepEqual(events.slice(-2), ['start:BTC-USDC', 'start-market:ETH-USDC']);
  });
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
