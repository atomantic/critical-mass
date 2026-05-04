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
const { getRegimeConfig, getFundConfig, getDefaultPair, getBaseCurrency } = require('./config-utils');
const { loadRegimeState, LIFECYCLE } = require('./state-tracker');
const { createFillLedger } = require('./fill-ledger');
const { fundKey } = require('./shared-utils');
const { calculateApyMetrics } = require('./apy-calculator');
const celestialHierarchy = require('./celestial-hierarchy');

// Store active market data services keyed by `${exchange}::${pair}`
const marketDataServices = new Map();

// Only Coinbase is supported for WebSocket market data (other exchanges have different APIs)
const SUPPORTED_EXCHANGES = ['coinbase', 'cryptocom', 'gemini'];

const serviceKey = (exchange, pair) => fundKey(exchange, pair || getDefaultPair(exchange) || 'default');

/**
 * Create a market data service for a fund (exchange + pair).
 * Each fund needs its own service because the WebSocket feed subscribes to a
 * single product per connection.
 * @param {string} exchange - Exchange name
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {Object} Market data service instance
 */
const createMarketDataService = (exchange, pair) => {
  const resolvedPair = pair || getDefaultPair(exchange);
  let wsFeed = null;
  let regimeDetector = null;
  let fillLedger = null;
  let isConnected = false;
  let metricsUpdateInterval = null;
  let productId = null;
  let onStatusUpdateCallback = null;
  let lastStatusEmit = 0;
  const STATUS_EMIT_INTERVAL = 1000; // Throttle to ~1/sec to match chart buffer rate

  // Cache for regime state to avoid disk reads every second
  let cachedRegimeState = null;
  let cachedRegimeStateTime = 0;
  const REGIME_STATE_CACHE_MS = 10_000; // Reload from disk at most every 10s

  // Trade flow tracking — rolling window of recent trades for imbalance calculation
  const tradeFlowWindow = [] // { price, size, side, timestamp }
  const TRADE_FLOW_MAX_AGE_MS = 300_000 // 5 minutes

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
  // Orders the WS feed has already confirmed settled (filled/cancelled).
  // Persisted in-memory for the life of the process so a cache reload can't
  // resurrect a stale tpOrderId from disk after the 60s trackedOrders TTL —
  // the engine, while running, would have rewritten regime-state, but if it's
  // stopped that orderId still appears in disk state and would otherwise come
  // back as 'open' on the next refresh.
  const settledOrderIds = new Set();
  let onOrderFillCallback = null; // External callback for when orders fill

  // Pre-populate trackedOrders from a position (called at startup and on
  // every cache reload) so the WS feed can detect fills/cancels for every
  // persisted live order — TPs (sell), pending entries (buy), and ladder
  // entries (buy) — while the engine is stopped. Skips anything already
  // seen settled.
  const trackTpFromPosition = (pos) => {
    if (pos?.activeTpOrderId && !trackedOrders.has(pos.activeTpOrderId) && !settledOrderIds.has(pos.activeTpOrderId)) {
      trackedOrders.set(pos.activeTpOrderId, {
        type: 'take_profit',
        price: pos.lastTpPrice || 0,
        size: pos.assetOnOrder || pos.totalAsset || 0,
        placedAt: pos.lastEntryTime || Date.now(),
        status: 'open',
      });
      console.log(`📋 [${exchange}] Market data service tracking core TP: ${pos.activeTpOrderId}`);
    }
    for (const body of (pos?.celestialBodies || [])) {
      if (!body.tpOrderId || trackedOrders.has(body.tpOrderId) || settledOrderIds.has(body.tpOrderId)) continue;
      trackedOrders.set(body.tpOrderId, {
        type: 'body_tp',
        price: body.tpPrice || 0,
        size: body.assetOnOrder || body.assetQty || 0,
        placedAt: body.lastMergedAt || body.createdAt || Date.now(),
        status: 'open',
        bodyId: body.id,
      });
    }
    const trackEntries = (entries, type) => {
      for (const e of (entries || [])) {
        if (!e.orderId || trackedOrders.has(e.orderId) || settledOrderIds.has(e.orderId)) continue;
        trackedOrders.set(e.orderId, {
          type,
          price: e.price || 0,
          size: e.assetQty || 0,
          sizeUsdc: e.sizeUsdc,
          placedAt: e.placedAt || Date.now(),
          status: 'open',
        });
      }
    };
    trackEntries(pos?.pendingEntryOrders, 'entry');
    trackEntries(pos?.pendingLadderOrders, 'ladder_entry');
  };

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

    const config = getRegimeConfig(exchange, resolvedPair);
    const fundConfig = getFundConfig(exchange, resolvedPair);
    productId = fundConfig.productId || resolvedPair || 'BTC-USDC';

    // Create regime detector for passive monitoring
    regimeDetector = createRegimeDetector(exchange, config);

    // Load any tracked orders from saved regime state.
    const savedState = loadRegimeState(exchange, resolvedPair);
    trackTpFromPosition(savedState.position);
    const bodyTpCount = (savedState.position?.celestialBodies || []).filter(b => b.tpOrderId).length;
    if (bodyTpCount > 0) console.log(`📋 [${exchange}] Market data service tracking ${bodyTpCount} body TP(s)`);

    // Create fill ledger for order fill tracking
    fillLedger = createFillLedger(exchange, productId, resolvedPair);

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
    if (metricsUpdateInterval) {
      clearInterval(metricsUpdateInterval);
    }
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
      cachedRegimeState = loadRegimeState(exchange, resolvedPair);
      cachedRegimeStateTime = now;
      // Pick up any new body TPs created since startup so the WS feed can
      // detect their fills/cancels while the engine is stopped.
      trackTpFromPosition(cachedRegimeState?.position);
    }

    // Synthesize persisted TPs + the same enrichment fields the running
    // engine emits (apy, lifecycle, celestial summary) so a hard refresh
    // while the engine is stopped doesn't lose APY/capital sections or
    // misreport celestial as off between cycles. Each tick from this
    // service overwrites socketStatus, so the payload must be shape-
    // compatible with the running-engine status.
    const position = cachedRegimeState?.position || null;
    const bodies = position?.celestialBodies || [];
    const config = getRegimeConfig(exchange, resolvedPair);
    const market = getMarketState();
    // Drop persisted TPs the WS feed has already confirmed are no longer open
    // (filled/cancelled while the engine was stopped) — the engine can't
    // refresh state until it restarts, but we should not show phantom rows.
    const pendingOrders = celestialHierarchy.buildPersistedPendingOrders(position, getOrderStatus);

    onStatusUpdateCallback({
      isRunning: false,
      market,
      regime: getRegimeState(),
      position,
      pendingOrders,
      apy: position ? calculateApyMetrics(position, config, { lastPrice: market?.lastPrice || 0 }) : {},
      lifecycle: {
        lifecycle: position?.lifecycle || LIFECYCLE.ACTIVE,
        lifecycleChangedAt: position?.lifecycleChangedAt || null,
        lifecycleReason: position?.lifecycleReason || null,
        lifecycleClosedCycle: position?.lifecycleClosedCycle || null,
      },
      celestial: celestialHierarchy.buildCelestialPayload(position, config),
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
   * Handle trade updates — accumulate into rolling window for buy/sell imbalance
   */
  const handleTrade = (data) => {
    if (!data?.price || !data?.size || !data?.side) return

    const now = Date.now()
    tradeFlowWindow.push({
      price: data.price,
      size: parseFloat(data.size),
      side: data.side, // 'buy' or 'sell' (taker side)
      timestamp: now,
    })

    // Prune entries older than 5 minutes
    while (tradeFlowWindow.length > 0 && tradeFlowWindow[0].timestamp < now - TRADE_FLOW_MAX_AGE_MS) {
      tradeFlowWindow.shift()
    }
  };

  /**
   * Handle order updates from WebSocket
   * Detects when tracked orders fill while engine isn't running
   */
  const handleOrderUpdate = async (data) => {
    if (!productId) return;
    const { orderId, status, filledSize, averageFilledPrice, totalFees } = data;

    // Check if this is a tracked order
    if (!trackedOrders.has(orderId)) {
      return;
    }

    const trackedOrder = trackedOrders.get(orderId);

    if (status === 'FILLED') {
      const baseCurr = getBaseCurrency(productId);
      console.log(`✅ [${exchange}] Tracked order ${orderId} FILLED: ${filledSize} ${baseCurr} @ $${averageFilledPrice}`);

      // Get fills for this order and ingest them. Track failure separately
      // so we can avoid permanently marking the order settled when the
      // adapter call failed — otherwise a transient API hiccup would drop
      // the row from pendingOrders without ever updating the ledger
      // linkage, recreating the orphaned-buy symptom until engine restart.
      const adapter = getAdapter(exchange);
      let fillsFetched = false;
      let fills = [];
      try {
        fills = await adapter.getOrderFills(orderId);
        fillsFetched = true;
      } catch (err) {
        console.log(`⚠️ [${exchange}] Failed to fetch fills for ${orderId}: ${err.message} — will retry on next update`);
      }

      // On transient adapter failure, do not flip the in-memory status to
      // 'filled' — getOrderStatus() would then report the order as no
      // longer open, the offline synthesizer would drop it, and the
      // ledger/linkage would never be written until engine restart.
      // Leave status='open' so the WS gives us another shot on the next
      // OrderUpdate event for this orderId.
      if (!fillsFetched) return;

      // Pass placedAt for fill time tracking (only meaningful for buy orders)
      const orderPlacedAt = trackedOrder.type === 'entry' ? trackedOrder.placedAt : null;
      for (const fill of fills) {
        fillLedger.ingestFill(fill, orderPlacedAt);
      }
      if (fills.length > 0) fillLedger.persist();

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

      // Mark settled and prune from trackedOrders (the settledOrderIds set
      // outlives the 60s TTL so cache reloads can't resurrect this order).
      settledOrderIds.add(orderId);
      setTimeout(() => trackedOrders.delete(orderId), 60000);
    } else if (status === 'CANCELLED' || status === 'FAILED') {
      console.log(`⚠️ [${exchange}] Tracked order ${orderId} ${status}`);
      trackedOrder.status = status.toLowerCase();
      settledOrderIds.add(orderId);
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
   * Compute trade flow imbalance for a given time window
   * @param {number} windowMs - Window size in milliseconds
   * @returns {{ buyVolume: number, sellVolume: number, imbalance: number, tradeCount: number }}
   */
  const computeTradeFlow = (windowMs) => {
    const cutoff = Date.now() - windowMs
    let buyVolume = 0
    let sellVolume = 0
    let tradeCount = 0

    for (let i = tradeFlowWindow.length - 1; i >= 0; i--) {
      const t = tradeFlowWindow[i]
      if (t.timestamp < cutoff) break
      if (t.side === 'buy') buyVolume += t.size
      else sellVolume += t.size
      tradeCount++
    }

    const total = buyVolume + sellVolume
    const imbalance = total > 0 ? (buyVolume - sellVolume) / total : 0
    return { buyVolume, sellVolume, imbalance, tradeCount }
  }

  /**
   * Get current market state
   */
  const getMarketState = () => {
    const flow60 = computeTradeFlow(60_000)
    const flow300 = computeTradeFlow(300_000)

    return {
      ...marketState,
      connected: isConnected,
      tradeFlow: {
        imbalance60s: flow60.imbalance,
        imbalance300s: flow300.imbalance,
        buyVolume60s: flow60.buyVolume,
        sellVolume60s: flow60.sellVolume,
        tradeCount60s: flow60.tradeCount,
        updatedAt: Date.now(),
      },
    }
  };

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
   * Look up a tracked order's status without filtering on 'open'. Returns
   * the status string ('open' / 'filled' / 'cancelled' / etc.) or null if
   * the order isn't tracked at all. Used by stopped-engine status
   * synthesizers to drop persisted TPs that the WS feed has already
   * confirmed are no longer open. Consults settledOrderIds so the
   * filter still works after the 60s trackedOrders cleanup fires.
   */
  const getOrderStatus = (orderId) => {
    const o = trackedOrders.get(orderId);
    if (o) return o.status;
    if (settledOrderIds.has(orderId)) return 'settled';
    return null;
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
    getOrderStatus,
    trackOrder,
    untrackOrder,
    setOnOrderFill,
    setOnStatusUpdate,
  };
};

/**
 * Start market data service for a fund (exchange + pair).
 * @param {string} exchange
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 */
const startMarketDataService = async (exchange, pair) => {
  // Only supported for certain exchanges
  if (!SUPPORTED_EXCHANGES.includes(exchange)) {
    return { success: false, error: `Market data service not supported for ${exchange}` };
  }

  const key = serviceKey(exchange, pair);
  if (marketDataServices.has(key)) {
    return { success: true, message: 'Already running' };
  }

  const service = createMarketDataService(exchange, pair);
  const result = await service.start();

  if (result.success) {
    marketDataServices.set(key, service);
  }

  return result;
};

/**
 * Stop market data service for a fund (exchange + pair).
 */
const stopMarketDataService = (exchange, pair) => {
  const key = serviceKey(exchange, pair);
  const service = marketDataServices.get(key);
  if (service) {
    service.stop();
    marketDataServices.delete(key);
  }
};

/**
 * Get market data service for a fund (exchange + pair).
 */
const getMarketDataService = (exchange, pair) => {
  return marketDataServices.get(serviceKey(exchange, pair));
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
