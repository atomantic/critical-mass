// @ts-check
/**
 * Issue #429 — a backup restore must not overwrite live data files until every
 * writer has CONFIRMED it stopped.
 *
 * Covers:
 *  - src/restore-coordinator.js: rejected / timed-out / negative / malformed
 *    stop acknowledgements block the restore with zero destination writes.
 *  - src/engine-stop-all.js: a fund whose stop() rejects is reported failed and
 *    stays owned by the engine process.
 *  - src/restore-maintenance.js: concurrent mutations and a second restore
 *    cannot slip through while a restore holds the lock.
 *  - src/routes/settings-routes.js: the route is wired to the gate.
 *  - src/regime-engine.js: stop() still tears down timers when a state save throws.
 *
 * No PM2, no live data files: IPC, the archive applier and UpDown are stubs,
 * and the one real engine uses a throwaway pair whose dir is deleted after.
 */
const { describe, it, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { performRestore, classifyStopAck } = require('../src/restore-coordinator');
const { stopAllRegimeEngines } = require('../src/engine-stop-all');
const maintenance = require('../src/restore-maintenance');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Adapt an UpDown-shaped service (stop/start) to the coordinator's gateway
 * writer descriptor.
 * @param {{stop: Function, start: Function}} service - Service under test
 * @returns {Array<{name: string, stop: Function, resume: Function}>} Writer list
 */
const updownWriter = (service) => [{ name: 'UpDown', stop: () => service.stop(), resume: () => service.start() }];

const okIPC = (stopped = [{ exchange: 'coinbase', pair: 'BTC-USDC' }]) => ({
  isConnected: () => true,
  request: async () => ({ success: true, stopped }),
});

/**
 * Run a restore whose engine acknowledgements all confirm, recording every
 * archive application so tests can assert "exactly once" / "never".
 * @param {Object} [over] - Overrides for the default all-confirmed setup
 * @returns {Promise<{status: number, body: Object, restoreCalls: string[]}>} Result + applied filenames
 */
const runRestore = async (over = {}) => {
  const restoreCalls = [];
  const apply = over.restore || (() => ({ success: true, filesRestored: 7 }));
  const result = await performRestore({
    filename: 'backup-2026-01-01.zip',
    exchangeIPCMap: { coinbase: okIPC() },
    configuredExchanges: ['coinbase'],
    logger: silentLogger,
    stopTimeoutMs: 50,
    ...over,
    restore: (filename) => { restoreCalls.push(filename); return apply(filename); },
  });
  return { ...result, restoreCalls };
};

describe('restore writer quiescence gate', () => {
  afterEach(() => {
    maintenance.endMaintenance();
    mock.restoreAll();
  });

  it('blocks the restore and writes nothing when the stop request rejects', async () => {
    const restoreCalls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: { isConnected: () => true, request: async () => { throw new Error('socket hang up'); } } },
      configuredExchanges: ['coinbase'],
      restore: (f) => { restoreCalls.push(f); return { success: true, filesRestored: 9 }; },
      logger: silentLogger,
    });

    assert.equal(status, 409);
    assert.equal(body.success, false);
    assert.equal(body.code, 'writers-not-quiesced');
    assert.deepEqual(body.unconfirmed.map((u) => u.reason), ['stop-request-failed']);
    assert.match(body.unconfirmed[0].error, /socket hang up/);
    assert.deepEqual(restoreCalls, [], 'restore must not touch destination files');
    assert.equal(maintenance.isMaintenanceActive(), false, 'maintenance lock released');
  });

  it('treats an IPC timeout as "still writing", never as stopped', async () => {
    const restoreCalls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: { isConnected: () => true, request: async () => { throw new Error('IPC request timeout: regime:stop-all (coinbase)'); } } },
      configuredExchanges: ['coinbase'],
      restore: (f) => { restoreCalls.push(f); return { success: true, filesRestored: 9 }; },
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.equal(body.unconfirmed[0].reason, 'stop-request-failed');
    assert.deepEqual(restoreCalls, []);
  });

  it('treats a disconnected IPC client as unknown, not as stopped', async () => {
    const restoreCalls = [];
    let requested = false;
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { gemini: { isConnected: () => false, request: async () => { requested = true; return { success: true, stopped: [] }; } } },
      configuredExchanges: ['gemini'],
      restore: (f) => { restoreCalls.push(f); return { success: true, filesRestored: 3 }; },
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.equal(body.unconfirmed[0].reason, 'ipc-disconnected');
    assert.equal(requested, false);
    assert.deepEqual(restoreCalls, []);
  });

  it('blocks on a negative acknowledgement and surfaces the failed funds', async () => {
    const restoreCalls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: {
        coinbase: {
          isConnected: () => true,
          request: async () => ({ success: false, stopped: [], failed: [{ exchange: 'coinbase', pair: 'BTC-USDC', error: 'ENOSPC' }] }),
        },
      },
      configuredExchanges: ['coinbase'],
      restore: (f) => { restoreCalls.push(f); return { success: true, filesRestored: 3 }; },
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.equal(body.unconfirmed[0].reason, 'stop-reported-failure');
    assert.deepEqual(body.unconfirmed[0].failedFunds, [{ exchange: 'coinbase', pair: 'BTC-USDC', error: 'ENOSPC' }]);
    assert.deepEqual(restoreCalls, []);
  });

  it('rejects malformed acknowledgements rather than reading them as success', () => {
    for (const ack of [null, undefined, 'ok', 42, [], { stopped: [] }, { success: 'true', stopped: [] }]) {
      assert.equal(classifyStopAck(ack).confirmed, false, `ack ${JSON.stringify(ack)} must not confirm`);
    }
    // success without the stopped list is shapeless — refuse it too.
    assert.equal(classifyStopAck({ success: true }).confirmed, false);
    assert.equal(classifyStopAck({ success: true, stopped: [] }).confirmed, true);
    // Self-contradictory ack: believe the failures, not the success flag.
    const contradictory = classifyStopAck({ success: true, stopped: [], failed: [{ pair: 'BTC-USDC', error: 'EIO' }] });
    assert.equal(contradictory.confirmed, false);
    assert.equal(contradictory.reason, 'stop-reported-failure');
  });

  it('applies the archive once when every configured engine confirms', async () => {
    const { status, body, restoreCalls } = await runRestore();
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.filesRestored, 7);
    assert.deepEqual(body.stoppedEngines, ['coinbase BTC-USDC']);
    assert.deepEqual(restoreCalls, ['backup-2026-01-01.zip']);
    assert.equal(maintenance.isMaintenanceActive(), false);
  });

  it('only requires acknowledgement from configured exchanges', async () => {
    const { status, restoreCalls } = await runRestore({
      exchangeIPCMap: { coinbase: okIPC(), cryptocom: { isConnected: () => false, request: async () => { throw new Error('never'); } } },
      configuredExchanges: ['coinbase'],
    });
    assert.equal(status, 200);
    assert.equal(restoreCalls.length, 1);
  });

  it('force applies past unconfirmed writers but reports them', async () => {
    const restoreCalls = [];
    const { status, body } = await performRestore({
      filename: 'backup-x.zip',
      force: true,
      exchangeIPCMap: { coinbase: { isConnected: () => false, request: async () => ({}) } },
      configuredExchanges: ['coinbase'],
      restore: (f) => { restoreCalls.push(f); return { success: true, filesRestored: 2 }; },
      logger: silentLogger,
    });
    assert.equal(status, 200);
    assert.equal(body.forced, true);
    assert.equal(body.unconfirmed[0].reason, 'ipc-disconnected');
    assert.deepEqual(restoreCalls, ['backup-x.zip']);
  });
});

