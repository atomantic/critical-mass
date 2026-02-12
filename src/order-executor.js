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

  /** @type {Map<string, {tpOrderId: string, btcQty: number, tpPrice: number}>} */
  const satelliteTpOrders = new Map(); // buyOrderId -> satellite TP tracking (legacy alias)
  const bodyTpOrders = satelliteTpOrders; // Celestial body TP tracking (same Map, new name)

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
   * Safe cancel: cancel order, then check status on failure to detect fills
   * @param {string} orderId - Order ID to cancel
   * @returns {Promise<{cancelled: boolean, filled: boolean}>}
   */
  const safeCancelOrder = async (orderId) => {
    const result = await adapter.cancelOrder(orderId);
    if (result.success) return { cancelled: true, filled: false };

    const status = await adapter.getOrder(orderId).catch(() => null);
    if (status && (status.status === 'FILLED' || status.completionPercentage >= 100)) {
      console.log(`📋 [${exchange}] Order ${orderId.slice(0, 8)} already filled (discovered during cancel)`);
      return { cancelled: false, filled: true };
    }
    if (status && status.status === 'CANCELLED') {
      return { cancelled: true, filled: false };
    }

    console.log(`⚠️ [${exchange}] Cancel failed for ${orderId.slice(0, 8)}, status=${status?.status || 'unknown'}`);
    return { cancelled: false, filled: false };
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
   * @param {Object} [options] - Options
   * @param {boolean} [options.forceUpdate] - Bypass anti-churn (use after buy fills)
   * @returns {Promise<{success: boolean, orderId?: string, updated?: boolean, errorMessage?: string}>}
   */
  const placeTakeProfitOrder = async (btcQty, tpPrice, options = {}) => {
    // Anti-churn: check if price OR size change is significant (skip if forceUpdate)
    if (!options.forceUpdate && activeTpOrderId && lastTpPrice > 0 && lastTpSize > 0) {
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
      const oldTpId = activeTpOrderId;
      const cancelSuccess = await cancelTpOrder();
      if (!cancelSuccess) {
        console.log(`⚠️ [${exchange}] Failed to cancel old TP order ${oldTpId}, keeping it tracked to avoid duplicate sells`);
        // Do NOT clear tracking or place a new TP - risk of two live TP orders causing oversell
        return {
          success: false,
          errorMessage: `Cannot place new TP: failed to cancel existing TP order ${oldTpId}`,
        };
      }
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

    const orderToCancel = activeTpOrderId;
    const result = await adapter.cancelOrder(orderToCancel);

    if (result.success) {
      console.log(`🗑️ [${exchange}] Cancelled TP order: ${orderToCancel}`);
      pendingOrders.delete(orderToCancel);
      activeTpOrderId = null;
      lastTpSize = 0;
      return true;
    }

    console.log(`⚠️ [${exchange}] Cancel TP failed for ${orderToCancel}: ${result.errorMessage || 'unknown error'}`);
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
            // Capture placedAt BEFORE deleting from pendingOrders
            const placedAt = order.placedAt;
            pendingOrders.delete(orderId);
            if (callbacks.onFillDetected) {
              callbacks.onFillDetected(orderId, { ...status, placedAt });
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

    const isTpType = (type) => type === 'take_profit' || type === 'satellite_tp' || type === 'body_tp';
    const effectiveStaleMs = getEffectiveStaleMs();
    for (const [orderId, order] of pendingOrders) {
      // Check if order is stale (using regime-adjusted timeout)
      if (now - order.placedAt > effectiveStaleMs) {
        // Rate limit cancels (only relevant for non-TP orders)
        if (!isTpType(order.type) && now - lastCancelTime < config.cancelRateLimitMs) {
          continue;
        }

        const status = await adapter.getOrder(orderId);
        const normalizedStatus = (status.status || '').toUpperCase();

        if (normalizedStatus === 'FILLED' || status.completionPercentage >= 100) {
          console.log(`✅ [${exchange}] Refresh detected filled ${order.type} order ${orderId}`);
          const placedAt = order.placedAt;
          pendingOrders.delete(orderId);
          if (callbacks.onFillDetected) {
            callbacks.onFillDetected(orderId, { ...status, placedAt });
          }
          refreshed++;
        } else if (normalizedStatus === 'CANCELLED') {
          console.log(`⏰ [${exchange}] Refresh found cancelled ${order.type} order ${orderId}`);
          pendingOrders.delete(orderId);
          refreshed++;
        } else if (normalizedStatus === 'OPEN' && status.completionPercentage === 0 && !isTpType(order.type)) {
          // Only cancel stale ENTRY orders — TP orders should persist until filled
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
   * Check all pending orders for fills (backup fill detection)
   * Call this periodically to catch fills that WebSocket missed
   * Checks entries, take_profit, body_tp, and satellite_tp orders
   * @returns {Promise<{filled: number, cancelled: number}>}
   */
  const checkPendingOrderFills = async () => {
    let filled = 0;
    let cancelled = 0;

    for (const [orderId, order] of pendingOrders) {
      const status = await adapter.getOrder(orderId).catch(() => null);
      if (!status) continue;

      const normalizedStatus = (status.status || '').toUpperCase();

      if (normalizedStatus === 'FILLED' || status.completionPercentage >= 100) {
        console.log(`✅ [${exchange}] Fill check detected filled ${order.type} order ${orderId}`);
        const placedAt = order.placedAt;
        pendingOrders.delete(orderId);
        if (callbacks.onFillDetected) {
          callbacks.onFillDetected(orderId, { ...status, placedAt });
        }
        filled++;
      } else if (normalizedStatus === 'CANCELLED') {
        console.log(`⏰ [${exchange}] Fill check found cancelled ${order.type} order ${orderId}`);
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
      } else if (order.type === 'satellite_tp' || order.type === 'body_tp') {
        removeSatelliteTracking(orderId);
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
      } else if (order.type === 'satellite_tp' || order.type === 'body_tp') {
        removeSatelliteTracking(orderId);
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
    let satellites = 0;

    for (const order of pendingOrders.values()) {
      if (order.type === 'entry') entries++;
      else if (order.type === 'take_profit') takeProfits++;
      else if (order.type === 'satellite_tp' || order.type === 'body_tp') satellites++;
    }

    return { entries, takeProfits, satellites, total: pendingOrders.size };
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
      side: (order.type === 'entry' || order.type === 'ladder_entry') ? 'buy' : 'sell',
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
    let summary = `pending=${counts.total}(entries=${counts.entries},tp=${counts.takeProfits},sat=${counts.satellites})`;

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
    satelliteTpOrders.clear();
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
    // satellite_tp/body_tp orders are restored via restoreSatelliteTpOrder/restoreBodyTpOrder
  };

  // ============================================================================
  // Satellite TP Functions
  // ============================================================================

  /**
   * Place a satellite TP sell order (independent from core TP)
   * @param {number} btcQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {string} buyOrderId - Buy order ID that created this satellite
   * @returns {Promise<{success: boolean, orderId?: string, errorMessage?: string}>}
   */
  const placeSatelliteTpOrder = async (btcQty, tpPrice, buyOrderId) => {
    const roundedPrice = roundPrice(tpPrice);
    const roundedQty = roundBTC(btcQty);

    console.log(`📝 [${exchange}] Placing satellite TP: ${roundedQty} BTC @ $${roundedPrice} (buy=${buyOrderId.substring(0, 8)})`);

    const result = await adapter.placeLimitSell(productId, roundedQty, roundedPrice);

    if (result.success) {
      satelliteTpOrders.set(buyOrderId, {
        tpOrderId: result.orderId,
        btcQty: roundedQty,
        tpPrice: roundedPrice,
      });

      pendingOrders.set(result.orderId, {
        type: 'satellite_tp',
        price: roundedPrice,
        size: roundedQty,
        sizeUsdc: roundedQty * roundedPrice,
        placedAt: Date.now(),
      });

      return { success: true, orderId: result.orderId };
    }

    return { success: false, errorMessage: result.errorMessage || 'Satellite TP order failed' };
  };

  /**
   * Cancel a specific satellite TP order
   * @param {string} buyOrderId - Buy order ID of the satellite to cancel
   * @returns {Promise<{cancelled: boolean, filled: boolean}>}
   */
  const cancelSatelliteTpOrder = async (buyOrderId) => {
    const satellite = satelliteTpOrders.get(buyOrderId);
    if (!satellite) return { cancelled: true, filled: false };

    const result = await safeCancelOrder(satellite.tpOrderId);
    if (result.cancelled) {
      pendingOrders.delete(satellite.tpOrderId);
      satelliteTpOrders.delete(buyOrderId);
      return { cancelled: true, filled: false };
    }
    if (result.filled) {
      satelliteTpOrders.delete(buyOrderId);
      // Leave in pendingOrders for polling to process the fill
      return { cancelled: false, filled: true };
    }
    return { cancelled: false, filled: false };
  };

  /**
   * Cancel all satellite TP orders
   * @returns {Promise<number>} Number cancelled
   */
  const cancelAllSatelliteTpOrders = async () => {
    let cancelled = 0;
    const entries = Array.from(satelliteTpOrders.entries());

    for (const [buyOrderId, satellite] of entries) {
      const result = await safeCancelOrder(satellite.tpOrderId).catch(() => ({ cancelled: false, filled: false }));
      if (result.cancelled) {
        pendingOrders.delete(satellite.tpOrderId);
        cancelled++;
      } else if (result.filled) {
        console.log(`📋 [${exchange}] Satellite TP ${satellite.tpOrderId.slice(0, 8)} filled during bulk cancel`);
      }
      satelliteTpOrders.delete(buyOrderId);
    }

    return cancelled;
  };

  /**
   * Check if an order ID is a satellite TP order
   * @param {string} orderId - Exchange order ID to check
   * @returns {boolean}
   */
  const isSatelliteTpOrder = (orderId) => {
    for (const satellite of satelliteTpOrders.values()) {
      if (satellite.tpOrderId === orderId) return true;
    }
    return false;
  };

  /**
   * Get satellite tracking info by TP order ID
   * @param {string} tpOrderId - Exchange sell order ID
   * @returns {{buyOrderId: string, btcQty: number, tpPrice: number}|null}
   */
  const getSatelliteByTpOrderId = (tpOrderId) => {
    for (const [buyOrderId, satellite] of satelliteTpOrders) {
      if (satellite.tpOrderId === tpOrderId) {
        return { buyOrderId, ...satellite };
      }
    }
    return null;
  };

  /**
   * Restore satellite TP order tracking (for recovery)
   * @param {string} buyOrderId - Buy order ID
   * @param {string} tpOrderId - Exchange sell order ID
   * @param {number} btcQty - BTC quantity
   * @param {number} tpPrice - TP price
   * @param {number} [placedAt] - Original placement timestamp (ms), defaults to now
   */
  const restoreSatelliteTpOrder = (buyOrderId, tpOrderId, btcQty, tpPrice, placedAt) => {
    satelliteTpOrders.set(buyOrderId, { tpOrderId, btcQty, tpPrice });

    pendingOrders.set(tpOrderId, {
      type: 'satellite_tp',
      price: tpPrice,
      size: btcQty,
      sizeUsdc: btcQty * tpPrice,
      placedAt: placedAt || Date.now(),
    });
  };

  /**
   * Remove satellite tracking after fill or cancel
   * @param {string} tpOrderId - Exchange sell order ID that was filled/cancelled
   */
  const removeSatelliteTracking = (tpOrderId) => {
    for (const [buyOrderId, satellite] of satelliteTpOrders) {
      if (satellite.tpOrderId === tpOrderId) {
        satelliteTpOrders.delete(buyOrderId);
        pendingOrders.delete(tpOrderId);
        return;
      }
    }
  };

  // ============================================================================
  // Celestial Body TP Functions (wrappers over satellite TP for new naming)
  // ============================================================================

  /**
   * Place a body TP sell order (celestial hierarchy)
   * @param {number} btcQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {string} bodyId - Celestial body ID
   * @returns {Promise<{success: boolean, orderId?: string, errorMessage?: string}>}
   */
  const placeBodyTpOrder = async (btcQty, tpPrice, bodyId) => {
    const roundedPrice = roundPrice(tpPrice);
    const roundedQty = roundBTC(btcQty);

    console.log(`📝 [${exchange}] Placing body TP: ${roundedQty} BTC @ $${roundedPrice} (body=${bodyId.slice(-8)})`);

    // Body TPs should not use post_only — when market reaches TP price, the order must fill
    const result = await adapter.placeLimitSell(productId, roundedQty, roundedPrice, { postOnly: false });

    if (result.success) {
      bodyTpOrders.set(bodyId, {
        tpOrderId: result.orderId,
        btcQty: roundedQty,
        tpPrice: roundedPrice,
      });

      pendingOrders.set(result.orderId, {
        type: 'body_tp',
        price: roundedPrice,
        size: roundedQty,
        sizeUsdc: roundedQty * roundedPrice,
        placedAt: Date.now(),
      });

      return { success: true, orderId: result.orderId };
    }

    return { success: false, errorMessage: result.errorMessage || 'Body TP order failed' };
  };

  /**
   * Cancel a specific body TP order
   * @param {string} bodyId - Celestial body ID
   * @returns {Promise<{cancelled: boolean, filled: boolean}>}
   */
  const cancelBodyTpOrder = async (bodyId) => {
    const body = bodyTpOrders.get(bodyId);
    if (!body) return { cancelled: true, filled: false };

    const result = await safeCancelOrder(body.tpOrderId);
    if (result.cancelled) {
      pendingOrders.delete(body.tpOrderId);
      bodyTpOrders.delete(bodyId);
      return { cancelled: true, filled: false };
    }
    if (result.filled) {
      bodyTpOrders.delete(bodyId);
      // Leave in pendingOrders for polling to process the fill
      return { cancelled: false, filled: true };
    }
    return { cancelled: false, filled: false };
  };

  /**
   * Check if an order ID is a body TP order
   * @param {string} orderId - Exchange order ID to check
   * @returns {boolean}
   */
  const isBodyTpOrder = (orderId) => {
    for (const body of bodyTpOrders.values()) {
      if (body.tpOrderId === orderId) return true;
    }
    return false;
  };

  /**
   * Get body tracking info by TP order ID
   * @param {string} tpOrderId - Exchange sell order ID
   * @returns {{bodyId: string, btcQty: number, tpPrice: number}|null}
   */
  const getBodyByTpOrderId = (tpOrderId) => {
    for (const [bodyId, body] of bodyTpOrders) {
      if (body.tpOrderId === tpOrderId) {
        return { bodyId, ...body };
      }
    }
    return null;
  };

  /**
   * Restore body TP order tracking (for recovery)
   * @param {string} bodyId - Body ID
   * @param {string} tpOrderId - Exchange sell order ID
   * @param {number} btcQty - BTC quantity
   * @param {number} tpPrice - TP price
   * @param {number} [placedAt] - Original placement timestamp (ms), defaults to now
   */
  const restoreBodyTpOrder = (bodyId, tpOrderId, btcQty, tpPrice, placedAt) => {
    bodyTpOrders.set(bodyId, { tpOrderId, btcQty, tpPrice });

    pendingOrders.set(tpOrderId, {
      type: 'body_tp',
      price: tpPrice,
      size: btcQty,
      sizeUsdc: btcQty * tpPrice,
      placedAt: placedAt || Date.now(),
    });
  };

  /**
   * Remove body tracking after fill or cancel
   * @param {string} tpOrderId - Exchange sell order ID that was filled/cancelled
   */
  const removeBodyTracking = (tpOrderId) => {
    for (const [bodyId, body] of bodyTpOrders) {
      if (body.tpOrderId === tpOrderId) {
        bodyTpOrders.delete(bodyId);
        pendingOrders.delete(tpOrderId);
        return;
      }
    }
  };

  // ============================================================================
  // Ladder Mode Functions
  // ============================================================================

  /**
   * Sleep utility for rate limiting
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Place multiple ladder entry orders
   * @param {Array<{index: number, price: number, sizeUsdc: number, btcQty: number}>} levels - Ladder levels
   * @returns {Promise<{orders: Array<{orderId: string, index: number, price: number, sizeUsdc: number, btcQty: number}>, failedCount: number}>}
   */
  const placeLadderOrders = async (levels) => {
    const results = [];
    let failedCount = 0;

    for (const level of levels) {
      const result = await adapter.placeLimitBuy(productId, level.btcQty, level.price, { postOnly: true }).catch(err => {
        console.log(`⚠️ [${exchange}] Error placing ladder order at $${level.price}: ${err.message}`);
        return { success: false, errorMessage: err.message };
      });

      if (result.success) {
        // Verify order is actually open (post-only can be immediately cancelled)
        const orderStatus = await adapter.getOrder(result.orderId).catch(() => null);

        // Only treat as immediately cancelled when we positively know it's cancelled.
        // If we failed to fetch status (null), track the order and let later refresh reconcile.
        if (orderStatus && orderStatus.status === 'CANCELLED') {
          console.log(`⚠️ [${exchange}] Ladder order at $${level.price} was immediately cancelled`);
          failedCount++;
          continue;
        }

        if (!orderStatus) {
          console.log(`⚠️ [${exchange}] Could not verify ladder order at $${level.price}, tracking it for reconciliation`);
        }

        pendingOrders.set(result.orderId, {
          type: 'ladder_entry',
          price: level.price,
          size: level.btcQty,
          sizeUsdc: level.sizeUsdc,
          ladderIndex: level.index,
          placedAt: Date.now(),
        });

        results.push({
          orderId: result.orderId,
          ladderIndex: level.index,
          price: level.price,
          sizeUsdc: level.sizeUsdc,
          btcQty: level.btcQty,
        });
      } else {
        console.log(`⚠️ [${exchange}] Failed to place ladder order at $${level.price}: ${result.errorMessage}`);
        failedCount++;
      }

      // Rate limit between orders
      await sleep(100);
    }

    return { orders: results, failedCount };
  };

  /**
   * Cancel all unfilled ladder orders
   * @returns {Promise<{cancelled: number, remainingTracked: number}>} Cancel results
   */
  const cancelAllLadderOrders = async () => {
    let cancelled = 0;

    const ladderOrders = Array.from(pendingOrders.entries())
      .filter(([, order]) => order.type === 'ladder_entry');

    for (const [orderId] of ladderOrders) {
      const result = await safeCancelOrder(orderId).catch(() => ({ cancelled: false, filled: false }));
      if (result.cancelled) {
        pendingOrders.delete(orderId);
        cancelled++;
      } else if (result.filled) {
        console.log(`📋 [${exchange}] Ladder order ${orderId.slice(0, 8)} filled during cancel — polling will process`);
      } else {
        console.log(`⚠️ [${exchange}] Failed to cancel ladder order ${orderId.slice(0, 8)}`);
      }
    }

    const remainingTracked = Array.from(pendingOrders.values())
      .filter(o => o.type === 'ladder_entry').length;

    return { cancelled, remainingTracked };
  };

  /**
   * Get all pending ladder orders
   * @returns {Array<{orderId: string, price: number, sizeUsdc: number, ladderIndex: number, placedAt: number}>}
   */
  const getPendingLadderOrders = () => {
    const ladderOrders = [];
    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'ladder_entry') {
        ladderOrders.push({
          orderId,
          price: order.price,
          size: order.size,
          sizeUsdc: order.sizeUsdc,
          ladderIndex: order.ladderIndex,
          placedAt: order.placedAt,
        });
      }
    }
    return ladderOrders.sort((a, b) => b.price - a.price); // Sort by price descending (top of ladder first)
  };

  /**
   * Check if an order is a ladder entry order
   * @param {string} orderId - Order ID to check
   * @returns {boolean}
   */
  const isLadderOrder = (orderId) => {
    const order = pendingOrders.get(orderId);
    return order?.type === 'ladder_entry';
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
    // Satellite TP functions (legacy aliases)
    placeSatelliteTpOrder,
    cancelSatelliteTpOrder,
    cancelAllSatelliteTpOrders,
    isSatelliteTpOrder,
    getSatelliteByTpOrderId,
    restoreSatelliteTpOrder,
    removeSatelliteTracking,
    // Celestial body TP functions
    placeBodyTpOrder,
    cancelBodyTpOrder,
    isBodyTpOrder,
    getBodyByTpOrderId,
    restoreBodyTpOrder,
    removeBodyTracking,
    // Ladder mode functions
    placeLadderOrders,
    cancelAllLadderOrders,
    getPendingLadderOrders,
    isLadderOrder,
  };
};

module.exports = {
  createOrderExecutor,
};
