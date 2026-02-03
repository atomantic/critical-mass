// @ts-check
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('./adapters');
const stateTracker = require('./state-tracker');
const orderManager = require('./order-manager');
const logger = require('./logger');
const { consolidatePendingOrders } = require('./order-manager');
const { getExchangeConfig, getEnabledExchanges } = require('./config-utils');
const { normalizeConfig, formatInterval, shouldRunConsolidation, getConsolidationRunId } = require('./interval-utils');
const { tradeEvents } = require('./trade-events');
const { getFibonacciBuyAmount } = require('./fibonacci-utils');

/**
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').BotState} BotState
 * @typedef {import('./types').CycleResult} CycleResult
 * @typedef {import('./types').StatusResult} StatusResult
 * @typedef {import('./types').FilledSellOrder} FilledSellOrder
 * @typedef {import('./types').ConsolidationResult} ConsolidationResult
 * @typedef {import('./types').TrackedOrder} TrackedOrder
 */

/**
 * Load configuration for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {ExchangeConfig} Configuration
 */
const loadConfig = (exchange = 'coinbase') => getExchangeConfig(exchange);

/**
 * Extract quote currency from product ID
 * @param {string} productId - Product ID (e.g., 'BTC-USDC', 'BTCUSD', 'CRO_USD')
 * @returns {string} Quote currency (e.g., 'USDC', 'USD')
 */
const getQuoteCurrency = (productId) => {
  if (!productId) return 'USD';
  // Handle different formats:
  // Coinbase: BTC-USDC -> USDC
  // Gemini: BTCUSD -> USD
  // Crypto.com: CRO_USD -> USD
  if (productId.includes('-')) {
    return productId.split('-')[1];
  }
  if (productId.includes('_')) {
    return productId.split('_')[1];
  }
  // Gemini format: BTCUSD - extract last 3 chars (USD) or 4 (USDC, USDT)
  const upper = productId.toUpperCase();
  if (upper.endsWith('USDC')) return 'USDC';
  if (upper.endsWith('USDT')) return 'USDT';
  if (upper.endsWith('USD')) return 'USD';
  return 'USD'; // Default fallback
};

/**
 * Extract base currency from product ID
 * @param {string} productId - Product ID (e.g., 'BTC-USDC', 'BTCUSD', 'CRO_USD')
 * @returns {string} Base currency (e.g., 'BTC', 'CRO')
 */
const getBaseCurrency = (productId) => {
  if (!productId) return 'BTC';
  // Handle different formats:
  // Coinbase: BTC-USDC -> BTC
  // Crypto.com: CRO_USD -> CRO
  if (productId.includes('-')) {
    return productId.split('-')[0];
  }
  if (productId.includes('_')) {
    return productId.split('_')[0];
  }
  // Gemini format: BTCUSD - extract base by removing known quote suffixes
  const upper = productId.toUpperCase();
  if (upper.endsWith('USDC')) return upper.slice(0, -4);
  if (upper.endsWith('USDT')) return upper.slice(0, -4);
  if (upper.endsWith('USD')) return upper.slice(0, -3);
  return upper; // Return as-is if no pattern matches
};

/**
 * Sync order statuses and update state for filled orders
 * @param {BotState} state - Current state
 * @param {string} [exchange] - Exchange name
 * @returns {Promise<FilledSellOrder[]>} List of newly filled orders
 */
const syncOrderStatuses = async (state, exchange = 'coinbase') => {
  const pendingOrders = stateTracker.getPendingOrders(state);

  if (pendingOrders.length === 0) {
    return [];
  }

  logger.log('INFO', `[${exchange}] Checking ${pendingOrders.length} pending orders...`);
  tradeEvents.checkingOrders(exchange, pendingOrders.length);

  const adapter = getAdapter(exchange);
  const filledOrders = await orderManager.checkFilledOrders(pendingOrders, adapter);

  for (const filled of filledOrders) {
    stateTracker.updateAfterSellFill(state, filled);
    logger.logSellFilled(filled, state, exchange);
    logger.log('INFO', `[${exchange}] Sell order filled: +${filled.fillValue.toFixed(2)}`);
    tradeEvents.orderFilled(exchange, filled.orderId, filled.fillValue);
  }

  return filledOrders;
};

