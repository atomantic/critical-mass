// @ts-check
const { getAdapter } = require('./adapters');
const { createContextLogger } = require('./logger');
const { getFibonacciSellPrice, getFibonacciSellQuantity } = require('./fibonacci-utils');
const { getBaseCurrency } = require('./config-utils');
const { isFilledStatus } = require('./shared-utils');

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
 * Build a context logger for a single order-manager operation.
 *
 * These are module-level functions rather than a factory closure, so the stable
 * trading context (which exchange, which pair) is derived per call from the
 * adapter and product id the caller passed in. Every adapter exposes `name`
 * via createBaseAdapter; `pair` is omitted when the call site only has an
 * adapter (JSON.stringify drops undefined keys, so the context stays clean).
 * @param {ExchangeAdapter|null} [adapter] - Exchange adapter (supplies the exchange name)
 * @param {string} [productId] - Trading pair being operated on
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const orderLogger = (adapter, productId) => createContextLogger({
  module: 'order-manager',
  exchange: adapter?.name,
  pair: productId,
});

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

    if (isFilledStatus(order)) {
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
      // A cancelled/expired order can still carry a real partial fill — e.g.
      // Gemini's IOC market buy reports CANCELLED once the unfilled remainder
      // is cancelled, but order.filledSize/filledValue reflect what actually
      // executed. Funds moved, so record the fill instead of throwing it away
      // as a "money moved, engine recorded nothing" leak (issue #208A follow-up).
      if (order.filledSize > 0) {
        const fillSummary = await adapter.getOrderFillSummary(orderId);
        return {
          orderId,
          price: order.averageFilledPrice,
          assetAmount: order.filledSize,
          usdcAmount: order.filledValue,
          fees: fillSummary.totalFees,
          rebates: fillSummary.totalRebates,
          netFees: fillSummary.netFees,
          actualCost: order.filledValue + fillSummary.netFees,
          status: order.status,
          fills: fillSummary.fills,
        };
      }
      throw new Error(`Buy order ${orderId} was ${order.status}`);
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error(`Buy order ${orderId} did not fill within ${maxAttempts} attempts`);
};

/**
 * Terminal exchange statuses that mean an order never became (or is no longer) a
 * live/executed position. A reconciled order in one of these states is NOT
 * adopted — it's treated as a clean failure, safe to re-place next cycle.
 */
const NON_ADOPTABLE_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED']);

/**
 * Place an order and, if the adapter reports an ambiguous 'unknown' outcome
 * (order-POST network error that may have reached the matching engine — issue
 * #199/#226), reconcile by client_order_id instead of treating it as a hard
 * failure. If the exchange shows a live/filled order carrying the deterministic
 * client_order_id we sent, adopt it (its orderId is real and must be tracked, or
 * we double-spend by re-buying). Only a genuinely-absent (or terminally-failed)
 * order is a true failure.
 *
 * A try/catch is unavoidable here: the adapter signals the unknown outcome by
 * throwing (so it can never be mistaken for a clean success), so the caller must
 * catch to reconcile. Non-unknown errors are re-thrown unchanged.
 *
 * The reconcile lookup retries with backoff (default 500ms/1s) if the first
 * attempt comes back empty — the exchange's order-history endpoint can be
 * briefly eventually-consistent right after the network error that produced
 * the unknown outcome, and declaring a real order absent too early lets a
 * caller re-place it against one that may still land (double exposure).
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @param {string} productId - Product ID (scopes the reconcile lookup)
 * @param {() => Promise<BuyResult|SellOrder>} placeFn - Placement thunk
 * @param {number[]} [retryDelaysMs] - Backoff (ms) between reconcile-lookup attempts; pass `[]` for a single immediate attempt (e.g. in tests)
 * @returns {Promise<BuyResult|SellOrder>} Placement result (possibly reconciled)
 */
