// @ts-check
/**
 * src/websocket-connection.js contract (issue #1180).
 *
 * The adapter over Node's global WebSocket must deliver exactly one `close`
 * per connection whatever the runtime does: Node 22 reports a failed
 * handshake as `error` with no `close` and readyState stuck at CONNECTING,
 * later runtimes report both. The controlled cases drive both shapes through
 * the fake; the real-runtime cases run the production client against the
 * owned server and a closed port on whichever Node executes the suite.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const { connectWebSocket } = require('../src/websocket-connection');
const { WebSocketServer } = require('../src/ipc/ws-server');
const { FakeWebSocket, installFakeWebSocket } = require('./helpers/fake-websocket');

const cleanups = [];
const onCleanup = (fn) => { cleanups.push(fn); };
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

const recorded = (connection) => {
  const log = { opens: 0, messages: [], errors: [], closes: [] };
  connection.on('open', () => { log.opens++; });
  connection.on('message', (data) => log.messages.push(data));
  connection.on('error', (err) => log.errors.push(err));
  connection.on('close', (code, reason) => log.closes.push({ code, reason }));
  return log;
};

describe('websocket-connection on a controlled socket', () => {
  const setup = () => {
    onCleanup(installFakeWebSocket());
    const connection = connectWebSocket('ws://127.0.0.1:1');
    const sock = FakeWebSocket.instances[0];
    return { connection, sock, log: recorded(connection) };
  };

  it('starts connecting, opens, sends only while open and delivers text and binary frames', () => {
    const { connection, sock, log } = setup();
    assert.equal(connection.isConnecting(), true);
    assert.equal(connection.send('early'), false, 'nothing is sent before open');
    assert.equal(sock.binaryType, 'arraybuffer');
    sock.open();
    assert.equal(connection.isOpen(), true);
    assert.equal(log.opens, 1);
    assert.equal(connection.send('{"a":1}'), true);
    assert.deepEqual(sock.sent, ['{"a":1}']);
    sock.receive('text');
    sock.receive(new Uint8Array([1, 2]).buffer);
    assert.equal(log.messages[0], 'text');
    assert.ok(Buffer.isBuffer(log.messages[1]));
    assert.deepEqual([...log.messages[1]], [1, 2]);
  });

  it('settles a Node 22-style failed handshake (error, no close) as a single close 1006', () => {
    const { connection, sock, log } = setup();
    sock.fail('Received network error or non-101 status code.');
    assert.deepEqual(log.closes, [{ code: 1006, reason: 'Received network error or non-101 status code.' }]);
    assert.equal(log.errors.length, 1);
    assert.equal(connection.state, 'closed');
    assert.equal(connection.isConnecting(), false, 'a stuck CONNECTING readyState must not block reconnects');
    sock.peerClose(1006);
    sock.open();
    sock.receive('late');
    assert.equal(log.closes.length, 1, 'a late runtime close is ignored');
    assert.equal(log.opens, 0);
    assert.deepEqual(log.messages, []);
  });

  it('settles a later-runtime failed handshake (error then close) as a single close with the runtime code', () => {
    const { sock, log } = setup();
    sock.fail('', { close: true });
    assert.equal(log.closes.length, 1, 'error and close collapse into one close');
    assert.equal(log.closes[0].code, 1006);
    assert.equal(log.errors.length, 1);
    assert.match(log.errors[0].message, /ws:\/\/127\.0\.0\.1:1/, 'an empty runtime message is replaced by one naming the URL');
  });

  it('reports an error after open without closing until the runtime closes', () => {
    const { connection, sock, log } = setup();
    sock.open();
    sock.fail('reset');
    assert.equal(log.errors.length, 1);
    assert.equal(log.closes.length, 0);
    assert.equal(connection.isOpen(), true);
    sock.peerClose(1006, 'reset');
    assert.deepEqual(log.closes, [{ code: 1006, reason: 'reset' }]);
  });

  it('close() waits for the peer and then reports the peer code and reason', () => {
    const { connection, sock, log } = setup();
    sock.open();
    connection.close(1000, 'done');
    assert.equal(connection.state, 'closing');
    assert.deepEqual(sock.closeCalls, [{ code: 1000, reason: 'done' }]);
    assert.equal(connection.send('x'), false);
    assert.equal(log.closes.length, 0);
    connection.close(1000, 'again');
    assert.equal(sock.closeCalls.length, 1, 'close is forwarded once');
    sock.peerClose(1000, 'done');
    assert.deepEqual(log.closes, [{ code: 1000, reason: 'done' }]);
  });

  it('close() while still connecting settles through the runtime error on Node 22', () => {
    const { connection, sock, log } = setup();
    connection.close();
    assert.deepEqual(sock.closeCalls, [{ code: undefined, reason: undefined }]);
    sock.fail('Connection was closed before it was established.');
    assert.equal(log.closes.length, 1);
    assert.equal(connection.state, 'closed');
  });

  it('terminate() detaches immediately, closes best-effort and reports 1006 exactly once', () => {
    const { connection, sock, log } = setup();
    sock.open();
    connection.terminate();
    assert.deepEqual(log.closes, [{ code: 1006, reason: 'terminated' }]);
    assert.equal(sock.closeCalls.length, 1, 'the runtime socket is asked to close');
    assert.equal(connection.send('x'), false);
    connection.terminate();
    connection.close();
    sock.receive('stale');
    sock.peerClose(1000);
    assert.equal(log.closes.length, 1);
    assert.deepEqual(log.messages, []);
  });

  it('never throws on a transport error when nobody listens for errors', () => {
    onCleanup(installFakeWebSocket());
    const connection = connectWebSocket('ws://127.0.0.1:1');
    const closes = [];
    connection.on('close', (code) => closes.push(code));
    assert.doesNotThrow(() => FakeWebSocket.instances[0].fail());
    assert.deepEqual(closes, [1006]);
  });

  it('refuses to start without a global WebSocket', () => {
    const original = globalThis.WebSocket;
    // @ts-ignore simulating a runtime below the floor
    globalThis.WebSocket = undefined;
    onCleanup(() => { globalThis.WebSocket = original; });
    assert.throws(() => connectWebSocket('ws://127.0.0.1:1'), /Node\.js 22 or newer/);
  });
});

describe('websocket-connection on the real runtime', () => {
  const startServer = async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    onCleanup(() => new Promise((resolve) => { for (const c of server.clients) c.terminate(); server.close(() => resolve(undefined)); }));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { server, url: `ws://127.0.0.1:${port}` };
  };

  const until = async (predicate, label, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(5);
    }
  };

  it('round-trips text with the owned server and reports a server-initiated close code and reason', async () => {
    const { server, url } = await startServer();
    const serverSide = [];
    server.on('connection', (peer) => { peer.on('message', (data) => { serverSide.push(data); peer.send(`echo:${data}`); }); });
    const connection = connectWebSocket(url);
    onCleanup(() => connection.terminate());
    const log = recorded(connection);
    await until(() => connection.isOpen(), 'open');
    connection.send('hello');
    await until(() => log.messages.length === 1, 'echo');
    assert.deepEqual(log.messages, ['echo:hello']);
    assert.deepEqual(serverSide, ['hello']);
    for (const peer of server.clients) peer.close(4002, 'engine stopping');
    await until(() => log.closes.length === 1, 'close');
    assert.deepEqual(log.closes, [{ code: 4002, reason: 'engine stopping' }]);
    assert.equal(connection.state, 'closed');
  });

  it('reports exactly one close for a refused connection on this runtime', async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
    await new Promise((resolve) => probe.close(() => resolve(undefined)));
    const connection = connectWebSocket(`ws://127.0.0.1:${port}`);
    const log = recorded(connection);
    await until(() => log.closes.length === 1, 'refused close');
    await sleep(50);
    assert.equal(log.closes.length, 1);
    assert.equal(log.closes[0].code, 1006);
    assert.equal(connection.isConnecting(), false);
    assert.equal(log.opens, 0);
  });

  it('reports exactly one close when the server refuses the upgrade', async () => {
    const refusing = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: () => false });
    await once(refusing, 'listening');
    onCleanup(() => new Promise((resolve) => refusing.close(() => resolve(undefined))));
    const { port } = /** @type {import('node:net').AddressInfo} */ (refusing.address());
    const connection = connectWebSocket(`ws://127.0.0.1:${port}`);
    const log = recorded(connection);
    await until(() => log.closes.length === 1, 'rejected close');
    await sleep(50);
    assert.equal(log.closes.length, 1);
    assert.equal(log.opens, 0);
  });
});
