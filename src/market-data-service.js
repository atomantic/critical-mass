// @ts-check
/**
 * Market Data Service
 *
 * Maintains WebSocket connections for live market data streaming
 * even when the regime engine isn't running. Provides:
 * - Real-time price updates
 * - ATR and volatility calculations
 * - Regime detection (passive, no trading)
 *
 * This allows the UI to show live data before starting the engine.
 */

const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { calculateAllMetrics } = require('./volatility-utils');
const { getAdapter } = require('./adapters');
const { getRegimeConfig } = require('./config-utils');
const { loadRegimeState } = require('./state-tracker');
const { createFillLedger } = require('./fill-ledger');

// Store active market data services by exchange
const marketDataServices = new Map();

// Only Coinbase is supported for WebSocket market data (other exchanges have different APIs)
const SUPPORTED_EXCHANGES = ['coinbase', 'cryptocom'];

/**
 * Create a market data service for an exchange
 * @param {string} exchange - Exchange name
 * @returns {Object} Market data service instance
 */
const createMarketDataService = (exchange) => {
  let wsFeed = null;
  let regimeDetector = null;
  let fillLedger = null;
  let isConnected = false;
  let metricsUpdateInterval = null;
  let onStatusUpdateCallback = null;
  let lastStatusEmit = 0;
  const STATUS_EMIT_INTERVAL = 1000; // Throttle to ~1/sec to match chart buffer rate

  // Cache for regime state to avoid disk reads every second
  let cachedRegimeState = null;
  let cachedRegimeStateTime = 0;
  const REGIME_STATE_CACHE_MS = 10_000; // Reload from disk at most every 10s

  // Market state (same structure as regime engine)
  const marketState = {
    lastPrice: 0,
    bid: 0,
    ask: 0,
    spread: 0,
    atr1m: 0,
    atr5m: 0,
    realizedVol: 0,
    volBaseline: 0,
    vwap: 0,
    vwapDistance: 0,
    recentSwing: 0,
    lastUpdate: 0,
  };

  // Regime state
  const regimeState = {
    mode: 'HARVEST',
    since: Date.now(),
    reason: 'Initial state',
  };

  // Tracked open orders (from saved regime state)
  const trackedOrders = new Map(); // orderId -> { type, price, size, placedAt, status }
  let onOrderFillCallback = null; // External callback for when orders fill

  // Price history for calculations
  const priceHistory = [];
  const MAX_PRICE_HISTORY = 300; // 5 minutes of tick data

  /**
   * Start the market data service
   */
  const start = async () => {
    const adapter = getAdapter(exchange);

    // Try to load credentials with error handling
    let credentials;
    try {
      credentials = adapter.loadCredentials();
    } catch (err) {
      console.log(`⚠️ [${exchange}] Market data service: Failed to load credentials: ${err.message}`);
      return { success: false, error: err.message };
    }

    if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
      console.log(`⚠️ [${exchange}] Market data service: No API credentials, skipping`);
      return { success: false, error: 'No API credentials' };
    }

    const config = getRegimeConfig(exchange);
    const productId = config.productId || 'BTC-USDC';

    // Create regime detector for passive monitoring
    regimeDetector = createRegimeDetector(exchange, config);

    // Load any tracked orders from saved regime state
    const savedState = loadRegimeState(exchange);
    if (savedState.position?.activeTpOrderId) {
      trackedOrders.set(savedState.position.activeTpOrderId, {
        type: 'take_profit',
        price: savedState.position.lastTpPrice || 0,
        size: savedState.position.assetOnOrder || savedState.position.totalAsset || 0,
        placedAt: savedState.position.lastEntryTime || Date.now(),
        status: 'open',
      });
      console.log(`📋 [${exchange}] Market data service tracking TP order: ${savedState.position.activeTpOrderId}`);
    }

    // Create fill ledger for order fill tracking
    fillLedger = createFillLedger(exchange);

    // Create WebSocket feed
    wsFeed = createWebSocketFeed(exchange, {
      productId,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      onTicker: handleTicker,
      onTrade: handleTrade,
      onOrderUpdate: handleOrderUpdate,
      onConnect: () => {
        isConnected = true;
        console.log(`📊 [${exchange}] Market data service connected`);
      },
      onDisconnect: () => {
        isConnected = false;
        console.log(`📊 [${exchange}] Market data service disconnected`);
      },
      onError: (error) => {
        console.log(`❌ [${exchange}] Market data service error: ${error.message}`);
      },
    });

    // Connect WebSocket
    wsFeed.connect();

    // Start periodic metrics update via REST (for ATR calculations)
    metricsUpdateInterval = setInterval(() => updateMetrics(adapter, productId), 60000);

    // Initial metrics fetch
    await updateMetrics(adapter, productId);

    console.log(`📊 [${exchange}] Market data service started for ${productId}`);
    return { success: true };
  };

  /**
   * Emit a throttled status update to the callback (for Socket.IO + chart buffer)
   */
  const emitStatus = () => {
    if (!onStatusUpdateCallback) return;
    const now = Date.now();
    if (now - lastStatusEmit < STATUS_EMIT_INTERVAL) return;
    lastStatusEmit = now;

    // Use cached regime state to avoid disk reads every second
    if (!cachedRegimeState || now - cachedRegimeStateTime > REGIME_STATE_CACHE_MS) {
      cachedRegimeState = loadRegimeState(exchange);
      cachedRegimeStateTime = now;
    }

    onStatusUpdateCallback({
      isRunning: false,
      market: getMarketState(),
      regime: getRegimeState(),
      position: cachedRegimeState?.position || null,
      health: { mode: 'STOPPED' },
      isDryRun: cachedRegimeState?.isDryRun || false,
    });
  };

  /**
   * Handle ticker updates
   */
  const handleTicker = (data) => {
    marketState.lastPrice = data.price;
    marketState.bid = data.bid;
    marketState.ask = data.ask;
    marketState.spread = data.ask - data.bid;
    marketState.lastUpdate = Date.now();

    // Add to price history
    priceHistory.push({
      price: data.price,
      timestamp: Date.now(),
    });

    // Trim history
    while (priceHistory.length > MAX_PRICE_HISTORY) {
      priceHistory.shift();
    }

    // Update regime detector with new price
    if (regimeDetector && marketState.atr1m > 0) {
      regimeDetector.update({
        lastPrice: data.price,
        atr1m: marketState.atr1m,
        realizedVol: marketState.realizedVol,
        volBaseline: marketState.volBaseline,
        vwapDistance: marketState.vwapDistance,
      });

      const mode = regimeDetector.getMode();
      if (mode !== regimeState.mode) {
        regimeState.mode = mode;
        regimeState.since = Date.now();
        regimeState.reason = `Detected via market data service`;
      }
    }

    // Push live data to UI + chart buffer
    emitStatus();
  };

  /**
   * Handle trade updates
   */
  const handleTrade = (data) => {
    // Could be used for volume tracking
  };

  /**
   * Handle order updates from WebSocket
   * Detects when tracked orders fill while engine isn't running
   */
  const handleOrderUpdate = async (data) => {
    const { orderId, status, filledSize, averageFilledPrice, totalFees } = data;

    // Check if this is a tracked order
    if (!trackedOrders.has(orderId)) {
      return;
    }

    const trackedOrder = trackedOrders.get(orderId);

    if (status === 'FILLED') {
      console.log(`✅ [${exchange}] Tracked order ${orderId} FILLED: ${filledSize} BTC @ $${averageFilledPrice}`);

      // Get fills for this order and ingest them
      const adapter = getAdapter(exchange);
      const fills = await adapter.getOrderFills(orderId).catch(() => []);

      // Pass placedAt for fill time tracking (only meaningful for buy orders)
      const orderPlacedAt = trackedOrder.type === 'entry' ? trackedOrder.placedAt : null;
      for (const fill of fills) {
        fillLedger.ingestFill(fill, orderPlacedAt);
      }
      fillLedger.persist();

      // Update tracked order status
      trackedOrder.status = 'filled';
      trackedOrder.filledSize = filledSize;
      trackedOrder.filledPrice = averageFilledPrice;
      trackedOrder.fees = totalFees;
      trackedOrder.filledAt = Date.now();

      // Notify external callback if set
      if (onOrderFillCallback) {
        onOrderFillCallback({
          orderId,
          type: trackedOrder.type,
          size: filledSize,
          price: averageFilledPrice,
          fees: totalFees,
          exchange,
        });
      }

      // Remove from tracked orders (keep in Map temporarily for status queries)
      setTimeout(() => trackedOrders.delete(orderId), 60000);
    } else if (status === 'CANCELLED' || status === 'FAILED') {
      console.log(`⚠️ [${exchange}] Tracked order ${orderId} ${status}`);
      trackedOrder.status = status.toLowerCase();
      setTimeout(() => trackedOrders.delete(orderId), 60000);
    }
  };

  /**
   * Update volatility metrics via REST API
   */
  const updateMetrics = async (adapter, productId) => {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const fourHoursAgo = now - 14400;

    let candles1m, candles5m;

    const [result1m, result5m] = await Promise.allSettled([
      adapter.getCandles(productId, oneHourAgo, now, 'ONE_MINUTE'),
      adapter.getCandles(productId, fourHoursAgo, now, 'FIVE_MINUTE'),
    ]);

    if (result1m.status === 'fulfilled' && result1m.value?.candles) {
      candles1m = result1m.value.candles;
    }
    if (result5m.status === 'fulfilled' && result5m.value?.candles) {
      candles5m = result5m.value.candles;
    }

    if (candles1m?.length > 0 || candles5m?.length > 0) {
      const metrics = calculateAllMetrics(candles1m || [], candles5m || [], marketState.lastPrice);

      marketState.atr1m = metrics.atr1m;
      marketState.atr5m = metrics.atr5m;
      marketState.realizedVol = metrics.realizedVol;
      marketState.volBaseline = metrics.volBaseline;
      marketState.vwap = metrics.vwap;
      marketState.vwapDistance = metrics.vwapDistance;
      marketState.recentSwing = metrics.recentSwing;
    }
  };

  /**
   * Stop the market data service
   */
  const stop = () => {
    if (metricsUpdateInterval) {
      clearInterval(metricsUpdateInterval);
      metricsUpdateInterval = null;
    }

    if (wsFeed) {
      wsFeed.disconnect();
      wsFeed = null;
    }

    isConnected = false;
    console.log(`📊 [${exchange}] Market data service stopped`);
  };

  /**
   * Get current market state
   */
  const getMarketState = () => ({
    ...marketState,
    connected: isConnected,
  });

  /**
   * Get current regime state
   */
  const getRegimeState = () => ({
    ...regimeState,
  });

  /**
   * Get full status
   */
  const getStatus = () => ({
    connected: isConnected,
    market: getMarketState(),
    regime: getRegimeState(),
    openOrders: getOpenOrders(),
  });

  /**
   * Get tracked open orders
   */
  const getOpenOrders = () => {
    const orders = [];
    for (const [orderId, order] of trackedOrders) {
      if (order.status === 'open') {
        orders.push({
          orderId,
          ...order,
        });
      }
    }
    return orders;
  };

  /**
   * Add an order to track
   */
  const trackOrder = (orderId, orderInfo) => {
    trackedOrders.set(orderId, {
      ...orderInfo,
      status: 'open',
    });
  };

  /**
   * Remove a tracked order
   */
  const untrackOrder = (orderId) => {
    trackedOrders.delete(orderId);
  };

  /**
   * Set callback for order fills
   */
  const setOnOrderFill = (callback) => {
    onOrderFillCallback = callback;
  };

  /**
   * Set callback for status updates (used by Socket.IO + chart buffer)
   */
  const setOnStatusUpdate = (callback) => {
    onStatusUpdateCallback = callback;
  };

  return {
    start,
    stop,
    getMarketState,
    getRegimeState,
    getStatus,
    isConnected: () => isConnected,
    getOpenOrders,
    trackOrder,
    untrackOrder,
    setOnOrderFill,
    setOnStatusUpdate,
  };
};

/**
 * Start market data service for an exchange
 */
const startMarketDataService = async (exchange) => {
  // Only supported for certain exchanges
  if (!SUPPORTED_EXCHANGES.includes(exchange)) {
    return { success: false, error: `Market data service not supported for ${exchange}` };
  }

  if (marketDataServices.has(exchange)) {
    return { success: true, message: 'Already running' };
  }

  const service = createMarketDataService(exchange);
  const result = await service.start();

  if (result.success) {
    marketDataServices.set(exchange, service);
  }

  return result;
};

/**
 * Stop market data service for an exchange
 */
const stopMarketDataService = (exchange) => {
  const service = marketDataServices.get(exchange);
  if (service) {
    service.stop();
    marketDataServices.delete(exchange);
  }
};

/**
 * Get market data service for an exchange
 */
const getMarketDataService = (exchange) => {
  return marketDataServices.get(exchange);
};

/**
 * Stop all market data services
 */
const stopAllMarketDataServices = () => {
  for (const [, service] of marketDataServices) {
    service.stop();
  }
  marketDataServices.clear();
};

module.exports = {
  createMarketDataService,
  startMarketDataService,
  stopMarketDataService,
  getMarketDataService,
  stopAllMarketDataServices,
};
