// @ts-check
/**
 * Dry-Run Order Executor
 *
 * Simulates order placement and fills for testing the regime engine
 * against live market data without placing real orders.
 *
 * Features:
 * - Tracks hypothetical orders with simulated IDs
 * - Simulates fills based on market price movement
 * - Maintains decision log for analysis
 * - Calculates hypothetical P&L
 */

const { roundBTC, roundPrice } = require('./volatility-utils');

/**
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 * @typedef {import('./types').PendingOrder} PendingOrder
 */

/**
 * @typedef {Object} SimulatedOrder
 * @property {string} orderId - Simulated order ID
 * @property {'entry' | 'take_profit' | 'satellite_tp' | 'body_tp'} type - Order type
 * @property {'buy' | 'sell'} side - Order side
 * @property {number} price - Limit price
 * @property {number} size - Size in BTC
 * @property {number} sizeUsdc - Size in USDC
 * @property {number} placedAt - Timestamp when placed
 * @property {'open' | 'filled' | 'cancelled'} status - Order status
 * @property {number|null} filledAt - Timestamp when filled
 * @property {number|null} fillPrice - Actual fill price
 */

/**
 * @typedef {Object} DecisionLogEntry
 * @property {number} timestamp - Decision timestamp
 * @property {'entry_placed' | 'entry_filled' | 'entry_cancelled' | 'tp_placed' | 'tp_filled' | 'tp_cancelled' | 'entry_blocked'} action - Action type
 * @property {string} regime - Current regime
 * @property {number} price - Market price at decision
 * @property {Object} details - Additional details
 */

let orderIdCounter = 0;

/**
 * Generate simulated order ID
 * @returns {string}
 */
const generateOrderId = () => {
  orderIdCounter++;
  return `DRY-${Date.now()}-${orderIdCounter}`;
};

/**
 * Set order ID counter (for state restoration)
 * @param {number} value - Counter value
 */
const setOrderIdCounter = (value) => {
  orderIdCounter = value;
};

/**
 * Get order ID counter (for state export)
 * @returns {number}
 */
const getOrderIdCounter = () => orderIdCounter;

/**
 * Create dry-run order executor instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Configuration
 * @param {Object} marketStateRef - Reference to market state (for simulating fills)
 * @param {Object} [callbacks] - Event callbacks
 * @param {Function} [callbacks.onBuyFill] - Called when buy order fills: (orderId, btcQty, price, costBasis)
 * @param {Function} [callbacks.onSellFill] - Called when sell order fills: (orderId, btcQty, price, proceeds, pnl)
 * @returns {Object} Dry-run order executor instance
 */
