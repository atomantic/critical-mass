// @ts-check
/**
 * IPC Client
 *
 * WebSocket client that runs inside the gateway process.
 * - Connects to an engine's IPC server with auto-reconnect (exponential backoff)
 * - Sends requests and waits for correlated responses with timeout
 * - Receives events from the engine and forwards them via callback
 */

const WebSocket = require('ws');
const { MSG_TYPE, DEFAULT_TIMEOUT, createMessage, serialize, deserialize } = require('./ipc-protocol');
const { log } = require('../logger');

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
 * @returns {Object}
 */
const createIPCClient = (url, name, options = {}) => {
  const {
    onEvent = null,
    onConnect = null,
    onDisconnect = null,
    reconnectMin = 1000,
    reconnectMax = 30000,
  } = options;

  /** @type {WebSocket | null} */
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

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    shouldReconnect = true;

    ws = new WebSocket(url);

    ws.on('open', () => {
      connected = true;
      reconnectDelay = reconnectMin;
      log('INFO', `🔗 [${name}] IPC connected to ${url}`);

      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(serialize(createMessage(MSG_TYPE.PING, 'ping', null)));
        }
      }, 15_000);

      if (onConnect) onConnect();
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = deserialize(data.toString());
      } catch (err) {
        log('ERROR', `🔗 [${name}] IPC message deserialize error: ${String(err)}`);
        return;
      }
      handleIncoming(msg);
    });

    ws.on('close', () => {
      const wasConnected = connected;
      connected = false;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      // Reject all pending requests
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`IPC connection closed (${name})`));
      }
      pendingRequests.clear();

      if (wasConnected && onDisconnect) onDisconnect();

      if (shouldReconnect) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, reconnectMax);
          connect();
        }, reconnectDelay);
      }
    });

    ws.on('error', (err) => {
      // Don't log ECONNREFUSED on every attempt — expected when engine isn't up yet
      if (err.code !== 'ECONNREFUSED') {
        log('ERROR', `🔗 [${name}] IPC error: ${err.message}`);
      }
    });
  };

  /**
   * Handle incoming message from the engine
   * @param {Object} msg
   */
  const handleIncoming = (msg) => {
    if (msg.type === MSG_TYPE.PONG) return;

    if (msg.type === MSG_TYPE.RESPONSE) {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.payload);
        }
      }
      return;
    }

    if (msg.type === MSG_TYPE.EVENT && onEvent) {
      onEvent(msg);
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
        return reject(new Error(`IPC not connected (${name})`));
      }

      const msg = createMessage(MSG_TYPE.REQUEST, channel, payload, { exchange, pair });
      const timer = setTimeout(() => {
        pendingRequests.delete(msg.id);
        reject(new Error(`IPC request timeout: ${channel} (${name})`));
      }, timeout);

      pendingRequests.set(msg.id, { resolve, reject, timer });
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        pendingRequests.delete(msg.id);
        return reject(new Error(`IPC WebSocket not open (${name})`));
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
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
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
      pending.reject(new Error(`IPC client disconnected (${name})`));
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
