// @ts-check
const { trackPendingWrite } = require('./pending-writes');
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
 *
 * This file is the passive ticker / metrics service and its wiring. The rest
 * lives beside it and is re-exported from here: order-mailbox.js (timer
 * tracker, order mailbox), stopped-fund-order-tracker.js (fill ingestion,
 * cancelled-order settlement, order retry chains) and
 * market-data-registry.js (one service per fund; start / stop / fence).
 */

const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { applyMarketMetrics } = require('./volatility-utils');
const { getAdapter, isSupported } = require('./adapters');
const { createHealthMonitor, instrumentAdapterForHealth } = require('./health-monitor');
const { getRegimeConfig, getFundConfig, getDefaultPair } = require('./config-utils');
const { loadFundRegimeState, evictFundRegimeStateReadOnly } = require('./regime-state-store');
const { createFillLedger } = require('./fill-ledger');
const { fundKey } = require('./shared-utils');
const { buildStoppedRegimeStatus } = require('./regime-status');
const { createContextLogger } = require('./logger');
const { createMarketDataRegistry } = require('./market-data-registry');
const { createTimerTracker, createOrderMailbox, ORDER_CONSUMER_CONCURRENCY } = require('./order-mailbox');
const {
  createStoppedFundOrderTracker, ingestNewFillsForOrder, INGEST_RETRY_REASON, settleCancelledOrder,
} = require('./stopped-fund-order-tracker');

