// @ts-check
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthHeaders } = require('./auth');
const { createBaseAdapter } = require('../base-adapter');

/**
 * @typedef {import('../../types').AccountBalance} AccountBalance
 * @typedef {import('../../types').ProductDetails} ProductDetails
 * @typedef {import('../../types').MarketBuyResult} MarketBuyResult
 * @typedef {import('../../types').LimitSellResult} LimitSellResult
 * @typedef {import('../../types').OrderDetails} OrderDetails
 * @typedef {import('../../types').OpenOrder} OpenOrder
 * @typedef {import('../../types').CancelResult} CancelResult
 * @typedef {import('../../types').OrderFill} OrderFill
 * @typedef {import('../../types').Candle} Candle
 * @typedef {import('../../types').ApiCredentials} ApiCredentials
 * @typedef {import('../../types').ExchangeAdapter} ExchangeAdapter
 */

const BASE_URL = 'https://api.coinbase.com';

/**
 * Create a Coinbase adapter instance
 * @param {string|null} [keysPath] - Path to keys file (defaults to data/coinbase-keys.json)
 * @returns {ExchangeAdapter} Coinbase adapter with all required methods
 */
const createCoinbaseAdapter = (keysPath = null) => {
  // Resolve keys path
  const resolvedKeysPath = keysPath || path.join(__dirname, '..', '..', '..', 'data', 'coinbase-keys.json');

  // Start with base adapter
  const adapter = createBaseAdapter('coinbase');

  /**
   * Check if keys file exists and contains valid-looking credentials
   * @returns {boolean}
   */
  adapter.hasValidKeys = () => {
    const legacyPath = path.join(__dirname, '..', '..', '..', 'keys.json');
    const keysFile = fs.existsSync(resolvedKeysPath) ? resolvedKeysPath :
                     fs.existsSync(legacyPath) ? legacyPath : null;

    if (!keysFile) return false;

    const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    const apiKey = keys.name || keys.apiKey;
    const apiSecret = keys.privateKey || keys.apiSecret;

    // Check for valid-looking credentials
    if (!apiKey || !apiSecret) return false;
    if (apiKey.length < 10) return false;
    // Coinbase private key should be PEM format or at least 50 chars
    if (!apiSecret.includes('-----BEGIN') && apiSecret.length < 50) return false;

    return true;
  };

  /**
   * Load API credentials from keys file
   * @returns {ApiCredentials}
   * @throws {Error} If keys file is missing or invalid
   */
  adapter.loadCredentials = () => {
    // Check for legacy keys.json first for backward compatibility
    const legacyPath = path.join(__dirname, '..', '..', '..', 'keys.json');
    let keysFile = resolvedKeysPath;

    if (!fs.existsSync(resolvedKeysPath) && fs.existsSync(legacyPath)) {
      keysFile = legacyPath;
    }

    if (!fs.existsSync(keysFile)) {
      throw new Error('API keys not configured. Please add your Coinbase API keys.');
    }

    const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    // Handle both old format (name/privateKey) and direct format
    const apiKey = keys.name || keys.apiKey;
    const apiSecret = keys.privateKey || keys.apiSecret;

    if (!apiKey || !apiSecret) {
      throw new Error('Invalid API keys. Both API key name and private key are required.');
    }

    return { apiKey, apiSecret };
  };

  /**
   * Make authenticated request to Coinbase API
   * @param {string} method - HTTP method
   * @param {string} apiPath - API path
   * @param {Object|null} [data] - Request body (for POST)
   * @returns {Promise<any>} API response data
   */
  const makeRequest = async (method, apiPath, data = null) => {
    const { apiKey, apiSecret } = adapter.loadCredentials();
    const headers = getAuthHeaders(apiKey, apiSecret, method, apiPath);

    const config = {
      method,
      url: `${BASE_URL}${apiPath}`,
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
   * @returns {Promise<AccountBalance>}
   */
  adapter.getAccountBalance = async (currency) => {
    let cursor = null;
    let allMatchingAccounts = [];

    // Collect all accounts for this currency across pages
    do {
      const apiPath = cursor
        ? `/api/v3/brokerage/accounts?limit=250&cursor=${cursor}`
        : '/api/v3/brokerage/accounts?limit=250';
      const data = await makeRequest('GET', apiPath);

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
  adapter.getCurrentPrice = async (productId) => {
    const data = await makeRequest('GET', `/api/v3/brokerage/products/${productId}`);
    return parseFloat(data.price);
  };

  /**
   * Get product details including base/quote increments
   * @param {string} productId - Product ID
   * @returns {Promise<ProductDetails>} Product details
   */
  adapter.getProductDetails = async (productId) => {
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
   * @param {number} quoteAmount - Amount in quote currency to spend
   * @returns {Promise<MarketBuyResult>} Order result
   */
  adapter.placeMarketBuy = async (productId, quoteAmount) => {
    const clientOrderId = uuidv4();

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'BUY',
      order_configuration: {
        market_market_ioc: {
          quote_size: quoteAmount.toFixed(2),
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
   * @param {number} baseAmount - Amount of base currency to sell
   * @param {number} price - Limit price in quote currency
   * @returns {Promise<LimitSellResult>} Order result
   */
  adapter.placeLimitSell = async (productId, baseAmount, price) => {
    const clientOrderId = uuidv4();

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);

    // Round to proper increments
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);

    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
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
   * @returns {Promise<OrderDetails>} Order details
   */
  adapter.getOrder = async (orderId) => {
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
   * @returns {Promise<OpenOrder[]>} List of open orders
   */
  adapter.getOpenOrders = async (productId) => {
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
   * @returns {Promise<CancelResult>} Cancel result
   */
  adapter.cancelOrder = async (orderId) => {
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
   * @returns {Promise<OrderFill[]>} List of fills with fee details
   */
  adapter.getOrderFills = async (orderId) => {
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
   * Get historical price candles
   * @param {string} productId - Product ID
   * @param {number} start - Start timestamp (seconds)
   * @param {number} end - End timestamp (seconds)
   * @param {string} granularity - Candle granularity (e.g., 'ONE_DAY', 'ONE_HOUR')
   * @returns {Promise<Candle[]>} Array of candle data
   */
  adapter.getCandles = async (productId, start, end, granularity) => {
    const apiPath = `/api/v3/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`;
    const data = await makeRequest('GET', apiPath);

    return (data.candles || []).map(c => ({
      timestamp: parseInt(c.start) * 1000,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));
  };

  return adapter;
};

// Create default instance for backward compatibility
const defaultAdapter = createCoinbaseAdapter();

module.exports = {
  createCoinbaseAdapter,
  // Export individual functions for backward compatibility
  loadCredentials: defaultAdapter.loadCredentials,
  getAccountBalance: defaultAdapter.getAccountBalance,
  getCurrentPrice: defaultAdapter.getCurrentPrice,
  getProductDetails: defaultAdapter.getProductDetails,
  placeMarketBuy: defaultAdapter.placeMarketBuy,
  placeLimitSell: defaultAdapter.placeLimitSell,
  getOrder: defaultAdapter.getOrder,
  getOpenOrders: defaultAdapter.getOpenOrders,
  cancelOrder: defaultAdapter.cancelOrder,
  getOrderFills: defaultAdapter.getOrderFills,
  getOrderFillSummary: defaultAdapter.getOrderFillSummary,
  getCandles: defaultAdapter.getCandles,
};
