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
const { getBaseCurrency } = require('./config-utils');
const { fmtCurrency: fmtPrice, BASIS_POINTS_DIVISOR, isFilledStatus, isCancelledStatus } = require('./shared-utils');
const { placeWithUnknownReconcile } = require('./order-manager');
const { createContextLogger } = require('./logger');

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
 * @param {Function} [callbacks.onEntryCancelled] - Called when an entry order is cancelled (stale timeout, refresh, etc.): (orderId, {filledSize})
 * @param {string} [pair] - Fund pair name (the `data/<exchange>/<pair>/` directory), used to scope durable placement intents; defaults to productId
 * @returns {Object} Order executor instance
 */
const createOrderExecutor = (exchange, config, adapter, productId, callbacks = {}, pair = productId) => {
  const logger = createContextLogger({ exchange, pair: productId });

  /**
   * Describe a placement so order-manager can persist a durable intent for it
   * BEFORE the POST is dispatched, and refuse a second placement on this fund
   * while an earlier one is unresolved — across restarts (#472).
   * @param {string} action - What is being placed, e.g. 'entry_bid'
   * @param {'buy'|'sell'} side - Order side
   * @param {{price?: number, size?: number, sizeUsdc?: number, bodyId?: string, ladderIndex?: number}} [details] - Requested order parameters
   * @returns {{intent: Object}} Options bag for placeWithUnknownReconcile
   */
  const intentFor = (action, side, details = {}) => ({
    intent: { exchange, pair, action, side, ...details },
  });
  /** @type {Map<string, PendingOrder>} */
  const pendingOrders = new Map();
  const baseCurrency = getBaseCurrency(productId);

  let lastTpPrice = 0;
  let lastTpSize = 0;
  let activeTpOrderId = null;
  let staleTimeoutMultiplier = 1.0; // Can be adjusted by regime
  let priceIncrement = 0.01; // Updated via setPriceIncrement from product details

  /** @type {Map<string, {tpOrderId: string, assetQty: number, tpPrice: number}>} */
  const bodyTpOrders = new Map(); // bodyId -> body TP tracking

  /** @type {Map<string, ReturnType<typeof createMutex>>} bodyId -> per-body TP mutex */
  const bodyTpMutexes = new Map();

  /**
   * Acquire the per-body TP mutex, serializing concurrent placeBodyTpOrder/
   * cancelBodyTpOrder calls for the SAME bodyId (a price-driven resize racing
   * a merge/rollup could otherwise place two live TP sells for one body,
   * silently orphaning the older one — the legacy tpMutex above only guards
   * the single-TP-per-executor path, never the per-body path).
   * @param {string} bodyId
   * @returns {Promise<() => void>} Release function
   */
  const acquireBodyTpMutex = async (bodyId) => {
    let mutex = bodyTpMutexes.get(bodyId);
    if (!mutex) {
      mutex = createMutex(TP_MUTEX_DEADLOCK_GUARD_MS);
      bodyTpMutexes.set(bodyId, mutex);
    }
    const release = await mutex.acquire();
    return () => {
      release();
      // Evict once nobody is queued behind us, so the map doesn't grow
      // unboundedly across the celestial hierarchy's full body lifetime.
      if (!mutex.isLocked()) bodyTpMutexes.delete(bodyId);
    };
  };

  /** @type {Map<string, number>} orderId -> last known partial filled size (high-water mark) */
  const partialFillTracker = new Map();

  /** @type {Map<string, string>} tpOrderId -> buyOrderId/bodyId for O(1) reverse lookups */
  const tpOrderToKey = new Map();

  // Track stale order timeouts for cleanup on shutdown
  const staleTimers = new Set();

  /** @type {Map<string, number>} orderId -> settlement timestamp.
   * Distinguishes "we removed this from pendingOrders intentionally" from
   * "this fill is for an order we never tracked." Without this, every
   * polling-backstop fill (which deletes from pendingOrders before routing
   * the fill through the engine, which then runs orderExecutor.handleOrderFill
   * at the end of its chain) fires a misleading "untracked order" warning. */
  const recentlySettled = new Map();
  /** @type {Map<string, number>} orderId -> settlement timestamp, for settled
   * orders the executor itself placed as the legacy core `take_profit`. Lets
   * the engine prove a sell with no owning body was its OWN TP (issue #672)
   * even after the polling backstop / cancel-race path already dropped it
   * from pendingOrders and cleared activeTpOrderId. */
  const recentlySettledTps = new Map();
  const SETTLED_TTL_MS = 5 * 60 * 1000;
  const pruneSettled = (map) => {
    if (map.size > 256) {
      const cutoff = Date.now() - SETTLED_TTL_MS;
      for (const [id, ts] of map) if (ts < cutoff) map.delete(id);
    }
  };
  const markSettled = (orderId, type) => {
    if (!orderId) return;
    recentlySettled.set(orderId, Date.now());
    pruneSettled(recentlySettled);
    if (type === 'take_profit') {
      recentlySettledTps.set(orderId, Date.now());
      pruneSettled(recentlySettledTps);
    }
  };

  // Mutex to serialize concurrent TP updates (prevents duplicate TP sells).
  //
  // The TP critical section in placeTakeProfitOrder can legitimately run for a
  // long time: cancelTpOrder → safeCancelOrder polls up to ~5.5s, and each
  // placeLimitSell has a 30s per-attempt timeout with up to 3 retries + backoff
  // (~127s worst case under a degraded network). The mutex's auto-release is
  // ONLY a last-resort deadlock guard and MUST sit well above that ceiling —
  // at the default 30s it would auto-release mid-section and admit a second
  // concurrent placeTakeProfitOrder, producing two live TP sells for one
  // position (issue #209 B). placeTakeProfitOrder already guarantees release
  // via try/finally, so this timer should essentially never fire.
  const TP_MUTEX_DEADLOCK_GUARD_MS = 5 * 60 * 1000; // 300s, > 2× the ~127s ceiling
  const tpMutex = createMutex(TP_MUTEX_DEADLOCK_GUARD_MS);

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
   *
   * Once the exchange ack's the cancel (success=true), we POLL the order
   * status — we do NOT re-issue the cancel. Re-issuing causes false-negatives
   * on exchanges with eventually-consistent status reads (notably Gemini):
   * the first cancel succeeds server-side, but `getOrder` lags showing OPEN,
   * and a second cancel returns is_cancelled=false because the order is
   * already cancelling — which we'd then misclassify as failure.
   *
   * Total wait budget when ack'd: ~5.5s (verifyDelayMs + 5 × pollDelayMs).
   *
   * `filledSize` is additive (issue #227): callers that need the exact sold
   * quantity of a cancelled-with-partials or filled-during-cancel order can read
   * it directly instead of re-deriving it via a separate `getOrder`. It is 0 on
   * a clean cancel / failure and resolved from the terminal status, falling back
   * to `partialFillTracker`'s high-water mark when the cancel-status response
   * omits the cumulative filled size (e.g. Gemini PARTIALLY_FILLED → CANCELLED).
   *
   * @param {string} orderId - Order ID to cancel
   * @returns {Promise<{cancelled: boolean, filled: boolean, filledSize: number, filledValue?: number, averageFilledPrice?: number, totalFees?: number}>}
   */
  const safeCancelOrder = async (orderId) => {
    const maxAckRetries = 2;
    const verifyDelayMs = 500;
    const pollDelayMs = 1000;
    const maxPollAttempts = 6;

    // Resolve the terminal filled quantity: prefer the status' own filledSize,
    // fall back to the last-known partial high-water mark for this order.
    const resolveFilledSize = (status) => {
      const fromStatus = parseFloat(status?.filledSize);
      if (Number.isFinite(fromStatus) && fromStatus > 0) return fromStatus;
      return partialFillTracker.get(orderId) || 0;
    };

    // Fill details from the status this function already fetched to discover
    // the fill — callers that route a filled-during-cancel order to the fill
    // handler can use these directly instead of re-fetching via a second,
    // redundant adapter.getOrder() call whose own failure would otherwise
    // silently drop the fill (no P&L booked) despite this function already
    // having the data in hand.
    const fillDetails = (status, filledSize) => ({
      filledSize,
      filledValue: parseFloat(status?.filledValue) || 0,
      averageFilledPrice: parseFloat(status?.averageFilledPrice) || 0,
      totalFees: parseFloat(status?.totalFees) || 0,
    });

    for (let attempt = 0; attempt <= maxAckRetries; attempt++) {
      const result = await adapter.cancelOrder(orderId);

      if (!result.success) {
        // Cancel call rejected — check terminal state before deciding to retry
        const status = await adapter.getOrder(orderId).catch(() => null);
        if (isFilledStatus(status)) {
          logger.info(`📋 [${exchange}] Order ${orderId.slice(0, 8)} already filled (discovered during cancel)`, {
            orderId,
            status: status?.status || 'unknown',
          });
          return { cancelled: false, filled: true, ...fillDetails(status, resolveFilledSize(status)) };
        }
        if (status && status.status === 'CANCELLED') {
          return { cancelled: true, filled: false, ...fillDetails(status, resolveFilledSize(status)) };
        }
        if (attempt < maxAckRetries) {
          logger.warn(`⚠️ [${exchange}] Cancel rejected for ${orderId.slice(0, 8)} (status=${status?.status || 'unknown'}) — retrying (${attempt + 1}/${maxAckRetries})`, {
            orderId,
            status: status?.status || 'unknown',
            attempt: attempt + 1,
            maxAttempts: maxAckRetries,
          });
          await new Promise(r => setTimeout(r, pollDelayMs));
          continue;
        }
        logger.error(`🚨 [${exchange}] Cancel rejected for ${orderId.slice(0, 8)} after ${maxAckRetries} retries, status=${status?.status || 'unknown'}`, {
          orderId,
          status: status?.status || 'unknown',
          attempts: maxAckRetries,
        });
        return { cancelled: false, filled: false, filledSize: 0 };
      }

      // Cancel ack'd — poll for the status to actually settle. Do NOT re-cancel.
      for (let poll = 0; poll < maxPollAttempts; poll++) {
        await new Promise(r => setTimeout(r, poll === 0 ? verifyDelayMs : pollDelayMs));
        const verified = await adapter.getOrder(orderId).catch(() => null);

        if (verified?.status === 'CANCELLED') {
          const filledSize = resolveFilledSize(verified);
          if (filledSize > 0) {
            logger.info(`📋 [${exchange}] Order ${orderId.slice(0, 8)} cancelled with ${filledSize} partial fill`, {
              orderId,
              filledSize,
            });
          }
          return { cancelled: true, filled: false, ...fillDetails(verified, filledSize) };
        }
        if (isFilledStatus(verified)) {
          logger.info(`📋 [${exchange}] Order ${orderId.slice(0, 8)} filled between cancel and verify`, {
            orderId,
            status: verified?.status || 'unknown',
          });
          return { cancelled: false, filled: true, ...fillDetails(verified, resolveFilledSize(verified)) };
        }
        // status OPEN, PENDING_CANCEL, null (fetch error), or unknown — keep polling
      }

      logger.error(`🚨 [${exchange}] Cancel ack'd but order ${orderId.slice(0, 8)} never reported CANCELLED after ${maxPollAttempts} polls`, {
        orderId,
        pollAttempts: maxPollAttempts,
      });
      return { cancelled: false, filled: false, filledSize: 0 };
    }

    return { cancelled: false, filled: false, filledSize: 0 };
  };

  /**
   * Place entry bid (maker-prefer post-only)
   * @param {number} sizeUsdc - Order size in USDC
   * @param {number} currentBid - Current best bid
   * @param {number} currentAsk - Current best ask
   * @param {number} [retryCount=0] - Current retry attempt
   * @param {number} [effectiveOffsetBps] - Optional dynamic offset (defaults to config.entryOffsetBps)
   * @param {number} [staleMs] - Optional per-order stale timeout (ATR/offset-adaptive, computed by the engine); defaults to the regime-adjusted global timeout
   * @returns {Promise<{success: boolean, orderId?: string, price?: number, assetQty?: number, errorMessage?: string}>}
   */
  const placeEntryBid = async (sizeUsdc, currentBid, currentAsk, retryCount = 0, effectiveOffsetBps = null, staleMs = null) => {
    // Calculate bid price with offset below current bid (use dynamic offset if provided)
    const offsetBps = effectiveOffsetBps ?? config.entryOffsetBps;
    const offsetMultiplier = 1 - (offsetBps / BASIS_POINTS_DIVISOR);
    let bidPrice = currentBid * offsetMultiplier;

    // Ensure post-only by checking against ask
    if (bidPrice >= currentAsk) {
      bidPrice = currentAsk * 0.999; // Back off to ensure maker
    }

    bidPrice = roundPrice(bidPrice, priceIncrement);
    const assetQty = roundAsset(sizeUsdc / bidPrice);
    const staleSeconds = Math.round((staleMs ?? getEffectiveStaleMs()) / 1000);

    logger.info(`📝 [${exchange}] Placing entry bid: ${assetQty} ${baseCurrency} @ ${fmtPrice(bidPrice)} (size $${sizeUsdc}, offset=${offsetBps}bps, stale=${staleSeconds}s)${retryCount > 0 ? ` [retry ${retryCount}]` : ''}`, {
      orderType: 'entry',
      assetQty,
      baseCurrency,
      bidPrice,
      sizeUsdc,
      offsetBps,
      staleSeconds,
      retryCount,
    });

    // Reconcile an ambiguous 'unknown' outcome by client_order_id (issue #226
    // follow-up) instead of treating a network error as a clean failure — a
    // real entry bid may have reached the exchange despite it.
    const result = await placeWithUnknownReconcile(
      adapter,
      productId,
      () => adapter.placeLimitBuy(productId, assetQty, bidPrice, { postOnly: true }),
      intentFor('entry_bid', 'buy', { price: bidPrice, size: assetQty, sizeUsdc }),
    );

    // An unresolved outcome is NOT a clean failure: a real bid may be resting
    // live on the exchange. Surface it as pending so the engine reports it and
    // stops entering, instead of retrying into a double position.
    if (result.pending) {
      logger.error(`⏸️ [${exchange}] Entry bid outcome unresolved — placements are blocked for this fund until an operator reconciles: ${result.errorMessage}`, {
        orderType: 'entry',
        pending: true,
        intentId: result.intentId ?? result.blockedByIntentId ?? null,
        error: result.errorMessage,
      });
      return { success: false, pending: true, intentId: result.intentId ?? result.blockedByIntentId ?? null, errorMessage: result.errorMessage };
    }

    if (result.success) {
      logger.info(`✅ [${exchange}] Entry bid placed: orderId=${result.orderId} ${assetQty} ${baseCurrency} @ ${fmtPrice(bidPrice)}`, {
        orderId: result.orderId,
        orderType: 'entry',
        assetQty,
        baseCurrency,
        bidPrice,
      });

      // Track first so WS fills/cancels can match even if the verify check below races
      // exchange propagation. Without this, getOrder returning 404 (eventual consistency)
      // or a stale CANCELLED would drop tracking and orphan any later fill.
      pendingOrders.set(result.orderId, {
        type: 'entry',
        price: bidPrice,
        size: assetQty,
        sizeUsdc,
        placedAt: Date.now(),
        staleMs: staleMs ?? null,
      });
      scheduleStaleOrderTimeout(result.orderId, staleMs);

      // Verify order is actually open on exchange (post-only orders can be immediately cancelled).
      // Brief delay lets the order propagate; only treat as cancelled when Coinbase explicitly
      // says so with zero filledSize — a thrown error / null response means "unknown", keep tracking.
      await new Promise(r => setTimeout(r, 750));
      const orderStatus = await adapter.getOrder(result.orderId).catch(() => null);

      if (orderStatus && orderStatus.status === 'CANCELLED' && orderStatus.filledSize === 0) {
        logger.warn(`⚠️ [${exchange}] Order ${result.orderId} was immediately cancelled by exchange`, { orderId: result.orderId });
        pendingOrders.delete(result.orderId);

        const maxRetries = config.entryMaxRetries || 3;
        if (retryCount < maxRetries) {
          logger.info(`🔄 [${exchange}] Retrying with fresh prices (retry ${retryCount + 1}/${maxRetries})`, {
            orderId: result.orderId,
            retryCount: retryCount + 1,
            maxRetries,
          });
          const freshPrices = await adapter.getBidAsk(productId);
          // Preserve the dynamic (momentum-adjusted) offset and adaptive stale
          // timeout across retries — dropping the args silently reverts to
          // config.entryOffsetBps / the global stale timeout.
          return placeEntryBid(sizeUsdc, freshPrices.bid, freshPrices.ask, retryCount + 1, effectiveOffsetBps, staleMs);
        }

        return {
          success: false,
          errorMessage: 'Order immediately cancelled by exchange (post-only)',
        };
      }

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
      logger.info(`🔄 [${exchange}] Post-only rejected (market moved), fetching fresh prices (retry ${retryCount + 1}/${maxRetries})`, {
        orderType: 'entry',
        error: result.errorMessage,
        retryCount: retryCount + 1,
        maxRetries,
      });

      const freshPrices = await adapter.getBidAsk(productId);
      // Preserve the dynamic offset and stale timeout across retries (see note above).
      return placeEntryBid(sizeUsdc, freshPrices.bid, freshPrices.ask, retryCount + 1, effectiveOffsetBps, staleMs);
    }

    logger.error(`❌ [${exchange}] Entry bid failed: ${result.errorMessage || 'unknown error'} (${assetQty} ${baseCurrency} @ ${fmtPrice(bidPrice)})`, {
      orderId: result.orderId,
      error: result.errorMessage || 'unknown error',
      assetQty,
      baseCurrency,
      bidPrice,
    });

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
   * @returns {Promise<{success: boolean, orderId?: string, updated?: boolean, filledDuringCancel?: boolean, filledOrderId?: string, filledSize?: number, filledValue?: number, averageFilledPrice?: number, totalFees?: number, errorMessage?: string}>}
   */
  const placeTakeProfitOrder = async (assetQty, tpPrice, options = {}) => {
    // Serialize concurrent TP updates to prevent duplicate sells.
    // try/finally guarantees release even if cancelTpOrder() or the
    // non-POST_ONLY_REJ rethrow below throws — otherwise the lock leaks and
    // (until the mutex auto-release) every later TP placement stalls.
    const release = await tpMutex.acquire();
    try {
      // Snapshot the TP id we entered the critical section with. If the mutex's
      // deadlock-guard timer ever fired mid-section and admitted a concurrent
      // placeTakeProfitOrder, that section would mutate activeTpOrderId out from
      // under us; we re-read it before placing (below) and abort rather than
      // create a second live TP sell (issue #209 B).
      const entryTpId = activeTpOrderId;

      // Anti-churn: check if price OR size change is significant (skip if forceUpdate)
      if (!options.forceUpdate && entryTpId && lastTpPrice > 0 && lastTpSize > 0) {
        const priceChange = Math.abs(tpPrice - lastTpPrice) / lastTpPrice * 100;
        const sizeChange = Math.abs(assetQty - lastTpSize) / lastTpSize * 100;
        // Update if neither price nor size changed significantly
        if (priceChange < config.tpUpdateThresholdPct && sizeChange < 1) {
          return {
            success: true,
            orderId: entryTpId,
            updated: false, // No update needed
          };
        }
      }

      // Cancel existing TP order if present
      if (entryTpId) {
        const oldTpId = entryTpId;
        const cancelResult = await cancelTpOrder();

        if (cancelResult.filled) {
          // Old TP filled in-flight — abort new TP placement, signal caller.
          // Fill details are already known from the cancel attempt above —
          // pass them through so the caller doesn't need a second,
          // redundant getOrder() call whose own failure would otherwise
          // silently drop this fill (issue #227 follow-up).
          return {
            success: false,
            filledDuringCancel: true,
            filledOrderId: cancelResult.filledOrderId,
            filledSize: cancelResult.filledSize || 0,
            filledValue: cancelResult.filledValue || 0,
            averageFilledPrice: cancelResult.averageFilledPrice || 0,
            totalFees: cancelResult.totalFees || 0,
            errorMessage: `TP ${oldTpId} filled during cancel`,
          };
        }

        if (!cancelResult.cancelled) {
          logger.warn(`⚠️ [${exchange}] Failed to cancel old TP order ${oldTpId}, keeping it tracked to avoid duplicate sells`, { orderId: oldTpId });
          return {
            success: false,
            errorMessage: `Cannot place new TP: failed to cancel existing TP order ${oldTpId}`,
          };
        }
      }

      // Re-read activeTpOrderId under the lock before placing. After our own
      // cancel above nulls it (or it was null on entry), any non-null value
      // that differs from what we entered with means a concurrent section
      // already placed a TP — abort rather than stack a second live sell.
      if (activeTpOrderId && activeTpOrderId !== entryTpId) {
        logger.warn(`⚠️ [${exchange}] activeTpOrderId changed (${entryTpId || 'none'} → ${activeTpOrderId}) during TP placement — aborting to avoid duplicate TP sell`, {
          previousOrderId: entryTpId,
          activeOrderId: activeTpOrderId,
        });
        return {
          success: false,
          errorMessage: `Concurrent TP placement detected (activeTpOrderId=${activeTpOrderId})`,
        };
      }

      const roundedPrice = roundPrice(tpPrice, priceIncrement);
      const roundedQty = roundAsset(assetQty);

      logger.info(`📝 [${exchange}] Placing TP sell: ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)}`, {
        orderType: 'take_profit',
        assetQty: roundedQty,
        baseCurrency,
        price: roundedPrice,
      });

      let result;
      try {
        // Reconcile an ambiguous 'unknown' outcome by client_order_id (issue
        // #226 follow-up) instead of treating a network error as a clean
        // failure — a real TP sell may have reached the exchange despite it.
        result = await placeWithUnknownReconcile(
          adapter,
          productId,
          () => adapter.placeLimitSell(productId, roundedQty, roundedPrice),
          intentFor('take_profit', 'sell', { price: roundedPrice, size: roundedQty }),
        );
      } catch (err) {
        // POST_ONLY_REJ means TP price is below current bid — price already passed TP level.
        // Retry without POST_ONLY so the order fills immediately as a taker.
        if (err.message && err.message.includes('POST_ONLY_REJ')) {
          logger.info(`⚡ [${exchange}] TP price ${fmtPrice(roundedPrice)} below bid — retrying as taker order`, {
            orderType: 'take_profit',
            price: roundedPrice,
            retryMode: 'taker',
          });
          result = await placeWithUnknownReconcile(
            adapter,
            productId,
            () => adapter.placeLimitSell(productId, roundedQty, roundedPrice, { postOnly: false }),
            intentFor('take_profit_taker', 'sell', { price: roundedPrice, size: roundedQty }),
          );
        } else {
          throw err;
        }
      }

      if (result.success) {
        logger.info(`✅ [${exchange}] TP sell placed: orderId=${result.orderId} ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)}`, {
          orderId: result.orderId,
          orderType: 'take_profit',
          assetQty: roundedQty,
          baseCurrency,
          price: roundedPrice,
        });
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
    } finally {
      release();
    }
  };

  /**
   * Cancel take-profit order using safeCancelOrder to detect in-flight fills
   * @returns {Promise<{cancelled: boolean, filled: boolean, filledSize: number, filledOrderId?: string, filledValue?: number, averageFilledPrice?: number, totalFees?: number}>}
   */
  const cancelTpOrder = async () => {
    if (!activeTpOrderId) return { cancelled: true, filled: false, filledSize: 0 };

    const orderToCancel = activeTpOrderId;
    const result = await safeCancelOrder(orderToCancel);

    if (result.cancelled) {
      logger.info(`🗑️ [${exchange}] Cancelled TP order: ${orderToCancel}`, {
        orderId: orderToCancel,
        orderType: 'take_profit',
        filledSize: result.filledSize || 0,
      });
      pendingOrders.delete(orderToCancel);
      activeTpOrderId = null;
      lastTpSize = 0;
      return { cancelled: true, filled: false, filledSize: result.filledSize || 0 };
    }

    if (result.filled) {
      logger.info(`📋 [${exchange}] TP order ${orderToCancel.slice(0, 8)} filled during cancel attempt`, {
        orderId: orderToCancel,
        orderType: 'take_profit',
        filledSize: result.filledSize || 0,
      });
      pendingOrders.delete(orderToCancel);
      markSettled(orderToCancel, 'take_profit');
      activeTpOrderId = null;
      lastTpSize = 0;
      return {
        cancelled: false,
        filled: true,
        filledSize: result.filledSize || 0,
        filledOrderId: orderToCancel,
        filledValue: result.filledValue || 0,
        averageFilledPrice: result.averageFilledPrice || 0,
        totalFees: result.totalFees || 0,
      };
    }

    logger.warn(`⚠️ [${exchange}] Cancel TP failed for ${orderToCancel}: unknown state`, { orderId: orderToCancel, status: 'unknown' });
    return { cancelled: false, filled: false, filledSize: 0 };
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
   * Settle a cancelled order detected via polling. If it had any partial
   * fills, route them through onFillDetected so the regime engine ingests
   * them before we drop the order from tracking (Gemini has no order-events
   * WS backstop). Uses partialFillTracker's high-water mark when the
   * cancel-status response doesn't carry cumulative filledSize.
   * @param {string} orderId
   * @param {Object} order Pending order entry (provides type, placedAt)
   * @param {Object} status Adapter getOrder result
   * @param {string} context Log prefix label ('Stale check', 'Refresh', 'Fill check')
   */
  const handleCancelledOrder = async (orderId, order, status, context) => {
    const trackedPartial = partialFillTracker.get(orderId) || 0;
    const filledSize = status.filledSize || trackedPartial;
    logger.info(`⏰ [${exchange}] ${context} found cancelled ${order.type} order ${orderId}${filledSize > 0 ? ` (with ${filledSize} partial fill)` : ''}`, {
      orderId,
      orderType: order.type,
      status: status.status || 'CANCELLED',
      reconciliationContext: context,
      filledSize,
    });
    // Drop tracking BEFORE awaiting the fill callback below — not after. A
    // concurrent sweep (another checkPendingOrderFills pass, or a second
    // stale timer) reads `pendingOrders` synchronously; if
    // this order were still in it while we `await` a slow fill/TP-placement
    // callback, that concurrent pass could re-discover the same "cancelled"
    // order and re-run this same booking a second time. Clearing state here
    // matches this function's original (pre-#674) synchronous timing, which
    // never awaited the callback and so always cleared immediately.
    pendingOrders.delete(orderId);
    partialFillTracker.delete(orderId);
    // Pass filledSize along so a consumer (regime-engine.js) can tell a
    // genuinely empty cancel (safe to retire immediately) apart from one that
    // is about to be routed through onFillDetected below — issue #673: the
    // regime engine's own retry for that fill can still fail, and a consumer
    // that purges its saved-order bookkeeping unconditionally here would
    // orphan a real fill before its outcome is even known, with nothing left
    // to rediscover it.
    if (order.type === 'entry' || order.type === 'ladder_entry') callbacks.onEntryCancelled?.(orderId, { filledSize });
    if (filledSize > 0 && callbacks.onFillDetected) {
      markSettled(orderId, order.type);
      // Await the fill callback (async in live mode) before returning. Most
      // callers fire-and-forget this (they have no synchronous continuation
      // that depends on ledger state), but cancelAllLadderOrders is awaited
      // directly by resetCycle/rebuildLadder/cancelLadder, which immediately
      // reset cycle state and call fillLedger.startNewCycle() afterward — if
      // the fill's ledger ingestion (which stamps the CURRENT cycleId at
      // ingest time) hasn't completed yet, it would be silently attributed to
      // the new cycle instead of the one it actually belongs to (issue #674
      // review finding). Making this awaitable, while every existing
      // fire-and-forget caller keeps working unchanged, closes that race.
      await callbacks.onFillDetected(orderId, { ...status, filledSize, placedAt: order.placedAt, isPartialFill: true });
    }
  };

  /**
   * Schedule stale order timeout for entry order
   * Uses the per-order adaptive timeout when provided (already ATR-scaled, so
   * the regime multiplier is deliberately NOT applied on top of it), otherwise
   * orderStaleMs * staleTimeoutMultiplier for regime-aware timeout
   * @param {string} orderId - Order ID to check
   * @param {number} [staleMsOverride] - Per-order adaptive timeout in ms
   */
  const scheduleStaleOrderTimeout = (orderId, staleMsOverride = null) => {
    const staleMs = staleMsOverride ?? getEffectiveStaleMs();
    const timer = setTimeout(() => {
      staleTimers.delete(timer);
      const order = pendingOrders.get(orderId);
      if (!order || order.type !== 'entry') return;

      adapter.getOrder(orderId)
        .then(status => {
          // Normalize status to uppercase for comparison
          const normalizedStatus = (status.status || '').toUpperCase();

          if (isFilledStatus(status)) {
            // Order filled but WebSocket missed it - notify regime engine
            logger.info(`✅ [${exchange}] Stale check detected filled order ${orderId} (WebSocket missed)`, {
              orderId,
              orderType: order.type,
              status: status.status || 'FILLED',
              reconciliationContext: 'Stale check',
            });
            // Capture placedAt BEFORE deleting from pendingOrders
            const placedAt = order.placedAt;
            pendingOrders.delete(orderId);
            markSettled(orderId, order.type);
            if (callbacks.onFillDetected) {
              callbacks.onFillDetected(orderId, { ...status, placedAt });
            }
          } else if (normalizedStatus === 'CANCELLED') {
            handleCancelledOrder(orderId, order, status, 'Stale check');
          } else if (normalizedStatus === 'OPEN' && status.completionPercentage === 0) {
            // Not filled at all (as of this snapshot) — cancel. Use safeCancelOrder
            // instead of a raw adapter.cancelOrder: the exchange refuses a cancel
            // when the order already filled, and a fill (full or partial) can also
            // land while the cancel is in flight. Either race must be routed
            // through the fill handlers instead of silently dropping the order
            // from tracking (issue #674, mirrors handleCancelledOrder's other
            // callers). Entry orders are always buy-side.
            logger.info(`⏰ [${exchange}] Stale order timeout, cancelling unfilled order ${orderId}`, {
              orderId,
              orderType: order.type,
              status: normalizedStatus,
              staleMs,
            });
            return safeCancelOrder(orderId).then(result => {
              const details = {
                filledSize: result.filledSize || 0,
                filledValue: result.filledValue || 0,
                averageFilledPrice: result.averageFilledPrice || 0,
                totalFees: result.totalFees || 0,
              };
              if (result.filled) {
                logger.info(`📋 [${exchange}] Order ${orderId.slice(0, 8)} filled during stale-timeout cancel`, {
                  orderId,
                  orderType: order.type,
                  filledSize: details.filledSize,
                });
                const placedAt = order.placedAt;
                pendingOrders.delete(orderId);
                partialFillTracker.delete(orderId);
                markSettled(orderId, order.type);
                if (callbacks.onFillDetected) {
                  callbacks.onFillDetected(orderId, { status: 'FILLED', side: 'buy', ...details, placedAt });
                }
                return;
              }
              if (result.cancelled) {
                handleCancelledOrder(orderId, order, { status: 'CANCELLED', side: 'buy', ...details }, 'Stale check');
                return;
              }
              // Neither filled nor cancelled (ack'd but never settled, or the
              // cancel call itself errored) — keep it tracked so the polling
              // backstop (checkPendingOrderFills) can still catch it.
              logger.warn(`⚠️ [${exchange}] Stale order cancel for ${orderId} left in unknown state — keeping tracked for polling backstop`, { orderId });
            }).catch(err => logger.error(`❌ [${exchange}] Stale order cancel failed for ${orderId}: ${err.message}`, { orderId, error: err.message }));
          }
          // Partially filled orders are left alone - WebSocket should handle incremental fills
        })
        .catch(err => {
          logger.error(`❌ [${exchange}] Stale order check failed for ${orderId}: ${err.message}`, { orderId, error: err.message });
        });
    }, staleMs);
    staleTimers.add(timer);
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
    let polled = 0; // count of order-status round-trips that actually succeeded

    for (const [orderId, order] of pendingOrders) {
      const status = await adapter.getOrder(orderId).catch(() => null);
      if (!status) continue;
      polled++; // a non-null status proves the order-status REST path is alive

      const normalizedStatus = (status.status || '').toUpperCase();

      if (isFilledStatus(status)) {
        logger.info(`✅ [${exchange}] Fill check detected filled ${order.type} order ${orderId}`, {
          orderId,
          orderType: order.type,
          status: status.status || 'FILLED',
          reconciliationContext: 'Fill check',
        });
        const placedAt = order.placedAt;
        pendingOrders.delete(orderId);
        markSettled(orderId, order.type);
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
          logger.info(`📦 [${exchange}] Fill check detected partial fill on ${order.type} order ${orderId}: ${status.filledSize} filled (was ${lastPartialSize})`, {
            orderId,
            orderType: order.type,
            status: normalizedStatus,
            filledSize: status.filledSize,
            previousFilledSize: lastPartialSize,
            reconciliationContext: 'Fill check',
          });
          partialFillTracker.set(orderId, status.filledSize);
          if (callbacks.onFillDetected) {
            callbacks.onFillDetected(orderId, { ...status, placedAt, isPartialFill: true });
          }
        }
      } else if (isCancelledStatus(status)) {
        // Match isCancelledStatus's full CANCELLED/CANCELED/EXPIRED/FAILED
        // set, not a literal 'CANCELLED' string — Gemini normalizes any
        // off-book, not-explicitly-cancelled order to EXPIRED (see
        // shared-utils.js). A narrower check here left an order the reconcile
        // sweep re-armed via restorePendingOrder() after a failed catch-up
        // (issue #673) permanently unpolled once its status came back
        // EXPIRED/FAILED: tracked (so the sweep no longer saw it as an
        // orphan) but never revisited by this loop either.
        handleCancelledOrder(orderId, order, status, 'Fill check');
        cancelled++;
      }
    }

    return { filled, cancelled, polled };
  };

  /**
   * Cancel all entry orders (for SAFE mode)
   *
   * All three adapters resolve `{success:false}` (they do NOT reject) when the
   * exchange refuses a cancel — the canonical reason being that the order
   * already filled. A refused cancel therefore must NOT be treated as a
   * successful cancel: before dropping tracking we query the order and route
   * any fill through `onFillDetected` (mirroring safeCancelOrder /
   * handleCancelledOrder), otherwise the polling backstop never sees the fill
   * and on Gemini (no order-events WS) the bought asset stays invisible until
   * the next restart's catch-up (issue #209 A).
   *
   * Continues on individual failures so every order is attempted.
   * @returns {Promise<number>} Number of orders actually cancelled
   */
  const cancelAllEntries = async () => {
    let cancelled = 0;
    let filled = 0;
    let failed = 0;

    const entryOrders = Array.from(pendingOrders.entries())
      .filter(([, order]) => order.type === 'entry');

    const results = await Promise.allSettled(
      entryOrders.map(([orderId]) => adapter.cancelOrder(orderId))
    );

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const [orderId, order] = entryOrders[index];

      // A thrown cancel (rejected) OR an exchange refusal (resolved
      // {success:false}) both mean the cancel did not take.
      const refused = result.status === 'rejected' || !result.value?.success;

      if (!refused) {
        // The exchange acknowledged the cancel ({success:true}), but every
        // adapter's cancelOrder response carries only that boolean — never a
        // filledSize — so an ack alone does not guarantee zero fill. A rung
        // can still partially (or, rarely with eventual consistency, fully)
        // fill in the race window right before the cancel takes (the same
        // race safeCancelOrder itself guards against by polling after an
        // ack'd cancel). Verify the terminal state before dropping tracking,
        // mirroring the refused-cancel branch below exactly — including its
        // isFilledStatus check first, and letting handleCancelledOrder's own
        // partialFillTracker fallback apply when this getOrder response
        // omits filledSize for a genuinely-partial cancel (issue #674 Fix
        // step 1).
        const cancelledStatus = typeof adapter.getOrder === 'function'
          ? await adapter.getOrder(orderId).catch(() => null)
          : null;

        if (isFilledStatus(cancelledStatus)) {
          logger.info(`📋 [${exchange}] Entry order ${orderId.slice(0, 8)} fully filled (discovered after a successful SAFE-mode cancel ack)`, {
            orderId,
            orderType: order.type,
            status: cancelledStatus.status || 'FILLED',
            reconciliationContext: 'SAFE-mode cancel',
          });
          const placedAt = order.placedAt;
          pendingOrders.delete(orderId);
          partialFillTracker.delete(orderId);
          markSettled(orderId, order.type);
          if (callbacks.onFillDetected) {
            await callbacks.onFillDetected(orderId, { ...cancelledStatus, placedAt });
          }
          filled++;
        } else if (cancelledStatus) {
          // Cleanly cancelled (possibly with partial fills) — the shared
          // handler routes any partial through onFillDetected before
          // dropping tracking, falling back to partialFillTracker's
          // high-water mark if this response omits filledSize.
          await handleCancelledOrder(orderId, order, cancelledStatus, 'SAFE-mode cancel');
          cancelled++;
        } else {
          // Could not verify (no getOrder on this adapter, or it failed) —
          // trust the ack, same as every other "can't verify" fallback here.
          pendingOrders.delete(orderId);
          partialFillTracker.delete(orderId);
          cancelled++;
        }
        continue;
      }

      if (result.status === 'rejected') {
        logger.warn(`⚠️ [${exchange}] Cancel threw for entry order ${orderId}: ${result.reason?.message || 'unknown'}`, {
          orderId,
          error: result.reason?.message || 'unknown',
        });
      }

      // Refused cancel — inspect terminal state before dropping tracking.
      const status = await adapter.getOrder(orderId).catch(() => null);

      if (isFilledStatus(status)) {
        logger.info(`📋 [${exchange}] Entry order ${orderId.slice(0, 8)} already filled (discovered during SAFE-mode cancel) — routing fill`, {
          orderId,
          orderType: order.type,
          status: status.status || 'FILLED',
          reconciliationContext: 'SAFE-mode cancel',
        });
        const placedAt = order.placedAt;
        pendingOrders.delete(orderId);
        partialFillTracker.delete(orderId);
        markSettled(orderId, order.type);
        if (callbacks.onFillDetected) {
          callbacks.onFillDetected(orderId, { ...status, placedAt });
        }
        filled++;
        continue;
      }

      const normalizedStatus = (status?.status || '').toUpperCase();
      if (normalizedStatus === 'CANCELLED') {
        // Cleanly cancelled (possibly with partial fills) — the shared handler
        // routes any partial through onFillDetected before dropping tracking.
        handleCancelledOrder(orderId, order, status, 'SAFE-mode cancel');
        cancelled++;
        continue;
      }

      // OPEN / PENDING / unknown / null — the cancel genuinely did not take and
      // the order may still be live. Keep it tracked so the polling backstop
      // (checkPendingOrderFills) can still catch a later fill; do NOT delete.
      failed++;
      logger.warn(`⚠️ [${exchange}] Entry order ${orderId} not cancelled (status=${normalizedStatus || 'unknown'}) — keeping tracked for polling backstop`, {
        orderId,
        status: normalizedStatus || 'unknown',
      });
    }

    logger.info(`🚫 [${exchange}] Cancelled ${cancelled} entry orders${filled > 0 ? ` (${filled} filled during cancel)` : ''}${failed > 0 ? ` (${failed} failed, still tracked)` : ''}`, {
      orderType: 'entry',
      cancelled,
      filled,
      failed,
    });
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
      markSettled(orderId, order.type);

      if (order.type === 'take_profit') {
        activeTpOrderId = null;
        lastTpPrice = 0;
        lastTpSize = 0;
      } else if (order.type === 'body_tp') {
        removeBodyTracking(orderId);
      }
    } else if (!recentlySettled.has(orderId)) {
      // Genuine orphan: the order isn't in pendingOrders AND we have no
      // record of recently settling it (polling backstop, stale-cancel,
      // or engine restart paths all stamp `recentlySettled`).
      logger.error(`🚨 [${exchange}] WS fill for untracked order ${orderId} — likely orphan (check audit-fills.js)`, { orderId, orphan: true });
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
   * @returns {{entries: number, ladderEntries: number, takeProfits: number, bodies: number, total: number}}
   */
  const getPendingCounts = () => {
    let entries = 0;
    let ladderEntries = 0;
    let takeProfits = 0;
    let bodies = 0;

    for (const order of pendingOrders.values()) {
      if (order.type === 'entry') entries++;
      else if (order.type === 'ladder_entry') ladderEntries++;
      else if (order.type === 'take_profit') takeProfits++;
      else if (order.type === 'body_tp') bodies++;
    }

    return { entries, ladderEntries, takeProfits, bodies, total: pendingOrders.size };
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
   * Get active TP order ID
   * @returns {string|null}
   */
  const getActiveTpOrderId = () => activeTpOrderId;

  /**
   * Whether `orderId` is (or recently was) the legacy core take-profit this
   * executor placed — pending as `take_profit`, the current activeTpOrderId, or
   * settled as a `take_profit` within SETTLED_TTL_MS. The engine uses this to
   * refuse closing a cycle on a foreign sell (manual/DCA/script) that merely
   * shares the product (issue #672).
   * @param {string} orderId
   * @returns {boolean}
   */
  const isTrackedTpOrder = (orderId) => {
    if (!orderId) return false;
    if (orderId === activeTpOrderId) return true;
    if (pendingOrders.get(orderId)?.type === 'take_profit') return true;
    const ts = recentlySettledTps.get(orderId);
    return ts !== undefined && Date.now() - ts < SETTLED_TTL_MS;
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
    const release = await acquireBodyTpMutex(bodyId);
    try {
      const roundedPrice = roundPrice(tpPrice, priceIncrement);
      const roundedQty = roundAsset(assetQty);

      logger.info(`📝 [${exchange}] Placing body TP: ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)} (body=${bodyId.slice(-8)})`, {
        bodyId,
        orderType: 'body_tp',
        assetQty: roundedQty,
        baseCurrency,
        price: roundedPrice,
      });

      // Body TPs should not use post_only — when market reaches TP price, the order must fill.
      // Reconcile an ambiguous 'unknown' outcome by client_order_id (issue #226
      // follow-up) instead of treating a network error as a clean failure.
      const result = await placeWithUnknownReconcile(
        adapter,
        productId,
        () => adapter.placeLimitSell(productId, roundedQty, roundedPrice, { postOnly: false }),
        intentFor('body_tp', 'sell', { price: roundedPrice, size: roundedQty, bodyId }),
      );

      if (result.success) {
        logger.info(`✅ [${exchange}] Body TP placed: orderId=${result.orderId} ${roundedQty} ${baseCurrency} @ ${fmtPrice(roundedPrice)} (body=${bodyId.slice(-8)})`, {
          bodyId,
          orderId: result.orderId,
          orderType: 'body_tp',
          assetQty: roundedQty,
          baseCurrency,
          price: roundedPrice,
        });
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
    } finally {
      release();
    }
  };

  /**
   * Cancel a specific body TP order.
   *
   * `cancelled` confirms cancellation; `filled` denotes the fully-filled outcome,
   * not whether any asset sold. `filledSize` is known cumulative execution,
   * including a prior polling high-water mark when terminal size is omitted.
   * Value, average price, and fees accompany cancelled execution for immediate
   * booking; optional fields remain absent on other outcomes.
   *
   * Body-TP postconditions (not the legacy cancelTpOrder wrapper): cancellation
   * removes pendingOrders, tpOrderToKey, and bodyTpOrders tracking, so callers
   * must handle any executed tranche immediately instead of waiting for polling.
   * A fully-filled outcome removes the body mappings but retains pendingOrders
   * for polling to process the fill. An unresolved outcome retains all tracking.
   * @param {string} bodyId - Celestial body ID
   * @param {string} [fallbackOrderId] - Order ID to cancel if body isn't in executor tracking
   * @returns {Promise<{cancelled: boolean, filled: boolean, filledSize: number, filledValue?: number, averageFilledPrice?: number, totalFees?: number}>}
   */
  const cancelBodyTpOrder = async (bodyId, fallbackOrderId) => {
    const release = await acquireBodyTpMutex(bodyId);
    try {
      const body = bodyTpOrders.get(bodyId);
      const orderToCancel = body?.tpOrderId || fallbackOrderId;

      if (!orderToCancel) {
        // No tracking AND no fallback — nothing to cancel
        return { cancelled: true, filled: false, filledSize: 0 };
      }

      if (!body && fallbackOrderId) {
        logger.warn(`⚠️ [${exchange}] Body ${bodyId.slice(-8)} not in executor tracking, using fallback orderId ${fallbackOrderId.slice(0, 8)} for cancel`, {
          bodyId,
          orderId: fallbackOrderId,
        });
      }

      const result = await safeCancelOrder(orderToCancel);
      if (result.cancelled) {
        pendingOrders.delete(orderToCancel);
        tpOrderToKey.delete(orderToCancel);
        bodyTpOrders.delete(bodyId);
        // filledSize > 0 here means the TP partially filled during the cancel —
        // surfaced (issue #227) so the merge path can react to the sold tranche.
        // filledValue/averageFilledPrice/totalFees ride along too (issue #227
        // follow-up) so a caller that needs to book this fill immediately
        // (rather than hoping a future WS/poll event finds it, when tracking
        // for this order has just been fully removed above) has everything
        // needed without a redundant re-fetch.
        return {
          cancelled: true,
          filled: false,
          filledSize: result.filledSize || 0,
          filledValue: result.filledValue || 0,
          averageFilledPrice: result.averageFilledPrice || 0,
          totalFees: result.totalFees || 0,
        };
      }
      if (result.filled) {
        tpOrderToKey.delete(orderToCancel);
        bodyTpOrders.delete(bodyId);
        // Leave in pendingOrders for polling to process the fill
        return { cancelled: false, filled: true, filledSize: result.filledSize || 0 };
      }
      return { cancelled: false, filled: false, filledSize: 0 };
    } finally {
      release();
    }
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
   * Map a durable placement intent's action onto the pendingOrders `type` the
   * rest of the executor (fill routing, stale refresh, cancel-all) keys off.
   */
  const INTENT_ORDER_TYPES = Object.freeze({
    entry_bid: 'entry',
    entry_replacement: 'entry',
    ladder_entry: 'ladder_entry',
    take_profit: 'take_profit',
    take_profit_taker: 'take_profit',
    take_profit_replacement: 'take_profit',
    body_tp: 'body_tp',
  });

  /**
   * Adopt an exchange order that an operator matched back to an unresolved
   * placement intent, putting it under normal tracking and fill processing as
   * if the original placement had acknowledged.
   *
   * Adoption is idempotent: an order id already tracked is reported as such and
   * never registered twice (the intent row is what makes it exactly-once, but a
   * duplicate here would double-count a fill, so it is refused outright).
   * @param {{orderId: string, price?: number, size?: number}} order - Order found on the exchange
   * @param {{action?: string, price?: number, size?: number, sizeUsdc?: number, bodyId?: string, ladderIndex?: number, createdAt?: number}} intent - The intent it satisfies
   * @returns {{tracked: boolean, message: string}} What was done
   */
  const adoptPlacement = (order, intent) => {
    const orderId = order?.orderId;
    if (!orderId) return { tracked: false, message: 'Exchange order carried no order id — nothing to adopt' };
    if (pendingOrders.has(orderId)) {
      return { tracked: false, message: `Order ${orderId} is already tracked — intent cleared, nothing further to adopt` };
    }

    const type = INTENT_ORDER_TYPES[intent?.action];
    if (!type) {
      return { tracked: false, message: `Intent action '${intent?.action ?? 'unknown'}' has no tracked order type — intent cleared; verify the order on the exchange` };
    }

    const price = intent?.price ?? order?.price ?? 0;
    const size = intent?.size ?? order?.size ?? 0;
    const placedAt = intent?.createdAt ?? Date.now();

    if (type === 'body_tp') {
      if (!intent?.bodyId) {
        return { tracked: false, message: `Body TP intent carried no bodyId — intent cleared; cancel ${orderId} on the exchange if it is a duplicate` };
      }
      restoreBodyTpOrder(intent.bodyId, orderId, size, price, placedAt);
      return { tracked: true, message: `Adopted body TP ${orderId} for body ${intent.bodyId}` };
    }

    restorePendingOrder(orderId, {
      type,
      price,
      size,
      sizeUsdc: intent?.sizeUsdc ?? size * price,
      placedAt,
      ...(intent?.ladderIndex === undefined ? {} : { ladderIndex: intent.ladderIndex }),
    });
    return { tracked: true, message: `Adopted ${type} order ${orderId} into tracking` };
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
      // Reconcile an ambiguous 'unknown' outcome by client_order_id (issue
      // #226 follow-up) instead of treating a network error as a clean
      // failure — a real ladder entry may have reached the exchange despite it.
      const result = await placeWithUnknownReconcile(
        adapter,
        productId,
        () => adapter.placeLimitBuy(productId, level.assetQty, level.price, { postOnly: true }),
        intentFor('ladder_entry', 'buy', { price: level.price, size: level.assetQty, sizeUsdc: level.sizeUsdc, ladderIndex: level.index }),
      ).catch(err => {
        // A thrown reconcile is NOT a clean failure — folding it into
        // {success:false} here is what let the next rung (and the next tick)
        // place against an order that may already be live (#472). The durable
        // intent is already on disk; mark the result pending and stop the loop.
        const unresolved = err?.status === 'unknown' || err?.unknownOutcome === true || err?.placementPending === true;
        logger[unresolved ? 'error' : 'warn'](`${unresolved ? '⏸️' : '⚠️'} [${exchange}] ${unresolved ? 'Unresolved' : 'Error'} placing ladder order at $${level.price}: ${err.message}`, {
          price: level.price,
          pending: unresolved,
          error: err.message,
        });
        return { success: false, pending: unresolved, errorMessage: err.message };
      });

      // Stop the ladder immediately on an unresolved placement: every later
      // rung would be refused by order-manager anyway, and continuing would
      // report them as ordinary failures the engine is free to retry.
      if (result.pending) {
        logger.error(`⏸️ [${exchange}] Ladder halted at level ${level.index} — placement unresolved, operator reconcile required: ${result.errorMessage}`, {
          ladderIndex: level.index,
          pending: true,
          placed: results.length,
          error: result.errorMessage,
        });
        return { orders: results, failedCount: levels.length - results.length, pending: true, errorMessage: result.errorMessage };
      }

      if (result.success) {
        // Verify order is actually open (post-only can be immediately cancelled)
        const orderStatus = await adapter.getOrder(result.orderId).catch(() => null);

        // Only treat as immediately cancelled when we positively know it's cancelled.
        // If we failed to fetch status (null), track the order and let later refresh reconcile.
        if (orderStatus && orderStatus.status === 'CANCELLED') {
          logger.warn(`⚠️ [${exchange}] Ladder order at $${level.price} was immediately cancelled`, { orderId: result.orderId, price: level.price });
          failedCount++;
          continue;
        }

        if (!orderStatus) {
          logger.warn(`⚠️ [${exchange}] Could not verify ladder order at $${level.price}, tracking it for reconciliation`, { orderId: result.orderId, price: level.price });
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
        logger.warn(`⚠️ [${exchange}] Failed to place ladder order at $${level.price}: ${result.errorMessage}`, { price: level.price, error: result.errorMessage });
        failedCount++;
      }

      // Rate limit between orders
      await sleep(100);
    }

    return { orders: results, failedCount };
  };

  /**
   * Cancel all unfilled ladder orders
   *
   * A cancel that the exchange honors (`result.cancelled`) can still carry a
   * partial fill that landed in the race window before the cancel took
   * (`result.filledSize > 0`) — a bare `pendingOrders.delete` would drop that
   * bought asset with no body and no TP (issue #674). Route it through the
   * same `handleCancelledOrder` path the other cancel call sites use, which
   * books the fill via `onFillDetected` before dropping tracking. Ladder
   * entries are always buy-side.
   *
   * `partialFillOrderIds` / `partialFillsCost` report what those mid-cancel
   * bookings bought (issue #711): the quote spent (filledValue + fees, the
   * same cost the body's costBasis carries) lets rebuildLadder keep its
   * exchange-balance clamp honest without re-fetching, and the order IDs let
   * callers reason about which buys landed inside their own sweep.
   * `unbookedFills` lists the rungs that filled COMPLETELY before their
   * cancel took, with their spend: those stay tracked for polling to book
   * later, so no body carries their cost yet — the caller must reserve it
   * itself (per order, so it can skip one polling booked in the meantime).
   * Both costs cover only what was not already booked as an earlier partial
   * (the tracker's high-water mark): an earlier tranche is already in a
   * body's costBasis and in the caller's balance snapshot.
   * @returns {Promise<{cancelled: number, remainingTracked: number, partialFills: number, partialFillOrderIds: string[], partialFillsCost: number, unbookedFills: Array<{orderId: string, cost: number}>}>} Cancel results
   */
  const cancelAllLadderOrders = async () => {
    let cancelled = 0;
    let partialFills = 0;
    const partialFillOrderIds = [];
    let partialFillsCost = 0;
    const unbookedFills = [];

    // Quote spent by the part of a cancel-time fill not already booked as a
    // partial. Read before handleCancelledOrder, which clears the tracker.
    const newFillCost = (orderId, result) => {
      const filledSize = Number(result.filledSize) || 0;
      const alreadyBooked = Math.min(partialFillTracker.get(orderId) || 0, filledSize);
      const newShare = filledSize > 0 ? (filledSize - alreadyBooked) / filledSize : 1;
      return ((Number(result.filledValue) || 0) + (Number(result.totalFees) || 0)) * newShare;
    };

    const ladderOrders = Array.from(pendingOrders.entries())
      .filter(([, order]) => order.type === 'ladder_entry');

    for (const [orderId, order] of ladderOrders) {
      const result = await safeCancelOrder(orderId).catch(() => ({ cancelled: false, filled: false }));
      if (result.cancelled) {
        if (result.filledSize > 0) {
          const cost = newFillCost(orderId, result);
          // Await the booking. resetCycle/rebuildLadder/cancelLadder all
          // await this whole function then immediately reset cycle state and
          // call fillLedger.startNewCycle() — an un-awaited fire-and-forget
          // here could let that cycle turnover race the fill's ledger
          // ingestion (which stamps the CURRENT cycleId), silently
          // attributing this buy to the new cycle instead of the one it
          // actually belongs to (issue #674 review finding).
          // NOTE: this serializes fill-booking (which can place a TP order,
          // with retries) behind each partially-filled rung, one at a time —
          // correctness over speed is the right tradeoff here (a lost fill is
          // much worse than a slower cancel sweep), but multiple partial
          // fills in one sweep will extend however long the caller's own
          // critical section (e.g. resetCycle's fill-gate) stays held.
          await handleCancelledOrder(orderId, order, {
            status: 'CANCELLED',
            side: 'buy',
            filledSize: result.filledSize,
            filledValue: result.filledValue || 0,
            averageFilledPrice: result.averageFilledPrice || 0,
            totalFees: result.totalFees || 0,
          }, 'Ladder cancel');
          partialFills++;
          partialFillOrderIds.push(orderId);
          partialFillsCost += cost;
        } else {
          pendingOrders.delete(orderId);
          partialFillTracker.delete(orderId);
        }
        cancelled++;
      } else if (result.filled) {
        unbookedFills.push({ orderId, cost: newFillCost(orderId, result) });
        logger.info(`📋 [${exchange}] Ladder order ${orderId.slice(0, 8)} filled during cancel — polling will process`, {
          orderId,
          orderType: 'ladder_entry',
          filledSize: result.filledSize || 0,
        });
      } else {
        logger.warn(`⚠️ [${exchange}] Failed to cancel ladder order ${orderId.slice(0, 8)}`, { orderId });
      }
    }

    const remainingTracked = Array.from(pendingOrders.values())
      .filter(o => o.type === 'ladder_entry').length;

    return { cancelled, remainingTracked, partialFills, partialFillOrderIds, partialFillsCost, unbookedFills };
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
    capabilities: {
      liveReconciliation: true,
    },
    placeEntryBid,
    placeTakeProfitOrder,
    cancelTpOrder,
    cancelAllEntries,
    handleOrderFill,
    handleOrderCancel,
    /** Mark an orderId as intentionally settled so a subsequent
     * `handleOrderFill(orderId)` no-op cleanup doesn't fire the
     * "untracked order — likely orphan" warning. Use from offline-recovery
     * paths in regime-engine.js where pendingOrders never had the order
     * (engine restart cleared it; the saved order filled while offline). */
    markSettled,
    getPendingCounts,
    getPendingEntries,
    getPendingOrdersList,
    getActiveTpOrderId,
    isTrackedTpOrder,
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
    isBodyTpOrder,
    getBodyByTpOrderId,
    restoreBodyTpOrder,
    removeBodyTracking,
    adoptPlacement,
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
