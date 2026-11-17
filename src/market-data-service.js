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
 */

const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { applyMarketMetrics } = require('./volatility-utils');
const { getAdapter, isSupported } = require('./adapters');
const { createHealthMonitor, instrumentAdapterForHealth } = require('./health-monitor');
const { getRegimeConfig, getFundConfig, getDefaultPair } = require('./config-utils');
const { loadFundRegimeState } = require('./regime-state-store');
const { createFillLedger } = require('./fill-ledger');
const { fundKey } = require('./shared-utils');
const { buildStoppedRegimeStatus } = require('./regime-status');
const { createContextLogger } = require('./logger');
const { createTimerTracker, createOrderMailbox, ORDER_CONSUMER_CONCURRENCY } = require('./order-mailbox');
const {
  createStoppedFundOrderTracker, ingestNewFillsForOrder, INGEST_RETRY_REASON, settleCancelledOrder,
} = require('./stopped-fund-order-tracker');

// Store active market data services keyed by `${exchange}::${pair}`
const marketDataServices = new Map();

// In-flight start() promises keyed the same way. startMarketDataService does a
// check-then-await-then-set, so two overlapping calls (e.g. the engine startup
// loop's fire-and-forget start vs the regime:stop handler's start) could both
// pass the has() check and both create a service — the loser overwritten in the
// map and leaked forever (live WS feed + 60s interval + a second fillLedger
// whose persist() fights the winner). De-duping on this map closes the gap.
const startingMarketDataServices = new Map();

// Monotonic per-key cancellation counter (issue #415). stopMarketDataService /
// stopAllMarketDataServices are synchronous — their callers (the engine's
// lifecycle-close callback, the regime:start handover, the SIGTERM path) can't
// await — so they cannot wait for an in-flight start to settle. Instead they
// bump the generation for the key; a start that finds the generation moved
// since it began knows a stop raced it, tears its own service down and never
// registers it. Without this, a stop issued inside the seconds-long start()
// window (WS connect + REST candle fetch) is a silent no-op and the fund ends
// up with two fill-ledger writers on the same file, each persist() erasing the
// other's ingested fills. Never deleted: resetting a key's generation could
// un-cancel a start still in flight, and the key set is bounded by fund count.
const stopGenerations = new Map();

/**
 * Cancel any in-flight start for this key.
 * @param {string} key
 */
const bumpStopGeneration = (key) => {
  stopGenerations.set(key, (stopGenerations.get(key) || 0) + 1);
};

// Stopped services whose accepted order work may still be finishing, keyed
// the same way (issue #1008). stop() fences new ledger writes immediately,
// but a REST fetch already in flight settles later; fenceMarketDataService
// joins these before a replacement writer may load the ledger.
const retiringServices = new Map();

/**
 * Stop a service and keep it joinable until its order work has drained.
 * @param {string} key
 * @param {Object} service
 */
const retireService = (key, service) => {
  service.stop?.();
  if (!service.whenIdle) return;
  if (!retiringServices.has(key)) retiringServices.set(key, new Set());
  const retiring = retiringServices.get(key);
  retiring.add(service);
  service.whenIdle().finally(() => {
    retiring.delete(service);
    if (!retiring.size && retiringServices.get(key) === retiring) retiringServices.delete(key);
  });
};

/** Default bound for a writer-handover join; matches the engine write drain. */
const FENCE_TIMEOUT_MS = 30_000;

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

