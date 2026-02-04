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
const { getRegimeConfig, updateRegimeConfig } = require('./config-utils');
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
  momentum: { magnitude: 0, direction: 'neutral' },
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
  // APY tracking fields
  engineStartTime: null,    // Timestamp when engine first started with capital
  initialCapital: 0,        // Initial capital (maxUsdcDeployed from config) - may be updated on restart
  originalCapital: 0,       // True original capital - never changes once set
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

  // Dry-run mode flag - use exchange-level config (same as DCA engine)
  // This ensures the UI toggle at exchanges.coinbase.dryRun controls both engines
  const isDryRun = exchangeConfig.dryRun === true;
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
      })
    : createOrderExecutor(exchange, config, adapter, productId, {
        onFillDetected: (orderId, status) => liveCallbacks.onFillDetected && liveCallbacks.onFillDetected(orderId, status),
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

  let isRunning = false;
  let wsFeed = null;
  let metricsInterval = null;
  let reconcileInterval = null;
  let stateSaveInterval = null;
  let entryInProgress = false; // Lock to prevent concurrent entry evaluations

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
    updateRegimeConfig(exchange, {
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

    // Optionally update ladder steps
    if (adjustment.maxLadderSteps !== undefined) {
      updates.maxLadderSteps = adjustment.maxLadderSteps;
      config.maxLadderSteps = adjustment.maxLadderSteps;
    }

    // Update in-memory config
    config.baseSizeUsdc = adjustment.baseSizeUsdc;
    config.maxUsdcDeployed = adjustment.maxUsdcDeployed;

    // Persist to config.json
    updateRegimeConfig(exchange, updates);

    tradeEvents.emitTradeEvent('size_adjusted', exchange, `Size adjusted: base=$${adjustment.baseSizeUsdc}`, {
      baseSizeUsdc: adjustment.baseSizeUsdc,
      maxUsdcDeployed: adjustment.maxUsdcDeployed,
      maxLadderSteps: adjustment.maxLadderSteps,
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

    dryRunState.saveState(exchange, {
      isDryRun: true,
      executor: orderExecutor.exportState(),
      position: { ...positionState },
      tpOptimizer: tpOptimizer.exportState(),
      sizeOptimizer: sizeOptimizer.exportState(),
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

    console.log(`📂 [${exchange}] [DRY-RUN] Restored state: ${positionState.cyclesCompleted} cycles, step ${positionState.ladderStep}, PnL=$${positionState.realizedPnL.toFixed(2)}, ${apyStatus}`);
    return true;
  };

  /**
   * Save live state to disk (for faster recovery on restarts)
   */
  const saveLiveState = () => {
    if (isDryRun) return;

    const regimeState = regimeDetector.getState();
    const tpOptimizerState = tpOptimizer.exportState();
    const sizeOptimizerState = sizeOptimizer.exportState();
    saveRegimeState(positionState, regimeState, exchange, tpOptimizerState, sizeOptimizerState);
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
          positionState.totalBTC = roundBTC(positionState.totalBTC + summary.totalSize);
          positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + summary.totalValue + summary.totalFees);
          positionState.avgCostBasis = positionState.totalBTC > 0
            ? positionState.totalCostBasis / positionState.totalBTC
            : 0;
          positionState.ladderStep += 1;
          positionState.lastEntryPrice = summary.avgPrice;
          positionState.lastEntryTime = Date.now();

          // Remove filled entry from persisted pending orders
          if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
            positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(
              e => e.orderId !== orderId
            );
          }

          orderExecutor.handleOrderFill(orderId);

          // Place/update TP order to reflect new position size
          await placeTakeProfitOrder();

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
   * Calculate APY and return metrics
   * Uses total liquid value (USDC + BTC at current price) for APY calculations
   * @returns {Object} APY metrics
   */
  const calculateApyMetrics = () => {
    const now = Date.now();
    const startTime = positionState.engineStartTime;
    // currentCapital = maxUsdcDeployed (grows with profits)
    const currentCapital = config.maxUsdcDeployed || 10000;
    // Total USDC return (realized P&L from trading)
    const totalUsdcReturn = positionState.realizedPnL || 0;
    // originalCapital = true starting amount (derive from current - realized if not set)
    // This ensures we get the true original even if the field was added after trading started
    const originalCapital = positionState.originalCapital > 0
      ? positionState.originalCapital
      : roundUSDC(currentCapital - totalUsdcReturn);
    const initialCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;
    // availableCapital = current cap - deployed in position
    const deployedCapital = positionState.totalCostBasis || 0;
    const availableCapital = currentCapital - deployedCapital;
    const currentPrice = marketState.lastPrice || 0;

    // Calculate BTC value in USD terms
    const totalBtcReturn = positionState.realizedBtcPnL || 0;
    const btcValueUsd = totalBtcReturn * currentPrice;

    // Total liquid value = USDC return + BTC holdings at current market price
    const totalLiquidValue = totalUsdcReturn + btcValueUsd;

    // If engine hasn't started tracking yet or no realized P&L, return zeros
    if (!startTime || (totalUsdcReturn === 0 && totalBtcReturn === 0)) {
      return {
        engineStartTime: startTime,
        originalCapital,
        initialCapital,
        currentCapital,
        deployedCapital,
        availableCapital,
        elapsedMs: startTime ? now - startTime : 0,
        elapsedDays: 0,
        // USDC returns
        totalUsdcReturn: 0,
        totalUsdcReturnPercent: 0,
        estimatedDailyUsdc: 0,
        // BTC returns
        totalBtcReturn: 0,
        btcValueUsd: 0,
        estimatedDailyBtc: 0,
        // Combined liquid value (used for APY)
        totalLiquidValue: 0,
        totalLiquidValuePercent: 0,
        // APY calculations based on liquid value
        dailyReturnPercent: 0,
        estimatedAnnualReturn: 0,
        estimatedApy: 0,
        // Cycle metrics
        cyclesPerDay: 0,
        avgPnlPerCycle: 0,
        // Legacy field for backwards compatibility
        totalReturn: 0,
        totalReturnPercent: 0,
      };
    }

    const elapsedMs = now - startTime;
    const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

    // Calculate return percentages
    const totalUsdcReturnPercent = (totalUsdcReturn / initialCapital) * 100;
    const totalLiquidValuePercent = (totalLiquidValue / initialCapital) * 100;

    // Minimum 1 hour of data required for meaningful projections
    const minHoursForProjection = 1;
    const hasEnoughData = elapsedMs >= minHoursForProjection * 60 * 60 * 1000;

    // Daily return rate based on total liquid value - only calculate with enough data
    const dailyReturnPercent = hasEnoughData && elapsedDays > 0
      ? totalLiquidValuePercent / elapsedDays
      : 0;

    // Estimated annual return (simple linear projection) based on liquid value
    const estimatedAnnualReturn = hasEnoughData ? dailyReturnPercent * 365 : 0;

    // Compound APY calculation: (1 + dailyReturn)^365 - 1
    // Cap daily return to prevent overflow (max 10% daily to keep APY reasonable)
    const dailyReturnDecimal = Math.min(dailyReturnPercent / 100, 0.1);
    let estimatedApy = 0;
    if (hasEnoughData && elapsedDays > 0) {
      const rawApy = (Math.pow(1 + dailyReturnDecimal, 365) - 1) * 100;
      // Cap APY at 99999% to avoid scientific notation in UI
      estimatedApy = Math.min(rawApy, 99999);
    }

    // Cycles per day - only calculate with enough data
    const cyclesPerDay = hasEnoughData && elapsedDays > 0
      ? positionState.cyclesCompleted / elapsedDays
      : 0;

    // Average P&L per cycle (USDC only, since that's the direct trading profit)
    const avgPnlPerCycle = positionState.cyclesCompleted > 0
      ? totalUsdcReturn / positionState.cyclesCompleted
      : 0;

    // Estimated daily returns
    const estimatedDailyUsdc = hasEnoughData && elapsedDays > 0
      ? totalUsdcReturn / elapsedDays
      : 0;

    const estimatedDailyBtc = hasEnoughData && elapsedDays > 0
      ? totalBtcReturn / elapsedDays
      : 0;

    // Estimated daily liquid value (USDC + BTC value combined)
    const estimatedDailyLiquid = hasEnoughData && elapsedDays > 0
      ? totalLiquidValue / elapsedDays
      : 0;

    return {
      engineStartTime: startTime,
      originalCapital,
      initialCapital,
      currentCapital,
      deployedCapital: roundUSDC(deployedCapital),
      availableCapital: roundUSDC(availableCapital),
      elapsedMs,
      elapsedDays: roundUSDC(elapsedDays * 100) / 100, // 2 decimal places
      // USDC returns
      totalUsdcReturn: roundUSDC(totalUsdcReturn),
      totalUsdcReturnPercent: roundUSDC(totalUsdcReturnPercent * 100) / 100,
      estimatedDailyUsdc: roundUSDC(estimatedDailyUsdc),
      // BTC returns
      totalBtcReturn: roundBTC(totalBtcReturn),
      btcValueUsd: roundUSDC(btcValueUsd),
      estimatedDailyBtc: roundBTC(estimatedDailyBtc),
      // Combined liquid value (used for APY calculations)
      totalLiquidValue: roundUSDC(totalLiquidValue),
      totalLiquidValuePercent: roundUSDC(totalLiquidValuePercent * 100) / 100,
      estimatedDailyLiquid: roundUSDC(estimatedDailyLiquid),
      // APY calculations based on total liquid value
      dailyReturnPercent: roundUSDC(dailyReturnPercent * 100) / 100,
      estimatedAnnualReturn: roundUSDC(estimatedAnnualReturn * 100) / 100,
      estimatedApy: roundUSDC(estimatedApy * 100) / 100,
      // Cycle metrics
      cyclesPerDay: roundUSDC(cyclesPerDay * 100) / 100,
      avgPnlPerCycle: roundUSDC(avgPnlPerCycle),
      // Legacy fields for backwards compatibility
      totalReturn: roundUSDC(totalLiquidValue),
      totalReturnPercent: roundUSDC(totalLiquidValuePercent * 100) / 100,
    };
  };

  /**
   * Initialize APY tracking if not already set
   * If there are existing filled orders but start time is after first order, backfill
   */
  const initializeApyTracking = () => {
    // Check for existing filled orders to potentially backfill start time
    const filledOrders = orderExecutor.getFilledOrders ? orderExecutor.getFilledOrders() : [];
    let earliestOrderTime = Infinity;

    if (filledOrders.length > 0) {
      earliestOrderTime = filledOrders.reduce((earliest, order) => {
        const orderTime = order.placedAt || order.filledAt;
        return orderTime < earliest ? orderTime : earliest;
      }, Infinity);
    }

    // If we have filled orders and the saved start time is after the first order, backfill
    if (earliestOrderTime !== Infinity) {
      if (!positionState.engineStartTime || positionState.engineStartTime > earliestOrderTime) {
        positionState.engineStartTime = earliestOrderTime;
        positionState.initialCapital = config.maxUsdcDeployed || 10000;
        // Only set originalCapital if not already set (preserve true starting value)
        if (!positionState.originalCapital) {
          positionState.originalCapital = positionState.initialCapital;
        }
        console.log(`📊 [${exchange}] APY tracking backfilled to first order: ${new Date(earliestOrderTime).toISOString()}, original=$${positionState.originalCapital} current=$${config.maxUsdcDeployed}`);
        return;
      }
      // Preserved existing start time that's earlier than first order
      // Ensure originalCapital is set
      if (!positionState.originalCapital) {
        positionState.originalCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;
      }
      console.log(`📊 [${exchange}] APY tracking restored: started ${new Date(positionState.engineStartTime).toISOString()}, original=$${positionState.originalCapital} current=$${config.maxUsdcDeployed}`);
      return;
    }

    // No filled orders - preserve existing or start fresh
    if (positionState.engineStartTime) {
      // Ensure originalCapital is set
      if (!positionState.originalCapital) {
        positionState.originalCapital = positionState.initialCapital || config.maxUsdcDeployed || 10000;
      }
      console.log(`📊 [${exchange}] APY tracking restored: started ${new Date(positionState.engineStartTime).toISOString()}, original=$${positionState.originalCapital} current=$${config.maxUsdcDeployed}`);
      return;
    }

    // No existing state or orders, start fresh
    positionState.engineStartTime = Date.now();
    positionState.initialCapital = config.maxUsdcDeployed || 10000;
    positionState.originalCapital = positionState.initialCapital; // First time, set original
    console.log(`📊 [${exchange}] APY tracking started fresh: original=$${positionState.originalCapital}`);
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

      // Merge recovered position with any saved state
      // IMPORTANT: If saved state shows totalBTC=0 with cyclesCompleted>0, this means
      // a cycle was properly completed and reset. The recovery from fills will show
      // the "holdback" BTC as position (sum of buys minus sells), but this is NOT
      // an active position - it's accumulated BTC reserves from completed cycles.
      // Trust the saved state in this case.
      const savedTpOrderId = positionState.activeTpOrderId;
      const savedTpPrice = positionState.lastTpPrice;
      const savedTotalBTC = positionState.totalBTC;
      const savedCyclesCompleted = positionState.cyclesCompleted;
      const cycleWasCompleted = hasSavedState && savedTotalBTC === 0 && savedCyclesCompleted > 0;

      if (cycleWasCompleted) {
        console.log(`ℹ️ [${exchange}] Saved state shows completed cycle (${savedCyclesCompleted} cycles, 0 BTC position) - trusting saved state over recovery`);
      }

      positionState = {
        ...createInitialPositionState(),
        ...positionState, // Keep saved fields like realizedPnL, cyclesCompleted
        ...position,      // Override with exchange-recovered values
        // BUT: if cycle was completed, preserve the zero position from saved state
        totalBTC: cycleWasCompleted ? 0 : position.totalBTC,
        totalCostBasis: cycleWasCompleted ? 0 : position.totalCostBasis,
        avgCostBasis: cycleWasCompleted ? 0 : position.avgCostBasis,
        ladderStep: cycleWasCompleted ? 0 : position.ladderStep,
        activeTpOrderId: savedTpOrderId, // Restore TP tracking (not in fills)
        lastTpPrice: savedTpPrice,
      };

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
      if (currentPrice > 0 && positionState.totalBTC > 0) {
        reEvaluateAfterDowntime(currentPrice);
      }

      // If we have position but no TP order, place one
      if (positionState.totalBTC > 0 && !positionState.activeTpOrderId) {
        console.log(`📝 [${exchange}] Position exists but no TP order, will place after metrics update`);
      }

      // Restore TP order tracking if we have an active TP order ID - but validate it exists first
      if (positionState.activeTpOrderId) {
        const tpOrderStatus = await adapter.getOrder(positionState.activeTpOrderId).catch(() => null);
        const tpOrderExists = tpOrderStatus && tpOrderStatus.status !== 'CANCELLED' && tpOrderStatus.status !== 'FAILED';

        if (tpOrderExists && orderExecutor.restorePendingOrder) {
          orderExecutor.restorePendingOrder(positionState.activeTpOrderId, {
            type: 'take_profit',
            price: positionState.lastTpPrice,
            size: positionState.btcOnOrder || positionState.totalBTC,
            sizeUsdc: (positionState.lastTpPrice || 0) * (positionState.btcOnOrder || positionState.totalBTC),
            placedAt: positionState.lastEntryTime || Date.now(),
            status: 'open',
          });
          console.log(`📋 [${exchange}] Restored TP order tracking: ${positionState.activeTpOrderId} @ $${positionState.lastTpPrice}`);
        } else {
          // TP order no longer exists on exchange - clear tracking so a new one gets placed
          console.log(`⚠️ [${exchange}] Saved TP order ${positionState.activeTpOrderId} not found on exchange, clearing`);
          positionState.activeTpOrderId = null;
          positionState.lastTpPrice = 0;
          positionState.btcOnOrder = 0;
        }
      }

      // Recalculate cycles from fill ledger to ensure accurate P&L tracking
      // This catches any discrepancies between saved state and actual fills
      const recalcResult = fillLedger.recalculateCycles();
      if (recalcResult.cyclesCompleted > 0 || recalcResult.orphansFixed > 0) {
        console.log(`🔧 [${exchange}] Auto-recalculated from fills: ${recalcResult.cyclesCompleted} cycles, PnL=$${recalcResult.realizedPnL.toFixed(2)}, BTC reserves=${recalcResult.realizedBtcPnL.toFixed(6)}`);
        positionState.cyclesCompleted = recalcResult.cyclesCompleted;
        positionState.realizedPnL = recalcResult.realizedPnL;
        positionState.realizedBtcPnL = recalcResult.realizedBtcPnL;
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

      const openOrders = await adapter.getOpenOrders(productId);
      const openEntries = openOrders.filter(o => o.side.toUpperCase() === 'BUY');

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
              size: savedEntry.btcQty,
              sizeUsdc: savedEntry.sizeUsdc,
              placedAt: savedEntry.placedAt,
            });
            restoredEntries++;
            console.log(`🔄 [${exchange}] Restored pending entry: ${order.orderId} @ $${savedEntry.price}`);
          }

          // Check if order has any fills while offline (partial fills)
          if (order.filledSize && order.filledSize > 0) {
            console.log(`✅ [${exchange}] Entry ${order.orderId} has partial fills (${order.filledSize})`);
            const rawFills = await adapter.getOrderFills(order.orderId);
            for (const fill of rawFills) {
              const result = fillLedger.ingestFill(fill);
              if (result.ingested) {
                positionState.totalBTC = roundBTC(positionState.totalBTC + fill.size);
                positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + (fill.size * fill.price) + fill.netFee);
                positionState.avgCostBasis = positionState.totalBTC > 0
                  ? positionState.totalCostBasis / positionState.totalBTC
                  : 0;
                positionState.ladderStep += 1;
                positionState.lastEntryPrice = fill.price;
                positionState.lastEntryTime = fill.timestamp;
                console.log(`📝 [${exchange}] Ingested partial fill: ${fill.size} BTC @ $${fill.price}`);
              }
            }
          }
        } else {
          // True orphan - not in our saved state, must be from another engine
          orphanedEntries++;
          console.log(`⚠️ [${exchange}] Found orphan entry order ${order.orderId} (not from regime engine), ignoring`);
        }
      }

      if (restoredEntries > 0) {
        console.log(`✅ [${exchange}] Restored ${restoredEntries} pending entry orders from state`);
      }
      if (orphanedEntries > 0) {
        console.log(`ℹ️ [${exchange}] Ignored ${orphanedEntries} entry orders not belonging to regime engine`);
      }

      // Update TP if we have position
      if (positionState.totalBTC > 0 && !positionState.activeTpOrderId) {
        await placeTakeProfitOrder();
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

    // Mark as not running FIRST to prevent callbacks from taking action
    isRunning = false;

    // Save state before stopping
    if (isDryRun) {
      dryRunState.forceSave(exchange, {
        isDryRun: true,
        executor: orderExecutor.exportState ? orderExecutor.exportState() : {},
        position: { ...positionState },
        tpOptimizer: tpOptimizer.exportState(),
      });
    } else {
      // Save live state on shutdown
      saveLiveState();
      // Also persist fill ledger
      fillLedger.persist();
      console.log(`💾 [${exchange}] Saved live state and fill ledger`);
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

    tailEvents.cleanup();

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
    const rawFills = await adapter.getOrderFills(fillData.orderId);

    // Get order placement time for fill time tracking (entry orders only)
    const orderPlacedAt = fillData.side.toLowerCase() === 'buy'
      ? orderExecutor.getOrderPlacedAt(fillData.orderId)
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
    const fillsToAggregate = ingestedFills.length > 0
      ? ingestedFills
      : fillLedger.getFillsForOrder(fillData.orderId);

    // Determine if buy or sell
    if (fillData.side.toLowerCase() === 'buy') {
      // Update position
      const summary = fillLedger.aggregateFills(fillsToAggregate);
      positionState.totalBTC = roundBTC(positionState.totalBTC + summary.totalSize);
      positionState.totalCostBasis = roundUSDC(positionState.totalCostBasis + summary.totalValue + summary.totalFees);
      positionState.avgCostBasis = positionState.totalBTC > 0
        ? positionState.totalCostBasis / positionState.totalBTC
        : 0;
      positionState.ladderStep += 1;
      positionState.lastEntryPrice = summary.avgPrice;
      positionState.lastEntryTime = Date.now();

      // Remove filled entry from persisted pending orders
      if (positionState.pendingEntryOrders && positionState.pendingEntryOrders.length > 0) {
        positionState.pendingEntryOrders = positionState.pendingEntryOrders.filter(
          e => e.orderId !== fillData.orderId
        );
      }

      // Place/update TP order
      await placeTakeProfitOrder();

      console.log(`✅ [${exchange}] Buy filled: ${summary.totalSize} BTC @ $${summary.avgPrice}, avg_cost=$${positionState.avgCostBasis.toFixed(2)}`);

      tradeEvents.emitTradeEvent('buy_filled', exchange, `${summary.totalSize} BTC @ $${summary.avgPrice}`, {
        btcAmount: summary.totalSize,
        price: summary.avgPrice,
        avgCostBasis: positionState.avgCostBasis,
      });

      // Persist state immediately after buy fill to prevent loss on crash
      saveLiveState();
      fillLedger.persist();

    } else if (fillData.side.toLowerCase() === 'sell') {
      // Cycle complete
      const summary = fillLedger.aggregateFills(fillsToAggregate);
      const proceeds = summary.totalValue - summary.totalFees;
      const soldCostBasis = summary.totalSize * positionState.avgCostBasis;
      const pnl = proceeds - soldCostBasis;

      // Calculate BTC holdback (the BTC we kept as reserves from this cycle)
      const holdbackBtc = roundBTC(positionState.totalBTC - summary.totalSize);

      // Calculate actual TP percentage for optimizer
      const actualTpPct = positionState.avgCostBasis > 0
        ? ((summary.avgPrice - positionState.avgCostBasis) / positionState.avgCostBasis) * 100
        : 0;

      positionState.realizedPnL += pnl;
      positionState.realizedBtcPnL += holdbackBtc;
      positionState.btcOnOrder = 0;
      positionState.cyclesCompleted += 1;

      // Grow capital by adding USDC profit to maxUsdcDeployed
      const prevMaxUsdc = config.maxUsdcDeployed;
      config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
      updateRegimeConfig(exchange, { maxUsdcDeployed: config.maxUsdcDeployed });

      console.log(`✅ [${exchange}] TP filled: ${summary.totalSize} BTC @ $${summary.avgPrice}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackBtc.toFixed(6)} BTC, capital: $${prevMaxUsdc}→$${config.maxUsdcDeployed}`);

      tradeEvents.emitTradeEvent('tp_filled', exchange, `${summary.totalSize} BTC @ $${summary.avgPrice}, PnL=$${pnl.toFixed(2)}`, {
        btcAmount: summary.totalSize,
        price: summary.avgPrice,
        pnl,
        holdbackBtc,
        totalRealizedBtc: positionState.realizedBtcPnL,
        capitalGrowth: pnl,
        newMaxUsdcDeployed: config.maxUsdcDeployed,
      });

      // Record cycle for TP optimizer (live mode doesn't track max price, use actual TP as optimal)
      recordCycleForOptimizer({
        optimalTpPct: actualTpPct, // In live mode, we don't track optimal; use actual
        actualTpPct,
      });

      // Record cycle for Size optimizer
      // Get current balance for size optimization (proceeds go back to available balance)
      const postCycleBalance = config.maxUsdcDeployed; // After capital growth adjustment
      recordCycleForSizeOptimizer({
        stepsUsed: positionState.ladderStep,
        capitalDeployed: soldCostBasis, // Cost basis of what we sold
      }, postCycleBalance);

      // Reset for next cycle FIRST, then persist
      resetCycle();

      // Persist state AFTER reset to ensure cycle reset is saved
      saveLiveState();
      fillLedger.persist();
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
    if (!isDryRun && positionState.totalBTC > 0 && !positionState.activeTpOrderId) {
      console.log(`📝 [${exchange}] Position without TP order detected, placing TP order now`);
      await placeTakeProfitOrder();
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
            if (err.message?.includes('not found') || err.response?.status === 404) {
              console.log(`⚠️ [${exchange}] TP order ${positionState.activeTpOrderId} not found on exchange, clearing`);
              positionState.activeTpOrderId = null;
              orderExecutor.handleOrderCancel(positionState.activeTpOrderId);
            } else {
              console.log(`❌ [${exchange}] TP order check failed: ${err.message}`);
            }
          });
      }

      recoveryModule.reconcile(positionState, fillLedger)
        .then(result => {
          if (result.updated) {
            positionState = result.position;
            console.log(`🔄 [${exchange}] Position reconciled from exchange`);
          }
        })
        .catch(err => {
          console.log(`❌ [${exchange}] Reconciliation failed: ${err.message}`);
        });
    }, config.reconcileIntervalMs);
  };

  /**
   * Evaluate volatility-based entry trigger
   */
  const evaluateEntryTrigger = async () => {
    // Prevent concurrent entry evaluations (race condition from rapid ticker updates)
    if (entryInProgress) return;

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
      entryInProgress = true;
      await executeEntry(volTrigger ? 'volatility' : 'timer').finally(() => {
        entryInProgress = false;
      });
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

    // Place entry with dynamic offset
    const result = await orderExecutor.placeEntryBid(sizing.sizeUsdc, marketState.bid, marketState.ask, 0, effectiveOffsetBps);

    if (result.success) {
      positionState.lastEntryTime = Date.now();
      positionState.anchorPrice = marketState.lastPrice;

      // Persist entry order to state for recovery across restarts
      if (!isDryRun) {
        if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
        positionState.pendingEntryOrders.push({
          orderId: result.orderId,
          price: result.price,
          btcQty: result.btcQty,
          sizeUsdc: sizing.sizeUsdc,
          placedAt: Date.now(),
        });
        saveLiveState();
      }

      console.log(`📝 [${exchange}] Entry placed: regime=${regime} step=${positionState.ladderStep} size=$${sizing.sizeUsdc} price=$${result.price} trigger=${triggerType} momentum=${momentumDirection} offset=${effectiveOffsetBps}bps`);

      tradeEvents.emitTradeEvent('entry_placed', exchange, `$${sizing.sizeUsdc} @ $${result.price}`, {
        regime,
        step: positionState.ladderStep,
        sizeUsdc: sizing.sizeUsdc,
        price: result.price,
        trigger: triggerType,
        momentum: momentumDirection,
        offsetBps: effectiveOffsetBps,
      });
    }
  };

  /**
   * Place or update take-profit order
   */
  const placeTakeProfitOrder = async () => {
    // Calculate TP price first (needed for profit-based holdback calculation)
    const tpPrice = calculateDynamicTP();

    // Calculate sizing based on profit at TP price
    const { sellQty, holdbackQty, profitBtcValue } = positionSizer.calculateTakeProfitSize(
      positionState.totalBTC,
      positionState.avgCostBasis,
      tpPrice
    );

    if (sellQty <= 0) return;

    const result = await orderExecutor.placeTakeProfitOrder(sellQty, tpPrice);

    if (result.success) {
      positionState.activeTpOrderId = result.orderId;
      positionState.lastTpPrice = tpPrice;
      positionState.btcOnOrder = sellQty;

      if (result.updated) {
        console.log(`📝 [${exchange}] TP ${result.orderId ? 'updated' : 'placed'}: ${sellQty} BTC @ $${tpPrice} (holdback=${holdbackQty.toFixed(6)} BTC ≈$${profitBtcValue.toFixed(2)})`);
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

      // Calculate actual TP percentage for optimizer
      const actualTpPct = positionState.avgCostBasis > 0
        ? ((price - positionState.avgCostBasis) / positionState.avgCostBasis) * 100
        : 0;

      // Get optimal TP analytics from dry-run executor
      const optimalAnalytics = orderExecutor.getOptimalTpAnalytics
        ? orderExecutor.getOptimalTpAnalytics()
        : null;
      const lastCycle = optimalAnalytics?.cycles?.[optimalAnalytics.cycles.length - 1];
      const optimalTpPct = lastCycle?.optimalTpPct || actualTpPct;

      positionState.realizedPnL += pnl;
      positionState.realizedBtcPnL += holdbackBtc;
      positionState.btcOnOrder = 0;
      positionState.cyclesCompleted += 1;

      // Grow capital by adding USDC profit to maxUsdcDeployed
      const prevMaxUsdc = config.maxUsdcDeployed;
      config.maxUsdcDeployed = roundUSDC(config.maxUsdcDeployed + pnl);
      updateRegimeConfig(exchange, { maxUsdcDeployed: config.maxUsdcDeployed });

      console.log(`💰 [${exchange}] [DRY-RUN] Capital growth: $${prevMaxUsdc.toFixed(2)} → $${config.maxUsdcDeployed.toFixed(2)} (+$${pnl.toFixed(2)})`);

      tradeEvents.emitTradeEvent('tp_filled', exchange, `[DRY-RUN] ${btcQty} BTC @ $${price}, PnL=$${pnl.toFixed(2)}, holdback=${holdbackBtc.toFixed(6)} BTC`, {
        btcAmount: btcQty,
        price,
        pnl,
        holdbackBtc,
        totalRealizedBtc: positionState.realizedBtcPnL,
        capitalGrowth: pnl,
        newMaxUsdcDeployed: config.maxUsdcDeployed,
        isDryRun: true,
      });

      // Record cycle for TP optimizer (use optimal from dry-run tracking)
      recordCycleForOptimizer({
        optimalTpPct,
        actualTpPct,
      });

      // Record cycle for Size optimizer
      const postCycleBalance = config.maxUsdcDeployed;
      recordCycleForSizeOptimizer({
        stepsUsed: positionState.ladderStep,
        capitalDeployed: positionState.totalCostBasis,
      }, postCycleBalance);

      // Reset for next cycle
      resetCycle();

      // Save state after TP fill
      saveDryRunState();
    };
  }

  // Set up live mode fill detection callback (backup for when WebSocket misses fills)
  if (!isDryRun) {
    liveCallbacks.onFillDetected = async (orderId, status) => {
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
    health: healthMonitor.getState(),
    pause: tailEvents.getPauseState(),
    risk: riskManager.getState(),
    orders: orderExecutor.getPendingCounts(),
    pendingOrders: !isDryRun && orderExecutor.getPendingOrdersList ? orderExecutor.getPendingOrdersList() : [],
    apy: calculateApyMetrics(),
    dryRun: isDryRun && orderExecutor.getDryRunState ? orderExecutor.getDryRunState() : null,
    tpOptimizer: tpOptimizer.getStatus(),
    sizeOptimizer: sizeOptimizer.getStatus(),
    fillTimeStats: fillLedger.getFillTimeStats ? fillLedger.getFillTimeStats(7) : null,
    effectiveStaleMs: !isDryRun && orderExecutor.getEffectiveStaleMs ? orderExecutor.getEffectiveStaleMs() : config.orderStaleMs,
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
    console.log(`🔄 [${exchange}] Position updated externally: step=${positionState.ladderStep}, cycles=${positionState.cyclesCompleted}, BTC reserves=${positionState.realizedBtcPnL}`);
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
    updatePosition,
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
