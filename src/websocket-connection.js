// @ts-check
/**
 * Client-side WebSocket connection over Node's global `WebSocket` (Node 22+).
 *
 * Normalises the EventTarget API into the emitter contract the IPC client and
 * the exchange feeds rely on, and papers over two runtime behaviours that
 * differ between Node 22 and later releases:
 *  - a failed handshake (ECONNREFUSED, non-101 status, close() while still
 *    connecting) fires only `error` on Node 22 — readyState stays CONNECTING
 *    and no `close` follows; later runtimes fire both. Callers see exactly one
 *    `close` (1006) either way, so reconnect logic never stalls.
 *  - close() on a peer that never answers waits forever (no close timeout), so
 *    a dead TCP connection needs `terminate()`: detach, best-effort close, and
 *    report `close` (1006) immediately. The global client exposes no transport
 *    abort, so the runtime socket stays in CLOSING until the kernel gives up
 *    retransmitting the close frame (bounded by the TCP retransmission limit,
 *    minutes at most); it is detached, so it can never affect the session.
 *
 * Events: `open`, `message` (string for text, Buffer for binary), `error`
 * (Error), and exactly one `close` (code, reason). `error` is only emitted
 * when someone listens, so a transport error can never throw out of here.
 */
const { EventEmitter } = require('node:events');

/**
 * @typedef {EventEmitter & {
 *   url: string,
 *   state: 'connecting' | 'open' | 'closing' | 'closed',
 *   isOpen: () => boolean,
 *   isConnecting: () => boolean,
 *   send: (data: string | Buffer) => boolean,
 *   close: (code?: number, reason?: string) => void,
 *   terminate: (reason?: string) => void,
 * }} WebSocketConnection
 */

/**
 * @param {Event & { message?: string, error?: unknown }} event
 * @param {string} url
 */
const toError = (event, url) => {
  const inner = event.error;
  const message = (typeof event.message === 'string' && event.message)
    || (inner instanceof Error && inner.message)
    || `WebSocket connection to ${url} failed`;
  return inner instanceof Error && inner.message ? inner : new Error(message, inner instanceof Error ? { cause: inner } : undefined);
};

/**
 * Open a connection. The socket class is resolved at call time so a test can
 * substitute `globalThis.WebSocket`.
 * @param {string} url
 * @param {{ headers?: Record<string, string> }} [init] - handshake headers (Node's undici WebSocket)
 * @returns {WebSocketConnection}
 */
const connectWebSocket = (url, init) => {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('global WebSocket is unavailable; Node.js 22 or newer is required');
  }
  const emitter = /** @type {WebSocketConnection} */ (new EventEmitter());
  const socket = init ? new WebSocketImpl(url, init) : new WebSocketImpl(url);
  socket.binaryType = 'arraybuffer';
  const detach = new AbortController();
  const { signal } = detach;
  /** @type {'connecting' | 'open' | 'closing' | 'closed'} */
  let state = 'connecting';
  let opened = false;

  /**
   * @param {number} code
   * @param {string} reason
   */
  const finish = (code, reason) => {
    if (state === 'closed') return;
    state = 'closed';
    detach.abort();
    emitter.emit('close', code, reason);
  };

  socket.addEventListener('open', () => {
    opened = true;
    if (state === 'connecting') state = 'open';
    emitter.emit('open');
  }, { signal });

  socket.addEventListener('message', (event) => {
    const { data } = /** @type {MessageEvent} */ (event);
    emitter.emit('message', typeof data === 'string' ? data : Buffer.from(data));
  }, { signal });

  socket.addEventListener('error', (event) => {
    const error = toError(/** @type {any} */ (event), url);
    if (emitter.listenerCount('error')) emitter.emit('error', error);
    // Node 22 never follows a failed handshake with `close`; settle it here.
    if (!opened) finish(1006, error.message);
  }, { signal });

  socket.addEventListener('close', (event) => {
    const { code, reason } = /** @type {CloseEvent} */ (event);
    finish(code, reason);
  }, { signal });

  Object.defineProperty(emitter, 'state', { get: () => state, enumerable: true });
  emitter.url = url;
  emitter.isOpen = () => state === 'open';
  emitter.isConnecting = () => state === 'connecting';
  emitter.send = (data) => {
    if (state !== 'open') return false;
    socket.send(data);
    return true;
  };
  emitter.terminate = (reason = 'terminated') => {
    if (state === 'closed') return;
    // Best effort only: there is no API to abort the transport (see header).
    try { socket.close(); } catch { /* already closing, or an invalid state */ }
    finish(1006, reason);
  };
  emitter.close = (code, reason) => {
    if (state === 'closed' || state === 'closing') return;
    state = 'closing';
    try {
      if (code === undefined) socket.close();
      else socket.close(code, reason);
    } catch {
      // An invalid code or reason throws synchronously; treat it as abandoned.
      emitter.terminate('close rejected');
    }
  };
  return emitter;
};

module.exports = { connectWebSocket };
