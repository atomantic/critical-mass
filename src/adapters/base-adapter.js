// @ts-check
/**
 * Base adapter interface definition
 * All exchange adapters must implement these methods
 */

/**
 * @typedef {import('../types').FillSummary} FillSummary
 * @typedef {import('../types').OrderFill} OrderFill
 */

/**
 * Required adapter methods that each exchange must implement:
 *
 * loadCredentials() - Load API credentials from keys file
 *   @returns {{apiKey: string, apiSecret: string}}
 *
 * getAccountBalance(currency) - Get account balance for a currency
 *   @param {string} currency - Currency code (e.g., 'USDC', 'BTC', 'USD')
 *   @returns {Promise<{available: number, hold: number, total: number}>}
 *
 * getCurrentPrice(productId) - Get current price for a product
 *   @param {string} productId - Product ID (e.g., 'BTC-USDC', 'BTCUSD')
 *   @returns {Promise<number>}
 *
 * getProductDetails(productId) - Get product trading details
 *   @param {string} productId - Product ID
 *   @returns {Promise<{baseIncrement: string, quoteIncrement: string, baseMinSize: string, quoteMinSize: string, price: number}>}
 *
 * placeMarketBuy(productId, quoteAmount) - Place market buy order
 *   @param {string} productId - Product ID
 *   @param {number} quoteAmount - Amount in quote currency to spend
 *   @returns {Promise<{orderId: string, clientOrderId: string, success: boolean, errorMessage?: string}>}
 *
 * placeLimitSell(productId, baseAmount, price) - Place limit sell order
 *   @param {string} productId - Product ID
 *   @param {number} baseAmount - Amount of base currency to sell
 *   @param {number} price - Limit price in quote currency
 *   @returns {Promise<{orderId: string, clientOrderId: string, success: boolean, errorMessage?: string, baseSize: number, limitPrice: number}>}
 *
 * getOrder(orderId) - Get order details
 *   @param {string} orderId - Order ID
 *   @returns {Promise<{orderId: string, productId: string, side: string, status: string, filledSize: number, filledValue: number, averageFilledPrice: number, completionPercentage: number, totalFees: number, createdTime: string}>}
 *
 * getOpenOrders(productId) - Get all open orders for a product
 *   @param {string} productId - Product ID
 *   @returns {Promise<Array<{orderId: string, productId: string, side: string, status: string, filledSize: number, createdTime: string}>>}
 *
 * cancelOrder(orderId) - Cancel an order
 *   @param {string} orderId - Order ID
 *   @returns {Promise<{success: boolean}>}
 *
 * getOrderFills(orderId) - Get fills for an order
 *   @param {string} orderId - Order ID
 *   @returns {Promise<Array>}
 *
 * getCandles(productId, start, end, granularity) - Get historical price candles
 *   @param {string} productId - Product ID
 *   @param {number} start - Start timestamp (seconds)
 *   @param {number} end - End timestamp (seconds)
 *   @param {string} granularity - Candle granularity
 *   @returns {Promise<Array<{timestamp: number, open: number, high: number, low: number, close: number, volume: number}>>}
 */

const REQUIRED_METHODS = [
  'loadCredentials',
  'getAccountBalance',
  'getCurrentPrice',
  'getProductDetails',
  'placeMarketBuy',
  'placeLimitSell',
  'getOrder',
  'getOpenOrders',
  'cancelOrder',
  'getOrderFills',
  'getCandles',
];

/**
 * Validate that an adapter implements all required methods
 * @param {Object} adapter - Adapter instance to validate
 * @param {string} name - Adapter name for error messages
 * @returns {void}
 * @throws {Error} If adapter is missing required methods
 */
const validateAdapter = (adapter, name) => {
  const missing = REQUIRED_METHODS.filter(method => typeof adapter[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Adapter '${name}' missing required methods: ${missing.join(', ')}`);
  }
};

/**
 * Create a base adapter with default implementations (for optional methods)
 * @param {string} exchangeName - Name of the exchange
 * @returns {{name: string, getOrderFillSummary: (orderId: string) => Promise<FillSummary>}} Base adapter object
 */
const createBaseAdapter = (exchangeName) => ({
  name: exchangeName,

  /**
   * Get aggregated fill info for an order
   * Default implementation that works with getOrderFills
   * @param {string} orderId - Order ID
   * @returns {Promise<FillSummary>}
   */
  getOrderFillSummary: async function(orderId) {
    const fills = await this.getOrderFills(orderId);

    const summary = fills.reduce((acc, fill) => {
      acc.totalSize += fill.size || 0;
      acc.totalValue += (fill.size || 0) * (fill.price || 0);
      acc.totalFees += fill.totalCommission || fill.commission || 0;
      acc.totalRebates += fill.rebate || 0;
      acc.netFees += fill.netFee || 0;
      return acc;
    }, {
      totalSize: 0,
      totalValue: 0,
      totalFees: 0,
      totalRebates: 0,
      netFees: 0,
    });

    summary.fillCount = fills.length;
    summary.averagePrice = summary.totalSize > 0 ? summary.totalValue / summary.totalSize : 0;
    summary.fills = fills;

    return summary;
  },
});

module.exports = {
  REQUIRED_METHODS,
  validateAdapter,
  createBaseAdapter,
};
