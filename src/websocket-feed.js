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
 * - Heartbeat/ping-pong for connection health
 * - JWT authentication for user channel
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { preparePrivateKey } = require('./adapters/coinbase/auth');

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
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;

/**
 * Generate JWT for WebSocket authentication
 * @param {string} apiKey - API key
 * @param {string} apiSecret - Private key
 * @returns {string} JWT token
 */
const generateWsJWT = (apiKey, apiSecret) => {
  const pemKey = preparePrivateKey(apiSecret);

  return jwt.sign(
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
  let ws = null;
  let isConnected = false;
  let shouldReconnect = true;
  let reconnectAttempts = 0;
  let heartbeatInterval = null;
  let reconnectTimeout = null;

  /**
   * Connect to WebSocket
   */
  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`🔌 [${exchange}] Connecting to WebSocket...`);

    ws = new WebSocket(COINBASE_WS_URL);

    ws.on('open', () => {
      console.log(`✅ [${exchange}] WebSocket connected`);
      isConnected = true;
      reconnectAttempts = 0;

      // Subscribe to channels
      subscribe();

      // Start heartbeat
      startHeartbeat();

      if (config.onConnect) {
        config.onConnect();
      }
    });

    ws.on('message', (data) => {
      handleMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 [${exchange}] WebSocket closed: ${code} ${reason}`);
      handleDisconnect();
    });

    ws.on('error', (error) => {
      console.log(`❌ [${exchange}] WebSocket error: ${error.message}`);
      if (config.onError) {
        config.onError(error);
      }
    });

    ws.on('pong', () => {
      // Connection is alive
    });
  };

  /**
   * Subscribe to channels
   */
  const subscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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

    ws.send(JSON.stringify(tickerSub));
    ws.send(JSON.stringify(tradesSub));

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
        console.log(`📡 [${exchange}] Subscribed to ticker, market_trades, user channels for ${config.productId}`);
      } catch (err) {
        console.log(`⚠️ [${exchange}] Failed to subscribe to user channel (JWT error): ${err.message}`);
        console.log(`📡 [${exchange}] Subscribed to ticker, market_trades channels for ${config.productId}`);
      }
    } else {
      console.log(`📡 [${exchange}] Subscribed to ticker, market_trades channels for ${config.productId}`);
    }
  };

  /**
   * Handle incoming WebSocket message
   * @param {string} data - Message data
   */
  const handleMessage = (data) => {
    const message = safeJsonParse(data);
    if (!message) {
      console.log(`⚠️ [${exchange}] Received invalid JSON from WebSocket`);
      return;
    }
    const { channel, events, type } = message;

    // Handle non-event messages (errors, heartbeats, subscription acks)
    if (type === 'error') {
      const errorMsg = message.message || message.reason || 'Unknown WebSocket error';
      console.log(`❌ [${exchange}] WebSocket error: ${errorMsg}`);
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

        const tickerData = {
          price: parseFloat(ticker.price || 0),
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

  /**
   * Handle disconnection
   */
  const handleDisconnect = () => {
    isConnected = false;
    stopHeartbeat();

    if (config.onDisconnect) {
      config.onDisconnect();
    }

    if (shouldReconnect) {
      scheduleReconnect();
    }
  };

  /**
   * Schedule reconnection with exponential backoff
   */
  const scheduleReconnect = () => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
      MAX_RECONNECT_DELAY
    );

    console.log(`🔄 [${exchange}] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts + 1})`);

    reconnectTimeout = setTimeout(() => {
      reconnectAttempts++;
      connect();
    }, delay);
  };

  /**
   * Start heartbeat ping
   */
  const startHeartbeat = () => {
    stopHeartbeat();

    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  };

  /**
   * Stop heartbeat ping
   */
  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  /**
   * Disconnect WebSocket
   */
  const disconnect = () => {
    shouldReconnect = false;
    stopHeartbeat();

    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    if (ws) {
      ws.close();
      ws = null;
    }

    isConnected = false;
    console.log(`🔌 [${exchange}] WebSocket disconnected`);
  };

  /**
   * Check if connected
   * @returns {boolean}
   */
  const isActive = () => isConnected;

  /**
   * Get connection status
   * @returns {{connected: boolean, reconnectAttempts: number}}
   */
  const getStatus = () => ({
    connected: isConnected,
    reconnectAttempts,
  });

  return {
    connect,
    disconnect,
    isActive,
    getStatus,
  };
};

module.exports = {
  createWebSocketFeed,
};
