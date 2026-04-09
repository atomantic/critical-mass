// @ts-check
/**
 * IPC Protocol
 *
 * Message types, serialization, and constants for inter-process communication
 * between the gateway and engine processes via WebSocket.
 */

const crypto = require('crypto');

const MSG_TYPE = {
  EVENT: 'event',                 // One-way: engine -> gateway (forwarded to Socket.IO)
  REQUEST: 'request',             // Two-way: gateway -> engine (expects response)
  RESPONSE: 'response',          // Two-way: engine -> gateway (reply to request)
  CONFIG_UPDATE: 'config_update', // One-way: gateway -> engine (config changed)
  PING: 'ping',
  PONG: 'pong',
};

const DEFAULT_TIMEOUT = 10_000; // 10s for request/response

/**
 * Create an IPC message
 * @param {string} type - Message type from MSG_TYPE
 * @param {string} channel - Event channel (e.g. 'regime:status', 'coinbase:trade')
 * @param {*} payload - Message data
 * @param {Object} [options]
 * @param {string} [options.id] - Message ID (auto-generated if omitted)
 * @param {string} [options.exchange] - Exchange name
 * @param {string} [options.pair] - Pair / fund identifier (e.g. 'BTC-USDC') — optional, defaults resolved at handler
 * @param {string} [options.room] - Socket.IO room to emit to
 * @param {string} [options.error] - Error message (for response type)
 * @returns {Object}
 */
const createMessage = (type, channel, payload, options = {}) => ({
  type,
  id: options.id || crypto.randomUUID(),
  channel,
  exchange: options.exchange || null,
  pair: options.pair || null,
  payload,
  room: options.room || null,
  error: options.error || null,
  ts: Date.now(),
});

/**
 * Serialize a message for WebSocket transport
 * @param {Object} msg
 * @returns {string}
 */
const serialize = (msg) => JSON.stringify(msg);

/**
 * Deserialize a WebSocket message
 * @param {string} data
 * @returns {Object}
 */
const deserialize = (data) => JSON.parse(data);

module.exports = { MSG_TYPE, DEFAULT_TIMEOUT, createMessage, serialize, deserialize };
