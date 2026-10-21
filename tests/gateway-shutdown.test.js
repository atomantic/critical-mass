const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { createGatewayShutdown, closeGatewayListeners, SHUTDOWN_TIMEOUT_MS } = require('../src/gateway-shutdown');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const makeGateway = (overrides = {}) => {
  const calls = [];
  const gateway = createGatewayShutdown({
    cancelSchedules: () => calls.push('cancel'),
    stopProducers: () => calls.push('producers'),
    stopNotifier: () => calls.push('notifier'),
    disconnectIPC: () => calls.push('disconnect'),
    closeListeners: () => calls.push('listeners'),
    log: () => {},
    exit: (code) => calls.push(`exit:${code}`),
    ...overrides,
  });
  return { gateway, calls };
};

describe('gateway shutdown owns admitted work', () => {
  it('production scheduler waits for a durable cycle and refuses subsequent ticks', async () => {
    const cycle = deferred();
    const notification = deferred();
    let runs = 0;
    const { gateway, calls } = makeGateway({ stopNotifier: () => notification.promise });
    // Execute the actual scheduler, with fake trades and no exchange access.
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const scheduler = source.slice(source.indexOf('const schedulerState = {}'), source.indexOf('// ============ Start Server'));
    const context = vm.createContext({
      gatewayShutdown: gateway,
      getGlobalConfig: () => ({ simpleDcaEnabled: true }),
      isMaintenanceActive: () => false,
      getEnabledFunds: () => [{ exchange: 'fake', pair: 'BTC-USD' }],
      getFundConfig: () => ({ intervalType: 'hourly' }),
      normalizeConfig: (config) => config,
      fundKey: () => 'fake/BTC-USD', fundLabel: () => 'fake/BTC-USD',
      hasRunThisInterval: () => false,
      formatInterval: () => 'hourly', getRunIdentifier: () => 'fake-run', getNextExecutionTime: () => 0,
      runIntervalCycle: () => { runs++; return cycle.promise; },
      log: () => {},
    });
    vm.runInContext(`${scheduler}\ncheckAndRunIntervalTrade();`, context);
    const shutdown = gateway.shutdown('SIGTERM');
    assert.equal(gateway.shutdown('SIGINT'), shutdown);
    vm.runInContext('checkAndRunIntervalTrade()', context);
    await settle();
    assert.equal(runs, 1);
    assert.deepEqual(calls, ['cancel', 'producers']);
    cycle.resolve({ status: 'booked-and-sell-ready' });
    await settle();
    assert.deepEqual(calls, ['cancel', 'producers', 'producers', 'disconnect'], 'IPC disconnects before the notification drain so engines hold later events');
    notification.resolve(true);
    assert.equal(await shutdown, 0);
    assert.deepEqual(calls, ['cancel', 'producers', 'producers', 'disconnect', 'listeners', 'exit:0']);
  });

  it('production producer stop leaves restore-owned writers alone so it cannot persist over restored files', () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const start = source.indexOf('  stopProducers: () => {');
    const block = source.slice(start, source.indexOf('\n  },', start) + '\n  },'.length);
    for (const maintenance of [true, false]) {
      const calls = [];
      const context = vm.createContext({
        isMaintenanceActive: () => maintenance,
        updownService: { stop: () => calls.push('updown') },
        sentinelService: { stop: () => calls.push('sentinel') },
        activeLogStreams: { stopAll: () => calls.push('logs') },
      });
      vm.runInContext(`({${block}}).stopProducers()`, context);
      assert.deepEqual(calls, maintenance ? ['logs'] : ['updown', 'sentinel', 'logs']);
    }
  });

  it('keeps IPC alive for a route promise even when its client disconnects', async () => {
    const work = deferred();
    const { gateway, calls } = makeGateway();
    const app = express();
    app.use(gateway.middleware);
    gateway.routes(app).post('/trade', async (req, res) => {
      await work.promise;
      assert.ok(!calls.includes('disconnect'));
      res.json({ booked: true });
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/trade', method: 'POST' });
    req.on('error', () => {});
    const admitted = new Promise((resolve) => server.once('request', resolve));
    req.end();
    await admitted;
    req.destroy();
    const shutdown = gateway.shutdown('SIGTERM');
    await settle();
    assert.deepEqual(calls, ['cancel', 'producers']);
    work.resolve();
    assert.equal(await shutdown, 0);
    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects new requests immediately, before body parsing or authentication', async () => {
    const work = deferred();
    const { gateway } = makeGateway();
    gateway.track(work.promise);
    const shutdown = gateway.shutdown('SIGTERM');
    for (const method of ['POST', 'PUT', 'DELETE', 'GET']) {
      let status;
      let body;
      gateway.middleware({ method }, {
        status: (code) => { status = code; return { json: (value) => { body = value; } }; },
      }, () => assert.fail('new request admitted'));
      assert.equal(status, 503);
      assert.match(body.error, /shutting down/);
    }
    work.resolve();
    await shutdown;
  });

  it('waits for a request already admitted before its async handler starts', async () => {
    const { gateway, calls } = makeGateway();
    const res = new EventEmitter();
    gateway.middleware({}, res, () => {});
    const shutdown = gateway.shutdown('SIGTERM');
    await settle();
    assert.deepEqual(calls, ['cancel', 'producers']);
    res.emit('finish');
    await shutdown;
    assert.equal(calls.at(-1), 'exit:0');
  });

  it('exits once with failure on a hung task, without changing its recovery data', async () => {
    const work = deferred();
    const recovery = { placementIntent: 'persisted' };
    const { gateway, calls } = makeGateway({ timeoutMs: 10 });
    gateway.track(work.promise);
    assert.equal(await gateway.shutdown('SIGTERM'), 1);
    assert.deepEqual(calls, ['cancel', 'producers', 'exit:1'], 'producers saved their state before the deadline exit');
    assert.deepEqual(recovery, { placementIntent: 'persisted' });
    work.resolve();
    await settle();
    assert.deepEqual(calls, ['cancel', 'producers', 'exit:1']);
  });

  it('does not let a producer startup that only its stop can cancel hold the drain', async () => {
    // UpDown's tracked start() waits on the scorecard lock until UpDown stops.
    let cancelStartup;
    const startup = new Promise((resolve) => { cancelStartup = resolve; });
    const { gateway, calls } = makeGateway({
      timeoutMs: 1000,
      stopProducers: () => { calls.push('producers'); cancelStartup(); },
    });
    gateway.track(startup);
    assert.equal(await gateway.shutdown('SIGTERM'), 0);
    assert.deepEqual(calls, ['cancel', 'producers', 'producers', 'disconnect', 'notifier', 'listeners', 'exit:0']);
  });

  it('reports a producer stop failure without an unhandled rejection, still draining work and the notifier', async () => {
    const work = deferred();
    const { gateway, calls } = makeGateway({ stopProducers: () => Promise.reject(new Error('persist failed')) });
    gateway.track(work.promise);
    const shutdown = gateway.shutdown('SIGTERM');
    await settle();
    assert.deepEqual(calls, ['cancel'], 'admitted work is still drained');
    work.resolve();
    assert.equal(await shutdown, 1);
    assert.deepEqual(calls, ['cancel', 'disconnect', 'notifier', 'listeners', 'exit:1']);
  });

  it('keeps tearing down after an IPC disconnect failure', async () => {
    const { gateway, calls } = makeGateway({ disconnectIPC: () => Promise.reject(new Error('socket failed')) });
    assert.equal(await gateway.shutdown('SIGTERM'), 1);
    assert.deepEqual(calls, ['cancel', 'producers', 'producers', 'notifier', 'listeners', 'exit:1']);
  });

  it('waits for the realtime bus and every HTTP listener, including an already closed listener', async () => {
    const socketClose = deferred();
    const servers = [http.createServer(), http.createServer()];
    await Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
    let closed = false;
    const closing = closeGatewayListeners({ close: () => socketClose.promise }, [...servers, http.createServer()])
      .then(() => { closed = true; });
    await settle();
    assert.equal(closed, false);
    assert.ok(servers.every((server) => !server.listening));
    socketClose.resolve();
    await closing;
    assert.equal(closed, true);
  });

  it('closes realtime connections on every attached listener before the listeners finish closing', async () => {
    const { createRealtimeBus } = require('../src/realtime-bus');
    const servers = [http.createServer(), http.createServer()];
    const bus = createRealtimeBus({ httpServer: servers[0] });
    bus.attach(servers[1]);
    await Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
    const sockets = servers.map((server) => new WebSocket(`ws://127.0.0.1:${server.address().port}/realtime`));
    // The bus's open frame: each connection is registered.
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.addEventListener('message', resolve, { once: true }))));
    const closed = sockets.map((socket) => new Promise((resolve) => socket.addEventListener('close', ({ code }) => resolve(code), { once: true })));
    await closeGatewayListeners(bus, servers);
    assert.deepEqual(await Promise.all(closed), [1001, 1001]);
    assert.ok(servers.every((server) => !server.listening));
    assert.ok(sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
  });

  it('gives PM2 longer than the internal gateway deadline', () => {
    const config = require('../ecosystem.config.cjs');
    const gateway = config.apps.find((app) => app.name === 'critical-mass');
    assert.ok(gateway.kill_timeout > SHUTDOWN_TIMEOUT_MS);
  });
});
