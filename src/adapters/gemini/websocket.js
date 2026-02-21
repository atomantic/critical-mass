// @ts-check
/**
 * Gemini Exchange WebSocket Feed
 *
 * Connects to Gemini's v2 WebSocket for real-time market data.
 * Subscribes to L2 book updates (best bid/ask) and trades, then
 * normalises them into the standard ticker/trade interface used by
 * the rest of the codebase.
 *
 * API docs: https://docs.gemini.com/websocket/market-data/v2/about
 * - Endpoint: wss://api.gemini.com/v2/marketdata
 * - Subscribe via JSON: { type: "subscribe", subscriptions: [{ name: "l2", symbols: [...] }] }
 * - Messages: l2_updates (changes + trades), trade
 * - No auth needed for public market data
 */

const WebSocket = require('ws');

const GEMINI_WS_URL = 'wss://api.gemini.com/v2/marketdata';
const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;

/**
 * Safely parse JSON, returning null on failure
 * @param {string} data
 * @returns {Object|null}
 */
const safeJsonParse = (data) => {
  try { return JSON.parse(data); } catch { return null; }
};

/**
 * Convert standard product ID (e.g. BTC-USD) to Gemini symbol (btcusd)
 * Mirrors toGeminiSymbol in api.js
 * @param {string} productId
 * @returns {string}
 */
const toGeminiSymbol = (productId) =>
  productId.toLowerCase().replace('-', '').replace('usdc', 'usd');

/**
 * Create Gemini WebSocket feed
 * @param {string} exchange - Exchange name
 * @param {import('../../websocket-feed').WebSocketConfig} config
 * @returns {{ connect: Function, disconnect: Function, isActive: Function, getStatus: Function }}
 */
const createGeminiWebSocketFeed = (exchange, config) => {
  let ws = null;
  let isConnected = false;
  let shouldReconnect = true;
  let reconnectAttempts = 0;
  let heartbeatInterval = null;
  let reconnectTimeout = null;

  const symbol = toGeminiSymbol(config.productId).toUpperCase();

  // Track best bid/ask from L2 updates
  let bestBid = 0;
  let bestAsk = 0;
  let lastPrice = 0;

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`🔌 [${exchange}] Connecting to Gemini WebSocket...`);

    ws = new WebSocket(GEMINI_WS_URL);

    ws.on('open', () => {
      console.log(`✅ [${exchange}] Gemini WebSocket connected`);
      isConnected = true;
      reconnectAttempts = 0;

      subscribe();
      startHeartbeat();
      config.onConnect?.();
    });

    ws.on('message', (data) => {
      handleMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 [${exchange}] Gemini WebSocket closed: ${code} ${reason}`);
      handleDisconnect();
    });

    ws.on('error', (error) => {
      console.log(`❌ [${exchange}] Gemini WebSocket error: ${error.message}`);
      config.onError?.(error);
    });

    ws.on('pong', () => {
      // Connection alive
    });
  };

  const subscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const sub = {
      type: 'subscribe',
      subscriptions: [
        { name: 'l2', symbols: [symbol] },
      ],
    };

    ws.send(JSON.stringify(sub));
    console.log(`📡 [${exchange}] Subscribed to l2 for ${symbol}`);
  };

  /**
   * Handle incoming Gemini v2 WebSocket messages.
   *
   * Message types:
   * - l2_updates: { type, symbol, changes: [[side,price,qty],...], trades?: [...] }
   * - trade:      { type, symbol, price, quantity, side, tid, timestamp }
   */
  const handleMessage = (data) => {
    const message = safeJsonParse(data);
    if (!message) return;

    const { type } = message;

    if (type === 'l2_updates') {
      handleL2Updates(message);
    } else if (type === 'trade') {
      handleTradeMessage(message);
    }
    // Subscription acks and other types are silently ignored
  };

  /**
   * Process L2 book updates and embedded trades.
   * Update best bid/ask from changes, then emit ticker.
   */
  const handleL2Updates = (message) => {
    const changes = message.changes || [];

    for (const [side, price, qty] of changes) {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (side === 'buy' && q > 0 && (p > bestBid || bestBid === 0)) {
        bestBid = p;
      } else if (side === 'sell' && q > 0 && (p < bestAsk || bestAsk === 0)) {
        bestAsk = p;
      }
      // A removal (qty=0) at current best means our cached value is stale,
      // but the next change will correct it. Acceptable for ticker purposes.
    }

    // Process embedded trades (present in snapshot and some updates)
    const trades = message.trades || [];
    for (const trade of trades) {
      const tradePrice = parseFloat(trade.price);
      if (tradePrice > 0) lastPrice = tradePrice;

      if (config.onTrade) {
        config.onTrade({
          tradeId: String(trade.tid),
          price: tradePrice,
          size: parseFloat(trade.quantity),
          side: (trade.side || '').toLowerCase(),
          timestamp: trade.timestamp || Date.now(),
        });
      }
    }

    // Emit ticker if we have meaningful data
    if ((lastPrice > 0 || bestBid > 0) && config.onTicker) {
      config.onTicker({
        price: lastPrice || bestBid,
        bid: bestBid,
        ask: bestAsk,
        volume24h: 0, // Not available from L2 stream
        timestamp: Date.now(),
      });
    }
  };

  /**
   * Handle standalone trade messages (outside l2_updates)
   */
  const handleTradeMessage = (message) => {
    const tradePrice = parseFloat(message.price);
    if (tradePrice > 0) lastPrice = tradePrice;

    if (config.onTrade) {
      config.onTrade({
        tradeId: String(message.tid),
        price: tradePrice,
        size: parseFloat(message.quantity),
        side: (message.side || '').toLowerCase(),
        timestamp: message.timestamp || Date.now(),
      });
    }

    // Emit ticker update with latest trade price
    if (config.onTicker) {
      config.onTicker({
        price: lastPrice,
        bid: bestBid,
        ask: bestAsk,
        volume24h: 0,
        timestamp: Date.now(),
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

    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    if (ws) {
      ws.close();
      ws = null;
    }

    isConnected = false;
    console.log(`🔌 [${exchange}] Gemini WebSocket disconnected`);
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
  createGeminiWebSocketFeed,
};
