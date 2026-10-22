// @ts-check
/**
 * IPC Client
 *
 * WebSocket client that runs inside the gateway process.
 * - Connects to an engine's IPC server with auto-reconnect (exponential backoff)
 * - Sends requests and waits for correlated responses with timeout
 * - Receives events from the engine and forwards them via callback
 */

const { connectWebSocket } = require('../websocket-connection');
const { MSG_TYPE, IPC_ERROR_CODE, IPC_SECRET_HEADER, getIpcSecret, DEFAULT_TIMEOUT, createMessage, serialize, deserialize } = require('./ipc-protocol');
const { createContextLogger } = require('../logger');

/**
 * Context logger for the gateway-side IPC client. `peer` names the engine this
 * socket talks to; transport detail rides along per call.
 * @param {string} name - Engine the client is connected to
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const CALLBACK_ERROR_LOG_MS = 10_000;

/**
 * Build the Error a request rejects with, tagged with its IPC failure kind.
 * @param {string} message
 * @param {string} code - One of IPC_ERROR_CODE
 * @returns {Error & {code: string}}
 */
const ipcError = (message, code) => Object.assign(new Error(message), { code });

const ipcClientLogger = (name) => createContextLogger({ module: 'ipc-client', peer: name });

/**
 * Create an IPC client for the gateway
 * @param {string} url - WebSocket URL (e.g. 'ws://127.0.0.1:5573')
 * @param {string} name - Human-readable name for logs (e.g. 'coinbase')
 * @param {Object} [options]
 * @param {((msg: Object) => void)} [options.onEvent] - Callback for incoming events
 * @param {(() => void)} [options.onConnect] - Callback when connected
 * @param {(() => void)} [options.onDisconnect] - Callback when disconnected
 * @param {number} [options.reconnectMin] - Min reconnect delay (default: 1000ms)
 * @param {number} [options.reconnectMax] - Max reconnect delay (default: 30000ms)
 * @param {string} [options.secret] - Shared IPC secret (default: env/file via getIpcSecret)
 * @returns {Object}
 */
