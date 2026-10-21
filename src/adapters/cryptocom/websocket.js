// @ts-check
/**
 * Crypto.com Exchange WebSocket Feed
 *
 * Connects to the Crypto.com Exchange public WebSocket for real-time
 * ticker and trade data. Implements the same interface as the Coinbase
 * feed (connect/disconnect/isActive/getStatus) so it can be used
 * interchangeably via the factory in websocket-feed.js.
 *
 * API docs: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
 * - Public market endpoint: wss://stream.crypto.com/exchange/v1/market
 * - Ticker channel: ticker.{instrument_name}
 * - Trade channel: trade.{instrument_name}
 * - Must wait 1s after connection before subscribing (rate limit)
 */

const { createWebSocketLifecycle } = require('../../websocket-lifecycle');
const { safeJsonParse } = require('../../shared-utils');
const { createContextLogger } = require('../../logger');

const CRYPTOCOM_WS_URL = 'wss://stream.crypto.com/exchange/v1/market';
const POST_CONNECT_DELAY = 1000; // Wait 1s before subscribing

/**
 * Safely parse JSON, returning null on failure
 * @param {string} data
 * @returns {Object|null}
 */

/**
 * Convert standard product ID (e.g. CRO-USD) to Crypto.com instrument (CRO_USD)
 * @param {string} productId
 * @returns {string}
 */
const toInstrumentName = (productId) =>
  productId.toUpperCase().replace('-', '_');

/**
 * Create Crypto.com WebSocket feed
 * @param {string} exchange - Exchange name
 * @param {import('../../websocket-feed').WebSocketConfig} config
 * @returns {{ connect: Function, disconnect: Function, isActive: Function, getStatus: Function }}
 */
const createCryptocomWebSocketFeed = (exchange, config) => {
  const logger = createContextLogger({ exchange, pair: config.productId });
  let requestId = 1;
  const instrumentName = toInstrumentName(config.productId);

  const subscribe = (ws) => {
    const tickerSub = {
      id: requestId++,
      method: 'subscribe',
      params: {
        channels: [`ticker.${instrumentName}`],
      },
    };

    const tradeSub = {
      id: requestId++,
      method: 'subscribe',
      params: {
        channels: [`trade.${instrumentName}`],
      },
    };

    ws.send(JSON.stringify(tickerSub));
    ws.send(JSON.stringify(tradeSub));
    logger.info(`📡 [${exchange}] Subscribed to ticker.${instrumentName}, trade.${instrumentName}`, {
      channels: [`ticker.${instrumentName}`, `trade.${instrumentName}`],
      instrument: instrumentName,
    });
  };

  /**
   * Handle incoming messages from Crypto.com WebSocket
   * Message structure: { id, method, code, result: { channel, instrument_name, subscription, data: [...] } }
   */
  const handleMessage = (data, ws) => {
    const message = safeJsonParse(data);
    if (!message) return;

    // Handle heartbeat responses
    if (message.method === 'public/heartbeat') {
      // Respond to server heartbeat to keep connection alive
      ws?.send(JSON.stringify({
        id: message.id,
        method: 'public/respond-heartbeat',
      }));
      return;
    }

    // Handle subscription errors (successful subscribes carry data in result, so fall through)
    if (message.method === 'subscribe' && message.code !== 0) {
      const errorMsg = message.message || `Subscription error code ${message.code}`;
      logger.error(`❌ [${exchange}] Crypto.com subscription error: ${errorMsg}`, { error: errorMsg, channel: 'subscription' });
      config.onError?.(new Error(errorMsg));
      return;
    }

    const result = message.result;
    if (!result?.channel || !result.data) return;

    const channel = result.channel;
    const channelPrefix = typeof channel === 'string' ? channel.split('.')[0] : '';

    if (channelPrefix === 'ticker') {
      handleTickerData(result.data);
    } else if (channelPrefix === 'trade') {
      handleTradeData(result.data);
    }
  };

  /**
   * Handle ticker data from Crypto.com
   * Fields: a (last price), b (best bid), k (best ask), v (24h volume), t (timestamp)
   */
  const handleTickerData = (dataArray) => {
    if (!config.onTicker) return;

    for (const tick of dataArray) {
      const price = parseFloat(tick.a);
      const bid = parseFloat(tick.b);
      const ask = parseFloat(tick.k);

      // Downstream entry sizing and order pricing assume a complete,
      // uncrossed top-of-book. Withhold sparse/corrupt exchange messages
      // instead of coercing missing values to zero or forwarding NaN.
      if (!Number.isFinite(price) || price <= 0
        || !Number.isFinite(bid) || bid <= 0
        || !Number.isFinite(ask) || ask <= 0
        || bid > ask) {
        continue;
      }

      config.onTicker({
        price,
        bid,
        ask,
        volume24h: parseFloat(tick.v || 0),
        timestamp: tick.t || Date.now(),
      });
    }
  };

  /**
   * Handle trade data from Crypto.com
   * Fields: p (price), q (quantity), s (side), t (timestamp), d (trade ID)
   */
  const handleTradeData = (dataArray) => {
    if (!config.onTrade) return;

    for (const trade of dataArray) {
      config.onTrade({
        tradeId: String(trade.d),
        price: parseFloat(trade.p),
        size: parseFloat(trade.q),
        side: (trade.s || '').toLowerCase(),
        timestamp: trade.t || Date.now(),
      });
    }
  };

  return createWebSocketLifecycle({
    url: CRYPTOCOM_WS_URL, exchange, logger, config, subscribe, handleMessage,
    name: 'Crypto.com WebSocket',
    subscribeDelay: POST_CONNECT_DELAY,
  });
};

module.exports = {
  createCryptocomWebSocketFeed,
};