describe('restore drains and reloads the gateway UpDown writer', () => {
  afterEach(() => maintenance.endMaintenance());

  it('stops UpDown before applying files and reloads it after', async () => {
    const order = [];
    const updownService = {
      stop: () => order.push('updown-stop'),
      start: async () => { order.push('updown-start'); },
    };
    const { status } = await runRestore({
      gatewayWriters: updownWriter(updownService),
      restore: (f) => { order.push(`restore:${f}`); return { success: true, filesRestored: 1 }; },
    });
    assert.equal(status, 200);
    assert.deepEqual(order, ['updown-stop', 'restore:backup-2026-01-01.zip', 'updown-start']);
  });

  it('leaves UpDown untouched when the gate blocks the restore', async () => {
    const order = [];
    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: { isConnected: () => true, request: async () => { throw new Error('nope'); } } },
      configuredExchanges: ['coinbase'],
      restore: () => { order.push('restore'); return { success: true, filesRestored: 1 }; },
      gatewayWriters: updownWriter({ stop: () => order.push('updown-stop'), start: async () => order.push('updown-start') }),
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.deepEqual(order, []);
  });

  it('reports a failed UpDown reload as a warning without claiming a clean restore path', async () => {
    const { status, body } = await runRestore({
      gatewayWriters: updownWriter({ stop: () => {}, start: async () => { throw new Error('scorecard hydration failed'); } }),
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.match(body.warnings[0], /scorecard hydration failed/);
  });

  it('restarts UpDown and releases the lock when the applier throws mid-copy', async () => {
    const order = [];
    const { status, body } = await runRestore({
      gatewayWriters: updownWriter({ stop: () => order.push('stop'), start: async () => order.push('start') }),
      restore: () => { throw new Error('ENOSPC: no space left on device'); },
    });
    assert.equal(status, 500);
    assert.equal(body.code, 'restore-failed');
    assert.match(body.error, /ENOSPC/);
    assert.deepEqual(order, ['stop', 'start']);
    assert.equal(maintenance.isMaintenanceActive(), false, 'a thrown applier must not leak the lock');
  });

  it('restarts UpDown even when applying the archive fails', async () => {
    const order = [];
    const { status, body } = await runRestore({
      gatewayWriters: updownWriter({ stop: () => order.push('stop'), start: async () => order.push('start') }),
      restore: () => ({ success: false, error: 'unzip: bad archive' }),
    });
    assert.equal(status, 500);
    assert.equal(body.code, 'restore-failed');
    assert.deepEqual(order, ['stop', 'start']);
  });
});

describe('maintenance lock', () => {
  afterEach(() => maintenance.endMaintenance());

  it('rejects a second concurrent restore with a structured 409', async () => {
    let release;
    const slow = performRestore({
      filename: 'first.zip',
      exchangeIPCMap: { coinbase: { isConnected: () => true, request: (channel) => (
        // Only the stop acknowledgement is held open; the maintenance window
        // handshake resolves immediately so the lock is genuinely held while
        // the second restore arrives.
        channel === 'engine:maintenance'
          ? Promise.resolve({ success: true })
          : new Promise((r) => { release = () => r({ success: true, stopped: [] }); })
      ) } },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: true, filesRestored: 1 }),
      logger: silentLogger,
    });
    const second = await performRestore({
      filename: 'second.zip',
      exchangeIPCMap: {},
      configuredExchanges: [],
      restore: () => { throw new Error('second restore must never apply'); },
      logger: silentLogger,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'restore-already-running');
    // The held restore reaches `regime:stop-all` a few turns of the loop after
    // the maintenance-window handshake; wait for it rather than racing it.
    for (let i = 0; i < 50 && !release; i++) await new Promise(r => setImmediate(r));
    release();
    assert.equal((await slow).status, 200);
  });

  it('blocks mutating API requests while held and lets reads through', () => {
    const call = (method, reqPath) => {
      let sent = null;
      let nexted = false;
      maintenance.maintenanceGuard(
        /** @type {any} */ ({ method, path: reqPath }),
        /** @type {any} */ ({ status(code) { sent = { code }; return this; }, json(body) { sent.body = body; return this; } }),
        () => { nexted = true; }
      );
      return { sent, nexted };
    };

    assert.equal(call('POST', '/regime/start').nexted, true, 'no lock held → pass through');

    assert.equal(maintenance.beginMaintenance('restore b.zip').acquired, true);
    const blocked = call('POST', '/regime/start');
    assert.equal(blocked.nexted, false);
    assert.equal(blocked.sent.code, 503);
    assert.equal(blocked.sent.body.code, 'maintenance-in-progress');

    assert.equal(call('GET', '/backups').nexted, true, 'reads stay available');
    assert.equal(call('POST', '/backups/backup-1.zip/restore').nexted, true, 'restore route owns the lock');
    assert.equal(maintenance.beginMaintenance('another').acquired, false);
  });
});

