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

describe('IPC client callback containment', () => {
  const eventFrame = (channel) => serialize(createMessage(MSG_TYPE.EVENT, channel, { n: 1 }));

  it('contains a throwing onEvent and keeps delivering later events', () => {
    let uncaught = null;
    const onUncaught = (err) => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      let calls = 0;
      const { sock } = openClient({ onEvent: () => { calls++; if (calls === 1) throw new Error('bad listener'); } });
      assert.doesNotThrow(() => sock.receive(eventFrame('regime:status')));
      assert.doesNotThrow(() => sock.receive(eventFrame('regime:status')));
      assert.equal(calls, 2, 'later event must still be delivered');
      assert.equal(uncaught, null);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('contains throwing onConnect and onDisconnect callbacks', () => {
    FakeWebSocket.instances = [];
    const client = createIPCClient('ws://127.0.0.1:5573', 'test', {
      onConnect: () => { throw new Error('connect boom'); },
      onDisconnect: () => { throw new Error('disconnect boom'); },
      reconnectMin: 60_000,
    });
    openClients.push(client);
    client.connect();
    const sock = FakeWebSocket.instances[0];
    assert.doesNotThrow(() => sock.open());
    assert.doesNotThrow(() => sock.peerClose());
  });
});

describe('IPC client failure codes', () => {
  const { IPC_ERROR_CODE } = require('../src/ipc/ipc-protocol');

  it('tags a request while disconnected as transport', async () => {
    FakeWebSocket.instances = [];
    const client = createIPCClient('ws://127.0.0.1:5573', 'test');
    await assert.rejects(client.request('regime:status', {}, 'coinbase'), (err) => err.code === IPC_ERROR_CODE.TRANSPORT);
  });

  it('tags an engine error reply as handler', async () => {
    const { client, sock } = openClient();
    const pending = client.request('regime:status', {}, 'coinbase');
    const sent = JSON.parse(sock.sent[sock.sent.length - 1]);
    sock.receive(serialize(createMessage(MSG_TYPE.RESPONSE, 'regime:status', null, { id: sent.id, error: 'handler blew up' })));
    await assert.rejects(pending, (err) => err.code === IPC_ERROR_CODE.HANDLER && err.message === 'handler blew up');
  });

  it('tags a deadline miss as timeout and a closed socket as transport', async () => {
    const { client, sock } = openClient();
    const timedOut = client.request('regime:status', {}, 'coinbase', 5);
    await assert.rejects(timedOut, (err) => err.code === IPC_ERROR_CODE.TIMEOUT);
    const closing = client.request('regime:status', {}, 'coinbase', 5000);
    sock.peerClose();
    await assert.rejects(closing, (err) => err.code === IPC_ERROR_CODE.TRANSPORT);
  });
});
