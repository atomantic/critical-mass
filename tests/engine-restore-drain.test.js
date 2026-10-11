const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineStopAllHandler } = require('../src/engine-stop-all');
const { performRestore } = require('../src/restore-coordinator');
const { createOrderMailbox } = require('../src/market-data-service');
const { trackPendingWrite, drainPendingWrites } = require('../src/pending-writes');
const em = require('../src/engine-maintenance');
const gm = require('../src/restore-maintenance');
const { createIPCClient } = require('../src/ipc/ipc-client');
const { startEngineIpc, until, deferred } = require('./helpers/ipc-command-harness');
const log = { info() {}, warn() {}, error() {} };
const tick = () => new Promise(r => setImmediate(r));

const setup = (over = {}) => {
  const flags = [];
  const events = [];
  const engines = new Map();
  const handler = createEngineStopAllHandler({
    regimeEngines: engines,
    cancelStarts: async () => events.push('cancel-starts'),
    drainPendingWrites,
    stopMarketServices: () => events.push('stop-market'),
    drainMarketStarts: async () => events.push('join-market-starts'),
    clearCaches: () => events.push('clear-caches'),
    getMaintenance: em.getEngineMaintenance,
    setQuiescing: em.setEngineRestoreQuiescing,
    logger: () => log, label: (e, p) => `${e}/${p}`,
    setRunningFlag: (e, p, running) => flags.push({ e, p, running }),
    ...over,
  });
  return { handler, flags, events, engines };
};
const maintenance = (t) => {
  em.setEngineMaintenance({ active: true, reason: 'restore test.zip' });
  t.after(() => { em.setEngineMaintenance({ active: false }); em.setEngineRestoreQuiescing(false); gm.endMaintenance(); });
};