describe('engine stop-all honesty', () => {
  const makeDeps = () => {
    const flags = [];
    return {
      flags,
      deps: {
        logger: () => ({ info: () => {}, error: () => {} }),
        label: (e, p) => `${e} ${p}`,
        setRunningFlag: (e, p, running) => flags.push({ e, p, running }),
      },
    };
  };

  it('retains ownership of a fund whose stop rejected and reports it failed', async () => {
    const broken = { stop: async () => { throw new Error('ENOSPC: no space left on device'); } };
    const healthy = { stop: async () => {} };
    const engines = new Map([['coinbase::BTC-USDC', broken], ['coinbase::ETH-USDC', healthy]]);
    const { flags, deps } = makeDeps();

    const result = await stopAllRegimeEngines(engines, deps);

    assert.equal(result.success, false);
    assert.deepEqual(result.stopped, [{ exchange: 'coinbase', pair: 'ETH-USDC' }]);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /ENOSPC/);
    assert.deepEqual([...engines.keys()], ['coinbase::BTC-USDC'], 'failed engine stays owned');
    assert.deepEqual(flags, [{ e: 'coinbase', p: 'ETH-USDC', running: false }], 'no resume flag cleared for the live engine');
  });

  it('reports success and empties the registry when every fund stops', async () => {
    const engines = new Map([['gemini::BTCUSD', { stop: async () => {} }]]);
    const { deps } = makeDeps();
    const result = await stopAllRegimeEngines(engines, deps);
    assert.deepEqual(result, { success: true, stopped: [{ exchange: 'gemini', pair: 'BTCUSD' }], failed: [] });
    assert.equal(engines.size, 0);
  });

  it('treats a synchronously throwing stop() as a failure, not a crash', async () => {
    const engines = new Map([['coinbase::BTC-USDC', { stop: () => { throw new Error('boom'); } }]]);
    const { deps } = makeDeps();
    const result = await stopAllRegimeEngines(engines, /** @type {any} */ (deps));
    assert.equal(result.success, false);
    assert.equal(engines.size, 1);
  });
});

