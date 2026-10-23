// @ts-check
const { it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setImmediate: tick } = require('node:timers/promises');
const { WebSocketServer, OPEN } = require('../src/ipc/ws-server');
const { createIPCServer, MAX_PENDING_BYTES, MAX_HELD_EVENTS } = require('../src/ipc/ipc-server');
const { createMessage, MSG_TYPE, IPC_SECRET_HEADER } = require('../src/ipc/ipc-protocol');
const { forwardTradeEvents } = require('../src/ipc/realtime-proxy');
const { EventEmitter } = require('node:events');
const { getFreePort, until } = require('./helpers/ipc-command-harness');

const fixture = async (t) => {
  const peers = [];
  const emit = WebSocketServer.prototype.emit;
  t.mock.method(WebSocketServer.prototype, 'emit', function (event, ...args) {
    if (event === 'connection') peers.push(args[0]);
    return emit.call(this, event, ...args);
  });
  const port = await getFreePort();
  const secret = 'synthetic-backpressure-test';
  const server = createIPCServer(port, 'backpressure-test', { secret });
  await server.start();
  t.after(() => { for (const peer of peers) peer.terminate(); server.stop(); });
  const connect = async (paused = false) => {
    const before = peers.length;
    const socket = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', [IPC_SECRET_HEADER]: secret,
      } });
      req.on('error', reject);
      req.on('response', (res) => { res.resume(); reject(new Error(`Upgrade refused: ${res.statusCode}`)); });
      req.on('upgrade', (_res, socket) => resolve(socket));
      req.end();
    });
    t.after(() => socket.destroy());
    await until(() => peers.length > before, 'IPC handshake');
    if (paused) socket.pause(); else socket.resume();
    return { socket, peer: peers[before] };
  };
  // Small masked text commands, sufficient for requests, pings and subscribe.
  const command = (socket, type, channel = 'test') => {
    const data = Buffer.from(JSON.stringify(createMessage(type, channel, {})));
    assert.ok(data.length < 65536);
    const header = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length])
      : Buffer.from([0x81, 0xfe, data.length >> 8, data.length & 255]);
    socket.write(Buffer.concat([header, Buffer.alloc(4), data]));
  };
  return { server, connect, command };
};

it('disconnects a real paused IPC reader within 8 MiB, flushes and lets a healthy peer progress', { timeout: 10000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const slow = await connect(true);
  const healthy = await connect();
  const healthyChunks = [];
  healthy.socket.on('data', (data) => { healthyChunks.push(data); });
  const events = new EventEmitter();
  t.after(forwardTradeEvents(server, events));
  let peak = 0;
  let emitted = 0;
  for (; emitted < 512 && slow.peer.readyState === OPEN; emitted++) {
    events.emit('trade', { sequence: emitted, data: 'x'.repeat(64 * 1024) });
    peak = Math.max(peak, slow.peer.bufferedAmount);
    // Allow the healthy socket to drain; the paused peer retains its backlog.
    await tick();
  }
  assert.notEqual(slow.peer.readyState, OPEN, 'slow peer must be terminated');
  assert.ok(peak > MAX_PENDING_BYTES / 2, 'real transport accumulated backpressure');
  assert.ok(peak <= MAX_PENDING_BYTES, `queued bytes ${peak} never exceed cap`);
  await server.flush();
  assert.equal(server.getHeldEventCount(), 0, 'healthy peer accepted the trade event');
  server.broadcast('after-disconnect', { alive: true });
  await server.flush();
  await until(() => Buffer.concat(healthyChunks).includes(Buffer.from('after-disconnect')), 'healthy delivery after slow disconnect');
  assert.equal(healthy.peer.readyState, OPEN);
});

it('retains the newly refused trade event and bounds disconnected holding for the next gateway', async (t) => {
  const { server, connect, command } = await fixture(t);
  const slow = await connect(true);
  // Leave precisely no room for even a small prospective frame. No socket write
  // is allowed, including the held trade event that must survive this refusal.
  Object.defineProperty(slow.peer, 'bufferedAmount', { get: () => MAX_PENDING_BYTES });
  const events = new EventEmitter();
  t.after(forwardTradeEvents(server, events));
  events.emit('trade', { trade: 'refused-fill' });
  assert.notEqual(slow.peer.readyState, OPEN);
  assert.equal(server.getHeldEventCount(), 1);
  const next = await connect();
  const received = [];
  next.socket.on('data', (data) => received.push(data));
  command(next.socket, MSG_TYPE.SUBSCRIBE);
  await until(() => server.getHeldEventCount() === 0, 'held trade replay');
  await server.flush();
  await until(() => received.length > 0, 'trade bytes');
  assert.match(Buffer.concat(received).toString(), /refused-fill/);
  next.peer.terminate();
  for (let i = 0; i < MAX_HELD_EVENTS + 20; i++) server.broadcast('trade:event', { i }, { hold: true });
  assert.equal(server.getHeldEventCount(), MAX_HELD_EVENTS);
});

it('bounds held replay and preserves the unaccepted tail for another subscribing gateway', async (t) => {
  const { server, connect, command } = await fixture(t);
  for (let i = 0; i < 150; i++) server.broadcast('trade:event', { i, data: 'x'.repeat(64 * 1024) }, { hold: true });
  const slow = await connect(true);
  let peak = 0;
  const send = slow.peer.send.bind(slow.peer);
  t.mock.method(slow.peer, 'send', (...args) => { send(...args); peak = Math.max(peak, slow.peer.bufferedAmount); });
  command(slow.socket, MSG_TYPE.SUBSCRIBE);
  await until(() => slow.peer.readyState !== OPEN, 'replay cap disconnect');
  await server.flush();
  assert.ok(peak <= MAX_PENDING_BYTES);
  assert.ok(server.getHeldEventCount() > 0 && server.getHeldEventCount() < 150);
  const next = await connect();
  command(next.socket, MSG_TYPE.SUBSCRIBE);
  await until(() => server.getHeldEventCount() === 0, 'remaining replay');
  await server.flush();
  assert.equal(next.peer.readyState, OPEN);
});

for (const kind of ['response', 'initializing', 'shutting-down', 'unknown-handler', 'pong']) {
  it(`applies the prospective-frame cap to ${kind}`, async (t) => {
    const { server, connect, command } = await fixture(t);
    server.onRequest('test', async () => ({ success: true }));
    if (kind === 'initializing') server.setInitializing(true);
    const client = await connect(true);
    if (kind === 'shutting-down') server.setShuttingDown(true);
    Object.defineProperty(client.peer, 'bufferedAmount', { get: () => MAX_PENDING_BYTES - 1 });
    t.mock.method(client.peer, 'send', () => assert.fail('over-cap message must not be queued'));
    command(client.socket, kind === 'pong' ? MSG_TYPE.PING : MSG_TYPE.REQUEST, kind === 'unknown-handler' ? 'unknown' : 'test');
    await until(() => client.peer.readyState !== OPEN, 'response cap disconnect');
    await server.flush();
  });
}

it('rejects an oversized response before writing even to an empty socket', async (t) => {
  const { server, connect, command } = await fixture(t);
  server.onRequest('test', async () => ({ data: 'x'.repeat(MAX_PENDING_BYTES) }));
  const client = await connect();
  assert.equal(client.peer.bufferedAmount, 0);
  t.mock.method(client.peer, 'send', () => assert.fail('oversized response must not be queued'));
  command(client.socket, MSG_TYPE.REQUEST);
  await until(() => client.peer.readyState !== OPEN, 'oversized response disconnect');
  await server.flush();
});