/** Interval between periodic REST metrics updates (ms) */
const METRICS_INTERVAL_MS = 60000;

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
  let logger = createContextLogger({ exchange, pair: resolvedPair });
  let wsFeed = null;
  let regimeDetector = null;
  let fillLedger = null;
  // Created in start() once config is available; instruments getActiveAdapter()'s
  // REST calls (issue #228). Null until start() runs, or until a test injects
  // one via _test.injectHealthMonitor — instrumentAdapterForHealth no-ops when
  // this is null, so pre-start adapter calls (if any) pass through unwrapped.
  let healthMonitor = null;
  let isConnected = false;
  let metricsUpdateInterval = null;
  /** @type {Promise<void> | null} */
  let metricsInFlight = null;
  let productId = null;
  let onStatusUpdateCallback = null;
  let lastStatusEmit = 0;
  const STATUS_EMIT_INTERVAL = 1000; // Throttle to ~1/sec to match chart buffer rate

  // Cache for regime state to avoid disk reads every second
  let cachedRegimeState = null;
  let cachedRegimeStateTime = 0;
  const REGIME_STATE_CACHE_MS = 10_000; // Reload from disk at most every 10s
  // Last status-synthesis failure, so an unreadable state file logs once
  // rather than on every tick.
  let statusEmitError = null;

  // Trade flow tracking — rolling window of recent trades for imbalance calculation
  let tradeFlowWindow = [] // { price, size, side, timestamp }
  let tradeFlowHead = 0
  const TRADE_FLOW_COMPACT_MIN = 4096
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
    momentum: { magnitude: 0, direction: 'neutral' },
    // 24h rolling volume from the ticker feed (issue #202) — always 0 before.
    volume24h: 0,
    lastUpdate: 0,
  };

  // Regime state
  const regimeState = {
    mode: 'HARVEST',
    since: Date.now(),
    reason: 'Initial state',
  };

  // Price history for calculations
  const priceHistory = [];
  const MAX_PRICE_HISTORY = 300; // 5 minutes of tick data

  /**
   * Start the market data service
   */
  const start = async () => {
    // Initialize the fill ledger BEFORE credentials/config — createFillLedger
    // auto-loads from disk and throws on cold-start corruption (refuses to
    // boot empty so a subsequent persist can't overwrite a recoverable file
    // with only post-start fills). Surfacing that as {success:false} early
    // lets callers like the regime:stop IPC handler decide whether to
    // proceed without WS handover. There is no point authenticating if we
    // can't read the ledger anyway, and front-loading the throw makes the
    // failure path testable without mocking credentials.
    const fundConfig = getFundConfig(exchange, resolvedPair);
    productId = fundConfig.productId || resolvedPair || 'BTC-USDC';
    logger = createContextLogger({ exchange, pair: resolvedPair || productId });
    try {
      fillLedger = createFillLedger(exchange, productId, resolvedPair);
    } catch (err) {
      // Log full detail (absolute path + parser error) server-side; return
      // a sanitized message to the IPC client (regime:stop relays this
      // back to the operator) so filesystem internals stay in engine logs.
      logger.warn(`⚠️ [${exchange}] Market data service: Fill ledger init failed: ${err.message}`, {
        error: err.message,
      });
      return { success: false, error: `Fill ledger init failed for ${exchange}/${resolvedPair} — see engine logs for details` };
    }

    // load() guesses the current cycle as the latest one with sells < buys, but
    // holdback leaves every finished cycle in that state — so after a cycle
    // closes (or an operator reset) it would pick the finished cycle and file
    // fills recorded while stopped there. Anchor on the persisted boundary the
    // engine itself restores at boot (regime-engine restorePersistedCycleId).
    const persistedPosition = loadFundRegimeState(exchange, resolvedPair)?.position;
    const persistedCycleId = persistedPosition?.activeCycleId;
    if (typeof persistedCycleId === 'string' && /^cycle-\d+$/.test(persistedCycleId)) {
      fillLedger.setCurrentCycleId(persistedCycleId, persistedPosition.activeCycleStartedAt ?? null);
    }

    // Create the health monitor BEFORE the first adapter call so
    // getActiveAdapter() (used below and by every REST call site) wraps the
    // adapter with REST error/rate-limit/latency instrumentation from the
    // start (issue #228 — mirrors regime-engine.js's instrumentAdapterForHealth
    // wiring, which previously only covered the live regime engine).
    const config = getRegimeConfig(exchange, resolvedPair);
    healthMonitor = createHealthMonitor(exchange, config);

    const adapter = getActiveAdapter();

    // Try to load credentials with error handling
    let credentials;
    try {
      credentials = adapter.loadCredentials();
    } catch (err) {
      logger.warn(`⚠️ [${exchange}] Market data service: Failed to load credentials: ${err.message}`, {
        error: err.message,
      });
      return { success: false, error: err.message };
    }

    if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
      logger.warn(`⚠️ [${exchange}] Market data service: No API credentials, skipping`, {
        reason: 'missing_credentials',
      });
      return { success: false, error: 'No API credentials' };
    }

    // Create regime detector for passive monitoring
    regimeDetector = createRegimeDetector(exchange, config, {}, resolvedPair || productId);

    // Load any tracked orders from saved regime state.
    const savedState = loadFundRegimeState(exchange, resolvedPair);
    trackPersistedOrders(savedState.position);
    const bodyTpCount = (savedState.position?.celestialBodies || []).filter(b => b.tpOrderId).length;
    if (bodyTpCount > 0) {
      logger.info(`📋 [${exchange}] Market data service tracking ${bodyTpCount} body TP(s)`, {
        orderType: 'body_tp',
        orderCount: bodyTpCount,
      });
    }

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
        logger.info(`📊 [${exchange}] Market data service connected`);
      },
      onDisconnect: () => {
        isConnected = false;
        logger.info(`📊 [${exchange}] Market data service disconnected`);
      },
      onError: (error) => {
        logger.error(`❌ [${exchange}] Market data service error: ${error.message}`, {
          error: error.message,
        });
      },
    });

    // Connect WebSocket
    wsFeed.connect();

    // Start periodic metrics update via REST (for ATR calculations)
    if (metricsUpdateInterval) {
      clearInterval(metricsUpdateInterval);
    }
    // A stalled exchange can outlast the interval (each candle request may take
    // minutes with retries), so a run in flight is shared, never stacked.
    const runMetrics = () => {
      if (metricsInFlight) return metricsInFlight;
      const run = updateMetrics(adapter, productId).finally(() => {
        if (metricsInFlight === run) metricsInFlight = null;
      });
      metricsInFlight = run;
      return run;
    };
    // updateMetrics is async; guard the interval callback so an unhandled
    // rejection (e.g. a throw inside calculateAllMetrics) can't crash the process.
    metricsUpdateInterval = setInterval(() => {
      if (metricsInFlight) return;
      trackPendingWrite(`market-metrics:${serviceKey(exchange, resolvedPair)}`, runMetrics).catch((err) =>
        logger.error(`❌ [${exchange}] Metrics update failed: ${err.message}`, {
          error: err.message,
        })
      );
    }, METRICS_INTERVAL_MS);

    // Initial metrics fetch
    await runMetrics();
    // A stop that landed during the fetch fenced this service: it must not
    // touch the ledger again, not even to recover the handover gap below.
    if (timerTracker.isStopped()) return { success: false, error: 'stopped during start' };

    const gapRecovery = await recoverHandoverGap();

    logger.info(`📊 [${exchange}] Market data service started for ${productId}`, {
      productId,
    });
    return { success: true, gapRecovery };
  };

  /**
   * Emit a throttled status update to the callback (for the realtime bus + chart buffer)
   */
  const emitStatus = () => {
    if (!onStatusUpdateCallback) return;
    const now = Date.now();
    if (now - lastStatusEmit < STATUS_EMIT_INTERVAL) return;
    lastStatusEmit = now;

    // Use cached regime state to avoid disk reads every second — only for
    // seeding trackPersistedOrders (new body TPs created since startup so
    // the WS feed can detect their fills/cancels while the engine is
    // stopped). Status synthesis below always re-reads via
    // buildStoppedRegimeStatus so lifecycle/P&L changes (e.g. an operator
    // edit, or another process closing the fund) aren't held stale for up
    // to REGIME_STATE_CACHE_MS.
    //
    // Delegate to the shared stopped/offline status synthesizer (issue #357)
    // so this socket stream re-derives realizedPnL / realizedAssetPnL /
    // heldAssetCostBasis from the fill ledger on every tick, the same as
    // the engine's own IPC handler and the HTTP gateway fallback — previously
    // this path broadcast the un-rederived persisted position, drifting from
    // the other two enrichment paths. Drops persisted TPs the WS feed has
    // already confirmed are no longer open (filled/cancelled while the
    // engine was stopped) via getOrderStatus — the engine can't refresh
    // state until it restarts, but we should not show phantom rows.
    //
    // This runs inside the WebSocket message listener, where a throw is an
    // uncaughtException that exits the whole engine process — every fund on
    // it, not just this stopped one. A corrupt regime-state.json (it throws by
    // design, issue #108) must only pause this fund's stopped-status stream.
    let status;
    try {
      if (!cachedRegimeState || now - cachedRegimeStateTime > REGIME_STATE_CACHE_MS) {
        cachedRegimeState = loadFundRegimeState(exchange, resolvedPair);
        cachedRegimeStateTime = now;
        trackPersistedOrders(cachedRegimeState?.position);
      }
      status = buildStoppedRegimeStatus(exchange, resolvedPair, {
        market: getMarketState(),
        regime: getRegimeState(),
        getOrderStatus,
        mode: 'STOPPED',
      });
    } catch (err) {
      cachedRegimeState = null;
      if (statusEmitError === err.message) return;
      statusEmitError = err.message;
      logger.error(`❌ [${exchange}] Stopped-fund status unavailable, live status updates paused until it loads: ${err.message}`, {
        action: 'emit-status',
        error: err.message,
      });
      return;
    }
    statusEmitError = null;
    if (status) onStatusUpdateCallback(status);
  };

  /**
   * Handle ticker updates
   */
  const handleTicker = (data) => {
    marketState.lastPrice = data.price;
    marketState.bid = data.bid;
    marketState.ask = data.ask;
    marketState.spread = data.ask - data.bid;
    // Carry 24h rolling volume through to consumers (issue #202). WS feeds emit
    // it; nullish-coalesce so a feed without it keeps the prior value.
    marketState.volume24h = data.volume24h ?? marketState.volume24h;
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

    // Classify regime with the latest price + metrics. Same call shape as
    // the live engine (regime-engine.js updateMetrics): classify(marketState)
    // reads lastPrice/atr1m/realizedVol/volBaseline/vwap directly.
    if (regimeDetector && marketState.atr1m > 0) {
      regimeDetector.classify(marketState);

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

    // Consume the expired prefix without reindexing the live tail per trade.
    while (tradeFlowHead < tradeFlowWindow.length && tradeFlowWindow[tradeFlowHead].timestamp < now - TRADE_FLOW_MAX_AGE_MS) {
      tradeFlowHead++
    }
    // Copy only after enough expirations can pay for the remaining live rows.
    // Between compactions, stale storage is below 4096 rows or below live size.
    if (tradeFlowHead >= TRADE_FLOW_COMPACT_MIN && tradeFlowHead * 2 >= tradeFlowWindow.length) {
      tradeFlowWindow = tradeFlowWindow.slice(tradeFlowHead)
      tradeFlowHead = 0
    }
  };

  // Allows tests to substitute a fake adapter without monkey-patching
  // the require cache (market-data-service destructures getAdapter at
  // module load, so cache patches arrive too late).
  let _adapterOverride = null;
  // Every call site goes through this getter (start()'s initial adapter,
  // ingestNewFillsForOrder's ingestDeps, retry chains, cancel catch-up), so
  // wrapping here instruments the full set of REST call sites in one place
  // (issue #228) rather than at each individual call. instrumentAdapterForHealth
  // no-ops (returns the adapter unwrapped) when healthMonitor is still null
  // (pre-start, or in tests that don't inject one).
  const getActiveAdapter = () => instrumentAdapterForHealth(_adapterOverride || getAdapter(exchange), healthMonitor);

  // Tracked orders, stopped-fund fill ingestion and the order retry chains
  // (stopped-fund-order-tracker). logger, fillLedger and productId go in as
  // accessors because start() and the _test injectors reassign them.
  const {
    trackedOrders, timerTracker, orderMailbox,
    pendingTerminalRetries, pendingPartialRetries,
    trackPersistedOrders, recoverHandoverGap, handleOrderUpdate,
    getOpenOrders, getOrderStatus, trackOrder, untrackOrder,
  } = createStoppedFundOrderTracker({
    exchange,
    resolvedPair,
    getLogger: () => logger,
    getFillLedger: () => fillLedger,
    getProductId: () => productId,
    getActiveAdapter,
  });

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

    // Adapters return a bare Candle[] array (coinbase/gemini/cryptocom),
    // not a { candles } wrapper.
    if (result1m.status === 'fulfilled' && Array.isArray(result1m.value)) {
      candles1m = result1m.value;
    }
    if (result5m.status === 'fulfilled' && Array.isArray(result5m.value)) {
      candles5m = result5m.value;
    }

    const config = getRegimeConfig(exchange, resolvedPair);
    applyMarketMetrics(marketState, candles1m, candles5m, config);
  };

  /**
   * Stop the market data service
   */
  const stop = () => {
    if (metricsUpdateInterval) {
      clearInterval(metricsUpdateInterval);
      metricsUpdateInterval = null;
    }
    // A later start() must fetch with its own adapter, not join this run.
    metricsInFlight = null;

    if (wsFeed) {
      wsFeed.disconnect();
      wsFeed = null;
    }

    // Cancel any pending cancel-retry / untrack timers so they can't fire
    // against this service's now-stale fillLedger after a replacement
    // service has taken over and overwrite its writes.
    timerTracker.cancelAll();
    // Drop pending order work and settle its callers; an in-flight pass
    // settles its key (and pending-writes entry) once its await returns.
    orderMailbox.stop();

    // This service is stopped when the fund's engine takes over (regime:start
    // handover) or the fund is torn down, so this is the "starts running"
    // eviction point. A removed fund's entry also self-evicts: the next
    // lookup stats a missing file and deletes it. Either way the map stays at
    // one entry per fund file.
    evictFundRegimeStateReadOnly(exchange, resolvedPair);

    isConnected = false;
    logger.info(`📊 [${exchange}] Market data service stopped`);
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

    for (let i = tradeFlowWindow.length - 1; i >= tradeFlowHead; i--) {
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
   * Set callback for status updates (used by the realtime bus + chart buffer)
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
    setOnStatusUpdate,
    // Health state (issue #228) — null until start() creates the monitor (or
    // a test injects one via _test.injectHealthMonitor).
    // `userChannel` ('subscribed' | 'degraded' | null when not configured)
    // surfaces lost real-time fill detection on the user channel (issue #1382).
    getHealthState: () => (healthMonitor
      ? { ...healthMonitor.getState(), userChannel: wsFeed?.getStatus?.().userChannel ?? null }
      : null),
    // Resolves once order work accepted before stop() has finished. Queued
    // work re-checks the stopped flag after every await, so after stop()
    // this only waits out REST calls already in flight.
    whenIdle: orderMailbox.whenIdle,
    // Test hooks. Expose enough surface to drive processOrderUpdate
    // through a real factory instance without spinning up the WS feed.
    _test: {
      handleOrderUpdate,
      handleTicker,
      handleTrade,
      computeTradeFlow,
      getTradeFlowStorage: () => ({
        head: tradeFlowHead,
        backingLength: tradeFlowWindow.length,
        rows: tradeFlowWindow.slice(tradeFlowHead),
      }),
      updateMetrics,
      marketState,
      regimeState,
      injectFillLedger: (ledger) => { fillLedger = ledger; },
      injectProductId: (id) => { productId = id; },
      injectAdapter: (a) => { _adapterOverride = a; },
      injectRegimeDetector: (d) => { regimeDetector = d; },
      injectHealthMonitor: (hm) => { healthMonitor = hm; },
      injectWsFeed: (feed) => { wsFeed = feed; },
      getActiveAdapter,
      trackedOrders,
      pendingTerminalRetries,
      pendingPartialRetries,
      timerTracker,
      orderMailbox,
    },
  };
};

// The registry (one service per fund, start / stop / fence) is built once per
// load of this module and re-exported, so callers and test stubs keep one
// module to import from.
const {
  getActiveMarketDataFunds, drainMarketDataStarts,
  startMarketDataService, stopMarketDataService, fenceMarketDataService,
  getMarketDataService, stopAllMarketDataServices,
} = createMarketDataRegistry({ createMarketDataService, isSupported, serviceKey });

module.exports = {
  createMarketDataService,
  getActiveMarketDataFunds,
  drainMarketDataStarts,
  startMarketDataService,
  stopMarketDataService,
  fenceMarketDataService,
  getMarketDataService,
  stopAllMarketDataServices,
  ingestNewFillsForOrder,
  INGEST_RETRY_REASON,
  settleCancelledOrder,
  createTimerTracker,
  createOrderMailbox,
  ORDER_CONSUMER_CONCURRENCY,
};