describe('a drained writer cannot resurrect its pre-restore snapshot', () => {
  /** Minimal stand-in for UpDown: a periodic writer with in-memory state. */
  const createPendingWriter = (file) => {
    let state = JSON.parse(fs.readFileSync(file, 'utf8'));
    let timer = null;
    const persist = () => fs.writeFileSync(file, JSON.stringify(state));
    return {
      start: async () => { state = JSON.parse(fs.readFileSync(file, 'utf8')); timer = setInterval(persist, 1); timer.unref(); },
      stop: () => { if (timer) clearInterval(timer); timer = null; persist(); },
      tick: persist,
      snapshot: () => state,
    };
  };

  it('reloads the restored file so the next persist writes restored state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-restore-429-'));
    const file = path.join(dir, 'updown-state.json');
    fs.writeFileSync(file, JSON.stringify({ position: 'PRE-RESTORE' }));

    const writer = createPendingWriter(file);
    await writer.start();

    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: okIPC() },
      configuredExchanges: ['coinbase'],
      gatewayWriters: updownWriter(writer),
      restore: () => { fs.writeFileSync(file, JSON.stringify({ position: 'RESTORED' })); return { success: true, filesRestored: 1 }; },
      logger: silentLogger,
    });
    assert.equal(status, 200);

    // The writer is live again — its next save must carry restored state.
    writer.tick();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { position: 'RESTORED' });
    assert.deepEqual(writer.snapshot(), { position: 'RESTORED' });

    writer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('settings route is wired to the quiescence gate', () => {
  const configUtils = require('../src/config-utils');
  const registerSettingsRoutes = require('../src/routes/settings-routes');

  const BASE_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
  const CONFIG = { exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC' } } } } };

  const setup = (ipc) => {
    configUtils._resetConfigCacheForTests();
    mock.method(fs, 'existsSync', (p) => p === BASE_CONFIG_FILE);
    mock.method(fs, 'readFileSync', (p) => {
      if (p === BASE_CONFIG_FILE) return JSON.stringify(CONFIG);
      throw new Error(`ENOENT: ${p}`);
    });
    let mtime = 0;
    mock.method(fs, 'statSync', (p) => {
      if (p === BASE_CONFIG_FILE) return { mtimeMs: ++mtime };
      const err = new Error(`ENOENT: ${p}`);
      // @ts-expect-error test fixture
      err.code = 'ENOENT';
      throw err;
    });

    let handler;
    const app = {
      get: () => {}, put: () => {}, delete: () => {},
      post: (route, fn) => { if (route === '/api/backups/:filename/restore') handler = fn; },
    };
    registerSettingsRoutes(app, { exchangeIPCMap: { coinbase: ipc }, rescheduleBackupTimer: () => {} });
    return async (body = {}) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ params: { filename: 'backup-2026-01-01.zip' }, body }, res);
      return res;
    };
  };

  afterEach(() => {
    mock.restoreAll();
    maintenance.endMaintenance();
    configUtils._resetConfigCacheForTests();
  });

  it('returns 409 without attempting extraction when the engine will not confirm', async () => {
    const invoke = setup({ isConnected: () => true, request: async () => { throw new Error('socket hang up'); } });
    const res = await invoke();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'writers-not-quiesced');
  });

  it('proceeds to the archive applier once the engine confirms', async () => {
    // existsSync is mocked false for the archive, so restoreBackup reports
    // "Backup not found" — reaching that error proves the gate let it through.
    const invoke = setup(okIPC());
    const res = await invoke();
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'restore-failed');
    assert.equal(res.body.error, 'Backup not found');
    assert.deepEqual(res.body.stoppedEngines, ['coinbase BTC-USDC']);
  });

  it('forwards an explicit force override from the request body', async () => {
    const invoke = setup({ isConnected: () => false, request: async () => ({}) });
    assert.equal((await invoke()).statusCode, 409);
    const forced = await invoke({ force: true });
    assert.equal(forced.statusCode, 500, 'force skips the gate and reaches the applier');
    assert.equal(forced.body.code, 'restore-failed');
  });
});

