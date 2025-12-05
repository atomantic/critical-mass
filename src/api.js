const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { getAuthHeaders } = require('./auth');

const BASE_URL = 'https://api.coinbase.com';

/**
 * Load API credentials from keys.json
 * @returns {{apiKey: string, apiSecret: string}}
 */
const loadCredentials = () => {
  const keys = require('../keys.json');
  // Handle both old format (name/privateKey) and direct format
  const apiKey = keys.name || keys.apiKey;
  const apiSecret = keys.privateKey || keys.apiSecret;
  return { apiKey, apiSecret };
};

/**
 * Make authenticated request to Coinbase API
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {Object} data - Request body (for POST)
 * @returns {Promise<Object>} API response data
 */
const makeRequest = async (method, path, data = null) => {
  const { apiKey, apiSecret } = loadCredentials();
  const headers = getAuthHeaders(apiKey, apiSecret, method, path);

  const config = {
    method,
    url: `${BASE_URL}${path}`,
    headers,
  };

  if (data) {
    config.data = data;
  }

  const response = await axios(config);
  return response.data;
};

/**
 * Get account balance for a specific currency (handles pagination)
 * Prefers non-vault accounts with balances
 * @param {string} currency - Currency code (e.g., 'USDC', 'BTC')
 * @returns {Promise<{available: number, hold: number, total: number}>}
 */
const getAccountBalance = async (currency) => {
  let cursor = null;
  let allMatchingAccounts = [];

  // Collect all accounts for this currency across pages
  do {
    const path = cursor
      ? `/api/v3/brokerage/accounts?limit=250&cursor=${cursor}`
      : '/api/v3/brokerage/accounts?limit=250';
    const data = await makeRequest('GET', path);

    const matches = data.accounts.filter(a => a.currency === currency);
    allMatchingAccounts = allMatchingAccounts.concat(matches);

    cursor = data.cursor;
  } while (cursor);

  if (allMatchingAccounts.length === 0) {
    return { available: 0, hold: 0, total: 0 };
  }

  // Prefer: non-vault with balance > default > any non-vault > first found
  const account = allMatchingAccounts.find(a =>
    a.type === 'ACCOUNT_TYPE_CRYPTO' &&
    (parseFloat(a.available_balance?.value || 0) > 0 || parseFloat(a.hold?.value || 0) > 0)
  ) || allMatchingAccounts.find(a => a.default === true)
    || allMatchingAccounts.find(a => a.type === 'ACCOUNT_TYPE_CRYPTO')
    || allMatchingAccounts[0];

  return {
    available: parseFloat(account.available_balance?.value || 0),
    hold: parseFloat(account.hold?.value || 0),
    total: parseFloat(account.available_balance?.value || 0) + parseFloat(account.hold?.value || 0),
  };
};

/**
 * Get current price for a product
 * @param {string} productId - Product ID (e.g., 'BTC-USDC')
 * @returns {Promise<number>} Current price
 */
const getCurrentPrice = async (productId) => {
  const data = await makeRequest('GET', `/api/v3/brokerage/products/${productId}`);
  return parseFloat(data.price);
};

/**
 * Get product details including base/quote increments
 * @param {string} productId - Product ID
 * @returns {Promise<Object>} Product details
 */
const getProductDetails = async (productId) => {
  const data = await makeRequest('GET', `/api/v3/brokerage/products/${productId}`);
  return {
    baseIncrement: data.base_increment,
    quoteIncrement: data.quote_increment,
    baseMinSize: data.base_min_size,
    quoteMinSize: data.quote_min_size,
    price: parseFloat(data.price),
  };
};

/**
 * Place a market buy order using quote currency (USDC)
 * @param {string} productId - Product ID (e.g., 'BTC-USDC')
 * @param {number} usdcAmount - Amount in USDC to spend
 * @returns {Promise<Object>} Order result
 */
const placeMarketBuy = async (productId, usdcAmount) => {
  const clientOrderId = uuidv4();

  const orderData = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: 'BUY',
    order_configuration: {
      market_market_ioc: {
        quote_size: usdcAmount.toFixed(2),
      },
    },
  };

  const result = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

  return {
    orderId: result.order_id || result.success_response?.order_id,
    clientOrderId,
    success: result.success || !!result.success_response,
    errorMessage: result.error_response?.message,
  };
};

/**
 * Place a post-only limit sell order
 * @param {string} productId - Product ID
 * @param {number} btcAmount - Amount of BTC to sell
 * @param {number} price - Limit price in USDC
 * @returns {Promise<Object>} Order result
 */
