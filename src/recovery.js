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
    // Use CURRENT CYCLE fills only - completed cycles should not affect current position
    // The fill ledger tracks cycle IDs, so getCurrentCycleFills() returns only active cycle
    const currentCycleFills = fillLedger.getCurrentCycleFills();
    const position = fillLedger.rebuildPositionFromFills(currentCycleFills);
    console.log(`📊 [${exchange}] Rebuilt position from ${currentCycleFills.length} current cycle fills`);

    // 6. Note: We do NOT restore all exchange orders to the order executor
    // The regime engine should only track orders IT places, not orders from other engines (like DCA)
    // Exchange open orders are used only for validation and offline fill detection
    console.log(`📋 [${exchange}] Exchange has ${openOrders.length} open orders (regime engine tracks its own orders separately)`);

    // 7. Compare position against base balance (informational only)
    // NOTE: Account may have BTC from other sources - we only track what regime engine traded
    const trackedBTC = position.totalBTC;
    const accountBTC = baseBalance.available + baseBalance.hold;

    if (accountBTC > trackedBTC + 0.00001) {
      // Account has more BTC than we're tracking - this is expected if user has other holdings
      console.log(`ℹ️ [${exchange}] Account has ${accountBTC.toFixed(8)} BTC, regime engine tracking ${trackedBTC.toFixed(8)} BTC (other holdings not tracked)`);
    } else if (trackedBTC > accountBTC + 0.00001) {
      // We're tracking more than exists - this is a real problem
      discrepancies.push(`BTC tracking error: tracking ${trackedBTC.toFixed(8)} but only ${accountBTC.toFixed(8)} in account`);
      console.log(`⚠️ [${exchange}] ${discrepancies[discrepancies.length - 1]}`);
    }

    console.log(`✅ [${exchange}] Recovery complete: ${position.totalBTC} ${baseCurrency} tracked position`);

    return {
      position,
      openOrders: new Map(), // Regime engine tracks its own orders, not all exchange orders
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

    const trackedBTC = position.totalBTC;
    const accountBTC = baseBalance.available + baseBalance.hold;

    // Only flag as discrepancy if we're tracking MORE than exists in account
    // Account having extra BTC is fine (user's other holdings)
    if (trackedBTC > accountBTC + 0.00001) {
      discrepancies.push(`Tracking ${trackedBTC.toFixed(8)} BTC but only ${accountBTC.toFixed(8)} in account`);
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

      // Rebuild from fills only - don't use exchange balance as it may include other holdings
      const rebuiltPosition = fillLedger.rebuildPositionFromFills();

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