describe('regime engine stop tears down timers even when the state save throws', () => {
  const TEST_PAIR = '__test429__';
  const JUNK_DIR = path.join(__dirname, '..', 'data', 'coinbase', TEST_PAIR);

  after(() => {
    mock.restoreAll();
    fs.rmSync(JUNK_DIR, { recursive: true, force: true });
  });

  it('runs cleanup and still propagates the failure to the caller', async () => {
    const { createRegimeEngine } = require('../src/regime-engine');
    const dryRunState = require('../src/dry-run-state');

    const engine = createRegimeEngine('coinbase', TEST_PAIR, { dryRun: true, productId: TEST_PAIR }, {});
    let clearedTimers = 0;
    engine._test.setOrderExecutor({ clearTimers: () => { clearedTimers++; }, exportState: () => ({}) });
    engine._test.setRunning(true);

    mock.method(dryRunState, 'forceSave', () => { throw new Error('EROFS: read-only file system'); });

    const err = await engine.stop().then(() => null, (e) => e);
    assert.ok(err, 'stop must not swallow the persistence failure');
    assert.match(err.message, /EROFS/);
    assert.equal(clearedTimers, 1, 'order executor timers cleared despite the throw');
    assert.equal(engine._test.getFlags().isRunning, false);
  });
});

