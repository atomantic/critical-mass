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
const { getRegimeConfig, updateRegimeConfig, getBaseCurrency, getQuoteCurrency } = require('./config-utils');
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
const { createTpOptimizer } = require('./tp-optimizer');
const { createSizeOptimizer } = require('./size-optimizer');
const { createLadderCalculator } = require('./ladder-calculator');
const { calculateAllMetrics, clamp, roundAsset, roundUSDC, roundPrice } = require('./volatility-utils');
const { createMacroRegime } = require('./macro-regime');
const { calculateApyMetrics: _calculateApyMetrics, initializeApyTracking: _initializeApyTracking } = require('./apy-calculator');
const { tradeEvents } = require('./trade-events');
const dryRunState = require('./dry-run-state');
const { loadRegimeState, saveRegimeState, LIFECYCLE } = require('./state-tracker');
const celestialHierarchy = require('./celestial-hierarchy');

/** Format price with appropriate decimal places for the asset */
const fmtPrice = (p) => {
  if (p == null || isNaN(p)) return '-';
  if (Math.abs(p) >= 100) return `$${p.toFixed(2)}`;
  if (Math.abs(p) >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(5)}`;
};

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
  momentum: { magnitude: 0, direction: 'neutral' },
  trades: [],
  lastUpdate: 0,
  // ATH tracking for ladder mode
  ath: 0,
  athDistance: 0,
  athLastUpdate: 0,
});

/**
 * Create initial position state
 * @returns {RegimePositionState}
 */
const createInitialPositionState = () => ({
  totalAsset: 0,
  totalCostBasis: 0,
  avgCostBasis: 0,
  cycleBuys: 0,
  lastEntryPrice: 0,
  lastEntryTime: 0,
  anchorPrice: 0,
  activeTpOrderId: null,
  lastTpPrice: 0,
  cyclesCompleted: 0,
  unrealizedPnL: 0,
  realizedPnL: 0,
  realizedAssetPnL: 0,
  assetOnOrder: 0,
  maxDrawdownSeen: 0,
  scalingDisabled: false,
  scalingDisabledReason: null,
  // APY tracking fields
  engineStartTime: null,    // Timestamp when engine first started with capital
  initialCapital: 0,        // Initial capital (maxUsdcDeployed from config) - may be updated on restart
  originalCapital: 0,       // DEPRECATED: use depositedCapital instead
  depositedCapital: 0,      // Total user deposits (excludes profits) - updated when user adds capital
  // Ladder mode state
  ladderActive: false,
  ladderPlacedAt: null,
  ladderLowerBound: 0,
  pendingLadderOrders: [],  // [{orderId, price, sizeUsdc, ladderIndex}]
  // Legacy satellite state (migrated into celestialState on load)
});

/**
 * Create regime engine instance.
 *
 * Two signatures (string-typed second arg disambiguates):
 *   createRegimeEngine(exchange, exchangeConfig, callbacks)
 *   createRegimeEngine(exchange, pair, exchangeConfig, callbacks)
 *
 * @param {string} exchange
 * @param {string|Object} pairOrExchangeConfig
 * @param {Object} [exchangeConfigOrCallbacks]
 * @param {Object} [maybeCallbacks]
 * @returns {Object}
 */
const createRegimeEngine = (exchange, pairOrExchangeConfig, exchangeConfigOrCallbacks, maybeCallbacks) => {
  let pair;
  let exchangeConfig;
  let callbacks;
  if (typeof pairOrExchangeConfig === 'string') {
    pair = pairOrExchangeConfig;
    exchangeConfig = exchangeConfigOrCallbacks || {};
    callbacks = maybeCallbacks || {};
  } else {
    pair = null;
    exchangeConfig = pairOrExchangeConfig || {};
    callbacks = exchangeConfigOrCallbacks || {};
  }

  const { getDefaultPair } = require('./config-utils');
  if (!pair) pair = getDefaultPair(exchange) || exchangeConfig.productId || 'default';

  const { productId } = exchangeConfig;
  const config = getRegimeConfig(exchange, pair);
  const baseCurrency = getBaseCurrency(productId);

  // Prefix used in log lines and trade events to identify this fund
  const fundLabel = `${exchange}/${pair}`;

  // Throttled status update tracking
  let lastStatusUpdate = 0;
  const STATUS_UPDATE_INTERVAL = 1000; // 1 second throttle

  // Dry-run mode flag - use exchange-level config (same as DCA engine)
  // This ensures the UI toggle at exchanges.coinbase.dryRun controls both engines
  const isDryRun = exchangeConfig.dryRun === true;
  const modeLabel = isDryRun ? '[DRY-RUN] ' : '';

  // Create adapter
  const adapter = getAdapter(exchange);

  // Create all component instances
  const fillLedger = createFillLedger(exchange, productId, pair);
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
  const riskManager = createRiskManager(exchange, config, productId);

  // State (initialized before executor so dry-run can reference marketState)
  let marketState = createInitialMarketState();
  let positionState = createInitialPositionState();
  let priceIncrement = 0.01; // Updated from product details in start()
  let productDetails = null; // Cached from start() for min-order-size checks

  // Track if cycle buys limit warning has been logged (to avoid log spam)
  let cycleBuysLimitWarningLogged = false;
  // Track if USDC cap exceeded warning has been logged (to avoid log spam)
  let usdcCapWarningLogged = false;
  // Track if budget exhausted warning has been logged (to avoid log spam)
  let budgetExhaustedWarningLogged = false;
  // Guard against concurrent ATH backfill requests
  let athUpdateInProgress = false;

  // Callbacks container for dry-run (populated after functions are defined)
  const dryRunCallbacks = {
    onBuyFill: null,
    onSellFill: null,
  };

  // Callbacks container for live mode fill detection (populated after functions are defined)
  const liveCallbacks = {
    onFillDetected: null,
  };

  // Create order executor - use dry-run executor when dryRun is enabled
  // Callbacks are set up later after internal functions are defined
  const orderExecutor = isDryRun
    ? createDryRunExecutor(exchange, config, marketState, {
        onBuyFill: (...args) => dryRunCallbacks.onBuyFill && dryRunCallbacks.onBuyFill(...args),
        onSellFill: (...args) => dryRunCallbacks.onSellFill && dryRunCallbacks.onSellFill(...args),
      }, productId)
    : createOrderExecutor(exchange, config, adapter, productId, {
        onFillDetected: (orderId, status) => liveCallbacks.onFillDetected && liveCallbacks.onFillDetected(orderId, status),
        onEntryCancelled: (orderId) => {
          if (positionState.pendingEntryOrders?.length > 0) {
            positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(e => e.orderId !== orderId);
          }
        },
      });

  const recoveryModule = createRecoveryModule(exchange, adapter, productId);

  // Create TP optimizer for dynamic TP adjustment
  const tpOptimizer = createTpOptimizer(exchange, config, {
    onAdjustment: (adjustment) => {
      console.log(`📊 [${exchange}] ${modeLabel}TP auto-adjusted: min=${adjustment.tpMinPercent}% max=${adjustment.tpMaxPercent}% holdbackRatio=${adjustment.holdbackRatio}`);
    },
  });

  // Create Size optimizer for dynamic position sizing
  const sizeOptimizer = createSizeOptimizer(exchange, config, {
    onAdjustment: (adjustment) => {
      console.log(`📊 [${exchange}] ${modeLabel}Size auto-adjusted: ${adjustment.reason}`);
    },
  });

  // Create Ladder calculator for pre-positioned liquidity ladder mode
  const ladderCalculator = createLadderCalculator(exchange, config);

  // Create Macro Regime detector (multi-timeframe EMA overlay)
  const macroRegime = config.macroEnabled
    ? createMacroRegime(exchange, config, adapter, productId)
    : null;

  let isRunning = false;
  let wsFeed = null;
  let metricsInterval = null;
  let reconcileInterval = null;
  let stateSaveInterval = null;
  let entryInProgress = false; // Lock to prevent concurrent entry evaluations
  let insufficientFundsCooldownUntil = 0; // Cooldown after InsufficientFunds to prevent rapid retry spam
  const recentlyProcessedFills = new Set(); // Dedup guard: prevents double-processing when stale check and fill check race
  const recentlyProcessedSellFills = new Set(); // Dedup guard: prevents sell orders from being processed twice across WS/reconcile/polling
  const tpPlacementInFlight = new Set(); // Dedup guard: prevents concurrent placeBodyTp calls for the same body

  // Race 3: Merge-snapshot maps for fills arriving after body removal during merges
  // tpOrderId → body snapshot (active during merge operation)
  const pendingMergeTpOrders = new Map();
  // tpOrderId → body snapshot (completed merges, auto-expire after 60s)
  const completedMergeTpOrders = new Map();

  // Track TTL timers for cleanup on shutdown
  const ttlTimers = new Set();

  /**
   * Handle TP optimizer adjustment
   * Updates in-memory config and persists to config.json
   * @param {Object} adjustment - Adjustment from optimizer
   */
  const handleTpAdjustment = (adjustment) => {
    // Update in-memory config
    config.tpMinPercent = adjustment.tpMinPercent;
    config.tpMaxPercent = adjustment.tpMaxPercent;
    config.holdbackRatio = adjustment.holdbackRatio;

    // Persist to config.json
    updateRegimeConfig(exchange, pair, {
      tpMinPercent: adjustment.tpMinPercent,
      tpMaxPercent: adjustment.tpMaxPercent,
      holdbackRatio: adjustment.holdbackRatio,
    });

    tradeEvents.emitTradeEvent('tp_adjusted', exchange, `TP adjusted: ${adjustment.tpMinPercent}%-${adjustment.tpMaxPercent}%`, {
      tpMinPercent: adjustment.tpMinPercent,
      tpMaxPercent: adjustment.tpMaxPercent,
      holdbackRatio: adjustment.holdbackRatio,
      reason: adjustment.reason,
    });
  };

  /**
   * Handle Size optimizer adjustment
   * Updates in-memory config and persists to config.json
   * @param {Object} adjustment - Adjustment from optimizer
   */
  const handleSizeAdjustment = (adjustment) => {
    const updates = {
      baseSizeUsdc: adjustment.baseSizeUsdc,
      maxUsdcDeployed: adjustment.maxUsdcDeployed,
    };

    // Optionally update max cycle buys
    if (adjustment.maxCycleBuys !== undefined) {
      updates.maxCycleBuys = adjustment.maxCycleBuys;
      config.maxCycleBuys = adjustment.maxCycleBuys;
    }

    // Update in-memory config
    config.baseSizeUsdc = adjustment.baseSizeUsdc;
    config.maxUsdcDeployed = adjustment.maxUsdcDeployed;

    // Persist to config.json
    updateRegimeConfig(exchange, pair, updates);

    tradeEvents.emitTradeEvent('size_adjusted', exchange, `Size adjusted: base=$${adjustment.baseSizeUsdc}`, {
      baseSizeUsdc: adjustment.baseSizeUsdc,
      maxUsdcDeployed: adjustment.maxUsdcDeployed,
      maxCycleBuys: adjustment.maxCycleBuys,
      reason: adjustment.reason,
    });
  };

  /**
   * Record cycle completion for TP optimizer
   * @param {Object} cycleData - Data about the completed cycle
   */
  const recordCycleForOptimizer = (cycleData) => {
    if (!config.tpAutoManaged) return;

    const adjustment = tpOptimizer.recordCycle({
      optimalTpPct: cycleData.optimalTpPct || 0,
      actualTpPct: cycleData.actualTpPct || 0,
      completedAt: Date.now(),
      volBaseline: marketState.volBaseline || 0,
    });

    if (adjustment) {
      handleTpAdjustment(adjustment);
    }
  };

  /**
   * Record cycle completion for Size optimizer
   * @param {Object} cycleData - Data about the completed cycle
   * @param {number} availableBalance - Current available USDC balance
   */
  const recordCycleForSizeOptimizer = (cycleData, availableBalance) => {
    if (!config.sizeAutoManaged) return;

    const adjustment = sizeOptimizer.recordCycle({
      stepsUsed: cycleData.stepsUsed || 0,
      capitalDeployed: cycleData.capitalDeployed || 0,
      completedAt: Date.now(),
      availableBalance: availableBalance || 0,
    });

    if (adjustment) {
      handleSizeAdjustment(adjustment);
    }
  };

  /**
   * Save dry-run state to disk
   */
  const saveDryRunState = () => {
    if (!isDryRun || !orderExecutor.exportState) return;

    // Persist macro regime state into position for recovery
    if (macroRegime) {
      positionState.macroRegime = macroRegime.getState();
    }

    dryRunState.saveState(exchange, {
      isDryRun: true,
      executor: orderExecutor.exportState(),
      position: { ...positionState },
      tpOptimizer: tpOptimizer.exportState(),
      sizeOptimizer: sizeOptimizer.exportState(),
    }, pair);
  };

  /**
   * Load dry-run state from disk
   * @returns {boolean} Whether state was loaded
   */
  const loadDryRunState = () => {
    if (!isDryRun || !orderExecutor.importState) return false;

    const savedState = dryRunState.loadState(exchange, pair);
    if (!savedState || !savedState.isDryRun) return false;

    // Restore executor state
    orderExecutor.importState(savedState.executor);

    // Restore position state
    if (savedState.position) {
      positionState = { ...createInitialPositionState(), ...savedState.position };
    }

    // Restore TP optimizer state
    if (savedState.tpOptimizer) {
      tpOptimizer.importState(savedState.tpOptimizer);
    }

    // Restore Size optimizer state
    if (savedState.sizeOptimizer) {
      sizeOptimizer.importState(savedState.sizeOptimizer);
    }

    // Log APY tracking state restoration
    const apyStatus = positionState.engineStartTime
      ? `APY from ${new Date(positionState.engineStartTime).toISOString()}`
      : 'APY not tracked yet';

    console.log(`📂 [${exchange}] [DRY-RUN] Restored state: ${positionState.cyclesCompleted} cycles, buys ${positionState.cycleBuys}, PnL=$${positionState.realizedPnL.toFixed(2)}, ${apyStatus}`);
    return true;
  };

  /**
   * Cap realizedAssetPnL at actual exchange reserves after body sells.
   * Prevents cumulative holdback inflation when bodies consolidate and re-sell.
   * Only reduces the value (never inflates), so it's safe even when the exchange
   * holds non-bot assets — the cap will just be higher than the stored value.
   */
  const reconcileAssetReserves = async () => {
    if (isDryRun) return;
    try {
      const bal = await adapter.getAccountBalance(baseCurrency);
      if (!bal) return;
      const totalExchangeAsset = (parseFloat(bal.available) || 0) + (parseFloat(bal.hold) || 0);
      // Use body sum directly (positionState.totalAsset may not be synced yet at startup)
      const bodyAssetSum = (positionState.celestialBodies || []).reduce((s, b) => s + (b.assetQty || 0), 0);
      const positionAsset = bodyAssetSum > 0 ? bodyAssetSum : (positionState.totalAsset || 0);
      const maxReserves = roundAsset(Math.max(0, totalExchangeAsset - positionAsset));
      if (positionState.realizedAssetPnL > maxReserves) {
        console.log(`📊 [${exchange}] Asset reserves capped: ${positionState.realizedAssetPnL.toFixed(2)} → ${maxReserves.toFixed(2)} ${baseCurrency} (exchange=${totalExchangeAsset.toFixed(2)}, bodies=${positionAsset.toFixed(2)})`);
        positionState.realizedAssetPnL = maxReserves;
        if (positionState.celestialState) {
          positionState.celestialState.bodiesRealizedAssetPnL = maxReserves;
        }
      }
    } catch (err) { /* non-critical — next sell will retry */ }
  };

  /**
   * Save live state to disk (for faster recovery on restarts)
   */
  const saveLiveState = () => {
    if (isDryRun) return;

    // Persist macro regime state into position for recovery
    if (macroRegime) {
      positionState.macroRegime = macroRegime.getState();
    }

    // Cap asset reserves at actual exchange balance before saving
    reconcileAssetReserves().catch(() => {});

    const regimeState = regimeDetector.getState();
    const tpOptimizerState = tpOptimizer.exportState();
    const sizeOptimizerState = sizeOptimizer.exportState();
    saveRegimeState(positionState, regimeState, exchange, tpOptimizerState, sizeOptimizerState, pair);
  };

  /**
   * Load live state from disk
   * @returns {boolean} Whether state was loaded
   */
  const loadLiveState = () => {
    if (isDryRun) return false;

    const savedState = loadRegimeState(exchange, pair);
    const pos = savedState.position;
    // Check if state has any meaningful data (not just default initial state)
    // Even with totalAsset=0, there may be satellites, TP orders, or historical data to restore
    const hasMeaningfulState = pos && (
      pos.totalAsset > 0
      || pos.cyclesCompleted > 0
      || pos.activeTpOrderId
      || (pos.celestialBodies && pos.celestialBodies.length > 0)
      || pos.realizedPnL > 0
    );
    if (!hasMeaningfulState) {
      console.log(`ℹ️ [${exchange}] No saved live state or empty position`);
      // Still restore optimizer states even if no position
      if (savedState.tpOptimizer) {
        tpOptimizer.importState(savedState.tpOptimizer);
      }
      if (savedState.sizeOptimizer) {
        sizeOptimizer.importState(savedState.sizeOptimizer);
      }
      return false;
    }

    positionState = { ...createInitialPositionState(), ...savedState.position };
    if (savedState.regime) {
      regimeDetector.restoreState(savedState.regime);
    }
    if (savedState.tpOptimizer) {
      tpOptimizer.importState(savedState.tpOptimizer);
    }
    if (savedState.sizeOptimizer) {
      sizeOptimizer.importState(savedState.sizeOptimizer);
    }

    console.log(`📂 [${exchange}] Loaded saved state: ${positionState.cyclesCompleted} cycles, buys ${positionState.cycleBuys}, ${positionState.totalAsset.toFixed(6)} ${baseCurrency}`);
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
        const rawFills = await adapter.getOrderFills(positionState.activeTpOrderId);
        const ingestedFills = [];
        for (const fill of rawFills) {
          const result = fillLedger.ingestFill(fill);
          if (result.fill) ingestedFills.push(result.fill);
        }

        // Use ingested fills (with quoteAmount) for aggregation
        const fillsToAggregate = ingestedFills.length > 0
          ? ingestedFills
          : fillLedger.getFillsForOrder(positionState.activeTpOrderId);

        // Calculate P&L from the fills
        const summary = fillLedger.aggregateFills(fillsToAggregate);
        const proceeds = summary.totalValue - summary.totalFees;
        const soldCostBasis = summary.totalSize * positionState.avgCostBasis;
        const pnl = proceeds - soldCostBasis;
        const holdbackAsset = roundAsset(positionState.totalAsset - summary.totalSize);

        positionState.realizedPnL += pnl;
        positionState.realizedAssetPnL += holdbackAsset;
        positionState.cyclesCompleted += 1;

        console.log(`💰 [${exchange}] Offline TP fill: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackAsset.toFixed(6)} ${baseCurrency}`);

        tradeEvents.emitTradeEvent('tp_filled', exchange, `[OFFLINE] ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          pnl,
          holdbackAsset,
          offlineFill: true,
        });

        // Reset cycle
        await resetCycle();
      }
    }

    // Check for celestial body TP orders that filled while offline
    const offlineBodies = positionState.celestialBodies || [];
    for (const body of [...offlineBodies]) {
      if (body.tpOrderId && !openOrderIds.has(body.tpOrderId)) {
        const orderStatus = await adapter.getOrder(body.tpOrderId).catch(() => null);
        if (orderStatus && orderStatus.status === 'FILLED') {
          const tierCfg = celestialHierarchy.getTierConfig(body.tier);
          console.log(`${tierCfg.emoji} [${exchange}] Body TP ${body.tpOrderId} filled while offline`);

          const rawFills = await adapter.getOrderFills(body.tpOrderId);
          const ingestedFills = [];
          for (const fill of rawFills) {
            const result = fillLedger.ingestFill(fill);
            if (result.fill) ingestedFills.push(result.fill);
          }

          const fillsForBody = ingestedFills.length > 0
            ? ingestedFills
            : fillLedger.getFillsForOrder(body.tpOrderId);
          const summary = fillLedger.aggregateFills(fillsForBody);

          const proceeds = summary.totalValue - summary.totalFees;
          // Prorate cost basis when sell doesn't cover full body (stale TP / partial fill)
          const soldRatio = body.assetQty > 0 ? Math.min(summary.totalSize / body.assetQty, 1) : 1;
          const proratedCostBasis = roundUSDC(body.costBasis * soldRatio);
          const pnl = proceeds - proratedCostBasis;
          const holdbackAsset = roundAsset(body.assetQty - summary.totalSize);

          const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
          cs.bodiesCompleted += 1;
          cs.bodiesRealizedPnL += pnl;
          cs.bodiesRealizedAssetPnL += holdbackAsset;
          positionState.celestialState = cs;

          positionState.realizedPnL += pnl;
          positionState.realizedAssetPnL += holdbackAsset;

          const prevMaxUsdc = config.maxUsdcDeployed;
          config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
          updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

          positionState.celestialBodies = positionState.celestialBodies.filter(
            b => b.tpOrderId !== body.tpOrderId
          );

          if (orderExecutor.removeBodyTracking) {
            orderExecutor.removeBodyTracking(body.tpOrderId);
          }

          fillLedger.annotateFillsByOrderId(body.tpOrderId, {
            isBodyOwned: true,
            bodyId: body.id,
            bodyTier: body.tier,
            bodyCostBasis: body.costBasis,
            bodyAvgPrice: body.avgPrice,
            bodyBtcQty: body.assetQty,
            bodyHoldbackAsset: holdbackAsset,
            bodyPnl: pnl,
          });

          // Link source buy fills to this sell for buy→sell display linkage
          const offlineAnnotatedSrcIds = new Set();
          for (const srcId of (body.sourceOrderIds || [])) {
            fillLedger.annotateFillsByOrderId(srcId, { sellOrderId: body.tpOrderId });
            offlineAnnotatedSrcIds.add(srcId);
          }
          for (const buyOrder of (body.buyOrders || [])) {
            if (buyOrder.orderId !== 'core-migration' && !offlineAnnotatedSrcIds.has(buyOrder.orderId)) {
              fillLedger.annotateFillsByOrderId(buyOrder.orderId, { sellOrderId: body.tpOrderId });
            }
          }

          // Sync aggregates after body removal
          celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

          console.log(`${tierCfg.emoji} [${exchange}] Offline body fill: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

          tradeEvents.emitTradeEvent('body_tp_filled', exchange, `[OFFLINE] ${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
            assetAmount: summary.totalSize,
            price: summary.avgPrice,
            pnl,
            holdbackAsset,
            bodyId: body.id,
            bodyTier: body.tier,
            offlineFill: true,
          });
        }
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
          const rawFills = await adapter.getOrderFills(orderId);
          const ingestedFills = [];
          for (const fill of rawFills) {
            const result = fillLedger.ingestFill(fill);
            if (result.fill) ingestedFills.push(result.fill);
          }

          // Use ingested fills (with quoteAmount) for aggregation
          const fillsToAggregate = ingestedFills.length > 0
            ? ingestedFills
            : fillLedger.getFillsForOrder(orderId);

          // Update position
          const summary = fillLedger.aggregateFills(fillsToAggregate);
          positionState.totalAsset = roundAsset(positionState.totalAsset + summary.totalSize);
          positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + summary.totalValue + summary.totalFees);
          positionState.avgCostBasis = positionState.totalAsset > 0
            ? positionState.totalCostBasis / positionState.totalAsset
            : 0;
          positionState.cycleBuys += 1;
          positionState.lastEntryPrice = summary.avgPrice;
          positionState.lastEntryTime = Date.now();

          // Remove filled entry from persisted pending orders
          if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
            positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(
              e => e.orderId !== orderId
            );
          }

          orderExecutor.handleOrderFill(orderId);

          // Place/update TP order to reflect new position size (force update to bypass anti-churn)
          await placeTakeProfitOrder({ forceUpdate: true });

          tradeEvents.emitTradeEvent('buy_filled', exchange, `[OFFLINE] ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}`, {
            assetAmount: summary.totalSize,
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
    if (positionState.totalAsset <= 0) {
      console.log(`ℹ️ [${exchange}] No position to re-evaluate`);
      return;
    }

    const lastEntryPrice = positionState.lastEntryPrice || positionState.avgCostBasis;
    if (lastEntryPrice <= 0) return;

    const priceChange = ((currentPrice - lastEntryPrice) / lastEntryPrice) * 100;
    const priceChangeAbs = Math.abs(priceChange);

    console.log(`📊 [${exchange}] Re-evaluating position: price moved ${priceChange.toFixed(2)}% since last entry (${fmtPrice(lastEntryPrice)} -> ${fmtPrice(currentPrice)})`);

    // Re-anchor price for volatility triggers
    positionState.anchorPrice = currentPrice;
    console.log(`⚓ [${exchange}] Re-anchored price to ${fmtPrice(currentPrice)}`);

    // If price dropped significantly (>5%), consider the position may need attention
    if (priceChange < -5) {
      console.log(`⚠️ [${exchange}] Price dropped ${priceChangeAbs.toFixed(2)}% while offline - position unrealized P&L affected`);
    }

    // If price rose significantly and we have a position, TP might need updating
    if (priceChange > 3 && positionState.totalAsset > 0) {
      console.log(`📈 [${exchange}] Price rose ${priceChangeAbs.toFixed(2)}% while offline - TP order may need adjustment`);
      // TP order will be re-evaluated naturally on next metrics update
    }
  };

  // APY calculation delegates to extracted module
  const calculateApyMetrics = () => _calculateApyMetrics(positionState, config, marketState);
  const initializeApyTracking = () => _initializeApyTracking(
    positionState, config, exchange,
    orderExecutor.getFilledOrders ? () => orderExecutor.getFilledOrders() : undefined
  );

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

    // Fetch product details for price tick size (affects TP price rounding)
    productDetails = await adapter.getProductDetails(productId).catch((err) => {
      console.log(`⚠️ [${exchange}] Could not fetch product details: ${err.message}, using default price increment`);
      return null;
    });
    if (productDetails?.quoteIncrement) {
      priceIncrement = parseFloat(productDetails.quoteIncrement) || 0.01;
      console.log(`📏 [${exchange}] Price increment: ${priceIncrement}`);
    }
    if (orderExecutor.setPriceIncrement) {
      orderExecutor.setPriceIncrement(priceIncrement);
    }

    // Recover state from exchange (skip in dry-run mode)
    if (!isDryRun) {
      // First, try to load saved state for faster startup
      const hasSavedState = loadLiveState();

      // Then recover/validate from exchange (source of truth)
      const { position } = await recoveryModule.recoverState(fillLedger, orderExecutor);

      // Merge recovered position with any saved state
      // IMPORTANT: If saved state shows totalAsset=0 with cyclesCompleted>0, this means
      // a cycle was properly completed and reset. The recovery from fills will show
      // the "holdback" BTC as position (sum of buys minus sells), but this is NOT
      // an active position - it's accumulated BTC reserves from completed cycles.
      // Trust the saved state in this case.
      const savedTpOrderId = positionState.activeTpOrderId;
      const savedTpPrice = positionState.lastTpPrice;
      const savedTotalBTC = positionState.totalAsset;
      const savedCyclesCompleted = positionState.cyclesCompleted;
      // Cross-validate: if fill ledger has buys in the current cycle, the cycle is NOT completed
      // (saved state may have been corrupted by a previous buggy restart)
      const fillLedgerHasBuys = fillLedger.getCurrentCycleBuysCount() > 0;
      const cycleWasCompleted = hasSavedState && savedTotalBTC === 0 && savedCyclesCompleted > 0
        && !fillLedgerHasBuys;

      if (cycleWasCompleted) {
        console.log(`ℹ️ [${exchange}] Saved state shows completed cycle (${savedCyclesCompleted} cycles, 0 ${baseCurrency} position) - trusting saved state over recovery`);
      }

      positionState = {
        ...createInitialPositionState(),
        ...positionState, // Keep saved fields (realizedPnL, cyclesCompleted, celestialBodies, etc.)
        // Only override position fields that come from fill-ledger rebuild
        // (NOT realizedPnL, cyclesCompleted, celestialBodies, celestialState, etc.)
        totalAsset: cycleWasCompleted ? 0 : position.totalAsset,
        totalCostBasis: cycleWasCompleted ? 0 : position.totalCostBasis,
        avgCostBasis: cycleWasCompleted ? 0 : position.avgCostBasis,
        cycleBuys: cycleWasCompleted ? 0 : position.cycleBuys,
        lastEntryPrice: position.lastEntryPrice || positionState.lastEntryPrice,
        lastEntryTime: position.lastEntryTime || positionState.lastEntryTime,
        anchorPrice: position.anchorPrice || positionState.anchorPrice,
        activeTpOrderId: savedTpOrderId, // Restore TP tracking (not in fills)
        lastTpPrice: savedTpPrice,
      };

      // Auto-correct cycleBuys from fill ledger (source of truth)
      const actualCycleBuys = fillLedger.getCurrentCycleBuysCount();
      if (positionState.cycleBuys !== actualCycleBuys) {
        console.log(`🔧 [${exchange}] Auto-correcting cycleBuys: ${positionState.cycleBuys} -> ${actualCycleBuys} (from fill ledger)`);
        positionState.cycleBuys = actualCycleBuys;
      }

      // Check for orders that filled while we were offline (non-critical, continue on error)
      const offlineFills = await checkOfflineOrderFills().catch(err => {
        console.log(`⚠️ [${exchange}] Failed to check offline fills: ${err.message}`);
        return { tpFilled: false, entriesFilled: 0 };
      });
      if (offlineFills.tpFilled || offlineFills.entriesFilled > 0) {
        console.log(`📋 [${exchange}] Processed offline fills: TP=${offlineFills.tpFilled}, entries=${offlineFills.entriesFilled}`);
      }

      // Get current price and re-evaluate position
      const currentPrice = await adapter.getCurrentPrice(productId);
      if (currentPrice > 0 && positionState.totalAsset > 0) {
        reEvaluateAfterDowntime(currentPrice);
      }

      // If we have position but no TP order, place one
      if (positionState.totalAsset > 0 && !positionState.activeTpOrderId) {
        console.log(`📝 [${exchange}] Position exists but no TP order, will place after metrics update`);
      }

      // Restore TP order tracking if we have an active TP order ID - but validate it exists first
      if (positionState.activeTpOrderId) {
        const tpOrderStatus = await adapter.getOrder(positionState.activeTpOrderId).catch(() => null);
        const tpOrderExists = tpOrderStatus && tpOrderStatus.status !== 'CANCELLED' && tpOrderStatus.status !== 'FAILED';

        if (tpOrderExists && orderExecutor.restorePendingOrder) {
          // Check if a celestial body owns this TP — restore as body_tp if so
          const bodyOwner = (positionState.celestialBodies || []).find(b => b.tpOrderId === positionState.activeTpOrderId);
          if (bodyOwner && orderExecutor.restoreBodyTpOrder) {
            const placedAt = tpOrderStatus.createdTime ? new Date(tpOrderStatus.createdTime).getTime() : (positionState.lastEntryTime || Date.now());
            orderExecutor.restoreBodyTpOrder(bodyOwner.id, positionState.activeTpOrderId, bodyOwner.assetQty, positionState.lastTpPrice, placedAt);
            console.log(`📋 [${exchange}] Restored legacy TP as body_tp: ${positionState.activeTpOrderId.slice(0, 8)} → body ${bodyOwner.id.slice(-8)}`);
            positionState.activeTpOrderId = null;
            positionState.lastTpPrice = 0;
            positionState.assetOnOrder = 0;
          } else {
            orderExecutor.restorePendingOrder(positionState.activeTpOrderId, {
              type: 'take_profit',
              price: positionState.lastTpPrice,
              size: positionState.assetOnOrder || positionState.totalAsset,
              sizeUsdc: (positionState.lastTpPrice || 0) * (positionState.assetOnOrder || positionState.totalAsset),
              placedAt: tpOrderStatus.createdTime ? new Date(tpOrderStatus.createdTime).getTime() : (positionState.lastEntryTime || Date.now()),
              status: 'open',
            });
            console.log(`📋 [${exchange}] Restored TP order tracking: ${positionState.activeTpOrderId} @ ${fmtPrice(positionState.lastTpPrice)}`);
          }
        } else {
          // TP order no longer exists on exchange - clear tracking so a new one gets placed
          console.log(`⚠️ [${exchange}] Saved TP order ${positionState.activeTpOrderId} not found on exchange, clearing`);
          positionState.activeTpOrderId = null;
          positionState.lastTpPrice = 0;
          positionState.assetOnOrder = 0;
        }
      }

      // Cancel stale orders flagged for cleanup (e.g. partially-filled TPs from prior crashes)
      if (positionState._cancelOnStartup?.length > 0) {
        for (const staleOrderId of [...positionState._cancelOnStartup]) {
          const cancelResult = await adapter.cancelOrder(staleOrderId).catch(() => ({ success: false }));
          if (cancelResult.success) {
            console.log(`🗑️ [${exchange}] Cancelled stale order from _cancelOnStartup: ${staleOrderId}`);
          } else {
            const status = await adapter.getOrder(staleOrderId).catch(() => null);
            if (status && (status.status === 'FILLED' || status.status === 'CANCELLED')) {
              console.log(`ℹ️ [${exchange}] Stale order ${staleOrderId} already ${status.status}`);
            } else {
              console.log(`⚠️ [${exchange}] Failed to cancel stale order ${staleOrderId}`);
              continue; // Keep failed IDs for next startup
            }
          }
          positionState._cancelOnStartup = positionState._cancelOnStartup.filter(id => id !== staleOrderId);
        }
        if (positionState._cancelOnStartup.length === 0) {
          delete positionState._cancelOnStartup;
        }
      }

      // Restore celestial body TP order tracking from saved state
      const savedBodies = positionState.celestialBodies || [];
      if (savedBodies.length > 0) {
        let restoredBodies = 0;
        let expiredBodies = 0;

        // Backfill buyOrders for bodies that predate the tracking field
        for (const body of savedBodies) {
          if (!body.buyOrders) {
            body.buyOrders = (body.sourceOrderIds || []).map(oid => ({
              orderId: oid,
              price: body.avgPrice,
              assetQty: 0,
              sizeUsdc: 0,
              filledAt: body.createdAt || Date.now(),
            }));
          }
        }

        // Self-heal avgPrice for bodies where roundUSDC truncated precision
        for (const body of savedBodies) {
          if (body.assetQty > 0 && body.costBasis > 0) {
            const correctedAvg = body.costBasis / body.assetQty;
            if (Math.abs(correctedAvg - body.avgPrice) / correctedAvg > 0.001) {
              console.log(`🔧 [${exchange}] correcting body avgPrice bodyId=${body.id} old=${body.avgPrice} new=${correctedAvg}`);
              body.avgPrice = correctedAvg;
            }
          }
        }

        for (const body of [...savedBodies]) {
          if (!body.tpOrderId) continue;

          const bodyStatus = await adapter.getOrder(body.tpOrderId).catch(() => null);
          const bodyExists = bodyStatus && bodyStatus.status !== 'CANCELLED' && bodyStatus.status !== 'FAILED';

          if (bodyExists && bodyStatus.status === 'FILLED') {
            // Body filled while offline — handled in checkOfflineOrderFills above
            continue;
          }

          if (bodyExists && orderExecutor.restoreBodyTpOrder) {
            const bodyPlacedAt = bodyStatus.createdTime ? new Date(bodyStatus.createdTime).getTime() : Date.now();
            orderExecutor.restoreBodyTpOrder(
              body.id,
              body.tpOrderId,
              body.assetOnOrder || body.assetQty,
              body.tpPrice,
              bodyPlacedAt
            );
            restoredBodies++;
          } else {
            // Body TP no longer on exchange — re-place TP
            body.tpOrderId = null;
            expiredBodies++;
          }
        }

        if (restoredBodies > 0) console.log(`🌌 [${exchange}] Restored ${restoredBodies} celestial body TP orders`);
        if (expiredBodies > 0) console.log(`⚠️ [${exchange}] ${expiredBodies} body TP orders need re-placement`);

        // Reprice any restored body TPs whose TP% exceeds the effective max
        // (fixes bodies that were placed with uncapped holdback floor)
        // Cancel directly via adapter since executor map may not be populated yet
        for (const body of savedBodies) {
          if (!body.tpOrderId || body.avgPrice <= 0) continue;
          // Skip bodies with a manual TP override — user intentionally set this price
          if (body.manualTpPct != null) continue;
          const currentTpPct = ((body.tpPrice - body.avgPrice) / body.avgPrice) * 100;
          const bTierCfg = celestialHierarchy.getTierConfig(body.tier);
          const bEffectiveMax = config.tpMaxPercent * (bTierCfg.tpMaxScale || 1);
          if (currentTpPct > bEffectiveMax * 1.01) {
            console.log(`⚠️ [${exchange}] Body ${body.id.slice(-8)} TP% ${currentTpPct.toFixed(2)}% exceeds max ${bEffectiveMax.toFixed(2)}% — cancelling and repricing`);
            const cancelResult = await adapter.cancelOrder(body.tpOrderId);
            if (cancelResult.success) {
              if (orderExecutor.removeBodyTracking) orderExecutor.removeBodyTracking(body.tpOrderId);
              body.tpOrderId = null;
              body.tpPrice = 0;
              body.assetOnOrder = 0;
              await placeBodyTp(body);
            } else {
              const status = await adapter.getOrder(body.tpOrderId).catch(() => null);
              if (status && (status.status === 'FILLED' || status.completionPercentage >= 100)) {
                console.log(`📋 [${exchange}] Overpriced body TP ${body.tpOrderId.slice(0, 8)} already filled — polling will process`);
              } else {
                console.log(`⚠️ [${exchange}] Failed to cancel overpriced body TP ${body.tpOrderId}: ${cancelResult.errorMessage || 'unknown'}`);
              }
            }
          }
        }
      }

      // Detect orphaned sell orders on exchange that we lost track of
      const exchangeOpenOrders = await adapter.getOpenOrders(productId);
      const trackedSellIds = new Set();
      if (positionState.activeTpOrderId) trackedSellIds.add(positionState.activeTpOrderId);
      for (const body of (positionState.celestialBodies || [])) {
        if (body.tpOrderId) trackedSellIds.add(body.tpOrderId);
      }
      const orphanedSells = exchangeOpenOrders.filter(o =>
        o.side.toUpperCase() === 'SELL' && !trackedSellIds.has(o.orderId) && o.size > 0
      );

      // Log orphaned sell orders but do NOT adopt them. Automatic reclamation
      // is unsafe — it can sell non-engine assets (user holdings, other bots).
      if (orphanedSells.length > 0) {
        for (const order of orphanedSells) {
          console.log(`⚠️ [${exchange}] Untracked sell order on exchange: ${order.orderId.slice(0, 8)} ${order.size.toFixed(8)} ${baseCurrency} @ ${fmtPrice(order.price)} — NOT adopting (manual review required)`);
        }
      }

      // Retroactively annotate body fills that are missing isBodyOwned flag
      // This fixes historical fills that were processed before annotation code was deployed
      const currentCycleId = fillLedger.getCurrentCycleId();
      if (currentCycleId) {
        const cycleFills = fillLedger.getCurrentCycleFills();
        const coreTpOrderId = positionState.activeTpOrderId;
        let annotatedCount = 0;

        // 1. Annotate buy fills for active celestial bodies (use both sourceOrderIds and buyOrders)
        // Also fix fills that have isBodyOwned but are missing bodyId (e.g. from DCA merge converter)
        for (const body of (positionState.celestialBodies || [])) {
          const annotation = { isBodyOwned: true, bodyId: body.id, bodyTier: body.tier };
          if (body.tpOrderId) annotation.sellOrderId = body.tpOrderId;
          const seen = new Set();
          for (const srcOrderId of (body.sourceOrderIds || [])) {
            const buyFills = cycleFills.filter(f => f.orderId === srcOrderId && !(f.isSatellite) && (!f.isBodyOwned || !f.bodyId));
            if (buyFills.length > 0) {
              fillLedger.annotateFillsByOrderId(srcOrderId, annotation);
              annotatedCount += buyFills.length;
            }
            seen.add(srcOrderId);
          }
          for (const buyOrder of (body.buyOrders || [])) {
            if (buyOrder.orderId === 'core-migration' || seen.has(buyOrder.orderId)) continue;
            const buyFills = cycleFills.filter(f => f.orderId === buyOrder.orderId && !(f.isSatellite) && (!f.isBodyOwned || !f.bodyId));
            if (buyFills.length > 0) {
              fillLedger.annotateFillsByOrderId(buyOrder.orderId, annotation);
              annotatedCount += buyFills.length;
            }
          }
        }

        // 2. Find unannotated or badly-annotated body sells
        // (non-core-TP sells missing isBodyOwned, or with negative PnL/holdback)
        const sellsToAnnotate = cycleFills.filter(f =>
          f.side === 'sell' && f.orderId !== coreTpOrderId
          && (!(f.isBodyOwned || f.isSatellite) || (f.bodyPnl ?? f.satellitePnl) < 0 || (f.bodyHoldbackAsset ?? f.satelliteHoldbackAsset) < 0)
        );
        const buyFills = cycleFills.filter(f => f.side === 'buy');
        const consumedBuyOrderIds = new Set();

        for (const sellFill of sellsToAnnotate) {
          // Find matching buy: similar BTC size, closest in time to the sell
          // (satellite TP is placed right after its buy, so the buy should be temporally close)
          const candidates = buyFills.filter(buy => {
            if (consumedBuyOrderIds.has(buy.orderId)) return false;
            const sizeRatio = buy.size / sellFill.size;
            return sizeRatio > 0.99 && sizeRatio < 1.01
              && buy.timestamp < sellFill.timestamp;
          });
          // Pick the candidate closest in time to the sell
          const matchingBuy = candidates.length > 0
            ? candidates.reduce((best, buy) =>
              (sellFill.timestamp - buy.timestamp) < (sellFill.timestamp - best.timestamp) ? buy : best
            )
            : null;

          if (matchingBuy) {
            consumedBuyOrderIds.add(matchingBuy.orderId);
            const costBasis = matchingBuy.quoteAmount + (matchingBuy.netFee || matchingBuy.fee || 0);
            const proceeds = sellFill.quoteAmount - (sellFill.netFee || sellFill.fee || 0);
            const pnl = proceeds - costBasis;
            const holdbackAsset = roundAsset(matchingBuy.size - sellFill.size);

            // Sanity check: body PnL should be positive and holdback non-negative
            if (pnl >= 0 && holdbackAsset >= 0) {
              fillLedger.annotateFillsByOrderId(sellFill.orderId, {
                isBodyOwned: true,
                bodyCostBasis: costBasis,
                bodyAvgPrice: matchingBuy.price,
                bodyBtcQty: matchingBuy.size,
                bodyHoldbackAsset: holdbackAsset,
                bodyPnl: pnl,
              });
              fillLedger.annotateFillsByOrderId(matchingBuy.orderId, { isBodyOwned: true, sellOrderId: sellFill.orderId });
              annotatedCount += 2;
              console.log(`🔧 [${exchange}] Annotated body sell: ${sellFill.orderId.slice(0, 8)} PnL=$${pnl.toFixed(4)}, holdback=${holdbackAsset.toFixed(8)} ${baseCurrency}`);
            } else {
              // Mark as body-owned but without computed values (dashboard will show raw data)
              fillLedger.annotateFillsByOrderId(sellFill.orderId, { isBodyOwned: true });
              annotatedCount++;
              console.log(`⚠️ [${exchange}] Marked body sell ${sellFill.orderId.slice(0, 8)} (no matching buy found with valid PnL)`);
            }
          }
        }

        // 3. Fix fills with wrong cycle IDs (e.g., recovered-* cycles that belong here)
        // Only move fills that are within the current cycle's timeframe
        const currentCycleFills = fillLedger.getCurrentCycleFills();
        const cycleStartTs = currentCycleFills.length > 0
          ? Math.min(...currentCycleFills.map(f => f.timestamp))
          : Date.now();
        const allFillsRaw = fillLedger.getAllFills();
        for (const fill of allFillsRaw) {
          if (fill.cycleId && fill.cycleId.includes('-recovered-')
            && fill.cycleId !== currentCycleId && fill.timestamp >= cycleStartTs) {
            const oldCycleId = fill.cycleId;
            fillLedger.updateFillCycleId(fill.tradeId, currentCycleId);
            annotatedCount++;
            console.log(`🔧 [${exchange}] Moved fill ${fill.tradeId.slice(0, 8)} from ${oldCycleId} to ${currentCycleId}`);
          }
        }

        if (annotatedCount > 0) {
          fillLedger.persist();
          console.log(`🔧 [${exchange}] Annotated ${annotatedCount} satellite fills for correct tracking`);
        }
      }

      // Sync position totals from celestial bodies (ensures recovery didn't zero them out)
      if ((positionState.celestialBodies || []).length > 0) {
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
      }

      // Recalculate cycles from fill ledger to ensure accurate P&L tracking
      // This catches any discrepancies between saved state and actual fills
      // Note: recalculateCycles skips satellite fills — body/satellite P&L tracked separately
      const recalcResult = fillLedger.recalculateCycles();
      if (recalcResult.cyclesCompleted > 0 || recalcResult.orphansFixed > 0) {
        const totalPnL = recalcResult.globalRealizedPnL;
        const totalAssetPnL = recalcResult.globalRealizedAssetPnL;
        console.log(`🔧 [${exchange}] Auto-recalculated from fills: ${recalcResult.cyclesCompleted} cycles, globalPnL=$${totalPnL.toFixed(2)}, ${baseCurrency} reserves=${totalAssetPnL.toFixed(6)}`);
        positionState.cyclesCompleted = recalcResult.cyclesCompleted;
        positionState.realizedPnL = totalPnL;
        // Only update realizedAssetPnL if recalc gives a lower/equal value, OR if
        // the saved value is 0 (recovery from baseCurrency bug). Body consolidation
        // inflates the fill-ledger holdback sum, so we preserve the saved value
        // (which may have been corrected by reconcileAssetReserves or manual fix).
        if (totalAssetPnL <= positionState.realizedAssetPnL || positionState.realizedAssetPnL === 0) {
          positionState.realizedAssetPnL = totalAssetPnL;
        }
        // Keep celestial body P&L counter in sync
        const bodyOnlyPnL = totalPnL - recalcResult.realizedPnL;
        const bodyOnlyBtcPnL = totalAssetPnL - recalcResult.realizedAssetPnL;
        if (positionState.celestialState) {
          positionState.celestialState.bodiesRealizedPnL = Math.round(bodyOnlyPnL * 100) / 100;
          positionState.celestialState.bodiesRealizedAssetPnL = Math.round(bodyOnlyBtcPnL * 1e8) / 1e8;
        }
      }

      // Backfill APY tracking start time from earliest fill in ledger
      const allFills = fillLedger.getAllFills();
      if (allFills.length > 0) {
        const earliestFillTime = allFills.reduce((earliest, fill) => {
          return fill.timestamp < earliest ? fill.timestamp : earliest;
        }, Infinity);
        if (earliestFillTime !== Infinity && (!positionState.engineStartTime || positionState.engineStartTime > earliestFillTime)) {
          positionState.engineStartTime = earliestFillTime;
          positionState.initialCapital = config.maxUsdcDeployed || 10000;
          // Only set originalCapital if not already set (preserve true starting value)
          if (!positionState.originalCapital) {
            positionState.originalCapital = positionState.initialCapital;
          }
          console.log(`📊 [${exchange}] APY tracking backfilled to first fill: ${new Date(earliestFillTime).toISOString()}, original=$${positionState.originalCapital}`);
        }
      }

      // Restore pending entry orders from saved state (instead of canceling them)
      const savedPendingEntries = positionState.pendingEntryOrders || [];
      const savedOrderIds = new Set(savedPendingEntries.map(e => e.orderId));

      // Reuse exchangeOpenOrders from orphan satellite detection above
      const openEntries = exchangeOpenOrders.filter(o => o.side.toUpperCase() === 'BUY');

      // Pre-build ladder order ID set so we don't flag them as orphans
      const savedLadderIds = new Set((positionState.pendingLadderOrders || []).map(o => o.orderId));

      // Load corrective buy order IDs to avoid cancelling them as orphans
      const correctiveBuyIds = new Set();
      try {
        const cbPath = require('path').join(__dirname, '..', 'data', exchange, 'pending-corrective-buys.json');
        const cbData = JSON.parse(require('fs').readFileSync(cbPath, 'utf8'));
        for (const cb of cbData) {
          if (!cb.filled && !cb.cancelled) correctiveBuyIds.add(cb.buyOrderId);
        }
      } catch { /* no corrective buys file */ }

      // Load manual trade recovery buy order IDs to avoid cancelling them as orphans
      try {
        const { resolveFundDataDir } = require('./migration');
        const mtPath = require('path').join(resolveFundDataDir(exchange, pair), 'manual-trades.json');
        const mtData = JSON.parse(require('fs').readFileSync(mtPath, 'utf8'));
        for (const mt of (mtData.trades || [])) {
          if (mt.buyOrderId && mt.status === 'buy_pending') correctiveBuyIds.add(mt.buyOrderId);
        }
      } catch { /* no manual trades file */ }

      let restoredEntries = 0;
      let orphanedEntries = 0;

      for (const order of openEntries) {
        if (savedOrderIds.has(order.orderId)) {
          // This is our order - restore tracking instead of canceling
          const savedEntry = savedPendingEntries.find(e => e.orderId === order.orderId);
          if (orderExecutor.restorePendingOrder) {
            orderExecutor.restorePendingOrder(order.orderId, {
              type: 'entry',
              price: savedEntry.price,
              size: savedEntry.assetQty,
              sizeUsdc: savedEntry.sizeUsdc,
              placedAt: order.createdTime ? new Date(order.createdTime).getTime() : (savedEntry.placedAt || Date.now()),
            });
            restoredEntries++;
            console.log(`🔄 [${exchange}] Restored pending entry: ${order.orderId} @ ${fmtPrice(savedEntry.price)}`);
          }

          // Check if order has any fills while offline (partial fills)
          if (order.filledSize && order.filledSize > 0) {
            console.log(`✅ [${exchange}] Entry ${order.orderId} has partial fills (${order.filledSize})`);
            const rawFills = await adapter.getOrderFills(order.orderId);
            let orderHadNewFills = false;
            let lastFillPrice = 0;
            let lastFillTime = 0;
            for (const fill of rawFills) {
              const result = fillLedger.ingestFill(fill);
              if (result.ingested) {
                positionState.totalAsset = roundAsset(positionState.totalAsset + fill.size);
                positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + (fill.size * fill.price) + fill.netFee);
                positionState.avgCostBasis = positionState.totalAsset > 0
                  ? positionState.totalCostBasis / positionState.totalAsset
                  : 0;
                orderHadNewFills = true;
                lastFillPrice = fill.price;
                lastFillTime = fill.timestamp;
                console.log(`📝 [${exchange}] Ingested partial fill: ${fill.size} ${baseCurrency} @ ${fmtPrice(fill.price)}`);
              }
            }
            // Increment step once per order, not per fill
            if (orderHadNewFills) {
              positionState.cycleBuys += 1;
              positionState.lastEntryPrice = lastFillPrice;
              positionState.lastEntryTime = lastFillTime;
            }
          }
        } else if (correctiveBuyIds.has(order.orderId)) {
          console.log(`📋 [${exchange}] Skipping corrective buy order ${order.orderId.slice(0, 8)} (tracked in pending-corrective-buys)`);
        } else if (!savedLadderIds.has(order.orderId)) {
          // Orphan entry — not in saved state or ladder orders, cancel it
          orphanedEntries++;
          console.log(`🧹 [${exchange}] Cancelling orphan entry order ${order.orderId} (not tracked by regime engine)`);
          const cancelResult = await adapter.cancelOrder(order.orderId);
          if (cancelResult.success) {
            console.log(`✅ [${exchange}] Cancelled orphan entry ${order.orderId.slice(0, 8)}`);
          } else {
            const orphanStatus = await adapter.getOrder(order.orderId).catch(() => null);
            if (orphanStatus?.status === 'FILLED') {
              console.log(`📋 [${exchange}] Orphan entry ${order.orderId.slice(0, 8)} already filled — recovery will process`);
            } else {
              console.log(`⚠️ [${exchange}] Failed to cancel orphan entry ${order.orderId.slice(0, 8)}: ${cancelResult.errorMessage || 'unknown'}`);
            }
          }
        }
      }

      if (restoredEntries > 0) {
        console.log(`✅ [${exchange}] Restored ${restoredEntries} pending entry orders from state`);
      }
      if (orphanedEntries > 0) {
        console.log(`🧹 [${exchange}] Cancelled ${orphanedEntries} orphan entry orders`);
      }

      // Remove saved pending entries that are no longer open on the exchange
      // (filled or cancelled while engine was offline)
      const allOpenIds = new Set(exchangeOpenOrders.map(o => o.orderId));
      if (savedPendingEntries.length > 0) {
        positionState.pendingEntryOrders = savedPendingEntries.filter(e => allOpenIds.has(e.orderId));
        const purged = savedPendingEntries.length - positionState.pendingEntryOrders.length;
        if (purged > 0) {
          console.log(`🧹 [${exchange}] Purged ${purged} stale pending entry orders (filled/cancelled while offline)`);
        }
      }

      // Restore or cancel persisted ladder orders
      const savedLadderOrders = positionState.pendingLadderOrders || [];
      if (positionState.ladderActive && savedLadderOrders.length > 0) {
        let restoredLadder = 0;
        let cancelledLadder = 0;

        for (const order of openEntries) {
          if (savedLadderIds.has(order.orderId)) {
            const savedOrder = savedLadderOrders.find(o => o.orderId === order.orderId);
            if (orderExecutor.restorePendingOrder) {
              orderExecutor.restorePendingOrder(order.orderId, {
                type: 'ladder_entry',
                price: savedOrder.price,
                size: savedOrder.assetQty,
                sizeUsdc: savedOrder.sizeUsdc,
                ladderIndex: savedOrder.ladderIndex,
                placedAt: order.createdTime ? new Date(order.createdTime).getTime() : (savedOrder.placedAt || Date.now()),
              });
              restoredLadder++;
            }
          }
        }

        // Remove any saved ladder orders that are no longer open on the exchange
        const openOrderIds = new Set(openEntries.map(o => o.orderId));
        positionState.pendingLadderOrders = savedLadderOrders.filter(o => openOrderIds.has(o.orderId));

        cancelledLadder = savedLadderOrders.length - positionState.pendingLadderOrders.length;

        if (positionState.pendingLadderOrders.length === 0) {
          positionState.ladderActive = false;
        }

        if (restoredLadder > 0) console.log(`✅ [${exchange}] Restored ${restoredLadder} pending ladder orders`);
        if (cancelledLadder > 0) console.log(`ℹ️ [${exchange}] ${cancelledLadder} saved ladder orders no longer open on exchange`);
      }

      // Ensure all celestial bodies have TP orders
      // (covers bodies with null tpOrderId from saved state, e.g. after a cancelled TP wasn't re-placed)
      const bodiesNeedingTp = (positionState.celestialBodies || []).filter(b => !b.tpOrderId && b.assetQty > 0);
      if (bodiesNeedingTp.length > 0) {
        console.log(`🔧 [${exchange}] ${bodiesNeedingTp.length} celestial bodies need TP orders`);
        for (const body of bodiesNeedingTp) {
          await placeBodyTp(body);
        }
      }

      // Log untracked position asset but do NOT create recovery bodies or place sells.
      // Automatic sell placement for untracked assets is unsafe — it can sell non-engine holdings.
      const allRecoveryBodies = positionState.celestialBodies || [];
      if (allRecoveryBodies.length > 0 && positionState.totalAsset > 0) {
        const trackedBtc = allRecoveryBodies.reduce((sum, b) => sum + b.assetQty, 0);
        const untrackedAsset = roundAsset(positionState.totalAsset - trackedBtc);
        if (untrackedAsset > 0.00000100) {
          console.log(`⚠️ [${exchange}] ${untrackedAsset.toFixed(8)} ${baseCurrency} in position not tracked by any body — manual review required`);
        }
      }

      // Update TP if we have position but no order, OR if existing TP has drifted below minimum
      if (positionState.totalAsset > 0) {
        if (!positionState.activeTpOrderId) {
          await placeTakeProfitOrder();
        } else if (positionState.lastTpPrice > 0 && positionState.avgCostBasis > 0) {
          const currentTpPct = ((positionState.lastTpPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100;
          if (currentTpPct < config.tpMinPercent) {
            console.log(`⚠️ [${exchange}] TP has drifted below minimum: ${currentTpPct.toFixed(3)}% < ${config.tpMinPercent}% — rebuilding`);
            await placeTakeProfitOrder({ forceUpdate: true });
          }
        }
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

    // Initialize APY tracking if not already set (preserves existing tracking from saved state)
    initializeApyTracking();

    // Restore macro regime state if available
    if (macroRegime && positionState.macroRegime) {
      macroRegime.restoreState(positionState.macroRegime);
    }

    // Auto-close: if fund is draining but position is fully empty after recovery,
    // transition to closed immediately instead of running an empty engine.
    if (positionState.lifecycle === LIFECYCLE.DRAINING) {
      const bodies = positionState.celestialBodies || [];
      const hasPosition = (positionState.totalAsset || 0) > 0 || bodies.length > 0;
      if (!hasPosition) {
        positionState.lifecycle = LIFECYCLE.CLOSED;
        positionState.lifecycleChangedAt = Date.now();
        positionState.lifecycleClosedCycle = positionState.cyclesCompleted || 0;
        console.log(`🛑 [${exchange}] Draining fund has empty position — auto-closing`);
        if (!isDryRun) saveLiveState();
        if (callbacks.onLifecycleClosed) {
          setImmediate(() => {
            try { callbacks.onLifecycleClosed(); } catch (err) {
              console.log(`⚠️ [${exchange}] onLifecycleClosed callback error: ${err.message}`);
            }
          });
        }
        return { success: true, autoClosed: true };
      }
    }

    // Start WebSocket feed
    await connectWebSocket();

    // Start periodic metrics updates
    startMetricsUpdater();

    // Start macro regime detector
    if (macroRegime) {
      macroRegime.start();
    }

    // Start reconciliation and state saving
    if (!isDryRun) {
      startReconciliation();
      // Cap inflated asset reserves on startup
      reconcileAssetReserves().catch(() => {});
      // Start periodic state saving for live mode (every 5 minutes)
      stateSaveInterval = setInterval(saveLiveState, 300000);
    } else {
      // Start periodic state saving for dry-run (every 60 seconds)
      stateSaveInterval = setInterval(saveDryRunState, 60000);
    }

    isRunning = true;

    // Start Gemini heartbeat to prevent order auto-cancellation
    if (!isDryRun && adapter.startHeartbeat) {
      adapter.startHeartbeat();
    }

    console.log(`✅ [${exchange}] ${modeLabel}Regime engine started`);

    // SIGUSR1: reload state from disk (for applying manual state fixes without restart)
    if (!isDryRun) {
      const reloadHandler = () => {
        console.log(`🔄 [${exchange}] SIGUSR1 received — reloading state from disk`);
        const savedState = loadRegimeState(exchange, pair);
        const diskPos = savedState.position;
        if (!diskPos) {
          console.log(`⚠️ [${exchange}] No position in disk state, skipping reload`);
          return;
        }
        // Merge safe-to-reload fields from disk into in-memory state
        const reloadFields = [
          'realizedPnL', 'realizedAssetPnL',
          'celestialState',
        ];
        for (const field of reloadFields) {
          if (diskPos[field] !== undefined) {
            const old = positionState[field];
            positionState[field] = diskPos[field];
            console.log(`   ${field}: ${JSON.stringify(old)} → ${JSON.stringify(diskPos[field])}`);
          }
        }
        // Also reload fill ledger from disk
        fillLedger.load();
        console.log(`✅ [${exchange}] State reloaded from disk`);
        saveLiveState();
      };
      process.on('SIGUSR1', reloadHandler);
      // Store for cleanup
      positionState._sigusr1Handler = reloadHandler;
    }

    return { success: true };
  };

  /**
   * Stop the regime engine
   */
  const stop = async () => {
    if (!isRunning) return;

    console.log(`🛑 [${exchange}] Stopping regime engine`);

    // Mark as not running FIRST to prevent callbacks from taking action
    isRunning = false;

    // Save state before stopping
    if (isDryRun) {
      dryRunState.forceSave(exchange, {
        isDryRun: true,
        executor: orderExecutor.exportState ? orderExecutor.exportState() : {},
        position: { ...positionState },
        tpOptimizer: tpOptimizer.exportState(),
      }, pair);
    } else {
      // Save live state on shutdown
      saveLiveState();
      // Also persist fill ledger
      fillLedger.persist();
      console.log(`💾 [${exchange}] Saved live state and fill ledger`);
      // Remove SIGUSR1 handler
      if (positionState._sigusr1Handler) {
        process.removeListener('SIGUSR1', positionState._sigusr1Handler);
        delete positionState._sigusr1Handler;
      }
    }

    // Stop heartbeat
    if (adapter.stopHeartbeat) {
      adapter.stopHeartbeat();
    }

    // Stop intervals first
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

    // Stop macro regime
    if (macroRegime) {
      macroRegime.stop();
    }

    tailEvents.cleanup();

    // Clear all TTL timers to prevent post-shutdown state mutations
    for (const t of ttlTimers) clearTimeout(t);
    ttlTimers.clear();
    recentlyProcessedFills.clear();
    recentlyProcessedSellFills.clear();
    pendingMergeTpOrders.clear();
    completedMergeTpOrders.clear();

    // Clear order executor stale timers
    if (orderExecutor.clearTimers) orderExecutor.clearTimers();

    // Disconnect WebSocket last (callbacks will check isRunning)
    if (wsFeed) {
      wsFeed.disconnect();
      wsFeed = null;
    }

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
      onTicker: (data) => { if (isRunning) handleTicker(data); },
      onTrade: (data) => { if (isRunning) handleTrade(data); },
      onOrderUpdate: (data) => { if (isRunning) handleOrderUpdate(data); },
      onConnect: () => {
        if (isRunning) healthMonitor.recordWsStatus(true);
      },
      onDisconnect: () => {
        if (isRunning) healthMonitor.recordWsStatus(false);
      },
      onError: (error) => {
        if (isRunning) console.log(`❌ [${exchange}] WebSocket error: ${error.message}`);
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

    // Evaluate entry trigger (fire-and-forget, catch to prevent unhandled rejection)
    evaluateEntryTrigger().catch(err => console.log(`⚠️ [${exchange}] Entry evaluation failed: ${err.message}`));

    // In dry-run mode, check if any orders should fill based on current price
    if (isDryRun) {
      if (orderExecutor.checkTpFills) {
        orderExecutor.checkTpFills(data.price);
      }
      if (orderExecutor.checkEntryFills) {
        orderExecutor.checkEntryFills(data.price);
      }
    }

    // Update unrealized P&L — syncPositionState already aggregates body values
    // into totalAsset/totalCostBasis, so use them directly (no body loop needed)
    {
      const totalHeldBtc = positionState.totalAsset || 0;
      const totalHeldCost = positionState.totalCostBasis || 0;
      positionState.unrealizedPnL = totalHeldBtc > 0 ? (totalHeldBtc * data.price) - totalHeldCost : 0;
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
      // Remove cancelled entry from persisted pending orders
      if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
        const before = positionState.pendingEntryOrders.length;
        positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(
          e => e.orderId !== data.orderId
        );
        if (positionState.pendingEntryOrders.length < before) {
          saveLiveState();
        }
      }
    }
  };

  /**
   * Handle order fill
   * @param {Object} fillData - Fill data
   */
  const handleOrderFill = async (fillData) => {
    // Get detailed fills
    let rawFills = await adapter.getOrderFills(fillData.orderId);

    // If getOrderFills returns empty but we have fill data from order status (polling detection),
    // retry once after a short delay - Coinbase has eventual consistency
    if (rawFills.length === 0 && fillData.filledSize > 0) {
      console.log(`⏳ [${exchange}] No fills yet for ${fillData.orderId}, retrying in 2s (status shows ${fillData.filledSize} filled)`);
      await new Promise(r => setTimeout(r, 2000));
      rawFills = await adapter.getOrderFills(fillData.orderId);
    }

    // Get order placement time for fill time tracking (entry orders only)
    // Use placedAt from fillData (polling callback) or fall back to order executor lookup
    const orderPlacedAt = fillData.side.toLowerCase() === 'buy'
      ? (fillData.placedAt || orderExecutor.getOrderPlacedAt(fillData.orderId))
      : null;

    // Ingest each fill and collect the normalized fills
    const ingestedFills = [];
    for (const fill of rawFills) {
      const result = fillLedger.ingestFill(fill, orderPlacedAt);
      if (result.fill) {
        ingestedFills.push(result.fill);
      }
    }

    // Use ingested fills (which have quoteAmount) for aggregation
    // Fall back to getting fills from ledger if all were duplicates
    let fillsToAggregate = ingestedFills.length > 0
      ? ingestedFills
      : fillLedger.getFillsForOrder(fillData.orderId);

    // Last resort: if still no fills but order status has data, create synthetic fill
    // This handles Coinbase eventual consistency where fills API lags behind order status
    if (fillsToAggregate.length === 0 && fillData.filledSize > 0 && fillData.averageFilledPrice > 0) {
      console.log(`⚠️ [${exchange}] Using order status data as fallback for ${fillData.orderId}: ${fillData.filledSize} @ ${fmtPrice(fillData.averageFilledPrice)}`);
      const syntheticFill = {
        tradeId: `synthetic-${fillData.orderId}`,
        orderId: fillData.orderId,
        side: fillData.side.toLowerCase(),
        price: fillData.averageFilledPrice,
        size: fillData.filledSize,
        quoteAmount: fillData.filledSize * fillData.averageFilledPrice,
        netFee: fillData.totalFees || 0,
        timestamp: Date.now(),
      };
      // Ingest synthetic fill into ledger so it's not lost
      const result = fillLedger.ingestFill(syntheticFill, orderPlacedAt);
      fillsToAggregate = result.fill ? [result.fill] : [syntheticFill];
    }

    // Determine if buy or sell
    if (fillData.side.toLowerCase() === 'buy') {
      // Check if this is a ladder order fill (use positionState since polling may delete from pendingOrders before callback)
      const isLadderFill =
        (positionState.pendingLadderOrders &&
          positionState.pendingLadderOrders.some(o => o.orderId === fillData.orderId)) ||
        (orderExecutor.isLadderOrder && orderExecutor.isLadderOrder(fillData.orderId));

      const summary = fillLedger.aggregateFills(fillsToAggregate);

      // Celestial hierarchy: create new buy descriptor
      const newBuy = {
        assetQty: summary.totalSize,
        costBasis: summary.totalValue + summary.totalFees,
        avgPrice: summary.avgPrice,
        buyOrderId: fillData.orderId,
      };

      // Calculate candidate TP price for merge proximity check
      const candidateTpPrice = roundPrice(summary.avgPrice * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

      // Find merge target among existing celestial bodies
      const bodies = positionState.celestialBodies || [];
      let mergeTarget = celestialHierarchy.findMergeTarget(
        bodies, newBuy, config.maxUsdcDeployed, candidateTpPrice,
        config.maxCelestialBodies || 10, orderExecutor.getPendingCounts().total, config.maxOpenOrders
      );

      positionState.cycleBuys += 1;
      positionState.lastEntryPrice = summary.avgPrice;
      positionState.lastEntryTime = Date.now();

      const fillTypeLabel = isLadderFill ? '[LADDER] ' : '';

      if (mergeTarget) {
        // Race 3: snapshot merge target before cancel in case TP fills in-flight
        if (mergeTarget.tpOrderId) {
          pendingMergeTpOrders.set(mergeTarget.tpOrderId, { ...mergeTarget });
        }
        const cancelResult = await orderExecutor.cancelBodyTpOrder(mergeTarget.id);
        if (!cancelResult.cancelled) {
          if (mergeTarget.tpOrderId) pendingMergeTpOrders.delete(mergeTarget.tpOrderId);
          console.log(`⚠️ [${exchange}] Body ${mergeTarget.id.slice(-8)} TP ${cancelResult.filled ? 'already filled' : 'cancel failed'}, redirecting buy to new body`);
          mergeTarget = null;
        } else {
          // Cancel succeeded — move to completed with TTL
          if (mergeTarget.tpOrderId) {
            pendingMergeTpOrders.delete(mergeTarget.tpOrderId);
            completedMergeTpOrders.set(mergeTarget.tpOrderId, { ...mergeTarget });
            const t = setTimeout(() => { completedMergeTpOrders.delete(mergeTarget.tpOrderId); ttlTimers.delete(t); }, 300000);
            ttlTimers.add(t);
          }
          // Clear body TP fields so placeBodyTp can re-place after merge
          // (cancelBodyTpOrder only removes executor tracking, not body state)
          mergeTarget.tpOrderId = null;
          mergeTarget.tpPrice = 0;
          mergeTarget.assetOnOrder = 0;
        }
      }

      if (mergeTarget) {
        // MERGE: merge into existing body, possibly promote, re-place TP
        const merged = celestialHierarchy.mergeIntoBody(mergeTarget, newBuy, config.maxUsdcDeployed);
        // Replace old body with merged body in array
        const idx = positionState.celestialBodies.findIndex(b => b.id === merged.id);
        if (idx !== -1) positionState.celestialBodies[idx] = merged;

        // Annotate merged buy fills with body metadata (matches new-body annotation at line ~1903)
        fillLedger.annotateFillsByOrderId(fillData.orderId, { isBodyOwned: true, bodyId: merged.id, bodyTier: merged.tier });

        // Check for cascading promotions
        celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed);

        // Sync aggregate fields for backward compatibility
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        // Place body TP for merged body
        await placeBodyTp(merged);

        // Defense-in-depth: verify TP covers updated body size after merge
        if (merged.tpOrderId && merged.assetOnOrder > 0 && merged.tpPrice > 0) {
          const tierCfgCheck = celestialHierarchy.getTierConfig(merged.tier);
          const { sellQty } = positionSizer.calculateTakeProfitSize(
            merged.assetQty, merged.avgPrice, merged.tpPrice, tierCfgCheck.holdbackScale
          );
          if (Math.abs(sellQty - merged.assetOnOrder) > 0.00000001) {
            console.log(`⚠️ [${exchange}] Stale TP detected for body ${merged.id.slice(-8)}: onOrder=${merged.assetOnOrder}, expected=${sellQty} — cancelling for re-place`);
            const cancelResult = await orderExecutor.cancelBodyTpOrder(merged.id);
            if (cancelResult.cancelled) {
              orderExecutor.removeBodyTracking(merged.tpOrderId);
              merged.tpOrderId = null;
              merged.tpPrice = 0;
              merged.assetOnOrder = 0;
              await placeBodyTp(merged);
            }
          }
        }

        const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
        console.log(`${tierCfg.emoji} [${exchange}] ${fillTypeLabel}Buy merged into ${merged.tier}: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, body=${merged.id.slice(-8)} (${merged.assetQty.toFixed(6)} ${baseCurrency}, avg=${fmtPrice(merged.avgPrice)})`);

        tradeEvents.emitTradeEvent('buy_filled', exchange, `${fillTypeLabel}${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)} [merged→${merged.tier}]`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          bodyId: merged.id,
          bodyTier: merged.tier,
          isMerge: true,
          isLadderFill,
        });
      } else {
        // NEW BODY: Create new celestial body with its own TP
        const body = celestialHierarchy.createNewBody(newBuy, fillData.orderId);
        positionState.celestialBodies = positionState.celestialBodies || [];
        positionState.celestialBodies.push(body);

        // Sync aggregate fields
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        const bodyTpPlaced = await placeBodyTp(body);

        if (!bodyTpPlaced) {
          console.log(`⚠️ [${exchange}] Body TP placement failed for ${body.id.slice(-8)}, body persists without TP`);
        }

        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        console.log(`${tierCfg.emoji} [${exchange}] ${fillTypeLabel}Buy filled → created ${body.tier} body: ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, body=${body.id.slice(-8)}`);

        // Annotate buy fills with body metadata
        fillLedger.annotateFillsByOrderId(fillData.orderId, { isBodyOwned: true, bodyId: body.id, bodyTier: body.tier });

        tradeEvents.emitTradeEvent('buy_filled', exchange, `${fillTypeLabel}${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)} [new ${body.tier}]`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          bodyId: body.id,
          bodyTier: body.tier,
          isLadderFill,
        });
      }

      // Remove filled entry from persisted pending orders
      if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
        positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(
          e => e.orderId !== fillData.orderId
        );
      }

      // Remove from ladder tracking if it was a ladder order
      if (isLadderFill && positionState.pendingLadderOrders && positionState.pendingLadderOrders.length > 0) {
        positionState.pendingLadderOrders = positionState.pendingLadderOrders.filter(
          o => o.orderId !== fillData.orderId
        );
      }

      // Ladder orders stay in place on individual fills (no reprice).
      // Rebuild happens only after cycle reset.

      // Persist state immediately after buy fill to prevent loss on crash
      saveLiveState();
      fillLedger.persist();

    } else if (fillData.side.toLowerCase() === 'sell') {
      // Sell-fill dedup: skip if already processed (prevents double-processing across WS/reconcile/polling)
      // For partial fills, use a composite key with filled size to allow incremental processing
      const dedupKey = fillData.isPartialFill
        ? `${fillData.orderId}:${(fillData.filledSize || 0).toFixed(8)}`
        : fillData.orderId;
      if (recentlyProcessedSellFills.has(dedupKey)) {
        console.log(`⏭️ [${exchange}] Sell fill already processed, skipping: ${dedupKey}`);
        return;
      }
      recentlyProcessedSellFills.add(dedupKey);
      const t1 = setTimeout(() => { recentlyProcessedSellFills.delete(dedupKey); ttlTimers.delete(t1); }, 5 * 60 * 1000);
      ttlTimers.add(t1);

      // UNIFIED BODY TP FILL — find matching celestial body by TP order ID
      const summary = fillLedger.aggregateFills(fillsToAggregate);

      // Race 3: check merge-snapshot maps first (fill arrived for body removed during merge)
      const mergeSnapshot = pendingMergeTpOrders.get(fillData.orderId)
        || completedMergeTpOrders.get(fillData.orderId);
      if (mergeSnapshot) {
        // Process fill using snapshot data — body was already merged/removed
        pendingMergeTpOrders.delete(fillData.orderId);
        completedMergeTpOrders.delete(fillData.orderId);

        const tierCfg = celestialHierarchy.getTierConfig(mergeSnapshot.tier);
        const proceeds = summary.totalValue - summary.totalFees;
        // Prorate cost basis when sell doesn't cover full body (stale TP / partial fill)
        const soldRatio = mergeSnapshot.assetQty > 0 ? Math.min(summary.totalSize / mergeSnapshot.assetQty, 1) : 1;
        const proratedCostBasis = roundUSDC(mergeSnapshot.costBasis * soldRatio);
        const pnl = proceeds - proratedCostBasis;
        const holdbackAsset = roundAsset(mergeSnapshot.assetQty - summary.totalSize);

        const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
        cs.bodiesCompleted += 1;
        cs.bodiesRealizedPnL += pnl;
        cs.bodiesRealizedAssetPnL += holdbackAsset;
        positionState.celestialState = cs;
        positionState.realizedPnL += pnl;
        positionState.realizedAssetPnL += holdbackAsset;

        const prevMaxUsdc = config.maxUsdcDeployed;
        config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
        updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

        orderExecutor.removeBodyTracking(fillData.orderId);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        console.log(`${tierCfg.emoji} [${exchange}] Merge-snapshot TP filled (${mergeSnapshot.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

        fillLedger.annotateFillsByOrderId(fillData.orderId, {
          isBodyOwned: true,
          bodyId: mergeSnapshot.id,
          bodyTier: mergeSnapshot.tier,
          bodyCostBasis: mergeSnapshot.costBasis,
          bodyAvgPrice: mergeSnapshot.avgPrice,
          bodyBtcQty: mergeSnapshot.assetQty,
          bodyHoldbackAsset: holdbackAsset,
          bodyPnl: pnl,
          mergeSnapshot: true,
        });

        tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)} [merge-snapshot]`, {
          assetAmount: summary.totalSize,
          price: summary.avgPrice,
          pnl,
          holdbackAsset,
          bodyId: mergeSnapshot.id,
          bodyTier: mergeSnapshot.tier,
          mergeSnapshot: true,
        });

        saveLiveState();
        fillLedger.persist();
        orderExecutor.handleOrderFill(fillData.orderId);
        return;
      }

      // Find the body whose tpOrderId matches this fill
      const bodies = positionState.celestialBodies || [];
      const bodyIdx = bodies.findIndex(b => b.tpOrderId === fillData.orderId);

      // Fallback: check legacy satellite tracking (pre-celestial migration)
      const legacySatellite = null;

      if (bodyIdx !== -1) {
        // CELESTIAL BODY TP FILL (full or partial)
        const body = bodies[bodyIdx];
        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        const proceeds = summary.totalValue - summary.totalFees;
        // Prorate cost basis when sell doesn't cover full body (stale TP / partial fill)
        const soldRatio = body.assetQty > 0 ? Math.min(summary.totalSize / body.assetQty, 1) : 1;
        const proratedCostBasis = roundUSDC(body.costBasis * soldRatio);
        const pnl = proceeds - proratedCostBasis;
        const holdbackAsset = roundAsset(body.assetQty - summary.totalSize);

        // Detect partial fill: order is still open on the exchange
        const isPartial = fillData.isPartialFill || soldRatio < 0.95;

        // Update celestial state
        const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
        if (!isPartial) cs.bodiesCompleted += 1;
        cs.bodiesRealizedPnL += pnl;
        cs.bodiesRealizedAssetPnL += (isPartial ? 0 : holdbackAsset);
        positionState.celestialState = cs;

        // Update shared realized P&L
        positionState.realizedPnL += pnl;
        positionState.realizedAssetPnL += (isPartial ? 0 : holdbackAsset);

        // Grow capital
        const prevMaxUsdc = config.maxUsdcDeployed;
        config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
        updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

        if (isPartial) {
          // PARTIAL FILL: reduce body size, keep body active, re-place TP for remaining
          const remainingAsset = roundAsset(body.assetQty - summary.totalSize);
          const remainingCostBasis = roundUSDC(body.costBasis * (1 - soldRatio));
          body.assetQty = remainingAsset;
          body.costBasis = remainingCostBasis;
          // avgPrice stays the same (weighted average of buys doesn't change)

          // Remove old TP tracking — engine will re-place for correct remaining size
          orderExecutor.removeBodyTracking(fillData.orderId);
          body.tpOrderId = null;
          body.tpPrice = 0;
          body.assetOnOrder = 0;

          // Sync aggregate fields
          celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

          console.log(`${tierCfg.emoji} [${exchange}] Body TP PARTIAL fill (${body.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, remaining=${remainingAsset} ${baseCurrency}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

          tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)} [PARTIAL]`, {
            assetAmount: summary.totalSize,
            price: summary.avgPrice,
            pnl,
            holdbackAsset: remainingAsset,
            bodyId: body.id,
            bodyTier: body.tier,
            isPartialFill: true,
            remainingAsset,
          });

          // Re-place TP for remaining body size
          await placeBodyTp(body);
        } else {
          // FULL FILL: remove body entirely
          // Remove body from array
          positionState.celestialBodies.splice(bodyIdx, 1);

          // Remove executor tracking
          orderExecutor.removeBodyTracking(fillData.orderId);

          // Sync aggregate fields
          celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

          const remaining = positionState.celestialBodies.length;
          console.log(`${tierCfg.emoji} [${exchange}] Body TP filled (${body.tier}): ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackAsset.toFixed(6)} ${baseCurrency}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed} (${remaining} remaining)`);

          tradeEvents.emitTradeEvent('body_tp_filled', exchange, `${tierCfg.emoji} ${summary.totalSize} ${baseCurrency} @ ${fmtPrice(summary.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
            assetAmount: summary.totalSize,
            price: summary.avgPrice,
            pnl,
            holdbackAsset,
            bodyId: body.id,
            bodyTier: body.tier,
            bodiesRemaining: remaining,
            capitalGrowth: pnl,
            newMaxUsdcDeployed: config.maxUsdcDeployed,
          });

          // If no bodies remain, do a full cycle reset
          if (positionState.celestialBodies.length === 0) {
            positionState.cyclesCompleted += 1;

            const actualTpPct = body.avgPrice > 0
              ? ((summary.avgPrice - body.avgPrice) / body.avgPrice) * 100
              : 0;
            recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
            recordCycleForSizeOptimizer({
              stepsUsed: positionState.cycleBuys,
              capitalDeployed: body.costBasis,
            }, config.maxUsdcDeployed);

            await resetCycle();
          }
        }

        // Annotate fills with body metadata
        fillLedger.annotateFillsByOrderId(fillData.orderId, {
          isBodyOwned: true,
          bodyId: body.id,
          bodyTier: body.tier,
          bodyCostBasis: proratedCostBasis,
          bodyAvgPrice: body.avgPrice,
          bodyBtcQty: isPartial ? summary.totalSize : body.assetQty,
          bodyHoldbackAsset: isPartial ? 0 : holdbackAsset,
          bodyPnl: pnl,
          ...(isPartial && { partialFill: true }),
        });

        // Link source buy fills to this sell order for buy→sell display linkage
        const annotatedSrcIds = new Set();
        for (const srcId of (body.sourceOrderIds || [])) {
          fillLedger.annotateFillsByOrderId(srcId, { sellOrderId: fillData.orderId });
          annotatedSrcIds.add(srcId);
        }
        for (const buyOrder of (body.buyOrders || [])) {
          if (buyOrder.orderId !== 'core-migration' && !annotatedSrcIds.has(buyOrder.orderId)) {
            fillLedger.annotateFillsByOrderId(buyOrder.orderId, { sellOrderId: fillData.orderId });
          }
        }

        saveLiveState();
        fillLedger.persist();

      } else {
        // UNTRACKED SELL — could be a core TP from before migration
        const summary2 = fillLedger.aggregateFills(fillsToAggregate);

        // Guard: check if fills for this order are already annotated as body TP.
        // This catches duplicate body TP fills from cancel-and-replace races where both the
        // old and new TP orders fill simultaneously — the first is processed correctly, the
        // second arrives after the body is removed and would otherwise trigger a false cycle.
        const existingFills = fillLedger.getFillsForOrder(fillData.orderId);
        const alreadyProcessedAsBody = existingFills.some(f => f.isBodyOwned || f.isSatellite);
        if (alreadyProcessedAsBody) {
          console.log(`⏭️ [${exchange}] Sell ${fillData.orderId.slice(0,8)} already processed as body TP, skipping`);
          return;
        }

        // Guard: if celestial bodies still exist, this is NOT a legitimate cycle-closing TP.
        // It's likely a duplicate/untracked satellite sell. Log and annotate but don't complete the cycle.
        const remainingBodies = (positionState.celestialBodies || []).length;
        if (remainingBodies > 0) {
          console.log(`⚠️ [${exchange}] Untracked sell ${fillData.orderId.slice(0,8)} (${summary2.totalSize} ${baseCurrency} @ ${fmtPrice(summary2.avgPrice)}) — ${remainingBodies} celestial bodies still active, skipping cycle completion`);
          fillLedger.annotateFillsByOrderId(fillData.orderId, { untrackedSell: true });
          saveLiveState();
          fillLedger.persist();
        } else {
          const proceeds = summary2.totalValue - summary2.totalFees;
          const soldCostBasis = summary2.totalSize * positionState.avgCostBasis;
          const pnl = proceeds - soldCostBasis;
          const holdbackAsset = roundAsset(positionState.totalAsset - summary2.totalSize);

          positionState.realizedPnL += pnl;
          positionState.realizedAssetPnL += holdbackAsset;
          positionState.assetOnOrder = 0;
          positionState.cyclesCompleted += 1;

          const prevMaxUsdc = config.maxUsdcDeployed;
          config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
          updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

          console.log(`✅ [${exchange}] TP filled (untracked): ${summary2.totalSize} ${baseCurrency} @ ${fmtPrice(summary2.avgPrice)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

          // Link current-cycle buy fills to this sell order for buy→sell display linkage (skip body-owned)
          const cycleFills = fillLedger.getCurrentCycleFills();
          for (const fill of cycleFills) {
            if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId) {
              fillLedger.annotateFillsByOrderId(fill.orderId, { sellOrderId: fillData.orderId });
            }
          }

          tradeEvents.emitTradeEvent('tp_filled', exchange, `${summary2.totalSize} ${baseCurrency} @ ${fmtPrice(summary2.avgPrice)}, PnL=$${pnl.toFixed(2)}`, {
            assetAmount: summary2.totalSize,
            price: summary2.avgPrice,
            pnl,
            holdbackAsset,
            capitalGrowth: pnl,
            newMaxUsdcDeployed: config.maxUsdcDeployed,
          });

          const actualTpPct = positionState.avgCostBasis > 0
            ? ((summary2.avgPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100
            : 0;
          recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
          recordCycleForSizeOptimizer({
            stepsUsed: positionState.cycleBuys,
            capitalDeployed: soldCostBasis,
          }, config.maxUsdcDeployed);

          await resetCycle();
          saveLiveState();
          fillLedger.persist();
        }
      }
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
   * Fetch and update ATH (All-Time High) for ladder mode
   * Only fetches if in ladder mode and data is stale (>24 hours old)
   */
  const updateATH = async () => {
    // Only fetch ATH for ladder mode
    const effectiveMode = config.entryMode || 'reactive';
    if (effectiveMode !== 'ladder' && !config.ladderAutoSwitch) {
      return;
    }

    // Prevent concurrent ATH backfills
    if (athUpdateInProgress) return;

    // Check if ATH data is fresh enough (refresh daily)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    if (marketState.athLastUpdate && (now - marketState.athLastUpdate) < dayMs) {
      return;
    }

    athUpdateInProgress = true;

    const fetchAndComputeATH = async () => {
      // Fetch full daily history in paginated batches (Coinbase API limits <350 candles per request)
      const nowSec = Math.floor(now / 1000);
      const maxCandlesPerRequest = 349;
      const daySec = 24 * 60 * 60;

      const allCandles = [];
      let endSec = nowSec;

      while (true) {
        const startSec = endSec - (maxCandlesPerRequest * daySec);
        const batch = await adapter.getCandles(productId, startSec, endSec, 'ONE_DAY').catch(err => {
          console.log(`⚠️ [${exchange}] Failed to fetch ATH data: ${err.message}`);
          return null;
        });

        if (!batch || batch.length === 0) break;
        allCandles.push(...batch);

        // If we received fewer than max candles, we've reached the earliest available data
        if (batch.length < maxCandlesPerRequest) break;

        // Move window back in time for next batch
        endSec = startSec;
      }

      if (allCandles.length === 0) return;

      // Calculate ATH over full fetched history
      const ath = ladderCalculator.calculateATHFromCandles(allCandles);
      const athDistance = ladderCalculator.calculateATHDistance(marketState.lastPrice, ath);

      marketState.ath = ath;
      marketState.athDistance = athDistance;
      marketState.athLastUpdate = now;

      const distancePct = (Math.abs(athDistance) * 100).toFixed(1);
      console.log(`📊 [${exchange}] ATH updated: ${fmtPrice(ath)} (${allCandles.length} candles), current price ${athDistance < 0 ? `${distancePct}% below` : `${distancePct}% above`} ATH`);
    };

    await fetchAndComputeATH().finally(() => {
      athUpdateInProgress = false;
    });
  };

  /**
   * Update volatility metrics via REST API
   */
  const updateMetrics = async () => {
    // Check health status (allows auto-recovery from SAFE mode)
    healthMonitor.checkHealth();

    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const fourHoursAgo = now - 14400;

    // Fetch candles with error handling - metrics update is non-critical
    let candles1m, candles5m;
    let fetchFailed = false;

    await (async () => {
      candles1m = await adapter.getCandles(productId, oneHourAgo, now, 'ONE_MINUTE');
      candles5m = await adapter.getCandles(productId, fourHoursAgo, now, 'FIVE_MINUTE');
    })().catch(err => {
      console.log(`⚠️ [${exchange}] Metrics update failed (using cached): ${err.message}`);
      fetchFailed = true;
    });

    // If fetch failed, skip metrics update but continue with regime classification using cached values
    if (fetchFailed) {
      // Still log hourly summary with cached metrics
      logHourlySummary();
      return;
    }

    const metrics = calculateAllMetrics(candles1m, candles5m, marketState.volBaseline, config);

    marketState.atr1m = metrics.atr1m;
    marketState.atr5m = metrics.atr5m;
    marketState.realizedVol = metrics.realizedVol;
    marketState.volBaseline = metrics.volBaseline;
    marketState.vwap = metrics.vwap;
    marketState.recentSwing = metrics.recentSwing;
    marketState.momentum = metrics.momentum;

    // Calculate VWAP distance
    if (marketState.lastPrice > 0 && marketState.atr1m > 0) {
      marketState.vwapDistance = (marketState.lastPrice - marketState.vwap) / marketState.atr1m;
    }

    // Feed volatility data to TP optimizer for continuous vol-based sampling
    if (config.tpAutoManaged && marketState.atr5m > 0 && marketState.lastPrice > 0) {
      const volAdj = tpOptimizer.recordVolatilitySample({
        atr5m: marketState.atr5m,
        lastPrice: marketState.lastPrice,
        realizedVol: marketState.realizedVol,
        volBaseline: marketState.volBaseline,
      });
      if (volAdj) handleTpAdjustment(volAdj);
    }

    // Update ATH for ladder mode (daily refresh) - run async to avoid blocking metrics interval
    updateATH().catch(err => console.log(`⚠️ [${exchange}] ATH update failed: ${err.message}`));

    // Classify regime with updated metrics
    regimeDetector.classify(marketState);

    // Update stale order timeout based on regime
    // HARVEST: normal timeout (1.0x)
    // CAUTION: faster repricing (0.7x) - uncertain markets need quicker adjustments
    // TREND: fastest repricing (0.5x) - trending markets move quickly
    if (!isDryRun && orderExecutor.setStaleTimeoutMultiplier) {
      const regime = regimeDetector.getMode();
      const multiplier = regime === 'CAUTION' ? 0.7 : regime === 'TREND' ? 0.5 : 1.0;
      orderExecutor.setStaleTimeoutMultiplier(multiplier);
    }

    // Log hourly summary
    logHourlySummary();

    // Place TP order if we have a position but no active TP order (e.g., after recovery)
    if (!isDryRun && positionState.totalAsset > 0) {
      const bodies = positionState.celestialBodies || [];
      const bodiesWithoutTp = bodies.filter(b => !b.tpOrderId);
      const needsTp = bodies.length > 0 ? bodiesWithoutTp.length > 0 : !positionState.activeTpOrderId;
      if (needsTp) {
        console.log(`📝 [${exchange}] Position without TP order detected — bodies=${bodies.length} (${bodiesWithoutTp.length} need TP: ${bodiesWithoutTp.map(b => b.id.slice(-8)).join(',')}), avgCost=${fmtPrice(positionState.avgCostBasis)}, cycleBuys=${positionState.cycleBuys}`);
        await placeTakeProfitOrder();
      }
    }
  };

  /**
   * Start periodic reconciliation
   */
  const startReconciliation = () => {
    reconcileInterval = setInterval(() => {
      if (!isRunning) return; // Guard against firing after stop

      // Check for entry fills that WebSocket might have missed
      if (!isDryRun && orderExecutor.checkPendingOrderFills) {
        orderExecutor.checkPendingOrderFills()
          .then(result => {
            if (result.filled > 0 || result.cancelled > 0) {
              console.log(`🔄 [${exchange}] Reconcile fill check: ${result.filled} filled, ${result.cancelled} cancelled`);
            }
          })
          .catch(err => {
            console.log(`❌ [${exchange}] Fill check failed: ${err.message}`);
          });
      }

      // Check for TP order fill that WebSocket might have missed
      if (!isDryRun && positionState.activeTpOrderId) {
        adapter.getOrder(positionState.activeTpOrderId)
          .then(async (orderStatus) => {
            if (orderStatus.status === 'FILLED') {
              console.log(`✅ [${exchange}] Reconcile detected TP order ${positionState.activeTpOrderId} filled (WebSocket missed)`);
              // Build fill data in the format handleOrderFill expects
              const fillData = {
                orderId: positionState.activeTpOrderId,
                side: 'sell',
                status: 'FILLED',
                filledSize: parseFloat(orderStatus.filledSize || 0),
                filledValue: parseFloat(orderStatus.filledValue || 0),
                averageFilledPrice: parseFloat(orderStatus.averageFilledPrice || 0),
              };
              await handleOrderFill(fillData);
            }
          })
          .catch(err => {
            // Order not found might mean it was cancelled or doesn't exist
            const errCode = err.response?.data?.code;
            if (err.message?.includes('not found') || err.response?.status === 404 || errCode === 40003) {
              console.log(`⚠️ [${exchange}] TP order ${positionState.activeTpOrderId} not found on exchange, clearing`);
              positionState.activeTpOrderId = null;
              orderExecutor.handleOrderCancel(positionState.activeTpOrderId);
            } else {
              console.log(`❌ [${exchange}] TP order check failed: ${err.message}`);
            }
          });
      }

      // Check celestial body TP orders for fills/cancellations that WebSocket might have missed
      const activeBodies = positionState.celestialBodies || [];
      if (activeBodies.length > 0) {
        for (const body of [...activeBodies]) {
          if (!body.tpOrderId) continue;
          adapter.getOrder(body.tpOrderId)
            .then(async (bodyStatus) => {
              if (bodyStatus.status === 'FILLED') {
                const tierCfg = celestialHierarchy.getTierConfig(body.tier);
                console.log(`${tierCfg.emoji} [${exchange}] Reconcile detected body TP ${body.tpOrderId} filled`);
                const fillData = {
                  orderId: body.tpOrderId,
                  side: 'sell',
                  status: 'FILLED',
                  filledSize: parseFloat(bodyStatus.filledSize || 0),
                  filledValue: parseFloat(bodyStatus.filledValue || 0),
                  averageFilledPrice: parseFloat(bodyStatus.averageFilledPrice || 0),
                };
                await handleOrderFill(fillData);
              } else if (bodyStatus.status === 'CANCELLED' || bodyStatus.status === 'FAILED') {
                // TP was cancelled/failed externally — clear and immediately re-place
                const tierCfg = celestialHierarchy.getTierConfig(body.tier);
                console.log(`⚠️ [${exchange}] Reconcile detected body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} ${bodyStatus.status} — clearing for re-placement`);
                orderExecutor.removeBodyTracking(body.tpOrderId);
                body.tpOrderId = null;
                body.tpPrice = 0;
                body.assetOnOrder = 0;
                saveLiveState();
                await placeBodyTp(body);
              } else if (bodyStatus.status === 'OPEN' || bodyStatus.status === 'PENDING') {
                // Check if TP covers adequate portion of body (stale-size detection)
                const tierCfg = celestialHierarchy.getTierConfig(body.tier);
                const { sellQty } = positionSizer.calculateTakeProfitSize(
                  body.assetQty, body.avgPrice, body.tpPrice, tierCfg.holdbackScale
                );
                if (Math.abs(sellQty - body.assetOnOrder) > 0.00000001) {
                  console.log(`⚠️ [${exchange}] Reconcile: body ${body.id.slice(-8)} TP stale (onOrder=${body.assetOnOrder}, expected=${sellQty}) — cancelling for re-place`);
                  const cancelResult = await orderExecutor.cancelBodyTpOrder(body.id);
                  if (cancelResult.cancelled) {
                    orderExecutor.removeBodyTracking(body.tpOrderId);
                    body.tpOrderId = null;
                    body.tpPrice = 0;
                    body.assetOnOrder = 0;
                    saveLiveState();
                    await placeBodyTp(body);
                  }
                }
              }
            })
            .catch(async (err) => {
              // Order not found or invalid — likely cancelled externally or ID no longer valid
              const errCode = err.response?.data?.code;
              const isNotFound = err.message?.includes('not found') || err.response?.status === 404 || errCode === 40003;
              if (isNotFound) {
                console.log(`⚠️ [${exchange}] Body ${body.id.slice(-8)} TP ${body.tpOrderId.slice(0, 8)} not found on exchange — clearing for re-placement`);
                orderExecutor.removeBodyTracking(body.tpOrderId);
                body.tpOrderId = null;
                body.tpPrice = 0;
                body.assetOnOrder = 0;
                saveLiveState();
                await placeBodyTp(body);
              }
            });
        }
      }

      recoveryModule.reconcile(positionState, fillLedger)
        .then(result => {
          if (result.updated) {
            // Preserve fields that rebuildPositionFromFills doesn't return
            const savedBodies = positionState.celestialBodies;
            const savedCelestialState = positionState.celestialState;
            const savedRealizedPnL = positionState.realizedPnL;
            const savedRealizedAssetPnL = positionState.realizedAssetPnL;
            const savedEngineStartTime = positionState.engineStartTime;
            const savedInitialCapital = positionState.initialCapital;
            const savedOriginalCapital = positionState.originalCapital;
            const savedDepositedCapital = positionState.depositedCapital;
            positionState = result.position;
            if (savedBodies) positionState.celestialBodies = savedBodies;
            if (savedCelestialState) positionState.celestialState = savedCelestialState;
            if (savedRealizedPnL) positionState.realizedPnL = savedRealizedPnL;
            if (savedRealizedAssetPnL) positionState.realizedAssetPnL = savedRealizedAssetPnL;
            if (savedEngineStartTime) positionState.engineStartTime = savedEngineStartTime;
            if (savedInitialCapital) positionState.initialCapital = savedInitialCapital;
            if (savedOriginalCapital) positionState.originalCapital = savedOriginalCapital;
            if (savedDepositedCapital) positionState.depositedCapital = savedDepositedCapital;
            // Re-sync totals from bodies
            const bodies = positionState.celestialBodies || [];
            if (bodies.length > 0) {
              celestialHierarchy.syncPositionState(positionState, bodies);
            }
            console.log(`🔄 [${exchange}] Position reconciled from exchange (${bodies.length} bodies preserved)`);
          }
        })
        .catch(err => {
          console.log(`❌ [${exchange}] Reconciliation failed: ${err.message}`);
        });
    }, config.reconcileIntervalMs);
  };

  /**
   * Evaluate volatility-based entry trigger (mode-aware)
   * Delegates to either reactive or ladder entry evaluation based on config
   */
  const evaluateEntryTrigger = async () => {
    // Prevent concurrent entry evaluations (race condition from rapid ticker updates)
    if (entryInProgress) return;

    // Determine effective entry mode
    let effectiveMode = config.entryMode || 'reactive';

    // Auto-switch to ladder mode if enabled and volatility is expanded
    if (config.ladderAutoSwitch && marketState.volBaseline > 0) {
      const volExpansion = marketState.realizedVol / marketState.volBaseline;
      const volThreshold = config.ladderAutoSwitchVolMult || 2.0;
      if (volExpansion >= volThreshold) {
        if (effectiveMode !== 'ladder') {
          console.log(`🔀 [${exchange}] Auto-switch: reactive→ladder (volExpansion=${volExpansion.toFixed(2)}x >= ${volThreshold}x threshold, rVol=${marketState.realizedVol.toFixed(4)} baseline=${marketState.volBaseline.toFixed(4)})`);
        }
        effectiveMode = 'ladder';
      }
    }

    // Don't switch modes mid-cycle if we have an active position
    // (prevents inconsistent behavior during a trade cycle)
    if (positionState.totalAsset > 0) {
      // If ladder is active, stay in ladder mode
      if (positionState.ladderActive) {
        effectiveMode = 'ladder';
      } else {
        // Otherwise stay in reactive mode
        effectiveMode = 'reactive';
      }
    }

    if (effectiveMode === 'ladder') {
      await evaluateLadderEntry();
    } else {
      await evaluateReactiveEntry();
    }
  };

  /**
   * Evaluate reactive entry trigger (original volatility-based logic)
   */
  const evaluateReactiveEntry = async () => {
    const now = Date.now();

    // Fund lifecycle guard: when draining/closed, never place new entries
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) return;

    // Don't place new entry if there's already a pending entry order on the exchange
    if (orderExecutor.getPendingCounts().entries > 0) return;

    // Skip if in insufficient funds cooldown (prevents rapid retry spam on 406 errors)
    if (now < insufficientFundsCooldownUntil) return;

    const timeSinceLastEntry = now - positionState.lastEntryTime;

    // Minimum interval guard
    if (timeSinceLastEntry < config.minIntervalMs) return;

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Check tail events
    const tailCheck = tailEvents.canPlaceEntry(positionState.cycleBuys);
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
      entryInProgress = true;
      await executeEntry(volTrigger ? 'volatility' : 'timer').finally(() => {
        entryInProgress = false;
      });
    }
  };

  /**
   * Evaluate ladder entry - pre-position liquidity ladder
   */
  const evaluateLadderEntry = async () => {
    // Fund lifecycle guard: when draining/closed, never place new entries
    if (positionState.lifecycle && positionState.lifecycle !== LIFECYCLE.ACTIVE) return;

    // Skip if in insufficient funds cooldown
    if (Date.now() < insufficientFundsCooldownUntil) return;

    // Skip if ladder already active with pending orders
    if (positionState.ladderActive && positionState.pendingLadderOrders.length > 0) {
      return;
    }

    // Check health
    const healthCheck = healthMonitor.canPlaceEntry();
    if (!healthCheck.allowed) return;

    // Skip tail events check — ladder IS the flash event strategy,
    // orders should stay in place regardless of spread/depth/flash conditions

    // Check regime allows entries
    if (!regimeDetector.allowsEntries()) return;

    // Calculate remaining budget, capped at actual available balance
    let remainingBudget = config.maxUsdcDeployed - positionState.totalCostBasis;
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
    if (!quoteBalance) {
      // Can't verify balance — skip ladder to avoid placing orders we can't fund
      return;
    }
    const availableQuote = parseFloat(quoteBalance.available) || 0;
    if (availableQuote < remainingBudget) {
      remainingBudget = availableQuote;
    }

    // Quick sanity check - need at least 1 order worth of budget
    if (remainingBudget < config.baseSizeUsdc) {
      if (!budgetExhaustedWarningLogged) {
        console.log(`ℹ️ [${exchange}] Insufficient budget for ladder: $${remainingBudget.toFixed(2)} available (${quoteCurrency}=${availableQuote.toFixed(2)}) < $${config.baseSizeUsdc}`);
        budgetExhaustedWarningLogged = true;
      }
      return;
    }

    entryInProgress = true;

    const placeLadder = async () => {
      // Build ladder first to determine actual level count (may be fewer than config due to min-size filtering)
      const ladder = ladderCalculator.buildLadder(
        marketState.lastPrice,
        remainingBudget,
        {
          atr: marketState.atr1m,
          volBaseline: marketState.volBaseline,
          realizedVol: marketState.realizedVol,
          athDistance: marketState.athDistance || 0,
          ath: marketState.ath || 0,
          priceIncrement,
        }
      );

      if (ladder.levels.length === 0) {
        if (!budgetExhaustedWarningLogged) {
          console.log(`ℹ️ [${exchange}] Ladder build produced 0 levels for budget $${remainingBudget.toFixed(2)}`);
          budgetExhaustedWarningLogged = true;
        }
        return;
      }

      // Check order limit using actual built level count
      const pendingCounts = orderExecutor.getPendingCounts();
      const requiredSlots = ladder.levels.length + 1; // +1 for TP order

      if (pendingCounts.total + requiredSlots > config.maxOpenOrders) {
        console.log(`⚠️ [${exchange}] Insufficient order slots for ladder: need ${requiredSlots}, max=${config.maxOpenOrders}, current=${pendingCounts.total}`);
        return;
      }

      console.log(`📊 [${exchange}] Building ladder: ${ladderCalculator.getSummary(ladder)}`);

      // Place ladder orders
      const result = await orderExecutor.placeLadderOrders(ladder.levels);

      // Update position state
      positionState.ladderActive = true;
      positionState.ladderPlacedAt = Date.now();
      positionState.ladderLowerBound = ladder.lowerBound;
      positionState.pendingLadderOrders = result.orders;

      console.log(`📊 [${exchange}] Ladder placed: ${result.orders.length} levels from ${fmtPrice(marketState.lastPrice)} to ${fmtPrice(ladder.lowerBound)}${result.failedCount > 0 ? ` (${result.failedCount} failed)` : ''}`);

      tradeEvents.emitTradeEvent('ladder_placed', exchange, `${result.orders.length} levels to ${fmtPrice(ladder.lowerBound)}`, {
        levels: result.orders.length,
        topPrice: marketState.lastPrice,
        bottomPrice: ladder.lowerBound,
        lowerBoundPct: ladder.lowerBoundPct,
        totalBudget: ladder.totalBudget,
        failedCount: result.failedCount,
      });

      // Persist state
      saveLiveState();
    };

    await placeLadder().finally(() => {
      entryInProgress = false;
    });
  };

  /**
   * Execute entry
   * @param {string} triggerType - What triggered the entry
   */
  const executeEntry = async (triggerType) => {
    const regime = regimeDetector.getMode();

    // Calculate size (apply macro multiplier to sizing)
    const sizing = positionSizer.calculateEntrySize({
      regime,
      cycleBuys: positionState.cycleBuys,
      totalCostBasis: positionState.totalCostBasis,
      currentPrice: marketState.bid,
      avgCostBasis: positionState.avgCostBasis,
    });

    // Apply macro regime size multiplier
    const macroMult = macroRegime ? macroRegime.getMultipliers() : { sizeMult: 1.0, tpMult: 1.0, offsetMult: 1.0 };
    sizing.sizeUsdc = roundUSDC(sizing.sizeUsdc * macroMult.sizeMult);

    // Enforce minimum order size floor (after all multipliers, skip zero-size regimes)
    const minSize = config.minOrderSizeUsdc || exchangeConfig.minOrderSize || 1;
    const remainingBudget = roundUSDC(Math.max(0, config.maxUsdcDeployed - positionState.totalCostBasis));
    if (sizing.sizeUsdc > 0) {
      // If remaining budget can't fit 2 orders at minimum, use it all in one last order
      // But only if remaining budget is at least the minimum order size
      if (remainingBudget >= minSize && remainingBudget < minSize * 2) {
        sizing.sizeUsdc = remainingBudget;
      } else if (sizing.sizeUsdc < minSize) {
        sizing.sizeUsdc = minSize;
      }
    }

    // Check risk caps
    const assetQty = positionSizer.calculateBTCQuantity(sizing.sizeUsdc, marketState.bid);
    const riskCheck = riskManager.canPlaceEntry(positionState, assetQty, sizing.sizeUsdc);

    // Handle cycle buys auto-reset (time-based reset after being at max limit)
    if (riskCheck.shouldResetCycleBuys) {
      console.log(`🔄 [${exchange}] Cycle buys auto-reset triggered, resetting buys ${positionState.cycleBuys} -> 0`);
      positionState.cycleBuys = 0;
      cycleBuysLimitWarningLogged = false;
    }

    if (!riskCheck.allowed) {
      // Only log certain warnings once until they reset (to avoid log spam)
      const isLadderLimit = riskCheck.reason.startsWith('cycle_buys_limit_reached');
      const isUsdcCap = riskCheck.reason.startsWith('usdc_cap_exceeded');
      const shouldSkipLog = (isLadderLimit && cycleBuysLimitWarningLogged) || (isUsdcCap && usdcCapWarningLogged);
      if (!shouldSkipLog) {
        console.log(`⚠️ [${exchange}] Entry blocked: ${riskCheck.reason}`);
        if (isLadderLimit) cycleBuysLimitWarningLogged = true;
        if (isUsdcCap) usdcCapWarningLogged = true;
      }
      return;
    }

    // Check for zero/budget-exhausted (with spam protection)
    if (sizing.sizeUsdc <= 0) {
      if (!budgetExhaustedWarningLogged) {
        console.log(`ℹ️ [${exchange}] Budget exhausted`);
        budgetExhaustedWarningLogged = true;
      }
      return;
    }

    // Calculate dynamic offset based on momentum direction
    // UP momentum: smaller offset to get fills before price rises further
    // DOWN momentum: larger offset to catch the falling price
    // NEUTRAL: use default config offset
    const momentumDirection = marketState.momentum?.direction || 'neutral';
    let effectiveOffsetBps;
    if (momentumDirection === 'up') {
      effectiveOffsetBps = config.entryOffsetUpBps;
    } else if (momentumDirection === 'down') {
      effectiveOffsetBps = config.entryOffsetDownBps;
    } else {
      effectiveOffsetBps = config.entryOffsetBps;
    }

    // Apply macro regime offset multiplier
    effectiveOffsetBps = Math.round(effectiveOffsetBps * macroMult.offsetMult);

    // Place entry with dynamic offset
    let result;
    try {
      result = await orderExecutor.placeEntryBid(sizing.sizeUsdc, marketState.bid, marketState.ask, 0, effectiveOffsetBps);
    } catch (err) {
      // Catch InsufficientFunds (Gemini 406), INSUFFICIENT_AVAILABLE_BALANCE (Crypto.com 500), and similar balance errors
      if (err.message?.includes('InsufficientFunds') || err.message?.includes('INSUFFICIENT_AVAILABLE_BALANCE') || err.status === 406) {
        const cooldownMs = config.insufficientFundsCooldownMs || 60000;
        insufficientFundsCooldownUntil = Date.now() + cooldownMs;
        console.log(`⏸️ [${exchange}] Insufficient funds — pausing entries for ${cooldownMs / 1000}s`);
        return;
      }
      throw err; // Re-throw other errors
    }

    if (result.success) {
      positionState.lastEntryTime = Date.now();
      positionState.anchorPrice = marketState.lastPrice;

      // Persist entry order to state for recovery across restarts
      if (!isDryRun) {
        if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
        positionState.pendingEntryOrders.push({
          orderId: result.orderId,
          price: result.price,
          assetQty: result.assetQty,
          sizeUsdc: sizing.sizeUsdc,
          placedAt: Date.now(),
        });
        saveLiveState();
      }

      const macroLabel = macroRegime ? ` macro=${macroRegime.getMode()}(×${macroMult.sizeMult})` : '';
      console.log(`📝 [${exchange}] Entry placed: regime=${regime}${macroLabel} buys=${positionState.cycleBuys} size=$${sizing.sizeUsdc} price=${fmtPrice(result.price)} trigger=${triggerType} momentum=${momentumDirection} offset=${effectiveOffsetBps}bps`);

      tradeEvents.emitTradeEvent('entry_placed', exchange, `$${sizing.sizeUsdc} @ ${fmtPrice(result.price)}`, {
        regime,
        macroMode: macroRegime ? macroRegime.getMode() : null,
        macroSizeMult: macroMult.sizeMult,
        step: positionState.cycleBuys,
        sizeUsdc: sizing.sizeUsdc,
        price: result.price,
        trigger: triggerType,
        momentum: momentumDirection,
        offsetBps: effectiveOffsetBps,
      });
    }
  };

  /**
   * Calculate base dynamic TP percentage (without tier adjustments)
   * Used for candidate TP calculations and merge proximity checks
   * @returns {number} TP percentage
   */
  const calculateDynamicTpPercent = () => {
    const { recentSwing, lastPrice } = marketState;
    let tpPercent = recentSwing > 0 && lastPrice > 0
      ? (config.tpMult * recentSwing / lastPrice) * 100
      : config.tpMinPercent;

    const regime = regimeDetector.getMode();
    if (regime === 'CAUTION') tpPercent *= 1.5;
    else if (regime === 'TREND') tpPercent *= 0.8;

    const macroTpMult = macroRegime ? macroRegime.getMultipliers().tpMult : 1.0;
    tpPercent *= macroTpMult;

    return clamp(tpPercent, config.tpMinPercent, config.tpMaxPercent);
  };

  /**
   * Place or update TP order for a celestial body
   * Calculates tier-specific TP, applies holdback, places via executor
   * @param {Object} body - CelestialBody
   * @returns {Promise<boolean>} Whether TP was successfully placed
   */
  const placeBodyTp = async (body) => {
    // Extract hints immediately so they never leak if we return early
    const mergeMaxTpPct = body._maxTpPct ?? null;
    const overrideTpPct = body._overrideTpPct ?? null;
    delete body._maxTpPct;
    delete body._overrideTpPct;

    if (body.tpOrderId) {
      console.log(`⚠️ [${exchange}] Body ${body.id.slice(-8)} already has TP ${body.tpOrderId.slice(0, 8)}, skipping duplicate placement`);
      return false;
    }

    // Prevent concurrent TP placement for the same body (race between fill handler and safety-net loop)
    if (tpPlacementInFlight.has(body.id)) {
      console.log(`⚠️ [${exchange}] Body ${body.id.slice(-8)} TP placement already in-flight, skipping`);
      return false;
    }

    tpPlacementInFlight.add(body.id);
    try {

    // Get tier-specific TP percentage
    const baseTpPct = calculateDynamicTpPercent();
    const { tpPercent: tierTpPct } = celestialHierarchy.calculateBodyTpPercent(baseTpPct, body.tier, config.tpMaxPercent);

    // Get tier holdback scale
    const tierCfg = celestialHierarchy.getTierConfig(body.tier);

    // Holdback ratio (needed for fee floor calculation below)
    const holdbackRatio = Math.min((config.holdbackRatio ?? 0.5) * (tierCfg.holdbackScale || 1), 0.95);

    // Minimum profit floor: TP% must clear round-trip fees + $0.01 net USDC profit.
    // Because holdback retains BTC, only (1-h) of gross profit becomes USDC proceeds,
    // so the required TP% = (roundTripFees + minProfit/costBasis) / (1-h)
    const feeRatePerSide = config.feeRate || 0.001; // conservative 10 bps default
    const feeFloorPct = ((2 * feeRatePerSide) + (0.01 / body.costBasis)) / (1 - holdbackRatio) * 100;

    // Holdback floor: TP% must generate enough profit for at least 1 satoshi holdback
    // Only applied when achievable within the tier's effective max TP —
    // tiny bodies that can't produce 1 sat holdback at a reasonable price just get normal TP
    const holdbackFloorPct = (0.00000001 * body.avgPrice) / (body.assetQty * holdbackRatio) * 100;
    const effectiveMax = config.tpMaxPercent * (tierCfg.tpMaxScale || 1);

    const minTpPct = holdbackFloorPct <= effectiveMax
      ? Math.max(feeFloorPct, holdbackFloorPct)
      : feeFloorPct;
    let finalTpPct = Math.min(Math.max(tierTpPct, minTpPct), effectiveMax);

    if (overrideTpPct != null) {
      // User-specified override: use exactly this TP%, subject to fee floor only
      finalTpPct = Math.max(overrideTpPct, minTpPct);
    } else if (body.manualTpPct != null) {
      // Persisted manual override: re-use the user's last manual TP% on re-placement
      finalTpPct = Math.max(body.manualTpPct, minTpPct);
    } else if (mergeMaxTpPct != null) {
      // Merge cap: after a manual merge, TP% must not exceed the pre-merge target's TP%.
      // This guarantees the combined sell price is lower (lower avgPrice × capped TP%).
      finalTpPct = Math.max(Math.min(finalTpPct, mergeMaxTpPct), minTpPct);
    }

    let tpPrice = roundPrice(body.avgPrice * (1 + finalTpPct / 100), priceIncrement);

    // Guard: never place a TP at or below the body's avg price (would realize a loss)
    if (tpPrice <= body.avgPrice) {
      console.log(`🚫 [${exchange}] Body ${body.id.slice(-8)} TP price ${fmtPrice(tpPrice)} <= avgPrice ${fmtPrice(body.avgPrice)}, skipping placement to prevent negative P&L`);
      return false;
    }

    // Calculate sell qty with tier-specific holdback
    let { sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(
      body.assetQty,
      body.avgPrice,
      tpPrice,
      tierCfg.holdbackScale
    );

    // Post-hoc P&L validation: simulate the fill and bump TP% if rounding
    // still causes negative USDC P&L or insufficient holdback
    for (let bump = 0; bump < 10; bump++) {
      const estSellProceeds = sellQty * tpPrice * (1 - feeRatePerSide);
      const estPnl = estSellProceeds - body.costBasis;
      if (estPnl >= 0.01 && holdbackQty >= 0.00000001) break;
      finalTpPct += 0.01;
      tpPrice = roundPrice(body.avgPrice * (1 + finalTpPct / 100), priceIncrement);
      ({ sellQty, holdbackQty } = positionSizer.calculateTakeProfitSize(
        body.assetQty, body.avgPrice, tpPrice, tierCfg.holdbackScale
      ));
    }

    // Final guard: skip if estimated P&L is still negative (e.g. effectiveMax too low)
    const finalEstProceeds = sellQty * tpPrice * (1 - feeRatePerSide);
    const finalEstPnl = finalEstProceeds - body.costBasis;
    if (finalEstPnl < 0.01) {
      console.log(`🚫 [${exchange}] Body ${body.id.slice(-8)} estimated PnL $${finalEstPnl.toFixed(4)} < $0.01 at TP ${fmtPrice(tpPrice)} (${finalTpPct.toFixed(3)}%), skipping to prevent negative P&L`);
      return false;
    }

    if (sellQty <= 0) {
      console.log(`⚠️ [${exchange}] Body ${body.id.slice(-8)} sell qty is 0 after holdback`);
      return false;
    }

    // Pre-check sell qty against exchange minimum order size to avoid failed placements.
    // If holdback pushes qty below minimum, sell the full body (zero holdback).
    // If even the full body is below minimum, skip — it needs more buys to consolidate.
    if (productDetails?.baseMinSize) {
      const baseMinSize = parseFloat(productDetails.baseMinSize);
      const baseIncrement = parseFloat(productDetails.baseIncrement) || 0.00000001;
      const roundedSellQty = Math.floor(sellQty / baseIncrement) * baseIncrement;

      if (roundedSellQty < baseMinSize) {
        const fullQty = roundAsset(body.assetQty);
        const roundedFullQty = Math.floor(fullQty / baseIncrement) * baseIncrement;

        if (roundedFullQty >= baseMinSize) {
          const fullProceeds = fullQty * tpPrice * (1 - feeRatePerSide);
          const fullPnl = fullProceeds - body.costBasis;
          if (fullPnl >= 0.01) {
            console.log(`📏 [${exchange}] Body ${body.id.slice(-8)} sellQty ${sellQty} below exchange min ${baseMinSize}, selling full qty ${fullQty} (no holdback)`);
            sellQty = fullQty;
            holdbackQty = 0;
          } else {
            console.log(`🚫 [${exchange}] Body ${body.id.slice(-8)} full qty ${fullQty} PnL $${fullPnl.toFixed(4)} < $0.01 even without holdback, skipping`);
            return false;
          }
        } else {
          console.log(`📏 [${exchange}] Body ${body.id.slice(-8)} assetQty ${fullQty} (rounded ${roundedFullQty}) below exchange min ${baseMinSize}, waiting for consolidation`);
          return false;
        }
      }
    }

    let result;
    try {
      result = await orderExecutor.placeBodyTpOrder(sellQty, tpPrice, body.id);
    } catch (err) {
      console.log(`⚠️ [${exchange}] Body TP placement error for ${body.id.slice(-8)}: ${err.message}`);
      return false;
    }

    if (result.success) {
      body.tpOrderId = result.orderId;
      body.tpPrice = tpPrice;
      body.assetOnOrder = sellQty;

      // Re-aggregate position-level fields so positionState.assetOnOrder reflects
      // ALL bodies' TP orders, not just the most-recently-placed one. Without this,
      // satellite bodies created after the main body's TP leave assetOnOrder stale,
      // making the dashboard's "On Order" panel under-report by the satellite size.
      celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

      // Link all source buy fills to this sell order (use both sourceOrderIds and buyOrders for coverage)
      const annotatedSrcIds = new Set();
      for (const srcId of (body.sourceOrderIds || [])) {
        fillLedger.annotateFillsByOrderId(srcId, { sellOrderId: result.orderId, bodyId: body.id, bodyTier: body.tier });
        annotatedSrcIds.add(srcId);
      }
      for (const buyOrder of (body.buyOrders || [])) {
        if (buyOrder.orderId !== 'core-migration' && !annotatedSrcIds.has(buyOrder.orderId)) {
          fillLedger.annotateFillsByOrderId(buyOrder.orderId, { sellOrderId: result.orderId, bodyId: body.id, bodyTier: body.tier });
        }
      }

      console.log(`${tierCfg.emoji} [${exchange}] Body TP placed (${body.tier}): ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)} (holdback=${holdbackQty.toFixed(6)} ${baseCurrency}, body=${body.id.slice(-8)})`);

      tradeEvents.emitTradeEvent('body_tp_placed', exchange, `${tierCfg.emoji} ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)}`, {
        bodyId: body.id,
        bodyTier: body.tier,
        assetQty: body.assetQty,
        costBasis: body.costBasis,
        avgPrice: body.avgPrice,
        tpPrice,
        sellQty,
        holdbackQty,
      });

      return true;
    }

    console.log(`⚠️ [${exchange}] Failed to place body TP for ${body.id.slice(-8)}: ${result.errorMessage}`);
    return false;

    } finally {
      tpPlacementInFlight.delete(body.id);
    }
  };

  /**
   * Place or update take-profit order (legacy compat for untracked core position)
   * In celestial mode, body TPs are managed via placeBodyTp()
   * @param {Object} [options] - Options
   * @param {boolean} [options.forceUpdate] - Bypass anti-churn (use after buy fills)
   */
  const placeTakeProfitOrder = async (options = {}) => {
    // In celestial mode, update all body TPs instead
    if (positionState.celestialBodies && positionState.celestialBodies.length > 0) {
      // Cancel any lingering legacy TP order — but only if no body owns it
      if (positionState.activeTpOrderId) {
        const ownedByBody = positionState.celestialBodies.some(b => b.tpOrderId === positionState.activeTpOrderId);
        if (!ownedByBody) {
          console.log(`🧹 [${exchange}] Cancelling legacy TP ${positionState.activeTpOrderId.substring(0, 8)} — celestial mode active`);
          await orderExecutor.cancelTpOrder();
        }
        positionState.activeTpOrderId = null;
        positionState.lastTpPrice = 0;
        positionState.assetOnOrder = 0;
      }

      // Snapshot the array to avoid visiting bodies added concurrently by fill handlers
      const bodiesToCheck = [...positionState.celestialBodies];
      for (const body of bodiesToCheck) {
        if (!body.tpOrderId) {
          await placeBodyTp(body);
        }
      }
      return;
    }

    // Legacy path for untracked core position
    const tpPrice = calculateDynamicTP();

    const { sellQty, holdbackQty, profitAssetValue } = positionSizer.calculateTakeProfitSize(
      positionState.totalAsset,
      positionState.avgCostBasis,
      tpPrice
    );

    if (sellQty <= 0) return;

    const result = await orderExecutor.placeTakeProfitOrder(sellQty, tpPrice, options);

    if (result.filledDuringCancel && result.filledOrderId) {
      // Old TP filled while we were trying to cancel-and-replace — route to fill handler
      console.log(`📋 [${exchange}] TP filled during cancel-and-replace, routing to fill handler: ${result.filledOrderId}`);
      const orderStatus = await adapter.getOrder(result.filledOrderId).catch(() => null);
      if (orderStatus) {
        await handleOrderFill({
          orderId: result.filledOrderId,
          side: 'sell',
          status: 'FILLED',
          filledSize: parseFloat(orderStatus.filledSize || 0),
          filledValue: parseFloat(orderStatus.filledValue || 0),
          averageFilledPrice: parseFloat(orderStatus.averageFilledPrice || 0),
          totalFees: parseFloat(orderStatus.totalFees || 0),
        });
      }
      return;
    }

    if (result.success) {
      positionState.activeTpOrderId = result.orderId;
      positionState.lastTpPrice = tpPrice;
      positionState.assetOnOrder = sellQty;

      // Link all current-cycle non-body buys to this sell order (skip body-owned buys)
      const cycleFills = fillLedger.getCurrentCycleFills();
      for (const fill of cycleFills) {
        if (fill.side === 'buy' && !(fill.isBodyOwned || fill.isSatellite) && !fill.bodyId) {
          fillLedger.annotateFillsByOrderId(fill.orderId, { sellOrderId: result.orderId });
        }
      }

      if (result.updated) {
        console.log(`📝 [${exchange}] TP ${result.orderId ? 'updated' : 'placed'}: ${sellQty} ${baseCurrency} @ ${fmtPrice(tpPrice)} (holdback=${holdbackQty.toFixed(6)} ${baseCurrency} ≈$${profitAssetValue.toFixed(2)})`);
      }
    }
  };

  /**
   * Calculate dynamic take-profit price (legacy for core position)
   * @returns {number}
   */
  const calculateDynamicTP = () => {
    const { avgCostBasis } = positionState;
    const tpPercent = calculateDynamicTpPercent();
    return roundPrice(avgCostBasis * (1 + tpPercent / 100), priceIncrement);
  };

  /**
   * Reset for new cycle
   */
  const resetCycle = async () => {
    // Cancel remaining ladder orders - check both positionState and executor tracking
    const executorLadderOrders = orderExecutor.getPendingLadderOrders ? orderExecutor.getPendingLadderOrders() : [];
    const hasTrackedLadder = (positionState.pendingLadderOrders && positionState.pendingLadderOrders.length > 0) || executorLadderOrders.length > 0;
    if (positionState.ladderActive || hasTrackedLadder) {
      const { cancelled } = await orderExecutor.cancelAllLadderOrders();
      if (cancelled > 0) console.log(`🧹 [${exchange}] Cancelled ${cancelled} unfilled ladder orders`);
    }

    // Reset ladder state
    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // Reset cycle counters and entry tracking
    positionState.cycleBuys = 0;
    positionState.activeTpOrderId = null;
    positionState.lastTpPrice = 0;
    positionState.assetOnOrder = 0;
    positionState.anchorPrice = 0;
    positionState.scalingDisabled = false;
    positionState.scalingDisabledReason = null;
    cycleBuysLimitWarningLogged = false;
    usdcCapWarningLogged = false;
    budgetExhaustedWarningLogged = false;

    // Sync aggregate fields from any remaining bodies
    const bodies = positionState.celestialBodies || [];
    if (bodies.length > 0) {
      celestialHierarchy.syncPositionState(positionState, bodies);
    } else {
      positionState.totalAsset = 0;
      positionState.totalCostBasis = 0;
      positionState.avgCostBasis = 0;
    }

    // Start new cycle in fill ledger
    fillLedger.startNewCycle();
    riskManager.resetCycleTracking();

    const bodyCount = bodies.length;
    const bodyLabel = bodyCount > 0 ? `, ${bodyCount} celestial bodies preserved` : '';
    console.log(`🔄 [${exchange}] Cycle reset, starting new cycle${bodyLabel}`);

    // If the fund is draining, this cycle's TP fill is the trigger to close.
    // Defer the engine stop to next tick so the current call stack
    // (saveLiveState, fillLedger.persist, etc.) finishes cleanly first.
    if (positionState.lifecycle === LIFECYCLE.DRAINING) {
      positionState.lifecycle = LIFECYCLE.CLOSED;
      positionState.lifecycleChangedAt = Date.now();
      positionState.lifecycleClosedCycle = positionState.cyclesCompleted;
      console.log(`🛑 [${exchange}] Fund drained — closing engine after cycle ${positionState.cyclesCompleted}`);
      tradeEvents.emitTradeEvent('fund_closed', exchange, `Fund closed after cycle ${positionState.cyclesCompleted}`, {
        cyclesCompleted: positionState.cyclesCompleted,
        reason: positionState.lifecycleReason,
      });
      if (callbacks.onLifecycleClosed) {
        setImmediate(() => {
          try { callbacks.onLifecycleClosed(); } catch (err) {
            console.log(`⚠️ [${exchange}] onLifecycleClosed callback error: ${err.message}`);
          }
        });
      }
    }
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
      `atr=${fmtPrice(marketState.atr1m)} vol=${marketState.realizedVol.toFixed(2)}%`
    );
  };

  // Set up dry-run callbacks now that all functions are defined
  if (isDryRun) {
    dryRunCallbacks.onBuyFill = async (orderId, assetQty, price, costBasis) => {
      const newBuy = { assetQty, costBasis, avgPrice: price, buyOrderId: orderId };
      const candidateTpPrice = roundPrice(price * (1 + calculateDynamicTpPercent() / 100), priceIncrement);

      const bodies = positionState.celestialBodies || [];
      let mergeTarget = celestialHierarchy.findMergeTarget(
        bodies, newBuy, config.maxUsdcDeployed, candidateTpPrice,
        config.maxCelestialBodies || 10, orderExecutor.getPendingCounts().total, config.maxOpenOrders
      );

      positionState.cycleBuys += 1;
      positionState.lastEntryPrice = price;
      positionState.lastEntryTime = Date.now();

      if (mergeTarget) {
        const cancelResult = await orderExecutor.cancelBodyTpOrder(mergeTarget.id);
        if (!cancelResult.cancelled) {
          console.log(`⚠️ [${exchange}] [DRY-RUN] Body ${mergeTarget.id.slice(-8)} TP ${cancelResult.filled ? 'already filled' : 'cancel failed'}, redirecting buy to new body`);
          mergeTarget = null;
        } else {
          // Clear body TP fields so placeBodyTp can re-place after merge
          mergeTarget.tpOrderId = null;
          mergeTarget.tpPrice = 0;
          mergeTarget.assetOnOrder = 0;
        }
      }

      if (mergeTarget) {
        const merged = celestialHierarchy.mergeIntoBody(mergeTarget, newBuy, config.maxUsdcDeployed);
        const idx = positionState.celestialBodies.findIndex(b => b.id === merged.id);
        if (idx !== -1) positionState.celestialBodies[idx] = merged;

        celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
        await placeBodyTp(merged);

        tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)} [merged→${merged.tier}]`, {
          assetAmount: assetQty, price, bodyId: merged.id, bodyTier: merged.tier, isMerge: true, isDryRun: true,
        });
      } else {
        const body = celestialHierarchy.createNewBody(newBuy, orderId);
        positionState.celestialBodies = positionState.celestialBodies || [];
        positionState.celestialBodies.push(body);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
        await placeBodyTp(body);

        tradeEvents.emitTradeEvent('buy_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)} [new ${body.tier}]`, {
          assetAmount: assetQty, price, bodyId: body.id, bodyTier: body.tier, isDryRun: true,
        });
      }

      saveDryRunState();
    };

    dryRunCallbacks.onSellFill = async (orderId, assetQty, price, proceeds, pnl) => {
      // Find matching celestial body by TP order ID
      const bodies = positionState.celestialBodies || [];
      const bodyIdx = bodies.findIndex(b => b.tpOrderId === orderId);

      if (bodyIdx !== -1) {
        // CELESTIAL BODY TP FILL in dry-run
        const body = bodies[bodyIdx];
        const tierCfg = celestialHierarchy.getTierConfig(body.tier);
        const holdbackAsset = roundAsset(body.assetQty - assetQty);

        const cs = positionState.celestialState || celestialHierarchy.createInitialCelestialState();
        cs.bodiesCompleted += 1;
        cs.bodiesRealizedPnL += pnl;
        cs.bodiesRealizedAssetPnL += holdbackAsset;
        positionState.celestialState = cs;

        positionState.realizedPnL += pnl;
        positionState.realizedAssetPnL += holdbackAsset;

        const prevMaxUsdc = config.maxUsdcDeployed;
        config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
        updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

        positionState.celestialBodies.splice(bodyIdx, 1);
        orderExecutor.removeBodyTracking(orderId);
        celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

        console.log(`${tierCfg.emoji} [${exchange}] [DRY-RUN] Body TP filled (${body.tier}): ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}, capital: $${prevMaxUsdc.toFixed(2)}→$${config.maxUsdcDeployed.toFixed(2)}`);

        tradeEvents.emitTradeEvent('body_tp_filled', exchange, `[DRY-RUN] ${tierCfg.emoji} ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}`, {
          assetAmount: assetQty, price, pnl, holdbackAsset,
          bodyId: body.id, bodyTier: body.tier, isDryRun: true,
        });

        // If no bodies remain, full cycle reset
        if (positionState.celestialBodies.length === 0) {
          positionState.cyclesCompleted += 1;
          const actualTpPct = body.avgPrice > 0 ? ((price - body.avgPrice) / body.avgPrice) * 100 : 0;

          const optimalAnalytics = orderExecutor.getOptimalTpAnalytics
            ? orderExecutor.getOptimalTpAnalytics() : null;
          const lastCycle = optimalAnalytics?.cycles?.[optimalAnalytics.cycles.length - 1];
          const optimalTpPct = lastCycle?.optimalTpPct || actualTpPct;

          recordCycleForOptimizer({ optimalTpPct, actualTpPct });
          recordCycleForSizeOptimizer({
            stepsUsed: positionState.cycleBuys,
            capitalDeployed: body.costBasis,
          }, config.maxUsdcDeployed);

          await resetCycle();
        }
      } else {
        // Fallback: untracked sell (legacy core TP or unknown)
        const holdbackAsset = roundAsset(positionState.totalAsset - assetQty);
        positionState.realizedPnL += pnl;
        positionState.realizedAssetPnL += holdbackAsset;
        positionState.assetOnOrder = 0;
        positionState.cyclesCompleted += 1;

        const prevMaxUsdc = config.maxUsdcDeployed;
        config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
        updateRegimeConfig(exchange, pair, { maxUsdcDeployed: config.maxUsdcDeployed });

        console.log(`💰 [${exchange}] [DRY-RUN] Capital growth: $${prevMaxUsdc.toFixed(2)} → $${config.maxUsdcDeployed.toFixed(2)} (+$${pnl.toFixed(2)})`);

        tradeEvents.emitTradeEvent('tp_filled', exchange, `[DRY-RUN] ${assetQty} ${baseCurrency} @ ${fmtPrice(price)}, PnL=$${pnl.toFixed(2)}`, {
          assetAmount: assetQty, price, pnl, holdbackAsset, isDryRun: true,
        });

        const actualTpPct = positionState.avgCostBasis > 0
          ? ((price - positionState.avgCostBasis) / positionState.avgCostBasis) * 100 : 0;
        recordCycleForOptimizer({ optimalTpPct: actualTpPct, actualTpPct });
        recordCycleForSizeOptimizer({
          stepsUsed: positionState.cycleBuys,
          capitalDeployed: positionState.totalCostBasis,
        }, config.maxUsdcDeployed);

        await resetCycle();
      }

      saveDryRunState();
    };
  }

  // Set up live mode fill detection callback (backup for when WebSocket misses fills)
  if (!isDryRun) {
    liveCallbacks.onFillDetected = async (orderId, status) => {
      if (recentlyProcessedFills.has(orderId)) {
        console.log(`⚠️ [${exchange}] Duplicate fill callback for ${orderId}, skipping`);
        return;
      }
      recentlyProcessedFills.add(orderId);
      const t2 = setTimeout(() => { recentlyProcessedFills.delete(orderId); ttlTimers.delete(t2); }, 60000);
      ttlTimers.add(t2);
      console.log(`🔄 [${exchange}] Processing fill detected via polling: ${orderId} side=${status.side}`);
      // Convert status to the format handleOrderFill expects
      const fillData = {
        orderId,
        side: status.side,
        status: 'FILLED',
        filledSize: status.filledSize,
        filledValue: status.filledValue,
        averageFilledPrice: status.averageFilledPrice,
        totalFees: status.totalFees,
        placedAt: status.placedAt, // Passed from order executor for fill time tracking
      };
      await handleOrderFill(fillData);
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
    macro: macroRegime ? macroRegime.getState() : null,
    health: healthMonitor.getState(),
    pause: tailEvents.getPauseState(),
    risk: riskManager.getState(),
    orders: orderExecutor.getPendingCounts(),
    pendingOrders: !isDryRun && orderExecutor.getPendingOrdersList
      ? orderExecutor.getPendingOrdersList().map(order => {
        // Normalize take_profit → body_tp if a celestial body owns this order
        if (order.type === 'take_profit') {
          const matchingBody = (positionState.celestialBodies || []).find(b => b.tpOrderId === order.orderId);
          if (matchingBody) {
            const tierCfg = celestialHierarchy.getTierConfig(matchingBody.tier);
            return {
              ...order,
              type: 'body_tp',
              tpPercent: matchingBody.avgPrice > 0 ? ((order.price - matchingBody.avgPrice) / matchingBody.avgPrice * 100).toFixed(2) : null,
              bodyId: matchingBody.id,
              bodyTier: matchingBody.tier,
              tierEmoji: tierCfg ? tierCfg.emoji : '🛰️',
              bodyAvgCost: matchingBody.avgPrice,
              bodyBtcQty: matchingBody.assetQty,
              bodyCostBasis: matchingBody.costBasis,
            };
          }
          if (positionState.avgCostBasis > 0) {
            return {
              ...order,
              tpPercent: ((order.price - positionState.avgCostBasis) / positionState.avgCostBasis * 100).toFixed(2),
            };
          }
        }
        // Add cost basis + TP% for body_tp orders from their independent position
        if (order.type === 'body_tp' || order.type === 'satellite_tp') {
          const body = (positionState.celestialBodies || []).find(b => b.tpOrderId === order.orderId);
          const avgPrice = body ? body.avgPrice : 0;
          const tierCfg = body ? celestialHierarchy.getTierConfig(body.tier) : null;
          return {
            ...order,
            tpPercent: avgPrice > 0 ? ((order.price - avgPrice) / avgPrice * 100).toFixed(2) : null,
            bodyId: body ? body.id : null,
            bodyTier: body ? body.tier : null,
            tierEmoji: tierCfg ? tierCfg.emoji : '🛰️',
            bodyAvgCost: avgPrice,
            bodyBtcQty: body ? body.assetQty : order.size,
            bodyCostBasis: body ? body.costBasis : 0,
          };
        }
        return order;
      })
      : [],
    apy: calculateApyMetrics(),
    dryRun: isDryRun && orderExecutor.getDryRunState ? orderExecutor.getDryRunState() : null,
    tpOptimizer: tpOptimizer.getStatus(),
    sizeOptimizer: sizeOptimizer.getStatus(),
    fillTimeStats: fillLedger.getFillTimeStats ? fillLedger.getFillTimeStats(7) : null,
    effectiveStaleMs: !isDryRun && orderExecutor.getEffectiveStaleMs ? orderExecutor.getEffectiveStaleMs() : config.orderStaleMs,
    // Include current config for real-time dashboard updates
    config: {
      maxUsdcDeployed: config.maxUsdcDeployed,
      baseSizeUsdc: config.baseSizeUsdc,
      maxCycleBuys: config.maxCycleBuys,
      tpMinPercent: config.tpMinPercent,
      tpMaxPercent: config.tpMaxPercent,
      holdbackRatio: config.holdbackRatio,
      entryMode: config.entryMode || 'reactive',
      ladderAutoSwitch: config.ladderAutoSwitch || false,
      ladderMaxAthDropPct: config.ladderMaxAthDropPct || 80,
      ladderSpacingMode: config.ladderSpacingMode || 'sqrt',
      ladderSizeMode: config.ladderSizeMode || 'fibonacci',
      ladderMinSpacingPct: config.ladderMinSpacingPct || 0.5,
      celestialEnabled: config.celestialEnabled !== false,
      maxCelestialBodies: config.maxCelestialBodies || 10,
      macroEnabled: config.macroEnabled || false,
    },
    // Effective entry mode (may differ from config due to auto-switch)
    entryMode: (() => {
      let mode = config.entryMode || 'reactive';
      if (config.ladderAutoSwitch && marketState.volBaseline > 0) {
        const volExpansion = marketState.realizedVol / marketState.volBaseline;
        if (volExpansion >= (config.ladderAutoSwitchVolMult || 2.0)) {
          mode = 'ladder';
        }
      }
      return mode;
    })(),
    // Auto-switch debug info
    autoSwitch: config.ladderAutoSwitch ? {
      volExpansion: marketState.volBaseline > 0 ? parseFloat((marketState.realizedVol / marketState.volBaseline).toFixed(2)) : 0,
      threshold: config.ladderAutoSwitchVolMult || 2.0,
      wouldTrigger: marketState.volBaseline > 0 && (marketState.realizedVol / marketState.volBaseline) >= (config.ladderAutoSwitchVolMult || 2.0),
    } : null,
    ladder: positionState.ladderActive ? {
      active: true,
      placedAt: positionState.ladderPlacedAt,
      lowerBound: positionState.ladderLowerBound,
      pendingOrders: positionState.pendingLadderOrders?.length || 0,
      committedUsdc: (positionState.pendingLadderOrders || []).reduce((sum, o) => sum + (o.sizeUsdc || 0), 0),
    } : null,
    celestial: {
      enabled: config.celestialEnabled !== false,
      bodies: (positionState.celestialBodies || []).map(b => {
        const tierCfg = celestialHierarchy.getTierConfig(b.tier);
        return {
          id: b.id,
          tier: b.tier,
          emoji: tierCfg.emoji,
          assetQty: b.assetQty,
          costBasis: b.costBasis,
          avgPrice: b.avgPrice,
          tpOrderId: b.tpOrderId,
          tpPrice: b.tpPrice,
          tpPercent: b.avgPrice > 0 && b.tpPrice > 0 ? ((b.tpPrice - b.avgPrice) / b.avgPrice * 100).toFixed(2) : null,
          assetOnOrder: b.assetOnOrder,
          createdAt: b.createdAt,
          lastMergedAt: b.lastMergedAt,
          mergeCount: b.mergeCount,
          buyOrders: (b.buyOrders || []).map(bo => ({
            orderId: bo.orderId,
            price: bo.price,
            assetQty: bo.assetQty,
            sizeUsdc: bo.sizeUsdc,
            filledAt: bo.filledAt,
          })),
        };
      }),
      bodiesActive: (positionState.celestialBodies || []).length,
      bodiesCompleted: positionState.celestialState?.bodiesCompleted || 0,
      bodiesRealizedPnL: positionState.celestialState?.bodiesRealizedPnL || 0,
      bodiesRealizedAssetPnL: positionState.celestialState?.bodiesRealizedAssetPnL || 0,
      tierSummary: celestialHierarchy.getTierSummary(positionState.celestialBodies || []),
    },
    // Body TP aggregates (legacy key "satellites" kept for UI compat)
    satellites: {
      enabled: config.celestialEnabled !== false,
      active: (positionState.celestialBodies || []).length,
      completed: positionState.celestialState?.bodiesCompleted || 0,
      realizedPnL: positionState.celestialState?.bodiesRealizedPnL || 0,
      realizedAssetPnL: positionState.celestialState?.bodiesRealizedAssetPnL || 0,
      orders: (positionState.celestialBodies || []).map(b => ({
        buyOrderId: b.id?.substring(0, 8),
        tpOrderId: b.tpOrderId,
        assetQty: b.assetQty,
        costBasis: b.costBasis,
        avgPrice: b.avgPrice,
        tpPrice: b.tpPrice,
        assetOnOrder: b.assetOnOrder,
        placedAt: b.createdAt,
      })),
    },
    lifecycle: {
      lifecycle: positionState.lifecycle || LIFECYCLE.ACTIVE,
      lifecycleChangedAt: positionState.lifecycleChangedAt || null,
      lifecycleReason: positionState.lifecycleReason || null,
      lifecycleClosedCycle: positionState.lifecycleClosedCycle || null,
    },
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
   * Mark fund as draining: block all new entries, cancel any pending entry
   * orders, and let the current take-profit cycle complete naturally. When
   * the cycle's TP fills, resetCycle() transitions the lifecycle to closed
   * and invokes callbacks.onLifecycleClosed so the host process can stop
   * the engine.
   * @param {string} [reason]
   * @returns {{success: boolean, lifecycle?: string, error?: string}}
   */
  const close = (reason) => {
    if (positionState.lifecycle === LIFECYCLE.CLOSED) {
      return { success: false, error: 'Fund is already closed' };
    }
    if (positionState.lifecycle === LIFECYCLE.DRAINING) {
      return { success: false, error: 'Fund is already draining' };
    }
    positionState.lifecycle = LIFECYCLE.DRAINING;
    positionState.lifecycleChangedAt = Date.now();
    positionState.lifecycleReason = reason || null;
    if (!isDryRun) {
      saveLiveState();
    }
    // Cancel pending entry orders so the order book doesn't keep stale buys.
    // TP orders are NOT touched — they're what drains the cycle.
    orderExecutor.cancelAllEntries().catch((err) => {
      console.log(`⚠️ [${exchange}] Failed to cancel entries during close: ${err.message}`);
    });
    console.log(`🚦 [${exchange}] Fund draining${reason ? ` (${reason})` : ''} — new entries blocked, awaiting TP fill`);
    tradeEvents.emitTradeEvent('fund_draining', exchange, `Fund draining${reason ? `: ${reason}` : ''}`, {
      reason: reason || null,
      cyclesCompleted: positionState.cyclesCompleted,
    });
    return { success: true, lifecycle: LIFECYCLE.DRAINING };
  };

  /**
   * Get fund lifecycle state
   */
  const getLifecycle = () => ({
    lifecycle: positionState.lifecycle || LIFECYCLE.ACTIVE,
    lifecycleChangedAt: positionState.lifecycleChangedAt || null,
    lifecycleReason: positionState.lifecycleReason || null,
    lifecycleClosedCycle: positionState.lifecycleClosedCycle || null,
  });

  /**
   * Get current status (alias for getState for API consistency)
   * @returns {Object}
   */
  const getStatus = () => getState();

  /**
   * Update configuration
   * Tracks manual capital additions to depositedCapital
   * @param {Object} updates - Config updates
   */
  const updateConfig = (updates) => {
    // Direct depositedCapital edit - sync to position state
    if (updates.depositedCapital !== undefined && updates.depositedCapital !== config.depositedCapital) {
      positionState.depositedCapital = updates.depositedCapital > 0 ? roundUSDC(updates.depositedCapital) : 0;
      console.log(`💵 [${exchange}] Deposited capital set to $${updates.depositedCapital > 0 ? updates.depositedCapital.toFixed(2) : 'auto-derive'}`);
      if (!isDryRun) saveLiveState();
      else saveDryRunState();
    }
    // Track manual capital additions (user deposits, not profits)
    // Skip auto-adjust when depositedCapital was explicitly provided (already handled above)
    if (updates.maxUsdcDeployed !== undefined && updates.maxUsdcDeployed !== config.maxUsdcDeployed && updates.depositedCapital === undefined) {
      const capitalChange = updates.maxUsdcDeployed - config.maxUsdcDeployed;
      if (capitalChange > 0) {
        // User added capital - update depositedCapital
        const prevDeposited = positionState.depositedCapital || positionState.originalCapital || config.maxUsdcDeployed;
        positionState.depositedCapital = roundUSDC(prevDeposited + capitalChange);
        console.log(`💵 [${exchange}] Capital deposit: +$${capitalChange.toFixed(2)} (deposited: $${positionState.depositedCapital.toFixed(2)})`);
        // Save state to persist the deposit tracking
        if (!isDryRun) saveLiveState();
        else saveDryRunState();
      } else if (capitalChange < 0) {
        // User withdrew capital - reduce depositedCapital (but floor at 0)
        const prevDeposited = positionState.depositedCapital || positionState.originalCapital || config.maxUsdcDeployed;
        positionState.depositedCapital = roundUSDC(Math.max(0, prevDeposited + capitalChange));
        console.log(`💸 [${exchange}] Capital withdrawal: $${Math.abs(capitalChange).toFixed(2)} (deposited: $${positionState.depositedCapital.toFixed(2)})`);
        if (!isDryRun) saveLiveState();
        else saveDryRunState();
      }
    }
    Object.assign(config, updates);

    // Forward macro config changes
    if (macroRegime) {
      macroRegime.updateConfig(updates);
    }

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
      dryRunState.clearState(exchange, pair);
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
    const currentValue = positionState.totalAsset * marketState.lastPrice;
    const currentEquity = currentValue - positionState.totalCostBasis;

    riskManager.forceResume(currentEquity);
    console.log(`▶️ [${exchange}] Drawdown pause manually cleared, peak reset to $${currentEquity.toFixed(2)}`);

    return { success: true, message: `Resumed, peak reset to $${currentEquity.toFixed(2)}` };
  };

  /**
   * Update position state externally (e.g., from recalculate)
   * @param {Object} newPosition - New position values to merge
   */
  const updatePosition = (newPosition) => {
    positionState = {
      ...positionState,
      ...newPosition,
    };
    saveLiveState();
    console.log(`🔄 [${exchange}] Position updated externally: buys=${positionState.cycleBuys}, cycles=${positionState.cyclesCompleted}, ${baseCurrency} reserves=${positionState.realizedAssetPnL}`);
  };

  /**
   * Manually merge a body into the next-highest body by TP price.
   * Cancels both TPs, combines all buys, re-places a single merged TP.
   * @param {string} bodyId - ID of the source body (lower TP) to roll up
   * @returns {Promise<{success: boolean, message: string, mergedBody?: Object}>}
   */
  const manualMergeBody = async (bodyId) => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    const bodies = positionState.celestialBodies || [];
    if (bodies.length < 2) {
      return { success: false, message: 'Need at least 2 bodies to merge' };
    }
    const source = bodies.find(b => b.id === bodyId);
    if (!source) {
      return { success: false, message: `Body ${bodyId} not found` };
    }

    // Find next-highest body by tpPrice (lowest tpPrice above source's)
    const candidates = bodies
      .filter(b => b.id !== source.id && b.tpPrice > source.tpPrice)
      .sort((a, b) => a.tpPrice - b.tpPrice);
    if (candidates.length === 0) {
      return { success: false, message: 'No higher body to merge into (this is the highest)' };
    }
    const target = candidates[0];

    // Check both orders for partial fills before merging
    for (const body of [source, target]) {
      if (body.tpOrderId) {
        const orderStatus = await adapter.getOrder(body.tpOrderId).catch(() => null);
        if (orderStatus && orderStatus.filledSize > 0) {
          const label = body === source ? 'Source' : 'Target';
          return { success: false, message: `${label} body ${body.id.slice(-8)} has a partially filled TP order (${orderStatus.filledSize} filled) — cannot merge` };
        }
      }
    }

    console.log(`🔗 [${exchange}] Manual roll-up: merging body ${source.id.slice(-8)} (TP ${fmtPrice(source.tpPrice)}) → ${target.id.slice(-8)} (TP ${fmtPrice(target.tpPrice)})`);

    // Race 3: snapshot both bodies before cancelling TPs
    // If a TP fills between cancel and state removal, the fill handler uses the snapshot
    const sourceSnapshot = { ...source };
    const targetSnapshot = { ...target };
    if (source.tpOrderId) pendingMergeTpOrders.set(source.tpOrderId, sourceSnapshot);
    if (target.tpOrderId) pendingMergeTpOrders.set(target.tpOrderId, targetSnapshot);

    // Capture pre-merge TP% so the merged body's TP% can only decrease, never increase.
    // Merging cheaper buys lowers avgPrice; capping at prevTpPct ensures the absolute
    // sell price also decreases (new tpPrice = lowerAvgPrice × cappedTpPct < oldTpPrice).
    const prevTargetTpPct = targetSnapshot.tpPrice > 0 && targetSnapshot.avgPrice > 0
      ? (targetSnapshot.tpPrice / targetSnapshot.avgPrice - 1) * 100
      : null;

    // Cancel source TP
    const srcCancel = await orderExecutor.cancelBodyTpOrder(source.id);
    if (!srcCancel.cancelled) {
      // Clean up snapshots
      if (source.tpOrderId) pendingMergeTpOrders.delete(source.tpOrderId);
      if (target.tpOrderId) pendingMergeTpOrders.delete(target.tpOrderId);
      const reason = srcCancel.filled ? 'already filled' : 'cancel failed';
      console.log(`⚠️ [${exchange}] Source body ${source.id.slice(-8)} TP ${reason}, aborting roll-up`);
      return { success: false, message: `Source TP ${reason}` };
    }
    // Clear source body TP fields after successful cancel
    source.tpOrderId = null;
    source.tpPrice = 0;
    source.assetOnOrder = 0;

    // Cancel target TP
    const tgtCancel = await orderExecutor.cancelBodyTpOrder(target.id);
    if (!tgtCancel.cancelled) {
      // Clean up snapshots
      if (sourceSnapshot.tpOrderId) pendingMergeTpOrders.delete(sourceSnapshot.tpOrderId);
      if (target.tpOrderId) pendingMergeTpOrders.delete(target.tpOrderId);
      // Restore source TP to avoid leaving it dangling
      console.log(`⚠️ [${exchange}] Target body ${target.id.slice(-8)} TP cancel failed, restoring source TP`);
      await placeBodyTp(source);
      saveLiveState();
      return { success: false, message: 'Target TP cancel failed, source restored' };
    }
    // Clear target body TP fields after successful cancel
    target.tpOrderId = null;
    target.tpPrice = 0;
    target.assetOnOrder = 0;

    // Merge bodies (pure data)
    const merged = celestialHierarchy.mergeBodies(target, source, config.maxUsdcDeployed);

    // Remove source from celestialBodies
    positionState.celestialBodies = positionState.celestialBodies.filter(b => b.id !== source.id);

    // Move snapshots from pending → completed (5min TTL for late-arriving fills)
    if (sourceSnapshot.tpOrderId) {
      pendingMergeTpOrders.delete(sourceSnapshot.tpOrderId);
      completedMergeTpOrders.set(sourceSnapshot.tpOrderId, sourceSnapshot);
      const t3 = setTimeout(() => { completedMergeTpOrders.delete(sourceSnapshot.tpOrderId); ttlTimers.delete(t3); }, 300000);
      ttlTimers.add(t3);
    }
    if (targetSnapshot.tpOrderId) {
      pendingMergeTpOrders.delete(targetSnapshot.tpOrderId);
      completedMergeTpOrders.set(targetSnapshot.tpOrderId, targetSnapshot);
      const t4 = setTimeout(() => { completedMergeTpOrders.delete(targetSnapshot.tpOrderId); ttlTimers.delete(t4); }, 300000);
      ttlTimers.add(t4);
    }

    // Check cascading promotions and sync aggregates
    celestialHierarchy.checkPromotions(positionState.celestialBodies, config.maxUsdcDeployed);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);

    // Re-annotate source body's fills with merged body's ID
    for (const srcId of (source.sourceOrderIds || [])) {
      fillLedger.annotateFillsByOrderId(srcId, { bodyId: merged.id, bodyTier: merged.tier });
    }
    for (const buyOrder of (source.buyOrders || [])) {
      if (buyOrder.orderId && buyOrder.orderId !== 'core-migration') {
        fillLedger.annotateFillsByOrderId(buyOrder.orderId, { bodyId: merged.id, bodyTier: merged.tier });
      }
    }

    // Place new combined TP (handles holdback, annotation for ALL source buy fills).
    // Cap TP% at the pre-merge target level so the sell price can only go down after merge.
    if (prevTargetTpPct != null) merged._maxTpPct = prevTargetTpPct;
    await placeBodyTp(merged);

    // Persist
    saveLiveState();
    fillLedger.persist();

    const tierCfg = celestialHierarchy.getTierConfig(merged.tier);
    console.log(`${tierCfg.emoji} [${exchange}] Roll-up complete: body ${merged.id.slice(-8)} now ${merged.tier} (${merged.assetQty.toFixed(6)} ${baseCurrency}, $${merged.costBasis.toFixed(2)}, ${merged.buyOrders?.length || 0} buys)`);

    tradeEvents.emitTradeEvent('body_rollup', exchange, `${tierCfg.emoji} Merged → ${merged.tier}: ${merged.assetQty.toFixed(6)} ${baseCurrency}`, {
      mergedBodyId: merged.id,
      mergedTier: merged.tier,
      assetQty: merged.assetQty,
      costBasis: merged.costBasis,
      avgPrice: merged.avgPrice,
      sourceBodyId: source.id,
      buyCount: merged.buyOrders?.length || 0,
    });

    // Push updated status via WebSocket so dashboard animation refreshes immediately
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(getState());

    return {
      success: true,
      message: `Merged ${source.id.slice(-8)} → ${merged.id.slice(-8)} (${merged.tier})`,
      mergedBody: {
        id: merged.id,
        tier: merged.tier,
        assetQty: merged.assetQty,
        costBasis: merged.costBasis,
        avgPrice: merged.avgPrice,
        buyCount: merged.buyOrders?.length || 0,
      },
    };
  };

  /**
   * Manually set the TP% for a specific celestial body.
   * Cancels the existing TP, then re-places it at the specified percentage above avgPrice.
   * The override is subject to the fee floor (cannot be set so low it loses money).
   * @param {string} bodyId
   * @param {number} tpPct - Desired TP% (e.g. 2.5 means 2.5% above avgPrice)
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const setBodyTpPercent = async (bodyId, tpPct) => {
    if (!isRunning) return { success: false, message: 'Engine not running' };

    const body = (positionState.celestialBodies || []).find(b => b.id === bodyId);
    if (!body) return { success: false, message: `Body ${bodyId.slice(-8)} not found` };

    if (body.tpOrderId) {
      const cancelResult = await orderExecutor.cancelBodyTpOrder(body.id);
      if (!cancelResult.cancelled) {
        const reason = cancelResult.filled ? 'already filled' : 'cancel failed';
        return { success: false, message: `Existing TP ${reason}` };
      }
      body.tpOrderId = null;
      body.tpPrice = 0;
      body.assetOnOrder = 0;
    }

    body.manualTpPct = tpPct;
    body._overrideTpPct = tpPct;
    const placed = await placeBodyTp(body);

    if (!placed) {
      return { success: false, message: `Could not place TP at ${tpPct.toFixed(2)}% — below fee floor or invalid` };
    }

    const tierCfg = celestialHierarchy.getTierConfig(body.tier);
    console.log(`${tierCfg.emoji} [${exchange}] Manual TP% set: body ${body.id.slice(-8)} @ ${tpPct.toFixed(2)}% → ${fmtPrice(body.tpPrice)}`);

    saveLiveState();
    if (callbacks.onStatusUpdate) callbacks.onStatusUpdate(getState());

    return {
      success: true,
      message: `TP set to ${body.tpPrice ? fmtPrice(body.tpPrice) : `${tpPct.toFixed(2)}%`} for body ${bodyId.slice(-8)}`,
      status: getStatus(),
    };
  };

  /**
   * Manually set the TP limit price for a specific celestial body.
   * Converts to TP% internally and delegates to the same placement flow.
   * @param {string} bodyId
   * @param {number} limitPrice - Desired limit price (must be above avgPrice + fee floor)
   * @returns {Promise<{success: boolean, message: string, status?: Object}>}
   */
  const setBodyTpPrice = async (bodyId, limitPrice) => {
    if (!isRunning) return { success: false, message: 'Engine not running' };

    const body = (positionState.celestialBodies || []).find(b => b.id === bodyId);
    if (!body) return { success: false, message: `Body ${bodyId.slice(-8)} not found` };
    if (body.avgPrice <= 0) return { success: false, message: 'Body has no avg price' };
    if (limitPrice <= body.avgPrice) return { success: false, message: `Price must be above avg cost ${fmtPrice(body.avgPrice)}` };

    const tpPct = ((limitPrice - body.avgPrice) / body.avgPrice) * 100;
    return setBodyTpPercent(bodyId, tpPct);
  };

  /**
   * Force rebuild of TP sell order with current position
   * Useful when position state was corrected manually
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const rebuildTP = async () => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    if (positionState.totalAsset <= 0) {
      return { success: false, message: 'No position to protect' };
    }
    console.log(`🔄 [${exchange}] Manual TP rebuild requested for ${positionState.totalAsset.toFixed(8)} ${baseCurrency}`);
    await placeTakeProfitOrder({ forceUpdate: true });
    return { success: true, message: `TP rebuilt for ${positionState.totalAsset.toFixed(8)} ${baseCurrency} @ ${fmtPrice(positionState.lastTpPrice)}` };
  };

  /**
   * Preview what a ladder rebuild would place (dry calculation, no orders)
   * @returns {{success: boolean, message?: string, preview?: Object}}
   */
  /**
   * Compute allocated capital defensively: use totalCostBasis but floor at
   * celestial body sum in case totalCostBasis is stale (e.g. after mode switch).
   */
  const getAllocatedCapital = () => {
    const bodiesCost = (positionState.celestialBodies || []).reduce((sum, b) => sum + (b.costBasis || 0), 0);
    return Math.max(positionState.totalCostBasis || 0, bodiesCost);
  };

  const previewLadder = async () => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    if ((config.entryMode || 'reactive') !== 'ladder') {
      return { success: false, message: 'Entry mode is not ladder' };
    }

    const allocatedCapital = getAllocatedCapital();
    let remainingBudget = config.maxUsdcDeployed - allocatedCapital;

    // Fetch actual exchange balance to cap budget at reality
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
    const exchangeBalance = quoteBalance ? (parseFloat(quoteBalance.available) || 0) : null;
    if (exchangeBalance !== null && exchangeBalance < remainingBudget) {
      remainingBudget = exchangeBalance;
    }

    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      const budgetRemaining = (config.maxUsdcDeployed - allocatedCapital).toFixed(2);
      const balanceStr = exchangeBalance !== null ? `$${exchangeBalance.toFixed(2)}` : 'unknown';
      return { success: false, message: `Exchange ${quoteCurrency} balance (${balanceStr}) below min order ($${config.baseSizeUsdc || 50}). Budget shows $${budgetRemaining} remaining but exchange only has ${balanceStr} ${quoteCurrency}.` };
    }

    const ladder = ladderCalculator.buildLadder(
      marketState.lastPrice,
      remainingBudget,
      {
        atr: marketState.atr1m,
        volBaseline: marketState.volBaseline,
        realizedVol: marketState.realizedVol,
        athDistance: marketState.athDistance || 0,
        ath: marketState.ath || 0,
        priceIncrement,
      }
    );

    return {
      success: true,
      preview: {
        levelCount: ladder.levels.length,
        levels: ladder.levels.map(l => ({
          price: l.price,
          sizeUsdc: l.sizeUsdc,
          assetQty: l.assetQty,
          distancePct: l.distancePct,
        })),
        lowerBound: ladder.lowerBound,
        lowerBoundPct: ladder.lowerBoundPct,
        totalBudget: ladder.totalBudget,
        allocatedCapital,
        exchangeBalance,
        maxUsdcDeployed: config.maxUsdcDeployed,
        currentPrice: marketState.lastPrice,
      },
    };
  };

  /**
   * Cancel existing ladder orders and rebuild from scratch
   * Bypasses health/regime guards (user-initiated)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  const rebuildLadder = async () => {
    if (!isRunning) {
      return { success: false, message: 'Engine not running' };
    }
    if ((config.entryMode || 'reactive') !== 'ladder') {
      return { success: false, message: 'Entry mode is not ladder' };
    }

    const allocatedCapital = getAllocatedCapital();
    let remainingBudget = config.maxUsdcDeployed - allocatedCapital;
    const quoteCurrency = getQuoteCurrency(productId);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency).catch(() => null);
    if (!quoteBalance) {
      return { success: false, message: 'Could not fetch account balance — skipping ladder' };
    }
    const availableQuote = parseFloat(quoteBalance.available) || 0;
    if (availableQuote < remainingBudget) {
      remainingBudget = availableQuote;
    }
    if (remainingBudget < (config.baseSizeUsdc || 50)) {
      const budgetRemaining = (config.maxUsdcDeployed - allocatedCapital).toFixed(2);
      return { success: false, message: `Exchange ${quoteCurrency} balance ($${availableQuote.toFixed(2)}) below min order size ($${config.baseSizeUsdc || 50}). Budget says $${budgetRemaining} available but only $${availableQuote.toFixed(2)} ${quoteCurrency} on exchange. Deposit more ${quoteCurrency} or lower baseSizeUsdc.` };
    }

    console.log(`🔄 [${exchange}] Manual ladder rebuild requested, budget=$${remainingBudget.toFixed(2)} (allocated=$${allocatedCapital.toFixed(2)})`);

    // Cancel existing ladder orders
    if (positionState.ladderActive) {
      const cancelResult = await orderExecutor.cancelAllLadderOrders();
      console.log(`🧹 [${exchange}] Cancelled ${cancelResult.cancelled} existing ladder orders`);
    }

    // Reset ladder state
    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // Build new ladder
    const ladder = ladderCalculator.buildLadder(
      marketState.lastPrice,
      remainingBudget,
      {
        atr: marketState.atr1m,
        volBaseline: marketState.volBaseline,
        realizedVol: marketState.realizedVol,
        athDistance: marketState.athDistance || 0,
        ath: marketState.ath || 0,
        priceIncrement,
      }
    );

    if (ladder.levels.length === 0) {
      return { success: false, message: 'Ladder build produced 0 levels — price may be at or below floor' };
    }

    console.log(`📊 [${exchange}] Rebuilding ladder: ${ladderCalculator.getSummary(ladder)}`);

    // Place ladder orders
    const result = await orderExecutor.placeLadderOrders(ladder.levels);

    // Update position state
    positionState.ladderActive = true;
    positionState.ladderPlacedAt = Date.now();
    positionState.ladderLowerBound = ladder.lowerBound;
    positionState.pendingLadderOrders = result.orders;

    const msg = `Ladder rebuilt: ${result.orders.length} levels from ${fmtPrice(marketState.lastPrice)} to ${fmtPrice(ladder.lowerBound)}${result.failedCount > 0 ? ` (${result.failedCount} failed)` : ''}`;
    console.log(`📊 [${exchange}] ${msg}`);

    tradeEvents.emitTradeEvent('ladder_placed', exchange, `${result.orders.length} levels to ${fmtPrice(ladder.lowerBound)}`, {
      levels: result.orders.length,
      topPrice: marketState.lastPrice,
      bottomPrice: ladder.lowerBound,
      lowerBoundPct: ladder.lowerBoundPct,
      totalBudget: ladder.totalBudget,
      failedCount: result.failedCount,
      manual: true,
    });

    // Persist state
    saveLiveState();

    return { success: true, message: msg };
  };

  const cancelLadder = async () => {
    if (!isRunning) return { success: false, message: 'Engine not running' };

    const hadLadder = positionState.ladderActive;
    let cancelled = 0;

    if (hadLadder) {
      const result = await orderExecutor.cancelAllLadderOrders();
      cancelled = result.cancelled;
      console.log(`🧹 [${exchange}] Cancelled ${cancelled} ladder orders`);
    }

    positionState.ladderActive = false;
    positionState.ladderPlacedAt = null;
    positionState.ladderLowerBound = 0;
    positionState.pendingLadderOrders = [];

    // Switch config to reactive
    config.entryMode = 'reactive';
    updateRegimeConfig(exchange, pair, { entryMode: 'reactive' });

    saveLiveState();

    const msg = hadLadder
      ? `Cancelled ${cancelled} ladder orders, switched to reactive mode`
      : 'No active ladder — switched to reactive mode';
    console.log(`🔄 [${exchange}] ${msg}`);
    return { success: true, message: msg };
  };

  /**
   * Inject an externally-created celestial body into the running engine.
   * Syncs position aggregates, places TP, and saves state.
   * @param {Object} body - A body created via celestialHierarchy.createNewBody()
   * @returns {Promise<{success: boolean, bodyId: string, tpPlaced: boolean}>}
   */
  const injectBody = async (body) => {
    if (!isRunning) return { success: false, error: 'Engine not running' };
    positionState.celestialBodies = positionState.celestialBodies || [];
    positionState.celestialBodies.push(body);
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    const tpResult = await placeBodyTp(body);
    saveLiveState();
    console.log(`📦 [${exchange}] Injected body ${body.id} (${body.tier}): ${body.assetQty} BTC @ $${body.avgPrice.toFixed(2)}, TP placed: ${!!tpResult}`);
    return { success: true, bodyId: body.id, tpPlaced: !!tpResult };
  };

  return {
    start,
    stop,
    getState,
    getStatus,
    forceRegime,
    pause,
    resume,
    close,
    getLifecycle,
    updateConfig,
    updatePosition,
    getFills,
    getFillLedger: () => fillLedger,
    getFillStats,
    forceResumeDrawdown,
    manualMergeBody,
    setBodyTpPercent,
    setBodyTpPrice,
    rebuildTP,
    previewLadder,
    rebuildLadder,
    cancelLadder,
    injectBody,
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
