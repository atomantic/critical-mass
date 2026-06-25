// @ts-check
const { getAdapter } = require('./adapters');
const { log } = require('./logger');
const { getFibonacciSellPrice, getFibonacciSellQuantity } = require('./fibonacci-utils');
const { getBaseCurrency } = require('./config-utils');

/**
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 * @typedef {import('./types').BuyResult} BuyResult
 * @typedef {import('./types').SellOrder} SellOrder
 * @typedef {import('./types').FilledSellOrder} FilledSellOrder
 * @typedef {import('./types').TrackedOrder} TrackedOrder
 * @typedef {import('./types').ConsolidationResult} ConsolidationResult
 */

/**
 * Wait for a market buy order to fill and get fill details with fees
 * @param {string} orderId - Order ID to check
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @param {number} [maxAttempts] - Maximum polling attempts
 * @param {number} [delayMs] - Delay between polls
 * @returns {Promise<BuyResult>} Fill details including fees and rebates
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
        assetAmount: order.filledSize,
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
 * @param {ExchangeConfig} config - Configuration
 * @param {number} usdcAmount - Amount to spend in quote currency
 * @param {ExchangeAdapter|null} [adapter] - Exchange adapter (optional, uses coinbase by default)
 * @returns {Promise<BuyResult>} Buy result with fill details
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

  // Extract base currency from product ID (e.g., CRO_USD -> CRO, BTC-USDC -> BTC)
  const baseCurrency = getBaseCurrency(config.productId);
  log('INFO', `Buy filled: ${fillDetails.assetAmount.toFixed(8)} ${baseCurrency} at ${fillDetails.price.toFixed(2)}`);
  log('INFO', `Fees: ${fillDetails.fees.toFixed(4)}, Rebates: ${fillDetails.rebates.toFixed(4)}, Net: ${fillDetails.netFees.toFixed(4)}`);

  return fillDetails;
};

/**
 * Place a post-only sell order
 * @param {ExchangeConfig} config - Configuration
 * @param {BuyResult} buyDetails - Buy order fill details
 * @param {ExchangeAdapter|null} [adapter] - Exchange adapter (optional)
 * @returns {Promise<SellOrder>} Sell order result
 */
const placeSellOrder = async (config, buyDetails, adapter = null) => {
  adapter = adapter || getAdapter('coinbase');

  // Calculate sell quantity (minus holdback)
  const sellQuantity = buyDetails.assetAmount * (1 - config.holdbackPercent / 100);

  // Calculate sell price (plus markup)
  const sellPrice = buyDetails.price * (1 + config.sellMarkupPercent / 100);

  const baseCurrency = getBaseCurrency(config.productId);
  log('INFO', `Placing post-only sell for ${sellQuantity} ${baseCurrency} at ${sellPrice}`);

  const sellResult = await adapter.placeLimitSell(config.productId, sellQuantity, sellPrice);

  if (!sellResult.success) {
    throw new Error(`Limit sell failed: ${sellResult.errorMessage}`);
  }

  log('INFO', `Sell order placed: ${sellResult.orderId}`);

  return sellResult;
};

/**
 * Check status of pending sell orders (includes fee details)
 * @param {TrackedOrder[]} pendingOrders - List of pending orders from state
 * @param {ExchangeAdapter|null} [adapter] - Exchange adapter (optional)
 * @returns {Promise<FilledSellOrder[]>} List of orders that have filled with fee info
 */
