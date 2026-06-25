// @ts-check
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('./adapters');
const stateTracker = require('./state-tracker');
const orderManager = require('./order-manager');
const logger = require('./logger');
const { consolidatePendingOrders } = require('./order-manager');
const { getExchangeConfig, getEnabledExchanges, getBaseCurrency, getQuoteCurrency } = require('./config-utils');
const { normalizeConfig, formatInterval, shouldRunConsolidation, getConsolidationRunId } = require('./interval-utils');
const { tradeEvents } = require('./trade-events');
const { getFibonacciBuyAmount } = require('./fibonacci-utils');

/**
 * @typedef {import('./types').ExchangeConfig} ExchangeConfig
 * @typedef {import('./types').BotState} BotState
 * @typedef {import('./types').CycleResult} CycleResult
 * @typedef {import('./types').StatusResult} StatusResult
 * @typedef {import('./types').FilledSellOrder} FilledSellOrder
 * @typedef {import('./types').ConsolidationResult} ConsolidationResult
 * @typedef {import('./types').TrackedOrder} TrackedOrder
 */

// Fee constants for dry-run simulation
const FEE_RATE = 0.00125; // ~0.125% taker fee
const REBATE_RATE = 0.00031; // ~0.031% maker rebate

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
  tradeEvents.checkingOrders(exchange, pendingOrders.length);

  const adapter = getAdapter(exchange);
  const filledOrders = await orderManager.checkFilledOrders(pendingOrders, adapter);

  for (const filled of filledOrders) {
    stateTracker.updateAfterSellFill(state, filled);
    logger.logSellFilled(filled, state, exchange);
    logger.log('INFO', `[${exchange}] Sell order filled: +${filled.fillValue.toFixed(2)}`);
    tradeEvents.orderFilled(exchange, filled.orderId, filled.fillValue);
  }

  return filledOrders;
};

/**
 * Execute order consolidation for an exchange
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @param {string[]} [orderIds] - Specific order IDs to consolidate (optional, defaults to all pending)
 * @returns {Promise<ConsolidationResult>} Result of the consolidation
 */
