// @ts-check
/**
 * IPC Protocol
 *
 * Message types, serialization, and constants for inter-process communication
 * between the gateway and engine processes via WebSocket.
 */

const crypto = require('crypto');

const MSG_TYPE = {
  EVENT: 'event',                 // One-way: engine -> gateway (forwarded to the realtime bus)
  REQUEST: 'request',             // Two-way: gateway -> engine (expects response)
  RESPONSE: 'response',          // Two-way: engine -> gateway (reply to request)
  CONFIG_UPDATE: 'config_update', // One-way: gateway -> engine (config changed)
  SUBSCRIBE: 'subscribe',         // One-way: gateway -> engine (deliver events held while no gateway was connected)
  PING: 'ping',
  PONG: 'pong',
};

/**
 * Request channel names shared by the gateway (clients calling
 * `ipc.request(...)`) and the engine (`ipcServer.onRequest(...)`). Using one
 * table on both sides means a rename fails at require time instead of as a
 * runtime request timeout.
 */
const IPC_CHANNELS = Object.freeze({
  ENGINE_MAINTENANCE: 'engine:maintenance',
  ENGINE_BACKUP_PAUSE: 'engine:backup-pause',
  ENGINE_BACKUP_RESUME: 'engine:backup-resume',
  REGIME_START: 'regime:start',
  REGIME_STOP: 'regime:stop',
  REGIME_RECALCULATE: 'regime:recalculate',
  REGIME_CANCEL_LADDER: 'regime:cancel-ladder',
  REGIME_CHART_DATA: 'regime:chart-data',
  REGIME_CLOSE: 'regime:close',
  REGIME_CONFIG: 'regime:config',
  REGIME_CONVERT_DCA: 'regime:convert-dca',
  REGIME_DISMISS_FILLS: 'regime:dismiss-fills',
  REGIME_DRY_RUN_LOG: 'regime:dry-run-log',
  REGIME_DRY_RUN_PNL: 'regime:dry-run-pnl',
  REGIME_DRY_RUN_RESET: 'regime:dry-run-reset',
  REGIME_DRY_RUN_STATE: 'regime:dry-run-state',
  REGIME_FILLS: 'regime:fills',
  REGIME_FILLS_CYCLES: 'regime:fills:cycles',
  REGIME_FORCE_REGIME: 'regime:force-regime',
  REGIME_MANUAL_TRADE: 'regime:manual-trade',
  REGIME_MANUAL_TRADE_BUY: 'regime:manual-trade-buy',
  REGIME_MANUAL_TRADE_CHECK: 'regime:manual-trade-check',
  REGIME_MANUAL_TRADE_PAIR: 'regime:manual-trade-pair',
  REGIME_MANUAL_TRADE_RESUME: 'regime:manual-trade-resume',
  REGIME_MANUAL_TRADE_RETRY: 'regime:manual-trade-retry',
  REGIME_MANUAL_TRADES: 'regime:manual-trades',
  REGIME_OPEN_ORDERS: 'regime:open-orders',
  REGIME_PAUSE: 'regime:pause',
  REGIME_PREVIEW_LADDER: 'regime:preview-ladder',
  REGIME_REBUILD_LADDER: 'regime:rebuild-ladder',
  REGIME_RECONCILE_PLACEMENT_INTENT: 'regime:reconcile-placement-intent',
  REGIME_REOPEN: 'regime:reopen',
  REGIME_RESET_CYCLE: 'regime:reset-cycle',
  REGIME_RESUME: 'regime:resume',
  REGIME_RESUME_DRAWDOWN: 'regime:resume-drawdown',
  REGIME_ROLLUP_ALL: 'regime:rollup-all',
  REGIME_ROLLUP_BODY: 'regime:rollup-body',
  REGIME_SET_BODY_TP: 'regime:set-body-tp',
  REGIME_SET_BODY_TP_PRICE: 'regime:set-body-tp-price',
  REGIME_STATUS: 'regime:status',
  REGIME_STOP_ALL: 'regime:stop-all',
  REGIME_UNACCOUNTED_FILLS: 'regime:unaccounted-fills',
  REGIME_UNACCOUNTED_FILLS_STATUS: 'regime:unaccounted-fills-status',
  REGIME_UPDATE_CONFIG: 'regime:update-config',
});

/**
 * Machine-readable `code` the gateway IPC client attaches to every Error it
 * rejects a request with, so routes can tell an unreachable engine from a
 * healthy engine whose handler threw:
 *  - transport: no usable connection (not connected, socket closed/not open)
 *  - timeout:   the engine did not answer before the deadline
 *  - handler:   the engine answered with an error reply (its handler threw)
 */
const IPC_ERROR_CODE = Object.freeze({
  TRANSPORT: 'transport',
  TIMEOUT: 'timeout',
  HANDLER: 'handler',
});

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
 * @param {string} [options.room] - Realtime bus room to emit to
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

const { IPC_SECRET_HEADER, getIpcSecret, ipcSecretMatches } = require('./ipc-secret');

module.exports = { IPC_SECRET_HEADER, getIpcSecret, ipcSecretMatches, MSG_TYPE, IPC_CHANNELS, IPC_ERROR_CODE, DEFAULT_TIMEOUT, createMessage, serialize, deserialize };
