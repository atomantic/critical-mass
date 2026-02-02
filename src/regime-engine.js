// @ts-check
/**
 * Regime Engine
 *
 * Main regime-aware trading engine that orchestrates:
 * - WebSocket connection for real-time data
 * - Periodic metrics calculation (ATR, RV, VWAP)
 * - Regime classification (HARVEST/CAUTION/TREND)
 * - Volatility-triggered entries
 * - Dynamic take-profit management
 * - Risk management and caps
 * - Health monitoring and SAFE mode
 *
 * Replaces fixed-interval DCA with adaptive volatility-driven trading.
 */

const { getAdapter } = require('./adapters');
const { getRegimeConfig } = require('./config-utils');
const { createFillLedger } = require('./fill-ledger');
const { createHealthMonitor } = require('./health-monitor');
const { createTailEventsMonitor } = require('./tail-events');
const { createWebSocketFeed } = require('./websocket-feed');
const { createRegimeDetector } = require('./regime-detector');
const { createPositionSizer } = require('./position-sizer');
const { createRiskManager } = require('./risk-manager');
const { createOrderExecutor } = require('./order-executor');
const { createDryRunExecutor } = require('./dry-run-executor');
const { createRecoveryModule } = require('./recovery');
const { calculateAllMetrics, clamp, roundBTC, roundUSDC } = require('./volatility-utils');
const { tradeEvents } = require('./trade-events');
const dryRunState = require('./dry-run-state');
const { loadRegimeState, saveRegimeState } = require('./state-tracker');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').MarketState} MarketState
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 * @typedef {import('./types').RegimeState} RegimeState
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 */

/**
 * Create initial market state
 * @returns {MarketState}
 */
const createInitialMarketState = () => ({
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
  tradeImbalance: 0,
  trades: [],
  lastUpdate: 0,
});

/**
 * Create initial position state
 * @returns {RegimePositionState}
 */
const createInitialPositionState = () => ({
  totalBTC: 0,
  totalCostBasis: 0,
  avgCostBasis: 0,
  ladderStep: 0,
  lastEntryPrice: 0,
  lastEntryTime: 0,
  anchorPrice: 0,
  activeTpOrderId: null,
  lastTpPrice: 0,
  cyclesCompleted: 0,
  unrealizedPnL: 0,
  realizedPnL: 0,
  realizedBtcPnL: 0,
  btcOnOrder: 0,
  maxDrawdownSeen: 0,
  scalingDisabled: false,
  scalingDisabledReason: null,
});

/**
 * Create regime engine instance
 * @param {string} exchange - Exchange name
 * @param {Object} exchangeConfig - Exchange configuration
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onTrade] - Trade event callback
 * @param {Function} [callbacks.onRegimeChange] - Regime change callback
 * @param {Function} [callbacks.onHealthChange] - Health change callback
 * @param {Function} [callbacks.onStatusUpdate] - Throttled status update callback
 * @returns {Object} Regime engine instance
 */