const checkFilledOrders = async (pendingOrders, adapter = null) => {
  adapter = adapter || getAdapter('coinbase');
  const filledOrders = [];

  // Filter out dry-run orders - they don't exist on the exchange
  const realOrders = pendingOrders.filter(o => !o.orderId.startsWith('dry-run-'));

  for (const pendingOrder of realOrders) {
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
 * @param {ExchangeConfig} config - Configuration
 * @param {BuyResult} buyDetails - Buy order fill details
 * @param {ExchangeAdapter|null} [adapter] - Exchange adapter (optional)
 * @param {number} [maxRetries] - Maximum retry attempts
 * @returns {Promise<SellOrder>} Sell order result
 */
const placeSellOrderWithRetry = async (config, buyDetails, adapter = null, maxRetries = 3) => {
  adapter = adapter || getAdapter('coinbase');
  let lastError;
  let priceMultiplier = 1 + config.sellMarkupPercent / 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Get fresh price for each attempt
    const currentPrice = await adapter.getCurrentPrice(config.productId);
    const sellQuantity = buyDetails.assetAmount * (1 - config.holdbackPercent / 100);
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

/**
 * Consolidate multiple pending orders into a single order at weighted average price
 * @param {ExchangeConfig} config - Configuration
 * @param {TrackedOrder[]} pendingOrders - List of pending orders to consolidate
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @returns {Promise<ConsolidationResult>} Consolidation result
 */
const consolidatePendingOrders = async (config, pendingOrders, adapter) => {
  if (pendingOrders.length < 2) {
    return {
      success: false,
      error: 'At least 2 pending orders required for consolidation',
    };
  }

  // Filter out dry-run orders - they don't exist on the exchange
  const realOrders = pendingOrders.filter(o => !o.orderId?.startsWith('dry-run-'));
  if (realOrders.length < 2) {
    return {
      success: false,
      error: `Only ${realOrders.length} real orders after filtering dry-run orders`,
    };
  }

  const eligibleOrders = [];
  const skippedOrderIds = [];
  const cancelledOrders = [];
  const cancelledOrderIds = [];
  const filledDuringCancelOrderIds = [];

  // Step 1: Check each order for partial fills
  log('INFO', `Checking ${realOrders.length} orders for partial fills...`);
  for (const order of realOrders) {
    const orderDetails = await adapter.getOrder(order.orderId);

    // Skip orders that have partial fills
    if (orderDetails.completionPercentage > 0) {
      log('WARN', `Order ${order.orderId} has ${orderDetails.completionPercentage}% filled, skipping`);
      skippedOrderIds.push(order.orderId);
      continue;
    }

    eligibleOrders.push(order);
  }

  if (eligibleOrders.length < 2) {
    return {
      success: false,
      error: `Only ${eligibleOrders.length} eligible orders after filtering partial fills`,
      skippedOrderIds,
    };
  }

  const baseCurrency = getBaseCurrency(config.productId);

  // Step 2: Cancel all eligible orders, then re-fetch each to confirm it was
  // actually cancelled and not filled in the gap between the up-front eligibility
  // check and the cancel (issue #150). cancelOrder returns success on an
  // already-terminal (filled) order, so a fill landing in that window would
  // otherwise be counted into totalAsset and re-sold by the consolidated order —
  // a double-sell. Partition into confirmed-cancelled (still 0% filled) vs
  // filled-during-cancel; only the confirmed set feeds the consolidated quantity.
  log('INFO', `Cancelling ${eligibleOrders.length} orders...`);
  for (const order of eligibleOrders) {
    const cancelResult = await adapter.cancelOrder(order.orderId);
    if (!cancelResult.success) {
      // Abort consolidation if any cancel fails
      return {
        success: false,
        error: `Failed to cancel order ${order.orderId}`,
        cancelledOrderIds,
        skippedOrderIds,
      };
    }

    const postCancel = await adapter.getOrder(order.orderId);
    if (postCancel.completionPercentage > 0 || postCancel.status === 'FILLED') {
      // Filled (fully or partially) during the cancel window — its quantity is
      // already sold on the exchange. Exclude it from the consolidated total and
      // from cancelledOrderIds so the caller doesn't treat it as consolidated;
      // the engine's normal fill-detection path records the sale.
      log('WARN', `Order ${order.orderId} filled (${postCancel.completionPercentage}%) during cancel — excluding from consolidated total`);
      filledDuringCancelOrderIds.push(order.orderId);
      continue;
    }

    cancelledOrders.push(order);
    cancelledOrderIds.push(order.orderId);
  }

  // Step 3: Calculate weighted average sell price from confirmed-cancelled orders
  const totalAsset = cancelledOrders.reduce((sum, o) => sum + o.sellQuantity, 0);
  const weightedPriceSum = cancelledOrders.reduce((sum, o) => sum + (o.sellQuantity * o.sellPrice), 0);
  const consolidatedPrice = weightedPriceSum / totalAsset;

  if (cancelledOrders.length === 0) {
    // Every eligible order filled during its cancel window — nothing left to
    // consolidate. The fills are real and tracked elsewhere; report them so the
    // caller can reconcile, but place no order (no asset is held).
    log('WARN', 'All eligible orders filled during cancel — no consolidated order placed');
    return {
      success: true,
      newOrderId: null,
      consolidatedPrice: 0,
      consolidatedAsset: 0,
      consolidatedCount: 0,
      skippedOrderIds,
      cancelledOrderIds,
      filledDuringCancelOrderIds,
    };
  }

  log('INFO', `Consolidating ${cancelledOrders.length} orders: ${totalAsset.toFixed(8)} ${baseCurrency} @ ${consolidatedPrice.toFixed(2)}`);

  // Step 4: Place new consolidated order
  log('INFO', `Placing consolidated sell order: ${totalAsset.toFixed(8)} ${baseCurrency} @ ${consolidatedPrice.toFixed(2)}`);
  const sellResult = await adapter.placeLimitSell(config.productId, totalAsset, consolidatedPrice);

  if (!sellResult.success) {
    const error = `Failed to place consolidated order: ${sellResult.errorMessage}`;
    // The confirmed-cancelled sells are already cancelled, so the held asset is
    // now naked (no resting take-profit). Re-place those orders so the position is
    // never left unprotected on a consolidated-place failure. Orders that filled
    // during their cancel window are NOT re-placed — that quantity is already sold.
    // Note: we can't place the consolidated order before cancelling — the asset is
    // still locked in the open sells, so the exchange would reject it for
    // insufficient balance.
    log('ERROR', `${error} — re-placing ${cancelledOrders.length} original sells to avoid a naked position`);
    const restoredOrders = [];
    const failedRestoreOrderIds = [];
    for (const order of cancelledOrders) {
      const restoreResult = await adapter.placeLimitSell(config.productId, order.sellQuantity, order.sellPrice);
      if (restoreResult.success) {
        // Capture the old→new mapping so the caller can re-point tracked state
        // at the new exchange order IDs (the cancelled IDs no longer exist).
        restoredOrders.push({ oldOrderId: order.orderId, newOrderId: restoreResult.orderId });
      } else {
        failedRestoreOrderIds.push(order.orderId);
        log('ERROR', `Failed to restore sell for cancelled order ${order.orderId}: ${restoreResult.errorMessage}`);
      }
    }

    return {
      success: false,
      error,
      cancelledOrderIds,
      skippedOrderIds,
      filledDuringCancelOrderIds,
      restoredOrders,
      failedRestoreOrderIds,
    };
  }

  log('INFO', `Consolidation complete: ${cancelledOrders.length} orders -> 1 order (${sellResult.orderId})`);

  return {
    success: true,
    newOrderId: sellResult.orderId,
    consolidatedPrice,
    consolidatedAsset: totalAsset,
    consolidatedCount: cancelledOrders.length,
    skippedOrderIds,
    cancelledOrderIds,
    filledDuringCancelOrderIds,
  };
};

/**
 * Place or update a Fibonacci cycle consolidated sell order
 * Cancels previous sell order if exists and not filled, then places new order
 * @param {ExchangeConfig} config - Configuration
 * @param {number} cumulativeAsset - Total BTC accumulated in cycle
 * @param {number} avgCostBasis - Weighted average cost basis per BTC
 * @param {string|null} prevOrderId - Previous sell order ID to cancel
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @returns {Promise<{sellOrder: SellOrder, sellQuantity: number, holdbackAsset: number}>} Sell order result
 */
const placeFibonacciSellOrder = async (config, cumulativeAsset, avgCostBasis, prevOrderId, adapter) => {
  const baseCurrency = getBaseCurrency(config.productId);

  // Cancel previous order if it exists and is not filled
  if (prevOrderId) {
    const prevOrderStatus = await adapter.getOrder(prevOrderId);

    if (prevOrderStatus.status === 'OPEN' || prevOrderStatus.status === 'PENDING') {
      log('INFO', `Cancelling previous Fibonacci sell order ${prevOrderId}`);
      await adapter.cancelOrder(prevOrderId);
    } else if (prevOrderStatus.status === 'FILLED') {
      // Order already filled - this should trigger cycle reset
      log('INFO', `Previous Fibonacci sell order ${prevOrderId} already filled`);
      return { sellOrder: null, sellQuantity: 0, holdbackAsset: 0, alreadyFilled: true };
    }
  }

  // Calculate sell quantity and price
  const holdbackAsset = cumulativeAsset * (config.holdbackPercent / 100);
  const sellQuantity = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
  const sellPrice = getFibonacciSellPrice(avgCostBasis, config.sellMarkupPercent);

  log('INFO', `Placing Fibonacci sell: ${sellQuantity.toFixed(8)} ${baseCurrency} at $${sellPrice.toFixed(2)} (avg cost: $${avgCostBasis.toFixed(2)})`);

  // Ensure sell price is above current market for post-only
  const currentPrice = await adapter.getCurrentPrice(config.productId);
  let adjustedPrice = sellPrice;

  if (sellPrice <= currentPrice) {
    adjustedPrice = currentPrice * 1.01; // 1% above current price minimum
    log('WARN', `Fibonacci sell price $${sellPrice.toFixed(2)} below market $${currentPrice.toFixed(2)}, adjusting to $${adjustedPrice.toFixed(2)}`);
  }

  const sellResult = await adapter.placeLimitSell(config.productId, sellQuantity, adjustedPrice);

  if (!sellResult.success) {
    throw new Error(`Fibonacci sell order failed: ${sellResult.errorMessage}`);
  }

  log('INFO', `Fibonacci sell order placed: ${sellResult.orderId}`);

  return {
    sellOrder: sellResult,
    sellQuantity,
    holdbackAsset,
    alreadyFilled: false,
  };
};

/**
 * Check if a Fibonacci cycle sell order has filled
 * @param {string} orderId - Order ID to check
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @returns {Promise<FibonacciFillDetails|null>} Fill details if filled, null otherwise
 */
const checkFibonacciSellFill = async (orderId, adapter) => {
  const orderStatus = await adapter.getOrder(orderId);

  if (orderStatus.status !== 'FILLED') {
    return null;
  }

  const fillSummary = await adapter.getOrderFillSummary(orderId);

  return {
    orderId,
    filledSize: orderStatus.filledSize,
    fillValue: orderStatus.filledValue,
    averageFilledPrice: orderStatus.averageFilledPrice,
    fees: fillSummary.totalFees,
    rebates: fillSummary.totalRebates,
    netFees: fillSummary.netFees,
    netProceeds: orderStatus.filledValue - fillSummary.netFees,
  };
};

module.exports = {
  executeDailyBuy,
  placeSellOrder,
  placeSellOrderWithRetry,
  checkFilledOrders,
  waitForBuyFill,
  consolidatePendingOrders,
  // Fibonacci order management
  placeFibonacciSellOrder,
  checkFibonacciSellFill,
};