describe('restore joins gateway work that was already in flight', () => {
  const { trackPendingWrite, drainPendingWrites, getPendingWrites } = require('../src/pending-writes');

  afterEach(() => maintenance.endMaintenance());

  /** @returns {{promise: Promise<string>, finish: Function, fail: Function}} A cycle the test controls */
  const controllableCycle = (label = 'dca-cycle:coinbase') => {
    let finish;
    let fail;
    const gate = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const promise = trackPendingWrite(label, () => gate);
    return { promise, finish, fail };
  };

  it('blocks the restore when a scheduled cycle is still running after the drain window', async () => {
    const cycle = controllableCycle();
    const { status, body, restoreCalls } = await runRestore({ drainPendingWrites, drainTimeoutMs: 20 });

    assert.equal(status, 409);
    assert.equal(body.code, 'writers-not-quiesced');
    assert.deepEqual(restoreCalls, [], 'an in-flight cycle must leave every destination file untouched');
    const gateway = body.unconfirmed.find(u => u.exchange === 'gateway');
    assert.equal(gateway.reason, 'pending-writes-in-flight');
    assert.deepEqual(gateway.pendingWrites.map(w => w.label), ['dca-cycle:coinbase']);

    cycle.finish('done');
    await cycle.promise;
  });

  it('applies the archive once the in-flight cycle finishes', async () => {
    const cycle = controllableCycle();
    setTimeout(() => cycle.finish('done'), 5);
    const { status, restoreCalls } = await runRestore({ drainPendingWrites, drainTimeoutMs: 1_000 });

    assert.equal(status, 200);
    assert.deepEqual(restoreCalls, ['backup-2026-01-01.zip']);
    await cycle.promise;
  });

  it('treats a cycle that threw as drained — it is no longer writing', async () => {
    const cycle = controllableCycle();
    // The caller's own rejection handler; without it node would abort the run.
    const observed = cycle.promise.catch(err => err.message);
    setTimeout(() => cycle.fail(new Error('exchange 500')), 5);

    const { status, restoreCalls } = await runRestore({ drainPendingWrites, drainTimeoutMs: 1_000 });
    assert.equal(status, 200);
    assert.deepEqual(restoreCalls, ['backup-2026-01-01.zip']);
    assert.equal(await observed, 'exchange 500');
  });

  it('force applies past work that will not drain, and says so', async () => {
    const cycle = controllableCycle();
    const { status, body } = await runRestore({ drainPendingWrites, drainTimeoutMs: 20, force: true });

    assert.equal(status, 200);
    assert.equal(body.forced, true);
    assert.ok(body.unconfirmed.some(u => u.reason === 'pending-writes-in-flight'));

    cycle.finish('done');
    await cycle.promise;
  });

  it('stops tracking a write as soon as it settles', async () => {
    const cycle = controllableCycle('dca-consolidation:gemini');
    assert.deepEqual(getPendingWrites().map(w => w.label), ['dca-consolidation:gemini']);
    cycle.finish('done');
    await cycle.promise;
    assert.deepEqual(getPendingWrites(), []);
    assert.deepEqual(await drainPendingWrites(5), { drained: true, pending: [] });
  });

  it('wraps the exported DCA entry points so the scheduler is visible to the drain', () => {
    // Invoking the real cycle here would talk to an exchange and write state
    // files, so assert the wiring instead: both mutating entry points must be
    // exported through the tracker, not as the raw implementations.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'dca-engine.js'), 'utf8');
    const exportsBlock = source.slice(source.lastIndexOf('module.exports = {'));
    assert.match(exportsBlock, /runIntervalCycle:[\s\S]*?trackPendingWrite\(`dca-cycle:/);
    assert.match(exportsBlock, /executeConsolidation:[\s\S]*?trackPendingWrite\(`dca-consolidation:/);
  });
});

describe('restore drains and reloads the sentinel writer', () => {
  const { createSentinelService } = require('../src/sentinel/sentinel-service');

  afterEach(() => maintenance.endMaintenance());

  it('reloads restored alerts instead of writing its pre-restore snapshot back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sentinel-429-'));
    const stateFile = path.join(dir, 'sentinel-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ alerts: [{ id: 'pre', dismissed: false }], seenGuids: { pre: Date.now() } }));

    const io = { to: () => ({ emit: () => {} }) };
    const sentinel = createSentinelService(io, {
      readJSON: (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback),
      writeJSON: (f, data) => fs.writeFileSync(f, JSON.stringify(data)),
      DATA_DIR: dir,
      // Disabled: start() must stay a no-op and the reload must happen anyway.
      getSentinelConfig: () => ({ enabled: false, maxAlerts: 200 }),
      fetchAllFeeds: async () => [],
    });
    assert.equal(sentinel.getStatus().totalAlerts, 1, 'pre-restore state is loaded eagerly');

    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: okIPC() },
      configuredExchanges: ['coinbase'],
      gatewayWriters: [{
        name: 'Sentinel',
        stop: () => sentinel.stop(),
        resume: () => { sentinel.reloadState(); sentinel.start(); },
      }],
      restore: () => {
        fs.writeFileSync(stateFile, JSON.stringify({ alerts: [{ id: 'restored', dismissed: false }], seenGuids: {} }));
        return { success: true, filesRestored: 1 };
      },
      logger: silentLogger,
    });
    assert.equal(status, 200);
    assert.deepEqual(sentinel.getAlerts().map(a => a.id), ['restored']);

    // The next persist (any dismiss/clear from the API) must carry restored state.
    sentinel.clearAlerts();
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).alerts, []);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('restore invalidates in-memory views of the restored files', () => {
  afterEach(() => maintenance.endMaintenance());

  it('drops caches after applying the archive and before releasing the lock', async () => {
    const order = [];
    const { status } = await runRestore({
      restore: (f) => { order.push(`restore:${f}`); return { success: true, filesRestored: 1 }; },
      invalidateCaches: () => {
        order.push('invalidate');
        assert.equal(maintenance.isMaintenanceActive(), true, 'caches must be dropped while the lock is still held');
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(order, ['restore:backup-2026-01-01.zip', 'invalidate']);
  });

  it('reports a failed invalidation as a warning rather than swallowing it', async () => {
    const { status, body } = await runRestore({
      invalidateCaches: () => { throw new Error('seed fetch refused'); },
    });
    assert.equal(status, 200);
    assert.match(body.warnings.join(' '), /seed fetch refused/);
  });

  it('leaves caches alone when the gate blocks the restore', async () => {
    let invalidated = 0;
    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: { isConnected: () => true, request: async () => ({ success: false }) } },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: true, filesRestored: 1 }),
      invalidateCaches: () => { invalidated++; },
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.equal(invalidated, 0);
  });

  it('empties the shared candle cache so a pre-restore series is never served on', async () => {
    const { createCandleCache } = require('../src/candle-cache');
    const cache = createCandleCache();
    cache.processTick('coinbase', 100, Date.now(), 1);
    assert.ok(cache.getAggregator('coinbase').getCurrentCandle('1m'), 'cache is populated pre-restore');

    // reseed: false keeps the public APIs out of the suite; the behaviour under
    // test is that nothing pre-restore survives the call.
    await cache.invalidate({ reseed: false });
    assert.deepEqual(cache.getAllCandles('coinbase'), {});
  });
});

