// @ts-check
/**
 * Controllable stand-in for Node's global `WebSocket` (the EventTarget client
 * src/websocket-connection.js wraps). Suites install it with
 * `installFakeWebSocket()` and drive each instance by hand: `open()`,
 * `receive()`, `peerClose()`, `fail()`. Mirrors the real client's observable
 * contract — `close()` only moves to CLOSING (a real socket waits for the peer),
 * `send()` throws unless OPEN, and `fail()` reproduces the Node 22 shape by
 * default (an `error` with no `close`).
 */

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static instances = [];

  static reset() { FakeWebSocket.instances = []; }

  /** @param {string | URL} url */
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = 'blob';
    /** @type {Array<string | ArrayBuffer | ArrayBufferView>} */
    this.sent = [];
    /** @type {Array<{ code?: number, reason?: string }>} */
    this.closeCalls = [];
    FakeWebSocket.instances.push(this);
  }

  /** JSON-parsed frames the code under test sent. */
  get frames() { return this.sent.map((raw) => JSON.parse(String(raw))); }

  /** @param {string | ArrayBuffer | ArrayBufferView} data */
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('InvalidStateError: WebSocket is not open');
    this.sent.push(data);
  }

  /**
   * Local close: a real client moves to CLOSING and waits for the peer's echo.
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code, reason) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
  }

  // --- drivers: what the network / peer does ---

  /** Complete the handshake. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /**
   * Deliver a frame. Strings arrive as text; binary arrives as an ArrayBuffer.
   * @param {string | ArrayBuffer} data
   */
  receive(data) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /**
   * The connection ends (peer close handshake completed, or TCP dropped).
   * @param {number} [code]
   * @param {string} [reason]
   */
  peerClose(code = 1006, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }));
  }

  /**
   * A transport error. Node 22 reports a failed handshake as `error` alone
   * (readyState stays CONNECTING); later runtimes add `close` — pass
   * `{ close: true }` to reproduce that shape.
   * @param {string} [message]
   * @param {{ close?: boolean }} [options]
   */
  fail(message = 'Received network error or non-101 status code.', { close = false } = {}) {
    this.dispatchEvent(Object.assign(new Event('error'), { message, error: new Error(message) }));
    if (close) this.peerClose(1006, '');
  }
}

/**
 * Swap the global WebSocket for the fake; returns the restore function.
 * @returns {() => void}
 */
const installFakeWebSocket = () => {
  const original = globalThis.WebSocket;
  FakeWebSocket.reset();
  // @ts-ignore the fake is intentionally not a full DOM WebSocket
  globalThis.WebSocket = FakeWebSocket;
  return () => { globalThis.WebSocket = original; };
};

module.exports = { FakeWebSocket, installFakeWebSocket };
