// @ts-check
/**
 * IPC Server
 *
 * WebSocket server that runs inside each engine process.
 * - Receives requests from the gateway and dispatches to registered handlers
 * - Broadcasts events back to the gateway (for Socket.IO forwarding)
 */

const WebSocket = require('ws');
const { MSG_TYPE, createMessage, serialize, deserialize } = require('./ipc-protocol');
const { createContextLogger } = require('../logger');

/**
 * Context logger for the engine-side IPC server. `peer` is the engine process
 * the socket belongs to; `channel` rides along per call where the message
 * names one (JSON.stringify drops undefined keys).
 * @param {string} name - Engine process name owning this server
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const ipcServerLogger = (name) => createContextLogger({ module: 'ipc-server', peer: name });

/**
 * Create an IPC server for an engine process
 * @param {number} port - Port to listen on (localhost only)
 * @param {string} name - Human-readable name for logs (e.g. 'coinbase-engine')
 * @returns {Object}
 */
const createIPCServer = (port, name) => {
  const logger = ipcServerLogger(name);
  /** @type {import('ws').WebSocketServer | null} */
  let wss = null;
  /** @type {Set<WebSocket>} */
  const clients = new Set();
  /** @type {Map<string, (payload: any, exchange: string|null, pair: string|null) => Promise<any>>} */
  const requestHandlers = new Map();

  const start = () => {
    wss = new WebSocket.Server({ port, host: '127.0.0.1' });

    wss.on('connection', (ws) => {
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
      });

      ws.on('error', (err) => {
        logger.error(`❌ 🔗 [${name}] IPC client error: ${err.message}`, {
          event: 'client-error',
          error: err.message,
        });
      });
    });

    wss.on('error', (err) => {
      logger.error(`❌ 🔗 [${name}] IPC server error: ${err.message}`, {
        event: 'server-error',
        port,
        error: err.message,
      });
    });

    logger.info(`ℹ️ 🔗 [${name}] IPC server listening on 127.0.0.1:${port}`, { event: 'listening', port });
  };

  /**
   * Handle an incoming message from the gateway
   * @param {WebSocket} ws
   * @param {Object} msg
   */
  const handleIncoming = async (ws, msg) => {
    if (msg.type === MSG_TYPE.PING) {
      ws.send(serialize(createMessage(MSG_TYPE.PONG, 'ping', null)));
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

      try {
        const result = await handler(msg.payload, msg.exchange, msg.pair);
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
      const handler = requestHandlers.get('config_update');
      if (handler) {
        handler(msg.payload, msg.exchange, msg.pair).catch((err) => {
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
   * Broadcast an event to all connected gateway clients
   * @param {string} channel - Event channel name
   * @param {*} payload - Event data
   * @param {Object} [options] - Additional message options (room, exchange)
   */
  const broadcast = (channel, payload, options = {}) => {
    const msg = createMessage(MSG_TYPE.EVENT, channel, payload, options);
    const data = serialize(msg);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

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

  const stop = () => {
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
    onRequest,
    getClientCount: () => clients.size,
  };
};

module.exports = { createIPCServer };
