const api = require('./api');
const stateTracker = require('./state-tracker');
const orderManager = require('./order-manager');
const logger = require('./logger');

/**
 * Load configuration from config.json
 * @returns {Object} Configuration
 */
const loadConfig = () => require('../config.json');

/**
 * Sync order statuses and update state for filled orders
 * @param {Object} state - Current state
 * @returns {Promise<Array>} List of newly filled orders
 */
const syncOrderStatuses = async (state) => {
  const pendingOrders = stateTracker.getPendingOrders(state);

  if (pendingOrders.length === 0) {
    return [];
  }

  logger.log('INFO', `Checking ${pendingOrders.length} pending orders...`);

  const filledOrders = await orderManager.checkFilledOrders(pendingOrders);

  for (const filled of filledOrders) {
    stateTracker.updateAfterSellFill(state, filled);
    logger.logSellFilled(filled, state);
    logger.log('INFO', `Sell order filled: +${filled.fillValue.toFixed(2)} USDC`);
  }

  return filledOrders;
};

/**
 * Run the daily DCA cycle
 * @returns {Promise<Object>} Result of the cycle
 */
const runDailyCycle = async () => {
  const config = loadConfig();
  const state = stateTracker.loadState(config);

  // Check if enabled
  if (!config.enabled) {
    logger.log('INFO', 'DCA bot is disabled in config');
    return { status: 'disabled' };
  }

  // Check if already ran today
  if (stateTracker.checkIfRanToday(state)) {
    logger.log('INFO', `Already ran today (${state.lastRunDate})`);
    return { status: 'already_ran', lastRunDate: state.lastRunDate };
  }

  // Sync order statuses (check for filled sells)
  const filledOrders = await syncOrderStatuses(state);

  if (filledOrders.length > 0) {
    logger.log('INFO', `${filledOrders.length} orders filled since last run`);
    stateTracker.saveState(state);
  }

  // Check current price against max threshold
  const currentPrice = await api.getCurrentPrice(config.productId);
  logger.log('INFO', `Current ${config.productId} price: ${currentPrice.toFixed(2)} USDC`);

  if (currentPrice > config.maxBuyPrice) {
    logger.log('WARN', `Price ${currentPrice} exceeds max buy price ${config.maxBuyPrice}`);
    return {
      status: 'price_too_high',
      currentPrice,
      maxBuyPrice: config.maxBuyPrice,
    };
  }

  // Check allocation remaining
  const { remaining, dailyAmount } = stateTracker.checkAllocationRemaining(state, config);

  if (remaining <= 0) {
    logger.log('INFO', 'Full allocation has been used');
    return { status: 'fully_allocated', totalAllocated: state.totalAllocated };
  }

  if (dailyAmount < config.minOrderSize) {
    logger.log('INFO', `Daily amount ${dailyAmount} below minimum ${config.minOrderSize}`);
    return { status: 'below_minimum', dailyAmount, minOrderSize: config.minOrderSize };
  }

  // Check USDC balance and determine actual buy amount
  const balance = await api.getAccountBalance('USDC');
  logger.log('INFO', `Coinbase USDC balance: ${balance.available.toFixed(2)} available, ${balance.hold.toFixed(2)} on hold`);

  // Use the minimum of: daily amount, remaining allocation, or available balance
  let actualBuyAmount = Math.min(dailyAmount, remaining, balance.available);

  // If balance is below daily amount, use what's available
  if (balance.available < dailyAmount) {
    logger.log('WARN', `Balance ${balance.available.toFixed(2)} below daily amount ${dailyAmount.toFixed(2)}, using what's available`);
  }

  // Check if we have enough to meet minimum order size
  if (actualBuyAmount < config.minOrderSize) {
    logger.log('ERROR', `Available amount ${actualBuyAmount.toFixed(2)} below minimum ${config.minOrderSize}`);
    return {
      status: 'insufficient_balance',
      available: balance.available,
      required: config.minOrderSize,
    };
  }

  logger.log('INFO', `Allocation: ${state.totalAllocated}/${config.totalAllocation} USDC used, buying ${actualBuyAmount.toFixed(2)} USDC`);

  // Execute buy
  const buyResult = await orderManager.executeDailyBuy(config, actualBuyAmount);

  // Place sell order with retry (in case of post-only rejection)
  const sellOrder = await orderManager.placeSellOrderWithRetry(config, buyResult);

  // Update state
  stateTracker.updateAfterBuy(state, buyResult, sellOrder, config);

  // Log transactions
  logger.logBuy(buyResult, state);
  logger.logSellOrder(sellOrder, state);

  // Save state
  stateTracker.saveState(state);

  const holdbackBTC = buyResult.btcAmount * (config.holdbackPercent / 100);

  logger.log('INFO', '=== Daily Cycle Complete ===');
  logger.log('INFO', `Bought: ${buyResult.btcAmount.toFixed(8)} BTC at ${buyResult.price.toFixed(2)}`);
  logger.log('INFO', `Sell order: ${sellOrder.baseSize.toFixed(8)} BTC at ${sellOrder.limitPrice.toFixed(2)}`);
  logger.log('INFO', `Holdback (reserves): ${holdbackBTC.toFixed(8)} BTC`);
  logger.log('INFO', `Total BTC reserves: ${state.btcReserves.toFixed(8)} BTC`);
  logger.log('INFO', `Outstanding sell orders: ${state.outstandingOrdersUSDC.toFixed(2)} USDC`);

  return {
    status: 'success',
    buyResult,
    sellOrder,
    holdbackBTC,
    state: {
      totalAllocated: state.totalAllocated,
      btcReserves: state.btcReserves,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      daysRun: state.totalDaysRun,
    },
  };
};

/**
 * Check status only (no trading)
 * @returns {Promise<Object>} Current status
 */
const checkStatus = async () => {
  const config = loadConfig();
  const state = stateTracker.loadState(config);

  // Sync order statuses
  const filledOrders = await syncOrderStatuses(state);

  if (filledOrders.length > 0) {
    stateTracker.saveState(state);
  }

  const currentPrice = await api.getCurrentPrice(config.productId);
  const { remaining, dailyAmount } = stateTracker.checkAllocationRemaining(state, config);

  return {
    currentPrice,
    config: {
      productId: config.productId,
      totalAllocation: config.totalAllocation,
      daysToSpread: config.daysToSpread,
      sellMarkupPercent: config.sellMarkupPercent,
      holdbackPercent: config.holdbackPercent,
      maxBuyPrice: config.maxBuyPrice,
      enabled: config.enabled,
    },
    state: {
      totalAllocated: state.totalAllocated,
      remaining,
      dailyAmount,
      totalDaysRun: state.totalDaysRun,
      usdcFundSize: state.usdcFundSize,
      btcReserves: state.btcReserves,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      outstandingOrdersBTC: state.outstandingOrdersBTC,
      pendingOrders: stateTracker.getPendingOrders(state).length,
      lastRunDate: state.lastRunDate,
    },
    recentFills: filledOrders.length,
  };
};

module.exports = {
  runDailyCycle,
  checkStatus,
  syncOrderStatuses,
  loadConfig,
};