describe('engine-side maintenance window', () => {
  const engineMaintenance = require('../src/engine-maintenance');

  afterEach(() => engineMaintenance.setEngineMaintenance({ active: false }));

  it('refuses mutating channels and keeps reads and the stop path open', () => {
    engineMaintenance.setEngineMaintenance({ active: true, reason: 'restore backup-1.zip' });

    const refusal = engineMaintenance.refuseDuringMaintenance('regime:start');
    assert.equal(refusal.success, false);
    assert.equal(refusal.code, 'maintenance-in-progress');
    assert.match(refusal.error, /restore backup-1\.zip/);

    for (const channel of ['regime:stop-all', 'regime:stop', 'regime:status', 'engine:maintenance']) {
      assert.equal(engineMaintenance.refuseDuringMaintenance(channel), null, `${channel} must stay available`);
    }
    // Every other mutating channel is refused by default (allowlist, not denylist).
    for (const channel of ['regime:rebuild-ladder', 'regime:manual-trade', 'regime:reset-cycle', 'regime:convert-dca']) {
      assert.equal(engineMaintenance.refuseDuringMaintenance(channel).code, 'maintenance-in-progress');
    }
  });

  it('allows everything again once the window is closed', () => {
    engineMaintenance.setEngineMaintenance({ active: true, reason: 'restore' });
    engineMaintenance.setEngineMaintenance({ active: false });
    assert.equal(engineMaintenance.refuseDuringMaintenance('regime:start'), null);
    assert.equal(engineMaintenance.getEngineMaintenance(), null);
  });

  it('expires on its own so a gateway that dies mid-restore cannot brick the engine', () => {
    engineMaintenance.setEngineMaintenance({ active: true, reason: 'restore', ttlMs: 1 });
    const { expiresAt } = engineMaintenance.getEngineMaintenance();
    assert.ok(expiresAt <= Date.now() + 1);
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 5 });
    assert.equal(engineMaintenance.getEngineMaintenance(), null);
    assert.equal(engineMaintenance.refuseDuringMaintenance('regime:start'), null);
    mock.timers.reset();
  });

  it('clamps an absurd TTL instead of trusting the payload', () => {
    engineMaintenance.setEngineMaintenance({ active: true, ttlMs: Number.MAX_SAFE_INTEGER });
    const { startedAt, expiresAt } = engineMaintenance.getEngineMaintenance();
    assert.equal(expiresAt - startedAt, engineMaintenance.MAX_MAINTENANCE_TTL_MS);
  });

  it('is opened before the engines are asked to stop and closed afterwards', async () => {
    const channels = [];
    const ipc = {
      isConnected: () => true,
      request: async (channel, payload) => {
        channels.push(`${channel}:${channel === 'engine:maintenance' ? payload.active : 'x'}`);
        return { success: true, stopped: [] };
      },
    };
    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: ipc },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: true, filesRestored: 1 }),
      logger: silentLogger,
    });
    assert.equal(status, 200);
    assert.deepEqual(channels, ['engine:maintenance:true', 'regime:stop-all:x', 'engine:maintenance:false']);
  });

  it('closes the window even when the restore is blocked or throws', async () => {
    const closes = [];
    const ipc = {
      isConnected: () => true,
      request: async (channel, payload) => {
        if (channel === 'engine:maintenance') { closes.push(payload.active); return { success: true }; }
        throw new Error('socket hang up');
      },
    };
    const { status } = await performRestore({
      filename: 'backup-x.zip',
      exchangeIPCMap: { coinbase: ipc },
      configuredExchanges: ['coinbase'],
      restore: () => ({ success: true, filesRestored: 1 }),
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.deepEqual(closes, [true, false], 'a blocked restore must not leave engines in maintenance');
  });
});

