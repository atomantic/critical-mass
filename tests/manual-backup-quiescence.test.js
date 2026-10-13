const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { performBackup } = require('../src/backup-coordinator');
const { trackPendingWrite, drainPendingWrites, getPendingWrites } = require('../src/pending-writes');
const maintenance = require('../src/restore-maintenance');
const backup = require('../src/backup-service');

const logger = { info() {}, warn() {}, error() {} };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Exercise the actual server registration wrapper and shared backup runner
// without starting listeners, PM2, real exchange clients, or live services.
const setup = (t, { disconnected = false, resumeFails = false, createFails = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-manual-backup-'));
  const paths = { dataDir: path.join(root, 'data'), baseConfigFile: path.join(root, 'base.json') };
  const fundDir = path.join(paths.dataDir, 'coinbase', 'BTC-USDC');
  fs.mkdirSync(fundDir, { recursive: true });
  fs.writeFileSync(paths.baseConfigFile, JSON.stringify({
    exchanges: { coinbase: { pairs: { 'BTC-USDC': { productId: 'BTC-USDC', enabled: true } } } },
  }));
  const events = [];
  const gates = [];
  const operations = [];
  let copies = 0;
  let prunes = 0;
  const write = (file, generation) => fs.writeFileSync(path.join(fundDir, file), JSON.stringify({ generation }));
  const service = (name, running) => ({
    getStatus: () => ({ running }),
    stop: async () => { events.push(`stop:${name}`); },
    start: async () => { events.push(`start:${name}`); },
  });
  const exchangeIPCMap = { coinbase: {
    isConnected: () => !disconnected,
    request: async (channel, payload) => {
      events.push(channel);
      if (channel === 'engine:maintenance') return { success: true, maintenance: payload.active ? { reason: payload.reason } : null };
      if (channel === 'engine:backup-resume' && resumeFails) return { success: false };
      return { success: true, quiesced: true };
    },
  } };
  const handlers = {};
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method,
    (url, handler) => { handlers[`${method} ${url}`] = handler; },
  ]));
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const wrapper = serverSource.slice(serverSource.indexOf('const shutdownRoutes ='), serverSource.indexOf('// ============ Middleware'));
  const runnerStart = serverSource.search(/const run(?:Scheduled)?Backup =/);
  assert.notEqual(runnerStart, -1, 'server must expose its backup runner');
  const runner = serverSource.slice(runnerStart, serverSource.indexOf('const rescheduleBackupTimer =', runnerStart));
  const runnerName = /const (run\w*Backup) =/.exec(runner)[1];
  const runtime = vm.runInNewContext(`${wrapper}\n${runner}\n({ routes, runBackup: ${runnerName} });`, {
    app, gatewayShutdown: { routes: () => app }, trackPendingWrite,
    performBackup, exchangeIPCMap, getConfiguredExchanges: () => ['coinbase'],
    // A short deadline makes accidental self-draining fail deterministically.
    drainPendingWrites: () => drainPendingWrites(100),
    updownService: service('updown', true), sentinelService: service('sentinel', false),
    createContextLogger: () => logger,
  });
  const routeFile = path.join(__dirname, '../src/routes/settings-routes.js');
  const routeRequire = createRequire(routeFile);
  const routeModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(routeFile, 'utf8'), {
    module: routeModule, exports: routeModule.exports,
    require: (name) => {
      if (name === '../backup-service') return { ...backup,
        createBackup: (options) => {
          copies++;
          events.push('archive');
          return createFails ? { success: false, error: 'Synthetic archive failure' } : backup.createBackup({ ...options, paths });
        },
        pruneBackups: () => { prunes++; return { pruned: 0, remaining: 1 }; },
      };
      if (name === '../config-utils') return { ...routeRequire(name),
        getBackupConfig: () => ({ maxBackups: 7, includePriceCache: false }),
        getConfiguredExchanges: () => ['coinbase'],
      };
      if (name === '../logger') return { createContextLogger: () => logger };
      return routeRequire(name);
    },
  }, { filename: routeFile });
  routeModule.exports(runtime.routes, {
    notifier: {}, exchangeIPCMap, rescheduleBackupTimer() {}, runBackup: runtime.runBackup,
  });
  const invoke = (requestPath = '/api/backups') => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const operation = Promise.resolve(handlers['post /api/backups']({ method: 'POST', path: requestPath, body: {} }, res))
      .then(() => res);
    operations.push(operation);
    return operation;
  };
  t.after(async () => {
    gates.forEach((gate) => gate.resolve());
    await Promise.allSettled(operations);
    await drainPendingWrites(100);
    maintenance.endMaintenance();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { paths, fundDir, events, write, invoke, copies: () => copies, prunes: () => prunes,
    pendingWriter: async () => {
      const gate = deferred();
      const entered = deferred();
      gates.push(gate);
      const operation = trackPendingWrite('api:PUT:synthetic-fund-state', async () => {
        write('fill-ledger.json', 2);
        entered.resolve();
        await gate.promise;
        write('regime-state.json', 2);
      });
      operations.push(operation);
      await entered.promise;
      return () => gate.resolve();
    },
  };
};

describe('manual backups use the server writer-quiescence gate', () => {
  for (const requestPath of ['/api/backups', '/API/BACKUPS/']) {
    it(`${requestPath} drains admitted work and restores one complete generation without draining itself`, async (t) => {
      const w = setup(t);
      w.write('regime-state.json', 1);
      const finishWriter = await w.pendingWriter();
      const pendingBackup = w.invoke(requestPath);
      await nextTurn();
      assert.equal(w.copies(), 0, 'no archive may be created before admitted writes finish');
      assert.equal(getPendingWrites().length, 1, 'the backup request must not register itself as a writer it drains');
      finishWriter();
      const res = await pendingBackup;
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(w.copies(), 1);
      assert.equal(w.prunes(), 1);
      w.write('fill-ledger.json', 3);
      w.write('regime-state.json', 3);
      assert.equal(backup.restoreBackup(res.body.filename, { paths: w.paths }).success, true);
      for (const file of ['fill-ledger.json', 'regime-state.json']) {
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.fundDir, file), 'utf8')), { generation: 2 });
      }
      assert.equal(maintenance.isMaintenanceActive(), false);
    });
  }

  it('refuses an unconfirmed engine without creating or pruning an archive', async (t) => {
    const w = setup(t, { disconnected: true });
    const res = await w.invoke();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'writers-not-quiesced');
    assert.equal(w.copies(), 0);
    assert.equal(w.prunes(), 0);
    assert.equal(maintenance.isMaintenanceActive(), false);
  });

  it('cannot capture or prune while another maintenance operation owns the lock', async (t) => {
    const w = setup(t);
    maintenance.beginMaintenance('restore existing archive');
    const res = await w.invoke();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'maintenance-in-progress');
    assert.equal(w.copies(), 0);
    assert.equal(w.prunes(), 0);
    assert.equal(maintenance.getMaintenanceState().reason, 'restore existing archive');
  });

  it('preserves stopped gateway services and returns engine resume warnings', async (t) => {
    const w = setup(t, { resumeFails: true });
    w.write('regime-state.json', 1);
    const res = await w.invoke();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Array.from(res.body.warnings), ['Engine coinbase failed to resume after backup']);
    assert.ok(w.events.includes('stop:updown'));
    assert.ok(w.events.includes('stop:sentinel'));
    assert.ok(w.events.includes('start:updown'));
    assert.ok(!w.events.includes('start:sentinel'), 'a previously stopped service stays stopped');
    assert.equal(maintenance.isMaintenanceActive(), false);
  });

  it('does not prune after archive creation fails and still resumes the writers', async (t) => {
    const w = setup(t, { createFails: true });
    const res = await w.invoke();
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'backup-failed');
    assert.equal(w.prunes(), 0);
    assert.ok(w.events.includes('engine:backup-resume'));
    assert.ok(w.events.includes('start:updown'));
    assert.equal(maintenance.isMaintenanceActive(), false);
  });
});
