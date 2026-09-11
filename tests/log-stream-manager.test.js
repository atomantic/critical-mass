const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createLogStreamRegistry,
  registerLogStreamHandlers,
  disconnectLogStream,
} = require('../src/log-stream-manager');

/**
 * Minimal stand-in for a child_process ChildProcess: an EventEmitter with
 * stdout/stderr sub-emitters and a `kill()` that just marks itself killed
 * (tests fire 'close'/'error' explicitly to control ordering/races).
 */
const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
};

/** Minimal stand-in for a socket.io socket: records emitted events. */
const createFakeSocket = (id) => {
  const socket = new EventEmitter();
  socket.id = id;
  socket.emitted = [];
  const realEmit = socket.emit.bind(socket);
  socket.emit = (event, payload) => {
    socket.emitted.push({ event, payload });
    return true;
  };
  socket.trigger = (event, payload) => realEmit(event, payload);
  return socket;
};

const noopLog = () => {};

const ALLOWED = new Set(['critical-mass']);

describe('log-stream-manager registry', () => {
  it('end() tears down and returns the entry when the child is still current', () => {
    const registry = createLogStreamRegistry();
    const child = createFakeChild();
    registry.start('s1', 'critical-mass', child);

    const result = registry.end('s1', child);

    assert.equal(result.processName, 'critical-mass');
    assert.equal(registry.get('s1'), undefined);
  });

  it('dedupes an error immediately followed by close on the same child into one terminal', () => {
    const registry = createLogStreamRegistry();
    const child = createFakeChild();
    registry.start('s1', 'critical-mass', child);

    const first = registry.end('s1', child); // simulates the 'error' handler
    const second = registry.end('s1', child); // simulates the subsequent 'close'

    assert.ok(first, 'first end() call should return the entry');
    assert.equal(second, null, 'second end() call must be a no-op');
  });

  it('stop() (deliberate unsubscribe) prevents a later delayed end() from firing', () => {
    const registry = createLogStreamRegistry();
    const child = createFakeChild();
    registry.start('s1', 'critical-mass', child);

    const stopped = registry.stop('s1');
    const delayedClose = registry.end('s1', child);

    assert.ok(stopped);
    assert.equal(child.killed, true);
    assert.equal(delayedClose, null, 'unsubscribed child close must not clear/notify');
  });

  it('an old child\'s delayed close cannot clobber a replacement subscription', () => {
    const registry = createLogStreamRegistry();
    const oldChild = createFakeChild();
    const newChild = createFakeChild();

    registry.start('s1', 'critical-mass', oldChild);
    registry.start('s1', 'critical-mass', newChild); // replacement kills oldChild internally

    assert.equal(oldChild.killed, true);

    const delayedClose = registry.end('s1', oldChild);
    assert.equal(delayedClose, null, 'stale child must not remove the replacement entry');
    assert.equal(registry.get('s1').process, newChild, 'replacement entry must still be active');

    const currentClose = registry.end('s1', newChild);
    assert.equal(currentClose.processName, 'critical-mass');
  });

  it('disconnect (stop) blocks a subsequent delayed close from the same child', () => {
    const registry = createLogStreamRegistry();
    const child = createFakeChild();
    registry.start('s1', 'critical-mass', child);

    disconnectLogStream({ socket: { id: 's1' }, registry, log: noopLog });
    const delayedClose = registry.end('s1', child);

    assert.equal(delayedClose, null);
    assert.equal(registry.get('s1'), undefined);
  });
});

describe('log-stream-manager socket handlers', () => {
  const setup = () => {
    const registry = createLogStreamRegistry();
    const socket = createFakeSocket('s1');
    let spawned = [];
    const spawnFn = () => {
      const child = createFakeChild();
      spawned.push(child);
      return child;
    };
    registerLogStreamHandlers({ socket, registry, spawnFn, log: noopLog, allowedProcesses: ALLOWED });
    return { registry, socket, spawned };
  };

  it('a clean exit (code 0) emits logs:terminal with reason exited and clears Streaming', () => {
    const { socket, spawned } = setup();
    socket.trigger('logs:subscribe', { processName: 'critical-mass', lines: 100 });
    const child = spawned[0];

    child.emit('close', 0, null);

    const terminal = socket.emitted.find(e => e.event === 'logs:terminal');
    assert.ok(terminal, 'expected a logs:terminal event');
    assert.equal(terminal.payload.reason, 'exited');
    assert.equal(terminal.payload.processName, 'critical-mass');
  });

  it('a crash (nonzero code or signal) emits logs:terminal with reason crashed', () => {
    const { socket, spawned } = setup();
    socket.trigger('logs:subscribe', { processName: 'critical-mass', lines: 100 });
    const child = spawned[0];

    child.emit('close', 1, null);

    const terminal = socket.emitted.find(e => e.event === 'logs:terminal');
    assert.ok(terminal);
    assert.equal(terminal.payload.reason, 'crashed');
    assert.equal(terminal.payload.code, 1);
  });

  it('a spawn error followed by close yields exactly one logs:terminal', () => {
    const { socket, spawned } = setup();
    socket.trigger('logs:subscribe', { processName: 'critical-mass', lines: 100 });
    const child = spawned[0];

    child.emit('error', new Error('ENOENT'));
    child.emit('close', null, null);

    const terminals = socket.emitted.filter(e => e.event === 'logs:terminal');
    assert.equal(terminals.length, 1, 'expected exactly one terminal notification');
    assert.equal(terminals[0].payload.reason, 'error');
    assert.equal(terminals[0].payload.message, 'ENOENT');
  });

  it('explicit unsubscribe emits logs:unsubscribed, not a spurious logs:terminal', () => {
    const { socket, spawned } = setup();
    socket.trigger('logs:subscribe', { processName: 'critical-mass', lines: 100 });
    const child = spawned[0];

    socket.trigger('logs:unsubscribe');
    child.emit('close', 0, null); // delayed close arrives after unsubscribe

    const terminals = socket.emitted.filter(e => e.event === 'logs:terminal');
    const unsubscribed = socket.emitted.filter(e => e.event === 'logs:unsubscribed');
    assert.equal(terminals.length, 0, 'unsubscribe must not produce a terminal notification');
    assert.equal(unsubscribed.length, 1);
  });

  it('resubscribing to a new tail size replaces the stream without the old child clearing it', () => {
    const { socket, spawned, registry } = setup();
    socket.trigger('logs:subscribe', { processName: 'critical-mass', lines: 100 });
    const firstChild = spawned[0];

    socket.trigger('logs:subscribe', { processName: 'critical-mass', lines: 500 });
    const secondChild = spawned[1];

    assert.equal(firstChild.killed, true);
    assert.equal(registry.get('s1').process, secondChild);

    firstChild.emit('close', 0, null); // stale close from the replaced child

    const terminals = socket.emitted.filter(e => e.event === 'logs:terminal');
    assert.equal(terminals.length, 0, 'replaced child close must not notify');
    assert.equal(registry.get('s1').process, secondChild, 'replacement must remain active');
  });

  it('invalid process name is rejected without spawning', () => {
    const { socket, spawned } = setup();
    socket.trigger('logs:subscribe', { processName: 'not-allowed', lines: 100 });

    assert.equal(spawned.length, 0);
    const err = socket.emitted.find(e => e.event === 'logs:error');
    assert.ok(err);
  });
});
