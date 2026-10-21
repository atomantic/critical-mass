// @ts-check
/**
 * IPC Server
 *
 * WebSocket server that runs inside each engine process.
 * - Receives requests from the gateway and dispatches to registered handlers
 * - Broadcasts events back to the gateway (for realtime bus forwarding)
 */

const { WebSocketServer, OPEN } = require('./ws-server');
const { MSG_TYPE, createMessage, serialize, deserialize } = require('./ipc-protocol');
const { createContextLogger } = require('../logger');
const { trackPendingWrite } = require('../pending-writes');
const { setEngineMaintenance, refuseDuringMaintenance } = require('../engine-maintenance');

/**
 * Context logger for the engine-side IPC server. `peer` is the engine process
 * the socket belongs to; `channel` rides along per call where the message
 * names one (JSON.stringify drops undefined keys).
 * @param {string} name - Engine process name owning this server
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const ipcServerLogger = (name) => createContextLogger({ module: 'ipc-server', peer: name });

// Events broadcast with `hold` while no gateway is connected (an engine boot
// that beats the gateway's reconnect backoff, a gateway restart) are kept for
// the next subscribing gateway instead of being dropped. Bounded: the oldest
// go first so a long gateway outage cannot grow engine memory.
const MAX_HELD_EVENTS = 200;

/**
 * Create an IPC server for an engine process
 * @param {number} port - Port to listen on (localhost only)
 * @param {string} name - Human-readable name for logs (e.g. 'coinbase-engine')
 * @returns {Object}
 */