describe('engine IPC server enforces the maintenance window', () => {
  const { createIPCServer } = require('../src/ipc/ipc-server');
  const { createIPCClient } = require('../src/ipc/ipc-client');
  const engineMaintenance = require('../src/engine-maintenance');
  const PORT = 45_529;

  after(() => engineMaintenance.setEngineMaintenance({ active: false }));

  it('answers reads and refuses mutations while the gateway holds the window', async () => {
    const server = createIPCServer(PORT, 'test-engine');
    server.start();
    let started = 0;
    server.onRequest('regime:start', async () => { started++; return { success: true }; });
    server.onRequest('regime:status', async () => ({ success: true, status: 'ok' }));

    const client = createIPCClient(`ws://127.0.0.1:${PORT}`, 'test');
    client.connect();
    for (let i = 0; i < 100 && !client.isConnected(); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(client.isConnected(), 'IPC client connected');

    assert.deepEqual(await client.request('engine:maintenance', { active: true, reason: 'restore backup-1.zip' }, 'test', 1_000), {
      success: true,
      maintenance: engineMaintenance.getEngineMaintenance(),
    });

    const refused = await client.request('regime:start', {}, 'test', 1_000);
    assert.equal(refused.code, 'maintenance-in-progress');
    assert.equal(started, 0, 'the handler must never run during maintenance');

    const read = await client.request('regime:status', {}, 'test', 1_000);
    assert.equal(read.status, 'ok');

    await client.request('engine:maintenance', { active: false }, 'test', 1_000);
    assert.deepEqual(await client.request('regime:start', {}, 'test', 1_000), { success: true });
    assert.equal(started, 1);

    client.disconnect();
    server.stop();
  });
});

describe('release review restore failure boundaries', () => {
  afterEach(() => {
    maintenance.endMaintenance();
    mock.restoreAll();
  });

  it('refuses archive application when a gateway writer rejects shutdown', async () => {
    const order = [];
    const result = await runRestore({
      gatewayWriters: updownWriter({
        stop: async () => { order.push('stop'); throw new Error('writer still active'); },
        start: async () => { order.push('resume'); },
      }),
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'writers-not-quiesced');
    assert.equal(result.body.unconfirmed[0].reason, 'gateway-writer-stop-failed');
    assert.deepEqual(result.restoreCalls, []);
    assert.deepEqual(order, ['stop', 'resume']);
    assert.equal(maintenance.isMaintenanceActive(), false);
  });

  it('allows an explicit force override for failed gateway shutdown and reports it', async () => {
    const result = await runRestore({
      force: true,
      gatewayWriters: updownWriter({ stop: () => { throw new Error('failed drain'); }, start: () => {} }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.forced, true);
    assert.equal(result.body.unconfirmed[0].writer, 'UpDown');
    assert.equal(result.restoreCalls.length, 1);
  });

  it('keeps writers stopped and gateway mutations blocked after an incomplete rollback', async () => {
    const order = [];
    const recovery = { originalsDir: '.restore-originals-test' };
    const result = await runRestore({
      gatewayWriters: updownWriter({ stop: () => order.push('stop'), start: () => order.push('resume') }),
      restore: () => ({ success: false, code: 'restore-incomplete-recovery', error: 'rollback failed', rolledBack: false, recovery }),
    });
    assert.equal(result.status, 500);
    assert.equal(result.body.rolledBack, false);
    assert.deepEqual(result.body.recovery, recovery);
    assert.deepEqual(order, ['stop']);
    assert.equal(maintenance.isMaintenanceActive(), true);
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    maintenance.maintenanceGuard({ method: 'POST', path: '/coinbase/regime/start' }, response, () => assert.fail('mutation admitted'));
    assert.equal(response.code, 503);
  });

  it('blocks engine mutations on a durable journal even after the window closes', () => {
    const { JOURNAL_FILENAME } = require('../src/restore-apply');
    const { setEngineMaintenance, refuseDuringMaintenance } = require('../src/engine-maintenance');
    const { DATA_DIR } = require('../src/paths');
    const originalExists = fs.existsSync;
    const journalPath = path.join(DATA_DIR, JOURNAL_FILENAME);
    let pendingRecovery = true;
    mock.method(fs, 'existsSync', (file) => String(file) === journalPath ? pendingRecovery : originalExists(file));
    setEngineMaintenance({ active: false });
    assert.equal(refuseDuringMaintenance('regime:start').code, 'restore-incomplete-recovery');
    assert.equal(refuseDuringMaintenance('regime:status'), null);
    pendingRecovery = false;
    assert.equal(refuseDuringMaintenance('regime:start'), null);
  });
});
