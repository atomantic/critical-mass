// @ts-check
/**
 * Shared fixture for tests/ipc-command-contract.test.js (issue #845).
 *
 * Provides the three seams the IPC command contract needs:
 *  - a real engine-side IPC server on an OS-assigned loopback port,
 *  - the production IPC client driven over a controllable fake global
 *    WebSocket (so deadline / disconnect / reconnect ordering runs on mock
 *    timers) — see tests/helpers/fake-websocket.js,
 *  - a live-timer tracker proving deadlines are cleared, not just ignored.
 * Nothing here touches exchanges, config files or fund state.
 */
const net = require('node:net');
const { mock } = require('node:test');
const { performance } = require('node:perf_hooks');
const { setTimeout: waitForIo } = require('node:timers/promises');
const { FakeWebSocket, installFakeWebSocket } = require('./fake-websocket');

/** Ask the OS for a free loopback port (the server API takes a concrete port). */
const getFreePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
    probe.close(() => resolve(port));
  });
});

/** Poll real I/O against a monotonic elapsed-time deadline, allowing timers to fire. */
const until = async (predicate, label = 'condition', timeoutMs = 2000) => {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    if (predicate()) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${label}`);
    // Real timers are intentional: controlled-socket tests advance their own mocks.
    await waitForIo(Math.min(5, remaining));
  }
};

/** Resolve-on-demand promise used to hold a handler open and release it in a chosen order. */
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

/**
 * Frames the client wrote, parsed, excluding keep-alive pings (they accrue as
 * fake time advances).
 * @param {FakeWebSocket} sock
 */
const commands = (sock) => sock.frames.filter((frame) => frame.type !== 'ping');

/**
 * Enable mock timers and track which one-shot timers are still scheduled, so a
 * test can assert a deadline was cleared rather than merely ignored. Pair with
 * `restoreTimers()` in afterEach.
 */
const trackTimers = () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const live = new Set();
  const mockedSet = globalThis.setTimeout;
  const mockedClear = globalThis.clearTimeout;
  mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    const timer = mockedSet(() => { live.delete(timer); fn(...rest); }, ms);
    live.add(timer);
    return timer;
  });
  mock.method(globalThis, 'clearTimeout', (timer) => {
    live.delete(timer);
    return mockedClear(timer);
  });
  return { live, tick: (ms) => mock.timers.tick(ms) };
};

const restoreTimers = () => {
  mock.restoreAll();
  mock.timers.reset();
};

/** Real engine IPC server on an OS-assigned port. */
const startEngineIpc = async (register, port) => {
  const { createIPCServer } = require('../../src/ipc/ipc-server');
  const listenPort = port ?? await getFreePort();
  const server = createIPCServer(listenPort, 'contract-test');
  register?.(server);
  await server.start();
  return { server, port: listenPort, url: `ws://127.0.0.1:${listenPort}` };
};

module.exports = {
  FakeWebSocket,
  installFakeWebSocket,
  commands,
  getFreePort,
  until,
  deferred,
  trackTimers,
  restoreTimers,
  startEngineIpc,
};
