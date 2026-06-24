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
const MAX_MISSED_PONGS = 2; // terminate after this many unanswered pings
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
  let missedPongs = 0;

  const symbol = toGeminiSymbol(config.productId).toUpperCase();

  // Track best bid/ask from L2 updates.
  // The full book is maintained per side (price -> qty) from the `changes`
  // stream so that a qty=0 removal at the current best is applied as a
  // deletion and the best is recomputed from what remains (issue #144).
  // Without the book, bestBid/bestAsk only ever ratcheted one-directionally
  // (up for bid, down for ask) and produced a stale, crossed book.
  let bestBid = 0;
  let bestAsk = 0;
  let lastPrice = 0;
  const bidLevels = new Map(); // price -> qty
  const askLevels = new Map(); // price -> qty

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

      // A (re)connection means the next l2_updates is a fresh full snapshot.
      // Drop any prior book state so removals from the old session can't
      // linger as phantom levels and re-cross the recomputed best. lastPrice
      // is reset too so the first post-reconnect ticker reports the fresh
      // bestBid rather than a stale pre-disconnect trade price.
      bidLevels.clear();
      askLevels.clear();
      bestBid = 0;
      bestAsk = 0;
      lastPrice = 0;

      subscribe();
      startHeartbeat();
      config.onConnect?.();
    });

    ws.on('message', (data) => {
      missedPongs = 0; // Any inbound data proves the connection is alive
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
      missedPongs = 0; // Connection alive
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
   * Recompute best bid (highest bid price) and best ask (lowest ask price)
   * from the live book maps. Iterates rather than spreading into Math.max/min
   * to stay safe on deep books (argument-count limits). An empty side recomputes
   * to 0 — a truthful "no level here" — and `emitTicker` then withholds the
   * ticker until the side refills, so neither a stale held best nor a 0 reaches
   * downstream pricing.
   */
  const recomputeBest = () => {
    let hb = 0;
    for (const p of bidLevels.keys()) if (p > hb) hb = p;
    bestBid = hb;
    let la = 0;
    for (const p of askLevels.keys()) if (la === 0 || p < la) la = p;
    bestAsk = la;
  };

  /**
   * Emit a ticker only when the book has a valid, uncrossed top-of-book
   * (both sides present, bid <= ask). A missing side (best === 0) or a crossed
   * book would feed bad prices into order pricing — notably a 0 bid divides to
   * Infinity in entry sizing (assetQty = sizeUsdc / bid), and a crossed book is
   * exactly the corruption this fix removes — so withhold the update until the
   * book is whole again. For a liquid market that gap is momentary.
   */
  const emitTicker = () => {
    if (!config.onTicker) return;
    if (!(bestBid > 0) || !(bestAsk > 0) || bestBid > bestAsk) return;
    config.onTicker({
      price: lastPrice || bestBid,
      bid: bestBid,
      ask: bestAsk,
      volume24h: 0, // Not available from L2 stream
      timestamp: Date.now(),
    });
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
      if (!(p > 0)) continue;
      const levels = side === 'buy' ? bidLevels : side === 'sell' ? askLevels : null;
      if (!levels) continue;
      // qty>0 sets/updates the level; qty=0 removes it (Gemini deletion).
      if (q > 0) levels.set(p, q);
      else levels.delete(p);
    }

    // Recompute the best from the live book: highest remaining bid, lowest
    // remaining ask. A removal at the prior best now drops the best to the
    // next level instead of leaving a stale, crossed value.
    recomputeBest();

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

    emitTicker();
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

    // Emit ticker update with latest trade price (gated on a valid book).
    emitTicker();
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

  // Heartbeat with pong-timeout watchdog: if MAX_MISSED_PONGS pings go
  // unanswered, terminate() forces 'close' so the reconnect/backoff path runs.
  const startHeartbeat = () => {
    stopHeartbeat();
    missedPongs = 0;
    heartbeatInterval = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;

      if (missedPongs >= MAX_MISSED_PONGS) {
        console.log(`💀 [${exchange}] No pong after ${missedPongs} pings (${(missedPongs * HEARTBEAT_INTERVAL) / 1000}s) — terminating dead WebSocket to trigger reconnect`);
        ws.terminate();
        return;
      }

      missedPongs++;
      ws.ping();
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
