// @ts-check
/**
 * Shared fixture for tests/ipc-command-contract.test.js (issue #845).
 *
 * Provides the three seams the IPC command contract needs:
 *  - a real engine-side IPC server on an OS-assigned loopback port,
 *  - the production IPC client evaluated against a controllable fake `ws`
 *    (so deadline / disconnect / reconnect ordering runs on mock timers),
 *  - a live-timer tracker proving deadlines are cleared, not just ignored.
 * Nothing here touches exchanges, config files or fund state.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { mock } = require('node:test');
const { performance } = require('node:perf_hooks');
const { setTimeout: waitForIo } = require('node:timers/promises');

const SRC_IPC = path.join(__dirname, '..', '..', 'src', 'ipc');

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

/** Fake `ws` socket the test drives by hand. Records every frame the client sends. */
class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    /** @type {string[]} */
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }

  /** Frames the client wrote, parsed, excluding keep-alive pings (they accrue as fake time advances). */
  get frames() { return this.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type !== 'ping'); }

  /** Local close (client-initiated): mirrors ws, which later emits 'close'. */
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  /** Complete the handshake. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  /** Engine side hangs up. */
  peerClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  /** Deliver an engine frame to the client. */
  receive(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
}

/**
 * Evaluate the real src/ipc/ipc-client.js with `ws` swapped for FakeWebSocket.
 * Evaluated as a wrapped function (not via require.cache) so it cannot leak
 * into suites that exercise the client over a real socket.
 */
const loadClientWithFakeWs = () => {
  FakeWebSocket.instances = [];
  const file = path.join(SRC_IPC, 'ipc-client.js');
  const wrapper = vm.runInThisContext(`(function (require, module, exports) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  const mod = { exports: {} };
  wrapper((request) => {
    if (request === 'ws') return FakeWebSocket;
    if (request.startsWith('.')) return require(path.resolve(SRC_IPC, request));
    return require(request);
  }, mod, mod.exports);
  return mod.exports.createIPCClient;
};

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
  getFreePort,
  until,
  deferred,
  loadClientWithFakeWs,
  trackTimers,
  restoreTimers,
  startEngineIpc,
};
