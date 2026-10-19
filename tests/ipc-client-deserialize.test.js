// @ts-check
/**
 * IPC client malformed-frame hardening tests (issue #157)
 *
 * The gateway-side IPC client's message handler must not let a non-JSON /
 * truncated frame throw an uncaught exception out of the socket event
 * handler. It mirrors `ipc-server.js`: deserialize inside try/catch, log+return
 * on failure, and never deliver a bad frame to handleIncoming / onEvent.
 *
 * Uses the fake global WebSocket so we can drive the 'message' event
 * deterministically without a real socket.
 */
const { describe, it, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

// Installed before the client connects so it picks up the fake.
const restoreWebSocket = installFakeWebSocket();
after(restoreWebSocket);

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
  sock.open();
  return { client, sock };
};

afterEach(() => { openClients.splice(0).forEach((c) => c.disconnect()); });

describe('IPC client malformed-frame handling', () => {
  it('does not throw out of the message handler on a non-JSON frame', () => {
    const { sock } = openClient();
    assert.doesNotThrow(() => sock.receive('not json{'));
  });

  it('does not throw on a truncated JSON frame', () => {
    const { sock } = openClient();
    assert.doesNotThrow(() => sock.receive('{"type":"event"'));
  });

  it('does not throw on a well-formed JSON null frame', () => {
    const { sock } = openClient();
    assert.doesNotThrow(() => sock.receive('null'));
  });

  it('does not deliver a malformed frame to onEvent', () => {
    let delivered = 0;
    const { sock } = openClient({ onEvent: () => { delivered++; } });
    sock.receive('garbage');
    assert.equal(delivered, 0, 'malformed frame must be dropped, not forwarded');
  });

  it('still delivers a well-formed event after a malformed one', () => {
    /** @type {object[]} */
    const events = [];
    const { sock } = openClient({ onEvent: (msg) => { events.push(msg); } });
    sock.receive('garbage');
    const good = createMessage(MSG_TYPE.EVENT, 'tick', { price: 1 });
    sock.receive(serialize(good));
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'tick');
  });
});
