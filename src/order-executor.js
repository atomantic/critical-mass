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

const { roundAsset, roundPrice } = require('./volatility-utils');
const { createMutex } = require('./async-mutex');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').PendingOrder} PendingOrder
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 */

/**
 * Format a price with appropriate decimal places
 * @param {number} p - Price value
 * @returns {string} Formatted price string
 */
const fmtPrice = (p) => {
  if (p == null || isNaN(p)) return '-';
  if (Math.abs(p) >= 100) return `$${p.toFixed(2)}`;
  if (Math.abs(p) >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(5)}`;
};

/**
 * Create order executor instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @param {string} productId - Product to trade
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onFillDetected] - Called when fill is detected via polling: (orderId, orderStatus)
 * @param {Function} [callbacks.onEntryCancelled] - Called when an entry order is cancelled (stale timeout, refresh, etc.): (orderId)
 * @returns {Object} Order executor instance
 */
const createOrderExecutor = (exchange, config, adapter, productId, callbacks = {}) => {
  /** @type {Map<string, PendingOrder>} */
  const pendingOrders = new Map();
  const baseCurrency = productId.replace('_', '-').split('-')[0];

  let lastCancelTime = 0;
  let lastTpPrice = 0;
  let lastTpSize = 0;
  let activeTpOrderId = null;
  let staleTimeoutMultiplier = 1.0; // Can be adjusted by regime
  let priceIncrement = 0.01; // Updated via setPriceIncrement from product details

  /** @type {Map<string, {tpOrderId: string, assetQty: number, tpPrice: number}>} */
  const bodyTpOrders = new Map(); // bodyId -> body TP tracking

  /** @type {Map<string, number>} orderId -> last known partial filled size (high-water mark) */
  const partialFillTracker = new Map();

  /** @type {Map<string, string>} tpOrderId -> buyOrderId/bodyId for O(1) reverse lookups */
  const tpOrderToKey = new Map();

  // Track stale order timeouts for cleanup on shutdown
  const staleTimers = new Set();

  // Mutex to serialize concurrent TP updates (prevents duplicate TP sells)
  const tpMutex = createMutex();

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
    const maxRetries = 2;
    const verifyDelayMs = 500;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await adapter.cancelOrder(orderId);

      if (!result.success) {
        // Cancel call itself failed — check if already filled or cancelled
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
      }

      // Cancel reported success — verify the order is actually cancelled
      await new Promise(r => setTimeout(r, verifyDelayMs));
      const verified = await adapter.getOrder(orderId).catch(() => null);

      if (verified?.status === 'CANCELLED') {
        return { cancelled: true, filled: false };
      }
      if (verified?.status === 'FILLED' || verified?.completionPercentage >= 100) {
        console.log(`📋 [${exchange}] Order ${orderId.slice(0, 8)} filled between cancel and verify`);
        return { cancelled: false, filled: true };
      }
      if (verified?.status === 'OPEN' && attempt < maxRetries) {
        console.log(`⚠️ [${exchange}] Cancel ack'd but order ${orderId.slice(0, 8)} still OPEN — retrying (${attempt + 1}/${maxRetries})`);
        continue;
      }

      // Retries exhausted or unexpected status
      if (verified?.status === 'OPEN') {
        console.log(`🚨 [${exchange}] Cancel verification failed for ${orderId.slice(0, 8)} — still OPEN after ${maxRetries} retries`);
        return { cancelled: false, filled: false };
      }

      // Verified status is null/unknown but cancel said success — trust it
      return { cancelled: true, filled: false };
    }

    return { cancelled: false, filled: false };
  };

  /**
   * Place entry bid (maker-prefer post-only)
   * @param {number} sizeUsdc - Order size in USDC
   * @param {number} currentBid - Current best bid
   * @param {number} currentAsk - Current best ask
   * @param {number} [retryCount=0] - Current retry attempt
   * @param {number} [effectiveOffsetBps] - Optional dynamic offset (defaults to config.entryOffsetBps)
   * @returns {Promise<{success: boolean, orderId?: string, price?: number, assetQty?: number, errorMessage?: string}>}
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

    bidPrice = roundPrice(bidPrice, priceIncrement);
    const assetQty = roundAsset(sizeUsdc / bidPrice);

    console.log(`📝 [${exchange}] Placing entry bid: ${assetQty} ${baseCurrency} @ ${fmtPrice(bidPrice)} (size $${sizeUsdc})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}`);

    const result = await adapter.placeLimitBuy(productId, assetQty, bidPrice, { postOnly: true });

    if (result.success) {
      console.log(`✅ [${exchange}] Entry bid placed: orderId=${result.orderId} ${assetQty} ${baseCurrency} @ ${fmtPrice(bidPrice)}`);
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
        size: assetQty,
        sizeUsdc,
        placedAt: Date.now(),
      });

      // Schedule stale order timeout check
      scheduleStaleOrderTimeout(result.orderId);

      return {
        success: true,
        orderId: result.orderId,
        price: bidPrice,
        assetQty,
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
   * Place or update take-profit sell order (mutex-serialized)
   * @param {number} assetQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {Object} [options] - Options
   * @param {boolean} [options.forceUpdate] - Bypass anti-churn (use after buy fills)
   * @returns {Promise<{success: boolean, orderId?: string, updated?: boolean, filledDuringCancel?: boolean, filledOrderId?: string, errorMessage?: string}>}
   */
  const placeTakeProfitOrder = async (assetQty, tpPrice, options = {}) => {
    // Serialize concurrent TP updates to prevent duplicate sells
    const release = await tpMutex.acquire();

    // Anti-churn: check if price OR size change is significant (skip if forceUpdate)
    if (!options.forceUpdate && activeTpOrderId && lastTpPrice > 0 && lastTpSize > 0) {
      const priceChange = Math.abs(tpPrice - lastTpPrice) / lastTpPrice * 100;
      const sizeChange = Math.abs(assetQty - lastTpSize) / lastTpSize * 100;
      // Update if neither price nor size changed significantly
      if (priceChange < config.tpUpdateThresholdPct && sizeChange < 1) {
        release();
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
      const cancelResult = await cancelTpOrder();

      if (cancelResult.filled) {
        // Old TP filled in-flight — abort new TP placement, signal caller
        release();
        return {
          success: false,
          filledDuringCancel: true,
          filledOrderId: cancelResult.filledOrderId,
          errorMessage: `TP ${oldTpId} filled during cancel`,
        };
      }

      if (!cancelResult.cancelled) {
        console.log(`⚠️ [${exchange}] Failed to cancel old TP order ${oldTpId}, keeping it tracked to avoid duplicate sells`);
        release();
        return {
          success: false,
          errorMessage: `Cannot place new TP: failed to cancel existing TP order ${oldTpId}`,
        };
      }
    }

    const roundedPrice = roundPrice(tpPrice, priceIncrement);
    const roundedQty = roundAsset(assetQty);

    console.log(`📝 [${exchange}] Placing TP sell: ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)}`);

    let result;
    try {
      result = await adapter.placeLimitSell(productId, roundedQty, roundedPrice);
    } catch (err) {
      // POST_ONLY_REJ means TP price is below current bid — price already passed TP level.
      // Retry without POST_ONLY so the order fills immediately as a taker.
      if (err.message && err.message.includes('POST_ONLY_REJ')) {
        console.log(`⚡ [${exchange}] TP price ${fmtPrice(roundedPrice)} below bid — retrying as taker order`);
        result = await adapter.placeLimitSell(productId, roundedQty, roundedPrice, { postOnly: false });
      } else {
        throw err;
      }
    }

    if (result.success) {
      console.log(`✅ [${exchange}] TP sell placed: orderId=${result.orderId} ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)}`);
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

      release();
      return {
        success: true,
        orderId: result.orderId,
        updated: true,
      };
    }

    release();
    return {
      success: false,
      errorMessage: result.errorMessage || 'TP order placement failed',
    };
  };

  /**
   * Cancel take-profit order using safeCancelOrder to detect in-flight fills
   * @returns {Promise<{cancelled: boolean, filled: boolean, filledOrderId?: string}>}
   */
  const cancelTpOrder = async () => {
    if (!activeTpOrderId) return { cancelled: true, filled: false };

    const orderToCancel = activeTpOrderId;
    const result = await safeCancelOrder(orderToCancel);

    if (result.cancelled) {
      console.log(`🗑️ [${exchange}] Cancelled TP order: ${orderToCancel}`);
      pendingOrders.delete(orderToCancel);
      activeTpOrderId = null;
      lastTpSize = 0;
      return { cancelled: true, filled: false };
    }

    if (result.filled) {
      console.log(`📋 [${exchange}] TP order ${orderToCancel.slice(0, 8)} filled during cancel attempt`);
      pendingOrders.delete(orderToCancel);
      activeTpOrderId = null;
      lastTpSize = 0;
      return { cancelled: false, filled: true, filledOrderId: orderToCancel };
    }

    console.log(`⚠️ [${exchange}] Cancel TP failed for ${orderToCancel}: unknown state`);
    return { cancelled: false, filled: false };
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
    const timer = setTimeout(() => {
      staleTimers.delete(timer);
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
            callbacks.onEntryCancelled?.(orderId);
          } else if (normalizedStatus === 'OPEN' && status.completionPercentage === 0) {
            // Not filled at all, cancel
            console.log(`⏰ [${exchange}] Stale order timeout, cancelling unfilled order ${orderId}`);
            return adapter.cancelOrder(orderId).then(() => {
              pendingOrders.delete(orderId);
              callbacks.onEntryCancelled?.(orderId);
            });
          }
          // Partially filled orders are left alone - WebSocket should handle incremental fills
        })
        .catch(err => {
          console.log(`❌ [${exchange}] Stale order check failed for ${orderId}: ${err.message}`);
        });
    }, staleMs);
    staleTimers.add(timer);
  };

  /**
   * Refresh stale orders (cancel unfilled, rate-limited)
   * @returns {Promise<number>} Number of orders refreshed
   */
  const refreshStaleOrders = async () => {
    const now = Date.now();
    let refreshed = 0;

    const isPersistentType = (type) => type === 'take_profit' || type === 'body_tp' || type === 'ladder_entry';
    const effectiveStaleMs = getEffectiveStaleMs();
    for (const [orderId, order] of pendingOrders) {
      // Check if order is stale (using regime-adjusted timeout)
      if (now - order.placedAt > effectiveStaleMs) {
        // Rate limit cancels (only relevant for non-persistent orders)
        if (!isPersistentType(order.type) && now - lastCancelTime < config.cancelRateLimitMs) {
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
          if (order.type === 'entry' || order.type === 'ladder_entry') callbacks.onEntryCancelled?.(orderId);
          refreshed++;
        } else if (normalizedStatus === 'OPEN' && status.completionPercentage === 0 && !isPersistentType(order.type)) {
          // Only cancel stale reactive ENTRY orders — TP and ladder orders should persist until filled
          await adapter.cancelOrder(orderId);
          lastCancelTime = now;
          pendingOrders.delete(orderId);
          callbacks.onEntryCancelled?.(orderId);
          refreshed++;
        }
      }
    }

    return refreshed;
  };

  /**
   * Check all pending orders for fills (backup fill detection)
   * Call this periodically to catch fills that WebSocket missed
   * Checks entries, take_profit, and body_tp orders
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
        partialFillTracker.delete(orderId);
        if (callbacks.onFillDetected) {
          callbacks.onFillDetected(orderId, { ...status, placedAt });
        }
        filled++;
      } else if (normalizedStatus === 'PARTIALLY_FILLED' && status.filledSize > 0) {
        // Partial fill detected — notify handler with partial flag so body state can be updated
        // Keep order in pendingOrders since it's still open on the exchange
        const lastPartialSize = partialFillTracker.get(orderId) || 0;
        if (status.filledSize > lastPartialSize) {
          const placedAt = order.placedAt;
          console.log(`📦 [${exchange}] Fill check detected partial fill on ${order.type} order ${orderId}: ${status.filledSize} filled (was ${lastPartialSize})`);
          partialFillTracker.set(orderId, status.filledSize);
          if (callbacks.onFillDetected) {
            callbacks.onFillDetected(orderId, { ...status, placedAt, isPartialFill: true });
          }
        }
      } else if (normalizedStatus === 'CANCELLED') {
        console.log(`⏰ [${exchange}] Fill check found cancelled ${order.type} order ${orderId}`);
        pendingOrders.delete(orderId);
        partialFillTracker.delete(orderId);
        if (order.type === 'entry' || order.type === 'ladder_entry') callbacks.onEntryCancelled?.(orderId);
        cancelled++;
      }
    }

    return { filled, cancelled };
  };

  /**
   * Atomic order replacement (cancel then place)
   * @param {string} oldOrderId - Order to cancel
   * @param {Object} newOrderParams - New order parameters
   * @param {number} newOrderParams.assetQty - BTC quantity
   * @param {number} newOrderParams.price - Price
   * @param {'entry' | 'take_profit'} newOrderParams.type - Order type
   * @returns {Promise<{success: boolean, newOrderId?: string, reason?: string}>}
   */
  const atomicReplace = async (oldOrderId, newOrderParams) => {
    // Step 1: Cancel old order
    await adapter.cancelOrder(oldOrderId);

    // Step 2: Wait for cancel confirmation
    let confirmed = false;
    let filledDuringCancel = false;
    for (let i = 0; i < 5; i++) {
      const status = await adapter.getOrder(oldOrderId);
      if (status.status === 'CANCELLED') {
        confirmed = true;
        break;
      }
      if (status.status === 'FILLED') {
        filledDuringCancel = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // If old order filled during cancel, do NOT place a new order (would create a naked sell)
    if (filledDuringCancel) {
      console.log(`📋 [${exchange}] atomicReplace: old order ${oldOrderId.slice(0, 8)} filled during cancel, aborting replacement`);
      pendingOrders.delete(oldOrderId);
      return { success: false, reason: 'filled_during_cancel', filledDuringCancel: true };
    }

    if (!confirmed) {
      return { success: false, reason: 'cancel_not_confirmed' };
    }

    // Step 3: Remove from internal state
    pendingOrders.delete(oldOrderId);

    // Step 4: Place new order
    const { assetQty, price, type } = newOrderParams;

    if (type === 'entry') {
      const result = await adapter.placeLimitBuy(productId, assetQty, price, { postOnly: true });
      if (result.success) {
        pendingOrders.set(result.orderId, {
          type: 'entry',
          price,
          size: assetQty,
          sizeUsdc: assetQty * price,
          placedAt: Date.now(),
        });
        return { success: true, newOrderId: result.orderId };
      }
    } else {
      const result = await adapter.placeLimitSell(productId, assetQty, price);
      if (result.success) {
        activeTpOrderId = result.orderId;
        lastTpPrice = price;
        lastTpSize = assetQty;
        pendingOrders.set(result.orderId, {
          type: 'take_profit',
          price,
          size: assetQty,
          sizeUsdc: assetQty * price,
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
      } else if (order.type === 'body_tp') {
        removeBodyTracking(orderId);
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
      } else if (order.type === 'body_tp') {
        removeBodyTracking(orderId);
      }
    }
  };

  /**
   * Get pending orders count by type
   * @returns {{entries: number, takeProfits: number, bodies: number, total: number}}
   */
  const getPendingCounts = () => {
    let entries = 0;
    let takeProfits = 0;
    let bodies = 0;

    for (const order of pendingOrders.values()) {
      if (order.type === 'entry') entries++;
      else if (order.type === 'take_profit') takeProfits++;
      else if (order.type === 'body_tp') bodies++;
    }

    return { entries, takeProfits, bodies, total: pendingOrders.size };
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
      filledSize: partialFillTracker.get(orderId) || 0,
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
    let summary = `pending=${counts.total}(entries=${counts.entries},tp=${counts.takeProfits},body=${counts.bodies})`;

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
    partialFillTracker.clear();
    activeTpOrderId = null;
    lastTpPrice = 0;
    lastTpSize = 0;
    bodyTpOrders.clear();
    tpOrderToKey.clear();
    for (const t of staleTimers) clearTimeout(t);
    staleTimers.clear();
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
    // body_tp orders are restored via restoreBodyTpOrder
  };

  // ============================================================================
  // Body TP Functions (celestial hierarchy)
  // ============================================================================

  /**
   * Place a body TP sell order (celestial hierarchy)
   * @param {number} assetQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {string} bodyId - Celestial body ID
   * @returns {Promise<{success: boolean, orderId?: string, errorMessage?: string}>}
   */
  const placeBodyTpOrder = async (assetQty, tpPrice, bodyId) => {
    const roundedPrice = roundPrice(tpPrice, priceIncrement);
    const roundedQty = roundAsset(assetQty);

    console.log(`📝 [${exchange}] Placing body TP: ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)} (body=${bodyId.slice(-8)})`);

    // Body TPs should not use post_only — when market reaches TP price, the order must fill
    const result = await adapter.placeLimitSell(productId, roundedQty, roundedPrice, { postOnly: false });

    if (result.success) {
      console.log(`✅ [${exchange}] Body TP placed: orderId=${result.orderId} ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)} (body=${bodyId.slice(-8)})`);
      bodyTpOrders.set(bodyId, {
        tpOrderId: result.orderId,
        assetQty: roundedQty,
        tpPrice: roundedPrice,
      });
      tpOrderToKey.set(result.orderId, bodyId);

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
      tpOrderToKey.delete(body.tpOrderId);
      bodyTpOrders.delete(bodyId);
      return { cancelled: true, filled: false };
    }
    if (result.filled) {
      tpOrderToKey.delete(body.tpOrderId);
      bodyTpOrders.delete(bodyId);
      // Leave in pendingOrders for polling to process the fill
      return { cancelled: false, filled: true };
    }
    return { cancelled: false, filled: false };
  };

  /**
   * Cancel all body TP orders
   * @returns {Promise<number>} Number cancelled
   */
  const cancelAllBodyTpOrders = async () => {
    let cancelled = 0;
    const entries = Array.from(bodyTpOrders.entries());

    for (const [bodyId, body] of entries) {
      const result = await safeCancelOrder(body.tpOrderId).catch(() => ({ cancelled: false, filled: false }));
      if (result.cancelled) {
        pendingOrders.delete(body.tpOrderId);
        cancelled++;
      } else if (result.filled) {
        console.log(`📋 [${exchange}] Body TP ${body.tpOrderId.slice(0, 8)} filled during bulk cancel`);
      }
      tpOrderToKey.delete(body.tpOrderId);
      bodyTpOrders.delete(bodyId);
    }

    return cancelled;
  };

  /**
   * Check if an order ID is a body TP order
   * @param {string} orderId - Exchange order ID to check
   * @returns {boolean}
   */
  const isBodyTpOrder = (orderId) => tpOrderToKey.has(orderId);

  /**
   * Get body tracking info by TP order ID
   * @param {string} tpOrderId - Exchange sell order ID
   * @returns {{bodyId: string, assetQty: number, tpPrice: number}|null}
   */
  const getBodyByTpOrderId = (tpOrderId) => {
    const bodyId = tpOrderToKey.get(tpOrderId);
    if (!bodyId) return null;
    const body = bodyTpOrders.get(bodyId);
    return body ? { bodyId, ...body } : null;
  };

  /**
   * Restore body TP order tracking (for recovery)
   * @param {string} bodyId - Body ID
   * @param {string} tpOrderId - Exchange sell order ID
   * @param {number} assetQty - BTC quantity
   * @param {number} tpPrice - TP price
   * @param {number} [placedAt] - Original placement timestamp (ms), defaults to now
   */
  const restoreBodyTpOrder = (bodyId, tpOrderId, assetQty, tpPrice, placedAt) => {
    bodyTpOrders.set(bodyId, { tpOrderId, assetQty, tpPrice });
    tpOrderToKey.set(tpOrderId, bodyId);

    pendingOrders.set(tpOrderId, {
      type: 'body_tp',
      price: tpPrice,
      size: assetQty,
      sizeUsdc: assetQty * tpPrice,
      placedAt: placedAt || Date.now(),
    });
  };

  /**
   * Remove body tracking after fill or cancel
   * @param {string} tpOrderId - Exchange sell order ID that was filled/cancelled
   */
  const removeBodyTracking = (tpOrderId) => {
    const bodyId = tpOrderToKey.get(tpOrderId);
    if (bodyId) {
      bodyTpOrders.delete(bodyId);
      tpOrderToKey.delete(tpOrderId);
      pendingOrders.delete(tpOrderId);
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
   * @param {Array<{index: number, price: number, sizeUsdc: number, assetQty: number}>} levels - Ladder levels
   * @returns {Promise<{orders: Array<{orderId: string, index: number, price: number, sizeUsdc: number, assetQty: number}>, failedCount: number}>}
   */
  const placeLadderOrders = async (levels) => {
    const results = [];
    let failedCount = 0;

    for (const level of levels) {
      const result = await adapter.placeLimitBuy(productId, level.assetQty, level.price, { postOnly: true }).catch(err => {
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
          size: level.assetQty,
          sizeUsdc: level.sizeUsdc,
          ladderIndex: level.index,
          placedAt: Date.now(),
        });

        results.push({
          orderId: result.orderId,
          ladderIndex: level.index,
          price: level.price,
          sizeUsdc: level.sizeUsdc,
          assetQty: level.assetQty,
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
    // Body TP functions (celestial hierarchy)
    placeBodyTpOrder,
    cancelBodyTpOrder,
    cancelAllBodyTpOrders,
    isBodyTpOrder,
    getBodyByTpOrderId,
    restoreBodyTpOrder,
    removeBodyTracking,
    // Ladder mode functions
    placeLadderOrders,
    cancelAllLadderOrders,
    getPendingLadderOrders,
    isLadderOrder,
    // Timer cleanup
    clearTimers: () => { for (const t of staleTimers) clearTimeout(t); staleTimers.clear(); },
    // Price precision
    setPriceIncrement: (inc) => { priceIncrement = inc; },
  };
};

module.exports = {
  createOrderExecutor,
};
