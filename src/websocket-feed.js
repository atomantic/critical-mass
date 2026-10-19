// @ts-check
/**
 * WebSocket Feed Manager
 *
 * Manages WebSocket connections to Coinbase Advanced Trade API.
 * Channels:
 * - ticker: Real-time price updates
 * - market_trades: Trade executions
 * - user: Order updates and fills
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - heartbeats channel keeps inbound traffic flowing for the liveness watchdog
 * - JWT authentication for user channel
 */

const { createWebSocketLifecycle } = require('./websocket-lifecycle');
const { signJwt } = require('./jwt');
const crypto = require('crypto');
const { preparePrivateKey } = require('./adapters/coinbase/auth');
const { createContextLogger } = require('./logger');

/**
 * @typedef {Object} WebSocketConfig
 * @property {string} productId - Product to subscribe to
 * @property {string} [apiKey] - API key for authentication (optional for public-only mode)
 * @property {string} [apiSecret] - API secret (private key, optional for public-only mode)
 * @property {boolean} [publicOnly] - If true, only subscribe to public channels (ticker, market_trades)
 * @property {Function} [onTicker] - Ticker update callback
 * @property {Function} [onTrade] - Trade callback
 * @property {Function} [onOrderUpdate] - Order update callback
 * @property {Function} [onConnect] - Connection established callback
 * @property {Function} [onDisconnect] - Disconnection callback
 * @property {Function} [onError] - Error callback
 */

const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';

/**
 * Generate JWT for WebSocket authentication
 * @param {string} apiKey - API key
 * @param {string} apiSecret - Private key
 * @returns {string} JWT token
 */
const generateWsJWT = (apiKey, apiSecret) => {
  const pemKey = preparePrivateKey(apiSecret);

  return signJwt(
    {
      iss: 'cdp',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: apiKey,
    },
    pemKey,
    {
      algorithm: 'ES256',
      header: {
        kid: apiKey,
        nonce: crypto.randomBytes(16).toString('hex'),
      },
    }
  );
};

/**
 * Safely parse JSON, returning null on failure
 * @param {string} data - JSON string
 * @returns {Object|null} Parsed object or null
 */
const safeJsonParse = (data) => {
  try { return JSON.parse(data); } catch { return null; }
};

/**
 * Create WebSocket feed manager
 * @param {string} exchange - Exchange name
 * @param {WebSocketConfig} config - Configuration
 * @returns {Object} WebSocket feed instance
 */
