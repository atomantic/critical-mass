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

const WebSocket = require('ws');

const CRYPTOCOM_WS_URL = 'wss://stream.crypto.com/exchange/v1/market';
const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;
const POST_CONNECT_DELAY = 1000; // Wait 1s before subscribing

/**
 * Safely parse JSON, returning null on failure
 * @param {string} data
 * @returns {Object|null}
 */
const safeJsonParse = (data) => {
  try { return JSON.parse(data); } catch { return null; }
};

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
  let ws = null;
  let isConnected = false;
  let shouldReconnect = true;
  let reconnectAttempts = 0;
  let heartbeatInterval = null;
  let reconnectTimeout = null;
  let subscribeTimeout = null;
  let requestId = 1;

  const instrumentName = toInstrumentName(config.productId);

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`🔌 [${exchange}] Connecting to Crypto.com WebSocket...`);

    ws = new WebSocket(CRYPTOCOM_WS_URL);

    ws.on('open', () => {
      console.log(`✅ [${exchange}] Crypto.com WebSocket connected`);
      isConnected = true;
      reconnectAttempts = 0;

      // Wait 1s before subscribing (rate limit protection)
      subscribeTimeout = setTimeout(() => {
        subscribe();
        startHeartbeat();
        config.onConnect?.();
      }, POST_CONNECT_DELAY);
    });

    ws.on('message', (data) => {
      handleMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 [${exchange}] Crypto.com WebSocket closed: ${code} ${reason}`);
      handleDisconnect();
    });

    ws.on('error', (error) => {
      console.log(`❌ [${exchange}] Crypto.com WebSocket error: ${error.message}`);
      config.onError?.(error);
    });

    ws.on('pong', () => {
      // Connection alive
    });
  };

  const subscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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
    console.log(`📡 [${exchange}] Subscribed to ticker.${instrumentName}, trade.${instrumentName}`);
  };

  /**
   * Handle incoming messages from Crypto.com WebSocket
   * Message structure: { id, method, code, result: { channel, instrument_name, subscription, data: [...] } }
   */
  const handleMessage = (data) => {
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
      console.log(`❌ [${exchange}] Crypto.com subscription error: ${errorMsg}`);
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
      config.onTicker({
        price: parseFloat(tick.a || 0),
        bid: parseFloat(tick.b || 0),
        ask: parseFloat(tick.k || 0),
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

  const handleDisconnect = () => {
    isConnected = false;
    stopHeartbeat();
    config.onDisconnect?.();

    if (shouldReconnect) {
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);

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

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const disconnect = () => {
    shouldReconnect = false;
    stopHeartbeat();

    if (subscribeTimeout) {
      clearTimeout(subscribeTimeout);
      subscribeTimeout = null;
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    if (ws) {
      ws.close();
      ws = null;
    }

    isConnected = false;
    console.log(`🔌 [${exchange}] Crypto.com WebSocket disconnected`);
  };

  const isActive = () => isConnected;

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
  createCryptocomWebSocketFeed,
};
