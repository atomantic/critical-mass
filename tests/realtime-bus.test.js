// @ts-check
/**
 * Contract for the admin realtime bus (src/realtime-bus.js) over a real HTTP
 * server, real operator authentication and Node's global WebSocket client:
 * the upgrade-time operator check, room delivery, broadcast, unsubscribe,
 * client events, shutdown refusal, credential revocation, heartbeats and
 * closing every attached listener.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createRealtimeBus } = require('../src/realtime-bus');
const { createOperatorAuth, COOKIE_NAME } = require('../src/operator-auth');
const { readJSON, writeJSON } = require('../src/shared-utils');

const PASSWORD = 'realtime-bus-password';

const tmpAuthFile = (t) => {
  const file = path.join(os.tmpdir(), `realtime-bus-auth-${process.pid}-${crypto.randomUUID()}.json`);
  const salt = crypto.randomBytes(16).toString('hex');
  writeJSON(file, { kdf: 'scrypt', salt, hash: crypto.scryptSync(PASSWORD, Buffer.from(salt, 'hex'), 32).toString('hex') });
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
};

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
};

const closeServer = (server) => new Promise((resolve) => {
  server.close(() => resolve(undefined));
  server.closeAllConnections?.();
});

/**
 * Start a bus on `count` HTTP listeners. With `auth: true` the real operator
 * check guards upgrades and the listeners serve the real sign-in routes.
 */
const startBus = async (t, { count = 1, auth = false, ...options } = {}) => {
  const operatorAuth = auth ? createOperatorAuth({ authFile: tmpAuthFile(t), readJSON, writeJSON }) : null;
  const app = express();
  app.use(express.json());
  operatorAuth?.registerSessionRoutes(app);
  const servers = Array.from({ length: count }, () => http.createServer(app));
  const bus = createRealtimeBus({
    ...(operatorAuth ? { authorize: (req) => operatorAuth.authorizeUpgrade(req) } : {}),
    ...options,
  });
  for (const server of servers) bus.attach(server);
  // Echo for roundTrip(): frames on one connection are handled in order.
  bus.on('connection', (socket) => socket.on('test:sync', (marker) => socket.emit('test:synced', marker)));
  const hosts = [];
  for (const server of servers) hosts.push(await listen(server));
  t.after(async () => {
    await Promise.all([bus.close(), ...servers.map(closeServer)]);
  });
  return { bus, servers, hosts };
};

/** The session cookie a signed-in browser carries, from the real sign-in route. */
const signIn = async (host) => {
  const login = await fetch(`http://${host}/api/auth/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith(`${COOKIE_NAME}=`), 'sign-in produced a session cookie');
  return cookie;
};

/** Raw upgrade request: resolves the HTTP status the server answered with. */
const upgradeStatus = (host, headers = {}, pathname = '/realtime') => new Promise((resolve, reject) => {
  const req = http.request({
    host: host.split(':')[0], port: Number(host.split(':')[1]), path: pathname,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers,
    },
  });
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
  req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end();
});

/**
 * Open a client and wait for the bus's `open` frame. Records every frame;
 * answers pings unless `pong: false`.
 */
const connect = (t, host, { headers = {}, pong = true, scoped = false } = {}) => new Promise((resolve, reject) => {
  // @ts-ignore Node's WebSocket accepts { headers }
  const ws = new WebSocket(`ws://${host}/realtime${scoped ? "?scopedRegimeStatus=1" : ""}`, { headers });
  const client = { ws, frames: /** @type {any[]} */ ([]), id: null, closed: null };
  t.after(() => ws.close());
  ws.addEventListener('message', ({ data }) => {
    const frame = JSON.parse(String(data));
    client.frames.push(frame);
    if (frame.t === 'open') {
      client.id = frame.id;
      resolve(client);
    }
    if (frame.t === 'ping' && pong) ws.send(JSON.stringify({ t: 'pong' }));
  });
  client.closed = new Promise((done) => ws.addEventListener('close', ({ code, reason }) => done({ code, reason })));
  ws.addEventListener('error', () => reject(new Error('upgrade refused')));
});