/**
 * Execute order consolidation for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @param {string[]} [orderIds] - Specific order IDs to consolidate (optional, defaults to all pending)
 * @returns {Promise<ConsolidationResult>} Result of the consolidation
 */
const executeConsolidation = async (exchange = 'coinbase', orderIds = null) => {
  const config = loadConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  const adapter = getAdapter(exchange);

  // Get pending orders to consolidate
  let pendingOrders = stateTracker.getPendingOrders(state);

  // Filter to specific order IDs if provided
  if (orderIds && orderIds.length > 0) {
    pendingOrders = pendingOrders.filter(o => orderIds.includes(o.orderId));
  }

  if (pendingOrders.length < 2) {
    return {
      success: false,
      error: `Need at least 2 pending orders, found ${pendingOrders.length}`,
    };
  }

  logger.log('INFO', `[${exchange}] Starting consolidation of ${pendingOrders.length} orders`);

  const result = await consolidatePendingOrders(config, pendingOrders, adapter);

  if (result.success) {
    // Get the orders that were actually consolidated (not skipped)
    const consolidatedOrders = pendingOrders.filter(o =>
      result.cancelledOrderIds.includes(o.orderId)
    );

    // Update state
    stateTracker.updateAfterConsolidation(
      state,
      consolidatedOrders,
      result.newOrderId,
      result.consolidatedPrice,
      result.consolidatedBTC
    );

    // Track consolidation run for interval-based scheduling
    if (config.consolidateInterval && config.consolidateInterval !== 'never') {
      state.lastConsolidationId = getConsolidationRunId(config.consolidateInterval);
      state.lastConsolidationTimestamp = Date.now();
    }

    // Save state
    stateTracker.saveState(state, exchange);

    // Log the transaction
    logger.logConsolidation(result, state, exchange);

    // Emit event
    tradeEvents.ordersConsolidated(
      exchange,
      result.consolidatedCount,
      result.newOrderId,
      result.consolidatedPrice,
      result.consolidatedBTC
    );

    logger.log('INFO', `[${exchange}] Consolidation complete: ${result.consolidatedCount} orders -> 1 @ $${result.consolidatedPrice.toFixed(2)}`);
  } else {
    logger.log('ERROR', `[${exchange}] Consolidation failed: ${result.error}`);
    tradeEvents.error(exchange, `Consolidation failed: ${result.error}`);
  }

  return result;
};

/**
 * Run the interval DCA cycle for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {Promise<CycleResult>} Result of the cycle
 */