const createIPCServer = (port, name) => {
  const logger = ipcServerLogger(name);
  /** @type {WebSocketServer | null} */
  let wss = null;
  /** @type {Promise<void> | null} */
  let startPromise = null;
  /** @type {((error: Error) => void) | null} */
  let rejectStart = null;
  let initializing = false;
  let shuttingDown = false;
  /** @type {Set<import('./ws-server').WebSocketConnection>} */
  const clients = new Set();
  /** @type {Set<Promise<void>>} Outbound frames awaiting their send callback. */
  const pendingBroadcasts = new Set();
  /** @type {Map<string, (payload: any, exchange: string|null, pair: string|null) => Promise<any>>} */
  const requestHandlers = new Map();
  /** @type {Set<(remaining: number) => void>} Observers of a gateway socket closing. */
  const disconnectListeners = new Set();
  /** @type {string[]} Serialized held event frames, oldest first. */
  let heldFrames = [];
  let droppedHeldFrames = 0;

  // Built-in, registered for every engine: the gateway opens a maintenance
  // window here before a backup restore so this process stops mutating the
  // files being replaced (issue #429). Registering it centrally keeps the three
  // engine entry points identical and impossible to forget.
  requestHandlers.set('engine:maintenance', async (payload) => {
    const ack = setEngineMaintenance(payload);
    logger.info(
      ack.maintenance
        ? `ℹ️ 🔗 [${name}] Maintenance window OPEN (${ack.maintenance.reason}), mutating requests blocked until ${new Date(ack.maintenance.expiresAt).toISOString()}`
        : `ℹ️ 🔗 [${name}] Maintenance window closed, mutating requests accepted again`,
      { channel: 'engine:maintenance', active: Boolean(ack.maintenance), kind: ack.maintenance?.kind, reason: ack.maintenance?.reason },
    );
    return ack;
  });

  const start = () => {
    if (startPromise) return startPromise;
    let server;
    try {
      server = new WebSocketServer({
        port,
        host: '127.0.0.1',
        // Process IPC only: browsers always supply Origin, including opaque
        // ('null') origins. Check presence so an empty header is rejected too.
        verifyClient: (req) => !shuttingDown && !Object.prototype.hasOwnProperty.call(req.headers, 'origin'),
      });
    } catch (err) {
      return Promise.reject(err);
    }
    wss = server;
    startPromise = new Promise((resolve, reject) => {
      const onListening = () => {
        rejectStart = null;
        logger.info(`ℹ️ 🔗 [${name}] IPC server listening on 127.0.0.1:${port}`, { event: 'listening', port });
        resolve();
      };
      rejectStart = (err) => {
        server.removeListener('listening', onListening);
        rejectStart = null;
        startPromise = null;
        wss = null;
        for (const client of clients) client.terminate();
        clients.clear();
        server.close(() => {});
        reject(err);
      };
      server.once('listening', onListening);
    });

    server.on('connection', (ws) => {
      clients.add(ws);
      logger.info(`ℹ️ 🔗 [${name}] IPC client connected (${clients.size} total)`, {
        event: 'connection',
        clients: clients.size,
        port,
      });

      ws.on('message', (data) => {
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
        handleIncoming(ws, msg).catch((err) => {
          logger.error(`❌ 🔗 [${name}] IPC message handler error: ${String(err)}`, {
            event: 'message',
            channel: msg?.channel,
            error: String(err),
          });
        });
      });

      ws.on('close', () => {
        clients.delete(ws);
        logger.info(`ℹ️ 🔗 [${name}] IPC client disconnected (${clients.size} remaining)`, {
          event: 'close',
          clients: clients.size,
        });
        for (const listener of disconnectListeners) {
          try {
            listener(clients.size);
          } catch (err) {
            logger.error(`❌ 🔗 [${name}] IPC disconnect listener failed: ${err.message}`, { event: 'close', error: err.message });
          }
        }
      });

      ws.on('error', (err) => {
        logger.error(`❌ 🔗 [${name}] IPC client error: ${err.message}`, {
          event: 'client-error',
          error: err.message,
        });
      });
    });

    server.on('error', (err) => {
      logger.error(`❌ 🔗 [${name}] IPC server error: ${err.message}`, {
        event: 'server-error',
        port,
        error: err.message,
      });
      if (wss === server && rejectStart) rejectStart(err);
    });

    server.once('close', () => {
      if (wss === server && rejectStart) rejectStart(new Error('IPC server closed before listening'));
    });

    return startPromise;
  };

  /**
   * Handle an incoming message from the gateway
   * @param {import('./ws-server').WebSocketConnection} ws
   * @param {Object} msg
   */
  const handleIncoming = async (ws, msg) => {
    if (msg.type === MSG_TYPE.PING) {
      ws.send(serialize(createMessage(MSG_TYPE.PONG, 'ping', null)));
      return;
    }

    // Admitted while initializing: startup alerts are what the hold is for.
    if (msg.type === MSG_TYPE.SUBSCRIBE) {
      replayHeldFrames(ws);
      return;
    }

    // Even reads may lazily load a ledger. Admit only liveness probes until
    // restore recovery and migration have completed. Automatic fund starts
    // run after the gate opens, under the start supervisor (issue #1554).
    if (initializing && (msg.type === MSG_TYPE.REQUEST || msg.type === MSG_TYPE.CONFIG_UPDATE)) {
      const refusal = {
        success: false,
        code: 'engine-initializing',
        error: 'Engine is initializing; retry after startup recovery completes.',
      };
      ws.send(serialize(createMessage(MSG_TYPE.RESPONSE, msg.channel, refusal, { id: msg.id })));
      return;
    }

    if (shuttingDown) {
      if (msg.type === MSG_TYPE.REQUEST) {
        const refusal = {
          success: false,
          code: 'engine-shutting-down',
          error: 'Engine is shutting down; request rejected.',
        };
        try {
          ws.send(serialize(createMessage(MSG_TYPE.RESPONSE, msg.channel, refusal, { id: msg.id })));
        } catch { /* client disconnected */ }
      }
      return;
    }

    if (msg.type === MSG_TYPE.REQUEST) {
      const handler = requestHandlers.get(msg.channel);
      if (!handler) {
        const response = createMessage(MSG_TYPE.RESPONSE, msg.channel, null, {
          id: msg.id,
          error: `No handler for channel: ${msg.channel}`,
        });
        ws.send(serialize(response));
        return;
      }

      // A restore in flight outranks every mutating request: answering one
      // would write the exact files the gateway is replacing.
      const refusal = refuseDuringMaintenance(msg.channel);
      if (refusal) {
        logger.warn(`⚠️ 🔗 [${name}] Refused "${msg.channel}" during maintenance (${refusal.heldBy})`, {
          channel: msg.channel, exchange: msg.exchange, pair: msg.pair,
        });
        ws.send(serialize(createMessage(MSG_TYPE.RESPONSE, msg.channel, refusal, { id: msg.id })));
        return;
      }

      try {
        const run = () => handler(msg.payload, msg.exchange, msg.pair);
        const result = await (['engine:maintenance', 'engine:backup-pause', 'engine:backup-resume'].includes(msg.channel) ? run() : trackPendingWrite(`ipc:${msg.channel}`, run));
        const response = createMessage(MSG_TYPE.RESPONSE, msg.channel, result, { id: msg.id });
        ws.send(serialize(response));
      } catch (err) {
        const response = createMessage(MSG_TYPE.RESPONSE, msg.channel, null, {
          id: msg.id,
          error: err.message,
        });
        ws.send(serialize(response));
      }
      return;
    }

    if (msg.type === MSG_TYPE.CONFIG_UPDATE) {
      if (refuseDuringMaintenance('config_update')) return;
      const handler = requestHandlers.get('config_update');
      if (handler) {
        trackPendingWrite('ipc:config_update', () => handler(msg.payload, msg.exchange, msg.pair)).catch((err) => {
          logger.error(`❌ 🔗 [${name}] config_update handler error: ${err.message}`, {
            channel: 'config_update',
            exchange: msg.exchange,
            pair: msg.pair,
            error: err.message,
          });
        });
      }
    }
  };

  /**
   * Send held frames to a gateway that asked for them, in their original
   * order. A client that never subscribes (an older gateway, an offline
   * maintenance tool) leaves them held.
   * @param {import('./ws-server').WebSocketConnection} ws
   */
  const replayHeldFrames = (ws) => {
    if (ws.readyState !== OPEN || (heldFrames.length === 0 && droppedHeldFrames === 0)) return;
    const frames = heldFrames;
    const dropped = droppedHeldFrames;
    heldFrames = [];
    droppedHeldFrames = 0;
    for (const data of frames) sendFrame(ws, data, 'replay');
    const log = dropped > 0 ? logger.warn : logger.info;
    log(`${dropped > 0 ? '⚠️' : 'ℹ️'} 🔗 [${name}] Delivered ${frames.length} event(s) held while no gateway was connected${dropped > 0 ? `; ${dropped} older event(s) were dropped` : ''}`, {
      event: 'replay', delivered: frames.length, dropped,
    });
  };

  /**
   * @param {import('./ws-server').WebSocketConnection} client
   * @param {string} data - Serialized frame
   * @param {string} channel - For the failure log
   */
  const sendFrame = (client, data, channel) => {
    let complete;
    const sent = new Promise((resolve) => { complete = resolve; });
    pendingBroadcasts.add(sent);
    const onSent = (err) => {
      pendingBroadcasts.delete(sent);
      complete();
      if (err) {
        logger.error(`❌ 🔗 [${name}] IPC event send failed: ${err.message}`, {
          channel, event: 'broadcast', error: err.message,
        });
      }
    };
    try {
      client.send(data, onSent);
    } catch (err) {
      onSent(err);
    }
  };

  /**
   * Broadcast an event to all connected gateway clients
   * @param {string} channel - Event channel name
   * @param {*} payload - Event data
   * @param {Object} [options] - Additional message options (room, exchange)
   * @param {boolean} [options.hold] - Keep the event for the next subscribing gateway when none is connected
   */
  const broadcast = (channel, payload, options = {}) => {
    const msg = createMessage(MSG_TYPE.EVENT, channel, payload, options);
    const data = serialize(msg);
    let delivered = false;
    for (const client of clients) {
      if (client.readyState === OPEN) {
        delivered = true;
        sendFrame(client, data, channel);
      }
    }
    if (!delivered && options.hold) {
      heldFrames.push(data);
      if (heldFrames.length > MAX_HELD_EVENTS) {
        droppedHeldFrames += heldFrames.length - MAX_HELD_EVENTS;
        heldFrames = heldFrames.slice(-MAX_HELD_EVENTS);
      }
    }
  };

  // Fatal process guards wait for queued frames to leave the engine socket.
  // The guard owns the timeout, so a wedged socket cannot prevent exit(1).
  const flush = () => Promise.all([...pendingBroadcasts]);

  /**
   * Register a handler for incoming requests on a channel.
   * Handler signature: (payload, exchange, pair) => Promise<any>
   * The pair argument is optional — handlers that don't need it can ignore it
   * (existing handlers using the legacy 2-arg form continue to work since
   * extra arguments are silently ignored).
   *
   * @param {string} channel - Request channel name
   * @param {(payload: any, exchange: string|null, pair: string|null) => Promise<any>} handler
   */
  const onRequest = (channel, handler) => {
    requestHandlers.set(channel, handler);
  };

  /**
   * Observe gateway sockets closing. The engine owns state the gateway opened
   * (a backup pause); when its only client is gone, that state has no owner.
   * @param {(remaining: number) => void} listener - Receives the connected client count
   */
  const onClientDisconnect = (listener) => {
    disconnectListeners.add(listener);
  };

  const stop = () => {
    if (rejectStart) rejectStart(new Error('IPC server stopped before listening'));
    startPromise = null;
    for (const client of clients) {
      client.close();
    }
    clients.clear();
    if (wss) {
      wss.close();
      wss = null;
    }
    logger.info(`ℹ️ 🔗 [${name}] IPC server stopped`, { event: 'stopped', port });
  };

  return {
    start,
    stop,
    broadcast,
    flush,
    onRequest,
    onClientDisconnect,
    setInitializing: (value) => { initializing = Boolean(value); },
    setShuttingDown: (value) => { shuttingDown = Boolean(value); },
    isShuttingDown: () => shuttingDown,
    getClientCount: () => clients.size,
    getHeldEventCount: () => heldFrames.length,
  };
};

module.exports = { createIPCServer, MAX_HELD_EVENTS };
