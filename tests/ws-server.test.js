// @ts-check
/**
 * Owned loopback WebSocket server parity suite (issue #1180).
 *
 * Drives src/ipc/ws-server.js with hand-built RFC 6455 frames over raw TCP so
 * every protocol obligation the engine IPC relied on `ws` for is pinned:
 * handshake, masked text frames across the 7/16/64-bit length encodings,
 * fragmentation with interleaved control frames, ping/pong, both close
 * handshakes, Origin refusal, protocol-error close codes and send
 * backpressure. One interop case runs Node's global WebSocket client end to
 * end so the server is proven against the production client too.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const { WebSocketServer, OPEN, CLOSING, CLOSED } = require('../src/ipc/ws-server');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptFor = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

/** Resources released in afterEach so a failed assertion cannot leak sockets. */
const cleanups = [];
const onCleanup = (fn) => { cleanups.push(fn); };
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

/** Start a server on an OS-assigned loopback port. */
const listen = async (options = {}) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...options });
  await once(server, 'listening');
  onCleanup(() => new Promise((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  }));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, port, url: `ws://127.0.0.1:${port}` };
};

/** Build one client→server frame (masked unless told otherwise). */
const frame = (opcode, payload = '', { fin = true, mask = true, rsv = 0 } = {}) => {
  const body = Buffer.from(payload);
  const len = body.length;
  const lengthBytes = len < 126 ? [len] : len < 65536 ? [126, len >> 8, len & 0xff] : [127, ...(() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()];
  const head = [(fin ? 0x80 : 0) | (rsv << 4) | opcode, lengthBytes[0] | (mask ? 0x80 : 0), ...lengthBytes.slice(1)];
  if (!mask) return Buffer.concat([Buffer.from(head), body]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(body.map((byte, i) => byte ^ key[i % 4]));
  return Buffer.concat([Buffer.from(head), key, masked]);
};

const closeFrame = (code, reason = '', options = {}) => {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return frame(0x8, body, options);
};

/** Incrementally parse server→client frames (always unmasked). */
class FrameReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
  }
  drain() {
    while (this.buffer.length >= 2) {
      const fin = Boolean(this.buffer[0] & 0x80);
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + len) return;
      const masked = Boolean(this.buffer[1] & 0x80);
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      const parsed = { fin, opcode, payload: Buffer.from(payload), masked };
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed); else this.frames.push(parsed);
    }
  }
  next(timeoutMs = 2000) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
      this.waiters.push((parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

const parseClose = (payload) => payload.length ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() } : { code: 1005, reason: '' };

/** Raw TCP handshake; resolves with the parsed status line/headers and the socket. */
const rawHandshake = (port, { method = 'GET', headers = {}, key = crypto.randomBytes(16).toString('base64'), version = '13', extraBody = Buffer.alloc(0) } = {}) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    const lines = [
      `${method} / HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: ${version}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ];
    socket.write(Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n'), extraBody]));
  });
  onCleanup(() => socket.destroy());
  // Captured up front: the peer may finish before a test gets around to awaiting it.
  const ended = new Promise((resolve) => socket.once('end', resolve));
  const closed = new Promise((resolve) => socket.once('close', resolve));
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    socket.off('data', onData);
    const [statusLine, ...headerLines] = buffer.subarray(0, end).toString().split('\r\n');
    const responseHeaders = Object.fromEntries(headerLines.map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()];
    }));
    const reader = new FrameReader(socket);
    const rest = buffer.subarray(end + 4);
    if (rest.length) { reader.buffer = Buffer.from(rest); reader.drain(); }
    resolve({ socket, status: Number(statusLine.split(' ')[1]), headers: responseHeaders, key, reader, ended, closed });
  };
  socket.on('data', onData);
  socket.once('error', reject);
});

/** Server with a connection recorder; resolves the next admitted connection. */
const serverWithRecorder = async (options = {}) => {
  const started = await listen(options);
  const connections = [];
  started.server.on('connection', (connection, req) => {
    const record = { connection, req, messages: [], closes: [], errors: [], pings: [], pongs: [] };
    connection.on('message', (data, isBinary) => record.messages.push({ data, isBinary }));
    connection.on('close', (code, reason) => record.closes.push({ code, reason }));
    connection.on('error', (err) => record.errors.push(err));
    connection.on('ping', (data) => record.pings.push(data));
    connection.on('pong', (data) => record.pongs.push(data));
    connections.push(record);
  });
  return { ...started, connections };
};

const until = async (predicate, label = 'condition', timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
};

describe('ws-server opening handshake', () => {
  it('accepts a valid upgrade with the RFC 6455 accept key and negotiates no extension', async () => {
    const { port, connections } = await serverWithRecorder();
    const { status, headers, key } = await rawHandshake(port, { headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' } });
    assert.equal(status, 101);
    assert.equal(headers.upgrade, 'websocket');
    assert.equal(headers.connection.toLowerCase(), 'upgrade');
    assert.equal(headers['sec-websocket-accept'], acceptFor(key));
    assert.equal(headers['sec-websocket-extensions'], undefined, 'no extension may be negotiated');
    await until(() => connections.length === 1, 'connection event');
    assert.equal(connections[0].connection.readyState, OPEN);
    assert.equal(connections[0].req.headers['sec-websocket-key'], key);
  });

  it('refuses a non-GET method, a missing key, a wrong version and a plain HTTP request', async () => {
    const { port, connections } = await serverWithRecorder();
    assert.equal((await rawHandshake(port, { method: 'POST' })).status, 405);
    assert.equal((await rawHandshake(port, { key: '' })).status, 400);
    const wrongVersion = await rawHandshake(port, { version: '8' });
    assert.equal(wrongVersion.status, 426);
    assert.equal(wrongVersion.headers['sec-websocket-version'], '13');
    const plain = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(plain, 426);
    await sleep(20);
    assert.equal(connections.length, 0);
  });

  it('rejects with 401 when verifyClient refuses (an Origin header) and never emits connection', async () => {
    const { port, connections } = await serverWithRecorder({
      verifyClient: (req) => !Object.prototype.hasOwnProperty.call(req.headers, 'origin'),
    });
    for (const origin of ['https://untrusted.example', 'null', '']) {
      const { status, closed } = await rawHandshake(port, { headers: { Origin: origin } });
      assert.equal(status, 401, `Origin ${JSON.stringify(origin)} must be refused`);
      await closed;
    }
    const admitted = await rawHandshake(port);
    assert.equal(admitted.status, 101);
    await until(() => connections.length === 1, 'process client admitted');
  });
});

describe('ws-server data frames', () => {
  for (const [label, size] of [['7-bit', 125], ['16-bit minimum', 126], ['16-bit maximum', 65535], ['64-bit minimum', 65536], ['64-bit', 200000]]) {
    it(`delivers a masked ${label} text frame of ${size} bytes verbatim`, async () => {
      const { port, connections } = await serverWithRecorder();
      const { socket } = await rawHandshake(port);
      const text = crypto.randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
      socket.write(frame(0x1, text));
      await until(() => connections[0]?.messages.length === 1, `${label} message`);
      assert.deepEqual(connections[0].messages[0], { data: text, isBinary: false });
    });
  }

  it('delivers a frame that arrived in the same packet as the handshake, a binary frame as a Buffer, and frames split across packets', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket } = await rawHandshake(port, { extraBody: frame(0x1, 'early') });
    await until(() => connections[0]?.messages.length === 1, 'early message');
    assert.equal(connections[0].messages[0].data, 'early');

    const binary = frame(0x2, Buffer.from([0, 1, 2, 255]));
    socket.write(binary.subarray(0, 3));
    await sleep(10);
    socket.write(binary.subarray(3));
    await until(() => connections[0].messages.length === 2, 'binary message');
    assert.equal(connections[0].messages[1].isBinary, true);
    assert.deepEqual([...connections[0].messages[1].data], [0, 1, 2, 255]);

    const first = frame(0x1, 'a'.repeat(300));
    const second = frame(0x1, 'b');
    socket.write(Buffer.concat([first, second.subarray(0, 1)]));
    await sleep(10);
    socket.write(second.subarray(1));
    await until(() => connections[0].messages.length === 4, 'coalesced messages');
    assert.equal(connections[0].messages[2].data, 'a'.repeat(300));
    assert.equal(connections[0].messages[3].data, 'b');
  });

  it('reassembles a fragmented text message and answers a ping interleaved between fragments', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket, reader } = await rawHandshake(port);
    socket.write(frame(0x1, 'hel', { fin: false }));
    socket.write(frame(0x0, 'lo ', { fin: false }));
    socket.write(frame(0x9, 'keepalive'));
    socket.write(frame(0x0, 'world'));
    const pong = await reader.next();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString(), 'keepalive');
    await until(() => connections[0]?.messages.length === 1, 'fragmented message');
    assert.deepEqual(connections[0].messages[0], { data: 'hello world', isBinary: false });
    assert.deepEqual(connections[0].pings.map(String), ['keepalive']);
  });

  it('echoes ping payloads as pongs and surfaces unsolicited pongs without replying', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket, reader } = await rawHandshake(port);
    socket.write(frame(0xa, 'unsolicited'));
    socket.write(frame(0x9, ''));
    const pong = await reader.next();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.length, 0);
    assert.deepEqual(connections[0].pongs.map(String), ['unsolicited']);
    assert.equal(reader.frames.length, 0, 'a pong must not be answered');
  });
});

describe('ws-server protocol errors', () => {
  const cases = [
    ['an unmasked client frame', frame(0x1, 'plain', { mask: false }), 1002],
    ['a reserved bit', frame(0x1, 'rsv', { rsv: 4 }), 1002],
    ['an unknown opcode', frame(0x3, 'x'), 1002],
    ['a fragmented control frame', frame(0x9, 'x', { fin: false }), 1002],
    ['a control frame over 125 bytes', frame(0x9, 'p'.repeat(126)), 1002],
    ['a continuation with no message in progress', frame(0x0, 'orphan'), 1002],
    ['a new data frame while a message is fragmented', Buffer.concat([frame(0x1, 'a', { fin: false }), frame(0x1, 'b')]), 1002],
    ['a one-byte close payload', frame(0x8, Buffer.from([3])), 1002],
    ['a reserved close code', closeFrame(1005), 1002],
    ['invalid UTF-8 in a text frame', frame(0x1, Buffer.from([0xc3, 0x28])), 1007],
    ['invalid UTF-8 in a close reason', frame(0x8, Buffer.from([0x03, 0xe8, 0xff])), 1007],
    ['a payload above maxPayload', frame(0x2, Buffer.alloc(2049)), 1009],
    ['a fragmented message above maxPayload', Buffer.concat([frame(0x2, Buffer.alloc(1500), { fin: false }), frame(0x0, Buffer.alloc(1500))]), 1009],
  ];
  for (const [label, bytes, code] of cases) {
    it(`closes with ${code} on ${label}`, async () => {
      const { port, connections } = await serverWithRecorder({ maxPayload: 2048 });
      const { socket, reader, closed } = await rawHandshake(port);
      socket.write(bytes);
      const close = await reader.next();
      assert.equal(close.opcode, 0x8);
      assert.equal(parseClose(close.payload).code, code);
      await until(() => connections[0]?.closes.length === 1, 'server close event');
      assert.equal(connections[0].closes[0].code, code);
      assert.equal(connections[0].errors.length, 1, 'a protocol error is reported once');
      assert.equal(connections[0].connection.readyState, CLOSED);
      await closed;
    });
  }
});

describe('ws-server close handshake', () => {
  it('echoes a client-initiated close and reports the client code and reason', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket, reader, ended } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    socket.write(closeFrame(1001, 'going away'));
    const echo = await reader.next();
    assert.equal(echo.opcode, 0x8);
    assert.deepEqual(parseClose(echo.payload), { code: 1001, reason: 'going away' });
    await ended;
    await until(() => connections[0].closes.length === 1, 'close event');
    assert.deepEqual(connections[0].closes, [{ code: 1001, reason: 'going away' }]);
    assert.equal(connections[0].connection.readyState, CLOSED);
  });

  it('reports 1005 for an empty client close payload', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket, reader } = await rawHandshake(port);
    socket.write(frame(0x8, ''));
    const echo = await reader.next();
    assert.equal(echo.payload.length, 0);
    await until(() => connections[0]?.closes.length === 1, 'close event');
    assert.deepEqual(connections[0].closes, [{ code: 1005, reason: '' }]);
  });

  it('completes a server-initiated close once the client echoes, and rejects sends meanwhile', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket, reader, closed } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    const { connection } = connections[0];
    connection.close(4000, 'engine stopping');
    assert.equal(connection.readyState, CLOSING);
    const sendError = await new Promise((resolve) => connection.send('late', resolve));
    assert.match(String(sendError?.message), /not open/);
    const close = await reader.next();
    assert.deepEqual(parseClose(close.payload), { code: 4000, reason: 'engine stopping' });
    socket.write(closeFrame(4000, 'engine stopping'));
    await until(() => connections[0].closes.length === 1, 'close event');
    assert.deepEqual(connections[0].closes, [{ code: 4000, reason: 'engine stopping' }]);
    await closed;
  });

  it('destroys the socket with 1006 when the client never answers a server close', async () => {
    const { port, connections } = await serverWithRecorder({ closeTimeout: 50 });
    const { reader, closed } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    connections[0].connection.close();
    assert.equal(parseClose((await reader.next()).payload).code, 1000);
    await until(() => connections[0].closes.length === 1, 'timed-out close', 1000);
    assert.deepEqual(connections[0].closes, [{ code: 1006, reason: '' }]);
    await closed;
  });

  it('terminate() drops the connection without a close frame and reports 1006', async () => {
    const { port, connections } = await serverWithRecorder();
    const { reader, closed } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    connections[0].connection.terminate();
    await closed;
    assert.equal(reader.frames.length, 0, 'no close frame is sent on terminate');
    await until(() => connections[0].closes.length === 1, 'close event');
    assert.deepEqual(connections[0].closes, [{ code: 1006, reason: '' }]);
    connections[0].connection.terminate();
    connections[0].connection.close();
    assert.equal(connections[0].closes.length, 1, 'close is emitted exactly once');
  });
});

describe('ws-server sending and backpressure', () => {
  it('frames text and binary sends with the right length encodings and confirms each write', async () => {
    const { port, connections } = await serverWithRecorder();
    const { reader } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    const { connection } = connections[0];
    const sizes = [0, 125, 126, 65535, 65536];
    for (const size of sizes) {
      const payload = 'x'.repeat(size);
      const err = await new Promise((resolve) => connection.send(payload, resolve));
      assert.equal(err, undefined);
      const received = await reader.next();
      assert.equal(received.fin, true);
      assert.equal(received.opcode, 0x1);
      assert.equal(received.payload.length, size);
      assert.equal(received.masked, false, 'server frames are never masked');
    }
    connection.send(Buffer.from([7, 8, 9]));
    const binary = await reader.next();
    assert.equal(binary.opcode, 0x2);
    assert.deepEqual([...binary.payload], [7, 8, 9]);
  });

  it('keeps every frame intact under backpressure and settles all send callbacks once the peer drains', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket, reader } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    const { connection } = connections[0];
    socket.pause();
    const count = 64;
    const chunk = crypto.randomBytes(128 * 1024).toString('base64');
    const settled = [];
    const callbacks = Array.from({ length: count }, (_, i) => new Promise((resolve) => connection.send(`${i}:${chunk}`, (err) => { settled.push(i); resolve(err); })));
    await sleep(50);
    assert.ok(connection.bufferedAmount > 0, 'unsent bytes are reported while the peer is paused');
    assert.ok(settled.length < count, 'callbacks wait for the kernel to accept the bytes');
    socket.resume();
    const errors = await Promise.all(callbacks);
    assert.deepEqual(errors.filter(Boolean), []);
    for (let i = 0; i < count; i++) {
      const received = await reader.next(5000);
      assert.equal(received.payload.toString(), `${i}:${chunk}`);
    }
    await until(() => connection.bufferedAmount === 0, 'drained');
  });

  it('settles pending send callbacks once on socket error and ignores late write completions', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    const { connection } = connections[0];
    socket.pause();
    const calls = Array(64).fill(0);
    const pending = calls.map((_, i) => new Promise((resolve) => connection.send('z'.repeat(256 * 1024), (err) => { calls[i]++; resolve(err); })));
    assert.ok(connection.bufferedAmount > 0);
    connection._socket.emit('error', new Error('synthetic transport failure'));
    const results = await Promise.all(pending);
    assert.ok(results.some((err) => err?.message === 'synthetic transport failure'));
    connection.terminate();
    await until(() => connection.readyState === CLOSED, 'socket close after error');
    assert.deepEqual(calls, Array(64).fill(1));
  });

  it('fails pending send callbacks when the connection is terminated before flushing', async () => {
    const { port, connections } = await serverWithRecorder();
    const { socket } = await rawHandshake(port);
    await until(() => connections.length === 1, 'connection');
    const { connection } = connections[0];
    socket.pause();
    const calls = Array(64).fill(0);
    const pending = calls.map((_, i) => new Promise((resolve) => connection.send('y'.repeat(256 * 1024), (err) => { calls[i]++; resolve(err); })));
    await sleep(20);
    connection.terminate();
    const results = await Promise.all(pending);
    assert.ok(results.some(Boolean), 'at least one unflushed send reports an error');
    await until(() => connection.readyState === CLOSED, 'socket close after terminate');
    await sleep(10);
    assert.deepEqual(calls, Array(64).fill(1), 'termination and late socket callbacks settle each send once');
    assert.equal(await new Promise((resolve) => connection.send('after', resolve)) instanceof Error, true);
  });
});

describe('ws-server lifecycle', () => {
  it('tracks clients, stops accepting on close() and emits close once existing connections are gone', async () => {
    const started = await listen();
    const { server, port } = started;
    const a = await rawHandshake(port);
    const b = await rawHandshake(port);
    await until(() => server.clients.size === 2, 'two clients');
    const closed = once(server, 'close');
    let callbackRan = false;
    server.close(() => { callbackRan = true; });
    await assert.rejects(new Promise((resolve, reject) => {
      const probe = net.connect(port, '127.0.0.1', () => { probe.destroy(); resolve(undefined); });
      probe.once('error', reject);
    }), /ECONNREFUSED/);
    await sleep(20);
    assert.equal(callbackRan, false, 'open connections keep the server alive');
    for (const connection of server.clients) connection.close();
    a.socket.write(closeFrame(1000));
    b.socket.write(closeFrame(1000));
    await closed;
    assert.equal(callbackRan, true);
    assert.equal(server.clients.size, 0);
  });

  it('reports a bind failure through the error event', async () => {
    const occupant = net.createServer();
    await new Promise((resolve) => occupant.listen(0, '127.0.0.1', () => resolve(undefined)));
    onCleanup(() => new Promise((resolve) => occupant.close(() => resolve(undefined))));
    const { port } = /** @type {import('node:net').AddressInfo} */ (occupant.address());
    const server = new WebSocketServer({ port, host: '127.0.0.1' });
    const [err] = await once(server, 'error');
    assert.equal(err.code, 'EADDRINUSE');
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it('interoperates with Node\'s global WebSocket client end to end', async () => {
    const { url, connections } = await serverWithRecorder();
    const client = new WebSocket(url);
    onCleanup(() => client.close());
    const received = [];
    client.addEventListener('message', (event) => received.push(event.data));
    await new Promise((resolve, reject) => { client.addEventListener('open', resolve, { once: true }); client.addEventListener('error', reject, { once: true }); });
    await until(() => connections.length === 1, 'connection');
    const { connection } = connections[0];
    const large = 'z'.repeat(70000);
    client.send('hello');
    client.send(large);
    await until(() => connections[0].messages.length === 2, 'client frames');
    assert.deepEqual(connections[0].messages.map((m) => m.data.length), [5, 70000]);
    connection.send('back');
    connection.send(large);
    await until(() => received.length === 2, 'server frames');
    assert.deepEqual(received, ['back', large]);
    const clientClosed = new Promise((resolve) => client.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }), { once: true }));
    connection.close(4001, 'shutting down');
    assert.deepEqual(await clientClosed, { code: 4001, reason: 'shutting down' });
    await until(() => connections[0].closes.length === 1, 'server close');
    // undici echoes the status code but omits the reason; only the code is contractual.
    assert.equal(connections[0].closes[0].code, 4001);
  });
});
