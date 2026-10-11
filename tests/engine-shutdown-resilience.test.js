const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineShutdown } = require('../src/engine-shutdown');
const { createIPCServer } = require('../src/ipc/ipc-server');
const { createIPCClient } = require('../src/ipc/ipc-client');
const { trackPendingWrite, drainPendingWrites } = require('../src/pending-writes');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('coinbase engine graceful shutdown', () => {
  it('continues buffer flush and IPC close even when an engine.stop() rejects', async () => {
    const callLog = [];
    const mockRegimeEngines = new Map([
      ['btc-usdc', {
        stop: async () => {
          throw new Error('ENOSPC: no space left on device');
        },
      }],
      ['eth-usdc', {
        stop: async () => {
          callLog.push('eth-stop');
          return undefined;
        },
        flushForBackup: () => {
          callLog.push('eth-flush');
        },
      }],
    ]);

    const mockIPCServer = {
      setShuttingDown: () => callLog.push('ipcServer.setShuttingDown'),
      flush: async () => callLog.push('ipcServer.flush'),
      stop: () => callLog.push('ipcServer.stop'),
    };

    const mockLogger = {
      info: () => {},
      error: (msg) => callLog.push(`log-error:${msg}`),
      warn: () => {},
    };

    const exitCodes = [];
    const shutdownCoordinator = createEngineShutdown({
      ipcServer: mockIPCServer,
      regimeEngines: mockRegimeEngines,
      cancelStarts: async () => callLog.push('cancelStarts'),
      settleStarts: async () => callLog.push('settleStarts'),
      unaccountedFillsJobs: { shutdown: () => callLog.push('unaccountedFillsJobs.shutdown') },
      stopMarketServices: () => callLog.push('stopMarketServices'),
      drainMarketStarts: async () => callLog.push('drainMarketStarts'),
      drainPendingWrites: async () => { callLog.push('drainPendingWrites'); return { drained: true, pending: [] }; },
      shutdownAllBuffers: () => callLog.push('shutdownAllBuffers'),
      logger: mockLogger,
      exit: (code) => exitCodes.push(code),
    });

    await shutdownCoordinator.shutdown('SIGTERM');

    assert.ok(callLog.includes('eth-stop'), 'healthy engine stop was called');
    assert.ok(callLog.some((c) => c.includes('Engine stop failed for btc-usdc')), 'failed engine stop was logged');
    assert.ok(callLog.includes('eth-flush'), 'clean engine received post-drain flush');
    assert.ok(callLog.includes('shutdownAllBuffers'), 'shutdownAllBuffers must be called even when an engine.stop() rejects');
    assert.ok(callLog.includes('ipcServer.stop'), 'ipcServer.stop must be called even when an engine.stop() rejects');
    assert.deepEqual(exitCodes, [0], 'shutdown exits with code 0 after completing teardown');
  });

  it('shuts down idempotently when duplicate signals arrive', async () => {
    const callLog = [];
    const mockRegimeEngines = new Map([
      ['btc-usdc', {
        stop: async () => {
          await tick(10);
          callLog.push('btc-stop');
        },
        flushForBackup: () => callLog.push('btc-flush'),
      }],
    ]);

    const exitCodes = [];
    const coordinator = createEngineShutdown({
      regimeEngines: mockRegimeEngines,
      cancelStarts: async () => callLog.push('cancelStarts'),
      shutdownAllBuffers: () => callLog.push('shutdownAllBuffers'),
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      exit: (code) => exitCodes.push(code),
    });

    const p1 = coordinator.shutdown('SIGTERM');
    const p2 = coordinator.shutdown('SIGINT');

    assert.equal(p1, p2, 'duplicate signals must return the exact same shutdown promise');
    await Promise.all([p1, p2]);

    assert.equal(callLog.filter((c) => c === 'btc-stop').length, 1, 'engine stop called only once');
    assert.equal(callLog.filter((c) => c === 'cancelStarts').length, 1, 'cancelStarts called only once');
    assert.deepEqual(exitCodes, [0]);
  });

  it('closes IPC server intake immediately, refusing subsequent requests', async (t) => {
    const net = require('node:net');
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));

    const server = createIPCServer(port, 'test-shutdown-engine');
    t.after(() => server.stop());
    await server.start();
    server.onRequest('regime:status', async () => ({ success: true, status: 'ok' }));

    const client = createIPCClient(`ws://127.0.0.1:${port}`, 'test-client');
    t.after(() => client.disconnect());
    client.connect();
    for (let i = 0; i < 100 && !client.isConnected(); i++) await tick(10);
    assert.ok(client.isConnected(), 'client connected');

    const first = await client.request('regime:status', {}, 'test', 'BTC-USD', 1000);
    assert.equal(first.status, 'ok');

    const exitCodes = [];
    const coordinator = createEngineShutdown({
      ipcServer: server,
      regimeEngines: new Map(),
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      exit: (code) => exitCodes.push(code),
    });

    // Mark intake closed through coordinator
    server.setShuttingDown(true);

    const refused = await client.request('regime:status', {}, 'test', 'BTC-USD', 1000);
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'engine-shutting-down');
    assert.match(refused.error, /shutting down/i);

    await coordinator.shutdown('SIGTERM');
    assert.deepEqual(exitCodes, [0]);
  });

  it('drains accepted in-flight IPC requests before stopping engines', async () => {
    const callLog = [];
    const ipcWork = deferred();

    // Register a simulated accepted IPC request in pending writes
    const ipcWrite = trackPendingWrite('ipc:regime:rebuild-ladder', async () => {
      callLog.push('ipc-work-started');
      await ipcWork.promise;
      callLog.push('ipc-work-finished');
    });

    const mockRegimeEngines = new Map([
      ['btc-usdc', {
        stop: async () => {
          callLog.push('engine-stop');
        },
      }],
    ]);

    const exitCodes = [];
    const coordinator = createEngineShutdown({
      regimeEngines: mockRegimeEngines,
      drainPendingWrites,
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      exit: (code) => exitCodes.push(code),
      ipcDrainTimeoutMs: 1000,
      processDrainTimeoutMs: 1000,
    });

    const shutdownPromise = coordinator.shutdown('SIGTERM');
    await tick(10);

    assert.ok(callLog.includes('ipc-work-started'));
    assert.ok(!callLog.includes('engine-stop'), 'engine stop must wait for accepted IPC request');

    ipcWork.resolve();
    await ipcWrite;
    await shutdownPromise;

    assert.ok(callLog.includes('ipc-work-finished'));
    assert.ok(callLog.includes('engine-stop'));
    const finishIndex = callLog.indexOf('ipc-work-finished');
    const stopIndex = callLog.indexOf('engine-stop');
    assert.ok(finishIndex < stopIndex, 'accepted IPC request must finish before engine.stop() runs');
    assert.deepEqual(exitCodes, [0]);
  });

  it('drains process pending writes and invokes flushForBackup to capture writes after engine stop', async () => {
    const callLog = [];
    const bookingWork = deferred();

    const mockRegimeEngines = new Map([
      ['btc-usdc', {
        stop: async () => {
          callLog.push('engine-stop');
        },
        flushForBackup: () => {
          callLog.push('engine-flush');
        },
      }],
    ]);

    let bookingPromise;
    const coordinator = createEngineShutdown({
      regimeEngines: mockRegimeEngines,
      stopMarketServices: () => {
        // Simulate a booking write that was in flight as engines are stopped
        bookingPromise = trackPendingWrite('engine-booking:btc-usdc', async () => {
          callLog.push('booking-started');
          await bookingWork.promise;
          callLog.push('booking-completed');
        });
      },
      drainPendingWrites,
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      exit: (code) => callLog.push(`exit:${code}`),
      ipcDrainTimeoutMs: 1000,
      processDrainTimeoutMs: 1000,
    });

    const shutdownPromise = coordinator.shutdown('SIGTERM');
    await tick(10);

    assert.ok(callLog.includes('engine-stop'));
    assert.ok(callLog.includes('booking-started'));
    assert.ok(!callLog.includes('engine-flush'), 'engine flush must not run until pending write settles');
    assert.ok(!callLog.includes('exit:0'));

    bookingWork.resolve();
    await bookingPromise;
    await shutdownPromise;

    assert.ok(callLog.includes('booking-completed'));
    assert.ok(callLog.includes('engine-flush'));
    assert.ok(callLog.includes('exit:0'));
    const bookIndex = callLog.indexOf('booking-completed');
    const flushIndex = callLog.indexOf('engine-flush');
    assert.ok(bookIndex < flushIndex, 'booking must complete before flushForBackup persists the final state');
  });

  it('enforces the watchdog timeout and exits with code 1 on hung teardown', async () => {
    const callLog = [];
    const exitCodes = [];

    const mockRegimeEngines = new Map([
      ['btc-usdc', {
        stop: async () => {
          // Hung stop that never resolves
          await new Promise(() => {});
        },
      }],
    ]);

    const coordinator = createEngineShutdown({
      regimeEngines: mockRegimeEngines,
      watchdogMs: 40,
      logger: { info: () => {}, error: (msg) => callLog.push(msg), warn: () => {} },
      exit: (code) => exitCodes.push(code),
    });

    const shutdownPromise = coordinator.shutdown('SIGTERM');
    await tick(80);

    assert.deepEqual(exitCodes, [1], 'watchdog timeout must force exit with code 1');
    assert.ok(callLog.some((m) => m.includes('Forcing exit after shutdown timeout')), 'watchdog timeout must be logged');
  });
});