const send = (client, frame) => client.ws.send(JSON.stringify(frame));
const events = (client, name) => client.frames.filter((f) => f.t === 'event' && f.e === name).map((f) => f.p);
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Round-trip through the server: once the echo of a client-sent marker
 * arrives, every earlier client frame was handled and every earlier server
 * frame was delivered.
 */
const roundTrip = async (client) => {
  const marker = crypto.randomUUID();
  send(client, { t: 'event', e: 'test:sync', p: marker });
  for (let i = 0; i < 200 && !events(client, 'test:synced').includes(marker); i++) await settle(5);
  assert.ok(events(client, 'test:synced').includes(marker), 'server echoed the sync marker');
};

describe('scoped regime statuses', () => {
  it('preserves legacy broadcasts, isolates pairs and deduplicates overlapping rooms', async (t) => {
    const { bus, hosts: [host] } = await startBus(t, { rooms: ['updown'] });
    const legacy = await connect(t, host);
    const config = await connect(t, host, { scoped: true });
    const dashboard = await connect(t, host, { scoped: true });
    const overview = await connect(t, host, { scoped: true });
    send(dashboard, { t: 'sub', r: 'regime:status:gemini:BTCUSD' });
    send(overview, { t: 'sub', r: 'regime:status:all' });
    send(overview, { t: 'sub', r: 'regime:status:gemini:BTCUSD' });
    await Promise.all([legacy, config, dashboard, overview].map(roundTrip));
    const statuses = ['BTCUSD', 'ETHUSD'].map(pair => ({ exchange: 'gemini', pair, status: { running: true } }));
    for (const status of statuses) bus.emit('regime:status', status);
    bus.emit('trade:event', { id: 1 });
    bus.emit('alert', { id: 2 });
    await Promise.all([legacy, config, dashboard, overview].map(roundTrip));
    assert.deepEqual(events(legacy, 'regime:status'), statuses);
    assert.deepEqual(events(config, 'regime:status'), []);
    assert.deepEqual(events(dashboard, 'regime:status'), [statuses[0]]);
    assert.deepEqual(events(overview, 'regime:status'), statuses);
    assert.deepEqual(events(config, 'trade:event'), [{ id: 1 }]);
    assert.deepEqual(events(config, 'alert'), [{ id: 2 }]);
    send(dashboard, { t: 'unsub', r: 'regime:status:gemini:BTCUSD' });
    await roundTrip(dashboard);
    bus.emit('regime:status', statuses[0]);
    await roundTrip(dashboard);
    assert.equal(events(dashboard, 'regime:status').length, 1);
  });
});

