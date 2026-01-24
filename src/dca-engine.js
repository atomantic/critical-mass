// @ts-check
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('./adapters');
const stateTracker = require('./state-tracker');
const orderManager = require('./order-manager');
const logger = require('./logger');
const { getExchangeConfig, getEnabledExchanges } = require('./config-utils');
const { normalizeConfig, formatInterval } = require('./interval-utils');

/**
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').BotState} BotState
 * @typedef {import('./types').CycleResult} CycleResult
 * @typedef {import('./types').StatusResult} StatusResult
 * @typedef {import('./types').FilledSellOrder} FilledSellOrder
 */

/**
 * Load configuration for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @returns {ExchangeConfig} Configuration
 */
const loadConfig = (exchange = 'coinbase') => getExchangeConfig(exchange);

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

  const adapter = getAdapter(exchange);
  const filledOrders = await orderManager.checkFilledOrders(pendingOrders, adapter);

  for (const filled of filledOrders) {
    stateTracker.updateAfterSellFill(state, filled);
    logger.logSellFilled(filled, state, exchange);
    logger.log('INFO', `[${exchange}] Sell order filled: +${filled.fillValue.toFixed(2)} USDC`);
  }

  return filledOrders;
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

  // Check if enabled
  if (!config.enabled) {
    logger.log('INFO', `[${exchange}] DCA bot is disabled in config`);
    return { status: 'disabled', exchange };
  }

  // Check if already ran this interval
  if (stateTracker.checkIfRanThisInterval(state, config.intervalType)) {
    logger.log('INFO', `[${exchange}] Already ran this ${intervalLabel} interval (${state.lastRunId})`);
    return { status: 'already_ran', lastRunId: state.lastRunId, intervalType: config.intervalType, exchange };
  }

  // Sync order statuses (check for filled sells)
  const filledOrders = await syncOrderStatuses(state, exchange);

  if (filledOrders.length > 0) {
    logger.log('INFO', `[${exchange}] ${filledOrders.length} orders filled since last run`);
    stateTracker.saveState(state, exchange);
  }

  // Check current price against max threshold
  const currentPrice = await adapter.getCurrentPrice(config.productId);
  logger.log('INFO', `[${exchange}] Current ${config.productId} price: ${currentPrice.toFixed(2)}`);

  if (currentPrice > config.maxBuyPrice) {
    logger.log('WARN', `[${exchange}] Price ${currentPrice} exceeds max buy price ${config.maxBuyPrice}`);
    return {
      status: 'price_too_high',
      currentPrice,
      maxBuyPrice: config.maxBuyPrice,
      exchange,
    };
  }

  // Check allocation remaining
  const { remaining, intervalAmount } = stateTracker.checkAllocationRemaining(state, config);

  if (remaining <= 0) {
    logger.log('INFO', `[${exchange}] Full allocation has been used`);
    return { status: 'fully_allocated', totalAllocated: state.totalAllocated, exchange };
  }

  if (intervalAmount < config.minOrderSize) {
    logger.log('INFO', `[${exchange}] Interval amount ${intervalAmount} below minimum ${config.minOrderSize}`);
    return { status: 'below_minimum', intervalAmount, minOrderSize: config.minOrderSize, exchange };
  }

  // Check balance and determine actual buy amount
  // Map currency based on exchange
  const quoteCurrency = exchange === 'gemini' ? 'USD' : 'USDC';
  const balance = await adapter.getAccountBalance(quoteCurrency);
  logger.log('INFO', `[${exchange}] ${quoteCurrency} balance: ${balance.available.toFixed(2)} available, ${balance.hold.toFixed(2)} on hold`);

  // Use the minimum of: interval amount, remaining allocation, or available balance
  let actualBuyAmount = Math.min(intervalAmount, remaining, balance.available);

  // If balance is below interval amount, use what's available
  if (balance.available < intervalAmount) {
    logger.log('WARN', `[${exchange}] Balance ${balance.available.toFixed(2)} below interval amount ${intervalAmount.toFixed(2)}, using what's available`);
  }

  // Check if we have enough to meet minimum order size
  if (actualBuyAmount < config.minOrderSize) {
    logger.log('ERROR', `[${exchange}] Available amount ${actualBuyAmount.toFixed(2)} below minimum ${config.minOrderSize}`);
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

    const sellQuantity = simulatedBtcAmount * (1 - config.holdbackPercent / 100);
    const sellPrice = currentPrice * (1 + config.sellMarkupPercent / 100);

    sellOrder = {
      orderId: `dry-run-sell-${Date.now()}`,
      success: true,
      baseSize: sellQuantity,
      limitPrice: sellPrice,
      status: 'SIMULATED',
    };

    logger.log('INFO', `[${exchange}] ${modeLabel}Simulated buy: ${buyResult.btcAmount.toFixed(8)} BTC at ${buyResult.price.toFixed(2)}`);
    logger.log('INFO', `[${exchange}] ${modeLabel}Simulated sell order: ${sellOrder.baseSize.toFixed(8)} BTC at ${sellOrder.limitPrice.toFixed(2)}`);
  } else {
    // Execute real trades
    buyResult = await orderManager.executeDailyBuy(config, actualBuyAmount, adapter);
    sellOrder = await orderManager.placeSellOrderWithRetry(config, buyResult, adapter);
  }

  // Update state (even in dry-run to track what would have happened)
  stateTracker.updateAfterBuy(state, buyResult, sellOrder, config);

  // Log transactions
  logger.logBuy(buyResult, state, exchange);
  logger.logSellOrder(sellOrder, state, exchange);

  // Save state
  stateTracker.saveState(state, exchange);

  const holdbackBTC = buyResult.btcAmount * (config.holdbackPercent / 100);

  logger.log('INFO', `[${exchange}] ${modeLabel}=== ${intervalLabel} Cycle Complete ===`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Bought: ${buyResult.btcAmount.toFixed(8)} BTC at ${buyResult.price.toFixed(2)}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Sell order: ${sellOrder.baseSize.toFixed(8)} BTC at ${sellOrder.limitPrice.toFixed(2)}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Holdback (reserves): ${holdbackBTC.toFixed(8)} BTC`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Total BTC reserves: ${state.btcReserves.toFixed(8)} BTC`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Outstanding sell orders: ${state.outstandingOrdersUSDC.toFixed(2)}`);

  return {
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
};
