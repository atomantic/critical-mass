// @ts-check
/**
 * Price Bridge
 *
 * Bridges critical-mass's existing Coinbase/Gemini/Crypto.com market data
 * feeds to the Kalshi simulation engine. Replaces the standalone
 * coinbase-price-service.js that kalshibot used to run its own WebSocket.
 *
 * This means there's exactly ONE Coinbase WebSocket connection (the existing
 * authenticated Advanced Trade feed), and Kalshi piggybacks on it.
 */

const { getMarketDataService } = require('../../market-data-service');
const { log } = require('../../logger');

/** @type {Map<string, { price: number, bid: number, ask: number, volume24h: number, previousPrice: number, priceChange: number, updatedAt: number }>} */
const priceCache = new Map();

/** @type {((ticker: string, price: number, data: Object) => void) | null} */
let priceCallback = null;

/** @type {import('socket.io').Server | null} */
let socketIo = null;

/** @type {boolean} */
let isRunning = false;

/** @type {NodeJS.Timeout | null} */
let pollInterval = null;

/** Format timestamp for logs */
const ts = () => new Date().toISOString().slice(11, 23);

/**
 * Initialize the price bridge
 * @param {import('socket.io').Server} io - Socket.IO server instance
 * @param {Object} [options] - Options
 * @param {(ticker: string, price: number, data: Object) => void} [options.onPriceUpdate] - Callback for price updates
 * @param {string} [options.exchange] - Exchange to bridge from (default: 'coinbase')
 * @returns {{ start: () => void, stop: () => void, getCachedPrice: (ticker: string) => Object|null, getAllCachedPrices: () => Object, getStatus: () => Object }}
 */
const createPriceBridge = (io, options = {}) => {
  const { onPriceUpdate = null, exchange = 'coinbase' } = options;

  priceCallback = onPriceUpdate;
  socketIo = io;

  /**
   * Poll the market data service for the latest price and forward it
   */
  let pollDebugCount = 0;
  const pollPrice = () => {
    const service = getMarketDataService(exchange);
    if (!service) {
      if (pollDebugCount++ < 3) log('WARN', `[${ts()}] 🌉 Price bridge: no ${exchange} market data service yet`);
      return;
    }

    const marketState = service.getMarketState();
    if (!marketState || !marketState.lastPrice) return;

    // Map to BTC-USD ticker format (what kalshibot's coinbase-price-service used)
    const ticker = 'BTC-USD';
    const existing = priceCache.get(ticker);
    const previousPrice = existing?.price || marketState.lastPrice;
    const priceChange = marketState.lastPrice - previousPrice;

    // Skip if price hasn't changed
    if (existing && existing.price === marketState.lastPrice) return;

    const updated = {
      price: marketState.lastPrice,
      bid: marketState.bid || marketState.lastPrice,
      ask: marketState.ask || marketState.lastPrice,
      volume24h: 0,
      previousPrice,
      priceChange,
      updatedAt: Date.now(),
    };

    priceCache.set(ticker, updated);

    // Forward to simulation engine callback
    if (priceCallback) {
      priceCallback(ticker, marketState.lastPrice, updated);
    }

    // Broadcast to Socket.IO clients in the coinbase room (for Kalshi UI charts)
    if (socketIo) {
      socketIo.to('kalshi:coinbase').emit('kalshi:coinbase:price', {
        ticker,
        ...updated,
      });
    }
  };

  const start = () => {
    if (isRunning) return;
    isRunning = true;

    // Poll every 500ms to forward price updates from the existing market data service
    pollInterval = setInterval(pollPrice, 500);

    // Initial poll
    pollPrice();

    log('INFO', `[${ts()}] 🌉 Kalshi price bridge started (bridging ${exchange} -> simulation engine)`);
  };

  const stop = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    isRunning = false;
    priceCache.clear();
    log('INFO', `[${ts()}] 🌉 Kalshi price bridge stopped`);
  };

  const getCachedPrice = (ticker) => priceCache.get(ticker) || null;

  const getAllCachedPrices = () => Object.fromEntries(priceCache);

  const getStatus = () => ({
    running: isRunning,
    exchange,
    tickerCount: priceCache.size,
    subscriptions: Array.from(priceCache.keys()),
  });

  return {
    start,
    stop,
    getCachedPrice,
    getAllCachedPrices,
    getStatus,
  };
};

module.exports = { createPriceBridge };