const createRegimeEngine = (exchange, exchangeConfig, callbacks = {}) => {
  const { productId } = exchangeConfig;
  const config = getRegimeConfig(exchange);

  // Throttled status update tracking
  let lastStatusUpdate = 0;
  const STATUS_UPDATE_INTERVAL = 1000; // 1 second throttle

  // Dry-run mode flag
  const isDryRun = config.dryRun === true;
  const modeLabel = isDryRun ? '[DRY-RUN] ' : '';

  // Create adapter
  const adapter = getAdapter(exchange);

  // Create all component instances
  const fillLedger = createFillLedger(exchange);
  const healthMonitor = createHealthMonitor(exchange, config, {
    onSafeMode: async (reason) => {
      console.log(`⚠️ [${exchange}] SAFE mode: ${reason}`);
      await orderExecutor.cancelAllEntries();
      if (callbacks.onHealthChange) {
        callbacks.onHealthChange('SAFE', reason);
      }
    },
    onActiveMode: () => {
      if (callbacks.onHealthChange) {
        callbacks.onHealthChange('ACTIVE', null);
      }
    },
  });

  const tailEvents = createTailEventsMonitor(exchange, config, {
    onFlashMove: (delta, multiple) => {
      tradeEvents.emitTradeEvent('flash_move', exchange, `Flash move: ${multiple.toFixed(1)}x ATR`, { delta, multiple });
    },
    onRegimeTransition: (newMode, reason) => {
      regimeDetector.forceTransition(newMode, reason);
    },
  });

  const regimeDetector = createRegimeDetector(exchange, config, {
    onTransition: (prevMode, newMode, reason) => {
      tradeEvents.emitTradeEvent('regime_change', exchange, `${prevMode} -> ${newMode}`, { prevMode, newMode, reason });
      if (callbacks.onRegimeChange) {
        callbacks.onRegimeChange(prevMode, newMode, reason);
      }
    },
  });

  const positionSizer = createPositionSizer(exchange, config);
  const riskManager = createRiskManager(exchange, config);

  // State (initialized before executor so dry-run can reference marketState)
  let marketState = createInitialMarketState();
  let positionState = createInitialPositionState();

  // Callbacks container for dry-run (populated after functions are defined)
  const dryRunCallbacks = {
    onBuyFill: null,
    onSellFill: null,
  };

  // Create order executor - use dry-run executor when dryRun is enabled
  // Callbacks are set up later after internal functions are defined
  const orderExecutor = isDryRun
    ? createDryRunExecutor(exchange, config, marketState, {
        onBuyFill: (...args) => dryRunCallbacks.onBuyFill && dryRunCallbacks.onBuyFill(...args),
        onSellFill: (...args) => dryRunCallbacks.onSellFill && dryRunCallbacks.onSellFill(...args),
      })
    : createOrderExecutor(exchange, config, adapter, productId);

  const recoveryModule = createRecoveryModule(exchange, adapter, productId);
  let isRunning = false;
  let wsFeed = null;
  let metricsInterval = null;
  let reconcileInterval = null;
  let stateSaveInterval = null;

  /**
   * Save dry-run state to disk
   */
  const saveDryRunState = () => {
    if (!isDryRun || !orderExecutor.exportState) return;

    dryRunState.saveState(exchange, {
      isDryRun: true,
      executor: orderExecutor.exportState(),
      position: { ...positionState },
    });
  };

  /**
   * Load dry-run state from disk
   * @returns {boolean} Whether state was loaded
   */
  const loadDryRunState = () => {
    if (!isDryRun || !orderExecutor.importState) return false;

    const savedState = dryRunState.loadState(exchange);
    if (!savedState || !savedState.isDryRun) return false;

    // Restore executor state
    orderExecutor.importState(savedState.executor);

    // Restore position state
    if (savedState.position) {
      positionState = { ...createInitialPositionState(), ...savedState.position };
    }

    console.log(`📂 [${exchange}] [DRY-RUN] Restored state: ${positionState.cyclesCompleted} cycles, step ${positionState.ladderStep}, PnL=$${positionState.realizedPnL.toFixed(2)}`);
    return true;
  };

  /**
   * Save live state to disk (for faster recovery on restarts)
   */
  const saveLiveState = () => {
    if (isDryRun) return;

    const regimeState = regimeDetector.getState();
    saveRegimeState(positionState, regimeState, exchange);
  };

  /**
   * Load live state from disk
   * @returns {boolean} Whether state was loaded
   */
  const loadLiveState = () => {
    if (isDryRun) return false;

    const savedState = loadRegimeState(exchange);
    if (!savedState.position || savedState.position.totalBTC === 0) {
      console.log(`ℹ️ [${exchange}] No saved live state or empty position`);
      return false;
    }

    positionState = { ...createInitialPositionState(), ...savedState.position };
    if (savedState.regime) {
      regimeDetector.restoreState(savedState.regime);
    }

    console.log(`📂 [${exchange}] Loaded saved state: ${positionState.cyclesCompleted} cycles, step ${positionState.ladderStep}, ${positionState.totalBTC.toFixed(6)} BTC`);
    return true;
  };

  /**
   * Check for orders that filled while offline
   * @returns {Promise<{tpFilled: boolean, entriesFilled: number}>}
   */
  const checkOfflineOrderFills = async () => {
    const openOrders = await adapter.getOpenOrders(productId);
    const openOrderIds = new Set(openOrders.map(o => o.orderId));

    let tpFilled = false;
    let entriesFilled = 0;

    // Check if active TP order still exists on exchange
    if (positionState.activeTpOrderId && !openOrderIds.has(positionState.activeTpOrderId)) {
      // TP order is gone - check if it filled
      const orderStatus = await adapter.getOrder(positionState.activeTpOrderId);
      if (orderStatus.status === 'FILLED') {
        console.log(`✅ [${exchange}] TP order ${positionState.activeTpOrderId} filled while offline`);
        tpFilled = true;

        // Get fill details
        const fills = await adapter.getOrderFills(positionState.activeTpOrderId);
        for (const fill of fills) {
          fillLedger.ingestFill(fill);
        }

        // Calculate P&L from the fills
        const summary = fillLedger.aggregateFills(fills);
        const proceeds = summary.totalValue - summary.totalFees;
        const soldCostBasis = summary.totalSize * positionState.avgCostBasis;
        const pnl = proceeds - soldCostBasis;
        const holdbackBtc = roundBTC(positionState.totalBTC - summary.totalSize);

        positionState.realizedPnL += pnl;
        positionState.realizedBtcPnL += holdbackBtc;
        positionState.cyclesCompleted += 1;

        console.log(`💰 [${exchange}] Offline TP fill: ${summary.totalSize} BTC @ $${summary.avgPrice}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackBtc.toFixed(6)} BTC`);

        tradeEvents.emitTradeEvent('tp_filled', exchange, `[OFFLINE] ${summary.totalSize} BTC @ $${summary.avgPrice}, PnL=$${pnl.toFixed(2)}`, {
          btcAmount: summary.totalSize,
          price: summary.avgPrice,
          pnl,
          holdbackBtc,
          offlineFill: true,
        });

        // Reset cycle
        resetCycle();
      }
    }

    // Check for entry orders that filled while offline
    const pendingEntries = orderExecutor.getPendingEntries();
    for (const [orderId] of pendingEntries) {
      if (!openOrderIds.has(orderId)) {
        const orderStatus = await adapter.getOrder(orderId);
        if (orderStatus.status === 'FILLED') {
          console.log(`✅ [${exchange}] Entry order ${orderId} filled while offline`);
          entriesFilled++;

          // Get and ingest fills
          const fills = await adapter.getOrderFills(orderId);
          for (const fill of fills) {
            fillLedger.ingestFill(fill);
          }

          // Update position
          const summary = fillLedger.aggregateFills(fills);
          positionState.totalBTC = roundBTC(positionState.totalBTC + summary.totalSize);
          positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + summary.totalValue + summary.totalFees);
          positionState.avgCostBasis = positionState.totalBTC > 0
            ? positionState.totalCostBasis / positionState.totalBTC
            : 0;
          positionState.ladderStep += 1;
          positionState.lastEntryPrice = summary.avgPrice;
          positionState.lastEntryTime = Date.now();

          orderExecutor.handleOrderFill(orderId);

          tradeEvents.emitTradeEvent('buy_filled', exchange, `[OFFLINE] ${summary.totalSize} BTC @ $${summary.avgPrice}`, {
            btcAmount: summary.totalSize,
            price: summary.avgPrice,
            avgCostBasis: positionState.avgCostBasis,
            offlineFill: true,
          });
        }
      }
    }

    return { tpFilled, entriesFilled };
  };

  /**
   * Re-evaluate position after downtime
   * Checks if market has moved significantly and adjusts strategy accordingly
   * @param {number} currentPrice - Current market price
   */
  const reEvaluateAfterDowntime = (currentPrice) => {
    if (positionState.totalBTC <= 0) {
      console.log(`ℹ️ [${exchange}] No position to re-evaluate`);
      return;
    }

    const lastEntryPrice = positionState.lastEntryPrice || positionState.avgCostBasis;
    if (lastEntryPrice <= 0) return;

    const priceChange = ((currentPrice - lastEntryPrice) / lastEntryPrice) * 100;
    const priceChangeAbs = Math.abs(priceChange);

    console.log(`📊 [${exchange}] Re-evaluating position: price moved ${priceChange.toFixed(2)}% since last entry ($${lastEntryPrice.toFixed(2)} -> $${currentPrice.toFixed(2)})`);

    // Re-anchor price for volatility triggers
    positionState.anchorPrice = currentPrice;
    console.log(`⚓ [${exchange}] Re-anchored price to $${currentPrice.toFixed(2)}`);

    // If price dropped significantly (>5%), consider the position may need attention
    if (priceChange < -5) {
      console.log(`⚠️ [${exchange}] Price dropped ${priceChangeAbs.toFixed(2)}% while offline - position unrealized P&L affected`);
    }

    // If price rose significantly and we have a position, TP might need updating
    if (priceChange > 3 && positionState.totalBTC > 0) {
      console.log(`📈 [${exchange}] Price rose ${priceChangeAbs.toFixed(2)}% while offline - TP order may need adjustment`);
      // TP order will be re-evaluated naturally on next metrics update
    }
  };

  /**
   * Start the regime engine
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  const start = async () => {
    if (isRunning) {
      console.log(`⚠️ [${exchange}] ${modeLabel}Regime engine already running`);
      return { success: false, error: 'Engine already running' };
    }

    console.log(`🚀 [${exchange}] ${modeLabel}Starting regime engine for ${productId}`);

    // Recover state from exchange (skip in dry-run mode)
    if (!isDryRun) {
      // First, try to load saved state for faster startup
      const hasSavedState = loadLiveState();

      // Then recover/validate from exchange (source of truth)
      const { position } = await recoveryModule.recoverState(fillLedger, orderExecutor);

      // Merge recovered position with any saved state (exchange is authoritative for BTC balance)
      positionState = {
        ...createInitialPositionState(),
        ...positionState, // Keep saved fields like realizedPnL, cyclesCompleted
        ...position,      // Override with exchange-recovered values
      };

      // Check for orders that filled while we were offline
      const { tpFilled, entriesFilled } = await checkOfflineOrderFills();
      if (tpFilled || entriesFilled > 0) {
        console.log(`📋 [${exchange}] Processed offline fills: TP=${tpFilled}, entries=${entriesFilled}`);
      }

      // Get current price and re-evaluate position
      const currentPrice = await adapter.getCurrentPrice(productId);
      if (currentPrice > 0 && positionState.totalBTC > 0) {
        reEvaluateAfterDowntime(currentPrice);
      }

      // If we have position but no TP order, place one
      if (positionState.totalBTC > 0 && !positionState.activeTpOrderId) {
        console.log(`📝 [${exchange}] Position exists but no TP order, will place after metrics update`);
      }

      // Save initial state after recovery
      saveLiveState();
    } else {
      // Try to load saved dry-run state
      const loaded = loadDryRunState();
      if (!loaded) {
        console.log(`🧪 [${exchange}] [DRY-RUN] No saved state, starting fresh`);
        positionState = createInitialPositionState();
      }
    }

    // Start WebSocket feed
    await connectWebSocket();

    // Start periodic metrics updates
    startMetricsUpdater();

    // Start reconciliation and state saving
    if (!isDryRun) {
      startReconciliation();
      // Start periodic state saving for live mode (every 5 minutes)
      stateSaveInterval = setInterval(saveLiveState, 300000);
    } else {
      // Start periodic state saving for dry-run (every 60 seconds)
      stateSaveInterval = setInterval(saveDryRunState, 60000);
    }

    isRunning = true;
    console.log(`✅ [${exchange}] ${modeLabel}Regime engine started`);

    return { success: true };
  };

  /**
   * Stop the regime engine
   */
  const stop = async () => {
    if (!isRunning) return;

    console.log(`🛑 [${exchange}] Stopping regime engine`);

    // Save state before stopping
    if (isDryRun) {
      dryRunState.forceSave(exchange, {
        isDryRun: true,
        executor: orderExecutor.exportState ? orderExecutor.exportState() : {},
        position: { ...positionState },
      });
    } else {
      // Save live state on shutdown
      saveLiveState();
      // Also persist fill ledger
      fillLedger.persist();
      console.log(`💾 [${exchange}] Saved live state and fill ledger`);
    }

    // Disconnect WebSocket
    if (wsFeed) {
      wsFeed.disconnect();
      wsFeed = null;
    }

    // Stop intervals
    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }

    if (reconcileInterval) {
      clearInterval(reconcileInterval);
      reconcileInterval = null;
    }

    if (stateSaveInterval) {
      clearInterval(stateSaveInterval);
      stateSaveInterval = null;
    }

    tailEvents.cleanup();
    isRunning = false;

    console.log(`✅ [${exchange}] Regime engine stopped`);
  };

  /**
   * Connect to WebSocket feed
   */
  const connectWebSocket = async () => {
    const credentials = adapter.loadCredentials();

    wsFeed = createWebSocketFeed(exchange, {
      productId,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      onTicker: handleTicker,
      onTrade: handleTrade,
      onOrderUpdate: handleOrderUpdate,
      onConnect: () => {
        healthMonitor.recordWsStatus(true);
      },
      onDisconnect: () => {
        healthMonitor.recordWsStatus(false);
      },
      onError: (error) => {
        console.log(`❌ [${exchange}] WebSocket error: ${error.message}`);
      },
    });

    wsFeed.connect();
  };

  /**
   * Handle ticker update from WebSocket
   * @param {Object} data - Ticker data
   */
  const handleTicker = (data) => {
    marketState.lastPrice = data.price;
    marketState.bid = data.bid;
    marketState.ask = data.ask;
    marketState.spread = data.ask - data.bid;
    marketState.lastUpdate = Date.now();

    healthMonitor.recordTickerUpdate();

    // Process tail event checks
    tailEvents.processTicker(data, marketState.atr1m);

    // Evaluate entry trigger
    evaluateEntryTrigger();

    // In dry-run mode, check if any orders should fill based on current price
    if (isDryRun) {
      if (orderExecutor.checkTpFills) {
        orderExecutor.checkTpFills(data.price);
      }
      if (orderExecutor.checkEntryFills) {
        orderExecutor.checkEntryFills(data.price);
      }
    }

    // Update unrealized P&L
    if (positionState.totalBTC > 0) {
      const currentValue = positionState.totalBTC * data.price;
      positionState.unrealizedPnL = currentValue - positionState.totalCostBasis;
    }

    // Emit throttled status update
    const now = Date.now();
    if (callbacks.onStatusUpdate && now - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
      lastStatusUpdate = now;
      callbacks.onStatusUpdate(getState());
    }
  };

  /**
   * Handle trade from WebSocket
   * @param {Object} data - Trade data
   */
  const handleTrade = (data) => {
    // Update lastPrice from trade data (fallback when ticker isn't providing updates)
    if (data.price && data.price > 0) {
      marketState.lastPrice = data.price;
      marketState.lastUpdate = Date.now();
    }

    marketState.trades.push(data);

    // Prune old trades (keep 3 min)
    const cutoff = Date.now() - 3 * 60 * 1000;
    marketState.trades = marketState.trades.filter(t => t.timestamp >= cutoff);

    // Update trade imbalance
    updateTradeImbalance();
  };

  /**
   * Handle order update from WebSocket
   * @param {Object} data - Order data
   */
  const handleOrderUpdate = async (data) => {
    healthMonitor.recordOrderUpdate();

    if (data.status === 'FILLED') {
      await handleOrderFill(data);
    } else if (data.status === 'CANCELLED') {
      orderExecutor.handleOrderCancel(data.orderId);
    }
  };

  /**
   * Handle order fill
   * @param {Object} fillData - Fill data
   */
  const handleOrderFill = async (fillData) => {
    // Get detailed fills
    const fills = await adapter.getOrderFills(fillData.orderId);

    // Ingest each fill
    for (const fill of fills) {
      fillLedger.ingestFill(fill);
    }

    // Determine if buy or sell
    if (fillData.side.toLowerCase() === 'buy') {
      // Update position
      const summary = fillLedger.aggregateFills(fills);
      positionState.totalBTC = roundBTC(positionState.totalBTC + summary.totalSize);
      positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + summary.totalValue + summary.totalFees);
      positionState.avgCostBasis = positionState.totalBTC > 0
        ? positionState.totalCostBasis / positionState.totalBTC
        : 0;
      positionState.ladderStep += 1;
      positionState.lastEntryPrice = summary.avgPrice;
      positionState.lastEntryTime = Date.now();

      // Place/update TP order
      await placeTakeProfitOrder();

      console.log(`✅ [${exchange}] Buy filled: ${summary.totalSize} BTC @ $${summary.avgPrice}, avg_cost=$${positionState.avgCostBasis.toFixed(2)}`);

      tradeEvents.emitTradeEvent('buy_filled', exchange, `${summary.totalSize} BTC @ $${summary.avgPrice}`, {
        btcAmount: summary.totalSize,
        price: summary.avgPrice,
        avgCostBasis: positionState.avgCostBasis,
      });

    } else if (fillData.side.toLowerCase() === 'sell') {
      // Cycle complete
      const summary = fillLedger.aggregateFills(fills);
      const proceeds = summary.totalValue - summary.totalFees;
      const soldCostBasis = summary.totalSize * positionState.avgCostBasis;
      const pnl = proceeds - soldCostBasis;

      // Calculate BTC holdback (the BTC we kept as reserves from this cycle)
      const holdbackBtc = roundBTC(positionState.totalBTC - summary.totalSize);

      positionState.realizedPnL += pnl;
      positionState.realizedBtcPnL += holdbackBtc;
      positionState.btcOnOrder = 0;
      positionState.cyclesCompleted += 1;

      console.log(`✅ [${exchange}] TP filled: ${summary.totalSize} BTC @ $${summary.avgPrice}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackBtc.toFixed(6)} BTC`);

      tradeEvents.emitTradeEvent('tp_filled', exchange, `${summary.totalSize} BTC @ $${summary.avgPrice}, PnL=$${pnl.toFixed(2)}`, {
        btcAmount: summary.totalSize,
        price: summary.avgPrice,
        pnl,
        holdbackBtc,
        totalRealizedBtc: positionState.realizedBtcPnL,
      });

      // Reset for next cycle
      resetCycle();
    }

    orderExecutor.handleOrderFill(fillData.orderId);
  };

  /**
   * Update trade imbalance from recent trades
   */
  const updateTradeImbalance = () => {
    const recentTrades = marketState.trades;
    if (recentTrades.length === 0) {
      marketState.tradeImbalance = 0;
      return;
    }

    let buyVol = 0;
    let sellVol = 0;

    for (const trade of recentTrades) {
      if (trade.side === 'buy') {
        buyVol += trade.size;
      } else {
        sellVol += trade.size;
      }
    }

    const totalVol = buyVol + sellVol;
    if (totalVol > 0) {
      // Imbalance: +1 = all buys, -1 = all sells, 0 = balanced
      marketState.tradeImbalance = (buyVol - sellVol) / totalVol;
    }
  };

  /**
   * Start periodic metrics updater
   */
  const startMetricsUpdater = () => {
    // Update metrics every 60 seconds
    metricsInterval = setInterval(updateMetrics, 60000);
    // Initial update
    updateMetrics();
  };

  /**
   * Update volatility metrics via REST API
   */
  const updateMetrics = async () => {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const fourHoursAgo = now - 14400;

    const candles1m = await adapter.getCandles(productId, oneHourAgo, now, 'ONE_MINUTE');
    const candles5m = await adapter.getCandles(productId, fourHoursAgo, now, 'FIVE_MINUTE');

    const metrics = calculateAllMetrics(candles1m, candles5m, marketState.volBaseline, config);

    marketState.atr1m = metrics.atr1m;
    marketState.atr5m = metrics.atr5m;
    marketState.realizedVol = metrics.realizedVol;
    marketState.volBaseline = metrics.volBaseline;
    marketState.vwap = metrics.vwap;
    marketState.recentSwing = metrics.recentSwing;

    // Calculate VWAP distance
    if (marketState.lastPrice > 0 && marketState.atr1m > 0) {
      marketState.vwapDistance = (marketState.lastPrice - marketState.vwap) / marketState.atr1m;
    }

    // Classify regime with updated metrics
    regimeDetector.classify(marketState);

    // Log hourly summary
    logHourlySummary();
  };

  /**
   * Start periodic reconciliation
   */
  const startReconciliation = () => {
    reconcileInterval = setInterval(async () => {
      const result = await recoveryModule.reconcile(positionState, fillLedger);
      if (result.updated) {
        positionState = result.position;
        console.log(`🔄 [${exchange}] Position reconciled from exchange`);
      }
    }, config.reconcileIntervalMs);
  };

  /**
   * Evaluate volatility-based entry trigger
   */
  const evaluateEntryTrigger = async () => {
    const now = Date.now();
    const timeSinceLastEntry = now - positionState.lastEntryTime;

    // Minimum interval guard
    if (timeSinceLastEntry < config.minIntervalMs) return;

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Check tail events
    const tailCheck = tailEvents.canPlaceEntry(positionState.ladderStep);
    if (!tailCheck.allowed) return;

    // Check regime allows entries
    if (!regimeDetector.allowsEntries()) return;

    // Calculate price move from anchor
    const priceMove = positionState.anchorPrice > 0
      ? Math.abs(marketState.lastPrice - positionState.anchorPrice)
      : Infinity;

    const volTrigger = marketState.atr1m > 0 && priceMove >= config.kFactor * marketState.atr1m;
    const timeTrigger = timeSinceLastEntry >= config.maxIntervalMs;

    if (volTrigger || timeTrigger) {
      await executeEntry(volTrigger ? 'volatility' : 'timer');
    }
  };

  /**
   * Execute entry
   * @param {string} triggerType - What triggered the entry
   */
  const executeEntry = async (triggerType) => {
    const regime = regimeDetector.getMode();

    // Calculate size
    const sizing = positionSizer.calculateEntrySize({
      regime,
      ladderStep: positionState.ladderStep,
      totalCostBasis: positionState.totalCostBasis,
    });

    // Check risk caps
    const btcQty = positionSizer.calculateBTCQuantity(sizing.sizeUsdc, marketState.bid);
    const riskCheck = riskManager.canPlaceEntry(positionState, btcQty, sizing.sizeUsdc);

    // Handle ladder auto-reset (time-based reset after being at max limit)
    if (riskCheck.shouldResetLadder) {
      console.log(`🔄 [${exchange}] Ladder auto-reset triggered, resetting step ${positionState.ladderStep} -> 0`);
      positionState.ladderStep = 0;
    }

    if (!riskCheck.allowed) {
      console.log(`⚠️ [${exchange}] Entry blocked: ${riskCheck.reason}`);
      return;
    }

    // Check minimum size
    if (!positionSizer.meetsMinimum(sizing.sizeUsdc, exchangeConfig.minOrderSize || 1)) {
      console.log(`ℹ️ [${exchange}] Size $${sizing.sizeUsdc} below minimum`);
      return;
    }

    // Place entry
    const result = await orderExecutor.placeEntryBid(sizing.sizeUsdc, marketState.bid, marketState.ask);

    if (result.success) {
      positionState.lastEntryTime = Date.now();
      positionState.anchorPrice = marketState.lastPrice;

      console.log(`📝 [${exchange}] Entry placed: regime=${regime} step=${positionState.ladderStep} size=$${sizing.sizeUsdc} price=$${result.price} trigger=${triggerType}`);

      tradeEvents.emitTradeEvent('entry_placed', exchange, `$${sizing.sizeUsdc} @ $${result.price}`, {
        regime,
        step: positionState.ladderStep,
        sizeUsdc: sizing.sizeUsdc,
        price: result.price,
        trigger: triggerType,
      });
    }
  };

  /**
   * Place or update take-profit order
   */
  const placeTakeProfitOrder = async () => {
    const { sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(positionState.totalBTC);

    if (sellQty <= 0) return;

    const tpPrice = calculateDynamicTP();

    const result = await orderExecutor.placeTakeProfitOrder(sellQty, tpPrice);

    if (result.success) {
      positionState.activeTpOrderId = result.orderId;
      positionState.lastTpPrice = tpPrice;
      positionState.btcOnOrder = sellQty;

      if (result.updated) {
        console.log(`📝 [${exchange}] TP ${result.orderId ? 'updated' : 'placed'}: ${sellQty} BTC @ $${tpPrice} (holdback=${holdbackQty.toFixed(6)})`);
      }
    }
  };

  /**
   * Calculate dynamic take-profit price
   * @returns {number}
   */
  const calculateDynamicTP = () => {
    const { avgCostBasis } = positionState;
    const { recentSwing, lastPrice } = marketState;

    // Base TP percentage from recent volatility
    let tpPercent = recentSwing > 0 && lastPrice > 0
      ? (config.tpMult * recentSwing / lastPrice) * 100
      : config.tpMinPercent;

    // Regime adjustments
    const regime = regimeDetector.getMode();
    if (regime === 'CAUTION') {
      tpPercent *= 1.5; // Wider TP, prioritize de-risk
    } else if (regime === 'TREND') {
      tpPercent *= 0.8; // Tighter TP, capture rallies
    }

    // Clamp to min/max
    tpPercent = clamp(tpPercent, config.tpMinPercent, config.tpMaxPercent);

    return roundUSDC(avgCostBasis * (1 + tpPercent / 100));
  };

  /**
   * Reset for new cycle
   */
  const resetCycle = () => {
    positionState.totalBTC = 0;
    positionState.totalCostBasis = 0;
    positionState.avgCostBasis = 0;
    positionState.ladderStep = 0;
    positionState.activeTpOrderId = null;
    positionState.lastTpPrice = 0;
    positionState.btcOnOrder = 0;
    positionState.anchorPrice = 0;
    positionState.scalingDisabled = false;
    positionState.scalingDisabledReason = null;

    // Start new cycle in fill ledger
    fillLedger.startNewCycle();
    riskManager.resetCycleTracking();

    console.log(`🔄 [${exchange}] Cycle reset, starting new cycle`);
  };

  /**
   * Log hourly summary
   */
  const logHourlySummary = () => {
    const regime = regimeDetector.getMode();
    const counts = orderExecutor.getPendingCounts();
    const riskSummary = riskManager.getSummary(positionState);

    console.log(
      `📊 [${exchange}] ${modeLabel}Hour: regime=${regime} entries=${counts.entries} ` +
      `exposure=${riskSummary} ` +
      `atr=$${marketState.atr1m.toFixed(2)} vol=${marketState.realizedVol.toFixed(2)}%`
    );
  };

  // Set up dry-run callbacks now that all functions are defined
  if (isDryRun) {
    dryRunCallbacks.onBuyFill = async (orderId, btcQty, price, costBasis) => {
      positionState.totalBTC = roundBTC(positionState.totalBTC + btcQty);
      positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + costBasis);
      positionState.avgCostBasis = positionState.totalBTC > 0
        ? positionState.totalCostBasis / positionState.totalBTC
        : 0;
      positionState.ladderStep += 1;
      positionState.lastEntryPrice = price;
      positionState.lastEntryTime = Date.now();

      // Place/update TP order (simulated)
      await placeTakeProfitOrder();

      tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${btcQty} BTC @ $${price}`, {
        btcAmount: btcQty,
        price,
        avgCostBasis: positionState.avgCostBasis,
        isDryRun: true,
      });

      // Save state after buy fill
      saveDryRunState();
    };

    dryRunCallbacks.onSellFill = (orderId, btcQty, price, proceeds, pnl) => {
      // Calculate BTC holdback (the BTC we kept as reserves from this cycle)
      const holdbackBtc = roundBTC(positionState.totalBTC - btcQty);

      positionState.realizedPnL += pnl;
      positionState.realizedBtcPnL += holdbackBtc;
      positionState.btcOnOrder = 0;
      positionState.cyclesCompleted += 1;

      tradeEvents.emitTradeEvent('tp_filled', exchange, `[DRY-RUN] ${btcQty} BTC @ $${price}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackBtc.toFixed(6)} BTC`, {
        btcAmount: btcQty,
        price,
        pnl,
        holdbackBtc,
        totalRealizedBtc: positionState.realizedBtcPnL,
        isDryRun: true,
      });

      // Reset for next cycle
      resetCycle();

      // Save state after TP fill
      saveDryRunState();
    };
  }

  /**
   * Get current state summary
   * @returns {Object}
   */
  const getState = () => ({
    isRunning,
    isDryRun,
    market: marketState,
    position: positionState,
    regime: regimeDetector.getState(),
    health: healthMonitor.getState(),
    pause: tailEvents.getPauseState(),
    risk: riskManager.getState(),
    orders: orderExecutor.getPendingCounts(),
    dryRun: isDryRun && orderExecutor.getDryRunState ? orderExecutor.getDryRunState() : null,
  });

  /**
   * Force regime transition (manual override)
   * @param {string} newMode - New regime mode
   * @param {string} reason - Reason
   */
  const forceRegime = (newMode, reason) => {
    regimeDetector.forceTransition(newMode, reason);
  };

  /**
   * Pause engine (manual)
   * @param {string} reason - Reason
   */
  const pause = (reason) => {
    healthMonitor.pause(reason);
  };

  /**
   * Resume engine (manual)
   */
  const resume = () => {
    healthMonitor.resume();
  };

  /**
   * Get current status (alias for getState for API consistency)
   * @returns {Object}
   */
  const getStatus = () => getState();

  /**
   * Update configuration
   * @param {Object} updates - Config updates
   */
  const updateConfig = (updates) => {
    Object.assign(config, updates);
    console.log(`🔧 [${exchange}] Regime engine config updated`);
  };

  /**
   * Get all fills from ledger
   * @returns {Array}
   */
  const getFills = () => fillLedger.getAllFills();

  /**
   * Get fill statistics
   * @returns {Object}
   */
  const getFillStats = () => fillLedger.getStats();

  /**
   * Get dry-run decision log
   * @param {number} [limit] - Maximum entries to return
   * @returns {Array|null}
   */
  const getDryRunLog = (limit = 100) => {
    if (isDryRun && orderExecutor.getDecisionLog) {
      return orderExecutor.getDecisionLog(limit);
    }
    return null;
  };

  /**
   * Get dry-run P&L summary
   * @returns {Object|null}
   */
  const getDryRunPnL = () => {
    if (isDryRun && orderExecutor.getSimulatedPnL) {
      return orderExecutor.getSimulatedPnL();
    }
    return null;
  };

  /**
   * Reset dry-run state (clears all simulated orders and history)
   * @returns {boolean}
   */
  const resetDryRun = () => {
    if (isDryRun && orderExecutor.resetDryRunState) {
      orderExecutor.resetDryRunState();
      positionState = createInitialPositionState();
      // Clear saved state file
      dryRunState.clearState(exchange);
      return true;
    }
    return false;
  };

  /**
   * Force resume from drawdown pause (manual override)
   * Resets peak equity to current level to allow trading to continue
   * @returns {{success: boolean, message: string}}
   */
  const forceResumeDrawdown = () => {
    const riskState = riskManager.getState();
    if (!riskState.isDrawdownPaused) {
      return { success: false, message: 'Not in drawdown pause' };
    }

    // Calculate current equity to set as new peak
    const currentValue = positionState.totalBTC * marketState.lastPrice;
    const currentEquity = currentValue - positionState.totalCostBasis;

    riskManager.forceResume(currentEquity);
    console.log(`▶️ [${exchange}] Drawdown pause manually cleared, peak reset to $${currentEquity.toFixed(2)}`);

    return { success: true, message: `Resumed, peak reset to $${currentEquity.toFixed(2)}` };
  };

  return {
    start,
    stop,
    getState,
    getStatus,
    forceRegime,
    pause,
    resume,
    updateConfig,
    getFills,
    getFillStats,
    forceResumeDrawdown,
    // Dry-run specific methods
    isDryRun,
    getDryRunLog,
    getDryRunPnL,
    resetDryRun,
    // Expose internals for testing
    _getMarketState: () => marketState,
    _getPositionState: () => positionState,
    _getConfig: () => config,
  };
};

module.exports = {
  createRegimeEngine,
  createInitialMarketState,
  createInitialPositionState,
};