const executeConsolidation = async (exchange = 'coinbase', orderIds = null) => {
  const config = loadConfig(exchange);
  const state = stateTracker.loadState(config, exchange);
  const adapter = getAdapter(exchange);

  // Get pending orders to consolidate
  let pendingOrders = stateTracker.getPendingOrders(state);

  // Filter to specific order IDs if provided
  if (orderIds && orderIds.length > 0) {
    pendingOrders = pendingOrders.filter(o => orderIds.includes(o.orderId));
  }

  if (pendingOrders.length < 2) {
    return {
      success: false,
      error: `Need at least 2 pending orders, found ${pendingOrders.length}`,
    };
  }

  logger.log('INFO', `[${exchange}] Starting consolidation of ${pendingOrders.length} orders`);

  const result = await consolidatePendingOrders(config, pendingOrders, adapter);

  if (result.success && result.newOrderId == null) {
    // Every eligible order filled during its cancel window (issue #150): no
    // consolidated order was placed and no asset is held. Do NOT push a phantom
    // consolidated entry (orderId: null) into state — the filled originals are
    // detected and closed by the engine's normal fill reconciliation on the next
    // sync. Advance the consolidation schedule so we don't immediately retry, then
    // persist. Skip the ordersConsolidated event (nothing was consolidated).
    if (config.consolidateInterval && config.consolidateInterval !== 'never') {
      state.lastConsolidationId = getConsolidationRunId(config.consolidateInterval);
      state.lastConsolidationTimestamp = Date.now();
    }
    stateTracker.saveState(state, exchange);
    logger.log('INFO', `[${exchange}] Consolidation placed no order — all eligible orders filled during cancel (${result.filledDuringCancelOrderIds?.length || 0} filled)`);
    return result;
  }

  if (result.success) {
    // Get the orders that were actually consolidated (not skipped)
    const consolidatedOrders = pendingOrders.filter(o =>
      result.cancelledOrderIds.includes(o.orderId)
    );

    // Update state
    stateTracker.updateAfterConsolidation(
      state,
      consolidatedOrders,
      result.newOrderId,
      result.consolidatedPrice,
      result.consolidatedAsset
    );

    // Track consolidation run for interval-based scheduling
    if (config.consolidateInterval && config.consolidateInterval !== 'never') {
      state.lastConsolidationId = getConsolidationRunId(config.consolidateInterval);
      state.lastConsolidationTimestamp = Date.now();
    }

    // Save state
    stateTracker.saveState(state, exchange);

    // Log the transaction
    logger.logConsolidation(result, state, exchange);

    // Emit event
    tradeEvents.ordersConsolidated(
      exchange,
      result.consolidatedCount,
      result.newOrderId,
      result.consolidatedPrice,
      result.consolidatedAsset
    );

    logger.log('INFO', `[${exchange}] Consolidation complete: ${result.consolidatedCount} orders -> 1 @ $${result.consolidatedPrice.toFixed(2)}`);
  } else {
    // Consolidation cancelled the original sells before its place failed; the
    // recovery path re-placed them under new exchange IDs (issue #149). Re-point
    // tracked state at the new IDs and flag any sell that couldn't be re-placed,
    // then persist so the engine doesn't keep tracking the cancelled orders.
    if (result.restoredOrders?.length || result.failedRestoreOrderIds?.length) {
      stateTracker.applyConsolidationRecovery(state, result.restoredOrders, result.failedRestoreOrderIds);
      stateTracker.saveState(state, exchange);
      if (result.failedRestoreOrderIds?.length) {
        logger.log('ERROR', `[${exchange}] ${result.failedRestoreOrderIds.length} sell(s) left naked after failed consolidation — operator action needed: ${result.failedRestoreOrderIds.join(', ')}`);
      }
    }
    logger.log('ERROR', `[${exchange}] Consolidation failed: ${result.error}`);
    tradeEvents.error(exchange, `Consolidation failed: ${result.error}`);
  }

  return result;
};

/**
 * Recover durable 'awaiting_sell' rows left by a crash between the buy-save and
 * sell placement (issue #129). recordBuyFill persists the buy as 'awaiting_sell'
 * BEFORE sell placement (issue #106); if the process dies before
 * attachSellOrder/markSellPlacementFailed runs, the row is durable but invisible
 * to getPendingOrders (status filter) and has no recovery path — the filled buy
 * sits with no tracked sell while later intervals keep buying.
 *
 * For each such row, re-derive the buyDetails the sell-placement path expects
 * from the persisted fields (buyOrderId/buyPrice/buyQuantity) and re-attempt the
 * sell via the same orderManager.placeSellOrderWithRetry used post-buy. On
 * success attach the sell; on failure mark sell_failed for operator follow-up.
 * Dry-run rows are never persisted as awaiting_sell, so this only ever sees real
 * orders. State is NOT saved here — the caller persists once after reconciliation.
 *
 * @param {BotState} state - Current state (mutated in place)
 * @param {ExchangeConfig} config - Configuration
 * @param {Object} adapter - Exchange adapter
 * @param {string} exchange - Exchange name
 * @returns {Promise<{recovered: number, failed: number}>} Reconciliation outcome
 */
