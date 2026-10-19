// @ts-check
/**
 * Loopback WebSocket server (RFC 6455) for the engine IPC channel.
 *
 * Owned replacement for the `ws` server: a plain `node:http` server performs
 * the opening handshake and hands the upgraded socket to a connection that
 * frames, unframes and closes per RFC 6455. No extension is negotiated (a
 * client's permessage-deflate offer is ignored), no subprotocol, no TLS — the
 * gateway and the engines talk over 127.0.0.1 only.
 *
 * Surface mirrors what `src/ipc/ipc-server.js` used from `ws`:
 *  - `new WebSocketServer({ port, host, verifyClient })` starts listening and
 *    emits `listening`, `connection` (connection, request), `error`, `close`;
 *    `close(callback)` stops accepting and emits `close` once every connection
 *    is gone; `clients` is the live connection set.
 *  - a connection emits `message` (string for text, Buffer for binary, plus an
 *    `isBinary` flag), `ping`, `pong`, `error` and exactly one `close`
 *    (code, reason); it offers `send(data, callback)`, `close(code, reason)`,
 *    `terminate()`, `readyState` and `bufferedAmount`.
 *
 * `handshakeRefusal`, `refuseUpgrade` and `acceptUpgrade` are exported for the
 * gateway's realtime bus (src/realtime-bus.js), which upgrades on the
 * gateway's own HTTP listeners instead of a dedicated server.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT = 5000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** RFC 6455 §7.4 — codes a peer may send on the wire. */
const isValidCloseCode = (code) =>
  (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
  || (code >= 3000 && code <= 4999);

/**
 * Build one server→client frame. Servers never mask.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} [fin]
 */
const encodeFrame = (opcode, payload, fin = true) => {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
};

/**
 * @param {number} code
 * @param {string} reason
 */
const encodeClosePayload = (code, reason) => {
  if (code === 1005) return Buffer.alloc(0);
  // A control frame carries at most 125 bytes; trim whole characters so the
  // reason stays valid UTF-8 for the peer.
  let text = reason;
  while (Buffer.byteLength(text) > 123) text = text.slice(0, -1);
  const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(text));
  payload.writeUInt16BE(code, 0);
  payload.write(text, 2);
  return payload;
};