const placeLimitSell = async (productId, btcAmount, price) => {
  const clientOrderId = uuidv4();

  // Get product details for proper rounding
  const product = await getProductDetails(productId);

  // Round to proper increments
  const baseIncrement = parseFloat(product.baseIncrement);
  const quoteIncrement = parseFloat(product.quoteIncrement);

  const roundedAmount = Math.floor(btcAmount / baseIncrement) * baseIncrement;
  const roundedPrice = Math.floor(price / quoteIncrement) * quoteIncrement;

  const orderData = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: 'SELL',
    order_configuration: {
      limit_limit_gtc: {
        base_size: roundedAmount.toFixed(8),
        limit_price: roundedPrice.toFixed(2),
        post_only: true,
      },
    },
  };

  const result = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

  return {
    orderId: result.order_id || result.success_response?.order_id,
    clientOrderId,
    success: result.success || !!result.success_response,
    errorMessage: result.error_response?.message,
    baseSize: roundedAmount,
    limitPrice: roundedPrice,
  };
};

/**
 * Get order details by order ID (includes fee info)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Order details
 */
const getOrder = async (orderId) => {
  const data = await makeRequest('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
  const order = data.order;

  return {
    orderId: order.order_id,
    productId: order.product_id,
    side: order.side,
    status: order.status,
    filledSize: parseFloat(order.filled_size || 0),
    filledValue: parseFloat(order.filled_value || 0),
    averageFilledPrice: parseFloat(order.average_filled_price || 0),
    completionPercentage: parseFloat(order.completion_percentage || 0),
    totalFees: parseFloat(order.total_fees || 0),
    createdTime: order.created_time,
  };
};

/**
 * Get all open orders for a product
 * @param {string} productId - Product ID
 * @returns {Promise<Array>} List of open orders
 */
const getOpenOrders = async (productId) => {
  const data = await makeRequest('GET', `/api/v3/brokerage/orders/historical?product_id=${productId}&order_status=OPEN`);

  return (data.orders || []).map(order => ({
    orderId: order.order_id,
    productId: order.product_id,
    side: order.side,
    status: order.status,
    filledSize: parseFloat(order.filled_size || 0),
    createdTime: order.created_time,
  }));
};

/**
 * Cancel an order
 * @param {string} orderId - Order ID to cancel
 * @returns {Promise<Object>} Cancel result
 */
const cancelOrder = async (orderId) => {
  const result = await makeRequest('POST', '/api/v3/brokerage/orders/batch_cancel', {
    order_ids: [orderId],
  });

  return {
    success: result.results?.[0]?.success || false,
  };
};

/**
 * Get fills for an order with detailed fee/rebate info
 * @param {string} orderId - Order ID
 * @returns {Promise<Array>} List of fills with fee details
 */
const getOrderFills = async (orderId) => {
  const data = await makeRequest('GET', `/api/v3/brokerage/orders/historical/fills?order_id=${orderId}`);

  return (data.fills || []).map(fill => {
    // Extract detailed commission breakdown
    const commissionDetail = fill.commission_detail_total || {};

    return {
      tradeId: fill.trade_id,
      orderId: fill.order_id,
      productId: fill.product_id,
      side: fill.side,
      price: parseFloat(fill.price),
      size: parseFloat(fill.size),
      sizeInQuote: parseFloat(fill.size_in_quote || 0),
      // Fee breakdown
      commission: parseFloat(fill.commission || 0),
      totalCommission: parseFloat(commissionDetail.total_commission || fill.commission || 0),
      rebate: parseFloat(commissionDetail.rebate || 0),
      netFee: parseFloat(commissionDetail.total_commission || fill.commission || 0) - parseFloat(commissionDetail.rebate || 0),
      // Raw commission detail for debugging
      commissionDetail: commissionDetail,
      tradeTime: fill.trade_time,
      liquidityIndicator: fill.liquidity_indicator, // MAKER or TAKER
    };
  });
};

/**
 * Get aggregated fill info for an order (total fees, rebates, etc.)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Aggregated fill information
 */
const getOrderFillSummary = async (orderId) => {
  const fills = await getOrderFills(orderId);

  const summary = fills.reduce((acc, fill) => {
    acc.totalSize += fill.size;
    acc.totalValue += fill.size * fill.price;
    acc.totalFees += fill.totalCommission;
    acc.totalRebates += fill.rebate;
    acc.netFees += fill.netFee;
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
};

module.exports = {
  loadCredentials,
  getAccountBalance,
  getCurrentPrice,
  getProductDetails,
  placeMarketBuy,
  placeLimitSell,
  getOrder,
  getOpenOrders,
  cancelOrder,
  getOrderFills,
  getOrderFillSummary,
};