const createIPCClient = (url, name, options = {}) => {
  const logger = ipcClientLogger(name);
  const {
    onEvent = null,
    onConnect = null,
    onDisconnect = null,
    reconnectMin = 1000,
    reconnectMax = 30000,
    secret = null,
  } = options;

  /** @type {import('../websocket-connection').WebSocketConnection | null} */
  let ws = null;
  let connected = false;
  let shouldReconnect = true;
  let reconnectDelay = reconnectMin;
  /** @type {NodeJS.Timeout | null} */
  let reconnectTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let pingTimer = null;

  /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pendingRequests = new Map();

  /** @type {Map<string, number>} callback key -> last time a failure was logged */
  const lastCallbackErrorLog = new Map();

  /**
   * Run a consumer callback so a throw cannot escape into the socket event
   * handler (where it would surface as an uncaughtException and take the
   * gateway down). Failures are logged at most once per CALLBACK_ERROR_LOG_MS
   * per key because engine events arrive continuously.
   * @param {string} key - Event channel or lifecycle callback name
   * @param {() => void} fn
   */
  const containCallback = (key, fn) => {
    try {
      fn();
    } catch (err) {
      const now = Date.now();
      const last = lastCallbackErrorLog.get(key);
      if (last !== undefined && now - last < CALLBACK_ERROR_LOG_MS) return;
      lastCallbackErrorLog.set(key, now);
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`❌ 🔗 [${name}] IPC ${key} callback threw: ${message}`, {
        event: 'callback-error',
        channel: key,
        error: message,
      });
    }
  };

  const connect = () => {
    if (ws && (ws.isOpen() || ws.isConnecting())) return;

    shouldReconnect = true;

    // Resolved per attempt so a secret file that appears late (or an
    // unreadable data dir) is retried by the normal reconnect backoff.
    let headers;
    try {
      headers = { [IPC_SECRET_HEADER]: secret ?? getIpcSecret() };
    } catch (err) {
      logger.warn(`⚠️ 🔗 [${name}] IPC secret unavailable, connecting without it: ${String(err)}`, { event: 'secret', error: String(err) });
    }
    const socket = connectWebSocket(url, headers ? { headers } : undefined);
    ws = socket;
    // Handlers act only while this socket is the current one: a close that
    // lands after disconnect() or a reconnect must not touch its successor.
    const isCurrent = () => ws === socket;

    socket.on('open', () => {
      if (!isCurrent()) return;
      connected = true;
      reconnectDelay = reconnectMin;
      logger.info(`ℹ️ 🔗 [${name}] IPC connected to ${url}`, { event: 'open', url });

      pingTimer = setInterval(() => {
        if (socket.isOpen()) {
          socket.send(serialize(createMessage(MSG_TYPE.PING, 'ping', null)));
        }
      }, 15_000);

      // Only an event consumer takes the engine's held events; a tool that
      // connects just to issue requests must not swallow them. Older engines
      // ignore the unknown message type.
      if (onEvent) socket.send(serialize(createMessage(MSG_TYPE.SUBSCRIBE, 'events', null)));

      if (onConnect) containCallback('onConnect', onConnect);
    });

    socket.on('message', (data) => {
      if (!isCurrent()) return;
      let msg;
      try {
        msg = deserialize(data.toString());
      } catch (err) {
        logger.error(`❌ 🔗 [${name}] IPC message deserialize error: ${String(err)}`, {
          event: 'message',
          error: String(err),
        });
        return;
      }
      handleIncoming(msg);
    });

    socket.on('close', () => {
      if (!isCurrent()) return;
      const wasConnected = connected;
      connected = false;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      // Reject all pending requests
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(ipcError(`IPC connection closed (${name})`, IPC_ERROR_CODE.TRANSPORT));
      }
      pendingRequests.clear();

      if (wasConnected && onDisconnect) containCallback('onDisconnect', onDisconnect);

      if (shouldReconnect) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, reconnectMax);
          connect();
        }, reconnectDelay);
      }
    });

    socket.on('error', (err) => {
      if (!isCurrent()) return;
      // A failed handshake is expected while the engine is still starting
      // (the refused-connection case); the close path schedules the retry.
      if (!connected) return;
      logger.error(`❌ 🔗 [${name}] IPC error: ${err.message}`, {
        event: 'socket-error',
        url,
        error: err.message,
      });
    });
  };

  /**
   * Handle incoming message from the engine
   * @param {Object} msg
   */
  const handleIncoming = (msg) => {
    // A well-formed JSON frame can still be a non-object (e.g. the literal
    // `null`); guard before dereferencing so it can't throw out of the handler.
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === MSG_TYPE.PONG) return;

    if (msg.type === MSG_TYPE.RESPONSE) {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(ipcError(msg.error, IPC_ERROR_CODE.HANDLER));
        } else {
          pending.resolve(msg.payload);
        }
      }
      return;
    }

    if (msg.type === MSG_TYPE.EVENT && onEvent) {
      containCallback(`event:${msg.channel}`, () => onEvent(msg));
    }
  };

  /**
   * Send a request to the engine and wait for a response.
   *
   * Two signatures (string-typed 4th arg disambiguates):
   *   request(channel, payload, exchange, timeout)
   *   request(channel, payload, exchange, pair, timeout)
   *
   * @param {string} channel
   * @param {*} payload
   * @param {string} [exchange]
   * @param {string|number} [pairOrTimeout]
   * @param {number} [maybeTimeout]
   * @returns {Promise<*>}
   */
  const request = (channel, payload, exchange, pairOrTimeout, maybeTimeout) => {
    let pair;
    let timeout;
    if (typeof pairOrTimeout === 'string') {
      pair = pairOrTimeout;
      timeout = typeof maybeTimeout === 'number' ? maybeTimeout : DEFAULT_TIMEOUT;
    } else {
      pair = undefined;
      timeout = typeof pairOrTimeout === 'number' ? pairOrTimeout : DEFAULT_TIMEOUT;
    }

    return new Promise((resolve, reject) => {
      if (!connected) {
        return reject(ipcError(`IPC not connected (${name})`, IPC_ERROR_CODE.TRANSPORT));
      }

      const msg = createMessage(MSG_TYPE.REQUEST, channel, payload, { exchange, pair });
      const timer = setTimeout(() => {
        pendingRequests.delete(msg.id);
        reject(ipcError(`IPC request timeout: ${channel} (${name})`, IPC_ERROR_CODE.TIMEOUT));
      }, timeout);

      pendingRequests.set(msg.id, { resolve, reject, timer });
      if (!ws || !ws.isOpen()) {
        clearTimeout(timer);
        pendingRequests.delete(msg.id);
        return reject(ipcError(`IPC WebSocket not open (${name})`, IPC_ERROR_CODE.TRANSPORT));
      }
      ws.send(serialize(msg));
    });
  };

  /**
   * Send a one-way config update to the engine
   * @param {*} payload - Updated config values
   * @param {string} [exchange] - Exchange name
   * @param {string} [pair] - Pair name
   */
  const sendConfigUpdate = (payload, exchange, pair) => {
    if (!connected || !ws || !ws.isOpen()) return;
    const msg = createMessage(MSG_TYPE.CONFIG_UPDATE, 'config_update', payload, { exchange, pair });
    ws.send(serialize(msg));
  };

  /**
   * Disconnect from the engine (no auto-reconnect)
   */
  const disconnect = () => {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(ipcError(`IPC client disconnected (${name})`, IPC_ERROR_CODE.TRANSPORT));
    }
    pendingRequests.clear();

    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
  };

  return {
    connect,
    disconnect,
    request,
    sendConfigUpdate,
    isConnected: () => connected,
  };
};

module.exports = { createIPCClient };