const reconcileAwaitingSells = async (state, config, adapter, exchange) => {
  const awaiting = (state.orders || []).filter(o => o.status === 'awaiting_sell');
  if (awaiting.length === 0) {
    return { recovered: 0, failed: 0 };
  }

  logger.log('INFO', `🔧 [${exchange}] Reconciling ${awaiting.length} orphaned awaiting_sell row(s) before new buy`);

  let recovered = 0;
  let failed = 0;

  for (const order of awaiting) {
    // Re-derive the buyDetails shape placeSellOrderWithRetry expects. The
    // retry path recomputes sellQuantity from assetAmount + holdbackPercent and
    // sellPrice from price + markup, so the original buy price/qty is enough.
    const buyDetails = {
      orderId: order.buyOrderId,
      assetAmount: order.buyQuantity,
      price: order.buyPrice,
    };

    let sellOrder;
    try {
      sellOrder = await orderManager.placeSellOrderWithRetry(config, buyDetails, adapter);
    } catch (err) {
      stateTracker.markSellPlacementFailed(state, order.buyOrderId, err.message);
      logger.log('ERROR', `🔧 [${exchange}] Recovery sell failed for buy ${order.buyOrderId} — marked sell_failed: ${err.message}`);
      tradeEvents.error(exchange, `Recovery sell placement failed: ${err.message}`, { buyOrderId: order.buyOrderId });
      failed += 1;
      continue;
    }

    stateTracker.attachSellOrder(state, order.buyOrderId, sellOrder);
    logger.log('INFO', `🔧 [${exchange}] Recovery sell placed for buy ${order.buyOrderId}: ${sellOrder.orderId} @ ${sellOrder.limitPrice}`);
    tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
    recovered += 1;
  }

  return { recovered, failed };
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
  const isFibonacci = config.dcaStrategy === 'fibonacci';

  // Initialize Fibonacci state if needed
  if (isFibonacci) {
    stateTracker.initFibonacciState(state, config);
  }

  // Emit starting event
  tradeEvents.starting(exchange, intervalLabel);

  // Check if enabled
  if (!config.enabled) {
    logger.log('INFO', `[${exchange}] Critical Mass is disabled in config`);
    tradeEvents.disabled(exchange);
    return { status: 'disabled', exchange };
  }

  // Check if already ran this interval
  if (stateTracker.checkIfRanThisInterval(state, config.intervalType)) {
    logger.log('INFO', `[${exchange}] Already ran this ${intervalLabel} interval (${state.lastRunId})`);
    tradeEvents.skipped(exchange, `Already ran this ${intervalLabel} interval`);
    return { status: 'already_ran', lastRunId: state.lastRunId, intervalType: config.intervalType, exchange };
  }

  // Check Fibonacci sell fill FIRST (before buying more)
  if (isFibonacci && state.fibActiveSellOrderId) {
    const fibFill = await orderManager.checkFibonacciSellFill(state.fibActiveSellOrderId, adapter);
    if (fibFill) {
      const cyclePosition = state.fibPosition || 0;
      stateTracker.updateAfterFibSellFill(state, fibFill);
      logger.logFibSellFilled(fibFill, state, cyclePosition, exchange);
      stateTracker.saveState(state, exchange);
      logger.log('INFO', `[${exchange}] Fibonacci cycle complete - resetting to position 0`);
      tradeEvents.cycleComplete(exchange, 'fib_cycle_complete', { profit: fibFill.netProceeds, buysInCycle: cyclePosition });
    }
  }

  // Sync order statuses (check for filled sells) - for fixed strategy
  let filledOrders = [];
  if (!isFibonacci) {
    filledOrders = await syncOrderStatuses(state, exchange);

    if (filledOrders.length > 0) {
      logger.log('INFO', `[${exchange}] ${filledOrders.length} orders filled since last run`);
      stateTracker.saveState(state, exchange);
    }

    // Recover orphaned awaiting_sell rows (crash between buy-save and sell
    // placement) BEFORE evaluating a new buy — otherwise the filled buy sits
    // with no tracked sell while later intervals keep buying (issue #129).
    if (config.dryRun !== true) {
      const recon = await reconcileAwaitingSells(state, config, adapter, exchange);
      if (recon.recovered > 0 || recon.failed > 0) {
        stateTracker.saveState(state, exchange);
      }
    }
  }

  // Check current price against max threshold
  const currentPrice = await adapter.getCurrentPrice(config.productId);
  logger.log('INFO', `[${exchange}] Current ${config.productId} price: ${currentPrice.toFixed(2)}`);
  tradeEvents.priceCheck(exchange, config.productId, currentPrice);

  if (currentPrice > config.maxBuyPrice) {
    logger.log('WARN', `[${exchange}] Price ${currentPrice} exceeds max buy price ${config.maxBuyPrice}`);
    tradeEvents.skipped(exchange, `Price $${currentPrice.toFixed(2)} exceeds max $${config.maxBuyPrice}`);
    return {
      status: 'price_too_high',
      currentPrice,
      maxBuyPrice: config.maxBuyPrice,
      exchange,
    };
  }

  // Check balance first
  const quoteCurrency = getQuoteCurrency(config.productId);
  const balance = await adapter.getAccountBalance(quoteCurrency);
  logger.log('INFO', `[${exchange}] ${quoteCurrency} balance: ${balance.available.toFixed(2)} available, ${balance.hold.toFixed(2)} on hold`);
  tradeEvents.balanceCheck(exchange, quoteCurrency, balance.available);

  // Calculate buy amount based on strategy
  let actualBuyAmount;

  if (isFibonacci) {
    // Fibonacci strategy: use Fibonacci sequence for buy amounts
    const fibPosition = state.fibPosition || 0;
    const fibAmount = getFibonacciBuyAmount(fibPosition, config.fibBaseAmount);

    logger.log('INFO', `[${exchange}] Fibonacci position ${fibPosition}: target buy amount $${fibAmount.toFixed(2)}`);

    // Check allocation cap (same as fixed strategy)
    const { remaining } = stateTracker.checkAllocationRemaining(state, config);
    if (remaining <= 0) {
      logger.log('INFO', `[${exchange}] Full allocation has been used`);
      return { status: 'fully_allocated', totalAllocated: state.totalAllocated, exchange };
    }

    // Cap Fibonacci amount to remaining allocation
    const cappedFibAmount = Math.min(fibAmount, remaining);
    if (cappedFibAmount < fibAmount) {
      logger.log('INFO', `[${exchange}] Fibonacci amount capped to remaining allocation: $${cappedFibAmount.toFixed(2)} (was $${fibAmount.toFixed(2)})`);
    }

    // Wait if insufficient funds for (capped) Fibonacci amount
    if (balance.available < cappedFibAmount) {
      logger.log('INFO', `[${exchange}] Waiting for funds: need $${cappedFibAmount.toFixed(2)}, have $${balance.available.toFixed(2)}`);
      tradeEvents.skipped(exchange, `Waiting for funds: need $${cappedFibAmount.toFixed(2)}`);
      return {
        status: 'waiting_funds',
        required: cappedFibAmount,
        available: balance.available,
        fibPosition,
        exchange,
      };
    }

    actualBuyAmount = cappedFibAmount;
  } else {
    // Fixed strategy: use allocation-based amounts
    const { remaining, intervalAmount } = stateTracker.checkAllocationRemaining(state, config);

    if (remaining <= 0) {
      logger.log('INFO', `[${exchange}] Full allocation has been used`);
      return { status: 'fully_allocated', totalAllocated: state.totalAllocated, exchange };
    }

    if (intervalAmount < config.minOrderSize) {
      logger.log('INFO', `[${exchange}] Interval amount ${intervalAmount} below minimum ${config.minOrderSize}`);
      return { status: 'below_minimum', intervalAmount, minOrderSize: config.minOrderSize, exchange };
    }

    // Use the minimum of: interval amount, remaining allocation, or available balance
    actualBuyAmount = Math.min(intervalAmount, remaining, balance.available);

    // If balance is below interval amount, use what's available
    if (balance.available < intervalAmount) {
      logger.log('WARN', `[${exchange}] Balance ${balance.available.toFixed(2)} below interval amount ${intervalAmount.toFixed(2)}, using what's available`);
    }
  }

  // Check if we have enough to meet minimum order size
  if (actualBuyAmount < config.minOrderSize) {
    logger.log('ERROR', `[${exchange}] Available amount ${actualBuyAmount.toFixed(2)} below minimum ${config.minOrderSize}`);
    tradeEvents.error(exchange, `Insufficient balance: $${actualBuyAmount.toFixed(2)} below minimum $${config.minOrderSize}`, { available: balance.available, required: config.minOrderSize });
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

  // Emit buy placing event
  tradeEvents.buyPlacing(exchange, actualBuyAmount, config.productId);

  let holdbackAsset;

  if (isDryRun) {
    // Simulate the trade without executing
    const simulatedBtcAmount = actualBuyAmount / currentPrice;
    const simulatedFees = actualBuyAmount * FEE_RATE;
    const simulatedRebates = actualBuyAmount * REBATE_RATE;

    buyResult = {
      orderId: `dry-run-buy-${Date.now()}`,
      price: currentPrice,
      assetAmount: simulatedBtcAmount,
      usdcAmount: actualBuyAmount,
      fees: simulatedFees,
      rebates: simulatedRebates,
      netFees: simulatedFees - simulatedRebates,
      actualCost: actualBuyAmount + (simulatedFees - simulatedRebates),
      status: 'SIMULATED',
    };

    const assetCcy = getBaseCurrency(config.productId);
    logger.log('INFO', `[${exchange}] ${modeLabel}Simulated buy: ${buyResult.assetAmount.toFixed(8)} ${assetCcy} at ${buyResult.price.toFixed(2)}`);
    tradeEvents.buyFilled(exchange, buyResult.assetAmount, buyResult.price, buyResult.fees);

    if (isFibonacci) {
      // Fibonacci dry run: update state first to get cumulative values
      stateTracker.updateAfterFibBuy(state, buyResult, config);
      const cycleInfo = stateTracker.getFibonacciCycleInfo(state);

      const sellQuantity = cycleInfo.cumulativeAsset * (1 - config.holdbackPercent / 100);
      const sellPrice = cycleInfo.avgCostBasis * (1 + config.sellMarkupPercent / 100);
      holdbackAsset = cycleInfo.cumulativeAsset * (config.holdbackPercent / 100);

      sellOrder = {
        orderId: `dry-run-fib-sell-${Date.now()}`,
        success: true,
        baseSize: sellQuantity,
        limitPrice: sellPrice,
        status: 'SIMULATED',
      };

      stateTracker.updateAfterFibSellOrder(state, sellOrder, sellQuantity, holdbackAsset);
      logger.logFibBuy(buyResult, state, cycleInfo, exchange);
      logger.logFibSellOrder(sellOrder, state, cycleInfo, exchange);
    } else {
      // Fixed dry run
      const sellQuantity = simulatedBtcAmount * (1 - config.holdbackPercent / 100);
      const sellPrice = currentPrice * (1 + config.sellMarkupPercent / 100);
      holdbackAsset = simulatedBtcAmount * (config.holdbackPercent / 100);

      sellOrder = {
        orderId: `dry-run-sell-${Date.now()}`,
        success: true,
        baseSize: sellQuantity,
        limitPrice: sellPrice,
        status: 'SIMULATED',
      };

      stateTracker.updateAfterBuy(state, buyResult, sellOrder, config);
      logger.logBuy(buyResult, state, exchange);
      logger.logSellOrder(sellOrder, state, exchange);
    }

    logger.log('INFO', `[${exchange}] ${modeLabel}Simulated sell order: ${sellOrder.baseSize.toFixed(8)} ${assetCcy} at ${sellOrder.limitPrice.toFixed(2)}`);
    tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
  } else {
    // Execute real trades
    buyResult = await orderManager.executeDailyBuy(config, actualBuyAmount, adapter);
    tradeEvents.buyFilled(exchange, buyResult.assetAmount, buyResult.price, buyResult.fees || buyResult.netFees || 0);

    /**
     * Contain a sell-placement failure: the buy is already persisted (with
     * lastRunId set), so the cycle's accounting survives and the next
     * interval cannot double-buy. There is no retry mechanism for failed
     * sell placement — fixed strategy marks the order entry 'sell_failed'
     * for operator follow-up; Fibonacci self-heals next cycle via its
     * consolidated sell (which re-covers the full cumulative position).
     * @param {Error} err - The sell-placement error
     * @returns {CycleResult} Partial-cycle result
     */
    const sellPlacementFailed = (err) => {
      logger.log('ERROR', `[${exchange}] Sell placement failed after buy ${buyResult.orderId} — buy persisted (lastRunId=${state.lastRunId}), sell skipped: ${err.message}`);
      tradeEvents.error(exchange, `Sell placement failed: ${err.message}`, { buyOrderId: buyResult.orderId });
      return {
        status: 'sell_placement_failed',
        intervalType: config.intervalType,
        buyResult,
        error: err.message,
        exchange,
        state: {
          totalAllocated: state.totalAllocated,
          assetReserves: state.assetReserves,
          outstandingOrdersUSDC: state.outstandingOrdersUSDC,
          intervalsRun: state.totalIntervalsRun,
        },
      };
    };

    if (isFibonacci) {
      // Fibonacci strategy: persist the buy BEFORE attempting the
      // consolidated sell so a sell-placement throw cannot lose it (issue #106)
      stateTracker.updateAfterFibBuy(state, buyResult, config);
      stateTracker.saveState(state, exchange);
      const cycleInfo = stateTracker.getFibonacciCycleInfo(state);
      logger.logFibBuy(buyResult, state, cycleInfo, exchange);

      try {
        const fibSellResult = await orderManager.placeFibonacciSellOrder(
          config,
          cycleInfo.cumulativeAsset,
          cycleInfo.avgCostBasis,
          state.fibActiveSellOrderId,
          adapter
        );

        if (fibSellResult.alreadyFilled) {
          // Rare case: previous order filled between check and now
          const fibFill = await orderManager.checkFibonacciSellFill(state.fibActiveSellOrderId, adapter);
          if (!fibFill) {
            // Fill details unavailable despite FILLED status — leave
            // fibActiveSellOrderId intact so next cycle's fill check resolves it
            throw new Error(`fill details unavailable for filled fib sell ${state.fibActiveSellOrderId}`);
          }
          stateTracker.updateAfterFibSellFill(state, fibFill);
          stateTracker.saveState(state, exchange);
          logger.logFibSellFilled(fibFill, state, cycleInfo.position, exchange);
          // Now place new sell order for this buy
          const newFibSellResult = await orderManager.placeFibonacciSellOrder(
            config,
            buyResult.assetAmount,
            buyResult.price + (buyResult.netFees || 0) / buyResult.assetAmount,
            null,
            adapter
          );
          sellOrder = newFibSellResult.sellOrder;
          holdbackAsset = newFibSellResult.holdbackAsset;
          stateTracker.updateAfterFibSellOrder(state, sellOrder, newFibSellResult.sellQuantity, holdbackAsset);
        } else {
          sellOrder = fibSellResult.sellOrder;
          holdbackAsset = fibSellResult.holdbackAsset;
          stateTracker.updateAfterFibSellOrder(state, sellOrder, fibSellResult.sellQuantity, holdbackAsset);
        }
      } catch (err) {
        return sellPlacementFailed(err);
      }

      logger.logFibSellOrder(sellOrder, state, cycleInfo, exchange);
      tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
    } else {
      // Fixed strategy: persist the buy BEFORE attempting sell placement so
      // a sell-placement throw cannot lose it (issue #106)
      holdbackAsset = buyResult.assetAmount * (config.holdbackPercent / 100);
      stateTracker.recordBuyFill(state, buyResult, config);
      stateTracker.saveState(state, exchange);
      logger.logBuy(buyResult, state, exchange);

      try {
        sellOrder = await orderManager.placeSellOrderWithRetry(config, buyResult, adapter);
      } catch (err) {
        stateTracker.markSellPlacementFailed(state, buyResult.orderId, err.message);
        stateTracker.saveState(state, exchange);
        return sellPlacementFailed(err);
      }

      stateTracker.attachSellOrder(state, buyResult.orderId, sellOrder);
      logger.logSellOrder(sellOrder, state, exchange);
      tradeEvents.sellPlaced(exchange, sellOrder.orderId, sellOrder.baseSize, sellOrder.limitPrice);
    }
  }

  // Save state
  stateTracker.saveState(state, exchange);

  const baseCurrency = getBaseCurrency(config.productId);

  logger.log('INFO', `[${exchange}] ${modeLabel}=== ${intervalLabel} Cycle Complete ===`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Bought: ${buyResult.assetAmount.toFixed(8)} ${baseCurrency} at ${buyResult.price.toFixed(2)}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Sell order: ${sellOrder.baseSize.toFixed(8)} ${baseCurrency} at ${sellOrder.limitPrice.toFixed(2)}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Holdback (reserves): ${holdbackAsset.toFixed(8)} ${baseCurrency}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Total ${baseCurrency} reserves: ${state.assetReserves.toFixed(8)} ${baseCurrency}`);
  logger.log('INFO', `[${exchange}] ${modeLabel}Outstanding sell orders: ${state.outstandingOrdersUSDC.toFixed(2)}`);

  // Emit cycle complete event
  tradeEvents.cycleComplete(exchange, isDryRun ? 'dry_run_success' : 'success', {
    assetAmount: buyResult.assetAmount,
    buyPrice: buyResult.price,
    sellPrice: sellOrder.limitPrice,
    holdbackAsset,
    assetReserves: state.assetReserves,
    outstandingOrdersUSDC: state.outstandingOrdersUSDC,
  });

  // Check if auto-consolidation is needed (only for non-dry-run, fixed strategy only)
  // Fibonacci strategy handles its own consolidated sell orders
  if (!isDryRun && !isFibonacci) {
    const pendingCount = stateTracker.getPendingOrders(state).length;

    // Threshold-based consolidation
    if (config.consolidateAfterOrders > 0 && pendingCount > config.consolidateAfterOrders) {
      logger.log('INFO', `[${exchange}] Auto-consolidation triggered: ${pendingCount} orders > ${config.consolidateAfterOrders} threshold`);
      const consolResult = await executeConsolidation(exchange).catch(err => {
        logger.log('ERROR', `[${exchange}] Auto-consolidation failed: ${err.message}`);
        tradeEvents.error(exchange, `Auto-consolidation failed: ${err.message}`);
        return { success: false, error: err.message };
      });
      if (!consolResult?.success) {
        logger.log('WARN', `[${exchange}] Auto-consolidation unsuccessful, will retry next cycle`);
      }
    }
    // Interval-based consolidation (only if threshold didn't trigger and we have 2+ orders)
    else if (pendingCount >= 2 && shouldRunConsolidation(state.lastConsolidationId, config.consolidateInterval)) {
      logger.log('INFO', `[${exchange}] Scheduled consolidation triggered: ${config.consolidateInterval} interval`);
      await executeConsolidation(exchange).catch(err => {
        logger.log('ERROR', `[${exchange}] Scheduled consolidation failed: ${err.message}`);
        tradeEvents.error(exchange, `Scheduled consolidation failed: ${err.message}`);
      });
    }
  }

  const result = {
    status: isDryRun ? 'dry_run_success' : 'success',
    dryRun: isDryRun,
    intervalType: config.intervalType,
    buyResult,
    sellOrder,
    holdbackAsset,
    exchange,
    state: {
      totalAllocated: state.totalAllocated,
      assetReserves: state.assetReserves,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      intervalsRun: state.totalIntervalsRun,
    },
  };

  // Add Fibonacci-specific info if using that strategy
  if (isFibonacci) {
    const cycleInfo = stateTracker.getFibonacciCycleInfo(state);
    result.fibonacci = {
      position: cycleInfo.position,
      cumulativeCost: cycleInfo.cumulativeCost,
      cumulativeAsset: cycleInfo.cumulativeAsset,
      avgCostBasis: cycleInfo.avgCostBasis,
      activeSellOrderId: cycleInfo.activeSellOrderId,
    };
  }

  return result;
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
      assetReserves: state.assetReserves,
      outstandingOrdersUSDC: state.outstandingOrdersUSDC,
      outstandingOrdersAsset: state.outstandingOrdersAsset,
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
  reconcileAwaitingSells,
  loadConfig,
  executeConsolidation,
};
