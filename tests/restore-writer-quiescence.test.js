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
      updownService,
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
      updownService: { stop: () => order.push('updown-stop'), start: async () => order.push('updown-start') },
      logger: silentLogger,
    });
    assert.equal(status, 409);
    assert.deepEqual(order, []);
  });

  it('reports a failed UpDown reload as a warning without claiming a clean restore path', async () => {
    const { status, body } = await runRestore({
      updownService: { stop: () => {}, start: async () => { throw new Error('scorecard hydration failed'); } },
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.match(body.warnings[0], /scorecard hydration failed/);
  });

  it('restarts UpDown and releases the lock when the applier throws mid-copy', async () => {
    const order = [];
    const { status, body } = await runRestore({
      updownService: { stop: () => order.push('stop'), start: async () => order.push('start') },
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
      updownService: { stop: () => order.push('stop'), start: async () => order.push('start') },
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
      exchangeIPCMap: { coinbase: { isConnected: () => true, request: () => new Promise((r) => { release = () => r({ success: true, stopped: [] }); }) } },
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
      updownService: writer,
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
