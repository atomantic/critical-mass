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
const logger = { info() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ipc = (override = {}) => ({ isConnected: () => true, request: async (channel, payload) => {
  if (channel === 'engine:maintenance') return { success: true, maintenance: payload.active ? { reason: payload.reason } : null };
  return { success: true, quiesced: true };
}, ...override });
const run = (over = {}) => performBackup({ kind: 'test', create: () => ({ success: true }), exchangeIPCMap: { coinbase: ipc() }, configuredExchanges: ['coinbase'], drainPendingWrites, logger, ...over });
afterEach(() => { maintenance.endMaintenance(); setEngineMaintenance({ active: false }); setEngineBackupPaused(false); });

// Bridge the coordinator's IPC surface to the real engine handlers. Lifecycle
// spies reload flushed files and replace registry owners, without live adapters.
const backupWorkflow = (t, { restart = async () => ({ success: true }) } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-resume-'));
  const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
  const handlers = new Map();
  const events = [];
  const errors = [];
  const replies = [];
  const originals = new Map();
  const registry = new Map();
  const flushFailures = new Set();
  const pending = [];
  const gates = [];
  const stateFile = (pair) => path.join(paths.dataDir, 'coinbase', pair, 'state.json');
  fs.writeFileSync(paths.baseConfigFile, JSON.stringify({ exchanges: { coinbase: { pairs: {} } } }));
  for (const pair of ['BTC-USDC', 'ETH-USDC']) {
    fs.mkdirSync(path.dirname(stateFile(pair)), { recursive: true });
    fs.writeFileSync(stateFile(pair), JSON.stringify({ generation: 0 }));
    const engine = {
      generation: 0,
      stop: async () => { events.push(`stop:${pair}`); },
      flushForBackup: () => {
        events.push(`flush:${pair}`);
        if (flushFailures.has(pair)) throw Error(`flush failed:${pair}`);
        fs.writeFileSync(stateFile(pair), JSON.stringify({ generation: engine.generation }));
      },
    };
    originals.set(`coinbase::${pair}`, engine);
    registry.set(`coinbase::${pair}`, engine);
  }
  // Introduced after capture; cleanup must not stop or replace this owner.
  const unrelated = { stop: () => assert.fail('unrelated fund stopped'), flushForBackup: () => assert.fail('unrelated fund flushed') };
  const workflowLogger = { ...logger, error: (message, details) => errors.push({ message, details }) };
  registerEngineBackupHandlers({ onRequest: (name, handler) => handlers.set(name, handler) }, {
    regimeEngines: registry,
    getMarketFunds: () => [{ exchange: 'coinbase', pair: 'SOL-USDC' }],
    stopMarketServices: () => events.push('stop-market'),
    drainMarketStarts: async () => {},
    // Exercise real pending-write tracking with an immediate test-only deadline.
    drainPendingWrites: (_, matches) => drainPendingWrites(0, matches),
    startFund: async (_, exchange, pair) => {
      events.push(`start:${pair}`);
      const key = `${exchange}::${pair}`;
      assert.equal(registry.has(key), false, 'old owner must be removed only after its final flush');
      const result = await restart(pair);
      if (result.success) registry.set(key, { ...JSON.parse(fs.readFileSync(stateFile(pair))), replacement: true });
      return result;
    },
    startMarketService: async (_, pair) => { events.push(`start-market:${pair}`); return restart(pair); },
    pauseBuffers: () => events.push('pause-buffers'),
    resumeBuffers: () => events.push('resume-buffers'),
    logger: workflowLogger,
  });
  const client = ipc({ request: async (channel, payload) => {
    events.push(`${channel}:${payload?.active ?? ''}`);
    const refusal = refuseDuringMaintenance(channel);
    const result = refusal || await (channel === 'engine:maintenance' ? setEngineMaintenance(payload) : handlers.get(channel)());
    replies.push({ channel, result });
    return result;
  } });
  t.after(async () => {
    gates.forEach((gate) => gate.resolve());
    await Promise.allSettled(pending);
    await drainPendingWrites(0);
    maintenance.endMaintenance();
    setEngineMaintenance({ active: false });
    setEngineBackupPaused(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    registry, originals, unrelated, flushFailures, events, errors, replies,
    backup: (beforeCopy = () => {}) => run({
      exchangeIPCMap: { coinbase: client }, logger: workflowLogger,
      create: () => {
        events.push('copy');
        registry.set('coinbase::ADA-USDC', unrelated);
        beforeCopy();
        return createBackup({ paths });
      },
    }),
    resume: () => client.request('engine:backup-resume'),
    deferWriter: (pair) => {
      const gate = deferred();
      gates.push(gate);
      const writer = trackPendingWrite(`engine-booking:${pair}`, async () => {
        await gate.promise;
        events.push(`write:${pair}`);
        const engine = originals.get(`coinbase::${pair}`);
        engine.generation++;
        fs.writeFileSync(stateFile(pair), JSON.stringify({ generation: engine.generation }));
      });
      pending.push(writer);
      return { settle: async () => { gate.resolve(); await writer; } };
    },
  };
};

const assertResumeWarning = (result) => {
  assert.deepEqual(result.warnings, ['Engine coinbase failed to resume after backup']);
  assert.equal(maintenance.isMaintenanceActive(), false);
  assert.equal(getEngineMaintenance(), null, 'transport maintenance is released even when resume fails');
};

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

describe('coordinator and engine resume failure contracts', () => {
  it('replaces each captured owner once after a successful archive, leaving unrelated funds untouched', async (t) => {
    const workflow = backupWorkflow(t);
    const result = await workflow.backup();
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.filename, 'the archive has its own successful result');
    assert.equal(result.warnings, undefined);
    for (const pair of ['BTC-USDC', 'ETH-USDC']) {
      const key = `coinbase::${pair}`;
      assert.notEqual(workflow.registry.get(key), workflow.originals.get(key));
      assert.deepEqual(workflow.registry.get(key), { generation: 0, replacement: true });
      assert.equal(workflow.events.filter((event) => event === `start:${pair}`).length, 1);
      const flushes = workflow.events.flatMap((event, index) => event === `flush:${pair}` ? [index] : []);
      assert.equal(flushes.length, 2, 'pause and resume both flush the original owner');
      assert.ok(flushes[0] < workflow.events.indexOf('copy'));
      assert.ok(workflow.events.indexOf('copy') < flushes[1]);
      assert.ok(flushes[1] < workflow.events.indexOf(`start:${pair}`));
    }
    assert.equal(workflow.registry.get('coinbase::ADA-USDC'), workflow.unrelated);
    assert.equal(workflow.events.filter((event) => event === 'start-market:SOL-USDC').length, 1);
    assert.equal(workflow.events.filter((event) => event === 'resume-buffers').length, 1);
    assert.equal(maintenance.isMaintenanceActive(), false);
    assert.equal(getEngineMaintenance(), null);
    assert.equal(refuseDuringMaintenance('regime:update-config'), null);
    assert.deepEqual(await workflow.resume(), { success: true });
    assert.equal(workflow.events.filter((event) => event.startsWith('start:')).length, 2, 'repeated resume does not duplicate replacements');
  });

  it('refuses an undrained resume, retains original owners and the writer gate, then retries after the writer settles', async (t) => {
    const workflow = backupWorkflow(t);
    const writer = workflow.deferWriter('BTC-USDC');
    const result = await workflow.backup();
    assert.equal(result.success, false, 'a writer still running prevents an archive');
    assert.equal(result.code, 'writers-not-quiesced');
    assertResumeWarning(result);
    assert.equal(workflow.events.includes('copy'), false);
    const resumeReply = workflow.replies.find(({ channel }) => channel === 'engine:backup-resume').result;
    assert.deepEqual(resumeReply, { success: false, error: 'Engine writers are still draining; funds remain stopped' });
    for (const [key, original] of workflow.originals) assert.equal(workflow.registry.get(key), original);
    assert.equal(workflow.events.some((event) => event.startsWith('start:') || event.startsWith('start-market:')), false);
    assert.equal(workflow.events.includes('resume-buffers'), false, 'passive writers remain paused');
    assert.equal(refuseDuringMaintenance('regime:update-config').code, 'maintenance-in-progress', 'mutations remain gated after transport cleanup');
    assert.equal(refuseDuringMaintenance('engine:backup-resume'), null, 'an explicit retry remains available');

    await writer.settle();
    assert.deepEqual(await workflow.resume(), { success: true, failures: [] });
    for (const pair of ['BTC-USDC', 'ETH-USDC']) {
      const replacement = workflow.registry.get(`coinbase::${pair}`);
      assert.notEqual(replacement, workflow.originals.get(`coinbase::${pair}`));
      assert.deepEqual(replacement, { generation: pair === 'BTC-USDC' ? 1 : 0, replacement: true });
      assert.equal(workflow.events.filter((event) => event === `start:${pair}`).length, 1);
      assert.ok(workflow.events.indexOf(`flush:${pair}`) < workflow.events.indexOf(`start:${pair}`));
    }
    assert.ok(workflow.events.indexOf('write:BTC-USDC') < workflow.events.indexOf('flush:BTC-USDC'), 'the final flush follows the deferred booking');
    assert.equal(workflow.events.filter((event) => event === 'start-market:SOL-USDC').length, 1);
    assert.equal(workflow.events.filter((event) => event === 'resume-buffers').length, 1);
    assert.equal(refuseDuringMaintenance('regime:update-config'), null);
    assert.deepEqual(await workflow.resume(), { success: true });
    assert.equal(workflow.events.filter((event) => event.startsWith('start:')).length, 2);
  });

  it('retains a failed-flush owner while independently healthy captured funds resume', async (t) => {
    const workflow = backupWorkflow(t);
    const result = await workflow.backup(() => {
      workflow.originals.get('coinbase::BTC-USDC').generation = 1;
      workflow.flushFailures.add('BTC-USDC');
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.filename, 'archive success survives a later final-flush failure');
    assertResumeWarning(result);
    assert.equal(workflow.registry.get('coinbase::BTC-USDC'), workflow.originals.get('coinbase::BTC-USDC'), 'retain the only reference to unflushed booking state');
    assert.equal(workflow.registry.get('coinbase::BTC-USDC').generation, 1);
    assert.equal(workflow.events.includes('start:BTC-USDC'), false);
    assert.deepEqual(workflow.registry.get('coinbase::ETH-USDC'), { generation: 0, replacement: true });
    assert.equal(workflow.events.filter((event) => event === 'start:ETH-USDC').length, 1);
    assert.equal(workflow.registry.get('coinbase::ADA-USDC'), workflow.unrelated);
    const failures = [{ fund: 'coinbase::BTC-USDC', error: 'flush failed:BTC-USDC' }];
    assert.deepEqual(workflow.replies.find(({ channel }) => channel === 'engine:backup-resume').result, { success: false, failures });
    assert.deepEqual(workflow.errors.find(({ message }) => message === 'Backup completed but some engine writers could not resume').details, { failures });
    assert.deepEqual(workflow.errors.find(({ message }) => message === 'Backup test writer resume warnings').details, { warnings: result.warnings });
  });

  for (const mode of ['reject', 'negative acknowledgement']) {
    for (const producer of ['fund', 'market']) {
      it(`reports a ${producer} restart ${mode} separately from successful archive creation`, async (t) => {
        const pair = producer === 'fund' ? 'BTC-USDC' : 'SOL-USDC';
        const workflow = backupWorkflow(t, { restart: async (restartingPair) => {
          if (restartingPair !== pair) return { success: true };
          if (mode === 'reject') throw Error('restart failed');
          return { success: false, error: 'restart failed' };
        } });
        const result = await workflow.backup();
        assert.equal(result.success, true, JSON.stringify(result));
        assert.ok(result.filename);
        assertResumeWarning(result);
        const failures = [{ exchange: 'coinbase', pair, error: 'restart failed' }];
        assert.deepEqual(workflow.replies.find(({ channel }) => channel === 'engine:backup-resume').result, { success: false, failures });
        assert.deepEqual(workflow.errors.find(({ message }) => message === 'Backup completed but some engine writers could not resume').details, { failures });
        assert.deepEqual(workflow.errors.find(({ message }) => message === 'Backup test writer resume warnings').details, { warnings: result.warnings });
        assert.equal(workflow.registry.has('coinbase::BTC-USDC'), producer !== 'fund');
        assert.deepEqual(workflow.registry.get('coinbase::ETH-USDC'), { generation: 0, replacement: true });
        assert.equal(workflow.events.filter((event) => event === `${producer === 'fund' ? 'start' : 'start-market'}:${pair}`).length, 1);
        assert.equal(workflow.registry.get('coinbase::ADA-USDC'), workflow.unrelated);
      });
    }
  }
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