const runIntervalCycle = async (exchange = 'coinbase') => {
  const config = loadConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  const intervalLabel = formatInterval(config.intervalType);
  const adapter = getAdapter(exchange);
  const isFibonacci = config.dcaStrategy === 'fibonacci';

  // Initialize Fibonacci state if needed
  if (isFibonacci) {
    stateTracker.initFibonacciState(state, config);
  }

  // Emit starting event
  tradeEvents.starting(exchange, intervalLabel);

  // Check if enabled
  if (!config.enabled) {
    logger.log('INFO', `[${exchange}] DCA bot is disabled in config`);
    tradeEvents.disabled(exchange);
    return { status: 'disabled', exchange };
  }

  // Check if already ran this interval
  if (stateTracker.checkIfRanThisInterval(state, config.intervalType)) {
    logger.log('INFO', `[${exchange}] Already ran this ${intervalLabel} interval (${state.lastRunId})`);
    tradeEvents.skipped(exchange, `Already ran this ${intervalLabel} interval`);
    return { status: 'already_ran', lastRunId: state.lastRunId, intervalType: config.intervalType, exchange };
  }

  // Check Fibonacci sell fill FIRST (before buying more)
  if (isFibonacci && state.fibActiveSellOrderId) {
    const fibFill = await orderManager.checkFibonacciSellFill(state.fibActiveSellOrderId, adapter);
    if (fibFill) {
      const cyclePosition = state.fibPosition || 0;
      stateTracker.updateAfterFibSellFill(state, fibFill);
      logger.logFibSellFilled(fibFill, state, cyclePosition, exchange);
      stateTracker.saveState(state, exchange);
      logger.log('INFO', `[${exchange}] Fibonacci cycle complete - resetting to position 0`);
      tradeEvents.cycleComplete(exchange, 'fib_cycle_complete', { profit: fibFill.netProceeds, buysInCycle: cyclePosition });
    }
  }

  // Sync order statuses (check for filled sells) - for fixed strategy
  let filledOrders = [];
  if (!isFibonacci) {
    filledOrders = await syncOrderStatuses(state, exchange);

    if (filledOrders.length > 0) {
      logger.log('INFO', `[${exchange}] ${filledOrders.length} orders filled since last run`);
      stateTracker.saveState(state, exchange);
    }
  }

  // Check current price against max threshold
  const currentPrice = await adapter.getCurrentPrice(config.productId);
  logger.log('INFO', `[${exchange}] Current ${config.productId} price: ${currentPrice.toFixed(2)}`);
  tradeEvents.priceCheck(exchange, config.productId, currentPrice);

  if (currentPrice > config.maxBuyPrice) {
    logger.log('WARN', `[${exchange}] Price ${currentPrice} exceeds max buy price ${config.maxBuyPrice}`);
    tradeEvents.skipped(exchange, `Price $${currentPrice.toFixed(2)} exceeds max $${config.maxBuyPrice}`);
    return {
      status: 'price_too_high',
      currentPrice,
      maxBuyPrice: config.maxBuyPrice,
      exchange,
    };
  }

  // Check balance first
  const quoteCurrency = getQuoteCurrency(config.productId);
  const balance = await adapter.getAccountBalance(quoteCurrency);
  logger.log('INFO', `[${exchange}] ${quoteCurrency} balance: ${balance.available.toFixed(2)} available, ${balance.hold.toFixed(2)} on hold`);
  tradeEvents.balanceCheck(exchange, quoteCurrency, balance.available);

  // Calculate buy amount based on strategy
  let actualBuyAmount;

  if (isFibonacci) {
    // Fibonacci strategy: use Fibonacci sequence for buy amounts
    const fibPosition = state.fibPosition || 0;
    const fibAmount = getFibonacciBuyAmount(fibPosition, config.fibBaseAmount);

    logger.log('INFO', `[${exchange}] Fibonacci position ${fibPosition}: target buy amount $${fibAmount.toFixed(2)}`);

    // Wait if insufficient funds for next Fibonacci amount
    if (balance.available < fibAmount) {
      logger.log('INFO', `[${exchange}] Waiting for funds: need $${fibAmount.toFixed(2)}, have $${balance.available.toFixed(2)}`);
      tradeEvents.skipped(exchange, `Waiting for funds: need $${fibAmount.toFixed(2)}`);
      return {
        status: 'waiting_funds',
        required: fibAmount,
        available: balance.available,
        fibPosition,
        exchange,
      };
    }

    actualBuyAmount = fibAmount;
  } else {
    // Fixed strategy: use allocation-based amounts
    const { remaining, intervalAmount } = stateTracker.checkAllocationRemaining(state, config);

    if (remaining <= 0) {
      logger.log('INFO', `[${exchange}] Full allocation has been used`);
      return { status: 'fully_allocated', totalAllocated: state.totalAllocated, exchange };
    }

    if (intervalAmount < config.minOrderSize) {
      logger.log('INFO', `[${exchange}] Interval amount ${intervalAmount} below minimum ${config.minOrderSize}`);
      return { status: 'below_minimum', intervalAmount, minOrderSize: config.minOrderSize, exchange };
    }

    // Use the minimum of: interval amount, remaining allocation, or available balance
    actualBuyAmount = Math.min(intervalAmount, remaining, balance.available);

    // If balance is below interval amount, use what's available
    if (balance.available < intervalAmount) {
      logger.log('WARN', `[${exchange}] Balance ${balance.available.toFixed(2)} below interval amount ${intervalAmount.toFixed(2)}, using what's available`);
    }
  }

  // Check if we have enough to meet minimum order size
  if (actualBuyAmount < config.minOrderSize) {
    logger.log('ERROR', `[${exchange}] Available amount ${actualBuyAmount.toFixed(2)} below minimum ${config.minOrderSize}`);
    tradeEvents.error(exchange, `Insufficient balance: $${actualBuyAmount.toFixed(2)} below minimum $${config.minOrderSize}`, { available: balance.available, required: config.minOrderSize });
    return {
      status: 'insufficient_balance',
      available: balance.available,
      required: config.minOrderSize,
      exchange,
    };
  }

  const isDryRun = config.dryRun === true;
  const modeLabel = isDryRun ? '[DRY-RUN] ' : '';

  logger.log('INFO', `[${exchange}] ${modeLabel}Allocation: ${state.totalAllocated}/${config.totalAllocation} used, buying ${actualBuyAmount.toFixed(2)}`);

  let buyResult, sellOrder;

  // Emit buy placing event
  tradeEvents.buyPlacing(exchange, actualBuyAmount, config.productId);

  let holdbackBTC;

  if (isDryRun) {
    // Simulate the trade without executing
    const simulatedBtcAmount = actualBuyAmount / currentPrice;
    const simulatedFees = actualBuyAmount * 0.00125; // ~0.125% fee
    const simulatedRebates = actualBuyAmount * 0.00031; // ~0.031% rebate

    buyResult = {
      orderId: `dry-run-buy-${Date.now()}`,
      price: currentPrice,
      btcAmount: simulatedBtcAmount,
      usdcAmount: actualBuyAmount,
      fees: simulatedFees,
      rebates: simulatedRebates,
      netFees: simulatedFees - simulatedRebates,
      actualCost: actualBuyAmount + (simulatedFees - simulatedRebates),
      status: 'SIMULATED',
    };

    const baseCcy = getBaseCurrency(config.productId);
    logger.log('INFO', `[${exchange}] ${modeLabel}Simulated buy: ${buyResult.btcAmount.toFixed(8)} ${baseCcy} at ${buyResult.price.toFixed(2)}`);
    tradeEvents.buyFilled(exchange, buyResult.btcAmount, buyResult.price, buyResult.fees);

    if (isFibonacci) {
      // Fibonacci dry run: update state first to get cumulative values
      stateTracker.updateAfterFibBuy(state, buyResult, config);
      const cycleInfo = stateTracker.getFibonacciCycleInfo(state);

      const sellQuantity = cycleInfo.cumulativeBTC * (1 - config.holdbackPercent / 100);
      const sellPrice = cycleInfo.avgCostBasis * (1 + config.sellMarkupPercent / 100);
      holdbackBTC = cycleInfo.cumulativeBTC * (config.holdbackPercent / 100);

      sellOrder = {
        orderId: `dry-run-fib-sell-${Date.now()}`,
        success: true,
        baseSize: sellQuantity,
        limitPrice: sellPrice,
        status: 'SIMULATED',
      };

      stateTracker.updateAfterFibSellOrder(state, sellOrder, sellQuantity, holdbackBTC);
      logger.logFibBuy(buyResult, state, cycleInfo, exchange);
      logger.logFibSellOrder(sellOrder, state, cycleInfo, exchange);
    } else {
      // Fixed dry run
      const sellQuantity = simulatedBtcAmount * (1 - config.holdbackPercent / 100);
      const sellPrice = currentPrice * (1 + config.sellMarkupPercent / 100);
      holdbackBTC = simulatedBtcAmount * (config.holdbackPercent / 100);

      sellOrder = {
        orderId: `dry-run-sell-${Date.now()}`,
        success: true,
        baseSize: sellQuantity,
        limitPrice: sellPrice,
        status: 'SIMULATED',
      };

      stateTracker.updateAfterBuy(state, buyResult, sellOrder, config);
      logger.logBuy(buyResult, state, exchange);
      logger.logSellOrder(sellOrder, state, exchange);
    }

    logger.log('INFO', `[${exchange}] ${modeLabel}Simulated sell order: ${sellOrder.baseSize.toFixed(8)} ${baseCcy} at ${sellOrder.limitPrice.toFixed(2)}`);
    tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
  } else {
    // Execute real trades
    buyResult = await orderManager.executeDailyBuy(config, actualBuyAmount, adapter);
    tradeEvents.buyFilled(exchange, buyResult.btcAmount, buyResult.price, buyResult.fees || buyResult.netFees || 0);

    if (isFibonacci) {
      // Fibonacci strategy: consolidated sell order
      stateTracker.updateAfterFibBuy(state, buyResult, config);
      const cycleInfo = stateTracker.getFibonacciCycleInfo(state);

      const fibSellResult = await orderManager.placeFibonacciSellOrder(
        config,
        cycleInfo.cumulativeBTC,
        cycleInfo.avgCostBasis,
        state.fibActiveSellOrderId,
        adapter
      );

      if (fibSellResult.alreadyFilled) {
        // Rare case: previous order filled between check and now
        const fibFill = await orderManager.checkFibonacciSellFill(state.fibActiveSellOrderId, adapter);
        stateTracker.updateAfterFibSellFill(state, fibFill);
        logger.logFibSellFilled(fibFill, state, cycleInfo.position, exchange);
        // Now place new sell order for this buy
        const newFibSellResult = await orderManager.placeFibonacciSellOrder(
          config,
          buyResult.btcAmount,
          buyResult.price + (buyResult.netFees || 0) / buyResult.btcAmount,
          null,
          adapter
        );
        sellOrder = newFibSellResult.sellOrder;
        holdbackBTC = newFibSellResult.holdbackBTC;
        stateTracker.updateAfterFibSellOrder(state, sellOrder, newFibSellResult.sellQuantityBTC, holdbackBTC);
      } else {
        sellOrder = fibSellResult.sellOrder;
        holdbackBTC = fibSellResult.holdbackBTC;
        stateTracker.updateAfterFibSellOrder(state, sellOrder, fibSellResult.sellQuantityBTC, holdbackBTC);
      }

      logger.logFibBuy(buyResult, state, cycleInfo, exchange);
      logger.logFibSellOrder(sellOrder, state, cycleInfo, exchange);
      tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
    } else {
      // Fixed strategy: individual sell order
      sellOrder = await orderManager.placeSellOrderWithRetry(config, buyResult, adapter);
      holdbackBTC = buyResult.btcAmount * (config.holdbackPercent / 100);
      stateTracker.updateAfterBuy(state, buyResult, sellOrder, config);
      logger.logBuy(buyResult, state, exchange);
      logger.logSellOrder(sellOrder, state, exchange);
      tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
    }
  }

  // Save state
  stateTracker.saveState(state, exchange);

  const baseCurrency = getBaseCurrency(config.productId);

  logger.log('INFO', `[${exchange}] ${modeLabel}=== ${intervalLabel} Cycle Complete ===`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Bought: ${buyResult.btcAmount.toFixed(8)} ${baseCurrency} at ${buyResult.price.toFixed(2)}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Sell order: ${sellOrder.baseSize.toFixed(8)} ${baseCurrency} at ${sellOrder.limitPrice.toFixed(2)}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Holdback (reserves): ${holdbackBTC.toFixed(8)} ${baseCurrency}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Total ${baseCurrency} reserves: ${state.btcReserves.toFixed(8)} ${baseCurrency}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Outstanding sell orders: ${state.outstandingOrdersUSDC.toFixed(2)}`);

  // Emit cycle complete event
  tradeEvents.cycleComplete(exchange, isDryRun ? 'dry_run_success' : 'success', {
    btcAmount: buyResult.btcAmount,
    buyPrice: buyResult.price,
    sellPrice: sellOrder.limitPrice,
    holdbackBTC,
    btcReserves: state.btcReserves,
    outstandingOrdersUSDC: state.outstandingOrdersUSDC,
  });

  // Check if auto-consolidation is needed (only for non-dry-run, fixed strategy only)
  // Fibonacci strategy handles its own consolidated sell orders
  if (!isDryRun && !isFibonacci) {
    const pendingCount = stateTracker.getPendingOrders(state).length;

    // Threshold-based consolidation
    if (config.consolidateAfterOrders > 0 && pendingCount > config.consolidateAfterOrders) {
      logger.log('INFO', `[${exchange}] Auto-consolidation triggered: ${pendingCount} orders > ${config.consolidateAfterOrders} threshold`);
      await executeConsolidation(exchange);
    }
    // Interval-based consolidation (only if threshold didn't trigger and we have 2+ orders)
    else if (pendingCount >= 2 && shouldRunConsolidation(state.lastConsolidationId, config.consolidateInterval)) {
      logger.log('INFO', `[${exchange}] Scheduled consolidation triggered: ${config.consolidateInterval} interval`);
      await executeConsolidation(exchange);
    }
  }

  const result = {
    status: isDryRun ? 'dry_run_success' : 'success',
    dryRun: isDryRun,
    intervalType: config.intervalType,
    buyResult,
    sellOrder,
    holdbackBTC,
    exchange,
    state: {
      totalAllocated: state.totalAllocated,
      btcReserves: state.btcReserves,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      intervalsRun: state.totalIntervalsRun,
    },
  };

  // Add Fibonacci-specific info if using that strategy
  if (isFibonacci) {
    const cycleInfo = stateTracker.getFibonacciCycleInfo(state);
    result.fibonacci = {
      position: cycleInfo.position,
      cumulativeCost: cycleInfo.cumulativeCost,
      cumulativeBTC: cycleInfo.cumulativeBTC,
      avgCostBasis: cycleInfo.avgCostBasis,
      activeSellOrderId: cycleInfo.activeSellOrderId,
    };
  }

  return result;
};

/**
 * Run cycle for all enabled exchanges
 * @returns {Promise<Object<string, CycleResult>>} Results per exchange
 */
const runAllExchangeCycles = async () => {
  const enabledExchanges = getEnabledExchanges();
  const results = {};

  for (const exchange of enabledExchanges) {
    logger.log('INFO', `Running cycle for ${exchange}...`);
    results[exchange] = await runIntervalCycle(exchange);
  }

  return results;
};

/**
 * Check status only (no trading) for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {Promise<StatusResult>} Current status
 */
const checkStatus = async (exchange = 'coinbase') => {
  const config = loadConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  const adapter = getAdapter(exchange);

  // Sync order statuses
  const filledOrders = await syncOrderStatuses(state, exchange);

  if (filledOrders.length > 0) {
    stateTracker.saveState(state, exchange);
  }

  const currentPrice = await adapter.getCurrentPrice(config.productId);
  const { remaining, intervalAmount } = stateTracker.checkAllocationRemaining(state, config);

  return {
    exchange,
    currentPrice,
    config: {
      productId: config.productId,
      totalAllocation: config.totalAllocation,
      intervalsToSpread: config.intervalsToSpread,
      intervalType: config.intervalType,
      sellMarkupPercent: config.sellMarkupPercent,
      holdbackPercent: config.holdbackPercent,
      maxBuyPrice: config.maxBuyPrice,
      enabled: config.enabled,
      dryRun: config.dryRun,
    },
    state: {
      totalAllocated: state.totalAllocated,
      remaining,
      intervalAmount,
      totalIntervalsRun: state.totalIntervalsRun,
      usdcFundSize: state.usdcFundSize,
      btcReserves: state.btcReserves,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      outstandingOrdersBTC: state.outstandingOrdersBTC,
      pendingOrders: stateTracker.getPendingOrders(state).length,
      lastRunId: state.lastRunId,
      lastRunTimestamp: state.lastRunTimestamp,
    },
    recentFills: filledOrders.length,
  };
};

// Legacy alias for backward compatibility
const runDailyCycle = runIntervalCycle;

module.exports = {
  runIntervalCycle,
  runDailyCycle,
  runAllExchangeCycles,
  checkStatus,
  syncOrderStatuses,
  loadConfig,
  executeConsolidation,
  getQuoteCurrency,
  getBaseCurrency,
};