const createDryRunExecutor = (exchange, config, marketStateRef, callbacks = {}) => {
  /** @type {Map<string, SimulatedOrder>} */
  const pendingOrders = new Map();

  /** @type {DecisionLogEntry[]} */
  const decisionLog = [];

  /** @type {SimulatedOrder[]} */
  const filledOrders = [];

  let lastTpPrice = 0;
  let lastTpSize = 0;
  let activeTpOrderId = null;

  /** @type {Map<string, {tpOrderId: string, btcQty: number, tpPrice: number, costBasis: number}>} */
  const satelliteTpOrders = new Map(); // buyOrderId -> satellite tracking (legacy alias)
  const bodyTpOrders = satelliteTpOrders; // Celestial body TP tracking (same Map, new name)

  // Satellite simulated P&L tracking
  let simulatedSatelliteRealizedPnL = 0;
  let simulatedSatelliteRealizedBtcPnL = 0;

  // Simulated P&L tracking
  let simulatedRealizedPnL = 0;
  let simulatedRealizedBtcPnL = 0;
  let simulatedTotalBought = 0;
  let simulatedTotalSold = 0;

  // Optimal TP tracking
  /** @type {{entryPrice: number, entryTime: number, maxPrice: number, maxPriceTime: number, minPrice: number}|null} */
  let currentCycleTracking = null;

  /** @type {Array<{entryPrice: number, exitPrice: number, maxPrice: number, minPrice: number, optimalTpPct: number, actualTpPct: number, missedProfitPct: number, timeToMax: number, cycleNumber: number}>} */
  const cycleAnalytics = [];

  /**
   * Log a decision
   * @param {DecisionLogEntry['action']} action - Action type
   * @param {string} regime - Current regime
   * @param {number} price - Market price
   * @param {Object} details - Additional details
   */
  const logDecision = (action, regime, price, details) => {
    const entry = {
      timestamp: Date.now(),
      action,
      regime,
      price,
      details,
    };
    decisionLog.push(entry);

    // Keep log size manageable (last 1000 entries)
    if (decisionLog.length > 1000) {
      decisionLog.shift();
    }
  };

  /**
   * Place entry bid (simulated)
   * @param {number} sizeUsdc - Order size in USDC
   * @param {number} currentBid - Current best bid
   * @param {number} currentAsk - Current best ask
   * @param {number} [retryCount=0] - Current retry attempt (unused in dry-run, for API compatibility)
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
      bidPrice = currentAsk * 0.999;
    }

    bidPrice = roundPrice(bidPrice);
    const btcQty = roundBTC(sizeUsdc / bidPrice);

    const orderId = generateOrderId();

    const order = {
      orderId,
      type: 'entry',
      side: 'buy',
      price: bidPrice,
      size: btcQty,
      sizeUsdc,
      placedAt: Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    };

    pendingOrders.set(orderId, order);

    logDecision('entry_placed', 'N/A', currentBid, {
      orderId,
      bidPrice,
      btcQty,
      sizeUsdc,
      offsetBps,
    });

    console.log(`🧪 [${exchange}] [DRY-RUN] Entry bid placed: ${btcQty} BTC @ $${bidPrice} (size $${sizeUsdc}) offset=${offsetBps}bps`);

    // Entry fills are checked continuously via checkEntryFills() called from regime engine

    return {
      success: true,
      orderId,
      price: bidPrice,
      btcQty,
    };
  };

  /**
   * Place or update take-profit sell order (simulated)
   * @param {number} btcQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {string} [regime] - Current regime for logging
   * @returns {Promise<{success: boolean, orderId?: string, updated?: boolean, errorMessage?: string}>}
   */
  const placeTakeProfitOrder = async (btcQty, tpPrice, regime = 'UNKNOWN') => {
    // Anti-churn: check if price OR size change is significant
    if (activeTpOrderId && lastTpPrice > 0 && lastTpSize > 0) {
      const priceChange = Math.abs(tpPrice - lastTpPrice) / lastTpPrice * 100;
      const sizeChange = Math.abs(btcQty - lastTpSize) / lastTpSize * 100;
      // Update if neither price nor size changed significantly
      if (priceChange < config.tpUpdateThresholdPct && sizeChange < 1) {
        return {
          success: true,
          orderId: activeTpOrderId,
          updated: false,
        };
      }
    }

    // Cancel existing TP order if present
    if (activeTpOrderId) {
      await cancelTpOrder();
    }

    const roundedPrice = roundPrice(tpPrice);
    const roundedQty = roundBTC(btcQty);

    const orderId = generateOrderId();

    const order = {
      orderId,
      type: 'take_profit',
      side: 'sell',
      price: roundedPrice,
      size: roundedQty,
      sizeUsdc: roundedQty * roundedPrice,
      placedAt: Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    };

    pendingOrders.set(orderId, order);
    activeTpOrderId = orderId;
    lastTpPrice = roundedPrice;
    lastTpSize = roundedQty;

    logDecision('tp_placed', regime, marketStateRef.lastPrice || 0, {
      orderId,
      tpPrice: roundedPrice,
      btcQty: roundedQty,
    });

    console.log(`🧪 [${exchange}] [DRY-RUN] TP sell placed: ${roundedQty} BTC @ $${roundedPrice}`);

    return {
      success: true,
      orderId,
      updated: true,
    };
  };

  /**
   * Cancel take-profit order (simulated)
   * @returns {Promise<boolean>}
   */
  const cancelTpOrder = async () => {
    if (!activeTpOrderId) return true;

    const order = pendingOrders.get(activeTpOrderId);
    if (order) {
      order.status = 'cancelled';
      logDecision('tp_cancelled', 'N/A', marketStateRef.lastPrice || 0, {
        orderId: activeTpOrderId,
      });
    }

    pendingOrders.delete(activeTpOrderId);
    activeTpOrderId = null;
    lastTpSize = 0;
    return true;
  };

  /**
   * Check all pending entry orders for fills based on current price
   * Also cancels stale entries that haven't filled within orderStaleMs
   * Called periodically from regime engine alongside checkTpFills
   * @param {number} currentPrice - Current market price
   */
  const checkEntryFills = (currentPrice) => {
    if (!currentPrice) return;

    const now = Date.now();

    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'entry' && order.side === 'buy' && order.status === 'open') {
        // Entry fills if price drops to or below our bid level (with small tolerance for spread)
        if (currentPrice <= order.price * 1.001) {
          simulateFill(orderId, order.price);
        } else if (now - order.placedAt > config.orderStaleMs) {
          // Cancel stale entries that haven't filled
          order.status = 'cancelled';
          pendingOrders.delete(orderId);
          logDecision('entry_cancelled', 'N/A', currentPrice, {
            orderId,
            reason: 'stale_order',
            ageMs: now - order.placedAt,
          });
          console.log(`🧪 [${exchange}] [DRY-RUN] Entry cancelled (stale after ${Math.round((now - order.placedAt) / 1000)}s): ${orderId}`);
        }
      }
    }
  };

  /**
   * Check if any TP orders should fill based on current price
   * Also tracks price extremes for optimal TP analysis
   * Called periodically from regime engine
   * @param {number} currentPrice - Current market price
   */
  const checkTpFills = (currentPrice) => {
    // Update price tracking for optimal TP analysis
    if (currentCycleTracking && currentPrice > 0) {
      if (currentPrice > currentCycleTracking.maxPrice) {
        currentCycleTracking.maxPrice = currentPrice;
        currentCycleTracking.maxPriceTime = Date.now();
      }
      if (currentPrice < currentCycleTracking.minPrice) {
        currentCycleTracking.minPrice = currentPrice;
      }
    }

    for (const [orderId, order] of pendingOrders) {
      if ((order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp') && order.status === 'open') {
        // TP fills if price reaches or exceeds our ask
        if (currentPrice >= order.price) {
          simulateFill(orderId, order.price);
        }
      }
    }
  };

  /**
   * Simulate a fill
   * @param {string} orderId - Order ID
   * @param {number} fillPrice - Fill price
   */
  const simulateFill = (orderId, fillPrice) => {
    const order = pendingOrders.get(orderId);
    if (!order) return;

    order.status = 'filled';
    order.filledAt = Date.now();
    order.fillPrice = fillPrice;

    // Note: Don't push to filledOrders yet - we need to add P&L data first for TP orders
    pendingOrders.delete(orderId);

    if (order.type === 'entry') {
      simulatedTotalBought += order.size;

      // Post-only limit orders have 0% maker fees on Coinbase Advanced Trade
      const estimatedFee = 0;
      const costBasis = (order.size * fillPrice) + estimatedFee;

      // Store cost basis on order for UI display
      order.costBasis = costBasis;

      // Start or update cycle tracking for optimal TP analysis
      if (!currentCycleTracking) {
        currentCycleTracking = {
          entryPrice: fillPrice,
          entryTime: Date.now(),
          maxPrice: fillPrice,
          maxPriceTime: Date.now(),
          minPrice: fillPrice,
        };
      } else {
        // Update weighted average entry price for multi-entry cycles
        const prevTotal = currentCycleTracking.entryPrice * (simulatedTotalBought - order.size);
        const newTotal = prevTotal + (fillPrice * order.size);
        currentCycleTracking.entryPrice = newTotal / simulatedTotalBought;
      }

      logDecision('entry_filled', 'N/A', fillPrice, {
        orderId,
        btcQty: order.size,
        fillPrice,
        costBasis,
        totalBought: simulatedTotalBought,
      });
      console.log(`🧪 [${exchange}] [DRY-RUN] Entry FILLED: ${order.size} BTC @ $${fillPrice}`);

      // Push to filled orders after all data is populated
      filledOrders.push({ ...order });

      // Notify callback for position update
      if (callbacks.onBuyFill) {
        callbacks.onBuyFill(orderId, order.size, fillPrice, costBasis);
      }
    } else if (order.type === 'satellite_tp' || order.type === 'body_tp') {
      simulatedTotalSold += order.size;

      // Look up satellite/body tracking info for cost basis
      const satelliteInfo = getBodyByTpOrderId(orderId) || getSatelliteByTpOrderId(orderId);
      const avgBuyPrice = satelliteInfo ? (satelliteInfo.costBasis / satelliteInfo.btcQty) : getAverageEntryPrice();
      const costBasis = order.size * avgBuyPrice;
      const proceeds = order.size * fillPrice;
      const pnl = proceeds - costBasis;
      simulatedSatelliteRealizedPnL += pnl;

      const holdbackRatio = config.holdbackRatio ?? 0.5;
      const profitPerBTC = fillPrice - avgBuyPrice;
      const denominator = fillPrice * (1 - holdbackRatio) + avgBuyPrice * holdbackRatio;
      const holdbackBtc = denominator > 0 ? order.size * profitPerBTC * holdbackRatio / denominator : 0;
      simulatedSatelliteRealizedBtcPnL += holdbackBtc;

      order.pnl = pnl;
      order.holdbackBtc = holdbackBtc;
      order.avgCostBasis = avgBuyPrice;
      order.isSatellite = true;

      filledOrders.push({ ...order });

      logDecision('tp_filled', 'N/A', fillPrice, {
        orderId,
        btcQty: order.size,
        fillPrice,
        pnl,
        isSatellite: true,
      });
      console.log(`🧪 [${exchange}] [DRY-RUN] Satellite TP FILLED: ${order.size} BTC @ $${fillPrice}, PnL=$${pnl.toFixed(2)}`);

      // Remove satellite/body tracking
      removeBodyTracking(orderId);
      removeSatelliteTracking(orderId);

      // Notify callback for position update
      if (callbacks.onSellFill) {
        callbacks.onSellFill(orderId, order.size, fillPrice, proceeds, pnl);
      }
    } else if (order.type === 'take_profit') {
      simulatedTotalSold += order.size;

      // Calculate simulated P&L for this TP
      const proceeds = order.size * fillPrice;
      // Post-only limit orders have 0% maker fees on Coinbase Advanced Trade
      const estimatedFee = 0;
      const netProceeds = proceeds - estimatedFee;

      // Estimate cost basis from filled orders
      const avgBuyPrice = getAverageEntryPrice();
      const costBasis = order.size * avgBuyPrice;
      const pnl = netProceeds - costBasis;
      simulatedRealizedPnL += pnl;

      // Calculate profit-based BTC holdback for this cycle
      // holdbackQty = sellQty * (price - cost) * ratio / (price * (1 - ratio) + cost * ratio)
      const holdbackRatio = config.holdbackRatio ?? 0.5;
      const profitPerBTC = fillPrice - avgBuyPrice;
      const denominator = fillPrice * (1 - holdbackRatio) + avgBuyPrice * holdbackRatio;
      const holdbackBtc = denominator > 0 ? order.size * profitPerBTC * holdbackRatio / denominator : 0;
      const holdbackValue = holdbackBtc * fillPrice;
      simulatedRealizedBtcPnL += holdbackBtc;

      // Calculate USDC profit (this is what grows the capital)
      const usdcProfit = order.size * profitPerBTC;

      // Store P&L data on the order for UI display
      order.pnl = pnl;
      order.holdbackBtc = holdbackBtc;
      order.holdbackValue = holdbackValue;
      order.usdcProfit = usdcProfit;
      order.avgCostBasis = avgBuyPrice;

      // Push to filled orders after all data is populated
      filledOrders.push({ ...order });

      logDecision('tp_filled', 'N/A', fillPrice, {
        orderId,
        btcQty: order.size,
        fillPrice,
        pnl,
        holdbackBtc,
        holdbackValue,
        usdcProfit,
        totalRealizedPnL: simulatedRealizedPnL,
      });
      console.log(`🧪 [${exchange}] [DRY-RUN] TP FILLED: ${order.size} BTC @ $${fillPrice}, USDC profit=$${usdcProfit.toFixed(2)}, holdback=${holdbackBtc.toFixed(8)} BTC (≈$${holdbackValue.toFixed(2)})`);

      if (orderId === activeTpOrderId) {
        activeTpOrderId = null;
        lastTpPrice = 0;
        lastTpSize = 0;
      }

      // Record cycle analytics for optimal TP analysis
      if (currentCycleTracking) {
        const entryPrice = currentCycleTracking.entryPrice;
        const actualTpPct = ((fillPrice - entryPrice) / entryPrice) * 100;
        const optimalTpPct = ((currentCycleTracking.maxPrice - entryPrice) / entryPrice) * 100;
        const missedProfitPct = optimalTpPct - actualTpPct;
        const timeToMax = currentCycleTracking.maxPriceTime - currentCycleTracking.entryTime;

        cycleAnalytics.push({
          entryPrice,
          exitPrice: fillPrice,
          maxPrice: currentCycleTracking.maxPrice,
          minPrice: currentCycleTracking.minPrice,
          optimalTpPct,
          actualTpPct,
          missedProfitPct,
          timeToMax,
          cycleNumber: cycleAnalytics.length + 1,
        });

        console.log(`📊 [${exchange}] [DRY-RUN] Cycle ${cycleAnalytics.length} analytics: optimal=${optimalTpPct.toFixed(2)}% actual=${actualTpPct.toFixed(2)}% missed=${missedProfitPct.toFixed(2)}%`);

        // Reset tracking for next cycle
        currentCycleTracking = null;
      }

      // Notify callback for position update
      if (callbacks.onSellFill) {
        callbacks.onSellFill(orderId, order.size, fillPrice, netProceeds, pnl);
      }
    }
  };

  /**
   * Get average entry price from filled buy orders
   * @returns {number}
   */
  const getAverageEntryPrice = () => {
    const buyFills = filledOrders.filter(o => o.type === 'entry' && o.side === 'buy');
    if (buyFills.length === 0) return 0;

    const totalValue = buyFills.reduce((sum, o) => sum + (o.fillPrice * o.size), 0);
    const totalSize = buyFills.reduce((sum, o) => sum + o.size, 0);
    return totalSize > 0 ? totalValue / totalSize : 0;
  };

  /**
   * Cancel all entry orders (for SAFE mode)
   * @returns {Promise<number>}
   */
  const cancelAllEntries = async () => {
    let cancelled = 0;

    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'entry') {
        order.status = 'cancelled';
        pendingOrders.delete(orderId);
        cancelled++;
      }
    }

    console.log(`🧪 [${exchange}] [DRY-RUN] Cancelled ${cancelled} entry orders`);
    return cancelled;
  };

  // Satellite TP Functions
  // ============================================================================

  /**
   * Place a satellite TP sell order (simulated, independent from core TP)
   * @param {number} btcQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {string} buyOrderId - Buy order ID that created this satellite
   * @returns {Promise<{success: boolean, orderId?: string, errorMessage?: string}>}
   */
  const placeSatelliteTpOrder = async (btcQty, tpPrice, buyOrderId) => {
    const roundedPrice = roundPrice(tpPrice);
    const roundedQty = roundBTC(btcQty);

    const orderId = generateOrderId();

    const order = {
      orderId,
      type: 'satellite_tp',
      side: 'sell',
      price: roundedPrice,
      size: roundedQty,
      sizeUsdc: roundedQty * roundedPrice,
      placedAt: Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    };

    pendingOrders.set(orderId, order);
    satelliteTpOrders.set(buyOrderId, {
      tpOrderId: orderId,
      btcQty: roundedQty,
      tpPrice: roundedPrice,
      costBasis: roundedQty * roundedPrice, // Will be overridden by regime engine
    });

    console.log(`🧪 [${exchange}] [DRY-RUN] Satellite TP placed: ${roundedQty} BTC @ $${roundedPrice} (buy=${buyOrderId.substring(0, 8)})`);

    return { success: true, orderId };
  };

  /**
   * Cancel a specific satellite TP order (simulated)
   * @param {string} buyOrderId - Buy order ID of the satellite to cancel
   * @returns {Promise<{cancelled: boolean, filled: boolean}>}
   */
  const cancelSatelliteTpOrder = async (buyOrderId) => {
    const satellite = satelliteTpOrders.get(buyOrderId);
    if (!satellite) return { cancelled: true, filled: false };

    pendingOrders.delete(satellite.tpOrderId);
    satelliteTpOrders.delete(buyOrderId);
    return { cancelled: true, filled: false };
  };

  /**
   * Cancel all satellite TP orders (simulated)
   * @returns {Promise<number>} Number cancelled
   */
  const cancelAllSatelliteTpOrders = async () => {
    let cancelled = 0;
    const entries = Array.from(satelliteTpOrders.entries());

    for (const [buyOrderId, satellite] of entries) {
      pendingOrders.delete(satellite.tpOrderId);
      satelliteTpOrders.delete(buyOrderId);
      cancelled++;
    }

    return cancelled;
  };

  /**
   * Check if an order ID is a satellite TP order
   * @param {string} orderId - Order ID to check
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
   * @param {string} tpOrderId - Sell order ID
   * @returns {{buyOrderId: string, btcQty: number, tpPrice: number, costBasis: number}|null}
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
   * Restore satellite TP order tracking (for state recovery)
   * @param {string} buyOrderId - Buy order ID
   * @param {string} tpOrderId - Sell order ID
   * @param {number} btcQty - BTC quantity
   * @param {number} tpPrice - TP price
   * @param {number} [placedAt] - Original placement timestamp (ms), defaults to now
   */
  const restoreSatelliteTpOrder = (buyOrderId, tpOrderId, btcQty, tpPrice, placedAt) => {
    satelliteTpOrders.set(buyOrderId, { tpOrderId, btcQty, tpPrice, costBasis: btcQty * tpPrice });

    pendingOrders.set(tpOrderId, {
      orderId: tpOrderId,
      type: 'satellite_tp',
      side: 'sell',
      price: tpPrice,
      size: btcQty,
      sizeUsdc: btcQty * tpPrice,
      placedAt: placedAt || Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    });
  };

  /**
   * Remove satellite tracking after fill or cancel
   * @param {string} tpOrderId - Sell order ID that was filled/cancelled
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
   * Place a body TP sell order (simulated, celestial hierarchy)
   * @param {number} btcQty - BTC quantity to sell
   * @param {number} tpPrice - Take-profit price
   * @param {string} bodyId - Celestial body ID
   * @returns {Promise<{success: boolean, orderId?: string, errorMessage?: string}>}
   */
  const placeBodyTpOrder = async (btcQty, tpPrice, bodyId) => {
    const roundedPrice = roundPrice(tpPrice);
    const roundedQty = roundBTC(btcQty);
    const orderId = generateOrderId();

    const order = {
      orderId,
      type: 'body_tp',
      side: 'sell',
      price: roundedPrice,
      size: roundedQty,
      sizeUsdc: roundedQty * roundedPrice,
      placedAt: Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    };

    pendingOrders.set(orderId, order);
    bodyTpOrders.set(bodyId, {
      tpOrderId: orderId,
      btcQty: roundedQty,
      tpPrice: roundedPrice,
      costBasis: roundedQty * roundedPrice,
    });

    console.log(`🧪 [${exchange}] [DRY-RUN] Body TP placed: ${roundedQty} BTC @ $${roundedPrice} (body=${bodyId.slice(-8)})`);
    return { success: true, orderId };
  };

  /**
   * Cancel a specific body TP order (simulated)
   * @param {string} bodyId - Celestial body ID
   * @returns {Promise<{cancelled: boolean, filled?: boolean}>}
   */
  const cancelBodyTpOrder = async (bodyId) => {
    const body = bodyTpOrders.get(bodyId);
    if (!body) return { cancelled: true, filled: false };
    pendingOrders.delete(body.tpOrderId);
    bodyTpOrders.delete(bodyId);
    return { cancelled: true, filled: false };
  };

  /**
   * Check if an order ID is a body TP order
   * @param {string} orderId - Order ID to check
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
   * @param {string} tpOrderId - Sell order ID
   * @returns {{bodyId: string, btcQty: number, tpPrice: number, costBasis: number}|null}
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
   * Restore body TP order tracking (for state recovery)
   * @param {string} bodyId - Body ID
   * @param {string} tpOrderId - Sell order ID
   * @param {number} btcQty - BTC quantity
   * @param {number} tpPrice - TP price
   * @param {number} [placedAt] - Original placement timestamp (ms), defaults to now
   */
  const restoreBodyTpOrder = (bodyId, tpOrderId, btcQty, tpPrice, placedAt) => {
    bodyTpOrders.set(bodyId, { tpOrderId, btcQty, tpPrice, costBasis: btcQty * tpPrice });
    pendingOrders.set(tpOrderId, {
      orderId: tpOrderId,
      type: 'body_tp',
      side: 'sell',
      price: tpPrice,
      size: btcQty,
      sizeUsdc: btcQty * tpPrice,
      placedAt: placedAt || Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    });
  };

  /**
   * Remove body tracking after fill or cancel
   * @param {string} tpOrderId - Sell order ID that was filled/cancelled
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

  /**
   * Handle order fill notification (passthrough for compatibility)
   * @param {string} orderId - Filled order ID
   */
  const handleOrderFill = (orderId) => {
    // In dry-run mode, fills are handled internally
  };

  /**
   * Handle order cancel notification (passthrough for compatibility)
   * @param {string} orderId - Cancelled order ID
   */
  const handleOrderCancel = (orderId) => {
    const order = pendingOrders.get(orderId);
    if (order) {
      order.status = 'cancelled';
      pendingOrders.delete(orderId);

      if (order.type === 'take_profit' && orderId === activeTpOrderId) {
        activeTpOrderId = null;
        lastTpPrice = 0;
        lastTpSize = 0;
      } else if (order.type === 'satellite_tp' || order.type === 'body_tp') {
        removeBodyTracking(orderId);
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
      if (order.status === 'open') {
        if (order.type === 'entry') entries++;
        else if (order.type === 'take_profit') takeProfits++;
        else if (order.type === 'satellite_tp' || order.type === 'body_tp') satellites++;
      }
    }

    return { entries, takeProfits, satellites, total: pendingOrders.size };
  };

  /**
   * Get all pending entry orders
   * @returns {Map<string, Object>}
   */
  const getPendingEntries = () => {
    const entries = new Map();
    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'entry' && order.status === 'open') {
        entries.set(orderId, order);
      }
    }
    return entries;
  };

  /**
   * Check invariants
   * @returns {{valid: boolean, reason?: string}}
   */
  const checkInvariants = () => {
    const openCount = Array.from(pendingOrders.values()).filter(o => o.status === 'open').length;
    if (openCount > config.maxOpenOrders) {
      return {
        valid: false,
        reason: `too_many_orders:${openCount}>${config.maxOpenOrders}`,
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
    let summary = `[DRY-RUN] pending=${counts.total}(entries=${counts.entries},tp=${counts.takeProfits},sat=${counts.satellites})`;

    if (activeTpOrderId) {
      summary += ` active_tp=${activeTpOrderId.substring(0, 12)}@$${lastTpPrice}`;
    }

    return summary;
  };

  /**
   * Clear all pending orders
   */
  const clearPendingOrders = () => {
    pendingOrders.clear();
    satelliteTpOrders.clear();
    activeTpOrderId = null;
    lastTpPrice = 0;
    lastTpSize = 0;
  };

  /**
   * Restore pending order (for recovery - no-op in dry-run)
   * @param {string} orderId - Order ID
   * @param {PendingOrder} order - Order details
   */
  const restorePendingOrder = (orderId, order) => {
    // No-op in dry-run mode - we don't recover simulated orders
  };

  /**
   * Refresh stale orders (simulated)
   * @returns {Promise<number>}
   */
  const refreshStaleOrders = async () => {
    const now = Date.now();
    let refreshed = 0;

    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'entry' && order.status === 'open') {
        if (now - order.placedAt > config.orderStaleMs) {
          order.status = 'cancelled';
          pendingOrders.delete(orderId);
          refreshed++;
        }
      }
    }

    return refreshed;
  };

  /**
   * Atomic order replacement (simulated)
   * @param {string} oldOrderId - Order to cancel
   * @param {Object} newOrderParams - New order parameters
   * @returns {Promise<{success: boolean, newOrderId?: string, reason?: string}>}
   */
  const atomicReplace = async (oldOrderId, newOrderParams) => {
    // Cancel old order
    const oldOrder = pendingOrders.get(oldOrderId);
    if (oldOrder) {
      oldOrder.status = 'cancelled';
      pendingOrders.delete(oldOrderId);
    }

    const { btcQty, price, type } = newOrderParams;
    const newOrderId = generateOrderId();

    const newOrder = {
      orderId: newOrderId,
      type,
      side: type === 'entry' ? 'buy' : 'sell',
      price,
      size: btcQty,
      sizeUsdc: btcQty * price,
      placedAt: Date.now(),
      status: 'open',
      filledAt: null,
      fillPrice: null,
    };

    pendingOrders.set(newOrderId, newOrder);

    if (type === 'take_profit') {
      activeTpOrderId = newOrderId;
      lastTpPrice = price;
      lastTpSize = btcQty;
    }

    return { success: true, newOrderId };
  };

  /**
   * Log that an entry was blocked
   * @param {string} reason - Block reason
   * @param {string} regime - Current regime
   * @param {number} price - Market price
   * @param {Object} details - Additional details
   */
  const logEntryBlocked = (reason, regime, price, details) => {
    logDecision('entry_blocked', regime, price, { reason, ...details });
  };

  /**
   * Get decision log
   * @param {number} [limit] - Maximum entries to return
   * @returns {DecisionLogEntry[]}
   */
  const getDecisionLog = (limit = 100) => {
    return decisionLog.slice(-limit);
  };

  /**
   * Get filled orders
   * @returns {SimulatedOrder[]}
   */
  const getFilledOrders = () => [...filledOrders];

  /**
   * Get BTC currently on open sell orders
   * @returns {number}
   */
  const getBtcOnOrder = () => {
    let total = 0;
    for (const order of pendingOrders.values()) {
      if ((order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp') && order.status === 'open') {
        total += order.size;
      }
    }
    return total;
  };

  /**
   * Get simulated P&L summary
   * @returns {Object}
   */
  const getSimulatedPnL = () => ({
    realizedPnL: simulatedRealizedPnL,
    realizedBtcPnL: simulatedRealizedBtcPnL,
    btcOnOrder: getBtcOnOrder(),
    totalBought: simulatedTotalBought,
    totalSold: simulatedTotalSold,
    avgEntryPrice: getAverageEntryPrice(),
    filledOrderCount: filledOrders.length,
  });

  /**
   * Get optimal TP analytics
   * @returns {Object}
   */
  const getOptimalTpAnalytics = () => {
    const completedCycles = cycleAnalytics;
    const cycleCount = completedCycles.length;

    if (cycleCount === 0) {
      return {
        cycleCount: 0,
        currentCycle: currentCycleTracking ? {
          entryPrice: currentCycleTracking.entryPrice,
          currentMaxPrice: currentCycleTracking.maxPrice,
          currentMinPrice: currentCycleTracking.minPrice,
          currentOptimalPct: ((currentCycleTracking.maxPrice - currentCycleTracking.entryPrice) / currentCycleTracking.entryPrice) * 100,
          timeInPosition: Date.now() - currentCycleTracking.entryTime,
        } : null,
        avgOptimalTpPct: 0,
        avgActualTpPct: 0,
        avgMissedProfitPct: 0,
        avgTimeToMaxMs: 0,
        recommendedTpRange: null,
        cycles: [],
      };
    }

    const avgOptimalTpPct = completedCycles.reduce((sum, c) => sum + c.optimalTpPct, 0) / cycleCount;
    const avgActualTpPct = completedCycles.reduce((sum, c) => sum + c.actualTpPct, 0) / cycleCount;
    const avgMissedProfitPct = completedCycles.reduce((sum, c) => sum + c.missedProfitPct, 0) / cycleCount;
    const avgTimeToMaxMs = completedCycles.reduce((sum, c) => sum + c.timeToMax, 0) / cycleCount;

    // Calculate percentiles for recommended range
    const sortedOptimal = completedCycles.map(c => c.optimalTpPct).sort((a, b) => a - b);
    const p25 = sortedOptimal[Math.floor(cycleCount * 0.25)] || sortedOptimal[0];
    const p50 = sortedOptimal[Math.floor(cycleCount * 0.50)] || sortedOptimal[0];
    const p75 = sortedOptimal[Math.floor(cycleCount * 0.75)] || sortedOptimal[sortedOptimal.length - 1];

    // Min/max observed
    const minOptimal = Math.min(...sortedOptimal);
    const maxOptimal = Math.max(...sortedOptimal);

    return {
      cycleCount,
      currentCycle: currentCycleTracking ? {
        entryPrice: currentCycleTracking.entryPrice,
        currentMaxPrice: currentCycleTracking.maxPrice,
        currentMinPrice: currentCycleTracking.minPrice,
        currentOptimalPct: ((currentCycleTracking.maxPrice - currentCycleTracking.entryPrice) / currentCycleTracking.entryPrice) * 100,
        timeInPosition: Date.now() - currentCycleTracking.entryTime,
      } : null,
      avgOptimalTpPct,
      avgActualTpPct,
      avgMissedProfitPct,
      avgTimeToMaxMs,
      recommendedTpRange: {
        min: p25,
        median: p50,
        max: p75,
        observed: { min: minOptimal, max: maxOptimal },
      },
      cycles: completedCycles.slice(-20), // Last 20 cycles
    };
  };

  /**
   * Get dry-run state for API/UI
   * @returns {Object}
   */
  const getDryRunState = () => ({
    isDryRun: true,
    pendingOrders: Array.from(pendingOrders.values()),
    filledOrders: [...filledOrders],
    decisionLog: decisionLog.slice(-50),
    pnl: getSimulatedPnL(),
    optimalTpAnalytics: getOptimalTpAnalytics(),
  });

  /**
   * Reset all dry-run state
   */
  const resetDryRunState = () => {
    pendingOrders.clear();
    satelliteTpOrders.clear();
    decisionLog.length = 0;
    filledOrders.length = 0;
    cycleAnalytics.length = 0;
    currentCycleTracking = null;
    activeTpOrderId = null;
    lastTpPrice = 0;
    lastTpSize = 0;
    simulatedRealizedPnL = 0;
    simulatedRealizedBtcPnL = 0;
    simulatedSatelliteRealizedPnL = 0;
    simulatedSatelliteRealizedBtcPnL = 0;
    simulatedTotalBought = 0;
    simulatedTotalSold = 0;
    console.log(`🧪 [${exchange}] [DRY-RUN] State reset`);
  };

  /**
   * Export executor state for persistence
   * @returns {Object}
   */
  const exportState = () => ({
    pendingOrders: Array.from(pendingOrders.values()),
    filledOrders: [...filledOrders],
    activeTpOrderId,
    lastTpPrice,
    lastTpSize,
    simulatedRealizedPnL,
    simulatedRealizedBtcPnL,
    simulatedSatelliteRealizedPnL,
    simulatedSatelliteRealizedBtcPnL,
    simulatedTotalBought,
    simulatedTotalSold,
    currentCycleTracking,
    cycleAnalytics: [...cycleAnalytics],
    orderIdCounter: getOrderIdCounter(),
    satelliteTpOrders: Array.from(satelliteTpOrders.entries()).map(([buyOrderId, sat]) => ({
      buyOrderId, ...sat,
    })),
  });

  /**
   * Import executor state from persistence
   * @param {Object} state - State to restore
   */
  const importState = (state) => {
    if (!state) return;

    // Restore pending orders
    pendingOrders.clear();
    if (state.pendingOrders) {
      for (const order of state.pendingOrders) {
        pendingOrders.set(order.orderId, order);
      }
    }

    // Restore filled orders
    filledOrders.length = 0;
    if (state.filledOrders) {
      filledOrders.push(...state.filledOrders);
    }

    // Restore TP tracking
    activeTpOrderId = state.activeTpOrderId || null;
    lastTpPrice = state.lastTpPrice || 0;
    lastTpSize = state.lastTpSize || 0;

    // Restore P&L tracking
    simulatedRealizedPnL = state.simulatedRealizedPnL || 0;
    simulatedRealizedBtcPnL = state.simulatedRealizedBtcPnL || 0;
    simulatedSatelliteRealizedPnL = state.simulatedSatelliteRealizedPnL || 0;
    simulatedSatelliteRealizedBtcPnL = state.simulatedSatelliteRealizedBtcPnL || 0;
    simulatedTotalBought = state.simulatedTotalBought || 0;
    simulatedTotalSold = state.simulatedTotalSold || 0;

    // Restore cycle tracking
    currentCycleTracking = state.currentCycleTracking || null;
    cycleAnalytics.length = 0;
    if (state.cycleAnalytics) {
      cycleAnalytics.push(...state.cycleAnalytics);
    }

    // Restore satellite TP tracking
    satelliteTpOrders.clear();
    if (state.satelliteTpOrders) {
      for (const sat of state.satelliteTpOrders) {
        satelliteTpOrders.set(sat.buyOrderId, {
          tpOrderId: sat.tpOrderId,
          btcQty: sat.btcQty,
          tpPrice: sat.tpPrice,
          costBasis: sat.costBasis || (sat.btcQty * sat.tpPrice),
        });
      }
    }

    // Restore order ID counter
    if (state.orderIdCounter) {
      setOrderIdCounter(state.orderIdCounter);
    }

    console.log(`🧪 [${exchange}] [DRY-RUN] State restored: ${filledOrders.length} filled, ${pendingOrders.size} pending, ${satelliteTpOrders.size} satellites, PnL=$${simulatedRealizedPnL.toFixed(2)}`);
  };

  return {
    // Standard executor interface
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
    checkInvariants,
    getActiveTpOrderId,
    getSummary,
    clearPendingOrders,
    restorePendingOrder,

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

    // Dry-run specific methods
    checkTpFills,
    checkEntryFills,
    logEntryBlocked,
    getDecisionLog,
    getFilledOrders,
    getSimulatedPnL,
    getBtcOnOrder,
    getOptimalTpAnalytics,
    getDryRunState,
    resetDryRunState,

    // State persistence methods
    exportState,
    importState,

    // Flag to identify dry-run executor
    isDryRun: true,
  };
};

module.exports = {
  createDryRunExecutor,
};