class ProtocolError extends RangeError {
  /**
   * @param {number} code - close code to send
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WebSocketProtocolError';
    this.closeCode = code;
  }
}

class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket - the upgraded TCP socket
   * @param {{ maxPayload: number, closeTimeout: number }} options
   */
  constructor(socket, options) {
    super();
    this.readyState = OPEN;
    this._socket = socket;
    this._maxPayload = options.maxPayload;
    this._closeTimeout = options.closeTimeout;
    /** @type {Buffer[]} */
    this._chunks = [];
    this._buffered = 0;
    /** @type {{ opcode: number, parts: Buffer[], length: number } | null} */
    this._fragment = null;
    /** @type {{ code: number, reason: string } | null} */
    this._peerClose = null;
    /** @type {number | null} */
    this._failCode = null;
    /** @type {NodeJS.Timeout | null} */
    this._closeTimer = null;
    this._closeEmitted = false;

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._emitError(err));
    socket.on('end', () => {
      // Peer finished without (or after) the close handshake: finish our side.
      if (this.readyState !== CLOSED) socket.end();
    });
    socket.on('close', () => this._onSocketClose());
  }

  get bufferedAmount() {
    return this._socket.writableLength;
  }

  /**
   * Queue one frame. `callback(err)` runs once the kernel accepted the bytes,
   * or with an error when the connection is not open or dies first.
   * @param {string | Buffer | Uint8Array} data
   * @param {(err?: Error) => void} [callback]
   */
  send(data, callback) {
    if (this.readyState !== OPEN) {
      if (callback) callback(new Error(`WebSocket is not open: readyState ${this.readyState}`));
      return;
    }
    const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const opcode = typeof data === 'string' ? OPCODE.TEXT : OPCODE.BINARY;
    this._socket.write(encodeFrame(opcode, payload), callback && ((err) => callback(err || undefined)));
  }

  /**
   * Start the closing handshake. The `close` event follows once the peer
   * answers or the close timeout destroys the socket.
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this._writeClose(code, reason);
    this._armCloseTimer();
  }

  /** Drop the TCP connection immediately; reports 1006. */
  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this._socket.destroy();
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  _writeClose(code, reason) {
    this._socket.write(encodeFrame(OPCODE.CLOSE, encodeClosePayload(code, reason)));
  }

  _armCloseTimer() {
    if (this._closeTimer) return;
    this._closeTimer = setTimeout(() => this._socket.destroy(), this._closeTimeout);
    this._closeTimer.unref();
  }

  /**
   * Protocol violation: tell the peer why, finish, and stop parsing.
   * @param {ProtocolError} err
   */
  _fail(err) {
    if (this.readyState === CLOSED || this._failCode !== null) return;
    this._failCode = err.closeCode;
    this._chunks = [];
    this._buffered = 0;
    this._emitError(err);
    if (this.readyState === OPEN) {
      this.readyState = CLOSING;
      this._writeClose(err.closeCode, err.message);
    }
    this._socket.end();
    this._armCloseTimer();
  }

  /** @param {Error} err */
  _emitError(err) {
    if (this.listenerCount('error')) this.emit('error', err);
  }

  _onSocketClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.readyState = CLOSED;
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this._closeTimer = null;
    const code = this._peerClose?.code ?? this._failCode ?? 1006;
    const reason = this._peerClose?.reason ?? '';
    this.emit('close', code, reason);
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    if (this._failCode !== null || this.readyState === CLOSED) return;
    this._chunks.push(chunk);
    this._buffered += chunk.length;
    try {
      this._parse();
    } catch (err) {
      if (err instanceof ProtocolError) this._fail(err);
      else this._fail(new ProtocolError(1011, err instanceof Error ? err.message : String(err)));
    }
  }

  /** @param {number} length */
  _take(length) {
    const joined = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._buffered);
    const taken = joined.subarray(0, length);
    const rest = joined.subarray(length);
    this._chunks = rest.length ? [rest] : [];
    this._buffered = rest.length;
    return taken;
  }

  /** Decode every complete frame in the receive buffer. */
  _parse() {
    while (this._buffered >= 2) {
      const first = this._chunks[0].length >= 2 ? this._chunks[0] : Buffer.concat(this._chunks, this._buffered);
      const fin = Boolean(first[0] & 0x80);
      const rsv = first[0] & 0x70;
      const opcode = first[0] & 0x0f;
      const masked = Boolean(first[1] & 0x80);
      const short = first[1] & 0x7f;
      if (rsv) throw new ProtocolError(1002, 'RSV bits set without a negotiated extension');
      if (!masked) throw new ProtocolError(1002, 'client frame is not masked');
      const isControl = opcode >= 0x8;
      if (![OPCODE.CONTINUATION, OPCODE.TEXT, OPCODE.BINARY, OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG].includes(opcode)) {
        throw new ProtocolError(1002, `invalid opcode ${opcode}`);
      }
      if (isControl && (!fin || short > 125)) throw new ProtocolError(1002, 'control frame is fragmented or longer than 125 bytes');
      const extended = short === 126 ? 2 : short === 127 ? 8 : 0;
      const headerLength = 2 + extended + 4;
      if (this._buffered < headerLength) return;
      const header = first.length >= headerLength ? first : Buffer.concat(this._chunks, this._buffered);
      let length = short;
      if (extended === 2) length = header.readUInt16BE(2);
      else if (extended === 8) {
        const big = header.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError(1009, 'frame length exceeds the supported range');
        length = Number(big);
      }
      const pending = this._fragment ? this._fragment.length : 0;
      if (!isControl && pending + length > this._maxPayload) throw new ProtocolError(1009, 'message exceeds maxPayload');
      if (this._buffered < headerLength + length) return;
      const raw = this._take(headerLength + length);
      const mask = raw.subarray(headerLength - 4, headerLength);
      const payload = Buffer.from(raw.subarray(headerLength));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this._onFrame(fin, opcode, payload);
    }
  }

  /**
   * @param {boolean} fin
   * @param {number} opcode
   * @param {Buffer} payload
   */
  _onFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE.PING:
        this.emit('ping', payload);
        if (this.readyState === OPEN) this._socket.write(encodeFrame(OPCODE.PONG, payload));
        return;
      case OPCODE.PONG:
        this.emit('pong', payload);
        return;
      case OPCODE.CLOSE:
        this._onCloseFrame(payload);
        return;
      case OPCODE.CONTINUATION:
        if (!this._fragment) throw new ProtocolError(1002, 'continuation frame without a fragmented message');
        this._fragment.parts.push(payload);
        this._fragment.length += payload.length;
        if (!fin) return;
        this._deliver(this._fragment.opcode, Buffer.concat(this._fragment.parts, this._fragment.length));
        this._fragment = null;
        return;
      default:
        if (this._fragment) throw new ProtocolError(1002, 'new data frame while a fragmented message is in progress');
        if (!fin) {
          this._fragment = { opcode, parts: [payload], length: payload.length };
          return;
        }
        this._deliver(opcode, payload);
    }
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  _deliver(opcode, payload) {
    if (opcode === OPCODE.BINARY) {
      this.emit('message', payload, true);
      return;
    }
    let text;
    try {
      text = utf8.decode(payload);
    } catch {
      throw new ProtocolError(1007, 'text frame is not valid UTF-8');
    }
    this.emit('message', text, false);
  }

  /** @param {Buffer} payload */
  _onCloseFrame(payload) {
    let code = 1005;
    let reason = '';
    if (payload.length === 1) throw new ProtocolError(1002, 'close payload of one byte');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) throw new ProtocolError(1002, `invalid close code ${code}`);
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        throw new ProtocolError(1007, 'close reason is not valid UTF-8');
      }
    }
    this._peerClose = { code, reason };
    if (this.readyState === OPEN) {
      // Peer-initiated: echo the status and finish our half.
      this.readyState = CLOSING;
      this._writeClose(code, reason);
    }
    // Either way the handshake is complete from our side.
    this._socket.end();
    this._armCloseTimer();
  }
}