describe('compact regime state notifications', () => {
  it('announces header state to every socket only when it changes', async (t) => {
    const { bus, hosts: [host] } = await startBus(t);
    const legacy = await connect(t, host);
    const config = await connect(t, host, { scoped: true });
    const status = (isRunning, extra = {}) => ({ exchange: 'gemini', pair: 'BTCUSD', status: { isRunning, isDryRun: false, lifecycle: { lifecycle: 'active' }, big: 'x'.repeat(1000), ...extra } });
    bus.emit('regime:status', status(true));
    bus.emit('regime:status', status(true, { lastPrice: 2 }));
    bus.emit('regime:status', status(true, { isDryRun: true }));
    bus.emit('regime:status', status(false));
    bus.emit('regime:status', { exchange: 'gemini', pair: 'BTCUSD', status: { regime: 'range' } });
    bus.emit('regime:status', { exchange: 'gemini', status: { isRunning: true } });
    await Promise.all([legacy, config].map(roundTrip));
    const expected = [
      { exchange: 'gemini', pair: 'BTCUSD', isRunning: true, isDryRun: false, lifecycle: 'active' },
      { exchange: 'gemini', pair: 'BTCUSD', isRunning: true, isDryRun: true, lifecycle: 'active' },
      { exchange: 'gemini', pair: 'BTCUSD', isRunning: false, isDryRun: false, lifecycle: 'active' },
    ];
    assert.deepEqual(events(config, 'regime:state'), expected);
    assert.deepEqual(events(legacy, 'regime:state'), expected);
    assert.deepEqual(events(config, 'regime:status'), [], 'the full status stays room-scoped');
  });

  it('announces a lost engine\'s running funds as stopped and recovers on the next status', async (t) => {
    const { bus, hosts: [host] } = await startBus(t);
    const client = await connect(t, host, { scoped: true });
    const status = (exchange, isRunning) => ({ exchange, pair: 'P', status: { isRunning, isDryRun: false } });
    bus.emit('regime:status', status('gemini', true));
    bus.emit('regime:status', status('coinbase', true));
    bus.emit('regime:status', status('cryptocom', false));
    bus.engineDown('gemini');
    bus.engineDown('gemini');
    bus.engineDown('cryptocom');
    bus.emit('regime:status', status('gemini', true));
    bus.emit('regime:status', status('cryptocom', false));
    await roundTrip(client);
    assert.deepEqual(events(client, 'regime:state').map(({ exchange, isRunning }) => `${exchange}:${isRunning}`), [
      'gemini:true', 'coinbase:true', 'cryptocom:false', 'gemini:false', 'gemini:true', 'cryptocom:false',
    ]);
  });
});