const createWebSocketFeed = (exchange, config) => {
  if (exchange === 'cryptocom') {
    const { createCryptocomWebSocketFeed } = require('./adapters/cryptocom/websocket');
    return createCryptocomWebSocketFeed(exchange, config);
  }
  if (exchange === 'gemini') {
    const { createGeminiWebSocketFeed } = require('./adapters/gemini/websocket');
    return createGeminiWebSocketFeed(exchange, config);
  }

  const logger = createContextLogger({ exchange, pair: config.productId });

  const subscribe = (ws) => {
    const productIds = [config.productId];

    // Subscribe to ticker channel (public)
    const tickerSub = {
      type: 'subscribe',
      product_ids: productIds,
      channel: 'ticker',
    };

    // Subscribe to market_trades channel (public)
    const tradesSub = {
      type: 'subscribe',
      product_ids: productIds,
      channel: 'market_trades',
    };

    // Heartbeats (one per second) keep inbound traffic flowing on a quiet
    // product; the lifecycle judges liveness on inbound frames (issue #1180).
    const heartbeatSub = {
      type: 'subscribe',
      product_ids: productIds,
      channel: 'heartbeats',
    };

    ws.send(JSON.stringify(tickerSub));
    ws.send(JSON.stringify(tradesSub));
    ws.send(JSON.stringify(heartbeatSub));

    // Subscribe to user channel (authenticated) - only if not public-only mode
    if (!config.publicOnly && config.apiKey && config.apiSecret) {
      try {
        const jwtToken = generateWsJWT(config.apiKey, config.apiSecret);
        const userSub = {
          type: 'subscribe',
          product_ids: productIds,
          channel: 'user',
          jwt: jwtToken,
        };
        ws.send(JSON.stringify(userSub));
        logger.info(`📡 [${exchange}] Subscribed to ticker, market_trades, heartbeats, user channels for ${config.productId}`, {
          channels: ['ticker', 'market_trades', 'heartbeats', 'user'],
        });
      } catch (err) {
        logger.warn(`⚠️ [${exchange}] Failed to subscribe to user channel (JWT error): ${err.message}`, { error: err.message, channel: 'user' });
        logger.info(`📡 [${exchange}] Subscribed to ticker, market_trades, heartbeats channels for ${config.productId}`, {
          channels: ['ticker', 'market_trades', 'heartbeats'],
        });
      }
    } else {
      logger.info(`📡 [${exchange}] Subscribed to ticker, market_trades, heartbeats channels for ${config.productId}`, {
        channels: ['ticker', 'market_trades', 'heartbeats'],
      });
    }
  };

  /**
   * Handle incoming WebSocket message
   * @param {string} data - Message data
   */
  const handleMessage = (data) => {
    const message = safeJsonParse(data);
    if (!message) {
      logger.warn(`⚠️ [${exchange}] Received invalid JSON from WebSocket`, { error: 'invalid_json' });
      return;
    }
    const { channel, events, type } = message;

    // Handle non-event messages (errors, heartbeats, subscription acks)
    if (type === 'error') {
      const errorMsg = message.message || message.reason || 'Unknown WebSocket error';
      logger.error(`❌ [${exchange}] WebSocket error: ${errorMsg}`, { error: errorMsg });
      if (config.onError) {
        config.onError(new Error(errorMsg));
      }
      return;
    }

    // Skip heartbeat and subscription confirmation messages
    if (!events || events.length === 0) return;

    switch (channel) {
      case 'ticker':
        handleTickerEvent(events);
        break;
      case 'market_trades':
        handleTradeEvent(events);
        break;
      case 'user':
        handleUserEvent(events);
        break;
      case 'subscriptions':
        // Subscription confirmation
        break;
      default:
        // Unknown channel
        break;
    }
  };

  /**
   * Check if product ID matches exactly
   * @param {string} tickerProductId - Product ID from ticker
   * @returns {boolean}
   */
  const isMatchingProduct = (tickerProductId) => {
    if (!tickerProductId) return false;
    if (tickerProductId === config.productId) return true;
    // Coinbase WS sends BTC-USD for BTC-USDC subscriptions; match on base currency
    const [tickerBase] = tickerProductId.split('-');
    const [configBase] = config.productId.split('-');
    return tickerBase === configBase;
  };

  /**
   * Handle ticker events
   * @param {Object[]} events - Ticker events
   */
  const handleTickerEvent = (events) => {
    for (const event of events) {
      // Handle both 'ticker' type events and direct ticker data
      const tickers = event.tickers || (event.product_id ? [event] : []);

      for (const ticker of tickers) {
        if (!isMatchingProduct(ticker.product_id)) continue;

        // Reject the event when price is missing/non-positive rather than
        // coercing it to 0 — a hard 0 propagates into priceHistory, the chart
        // buffer, and the APY calc downstream (consumers assign lastPrice with
        // no >0 guard) (issue #110 M1).
        const price = parseFloat(ticker.price);
        if (!Number.isFinite(price) || price <= 0) continue;

        const tickerData = {
          price,
          bid: parseFloat(ticker.best_bid || 0),
          ask: parseFloat(ticker.best_ask || 0),
          bidSize: parseFloat(ticker.best_bid_quantity || 0),
          askSize: parseFloat(ticker.best_ask_quantity || 0),
          volume24h: parseFloat(ticker.volume_24_h || 0),
          timestamp: Date.now(),
        };

        if (config.onTicker) {
          config.onTicker(tickerData);
        }
      }
    }
  };

  /**
   * Handle trade events
   * @param {Object[]} events - Trade events
   */
  const handleTradeEvent = (events) => {
    for (const event of events) {
      if (event.type !== 'snapshot' && event.type !== 'update') continue;

      for (const trade of event.trades || []) {
        if (!isMatchingProduct(trade.product_id)) continue;
        // Guard against a malformed trade with no side — trade.side.toLowerCase()
        // would otherwise throw synchronously inside the ws 'message' listener,
        // becoming an uncaughtException with no global handler (issue #110 M2).
        if (!trade.side) continue;

        const tradeData = {
          tradeId: trade.trade_id,
          price: parseFloat(trade.price),
          size: parseFloat(trade.size),
          side: trade.side.toLowerCase(),
          timestamp: new Date(trade.time).getTime(),
        };

        if (config.onTrade) {
          config.onTrade(tradeData);
        }
      }
    }
  };

  /**
   * Handle user channel events (orders, fills)
   * @param {Object[]} events - User events
   */
  const handleUserEvent = (events) => {
    for (const event of events) {
      if (event.type !== 'snapshot' && event.type !== 'update') continue;

      for (const order of event.orders || []) {
        if (order.product_id !== config.productId) continue;
        if (!order.side) continue; // Skip orders without side info

        const orderData = {
          orderId: order.order_id,
          clientOrderId: order.client_order_id,
          productId: order.product_id,
          side: order.side.toLowerCase(),
          status: order.status,
          orderType: order.order_type,
          filledSize: parseFloat(order.filled_size || 0),
          filledValue: parseFloat(order.filled_value || 0),
          averageFilledPrice: parseFloat(order.average_filled_price || 0),
          totalFees: parseFloat(order.total_fees || 0),
          createdTime: order.created_time,
          completionPercentage: parseFloat(order.completion_percentage || 0),
        };

        if (config.onOrderUpdate) {
          config.onOrderUpdate(orderData);
        }
      }
    }
  };

  return createWebSocketLifecycle({
    url: COINBASE_WS_URL, exchange, logger, config, subscribe, handleMessage,
  });
};

module.exports = {
  createWebSocketFeed,
};
