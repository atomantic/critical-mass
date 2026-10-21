const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const protocol = require('../src/ipc/ipc-protocol');

// Evaluate the production modules with explicit dependency mocks. No real
// listener, exchange adapter, config, ledger or state file is reachable here.
const createHarness = (exchange = 'coinbase', failFirst = false, stopped = false) => {
  const servers = [];
  const logs = [];
  const calls = [];
  const owners = new Map();
  const hooks = {};
  const runningFlags = [];
  class MockServer extends EventEmitter {
    constructor(options) { super(); this.options = options; this.closed = false; servers.push(this); }
    bind() {
      if (owners.has(this.options.port)) {
        this.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
        return;
      }
      owners.set(this.options.port, this);
      this.emit('listening');
    }
    close(callback) {
      this.closed = true;
      if (owners.get(this.options.port) === this) owners.delete(this.options.port);
      this.emit('close');
      callback?.();
    }
  }
  const logger = { info: (message) => logs.push(message), warn: () => {}, error: () => {} };
  const ipcModule = { exports: {} };
  const ipcDependencies = {
    './ws-server': { WebSocketServer: MockServer, OPEN: 1 },
    '../pending-writes': { trackPendingWrite: (_, run) => Promise.resolve().then(run) },
    './ipc-protocol': protocol,
    '../logger': { createContextLogger: () => logger },
    '../engine-maintenance': { setEngineMaintenance: () => { calls.push('maintenance'); }, refuseDuringMaintenance: () => null },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ipc/ipc-server.js'), 'utf8'), {
    module: ipcModule,
    require: (name) => { assert.ok(name in ipcDependencies, `unexpected IPC dependency ${name}`); return ipcDependencies[name]; },
  });
  const ipc = ipcModule.exports.createIPCServer(12345, 'test');
  const send = (type, channel, payload = {}) => {
    const socket = new EventEmitter();
    socket.send = (frame) => socket.frames.push(JSON.parse(frame));
    socket.frames = [];
    socket.close = () => {};
    socket.terminate = () => {};
    servers.at(-1).emit('connection', socket);
    socket.emit('message', protocol.serialize(protocol.createMessage(type, channel, payload, { exchange, pair: 'BTC-USD' })));
    return socket.frames;
  };
  let finishFund;
  const fundStarted = new Promise((resolve) => { finishFund = resolve; });
  const pageRows = Array.from({ length: 250 }, (_, i) => ({ tradeId: `t${i}`, orderId: `o${i}`, timestamp: i + 1, side: 'buy', size: 0.01, price: 10, quoteAmount: 0.1 }));
  let ledgerCreations = 0;
  const makePageLedger = () => {
    ledgerCreations++;
    const { createTransactionsReadView } = require('../src/transactions-regime-query');
    const view = createTransactionsReadView(() => pageRows, () => `instance-${ledgerCreations}`);
    return { load: () => {}, getAllFills: () => pageRows, getStats: () => ({}),
      getFillPage: query => view.query(query), getFillAggregates: () => view.aggregates() };
  };
  const makeRunningReadView = require('../src/transactions-regime-query').createTransactionsReadView(() => pageRows, () => 'running');
  const dependencies = {
    path,
    '../src/logger': { createContextLogger: () => logger },
    '../src/config-utils': {
      initializeConfigBase: () => { calls.push('base-config'); },
      getRegimeConfig: () => ({}),
      getFundConfig: () => { calls.push('fund-config'); return {}; },
      getFundsForExchange: () => { calls.push('funds'); return failFirst ? ['BTC-USD', 'ETH-USD'] : ['BTC-USD']; },
      resolveConfiguredPair: (_, pair) => ({ pair }),
    },
    '../src/regime-engine': { createRegimeEngine: (_, pair) => {
      calls.push('construct');
      return { start: () => { calls.push('trade'); if (failFirst && pair === 'BTC-USD') return Promise.reject(new Error('fetch failed')); return fundStarted; }, stop: async () => { calls.push('cleanup'); }, getStatus: () => ({}), getFillPage: query => makeRunningReadView.query(query), getFillAggregates: () => makeRunningReadView.aggregates(), getFills: () => pageRows, getFillStats: () => ({}) };
    } },
    '../src/market-data-service': { stopMarketDataService: () => {}, fenceMarketDataService: async () => ({ drained: true }), startMarketDataService: async () => {} },
    '../src/chart-data-buffer': {},
    '../src/fill-ledger': { createFillLedger: makePageLedger },
    '../src/transactions-regime-query': require('../src/transactions-regime-query'),
    '../src/manual-trade-import': {},
    '../src/unaccounted-fills-jobs': require('../src/unaccounted-fills-jobs'),
    '../src/ipc/ipc-server': { createIPCServer: () => ipc },
    '../src/ipc/regime-ipc-handlers': require('../src/ipc/regime-ipc-handlers'),
    '../src/ipc/realtime-proxy': { createRealtimeProxy: () => ({}), forwardTradeEvents: () => {} },
    '../src/shared-utils': {
      fundKey: (name, pair) => `${name}::${pair}`,
      fundLabel: (name, pair) => `${name}/${pair}`,
      saveRegimeRunningFlag: (_, pair, running) => { runningFlags.push([pair, running]); },
      shouldAutoResumeRegime: () => { calls.push('running-flag'); return !stopped; },
    },
    '../src/engine-stop-all': { createEngineStopAllHandler: () => async () => ({ success: true }) },
    '../src/engine-maintenance': { getEngineMaintenance: () => null },
    '../src/engine-backup-window': { registerEngineBackupHandlers: () => {} },
    '../src/pending-writes': { drainPendingWrites: async () => ({ drained: true }) },
    '../src/engine-lifecycle-handlers': { registerEngineLifecycleHandlers: (registry, deps) => require('../src/engine-lifecycle-handlers').registerEngineLifecycleHandlers(registry, { ...deps, setTimer: () => ({ unref() {} }), clearTimer: () => {} }) },
    '../src/engine-recalculate-handler': { registerEngineRecalculateHandler: () => {} },
    '../src/migration': {
      guardLegacyMigration: () => { calls.push('namespace-migration'); return { blocked: false }; },
      migrateExchangeToPairs: () => { calls.push('migration'); return {}; },
    },
    '../src/restore-apply': { guardIncompleteRestore: () => { calls.push('restore'); hooks.onRecovery?.(); } },
    '../src/dca-conversion-transaction': { recoverDcaImport: () => ({ recovered: false }) },
    '../src/state-tracker': { LIFECYCLE: { CLOSED: 'closed' }, loadFundRegimeState: () => { calls.push('state'); return {}; }, loadRegimeStateSafe: () => { calls.push('state'); return {}; } },
    '../src/adapters': { getAdapter: () => { calls.push('adapter'); return { hasValidKeys: () => true }; } },
    '../src/process-guard': { registerProcessGuards: () => {} },
    '../src/ipc-port-defaults': { resolveIpcPort: () => 12345 },
    '../src/stopped-fund-tp-lookup': {},
    '../src/engine-shutdown': { createEngineShutdown: () => ({ shutdown: async () => 0, isStopping: () => false }) },
    '../package.json': { version: 'test' },
  };
  const exits = [];
  const processMock = { env: {}, on: () => {}, exit: (code) => exits.push(code) };
  const runShared = () => vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../engines/exchange-engine.js'), 'utf8')
      .replace('startup().catch', 'const startupDone = startup().catch') + '\nstartupDone;',
    { process: processMock, require: (name) => {
      assert.ok(name in dependencies, `unexpected engine dependency ${name}`);
      return dependencies[name];
    } },
  );
  let done;
  const run = () => {
    if (exchange === 'coinbase') done = runShared();
    else vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../engines/${exchange}-engine.js`), 'utf8'), {
      process: processMock,
      require: (name) => {
        if (name === '../src/ipc-port-defaults') return dependencies[name];
        assert.equal(name, './exchange-engine');
        done = runShared();
        return {};
      },
    });
    return done;
  };
  return { hooks, runningFlags, ipc, createIPCServer: ipcModule.exports.createIPCServer, servers, logs, calls, send, finishFund, exits, run, getLedgerCreations: () => ledgerCreations };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('IPC bind ownership and exchange startup', () => {
  it('resolves only on listening, keeps start idempotent and logs then', async () => {
    const h = createHarness();
    const started = h.ipc.start();
    assert.equal(h.ipc.start(), started);
    assert.equal(h.servers.length, 1);
    assert.equal(h.servers[0].options.host, '127.0.0.1');
    let resolved = false;
    started.then(() => { resolved = true; });
    await settle();
    assert.equal(resolved, false);
    assert.equal(h.logs.length, 0);
    h.servers[0].emit('listening');
    await started;
    assert.equal(h.logs.filter((line) => line.includes('listening')).length, 1);
    h.ipc.stop();
  });

  it('rejects and cleans a failed listener, without touching its existing owner', async () => {
    const h = createHarness();
    const owner = h.ipc.start();
    h.servers[0].bind();
    await owner;
    const duplicate = h.createIPCServer(12345, 'duplicate');
    const failure = assert.rejects(duplicate.start(), { code: 'EADDRINUSE' });
    h.servers[1].bind();
    await failure;
    assert.equal(h.servers[1].closed, true);
    assert.equal(h.servers[0].closed, false);
    h.servers[1].emit('listening');
    assert.equal(h.logs.filter((line) => line.includes('listening')).length, 1);
    h.ipc.stop();
    const retry = duplicate.start();
    assert.equal(h.servers.length, 3);
    h.servers[2].bind();
    await retry;
    duplicate.stop();
  });

  it('rejects a pending bind when stopped instead of leaving startup waiting', async () => {
    const h = createHarness();
    const started = h.ipc.start();
    const rejection = assert.rejects(started, /stopped before listening/);
    h.ipc.stop();
    await rejection;
    assert.equal(h.servers[0].closed, true);
  });

  for (const exchange of ['coinbase', 'gemini', 'cryptocom']) {
    it(`${exchange} exits on occupied port before recovery, data or exchange activity`, async () => {
      const h = createHarness(exchange);
      const done = h.run();
      assert.deepEqual(h.calls, []);
      h.servers[0].emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
      await done;
      assert.deepEqual(h.exits, [1]);
      assert.deepEqual(h.calls, []);
      assert.equal(h.servers[0].closed, true);
    });

    it(`${exchange} contains a failed fund and starts the next fund through the shared supervisor`, async () => {
      const h = createHarness(exchange, true);
      const done = h.run();
      h.servers[0].emit('listening');
      await settle();
      assert.equal(h.calls.filter(call => call === 'trade').length, 2);
      assert.equal(h.calls.filter(call => call === 'cleanup').length, 1);
      h.finishFund({ success: true });
      await done;
      assert.deepEqual(h.exits, []);
      h.ipc.stop();
    });

    it(`${exchange} starts once after binding and blocks requests only during boot recovery`, async () => {
      const h = createHarness(exchange);
      let mutations = 0;
      h.ipc.onRequest('mutate', async () => { mutations++; return { success: true }; });
      h.ipc.onRequest('config_update', async () => { mutations++; });
      const refusals = [];
      h.hooks.onRecovery = () => {
        for (const [type, channel] of [['request', 'mutate'], ['request', 'regime:fills'], ['request', 'regime:stop'], ['request', 'regime:status'], ['request', 'engine:maintenance'], ['config_update', 'config_update']]) {
          refusals.push(h.send(type, channel)[0]?.payload?.code);
        }
        assert.equal(h.send('ping', 'ping')[0].type, 'pong');
      };
      const done = h.run();
      assert.deepEqual(h.calls, []);
      h.servers[0].emit('listening');
      await settle();
      assert.deepEqual(refusals, Array(6).fill('engine-initializing'));
      assert.equal(mutations, 0);
      assert.deepEqual(h.calls, ['restore', 'base-config', 'namespace-migration', 'migration', 'funds', 'running-flag', 'state', 'fund-config', 'adapter', 'construct', 'trade']);
      await done;
      assert.deepEqual(h.exits, []);
      const frames = h.send('request', 'mutate');
      await settle();
      assert.equal(frames[0].payload.success, true);
      assert.equal(mutations, 1);
      h.finishFund({ success: true });
      await settle();
      assert.equal(h.calls.filter((call) => call === 'trade').length, 1);
      h.ipc.stop();
    });

    // Issue #1554: a slow first auto-resume must not hold the IPC gate shut.
    it(`${exchange} admits stop and status while a fund's first auto-resume is pending`, async () => {
      const h = createHarness(exchange);
      const done = h.run();
      h.servers[0].emit('listening');
      await done;
      await settle();
      assert.equal(h.calls.filter((call) => call === 'trade').length, 1, 'engine.start() is in flight');
      const statusFrames = h.send('request', 'regime:status');
      const stopFrames = h.send('request', 'regime:stop');
      const maintenanceFrames = h.send('request', 'engine:maintenance');
      await settle();
      assert.ok(maintenanceFrames[0]);
      assert.notEqual(maintenanceFrames[0].payload?.code, 'engine-initializing');
      assert.equal(statusFrames[0].payload.success, true, JSON.stringify(statusFrames[0]?.payload));
      assert.notEqual(statusFrames[0].payload.code, 'engine-initializing');
      // The stop is admitted and its intent recorded before the start resolves;
      // it replies once the supervisor has torn the cancelled attempt down.
      assert.deepEqual(h.runningFlags, [['BTC-USD', false]]);
      assert.equal(stopFrames.length, 0);
      h.finishFund({ success: true });
      for (let i = 0; i < 5 && !stopFrames.length; i++) await settle();
      assert.equal(stopFrames[0].payload.success, true, JSON.stringify(stopFrames[0]?.payload));
      assert.equal(h.calls.filter((call) => call === 'cleanup').length, 1);
      assert.equal(h.runningFlags.some(([, running]) => running), false);
      h.ipc.stop();
    });
  }
});