describe('exchange restore process drain', () => {
  it('joins a real standalone order mailbox before copying, then drops stale caches', async (t) => {
    maintenance(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-engine-restore-drain-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'fill-ledger.json');
    fs.writeFileSync(file, 'old');
    const mailbox = createOrderMailbox();
    const gate = deferred();
    const entered = deferred();
    const writer = mailbox.post('order-1', 'fill', async () => {
      entered.resolve();
      await gate.promise;
      fs.writeFileSync(file, 'late-old');
    });
    t.after(async () => { gate.resolve(); await writer; await mailbox.stop(); });
    await entered.promise;
    const h = setup({ stopMarketServices: () => { h.events.push('stop-market'); mailbox.stop(); } });
    const { server, url } = await startEngineIpc(ipc => ipc.onRequest('regime:stop-all', h.handler));
    t.after(() => server.stop());
    const client = createIPCClient(url, 'restore-drain-test');
    t.after(() => client.disconnect());
    client.connect();
    await until(() => client.isConnected(), 'restore client');
    let copies = 0;
    const restore = performRestore({
      filename: 'test.zip', configuredExchanges: ['coinbase'], exchangeIPCMap: { coinbase: client }, logger: log,
      restore: () => { copies++; fs.writeFileSync(file, 'restored'); return { success: true, filesRestored: 1 }; },
    });
    await until(() => h.events.includes('stop-market'), 'standalone fence');
    assert.equal(copies, 0, 'no copy while the accepted fill is mid-await');
    assert.equal(h.events.includes('clear-caches'), false);
    gate.resolve();
    assert.equal((await restore).status, 200);
    await writer;
    assert.equal(copies, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'restored');
    assert.equal(h.events.at(-1), 'clear-caches');
    assert.deepEqual(await drainPendingWrites(0), { drained: true, pending: [] }, 'stop-all does not join itself');
  });

  it('waits for accepted IPC before stopping owners and refuses intake even after the gateway closes its window', async (t) => {
    maintenance(t);
    const gate = deferred();
    const writer = trackPendingWrite('ipc:regime:stop', () => gate.promise);
    t.after(async () => { gate.resolve(); await writer; });
    const h = setup();
    const first = h.handler();
    assert.equal(h.handler(), first, 'duplicate stop-all shares one drain');
    await tick();
    assert.deepEqual(h.events, ['cancel-starts']);
    em.setEngineMaintenance({ active: false });
    assert.equal(em.refuseDuringMaintenance('regime:start').code, 'maintenance-in-progress');
    assert.equal(em.refuseDuringMaintenance('config_update').code, 'maintenance-in-progress');
    gate.resolve();
    assert.equal((await first).success, true);
    assert.equal(em.refuseDuringMaintenance('regime:start'), null);
  });

  it('keeps intake fenced after a process drain timeout until final flush and cache retirement', async (t) => {
    maintenance(t);
    const gate = deferred();
    const writer = trackPendingWrite('engine-booking:test', () => gate.promise);
    t.after(async () => { gate.resolve(); await writer; });
    let running = true;
    let flushes = 0;
    const h = setup({ drainPendingWrites: (_, matches) => drainPendingWrites(0, matches) });
    h.engines.set('coinbase::TEST', {
      getStatus: () => ({ isRunning: running }), stop: async () => { running = false; },
      flushForBackup: () => { flushes++; },
    });
    assert.equal((await h.handler()).success, false);
    assert.equal(h.engines.size, 1);
    assert.deepEqual(h.flags, []);
    assert.equal(flushes, 0);
    em.setEngineMaintenance({ active: false });
    assert.equal(em.refuseDuringMaintenance('regime:start').code, 'maintenance-in-progress');
    assert.equal(em.refuseDuringMaintenance('regime:fills').code, 'maintenance-in-progress');
    assert.equal(em.refuseDuringMaintenance('config_update').code, 'maintenance-in-progress');
    gate.resolve();
    await writer;
    await until(() => h.events.includes('clear-caches'), 'continuing process drain');
    await tick();
    assert.equal(em.refuseDuringMaintenance('regime:start'), null);
    assert.equal(flushes, 1, 'cleanup must publish writes completed after the failure acknowledgement');
    assert.equal(h.engines.size, 0);
    assert.equal(h.events.filter(e => e === 'clear-caches').length, 1);
  });

  it('keeps intake fenced after an accepted IPC drain timeout until the request settles', async (t) => {
    maintenance(t);
    const gate = deferred();
    const writer = trackPendingWrite('ipc:regime:stop', () => gate.promise);
    t.after(async () => { gate.resolve(); await writer; });
    const h = setup({ drainPendingWrites: (_, matches) => drainPendingWrites(0, matches) });
    const result = await h.handler();
    assert.equal(result.success, false);
    assert.match(result.error, /Accepted engine requests/);
    assert.deepEqual(h.events, ['cancel-starts']);
    em.setEngineMaintenance({ active: false });
    assert.equal(em.refuseDuringMaintenance('regime:fills').code, 'maintenance-in-progress');
    assert.equal(em.refuseDuringMaintenance('config_update').code, 'maintenance-in-progress');
    gate.resolve();
    await writer;
    await until(() => h.events.includes('clear-caches'), 'continuing accepted-request drain');
    await tick();
    assert.equal(em.refuseDuringMaintenance('regime:start'), null);
    assert.deepEqual(h.events, ['cancel-starts', 'stop-market', 'join-market-starts', 'clear-caches']);
  });

  it('retains a failed final-flush owner and blocks restore', async (t) => {
    maintenance(t);
    const h = setup();
    h.engines.set('coinbase::TEST', {
      getStatus: () => ({ isRunning: true }), stop: async () => {}, flushForBackup: () => { throw Error('ENOSPC'); },
    });
    const result = await h.handler();
    assert.equal(result.success, false);
    assert.match(result.failed[0].error, /ENOSPC/);
    assert.equal(h.engines.size, 1);
    assert.deepEqual(h.flags, []);
    assert.equal(h.events.includes('clear-caches'), false);
  });

  it('requires a restore window and never flushes partial startup state', async (t) => {
    maintenance(t);
    const h = setup();
    h.engines.set('coinbase::TEST', {
      getStatus: () => ({ isRunning: false }), stop: async () => {}, flushForBackup: () => assert.fail('partial startup flushed'),
    });
    assert.equal((await h.handler()).success, true);
    em.setEngineMaintenance({ active: false });
    assert.equal((await h.handler()).success, false);
  });
});
