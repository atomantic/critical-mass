// @ts-check
/**
 * The gateway owns every HTTP listener before it starts anything with side
 * effects: engine IPC connections, the UpDown/Sentinel writers, the notifier,
 * the backup and DCA schedulers and the immediate DCA check. A second gateway
 * on the same port (`node server.js` or `npm run dev` beside the PM2 process)
 * must therefore exit on EADDRINUSE without having touched state, placed a buy
 * or sent a notification — the gateway-side counterpart of the engines'
 * bind-first rule (issue #816).
 *
 * Runs the production "Start Server" block from server.js with fakes for the
 * bind and every service it starts; no socket, file or exchange is reachable.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const startBlock = source.slice(source.indexOf('// ============ Start Server'), source.indexOf('// ============ Graceful Shutdown'));
assert.ok(startBlock.includes('bindGatewayListeners('), 'server.js start block must bind through bindGatewayListeners');

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

const runStartBlock = ({ stopping = false } = {}) => {
  const bind = deferred();
  const started = [];
  const logs = [];
  const exits = [];
  const bindArgs = [];
  const recorder = (name) => () => { started.push(name); };
  const context = vm.createContext({
    require: (name) => (name === './package.json' ? { version: '0.0.0-test' } : assert.fail(`unexpected require ${name}`)),
    setInterval: (fn, ms) => { started.push(`interval:${ms}`); return { fn }; },
    process: { exit: (code) => exits.push(code) },
    log: (level, message) => logs.push(`${level} ${message}`),
    gatewayShutdown: { isStopping: () => stopping, track: (p) => p },
    bindGatewayListeners: (args) => { bindArgs.push(args); return bind.promise; },
    LISTEN_HOSTS: ['127.0.0.1'], PORT: 5570,
    server: { name: 'primary' }, app: {}, http: { createServer: () => ({ name: 'extra' }) },
    io: { attach: recorder('io.attach'), engine: { name: 'engine' } }, socketEngines: [],
    getEnabledExchanges: () => [], getConfiguredExchanges: () => ['fake'], getEnabledFunds: () => [],
    normalizeConfig: (c) => c, getFundConfig: () => ({}), formatInterval: () => '', getTimeUntilNext: () => ({ formatted: '' }), fundLabel: () => '',
    KNOWN_EXCHANGES: new Set(),
    notifier: { start: recorder('notifier.start') },
    exchangeIPCMap: { coinbase: { connect: recorder('ipc.connect:coinbase') }, gemini: { connect: recorder('ipc.connect:gemini') } },
    candleCache: { seedAll: recorder('candleCache.seedAll') },
    updownService: { start: () => { started.push('updown.start'); return Promise.resolve(); } },
    sentinelService: { start: recorder('sentinel.start') },
    rescheduleBackupTimer: recorder('rescheduleBackupTimer'),
    getGlobalConfig: () => ({ schedulerInterval: 30000 }),
    checkAndRunIntervalTrade: recorder('checkAndRunIntervalTrade'),
  });
  vm.runInContext(`let exchangeRefreshTimer = null; let schedulerTimer = null;\n${startBlock}`, context);
  return { bind, started, logs, exits, bindArgs, context };
};

describe('gateway startup order', () => {
  it('starts no writer, scheduler or engine connection until every listener is bound', async () => {
    const { bind, started, exits, bindArgs } = runStartBlock();
    assert.equal(bindArgs.length, 1);
    assert.deepEqual(bindArgs[0].hosts, ['127.0.0.1']);
    assert.equal(bindArgs[0].port, 5570);
    await settle();
    assert.deepEqual(started, [], 'nothing with side effects runs before the bind resolves');

    bind.resolve([]);
    await settle();
    assert.deepEqual(exits, []);
    assert.equal(started[0], 'notifier.start', 'the notifier subscribes before any producer can emit');
    for (const name of ['ipc.connect:coinbase', 'ipc.connect:gemini', 'candleCache.seedAll', 'updown.start', 'sentinel.start',
      'interval:60000', 'rescheduleBackupTimer', 'interval:30000', 'checkAndRunIntervalTrade']) {
      assert.ok(started.includes(name), `${name} starts after the bind`);
    }
  });

  it('exits non-zero on a bind failure without starting anything', async () => {
    const { bind, started, exits, logs } = runStartBlock();
    bind.reject(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', host: '127.0.0.1', port: 5570 }));
    await settle();
    assert.deepEqual(started, []);
    assert.deepEqual(exits, [1]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^ERROR .*127\.0\.0\.1:5570.*EADDRINUSE/);
  });

  it('starts nothing when shutdown began while the bind was pending', async () => {
    const { bind, started, exits } = runStartBlock({ stopping: true });
    bind.resolve([]);
    await settle();
    assert.deepEqual(started, []);
    assert.deepEqual(exits, []);
  });

  it('attaches Socket.IO to every extra host listener before it binds', () => {
    const { bindArgs, context, started } = runStartBlock();
    const extra = bindArgs[0].createServer();
    bindArgs[0].onExtra(extra);
    assert.deepEqual(started, ['io.attach']);
    assert.deepEqual(context.socketEngines, [{ name: 'engine' }]);
  });
});
