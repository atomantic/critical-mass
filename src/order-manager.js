const { getAdapter } = require('./adapters');
const { log } = require('./logger');

/**
 * Wait for a market buy order to fill and get fill details with fees
 * @param {string} orderId - Order ID to check
 * @param {Object} adapter - Exchange adapter
 * @param {number} maxAttempts - Maximum polling attempts
 * @param {number} delayMs - Delay between polls
 * @returns {Promise<Object>} Fill details including fees and rebates
 */
const waitForBuyFill = async (orderId, adapter, maxAttempts = 10, delayMs = 1000) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const order = await adapter.getOrder(orderId);

    if (order.status === 'FILLED' || order.completionPercentage >= 100) {
      // Get detailed fill info with fees/rebates
      const fillSummary = await adapter.getOrderFillSummary(orderId);

      return {
        orderId,
        price: order.averageFilledPrice,
        btcAmount: order.filledSize,
        usdcAmount: order.filledValue,
        // Fee details
        fees: fillSummary.totalFees,
        rebates: fillSummary.totalRebates,
        netFees: fillSummary.netFees,
        // Actual cost = amount spent + net fees
        actualCost: order.filledValue + fillSummary.netFees,
        status: 'FILLED',
        fills: fillSummary.fills,
      };
    }

    if (order.status === 'CANCELLED' || order.status === 'EXPIRED') {
      throw new Error(`Buy order ${orderId} was ${order.status}`);
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error(`Buy order ${orderId} did not fill within ${maxAttempts} attempts`);
};

/**
 * Execute a daily buy order
 * @param {Object} config - Configuration
 * @param {number} usdcAmount - Amount to spend in quote currency
 * @param {Object} adapter - Exchange adapter (optional, uses coinbase by default)
 * @returns {Promise<Object>} Buy result with fill details
 */
const executeDailyBuy = async (config, usdcAmount, adapter = null) => {
  adapter = adapter || getAdapter('coinbase');

  log('INFO', `Placing market buy for ${usdcAmount} of ${config.productId}`);

  // Place the market buy
  const buyResult = await adapter.placeMarketBuy(config.productId, usdcAmount);

  if (!buyResult.success) {
    throw new Error(`Market buy failed: ${buyResult.errorMessage}`);
  }

  log('INFO', `Buy order placed: ${buyResult.orderId}`);

  // Wait for fill
  const fillDetails = await waitForBuyFill(buyResult.orderId, adapter);

  log('INFO', `Buy filled: ${fillDetails.btcAmount.toFixed(8)} BTC at ${fillDetails.price.toFixed(2)}`);
  log('INFO', `Fees: ${fillDetails.fees.toFixed(4)}, Rebates: ${fillDetails.rebates.toFixed(4)}, Net: ${fillDetails.netFees.toFixed(4)}`);

  return fillDetails;
};

/**
 * Place a post-only sell order
 * @param {Object} config - Configuration
 * @param {Object} buyDetails - Buy order fill details
 * @param {Object} adapter - Exchange adapter (optional)
 * @returns {Promise<Object>} Sell order result
 */
const placeSellOrder = async (config, buyDetails, adapter = null) => {
  adapter = adapter || getAdapter('coinbase');

  // Calculate sell quantity (minus holdback)
  const sellQuantity = buyDetails.btcAmount * (1 - config.holdbackPercent / 100);

  // Calculate sell price (plus markup)
  const sellPrice = buyDetails.price * (1 + config.sellMarkupPercent / 100);

  log('INFO', `Placing post-only sell for ${sellQuantity} BTC at ${sellPrice}`);

  const sellResult = await adapter.placeLimitSell(config.productId, sellQuantity, sellPrice);

  if (!sellResult.success) {
    throw new Error(`Limit sell failed: ${sellResult.errorMessage}`);
  }

  log('INFO', `Sell order placed: ${sellResult.orderId}`);

  return sellResult;
};

/**
 * Check status of pending sell orders (includes fee details)
 * @param {Array} pendingOrders - List of pending orders from state
 * @param {Object} adapter - Exchange adapter (optional)
 * @returns {Promise<Array>} List of orders that have filled with fee info
 */
const checkFilledOrders = async (pendingOrders, adapter = null) => {
  adapter = adapter || getAdapter('coinbase');
  const filledOrders = [];

  for (const pendingOrder of pendingOrders) {
    const orderStatus = await adapter.getOrder(pendingOrder.orderId);

    if (orderStatus.status === 'FILLED') {
      // Get detailed fill info with fees/rebates
      const fillSummary = await adapter.getOrderFillSummary(pendingOrder.orderId);

      filledOrders.push({
        orderId: pendingOrder.orderId,
        filledSize: orderStatus.filledSize,
        fillValue: orderStatus.filledValue,
        averageFilledPrice: orderStatus.averageFilledPrice,
        // Fee details
        fees: fillSummary.totalFees,
        rebates: fillSummary.totalRebates,
        netFees: fillSummary.netFees,
        // Net proceeds = fill value - net fees
        netProceeds: orderStatus.filledValue - fillSummary.netFees,
        originalOrder: pendingOrder,
      });

      log('INFO', `Sell order ${pendingOrder.orderId} filled at ${orderStatus.averageFilledPrice}`);
      log('INFO', `Sell fees: ${fillSummary.totalFees.toFixed(4)}, rebates: ${fillSummary.totalRebates.toFixed(4)}, net: ${fillSummary.netFees.toFixed(4)}`);
    }
  }

  return filledOrders;
};

/**
 * Retry placing a sell order if post-only was rejected
 * @param {Object} config - Configuration
 * @param {Object} buyDetails - Buy order fill details
 * @param {Object} adapter - Exchange adapter (optional)
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Object>} Sell order result
 */
const placeSellOrderWithRetry = async (config, buyDetails, adapter = null, maxRetries = 3) => {
  adapter = adapter || getAdapter('coinbase');
  let lastError;
  let priceMultiplier = 1 + config.sellMarkupPercent / 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Get fresh price for each attempt
    const currentPrice = await adapter.getCurrentPrice(config.productId);
    const sellQuantity = buyDetails.btcAmount * (1 - config.holdbackPercent / 100);
    const sellPrice = buyDetails.price * priceMultiplier;

    // Ensure sell price is above current market (for post-only)
    if (sellPrice <= currentPrice) {
      priceMultiplier += 0.01; // Add 1% more
      log('WARN', `Sell price ${sellPrice} below market ${currentPrice}, adjusting to ${buyDetails.price * priceMultiplier}`);
      continue;
    }

    const sellResult = await adapter.placeLimitSell(config.productId, sellQuantity, sellPrice);

    if (sellResult.success) {
      return sellResult;
    }

    lastError = sellResult.errorMessage;
    log('WARN', `Sell attempt ${attempt + 1} failed: ${lastError}`);

    // If post-only rejection, increase price
    if (lastError && lastError.includes('post only')) {
      priceMultiplier += 0.01;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Failed to place sell order after ${maxRetries} attempts: ${lastError}`);
};

module.exports = {
  executeDailyBuy,
  placeSellOrder,
  placeSellOrderWithRetry,
  checkFilledOrders,
  waitForBuyFill,
};