describe('engine regime:fills paging', () => {
  for (const stopped of [false, true]) {
    it(`returns bounded consecutive pages with stable revision when ${stopped ? 'stopped' : 'running'}`, async () => {
      const h = createHarness('coinbase', false, stopped);
      const done = h.run();
      h.servers[0].emit('listening');
      await settle();
      if (!stopped) h.finishFund({ success: true });
      await done;
      const read = async payload => {
        const frames = h.send('request', 'regime:fills', payload);
        await settle();
        return frames[0].payload;
      };
      const first = await read({ paged: true });
      assert.equal(first.running, !stopped, JSON.stringify(first));
      assert.equal(first.fills.length, 100);
      const second = await read({ paged: true, page: 1, revision: first.revision });
      assert.equal(second.revision, first.revision);
      assert.equal(second.pageInfo.page, 1);
      assert.equal(second.fills.length, 100);
      assert.equal(second.fills.some(row => first.fills.some(other => row.tradeId === other.tradeId)), false);
      assert.equal(h.getLedgerCreations(), stopped ? 1 : 0);
      const oversized = await read({ paged: true, pageSize: 1000 });
      assert.equal(oversized.fills.length, 100);
      const unpaged = await read({});
      assert.equal(unpaged.statusCode, 400);
      assert.equal(unpaged.error, 'paged=true required');
      assert.equal(unpaged.fills, undefined);
      const aggregateFrames = h.send('request', 'regime:fills:cycles');
      await settle();
      const aggregate = aggregateFrames[0].payload;
      assert.equal(aggregate.running, !stopped);
      assert.equal(aggregate.fillCount, 250);
      assert.equal(aggregate.buyCount, 250);
      assert.equal(aggregate.sellCount, 0);
      assert.equal(aggregate.cycles[0].entryCount, 250);
      assert.equal(aggregate.detailFills.length <= 500, true);
      assert.equal(aggregate.revision, first.revision);
      h.ipc.stop();
    });
  }
});