describe('realtime bus: operator check at upgrade', () => {
  it('upgrades only with an operator session or bearer password from this origin', async (t) => {
    const { hosts: [host], bus } = await startBus(t, { auth: true });
    const cookie = await signIn(host);
    assert.equal(await upgradeStatus(host), 401, 'no credentials');
    assert.equal(await upgradeStatus(host, { Cookie: `${COOKIE_NAME}=forged` }), 401, 'invalid session');
    assert.equal(await upgradeStatus(host, { Authorization: 'Bearer wrong-password' }), 401, 'wrong bearer');
    assert.equal(await upgradeStatus(host, { Cookie: cookie, Origin: 'https://attacker.invalid' }), 401, 'foreign origin');
    assert.equal(await upgradeStatus(host, { Cookie: cookie, Origin: `http://${host}` }), 101, 'same-origin session');
    assert.equal(await upgradeStatus(host, { Authorization: `Bearer ${PASSWORD}` }), 101, 'bearer without Origin');

    const client = await connect(t, host, { headers: { Cookie: cookie, Origin: `http://${host}` } });
    const open = client.frames[0];
    assert.equal(open.t, 'open');
    assert.equal(typeof open.id, 'string');
    assert.equal(open.pingInterval, 25000);
    assert.equal(open.pingTimeout, 20000);
    assert.ok(bus.sockets.has(open.id));
    await assert.rejects(connect(t, host), /upgrade refused/);
  });

  it('refuses other paths and malformed handshakes', async (t) => {
    const { hosts: [host] } = await startBus(t);
    assert.equal(await upgradeStatus(host, {}, '/socket.io/?EIO=4&transport=websocket'), 404);
    assert.equal(await upgradeStatus(host, { 'Sec-WebSocket-Version': '8' }), 426);
    assert.equal(await upgradeStatus(host, { 'Sec-WebSocket-Key': 'short' }), 400);
    assert.equal(await upgradeStatus(host, {}, '/realtime?reconnect=1'), 101, 'query strings are ignored');
  });

  it('answers a rate-limited credential check with its status', async (t) => {
    const { hosts: [host] } = await startBus(t, { authorize: () => Promise.reject(Object.assign(new Error('busy'), { status: 429, headers: { 'Retry-After': '1' } })) });
    assert.equal(await upgradeStatus(host), 429);
  });

  it('releases a refused socket even when the peer never closes its side', async (t) => {
    const { servers: [server], hosts: [host] } = await startBus(t, { auth: true });
    const [hostname, port] = host.split(':');
    // allowHalfOpen: the peer keeps writing open after the gateway's FIN.
    const peer = net.connect({ host: hostname, port: Number(port), allowHalfOpen: true });
    const connections = () => new Promise((resolve, reject) => server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
    try {
      let response = '';
      peer.on('data', (chunk) => { response += chunk; });
      peer.write([
        'GET /realtime HTTP/1.1', `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, '', '',
      ].join('\r\n'));
      await new Promise((resolve) => peer.once('end', resolve));
      assert.match(response, /^HTTP\/1\.1 401 /);
      for (let i = 0; i < 200 && await connections() > 0; i++) await settle(5);
      assert.equal(await connections(), 0, 'the gateway released the refused socket');
    } finally {
      // Before teardown: a still-open refused socket would stall server.close().
      peer.destroy();
    }
  });
});

describe('realtime bus: delivery', () => {
  it('delivers room emits to subscribers only, broadcasts to everyone, and stops after unsubscribe', async (t) => {
    const { bus, hosts: [host] } = await startBus(t, { rooms: ['updown', 'sentinel'] });
    const [subscriber, other] = [await connect(t, host), await connect(t, host)];
    send(subscriber, { t: 'sub', r: 'updown' });
    send(other, { t: 'sub', r: 'not-a-room' });
    await roundTrip(subscriber);
    await roundTrip(other);
    assert.deepEqual([...bus.sockets.get(subscriber.id).rooms], ['updown']);
    assert.deepEqual([...bus.sockets.get(other.id).rooms], [], 'rooms outside the allowlist are ignored');

    bus.to('updown').emit('updown:tick', { price: 1 });
    bus.to('sentinel').emit('sentinel:status', { running: true });
    bus.emit('trade:event', { id: 'broadcast' });
    await roundTrip(subscriber);
    await roundTrip(other);
    assert.deepEqual(events(subscriber, 'updown:tick'), [{ price: 1 }]);
    assert.deepEqual(events(other, 'updown:tick'), []);
    assert.deepEqual(events(subscriber, 'sentinel:status'), []);
    assert.deepEqual(events(subscriber, 'trade:event'), [{ id: 'broadcast' }]);
    assert.deepEqual(events(other, 'trade:event'), [{ id: 'broadcast' }]);

    send(subscriber, { t: 'unsub', r: 'updown' });
    await roundTrip(subscriber);
    bus.to('updown').emit('updown:tick', { price: 2 });
    await roundTrip(subscriber);
    assert.deepEqual(events(subscriber, 'updown:tick'), [{ price: 1 }]);
  });

  it('dispatches client events to socket handlers, isolates handler failures and never lets a client fire disconnect', async (t) => {
    const logs = [];
    const { bus, hosts: [host] } = await startBus(t, { log: (level, message) => logs.push(`${level} ${message}`) });
    const received = [];
    let disconnects = 0;
    bus.on('connection', (socket) => {
      socket.on('logs:subscribe', (payload) => received.push(payload));
      socket.on('logs:unsubscribe', () => { throw new Error('handler failure'); });
      socket.on('disconnect', () => { disconnects++; });
      socket.emit('welcome', { id: socket.id });
    });
    const client = await connect(t, host);
    await roundTrip(client);
    assert.deepEqual(events(client, 'welcome'), [{ id: client.id }], 'events emitted during connection follow the open frame');
    send(client, { t: 'event', e: 'logs:subscribe', p: { processName: 'critical-mass' } });
    send(client, { t: 'event', e: 'logs:unsubscribe' });
    send(client, { t: 'event', e: 'disconnect' });
    send(client, { t: 'event', e: 'logs:subscribe', p: { processName: 'after-failure' } });
    await roundTrip(client);
    assert.deepEqual(received, [{ processName: 'critical-mass' }, { processName: 'after-failure' }]);
    assert.equal(disconnects, 0);
    assert.ok(logs.some((line) => /logs:unsubscribe handler failed/.test(line)));
    assert.equal(client.ws.readyState, WebSocket.OPEN);
  });

  it('closes a connection that sends something other than a protocol message', async (t) => {
    const { hosts: [host] } = await startBus(t);
    for (const raw of ['not json', '[1,2]', JSON.stringify({ t: 'bogus' })]) {
      const client = await connect(t, host);
      client.ws.send(raw);
      assert.equal((await client.closed).code, 1008, raw);
    }
  });
});

describe('realtime bus: shutdown and revocation', () => {
  it('refuses upgrades and drops inbound client messages while the gateway is stopping', async (t) => {
    let stopping = false;
    const received = [];
    const joins = [];
    const { bus, hosts: [host] } = await startBus(t, { isStopping: () => stopping, rooms: ['updown'] });
    bus.on('connection', (socket) => {
      socket.on('logs:flush', (payload) => received.push(payload));
      const join = socket.join;
      socket.join = (room) => { joins.push(room); join(room); };
    });
    const client = await connect(t, host);
    stopping = true;
    assert.equal(await upgradeStatus(host), 503);
    send(client, { t: 'event', e: 'logs:flush', p: { processName: 'critical-mass' } });
    send(client, { t: 'sub', r: 'updown' });
    // Client events are dropped while stopping, so sync on the close an
    // invalid frame causes: it is handled after the two frames above.
    client.ws.send('not json');
    assert.equal((await client.closed).code, 1008);
    assert.deepEqual(received, []);
    assert.deepEqual(joins, []);
  });

  it('disconnectSockets tears every socket down synchronously on every listener', async (t) => {
    const { bus, hosts } = await startBus(t, { count: 2 });
    const cleaned = [];
    bus.on('connection', (socket) => socket.on('disconnect', (reason) => cleaned.push(reason)));
    const clients = [await connect(t, hosts[0]), await connect(t, hosts[1])];
    bus.disconnectSockets();
    assert.deepEqual(cleaned, ['server disconnect', 'server disconnect'], 'cleanup ran before disconnectSockets returned');
    assert.equal(bus.sockets.size, 0);
    bus.emit('trade:event', { revoked: true });
    for (const client of clients) {
      assert.equal((await client.closed).code, 1008);
      assert.deepEqual(events(client, 'trade:event'), []);
    }
  });

  it('close() closes every connection with 1001 and refuses new upgrades', async (t) => {
    const { bus, servers, hosts } = await startBus(t, { count: 2 });
    const clients = [await connect(t, hosts[0]), await connect(t, hosts[1])];
    await bus.close();
    for (const client of clients) assert.deepEqual(await client.closed, { code: 1001, reason: 'Gateway is shutting down' });
    assert.equal(await upgradeStatus(hosts[0]), 503);
    await Promise.all(servers.map(closeServer));
  });
});

describe('realtime bus: heartbeat', () => {
  it('pings on the interval, keeps answering clients and terminates silent ones after the timeout', async (t) => {
    const { bus, hosts: [host] } = await startBus(t, { pingInterval: 40, pingTimeout: 60 });
    const answering = await connect(t, host);
    const silent = await connect(t, host, { pong: false });
    assert.equal(answering.frames[0].pingInterval, 40);
    const { code } = await silent.closed;
    assert.equal(code, 1006, 'a missed heartbeat drops the TCP connection');
    await settle(150);
    assert.ok(answering.frames.filter((f) => f.t === 'ping').length >= 3);
    assert.equal(answering.ws.readyState, WebSocket.OPEN);
    assert.ok(bus.sockets.has(answering.id));
    assert.equal(bus.sockets.has(silent.id), false);
  });
});