// Backoff between reconcile-lookup attempts when the first comes back empty —
// the exchange's order-history endpoint can be briefly eventually-consistent
// right after a network error on the placement POST, so a single immediate
// lookup risks declaring a real order absent and letting a caller re-place it
// (double exposure) purely because the lookup raced ahead of propagation.
const RECONCILE_RETRY_DELAYS_MS = [500, 1000];

const placeWithUnknownReconcile = async (adapter, productId, placeFn, retryDelaysMs = RECONCILE_RETRY_DELAYS_MS) => {
  const placement = await placeFn().catch((err) => {
    // Only the ambiguous order-POST outcome is reconcilable; anything else
    // (validation errors, hard network failure on non-order POSTs) propagates.
    if (err?.status === 'unknown' || err?.unknownOutcome === true) {
      return { __unknownError: err };
    }
    throw err;
  });

  if (!placement?.__unknownError) {
    return placement;
  }

  const err = placement.__unknownError;
  const clientOrderId = err.clientOrderId;

  // Can't reconcile without the id or a lookup capability — surface as a clean
  // failure (the safe mode: no untracked position, engine re-buys next cycle).
  const logger = orderLogger(adapter, productId);

  if (!clientOrderId || typeof adapter.findOrderByClientOrderId !== 'function') {
    logger.error(`❌ Unknown order outcome and cannot reconcile (clientOrderId=${clientOrderId ?? 'none'}) — treating as failed`, {
      clientOrderId: clientOrderId ?? null,
      reconcilable: false,
      error: err.message,
    });
    return { success: false, errorMessage: err.message };
  }

  logger.warn(`⚠️ Unknown order outcome — reconciling by client_order_id ${clientOrderId}`, {
    clientOrderId,
    error: err.message,
  });
  let found = null;
  for (let attempt = 0; ; attempt++) {
    found = await adapter.findOrderByClientOrderId(clientOrderId, productId);
    if (found || attempt >= retryDelaysMs.length) break;
    await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
  }

  if (found && !NON_ADOPTABLE_STATUSES.has(found.status)) {
    // The order DID reach the exchange — adopt it rather than re-place (which
    // would double-spend against the already-executing order).
    logger.info(`ℹ️ ✅ Reconciled unknown placement — adopting exchange order ${found.orderId} (status ${found.status})`, {
      orderId: found.orderId,
      clientOrderId,
      status: found.status,
      reconciled: true,
    });
    return { orderId: found.orderId, clientOrderId, success: true, reconciled: true };
  }

  logger.warn(`❌ Unknown placement not found live on exchange (client_order_id ${clientOrderId}, status ${found?.status ?? 'absent'}) — treating as failed, safe to re-place next cycle`, {
    clientOrderId,
    status: found?.status ?? 'absent',
    error: err.message,
  });
  return { success: false, errorMessage: err.message };
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
  const logger = orderLogger(adapter, config.productId);

  logger.info(`ℹ️ Placing market buy for ${usdcAmount} of ${config.productId}`, { usdcAmount });

  // Place the market buy. An ambiguous 'unknown' outcome (network error after
  // the POST may have executed) is reconciled by client_order_id rather than
  // re-placed — re-placing an order that actually filled is the double-spend
  // this guards against (issue #226).
  const buyResult = await placeWithUnknownReconcile(
    adapter,
    config.productId,
    () => adapter.placeMarketBuy(config.productId, usdcAmount)
  );

  if (!buyResult.success) {
    throw new Error(`Market buy failed: ${buyResult.errorMessage}`);
  }

  logger.info(`ℹ️ Buy order placed: ${buyResult.orderId}`, { orderId: buyResult.orderId, usdcAmount });

  // Wait for fill
  const fillDetails = await waitForBuyFill(buyResult.orderId, adapter);

  // Extract base currency from product ID (e.g., CRO_USD -> CRO, BTC-USDC -> BTC)
  const baseCurrency = getBaseCurrency(config.productId);
  logger.info(`ℹ️ Buy filled: ${fillDetails.assetAmount.toFixed(8)} ${baseCurrency} at ${fillDetails.price.toFixed(2)}`, {
    orderId: buyResult.orderId,
    assetAmount: fillDetails.assetAmount,
    price: fillDetails.price,
  });
  logger.info(`ℹ️ Fees: ${fillDetails.fees.toFixed(4)}, Rebates: ${fillDetails.rebates.toFixed(4)}, Net: ${fillDetails.netFees.toFixed(4)}`, {
    orderId: buyResult.orderId,
    fees: fillDetails.fees,
    rebates: fillDetails.rebates,
    netFees: fillDetails.netFees,
  });

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
  const logger = orderLogger(adapter, config.productId);
  logger.info(`ℹ️ Placing post-only sell for ${sellQuantity} ${baseCurrency} at ${sellPrice}`, { sellQuantity, sellPrice });

  // An ambiguous 'unknown' outcome here (network error after the POST may
  // have reached the exchange) is reconciled by client_order_id, mirroring
  // the buy-side fix (issue #226) — otherwise this sell would be treated as
  // a clean failure while a real order may be resting live and untracked.
  const sellResult = await placeWithUnknownReconcile(
    adapter,
    config.productId,
    () => adapter.placeLimitSell(config.productId, sellQuantity, sellPrice)
  );

  if (!sellResult.success) {
    throw new Error(`Limit sell failed: ${sellResult.errorMessage}`);
  }

  // A reconciled placement only carries orderId/clientOrderId (the exchange
  // lookup that adopted it doesn't echo back the limit price/size we
  // requested) — fill in the locally-known request parameters so callers
  // (e.g. state-tracker's attachSellOrder, which reads sellOrder.limitPrice
  // for accounting) see the same shape as a normal placement success.
  if (sellResult.reconciled) {
    sellResult.baseSize = sellQuantity;
    sellResult.limitPrice = sellPrice;
  }

  logger.info(`ℹ️ Sell order placed: ${sellResult.orderId}`, {
    orderId: sellResult.orderId,
    sellQuantity,
    sellPrice,
  });

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
  // No product id is available here — TrackedOrder carries only order ids.
  const logger = orderLogger(adapter);
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

      logger.info(`ℹ️ Sell order ${pendingOrder.orderId} filled at ${orderStatus.averageFilledPrice}`, {
        orderId: pendingOrder.orderId,
        averageFilledPrice: orderStatus.averageFilledPrice,
        filledSize: orderStatus.filledSize,
      });
      logger.info(`ℹ️ Sell fees: ${fillSummary.totalFees.toFixed(4)}, rebates: ${fillSummary.totalRebates.toFixed(4)}, net: ${fillSummary.netFees.toFixed(4)}`, {
        orderId: pendingOrder.orderId,
        fees: fillSummary.totalFees,
        rebates: fillSummary.totalRebates,
        netFees: fillSummary.netFees,
      });
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
  const logger = orderLogger(adapter, config.productId);
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
      logger.warn(`⚠️ Sell price ${sellPrice} below market ${currentPrice}, adjusting to ${buyDetails.price * priceMultiplier}`, {
        attempt: attempt + 1,
        sellPrice,
        currentPrice,
        adjustedPrice: buyDetails.price * priceMultiplier,
      });
      continue;
    }

    // Reconcile an ambiguous 'unknown' outcome by client_order_id (issue #226
    // sell-side follow-up) instead of letting it fall through to the
    // clean-failure retry below, which could re-place against an order that
    // actually reached the exchange.
    const sellResult = await placeWithUnknownReconcile(
      adapter,
      config.productId,
      () => adapter.placeLimitSell(config.productId, sellQuantity, sellPrice)
    );

    if (sellResult.success) {
      if (sellResult.reconciled) {
        sellResult.baseSize = sellQuantity;
        sellResult.limitPrice = sellPrice;
      }
      return sellResult;
    }

    lastError = sellResult.errorMessage;
    logger.warn(`⚠️ Sell attempt ${attempt + 1} failed: ${lastError}`, {
      attempt: attempt + 1,
      maxRetries,
      sellQuantity,
      sellPrice,
      error: lastError,
    });

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

  const logger = orderLogger(adapter, config.productId);

  // Step 1: Check each order for partial fills
  logger.info(`ℹ️ Checking ${realOrders.length} orders for partial fills...`, { orderCount: realOrders.length });
  for (const order of realOrders) {
    const orderDetails = await adapter.getOrder(order.orderId);

    // Skip orders that have partial fills
    if (orderDetails.completionPercentage > 0) {
      logger.warn(`⚠️ Order ${order.orderId} has ${orderDetails.completionPercentage}% filled, skipping`, {
        orderId: order.orderId,
        completionPercentage: orderDetails.completionPercentage,
      });
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
  logger.info(`ℹ️ Cancelling ${eligibleOrders.length} orders...`, { orderCount: eligibleOrders.length });
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

    // Re-fetch may return null/undefined for a just-cancelled or not-found order.
    // Treat an indeterminate result as "do not consolidate" (exclude), the
    // conservative choice: re-selling an order that may have filled is the
    // double-sell we're guarding against, whereas excluding a cleanly-cancelled
    // order only frees its asset for the engine's normal reconciliation to re-cover.
    const postCancel = await adapter.getOrder(order.orderId);
    if (!postCancel || postCancel.completionPercentage > 0 || postCancel.status === 'FILLED') {
      // Filled (fully or partially) during the cancel window, or indeterminate —
      // any filled quantity is already sold on the exchange. Exclude the WHOLE
      // order from the consolidated total and from cancelledOrderIds so the caller
      // doesn't treat it as consolidated; report it in filledDuringCancelOrderIds
      // for reconciliation. We deliberately do NOT fold a partial fill's unfilled
      // remainder into the consolidated order: updateAfterConsolidation would
      // attribute the order's full cost basis to the new order while only the
      // remainder is in it, corrupting P&L. The freed remainder asset is re-covered
      // by the engine's normal cycle reconciliation, same as any cancelled order.
      logger.warn(`⚠️ Order ${order.orderId} filled (${postCancel?.completionPercentage ?? 'unknown'}%) during cancel — excluding from consolidated total`, {
        orderId: order.orderId,
        completionPercentage: postCancel?.completionPercentage ?? null,
        status: postCancel?.status ?? 'indeterminate',
      });
      filledDuringCancelOrderIds.push(order.orderId);
      continue;
    }

    cancelledOrders.push(order);
    cancelledOrderIds.push(order.orderId);
  }

  if (cancelledOrders.length === 0) {
    // Every eligible order filled during its cancel window — nothing left to
    // consolidate. The fills are real and tracked elsewhere; report them so the
    // caller can reconcile, but place no order (no asset is held).
    logger.warn('⚠️ All eligible orders filled during cancel — no consolidated order placed', {
      filledDuringCancelCount: filledDuringCancelOrderIds.length,
    });
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

  // Step 3: Calculate weighted average sell price from confirmed-cancelled orders
  const totalAsset = cancelledOrders.reduce((sum, o) => sum + o.sellQuantity, 0);
  const weightedPriceSum = cancelledOrders.reduce((sum, o) => sum + (o.sellQuantity * o.sellPrice), 0);
  const consolidatedPrice = weightedPriceSum / totalAsset;

  logger.info(`ℹ️ Consolidating ${cancelledOrders.length} orders: ${totalAsset.toFixed(8)} ${baseCurrency} @ ${consolidatedPrice.toFixed(2)}`, {
    orderCount: cancelledOrders.length,
    totalAsset,
    consolidatedPrice,
  });

  // Step 4: Place new consolidated order
  logger.info(`ℹ️ Placing consolidated sell order: ${totalAsset.toFixed(8)} ${baseCurrency} @ ${consolidatedPrice.toFixed(2)}`, {
    totalAsset,
    consolidatedPrice,
  });
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
    logger.error(`❌ ${error} — re-placing ${cancelledOrders.length} original sells to avoid a naked position`, {
      error: sellResult.errorMessage,
      nakedOrderCount: cancelledOrders.length,
      cancelledOrderIds,
    });
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
        logger.error(`❌ Failed to restore sell for cancelled order ${order.orderId}: ${restoreResult.errorMessage}`, {
          orderId: order.orderId,
          sellQuantity: order.sellQuantity,
          sellPrice: order.sellPrice,
          error: restoreResult.errorMessage,
        });
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

  logger.info(`ℹ️ Consolidation complete: ${cancelledOrders.length} orders -> 1 order (${sellResult.orderId})`, {
    orderId: sellResult.orderId,
    consolidatedCount: cancelledOrders.length,
    consolidatedPrice,
    consolidatedAsset: totalAsset,
  });

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
  const logger = orderLogger(adapter, config.productId);

  // Inspect the previous sell before mutating any state. We look at the actual
  // executed amount (filledSize), not just the coarse status string, because
  // exchanges disagree on how they label a live partially-executed order
  // (Gemini → 'PARTIALLY_FILLED'; Coinbase → 'OPEN' with filled_size > 0).
  // Three cases: fully filled, partially filled (still live), fully open.
  let alreadySoldQty = 0;
  let prevFill = null;

  if (prevOrderId) {
    const prevOrderStatus = await adapter.getOrder(prevOrderId);
    const filledSize = prevOrderStatus.filledSize || 0;
    // A resting limit sell the engine placed is still live while OPEN/PENDING or,
    // on Gemini, PARTIALLY_FILLED. Only a live order should be cancelled; a
    // terminal status (CANCELLED/EXPIRED/UNKNOWN) falls through to place-new,
    // preserving prior behaviour.
    const isLive = prevOrderStatus.status === 'OPEN'
      || prevOrderStatus.status === 'PENDING'
      || prevOrderStatus.status === 'PARTIALLY_FILLED';

    if (prevOrderStatus.status === 'FILLED') {
      // Fully filled - this should trigger cycle reset upstream
      logger.info(`ℹ️ Previous Fibonacci sell order ${prevOrderId} already filled`, {
        orderId: prevOrderId,
        status: prevOrderStatus.status,
      });
      return { sellOrder: null, sellQuantity: 0, holdbackAsset: 0, alreadyFilled: true };
    }

    if (isLive && filledSize > 0) {
      // Partially executed and still live (Gemini → 'PARTIALLY_FILLED';
      // Coinbase → 'OPEN' with filled_size > 0). Cancel the remainder, then
      // credit the already-executed portion and shrink the new consolidated
      // sell so the sold quantity is not re-sold from reserves (issue #200,
      // Bug B).
      logger.info(`ℹ️ Previous Fibonacci sell ${prevOrderId} partially filled (${filledSize} ${baseCurrency}); cancelling remainder`, {
        orderId: prevOrderId,
        status: prevOrderStatus.status,
        filledSize,
      });
      const cancelResult = await adapter.cancelOrder(prevOrderId);

      if (!cancelResult || cancelResult.success !== true) {
        // Cancel refused - the order filled between getOrder and cancelOrder.
        // Route through the fill path so the full fill is credited upstream.
        logger.warn(`⚠️ Cancel refused for partially-filled ${prevOrderId} - treating as fully filled`, {
          orderId: prevOrderId,
          filledSize,
          cancelSuccess: cancelResult?.success ?? null,
        });
        return { sellOrder: null, sellQuantity: 0, holdbackAsset: 0, alreadyFilled: true };
      }

      // Gather the executed-portion details so the caller can book the proceeds.
      const fillSummary = await adapter.getOrderFillSummary(prevOrderId);
      prevFill = {
        orderId: prevOrderId,
        filledSize,
        fillValue: prevOrderStatus.filledValue,
        averageFilledPrice: prevOrderStatus.averageFilledPrice,
        fees: fillSummary.totalFees,
        rebates: fillSummary.totalRebates,
        netFees: fillSummary.netFees,
        netProceeds: (prevOrderStatus.filledValue || 0) - fillSummary.netFees,
      };
      alreadySoldQty = filledSize;
    } else if (isLive) {
      // Fully open, nothing executed - cancel and replace.
      logger.info(`ℹ️ Cancelling previous Fibonacci sell order ${prevOrderId}`, {
        orderId: prevOrderId,
        status: prevOrderStatus.status,
      });
      const cancelResult = await adapter.cancelOrder(prevOrderId);

      if (!cancelResult || cancelResult.success !== true) {
        // Cancel refused - the order filled between getOrder and cancelOrder.
        logger.warn(`⚠️ Cancel refused for ${prevOrderId} - treating as fully filled`, {
          orderId: prevOrderId,
          cancelSuccess: cancelResult?.success ?? null,
        });
        return { sellOrder: null, sellQuantity: 0, holdbackAsset: 0, alreadyFilled: true };
      }
    }
  }

  // Calculate sell quantity and price. Holdback stays a fixed fraction of the
  // full cycle cumulative (design intent); the new sell only covers what still
  // needs selling after subtracting any already-executed partial quantity.
  const holdbackAsset = cumulativeAsset * (config.holdbackPercent / 100);
  const targetSellQuantity = getFibonacciSellQuantity(cumulativeAsset, config.holdbackPercent);
  const sellQuantity = Math.max(0, targetSellQuantity - alreadySoldQty);
  const sellPrice = getFibonacciSellPrice(avgCostBasis, config.sellMarkupPercent);

  logger.info(`ℹ️ Placing Fibonacci sell: ${sellQuantity.toFixed(8)} ${baseCurrency} at $${sellPrice.toFixed(2)} (avg cost: $${avgCostBasis.toFixed(2)})`, {
    sellQuantity,
    sellPrice,
    avgCostBasis,
    alreadySoldQty,
  });

  // Ensure sell price is above current market for post-only
  const currentPrice = await adapter.getCurrentPrice(config.productId);
  let adjustedPrice = sellPrice;

  if (sellPrice <= currentPrice) {
    adjustedPrice = currentPrice * 1.01; // 1% above current price minimum
    logger.warn(`⚠️ Fibonacci sell price $${sellPrice.toFixed(2)} below market $${currentPrice.toFixed(2)}, adjusting to $${adjustedPrice.toFixed(2)}`, {
      sellPrice,
      currentPrice,
      adjustedPrice,
    });
  }

  // Reconcile an ambiguous 'unknown' outcome by client_order_id (issue #226
  // sell-side follow-up) instead of treating it as a clean failure — a real
  // consolidated sell may have reached the exchange despite the network error.
  const sellResult = await placeWithUnknownReconcile(
    adapter,
    config.productId,
    () => adapter.placeLimitSell(config.productId, sellQuantity, adjustedPrice)
  );

  if (!sellResult.success) {
    throw new Error(`Fibonacci sell order failed: ${sellResult.errorMessage}`);
  }

  if (sellResult.reconciled) {
    sellResult.baseSize = sellQuantity;
    sellResult.limitPrice = adjustedPrice;
  }

  logger.info(`ℹ️ Fibonacci sell order placed: ${sellResult.orderId}`, {
    orderId: sellResult.orderId,
    sellQuantity,
    limitPrice: adjustedPrice,
  });

  return {
    sellOrder: sellResult,
    sellQuantity,
    holdbackAsset,
    alreadyFilled: false,
    // Present only when a partially-filled prev sell was cancelled and rolled
    // into this consolidated order; the caller books its proceeds (issue #200).
    prevFill,
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
  placeWithUnknownReconcile,
  placeSellOrder,
  placeSellOrderWithRetry,
  checkFilledOrders,
  waitForBuyFill,
  consolidatePendingOrders,
  // Fibonacci order management
  placeFibonacciSellOrder,
  checkFibonacciSellFill,
};
