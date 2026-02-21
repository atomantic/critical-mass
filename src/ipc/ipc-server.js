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
const { log } = require('../logger');

/**
 * Create an IPC server for an engine process
 * @param {number} port - Port to listen on (localhost only)
 * @param {string} name - Human-readable name for logs (e.g. 'kalshi-engine')
 * @returns {Object}
 */
const createIPCServer = (port, name) => {
  /** @type {import('ws').WebSocketServer | null} */
  let wss = null;
  /** @type {Set<WebSocket>} */
  const clients = new Set();
  /** @type {Map<string, (payload: any, exchange: string|null) => Promise<any>>} */
  const requestHandlers = new Map();

  const start = () => {
    wss = new WebSocket.Server({ port, host: '127.0.0.1' });

    wss.on('connection', (ws) => {
      clients.add(ws);
      log('INFO', `🔗 [${name}] IPC client connected (${clients.size} total)`);

      ws.on('message', (data) => {
        const msg = deserialize(data.toString());
        handleIncoming(ws, msg);
      });

      ws.on('close', () => {
        clients.delete(ws);
        log('INFO', `🔗 [${name}] IPC client disconnected (${clients.size} remaining)`);
      });

      ws.on('error', (err) => {
        log('ERROR', `🔗 [${name}] IPC client error: ${err.message}`);
      });
    });

    wss.on('error', (err) => {
      log('ERROR', `🔗 [${name}] IPC server error: ${err.message}`);
    });

    log('INFO', `🔗 [${name}] IPC server listening on 127.0.0.1:${port}`);
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
        const result = await handler(msg.payload, msg.exchange);
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
        handler(msg.payload, msg.exchange).catch((err) => {
          log('ERROR', `🔗 [${name}] config_update handler error: ${err.message}`);
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
   * Register a handler for incoming requests on a channel
   * @param {string} channel - Request channel name
   * @param {(payload: any, exchange: string|null) => Promise<any>} handler
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
    log('INFO', `🔗 [${name}] IPC server stopped`);
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
