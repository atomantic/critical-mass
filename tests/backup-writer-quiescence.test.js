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
    resumeFund: async (exchange, pair) => {
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
      resumeFund: async (exchange, pair) => { events.push(`start:${pair}`); registry.set(`${exchange}::${pair}`, {}); return { success: true }; },
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

// Issue #1025: bridge the real backup handlers to the real lifecycle/startup
// supervisor so a transient restart failure keeps automatic recovery.
describe('backup resume keeps automatic fund supervision', () => {
  const { registerEngineLifecycleHandlers } = require('../src/engine-lifecycle-handlers');
  const { fundKey, fundLabel } = require('../src/shared-utils');
  const { LIFECYCLE } = require('../src/state-tracker');
  const PAIRS = ['BTC-USDC', 'ETH-USDC'];
  const settle = () => new Promise((r) => setImmediate(r));
  const transient = () => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

  const supervisedWorkflow = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-backup-supervised-'));
    const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'config.json') };
    const pairsConfig = Object.fromEntries(PAIRS.map((pair) => [pair, { enabled: true, productId: pair }]));
    fs.writeFileSync(paths.baseConfigFile, JSON.stringify({ exchanges: { coinbase: { pairs: pairsConfig } } }));
    const flagFile = (pair) => path.join(paths.dataDir, 'coinbase', pair, 'regime-state.json');
    for (const pair of PAIRS) {
      fs.mkdirSync(path.dirname(flagFile(pair)), { recursive: true });
      fs.writeFileSync(flagFile(pair), JSON.stringify({ isRunning: false }));
    }
    const readFlag = (pair) => JSON.parse(fs.readFileSync(flagFile(pair))).isRunning;
    const regimeEngines = new Map();
    const timers = new Map();
    let timerId = 0;
    const handlers = new Map();
    const registry = { onRequest: (name, handler) => handlers.set(name, handler) };
    // Per-pair queue of start behaviours: undefined → success, Error → throw, Promise → await it.
    const plans = new Map(PAIRS.map((pair) => [pair, []]));
    const starts = new Map(PAIRS.map((pair) => [pair, 0]));
    const createRegimeEngine = (exchange, pair) => ({
      start: async () => {
        starts.set(pair, starts.get(pair) + 1);
        const plan = plans.get(pair).shift();
        if (plan instanceof Error) throw plan;
        return plan ? plan : { success: true };
      },
      stop: async () => ({}),
      flushForBackup: () => {},
      getStatus: () => ({ mode: 'RUNNING' }),
    });
    const lifecycle = registerEngineLifecycleHandlers(registry, {
      regimeEngines, resolvePair: (_, pair) => pair, fundKey, fundLabel, logger: () => logger,
      getFundConfig: (exchange, pair) => ({ exchange, pair }), getAdapter: () => ({ hasValidKeys: () => true }),
      loadFundRegimeState: () => ({ position: { lifecycle: LIFECYCLE.ACTIVE } }), LIFECYCLE,
      createRegimeEngine, createEngineCallbacks: () => ({}),
      startMarketDataService: async () => ({ success: true }), fenceMarketDataService: async () => ({ drained: true }),
      wireMarketDataCallbacks: () => {}, invalidateStandaloneLedger: () => {},
      saveRegimeRunningFlag: (_, pair, isRunning) => fs.writeFileSync(flagFile(pair), JSON.stringify({ isRunning })),
      setTimer: (run, delay) => { const id = ++timerId; timers.set(id, { run, delay }); return id; },
      clearTimer: (id) => timers.delete(id),
    });
    registerEngineBackupHandlers(registry, {
      regimeEngines, getMarketFunds: () => [], stopMarketServices: () => {}, drainMarketStarts: async () => {},
      drainPendingWrites: (_, matches) => drainPendingWrites(0, matches), startMarketService: async () => ({ success: true }),
      resumeFund: lifecycle.resumeAfterBackup, getStartStatus: lifecycle.getStartStatus, drainStarts: lifecycle.settleStarts,
      logger,
    });
    const replies = [];
    const client = ipc({ request: async (channel, payload) => {
      const refusal = refuseDuringMaintenance(channel);
      const result = refusal || await (channel === 'engine:maintenance' ? setEngineMaintenance(payload) : handlers.get(channel)());
      replies.push({ channel, result });
      return result;
    } });
    t.after(async () => {
      await lifecycle.cancelStarts({ shutdown: true });
      fs.rmSync(root, { recursive: true, force: true });
    });
    return {
      ...lifecycle, handlers, regimeEngines, timers, plans, starts, readFlag, replies,
      stop: (pair) => handlers.get('regime:stop')({}, 'coinbase', pair),
      resume: () => handlers.get('engine:backup-resume')(),
      backup: (kind) => run({ kind, exchangeIPCMap: { coinbase: client },
        create: () => (kind === 'archive' ? createBackup({ paths }) : createFundStateBackup({ paths })) }),
      fire: async () => {
        const [id, timer] = timers.entries().next().value;
        timers.delete(id);
        timer.run();
        await settle(); await settle();
      },
      bootAll: async () => { for (const pair of PAIRS) assert.equal((await lifecycle.autoResumeFund('coinbase', pair)).success, true); },
    };
  };

  for (const kind of ['fund-state', 'archive']) {
    it(`${kind} backup + transient restart failure retries once after maintenance ends`, async (t) => {
      const w = supervisedWorkflow(t);
      await w.bootAll();
      w.plans.get('BTC-USDC').push(transient());
      const result = await w.backup(kind);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(result.warnings, ['Engine coinbase failed to resume after backup'], 'the initial failure stays visible');
      const reply = w.replies.find(({ channel }) => channel === 'engine:backup-resume').result;
      assert.equal(reply.success, false);
      assert.equal(reply.failures.length, 1);
      assert.equal(reply.failures[0].pair, 'BTC-USDC');
      assert.equal(reply.failures[0].recovering, true);
      // Healthy fund resumed independently; the failed one is pending, not lost.
      assert.equal(w.getStartStatus('coinbase', 'ETH-USDC').state, 'running');
      assert.equal(w.regimeEngines.has('coinbase::ETH-USDC'), true);
      assert.equal(w.regimeEngines.has('coinbase::BTC-USDC'), false);
      assert.equal(w.getStartStatus('coinbase', 'BTC-USDC').state, 'retrying');
      assert.equal(w.readFlag('BTC-USDC'), true, 'desired-running intent survives');
      assert.equal(w.timers.size, 1, 'exactly one retry timer');

      const repeat = await w.resume();
      assert.equal(repeat.success, false, 'a repeat resume does not claim restored service');
      assert.equal(repeat.failures[0].recovering, true);

      // Another maintenance window defers the retry without attempting.
      const btcStarts = w.starts.get('BTC-USDC');
      setEngineMaintenance({ active: true, reason: 'backup later' });
      await w.fire();
      assert.equal(w.starts.get('BTC-USDC'), btcStarts);
      assert.equal(w.timers.size, 1);
      setEngineMaintenance({ active: false });
      await w.fire();
      assert.equal(w.starts.get('BTC-USDC'), btcStarts + 1, 'resumes exactly once after recovery');
      assert.equal(w.getStartStatus('coinbase', 'BTC-USDC').state, 'running');
      assert.equal(w.regimeEngines.has('coinbase::BTC-USDC'), true);
      assert.equal(w.timers.size, 0);
      assert.deepEqual(await w.resume(), { success: true });
      assert.equal(w.starts.get('ETH-USDC'), 2, 'healthy fund started at boot and once after backup');
    });
  }

  it('explicit stop cancels pending recovery and clears durable resume intent', async (t) => {
    const w = supervisedWorkflow(t);
    await w.bootAll();
    w.plans.get('BTC-USDC').push(transient());
    await w.backup('fund-state');
    assert.equal(w.timers.size, 1);
    const stale = [...w.timers.values()][0].run;
    assert.equal((await w.stop('BTC-USDC')).success, true);
    assert.equal(w.timers.size, 0);
    assert.equal(w.readFlag('BTC-USDC'), false);
    const before = w.starts.get('BTC-USDC');
    stale();
    await settle();
    assert.equal(w.starts.get('BTC-USDC'), before, 'a cancelled retry never starts');
    assert.deepEqual(await w.resume(), { success: true }, 'operator stop is not reported as pending recovery');
  });

  it('shutdown cancels pending recovery', async (t) => {
    const w = supervisedWorkflow(t);
    await w.bootAll();
    w.plans.get('BTC-USDC').push(transient());
    await w.backup('fund-state');
    await w.cancelStarts({ shutdown: true });
    assert.equal(w.timers.size, 0);
  });

  it('keeps permanent restart failures operator-blocked', async (t) => {
    const w = supervisedWorkflow(t);
    await w.bootAll();
    w.plans.get('BTC-USDC').push(Object.assign(new Error('unauthorized'), { status: 401 }));
    const result = await w.backup('fund-state');
    assert.deepEqual(result.warnings, ['Engine coinbase failed to resume after backup']);
    assert.equal(w.getStartStatus('coinbase', 'BTC-USDC').state, 'blocked');
    assert.equal(w.timers.size, 0);
    const repeat = await w.resume();
    assert.equal(repeat.success, false);
    assert.equal(repeat.failures[0].recovering, undefined, 'blocked is distinct from pending recovery');
  });

  it('a retry in flight when the next backup pauses settles before capture', async (t) => {
    const w = supervisedWorkflow(t);
    await w.bootAll();
    w.plans.get('BTC-USDC').push(transient());
    await w.backup('fund-state');
    const gate = deferred();
    w.plans.get('BTC-USDC').push(gate.promise);
    await w.fire();
    assert.equal(w.getStartStatus('coinbase', 'BTC-USDC').state, 'starting');
    const backup = w.backup('fund-state');
    await settle();
    gate.resolve({ success: true });
    const result = await backup;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.warnings, undefined);
    assert.equal(w.getStartStatus('coinbase', 'BTC-USDC').state, 'running');
    assert.equal(w.regimeEngines.has('coinbase::BTC-USDC'), true);
    assert.equal(w.timers.size, 0);
  });
});
