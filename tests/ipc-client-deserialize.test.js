// @ts-check
/**
 * IPC client malformed-frame hardening tests (issue #157)
 *
 * The gateway-side IPC client's `ws.on('message')` handler must not let a
 * non-JSON / truncated frame throw an uncaught exception out of the ws event
 * handler. It mirrors `ipc-server.js`: deserialize inside try/catch, log+return
 * on failure, and never deliver a bad frame to handleIncoming / onEvent.
 *
 * Uses a fake `ws` module injected via require.cache so we can drive the
 * 'message' event deterministically without a real socket.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

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
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
}

// Inject the fake 'ws' module BEFORE loading the IPC client so it picks it up.
const wsPath = require.resolve('ws');
require.cache[wsPath] = /** @type {any} */ ({
  id: wsPath,
  filename: wsPath,
  path: wsPath,
  loaded: true,
  exports: FakeWebSocket,
  children: [],
});
delete require.cache[require.resolve('../src/ipc/ipc-client')];

const { createIPCClient } = require('../src/ipc/ipc-client');
const { MSG_TYPE, createMessage, serialize } = require('../src/ipc/ipc-protocol');

/** @type {Array<{ disconnect: () => void }>} */
const openClients = [];

/**
 * Create + connect a client, returning the underlying fake socket.
 * `open` starts a 15s ping interval, so every client is torn down in
 * afterEach to avoid leaking a timer that keeps `node --test` alive.
 * @param {object} [options]
 */
const openClient = (options = {}) => {
  FakeWebSocket.instances = [];
  const client = createIPCClient('ws://127.0.0.1:5573', 'test', options);
  openClients.push(client);
  client.connect();
  const sock = FakeWebSocket.instances[0];
  sock.emit('open');
  return { client, sock };
};

afterEach(() => { openClients.splice(0).forEach((c) => c.disconnect()); });

describe('IPC client malformed-frame handling', () => {
  it('does not throw out of the message handler on a non-JSON frame', () => {
    const { sock } = openClient();
    assert.doesNotThrow(() => sock.emit('message', Buffer.from('not json{')));
  });

  it('does not throw on a truncated JSON frame', () => {
    const { sock } = openClient();
    assert.doesNotThrow(() => sock.emit('message', Buffer.from('{"type":"event"')));
  });

  it('does not throw on a well-formed JSON null frame', () => {
    const { sock } = openClient();
    assert.doesNotThrow(() => sock.emit('message', Buffer.from('null')));
  });

  it('does not deliver a malformed frame to onEvent', () => {
    let delivered = 0;
    const { sock } = openClient({ onEvent: () => { delivered++; } });
    sock.emit('message', Buffer.from('garbage'));
    assert.equal(delivered, 0, 'malformed frame must be dropped, not forwarded');
  });

  it('still delivers a well-formed event after a malformed one', () => {
    /** @type {object[]} */
    const events = [];
    const { sock } = openClient({ onEvent: (msg) => { events.push(msg); } });
    sock.emit('message', Buffer.from('garbage'));
    const good = createMessage(MSG_TYPE.EVENT, 'tick', { price: 1 });
    sock.emit('message', Buffer.from(serialize(good)));
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'tick');
  });
});