/**
 * Start market data service for a fund (exchange + pair).
 * @param {string} exchange
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 */
const startMarketDataService = async (exchange, pair) => {
  // Only supported for certain exchanges
  if (!isSupported(exchange)) {
    return { success: false, error: `Market data service not supported for ${exchange}` };
  }

  const key = serviceKey(exchange, pair);
  if (marketDataServices.has(key)) {
    return { success: true, message: 'Already running' };
  }
  // Generation this start is bound to. If a stop bumps it before start()
  // settles, the service below is torn down instead of registered.
  const gen = stopGenerations.get(key) || 0;
  // Coalesce concurrent starts onto a single in-flight promise so the
  // check-then-act window can't spawn two services for the same fund — but
  // never onto a start a stop has already cancelled: that one resolves
  // {success:false} and registers nothing, so coalescing onto it would leave
  // the fund with no market data service at all (the regime:stop → start
  // handover does exactly stop-then-start on one key). Starting fresh is safe
  // because the cancelled start stops its own service and never publishes it.
  const inFlight = startingMarketDataServices.get(key);
  if (inFlight && inFlight.gen === gen) {
    return inFlight.promise;
  }

  // service.start() → createFillLedger → load() can throw on cold-start
  // corruption. The throw happens inside start(), not the factory — so
  // the wrap inside start() converts it to a {success:false} return
  // (see "Create fill ledger" in start()). Callers (notably the
  // regime:stop IPC handler that starts a standalone service for
  // handover) get a graceful failure they can decide on instead of an
  // unhandled rejection that aborts their flow.
  const service = createMarketDataService(exchange, pair);
  const startPromise = (async () => {
    const result = await service.start();
    if (!result.success) {
      // Failed start must not leak its WS feed / interval timers.
      retireService(key, service);
      return result;
    }
    if ((stopGenerations.get(key) || 0) !== gen) {
      // A stop landed while we were connecting. Tear this service down and
      // leave the settled map untouched — publishing it now would hand the
      // fund a second fill-ledger writer nothing can reach to stop again.
      retireService(key, service);
      return { success: false, error: 'stopped during start' };
    }
    marketDataServices.set(key, service);
    return result;
  })().finally(() => {
    // Only clear our own entry: a cancelled start can be superseded by a
    // newer one for the same key while it is still settling.
    if (startingMarketDataServices.get(key)?.promise === startPromise) {
      startingMarketDataServices.delete(key);
    }
  });

  startingMarketDataServices.set(key, { promise: startPromise, gen, service });
  return startPromise;
};

/**
 * Stop market data service for a fund (exchange + pair). Also cancels a start
 * still in flight for that fund, so the service it is building is torn down
 * rather than registered after this returns (issue #415).
 */
const stopMarketDataService = (exchange, pair) => {
  const key = serviceKey(exchange, pair);
  // Bump unconditionally: the settled map can be empty while a start is still
  // connecting, and the generation is the only way that start learns it lost.
  bumpStopGeneration(key);
  // Stop a still-connecting service now rather than when its start settles:
  // start() keeps ingesting (handover gap recovery) after its last await.
  const starting = startingMarketDataServices.get(key);
  if (starting?.service) retireService(key, starting.service);
  const service = marketDataServices.get(key);
  if (service) {
    retireService(key, service);
    marketDataServices.delete(key);
  }
};

/**
 * Stop a fund's standalone service and wait until it can no longer write its
 * fill ledger (issue #1008): every start still in flight has settled and every
 * order handler it accepted has finished. Only then may a replacement owner
 * (the regime engine) load the ledger — each instance persists its whole
 * in-memory Map, so a writer that outlives the handover erases the
 * replacement's fills on its next persist.
 * @param {string} exchange
 * @param {string} [pair]
 * @param {number} [timeoutMs]
 * @returns {Promise<{drained: boolean}>} drained:false when the join timed out
 */
const fenceMarketDataService = async (exchange, pair, timeoutMs = FENCE_TIMEOUT_MS) => {
  const key = serviceKey(exchange, pair);
  const starting = startingMarketDataServices.get(key)?.promise;
  stopMarketDataService(exchange, pair);
  const joined = (async () => {
    // The fenced start may still be mid-await (candles, gap recovery); let it
    // observe the stop and settle before joining the order work it queued.
    await starting?.catch(() => {});
    await Promise.allSettled([...(retiringServices.get(key) || [])].map((service) => service.whenIdle()));
    return true;
  })();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const drained = await Promise.race([joined, expired]);
  clearTimeout(timer);
  return { drained: drained === true };
};

/**
 * Get market data service for a fund (exchange + pair).
 */
const getMarketDataService = (exchange, pair) => {
  return marketDataServices.get(serviceKey(exchange, pair));
};

/**
 * Stop all market data services, including any whose start is still in flight.
 */
const stopAllMarketDataServices = () => {
  // Cancel in-flight starts too, so SIGTERM can't leave a WS feed and a 60s
  // metrics interval behind holding the event loop open after shutdown.
  for (const key of new Set([...marketDataServices.keys(), ...startingMarketDataServices.keys()])) {
    bumpStopGeneration(key);
  }
  for (const [key, { service }] of startingMarketDataServices) {
    if (service) retireService(key, service);
  }
  for (const [key, service] of marketDataServices) {
    retireService(key, service);
  }
  marketDataServices.clear();
};

module.exports = {
  createMarketDataService,
  getActiveMarketDataFunds: () => [...new Set([...marketDataServices.keys(), ...startingMarketDataServices.keys()])]
    .map((key) => { const [exchange, pair] = key.split('::'); return { exchange, pair }; }),
  drainMarketDataStarts: () => Promise.allSettled([...startingMarketDataServices.values()].map((entry) => entry.promise)),
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
