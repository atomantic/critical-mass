// @ts-check
/**
 * Order Executor
 *
 * Handles order placement with maker-preference:
 * - Places post-only limit orders below current bid
 * - Manages order lifecycle (timeout, refresh, cancel)
 * - Implements atomic order replacement
 * - Anti-churn logic for TP updates
 */

const { roundBTC, roundPrice } = require('./volatility-utils');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').PendingOrder} PendingOrder
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 */

/**
 * Create order executor instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @param {string} productId - Product to trade
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onFillDetected] - Called when fill is detected via polling: (orderId, orderStatus)
 * @returns {Object} Order executor instance
 */
const createOrderExecutor = (exchange, config, adapter, productId, callbacks = {}) => {
  /** @type {Map<string, PendingOrder>} */
  const pendingOrders = new Map();

  let lastCancelTime = 0;
  let lastTpPrice = 0;
  let lastTpSize = 0;
  let activeTpOrderId = null;
  let staleTimeoutMultiplier = 1.0; // Can be adjusted by regime

  /**
   * Check if error indicates a post-only rejection (price moved)
   * @param {string} errorMessage - Error message from exchange
   * @returns {boolean} True if post-only rejection
   */
  const isPostOnlyRejection = (errorMessage) => {
    const msg = (errorMessage || '').toLowerCase();
    return msg.includes('post_only') ||
           msg.includes('post only') ||
           msg.includes('would cross') ||
           msg.includes('would immediately match') ||
           msg.includes('price is too aggressive');
  };

  /**
   * Place entry bid (maker-prefer post-only)
   * @param {number} sizeUsdc - Order size in USDC
   * @param {number} currentBid - Current best bid
   * @param {number} currentAsk - Current best ask
   * @param {number} [retryCount=0] - Current retry attempt
   * @param {number} [effectiveOffsetBps] - Optional dynamic offset (defaults to config.entryOffsetBps)
   * @returns {Promise<{success: boolean, orderId?: string, price?: number, btcQty?: number, errorMessage?: string}>}
   */
  const placeEntryBid = async (sizeUsdc, currentBid, currentAsk, retryCount = 0, effectiveOffsetBps = null) => {
    // Calculate bid price with offset below current bid (use dynamic offset if provided)
    const offsetBps = effectiveOffsetBps ?? config.entryOffsetBps;
    const offsetMultiplier = 1 - (offsetBps / 10000);
    let bidPrice = currentBid * offsetMultiplier;

    // Ensure post-only by checking against ask
    if (bidPrice >= currentAsk) {
      bidPrice = currentAsk * 0.999; // Back off to ensure maker
    }

    bidPrice = roundPrice(bidPrice);
    const btcQty = roundBTC(sizeUsdc / bidPrice);

    console.log(`📝 [${exchange}] Placing entry bid: ${btcQty} BTC @ $${bidPrice} (size $${sizeUsdc})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}`);

    const result = await adapter.placeLimitBuy(productId, btcQty, bidPrice, { postOnly: true });

    if (result.success) {
      // Verify order is actually open on exchange (post-only orders can be immediately cancelled)
      const orderStatus = await adapter.getOrder(result.orderId).catch(() => null);

      if (!orderStatus || orderStatus.status === 'CANCELLED') {
        // Order was immediately cancelled (likely post-only crossed spread)
        console.log(`⚠️ [${exchange}] Order ${result.orderId} was immediately cancelled by exchange`);

        // Retry with fresh prices if we have retries remaining
        const maxRetries = config.entryMaxRetries || 3;
        if (retryCount < maxRetries) {
          console.log(`🔄 [${exchange}] Retrying with fresh prices (retry ${retryCount + 1}/${maxRetries})`);
          const freshPrices = await adapter.getBidAsk(productId);
          return placeEntryBid(sizeUsdc, freshPrices.bid, freshPrices.ask, retryCount + 1);
        }

        return {
          success: false,
          errorMessage: 'Order immediately cancelled by exchange (post-only)',
        };
      }

      pendingOrders.set(result.orderId, {
        type: 'entry',
        price: bidPrice,
        size: btcQty,
        sizeUsdc,
        placedAt: Date.now(),
      });

      // Schedule stale order timeout check
      scheduleStaleOrderTimeout(result.orderId);

      return {
        success: true,
        orderId: result.orderId,
        price: bidPrice,
        btcQty,
      };
    }

    // Retry on post-only rejection if we have retries remaining
    const maxRetries = config.entryMaxRetries || 3;
    if (retryCount < maxRetries && isPostOnlyRejection(result.errorMessage)) {
      console.log(`🔄 [${exchange}] Post-only rejected (market moved), fetching fresh prices (retry ${retryCount + 1}/${maxRetries})`);

      const freshPrices = await adapter.getBidAsk(productId);
      return placeEntryBid(sizeUsdc, freshPrices.bid, freshPrices.ask, retryCount + 1);
    }

    return {
      success: false,
      errorMessage: result.errorMessage || 'Order placement failed',
    };
  };

  /**
   * Place or update take-profit sell order
   * @param {number} btcQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @returns {Promise<{success: boolean, orderId?: string, updated?: boolean, errorMessage?: string}>}
   */
  const placeTakeProfitOrder = async (btcQty, tpPrice) => {
    // Anti-churn: check if price OR size change is significant
    if (activeTpOrderId && lastTpPrice > 0 && lastTpSize > 0) {
      const priceChange = Math.abs(tpPrice - lastTpPrice) / lastTpPrice * 100;
      const sizeChange = Math.abs(btcQty - lastTpSize) / lastTpSize * 100;
      // Update if neither price nor size changed significantly
      if (priceChange < config.tpUpdateThresholdPct && sizeChange < 1) {
        return {
          success: true,
          orderId: activeTpOrderId,
          updated: false, // No update needed
        };
      }
    }

    // Cancel existing TP order if present
    if (activeTpOrderId) {
      await cancelTpOrder();
    }

    const roundedPrice = roundPrice(tpPrice);
    const roundedQty = roundBTC(btcQty);

    console.log(`📝 [${exchange}] Placing TP sell: ${roundedQty} BTC @ $${roundedPrice}`);

    const result = await adapter.placeLimitSell(productId, roundedQty, roundedPrice);

    if (result.success) {
      activeTpOrderId = result.orderId;
      lastTpPrice = roundedPrice;
      lastTpSize = roundedQty;

      pendingOrders.set(result.orderId, {
        type: 'take_profit',
        price: roundedPrice,
        size: roundedQty,
        sizeUsdc: roundedQty * roundedPrice,
        placedAt: Date.now(),
      });

      return {
        success: true,
        orderId: result.orderId,
        updated: true,
      };
    }

    return {
      success: false,
      errorMessage: result.errorMessage || 'TP order placement failed',
    };
  };

  /**
   * Cancel take-profit order
   * @returns {Promise<boolean>}
   */
  const cancelTpOrder = async () => {
    if (!activeTpOrderId) return true;

    const result = await adapter.cancelOrder(activeTpOrderId);

    if (result.success) {
      pendingOrders.delete(activeTpOrderId);
      activeTpOrderId = null;
      lastTpSize = 0;
      return true;
    }

    return false;
  };

  /**
   * Get the placedAt timestamp for an order
   * @param {string} orderId - Order ID
   * @returns {number|null} Timestamp when order was placed, or null if not found
   */
  const getOrderPlacedAt = (orderId) => {
    const order = pendingOrders.get(orderId);
    return order ? order.placedAt : null;
  };

  /**
   * Set stale timeout multiplier (for regime-based adjustment)
   * @param {number} multiplier - Multiplier to apply to orderStaleMs (e.g., 0.7 for faster timeout)
   */
  const setStaleTimeoutMultiplier = (multiplier) => {
    staleTimeoutMultiplier = Math.max(0.3, Math.min(2.0, multiplier)); // Clamp between 0.3x and 2x
  };

  /**
   * Get current effective stale timeout
   * @returns {number} Effective timeout in ms
   */
  const getEffectiveStaleMs = () => {
    return Math.round(config.orderStaleMs * staleTimeoutMultiplier);
  };

  /**
   * Schedule stale order timeout for entry order
   * Uses orderStaleMs * staleTimeoutMultiplier for regime-aware timeout
   * @param {string} orderId - Order ID to check
   */
  const scheduleStaleOrderTimeout = (orderId) => {
    const staleMs = getEffectiveStaleMs();
    setTimeout(() => {
      const order = pendingOrders.get(orderId);
      if (!order || order.type !== 'entry') return;

      adapter.getOrder(orderId)
        .then(status => {
          // Normalize status to uppercase for comparison
          const normalizedStatus = (status.status || '').toUpperCase();

          if (normalizedStatus === 'FILLED' || status.completionPercentage >= 100) {
            // Order filled but WebSocket missed it - notify regime engine
            console.log(`✅ [${exchange}] Stale check detected filled order ${orderId} (WebSocket missed)`);
            pendingOrders.delete(orderId);
            if (callbacks.onFillDetected) {
              callbacks.onFillDetected(orderId, status);
            }
          } else if (normalizedStatus === 'CANCELLED') {
            // Order was cancelled
            console.log(`⏰ [${exchange}] Stale check found cancelled order ${orderId}`);
            pendingOrders.delete(orderId);
          } else if (normalizedStatus === 'OPEN' && status.completionPercentage === 0) {
            // Not filled at all, cancel
            console.log(`⏰ [${exchange}] Stale order timeout, cancelling unfilled order ${orderId}`);
            return adapter.cancelOrder(orderId).then(() => {
              pendingOrders.delete(orderId);
            });
          }
          // Partially filled orders are left alone - WebSocket should handle incremental fills
        })
        .catch(err => {
          console.log(`❌ [${exchange}] Stale order check failed for ${orderId}: ${err.message}`);
        });
    }, config.orderStaleMs);
  };

  /**
   * Refresh stale orders (cancel unfilled, rate-limited)
   * @returns {Promise<number>} Number of orders refreshed
   */
  const refreshStaleOrders = async () => {
    const now = Date.now();
    let refreshed = 0;

    const effectiveStaleMs = getEffectiveStaleMs();
    for (const [orderId, order] of pendingOrders) {
      // Skip TP orders - they should stay
      if (order.type === 'take_profit') continue;

      // Check if order is stale (using regime-adjusted timeout)
      if (now - order.placedAt > effectiveStaleMs) {
        // Rate limit cancels
        if (now - lastCancelTime < config.cancelRateLimitMs) {
          continue;
        }

        const status = await adapter.getOrder(orderId);
        const normalizedStatus = (status.status || '').toUpperCase();

        if (normalizedStatus === 'FILLED' || status.completionPercentage >= 100) {
          // Order filled but WebSocket missed it
          console.log(`✅ [${exchange}] Refresh detected filled order ${orderId}`);
          pendingOrders.delete(orderId);
          if (callbacks.onFillDetected) {
            callbacks.onFillDetected(orderId, status);
          }
          refreshed++;
        } else if (normalizedStatus === 'CANCELLED') {
          console.log(`⏰ [${exchange}] Refresh found cancelled order ${orderId}`);
          pendingOrders.delete(orderId);
          refreshed++;
        } else if (normalizedStatus === 'OPEN' && status.completionPercentage === 0) {
          await adapter.cancelOrder(orderId);
          lastCancelTime = now;
          pendingOrders.delete(orderId);
          refreshed++;
        }
      }
    }

    return refreshed;
  };

  /**
   * Check all pending entry orders for fills (backup fill detection)
   * Call this periodically to catch fills that WebSocket missed
   * @returns {Promise<{filled: number, cancelled: number}>}
   */
  const checkPendingOrderFills = async () => {
    let filled = 0;
    let cancelled = 0;

    for (const [orderId, order] of pendingOrders) {
      if (order.type !== 'entry') continue;

      const status = await adapter.getOrder(orderId).catch(() => null);
      if (!status) continue;

      const normalizedStatus = (status.status || '').toUpperCase();

      if (normalizedStatus === 'FILLED' || status.completionPercentage >= 100) {
        console.log(`✅ [${exchange}] Fill check detected filled order ${orderId}`);
        pendingOrders.delete(orderId);
        if (callbacks.onFillDetected) {
          callbacks.onFillDetected(orderId, status);
        }
        filled++;
      } else if (normalizedStatus === 'CANCELLED') {
        console.log(`⏰ [${exchange}] Fill check found cancelled order ${orderId}`);
        pendingOrders.delete(orderId);
        cancelled++;
      }
    }

    return { filled, cancelled };
  };

  /**
   * Atomic order replacement (cancel then place)
   * @param {string} oldOrderId - Order to cancel
   * @param {Object} newOrderParams - New order parameters
   * @param {number} newOrderParams.btcQty - BTC quantity
   * @param {number} newOrderParams.price - Price
   * @param {'entry' | 'take_profit'} newOrderParams.type - Order type
   * @returns {Promise<{success: boolean, newOrderId?: string, reason?: string}>}
   */
  const atomicReplace = async (oldOrderId, newOrderParams) => {
    // Step 1: Cancel old order
    await adapter.cancelOrder(oldOrderId);

    // Step 2: Wait for cancel confirmation
    let confirmed = false;
    for (let i = 0; i < 5; i++) {
      const status = await adapter.getOrder(oldOrderId);
      if (status.status === 'CANCELLED' || status.status === 'FILLED') {
        confirmed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!confirmed) {
      return { success: false, reason: 'cancel_not_confirmed' };
    }

    // Step 3: Remove from internal state
    pendingOrders.delete(oldOrderId);

    // Step 4: Place new order
    const { btcQty, price, type } = newOrderParams;

    if (type === 'entry') {
      const result = await adapter.placeLimitBuy(productId, btcQty, price, { postOnly: true });
      if (result.success) {
        pendingOrders.set(result.orderId, {
          type: 'entry',
          price,
          size: btcQty,
          sizeUsdc: btcQty * price,
          placedAt: Date.now(),
        });
        return { success: true, newOrderId: result.orderId };
      }
    } else {
      const result = await adapter.placeLimitSell(productId, btcQty, price);
      if (result.success) {
        activeTpOrderId = result.orderId;
        lastTpPrice = price;
        lastTpSize = btcQty;
        pendingOrders.set(result.orderId, {
          type: 'take_profit',
          price,
          size: btcQty,
          sizeUsdc: btcQty * price,
          placedAt: Date.now(),
        });
        return { success: true, newOrderId: result.orderId };
      }
    }

    return { success: false, reason: 'new_order_failed' };
  };

  /**
   * Cancel all entry orders (for SAFE mode)
   * Continues on individual cancel failures to ensure all orders are attempted
   * @returns {Promise<number>} Number of orders cancelled
   */
  const cancelAllEntries = async () => {
    let cancelled = 0;
    let failed = 0;

    const entryOrders = Array.from(pendingOrders.entries())
      .filter(([, order]) => order.type === 'entry');

    const results = await Promise.allSettled(
      entryOrders.map(([orderId]) => adapter.cancelOrder(orderId))
    );

    results.forEach((result, index) => {
      const [orderId] = entryOrders[index];
      if (result.status === 'fulfilled') {
        pendingOrders.delete(orderId);
        cancelled++;
      } else {
        failed++;
        console.log(`⚠️ [${exchange}] Failed to cancel order ${orderId}: ${result.reason?.message || 'unknown'}`);
        // Still remove from tracking - order may have filled or been cancelled already
        pendingOrders.delete(orderId);
      }
    });

    console.log(`🚫 [${exchange}] Cancelled ${cancelled} entry orders${failed > 0 ? ` (${failed} failed)` : ''}`);
    return cancelled;
  };

  /**
   * Handle order fill notification
   * @param {string} orderId - Filled order ID
   */
  const handleOrderFill = (orderId) => {
    const order = pendingOrders.get(orderId);
    if (order) {
      pendingOrders.delete(orderId);

      if (order.type === 'take_profit') {
        activeTpOrderId = null;
        lastTpPrice = 0;
        lastTpSize = 0;
      }
    }
  };

  /**
   * Handle order cancel notification
   * @param {string} orderId - Cancelled order ID
   */
  const handleOrderCancel = (orderId) => {
    const order = pendingOrders.get(orderId);
    if (order) {
      pendingOrders.delete(orderId);

      if (order.type === 'take_profit' && orderId === activeTpOrderId) {
        activeTpOrderId = null;
        lastTpPrice = 0;
        lastTpSize = 0;
      }
    }
  };

  /**
   * Get pending orders count by type
   * @returns {{entries: number, takeProfits: number, total: number}}
   */
  const getPendingCounts = () => {
    let entries = 0;
    let takeProfits = 0;

    for (const order of pendingOrders.values()) {
      if (order.type === 'entry') entries++;
      else if (order.type === 'take_profit') takeProfits++;
    }

    return { entries, takeProfits, total: pendingOrders.size };
  };

  /**
   * Get all pending entry orders
   * @returns {Map<string, PendingOrder>}
   */
  const getPendingEntries = () => {
    const entries = new Map();
    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'entry') {
        entries.set(orderId, order);
      }
    }
    return entries;
  };

  /**
   * Get all pending orders as array for UI display
   * @returns {Array<{orderId: string, type: string, price: number, size: number, sizeUsdc: number, placedAt: number, status: string}>}
   */
  const getPendingOrdersList = () => {
    return Array.from(pendingOrders.entries()).map(([orderId, order]) => ({
      orderId,
      type: order.type,
      side: order.type === 'entry' ? 'buy' : 'sell',
      price: order.price,
      size: order.size,
      sizeUsdc: order.sizeUsdc,
      placedAt: order.placedAt,
      status: 'open',
    }));
  };

  /**
   * Check invariants (max open orders)
   * @returns {{valid: boolean, reason?: string}}
   */
  const checkInvariants = () => {
    if (pendingOrders.size > config.maxOpenOrders) {
      return {
        valid: false,
        reason: `too_many_orders:${pendingOrders.size}>${config.maxOpenOrders}`,
      };
    }
    return { valid: true };
  };

  /**
   * Get active TP order ID
   * @returns {string|null}
   */
  const getActiveTpOrderId = () => activeTpOrderId;

  /**
   * Get status summary for logging
   * @returns {string}
   */
  const getSummary = () => {
    const counts = getPendingCounts();
    let summary = `pending=${counts.total}(entries=${counts.entries},tp=${counts.takeProfits})`;

    if (activeTpOrderId) {
      summary += ` active_tp=${activeTpOrderId.substring(0, 8)}@$${lastTpPrice}`;
    }

    return summary;
  };

  /**
   * Clear all pending orders (for recovery)
   */
  const clearPendingOrders = () => {
    pendingOrders.clear();
    activeTpOrderId = null;
    lastTpPrice = 0;
    lastTpSize = 0;
  };

  /**
   * Restore pending order (for recovery from exchange)
   * @param {string} orderId - Order ID
   * @param {PendingOrder} order - Order details
   */
  const restorePendingOrder = (orderId, order) => {
    pendingOrders.set(orderId, order);

    if (order.type === 'take_profit') {
      activeTpOrderId = orderId;
      lastTpPrice = order.price;
      lastTpSize = order.size;
    }
  };

  return {
    placeEntryBid,
    placeTakeProfitOrder,
    cancelTpOrder,
    refreshStaleOrders,
    atomicReplace,
    cancelAllEntries,
    handleOrderFill,
    handleOrderCancel,
    getPendingCounts,
    getPendingEntries,
    getPendingOrdersList,
    checkInvariants,
    getActiveTpOrderId,
    getSummary,
    clearPendingOrders,
    restorePendingOrder,
    checkPendingOrderFills,
    // Fill time tracking
    getOrderPlacedAt,
    // Regime-based stale timeout
    setStaleTimeoutMultiplier,
    getEffectiveStaleMs,
  };
};

module.exports = {
  createOrderExecutor,
};
