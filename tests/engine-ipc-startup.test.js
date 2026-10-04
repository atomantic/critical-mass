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
    ws: { Server: MockServer, OPEN: 1 },
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
    return { load: () => {}, getAllFills: () => pageRows, getStats: () => ({}), getFillPage: query => view.query(query) };
  };
  const makeRunningReadView = require('../src/transactions-regime-query').createTransactionsReadView(() => pageRows, () => 'running');
  const dependencies = {
    path,
    '../src/logger': { createContextLogger: () => logger },
    '../src/config-utils': {
      getRegimeConfig: () => ({}),
      getFundConfig: () => { calls.push('fund-config'); return {}; },
      getFundsForExchange: () => { calls.push('funds'); return failFirst ? ['BTC-USD', 'ETH-USD'] : ['BTC-USD']; },
      resolveConfiguredPair: (_, pair) => ({ pair }),
    },
    '../src/regime-engine': { createRegimeEngine: (_, pair) => {
      calls.push('construct');
      return { start: () => { calls.push('trade'); if (failFirst && pair === 'BTC-USD') return Promise.reject(new Error('fetch failed')); return fundStarted; }, stop: async () => { calls.push('cleanup'); }, getStatus: () => ({}), getFillPage: query => makeRunningReadView.query(query), getFills: () => pageRows, getFillStats: () => ({}) };
    } },
    '../src/market-data-service': { stopMarketDataService: () => {}, startMarketDataService: async () => {} },
    '../src/chart-data-buffer': {},
    '../src/fill-ledger': { createFillLedger: makePageLedger },
    '../src/transactions-regime-query': require('../src/transactions-regime-query'),
    '../src/manual-trade-import': {},
    '../src/unaccounted-fills-jobs': require('../src/unaccounted-fills-jobs'),
    '../src/ipc/ipc-server': { createIPCServer: () => ipc },
    '../src/ipc/socket-io-proxy': { createSocketIOProxy: () => ({}), forwardTradeEvents: () => {} },
    '../src/shared-utils': {
      fundKey: (name, pair) => `${name}::${pair}`,
      fundLabel: (name, pair) => `${name}/${pair}`,
      saveRegimeRunningFlag: () => {},
      shouldAutoResumeRegime: () => { calls.push('running-flag'); return !stopped; },
    },
    '../src/engine-stop-all': {},
    '../src/engine-backup-window': { registerEngineBackupHandlers: () => {} },
    '../src/pending-writes': { drainPendingWrites: async () => ({ drained: true }) },
    '../src/engine-lifecycle-handlers': { registerEngineLifecycleHandlers: (registry, deps) => require('../src/engine-lifecycle-handlers').registerEngineLifecycleHandlers(registry, { ...deps, setTimer: () => ({ unref() {} }), clearTimer: () => {} }) },
    '../src/engine-recalculate-handler': { registerEngineRecalculateHandler: () => {} },
    '../src/migration': { migrateExchangeToPairs: () => { calls.push('migration'); return {}; } },
    '../src/restore-apply': { guardIncompleteRestore: () => { calls.push('restore'); } },
    '../src/dca-conversion-transaction': { recoverDcaImport: () => ({ recovered: false }) },
    '../src/state-tracker': { LIFECYCLE: { CLOSED: 'closed' }, loadRegimeState: () => { calls.push('state'); return {}; }, loadRegimeStateSafe: () => { calls.push('state'); return {}; } },
    '../src/adapters': { getAdapter: () => { calls.push('adapter'); return { hasValidKeys: () => true }; } },
    '../src/process-guard': { registerProcessGuards: () => {} },
    '../src/ipc-port-defaults': { resolveIpcPort: () => 12345 },
    '../src/stopped-fund-tp-lookup': {},
    '../package.json': { version: 'test' },
  };
  const exits = [];
  const processMock = { env: {}, on: () => {}, exit: (code) => exits.push(code) };
  const runShared = () => vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../engines/coinbase-engine.js'), 'utf8')
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
        assert.equal(name, './coinbase-engine');
        done = runShared();
        return {};
      },
    });
    return done;
  };
  return { ipc, createIPCServer: ipcModule.exports.createIPCServer, servers, logs, calls, send, finishFund, exits, run, getLedgerCreations: () => ledgerCreations };
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

    it(`${exchange} starts once after binding and blocks requests until funds recover`, async () => {
      const h = createHarness(exchange);
      const done = h.run();
      assert.deepEqual(h.calls, []);
      h.servers[0].emit('listening');
      await settle();
      assert.deepEqual(h.calls, ['restore', 'migration', 'funds', 'running-flag', 'state', 'fund-config', 'adapter', 'construct', 'trade']);
      let mutations = 0;
      h.ipc.onRequest('mutate', async () => { mutations++; return { success: true }; });
      h.ipc.onRequest('config_update', async () => { mutations++; });
      for (const [type, channel] of [['request', 'mutate'], ['request', 'regime:fills'], ['request', 'engine:maintenance'], ['config_update', 'config_update']]) {
        const [response] = h.send(type, channel);
        assert.equal(response.payload.code, 'engine-initializing');
      }
      assert.equal(h.send('ping', 'ping')[0].type, 'pong');
      assert.equal(mutations, 0);
      h.finishFund({ success: true });
      await done;
      assert.deepEqual(h.exits, []);
      const frames = h.send('request', 'mutate');
      await settle();
      assert.equal(frames[0].payload.success, true);
      assert.equal(mutations, 1);
      assert.equal(h.calls.filter((call) => call === 'trade').length, 1);
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
      const legacy = await read({});
      assert.equal(legacy.fills.length, 250);
      assert.ok(legacy.stats);
      h.ipc.stop();
    });
  }
});