/**
 * RFC 6455 §4.2.1 opening-handshake checks.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ status: number, headers?: Record<string, string> } | null} the refusal, or null for a valid handshake
 */
const handshakeRefusal = (req) => {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET') return { status: 405 };
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket') return { status: 400 };
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return { status: 400 };
  if (req.headers['sec-websocket-version'] !== '13') return { status: 426, headers: { 'Sec-WebSocket-Version': '13' } };
  return null;
};

/**
 * Answer an upgrade request with a plain HTTP error and end the socket.
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 * @param {Record<string, string>} [headers]
 */
const refuseUpgrade = (socket, status, headers = {}) => {
  const body = http.STATUS_CODES[status] || '';
  const lines = [`HTTP/1.1 ${status} ${body}`, 'Connection: close', 'Content-Type: text/plain', `Content-Length: ${Buffer.byteLength(body)}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
};

/**
 * Complete a validated handshake. `onConnection` attaches its listeners before
 * any frame that arrived with the upgrade request is parsed.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ maxPayload?: number, closeTimeout?: number }} options
 * @param {(connection: WebSocketConnection) => void} onConnection
 * @returns {WebSocketConnection | null} null when the peer already went away
 */
const acceptUpgrade = (req, socket, head, options, onConnection) => {
  if (!socket.readable || !socket.writable) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const connection = new WebSocketConnection(socket, {
    maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    closeTimeout: options.closeTimeout ?? DEFAULT_CLOSE_TIMEOUT,
  });
  onConnection(connection);
  if (head.length) connection._onData(head);
  return connection;
};

class WebSocketServer extends EventEmitter {
  /**
   * @param {{
   *   port: number,
   *   host?: string,
   *   verifyClient?: (req: import('node:http').IncomingMessage) => boolean,
   *   maxPayload?: number,
   *   closeTimeout?: number,
   * }} options
   */
  constructor({ port, host = '127.0.0.1', verifyClient = () => true, maxPayload = DEFAULT_MAX_PAYLOAD, closeTimeout = DEFAULT_CLOSE_TIMEOUT }) {
    super();
    /** @type {Set<WebSocketConnection>} */
    this.clients = new Set();
    this._verifyClient = verifyClient;
    this._connectionOptions = { maxPayload, closeTimeout };
    this._server = http.createServer((req, res) => {
      res.writeHead(426, { Upgrade: 'websocket', Connection: 'close', 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
    });
    this._server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    this._server.on('listening', () => this.emit('listening'));
    this._server.on('error', (err) => {
      // A failed bind leaves nothing to close; a later close() resolves at once.
      if (!this._server.listening) this._httpClosed = true;
      this.emit('error', err);
      this._maybeEmitClose();
    });
    this._closing = false;
    this._httpClosed = false;
    this._closeEmitted = false;
    /** @type {Array<() => void>} */
    this._closeCallbacks = [];
    this._server.listen(port, host);
  }

  address() {
    return this._server.address();
  }

  /**
   * Stop accepting connections. Existing connections are left to finish; the
   * `close` event (and callback) fire once the listener is down and the last
   * connection is gone. Upgraded sockets are not tracked by `node:http`, so the
   * server keeps its own count. A close requested while the bind is still in
   * flight takes effect as soon as the listener is up.
   * @param {() => void} [callback]
   */
  close(callback) {
    if (callback) this._closeCallbacks.push(callback);
    if (this._closing) {
      this._maybeEmitClose();
      return;
    }
    this._closing = true;
    if (this._httpClosed) {
      this._maybeEmitClose();
      return;
    }
    const shutdown = () => this._server.close(() => {
      this._httpClosed = true;
      this._maybeEmitClose();
    });
    if (this._server.listening) shutdown();
    else this._server.once('listening', shutdown);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  _onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const refusal = handshakeRefusal(req) ?? (this._verifyClient(req) ? null : { status: 401 });
    if (refusal) return refuseUpgrade(socket, refusal.status, refusal.headers);
    acceptUpgrade(req, socket, head, this._connectionOptions, (connection) => {
      this.clients.add(connection);
      connection.once('close', () => {
        this.clients.delete(connection);
        this._maybeEmitClose();
      });
      this.emit('connection', connection, req);
    });
  }

  _maybeEmitClose() {
    if (!this._closing || !this._httpClosed || this.clients.size) return;
    const callbacks = this._closeCallbacks;
    this._closeCallbacks = [];
    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit('close');
    }
    for (const callback of callbacks) callback();
  }
}

module.exports = {
  WebSocketServer, WebSocketConnection, handshakeRefusal, refuseUpgrade, acceptUpgrade,
  CONNECTING, OPEN, CLOSING, CLOSED,
};
