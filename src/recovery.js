// @ts-check
/**
 * Recovery Module
 *
 * Handles startup state recovery from exchange:
 * - Fetches open orders from exchange
 * - Fetches recent fills
 * - Rebuilds position state from fills
 * - Validates internal state against exchange balances
 *
 * Exchange fills/balances are ALWAYS the source of truth.
 */

const { roundBTC, roundUSDC } = require('./volatility-utils');

/**
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 * @typedef {import('./types').RegimePositionState} RegimePositionState
 * @typedef {import('./types').PendingOrder} PendingOrder
 */

/**
 * Create recovery module instance
 * @param {string} exchange - Exchange name
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @param {string} productId - Product to recover state for
 * @returns {Object} Recovery module instance
 */
const createRecoveryModule = (exchange, adapter, productId) => {
  /**
   * Recover full state from exchange
   * @param {Object} fillLedger - Fill ledger instance
   * @param {Object} orderExecutor - Order executor instance
   * @returns {Promise<{position: RegimePositionState, openOrders: Map<string, PendingOrder>, discrepancies: string[]}>}
   */
  const recoverState = async (fillLedger, orderExecutor) => {
    console.log(`🔄 [${exchange}] Starting state recovery from exchange...`);
    const discrepancies = [];

    // 1. Fetch all open orders from exchange
    const openOrders = await adapter.getOpenOrders(productId);
    console.log(`📋 [${exchange}] Found ${openOrders.length} open orders`);

    // 2. Fetch recent fills (last 24h)
    const recentFills = await getRecentFills();
    console.log(`📋 [${exchange}] Found ${recentFills.length} recent fills`);

    // 3. Fetch current balances
    const baseCurrency = productId.split('-')[0];
    const quoteCurrency = productId.split('-')[1];
    const baseBalance = await adapter.getAccountBalance(baseCurrency);
    const quoteBalance = await adapter.getAccountBalance(quoteCurrency);

    console.log(`💰 [${exchange}] Balances: ${baseCurrency}=${baseBalance.available}, ${quoteCurrency}=${quoteBalance.available}`);

    // 4. Ingest all fills into ledger (idempotent)
    let newFillsIngested = 0;
    for (const fill of recentFills) {
      const result = fillLedger.ingestFill(fill);
      if (result.ingested) {
        newFillsIngested++;
      }
    }
    console.log(`📝 [${exchange}] Ingested ${newFillsIngested} new fills`);

    // 5. Rebuild position state from fill ledger
    const position = fillLedger.rebuildPositionFromFills();

    // 6. Map open orders to internal state
    orderExecutor.clearPendingOrders();
    for (const order of openOrders) {
      const pendingOrder = {
        type: order.side === 'BUY' ? 'entry' : 'take_profit',
        price: parseFloat(order.price || 0),
        size: parseFloat(order.filledSize || 0),
        sizeUsdc: 0, // Will be calculated if needed
        placedAt: new Date(order.createdTime).getTime(),
        recoveredFromExchange: true,
      };
      orderExecutor.restorePendingOrder(order.orderId, pendingOrder);
    }

    // 7. Validate position against base balance
    const expectedBTC = position.totalBTC;
    const actualBTC = baseBalance.available + baseBalance.hold;
    const btcDiff = Math.abs(expectedBTC - actualBTC);

    if (btcDiff > 0.00001) {
      discrepancies.push(`BTC discrepancy: expected=${expectedBTC.toFixed(8)}, actual=${actualBTC.toFixed(8)}`);
      console.log(`⚠️ [${exchange}] ${discrepancies[discrepancies.length - 1]}`);
      // Use exchange balance as truth
      position.totalBTC = roundBTC(actualBTC);
      // Recalculate avg cost if we have any position
      if (position.totalBTC > 0 && position.totalCostBasis > 0) {
        position.avgCostBasis = position.totalCostBasis / position.totalBTC;
      }
    }

    console.log(`✅ [${exchange}] Recovery complete: ${openOrders.length} open orders, ${position.totalBTC} ${baseCurrency} position`);

    return {
      position,
      openOrders: new Map(openOrders.map(o => [o.orderId, {
        type: o.side === 'BUY' ? 'entry' : 'take_profit',
        price: 0,
        size: 0,
        sizeUsdc: 0,
        placedAt: new Date(o.createdTime).getTime(),
        recoveredFromExchange: true,
      }])),
      discrepancies,
    };
  };

  /**
   * Get recent fills from exchange (last 24h)
   * @returns {Promise<Array>}
   */
  const getRecentFills = async () => {
    // Coinbase doesn't have a direct recent fills endpoint without order ID
    // We'll need to get fills from open orders that are partially filled
    // and from recently closed orders

    const fills = [];

    // Get fills from open orders
    const openOrders = await adapter.getOpenOrders(productId);
    for (const order of openOrders) {
      if (order.filledSize > 0) {
        const orderFills = await adapter.getOrderFills(order.orderId);
        fills.push(...orderFills);
      }
    }

    return fills;
  };

  /**
   * Validate current internal state against exchange
   * @param {RegimePositionState} position - Current position state
   * @returns {Promise<{valid: boolean, discrepancies: string[]}>}
   */
  const validateState = async (position) => {
    const discrepancies = [];

    const baseCurrency = productId.split('-')[0];
    const baseBalance = await adapter.getAccountBalance(baseCurrency);

    const expectedBTC = position.totalBTC;
    const actualBTC = baseBalance.available + baseBalance.hold;
    const btcDiff = Math.abs(expectedBTC - actualBTC);

    if (btcDiff > 0.00001) {
      discrepancies.push(`BTC: expected=${expectedBTC.toFixed(8)}, actual=${actualBTC.toFixed(8)}`);
    }

    return {
      valid: discrepancies.length === 0,
      discrepancies,
    };
  };

  /**
   * Reconcile internal state with exchange (periodic)
   * @param {RegimePositionState} position - Current position state
   * @param {Object} fillLedger - Fill ledger instance
   * @returns {Promise<{updated: boolean, position: RegimePositionState}>}
   */
  const reconcile = async (position, fillLedger) => {
    const validation = await validateState(position);

    if (!validation.valid) {
      console.log(`⚠️ [${exchange}] Reconciliation found discrepancies: ${validation.discrepancies.join(', ')}`);

      // Rebuild from fills
      const rebuiltPosition = fillLedger.rebuildPositionFromFills();

      // Use exchange balance for BTC
      const baseCurrency = productId.split('-')[0];
      const baseBalance = await adapter.getAccountBalance(baseCurrency);
      rebuiltPosition.totalBTC = roundBTC(baseBalance.available + baseBalance.hold);

      return {
        updated: true,
        position: rebuiltPosition,
      };
    }

    return {
      updated: false,
      position,
    };
  };

  /**
   * Get order fill summary for a specific order
   * @param {string} orderId - Order ID
   * @returns {Promise<{totalSize: number, totalValue: number, totalFees: number, avgPrice: number}>}
   */
  const getOrderFillSummary = async (orderId) => {
    const fills = await adapter.getOrderFills(orderId);

    let totalSize = 0;
    let totalValue = 0;
    let totalFees = 0;

    for (const fill of fills) {
      totalSize += fill.size;
      totalValue += fill.size * fill.price;
      totalFees += fill.netFee;
    }

    return {
      totalSize: roundBTC(totalSize),
      totalValue: roundUSDC(totalValue),
      totalFees: roundUSDC(totalFees),
      avgPrice: totalSize > 0 ? roundUSDC(totalValue / totalSize) : 0,
    };
  };

  return {
    recoverState,
    validateState,
    reconcile,
    getRecentFills,
    getOrderFillSummary,
  };
};

module.exports = {
  createRecoveryModule,
};
