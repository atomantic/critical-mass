// @ts-check
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAuthHeaders } = require('./auth');
const { createBaseAdapter } = require('../base-adapter');

/**
 * @typedef {import('../../types').AccountBalance} AccountBalance
 * @typedef {import('../../types').ProductDetails} ProductDetails
 * @typedef {import('../../types').MarketBuyResult} MarketBuyResult
 * @typedef {import('../../types').LimitSellResult} LimitSellResult
 * @typedef {import('../../types').LimitBuyResult} LimitBuyResult
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
   * Check if error is a transient network error that should be retried
   * @param {Error} err - Error object
   * @returns {boolean}
   */
  const isTransientNetworkError = (err) => {
    const msg = err.message || '';
    const code = err.code || '';
    // Network errors that are transient and should be retried
    return code === 'ETIMEDOUT' ||
           code === 'ECONNRESET' ||
           code === 'ECONNREFUSED' ||
           code === 'ENOTFOUND' ||
           code === 'EPIPE' ||
           msg.includes('ETIMEDOUT') ||
           msg.includes('ECONNRESET') ||
           msg.includes('socket disconnected') ||
           msg.includes('TLS connection') ||
           msg.includes('network socket') ||
           msg.includes('timeout') ||
           msg.includes('aborted');
  };

  /**
   * Make authenticated request to Coinbase API with retry logic
   * @param {string} method - HTTP method
   * @param {string} apiPath - API path
   * @param {Object|null} [data] - Request body (for POST)
   * @param {number} [retries=3] - Number of retries for transient errors
   * @returns {Promise<any>} API response data
   */
  const makeRequest = async (method, apiPath, data = null, retries = 3) => {
    const { apiKey, apiSecret } = adapter.loadCredentials();
    const headers = getAuthHeaders(apiKey, apiSecret, method, apiPath);

    const fetchOptions = {
      method,
      headers,
    };

    if (data) {
      fetchOptions.headers = { ...headers, 'Content-Type': 'application/json' };
      fetchOptions.body = JSON.stringify(data);
    }

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        response = await fetch(`${BASE_URL}${apiPath}`, {
          ...fetchOptions,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = err;
        response = null;
      } finally {
        clearTimeout(timeout);
      }

      if (response) {
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          const message = errData.message || errData.error_details || response.statusText;
          const errorData = errData.error || '';
          const cleanError = new Error(`Coinbase API ${response.status}: ${message}${errorData ? ` (${errorData})` : ''}`);
          cleanError.status = response.status;
          cleanError.endpoint = `${method} ${apiPath}`;
          throw cleanError;
        }
        return response.json();
      }

      // Check if we should retry
      if (attempt < retries && isTransientNetworkError(lastError)) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`⚠️ [coinbase] Network error on ${method} ${apiPath.split('?')[0]}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error or out of retries
      const cleanError = new Error(`Coinbase API network error: ${lastError.message}`);
      cleanError.status = 'network';
      cleanError.endpoint = `${method} ${apiPath}`;
      throw cleanError;
    }
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
   * Get current bid/ask for a product
   * @param {string} productId - Product ID (e.g., 'BTC-USDC')
   * @returns {Promise<{bid: number, ask: number}>} Bid and ask prices
   */
  adapter.getBidAsk = async (productId) => {
    const data = await makeRequest('GET', `/api/v3/brokerage/best_bid_ask?product_ids=${productId}`);
    const pricebook = data.pricebooks?.[0];
    return {
      bid: parseFloat(pricebook?.bids?.[0]?.price || 0),
      ask: parseFloat(pricebook?.asks?.[0]?.price || 0),
    };
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
    const clientOrderId = crypto.randomUUID();

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
  adapter.placeLimitSell = async (productId, baseAmount, price, options = {}) => {
    const clientOrderId = crypto.randomUUID();
    const postOnly = options.postOnly !== false; // Default to true

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);

    // Round to proper increments
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);

    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
    const roundedPrice = Math.floor(price / quoteIncrement) * quoteIncrement;

    // Derive decimal precision from increments
    const basePrecision = Math.max(0, -Math.floor(Math.log10(baseIncrement)));
    const quotePrecision = Math.max(0, -Math.floor(Math.log10(quoteIncrement)));

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'SELL',
      order_configuration: {
        limit_limit_gtc: {
          base_size: roundedAmount.toFixed(basePrecision),
          limit_price: roundedPrice.toFixed(quotePrecision),
          post_only: postOnly,
        },
      },
    };

    const result = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

    return {
      orderId: result.order_id || result.success_response?.order_id,
      clientOrderId,
      success: result.success || !!result.success_response,
      errorMessage: result.failure_response?.message || result.error_response?.message,
      baseSize: roundedAmount,
      limitPrice: roundedPrice,
    };
  };

  /**
   * Place a post-only limit buy order (maker-prefer)
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to buy
   * @param {number} price - Limit price in quote currency
   * @param {Object} [options] - Order options
   * @param {boolean} [options.postOnly] - Whether to use post-only mode (default: true)
   * @returns {Promise<LimitBuyResult>} Order result
   */
  adapter.placeLimitBuy = async (productId, baseAmount, price, options = {}) => {
    const clientOrderId = crypto.randomUUID();
    const postOnly = options.postOnly !== false; // Default to true

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);

    // Round to proper increments
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);

    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
    const roundedPrice = Math.floor(price / quoteIncrement) * quoteIncrement;

    // Derive decimal precision from increments
    const basePrecision = Math.max(0, -Math.floor(Math.log10(baseIncrement)));
    const quotePrecision = Math.max(0, -Math.floor(Math.log10(quoteIncrement)));

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'BUY',
      order_configuration: {
        limit_limit_gtc: {
          base_size: roundedAmount.toFixed(basePrecision),
          limit_price: roundedPrice.toFixed(quotePrecision),
          post_only: postOnly,
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
      postOnly,
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
    const data = await makeRequest('GET', `/api/v3/brokerage/orders/historical/batch?product_ids=${productId}&order_status=OPEN`);

    return (data.orders || []).map(order => {
      // Extract size and price from order configuration (varies by order type)
      const cfg = order.order_configuration || {};
      const limitCfg = cfg.limit_limit_gtc || cfg.limit_limit_gtd || cfg.limit_limit_fok || {};
      const stopCfg = cfg.stop_limit_stop_limit_gtc || cfg.stop_limit_stop_limit_gtd || {};
      const size = parseFloat(limitCfg.base_size || stopCfg.base_size || 0);
      const price = parseFloat(limitCfg.limit_price || stopCfg.limit_price || 0);

      return {
        orderId: order.order_id,
        productId: order.product_id,
        side: order.side,
        status: order.status,
        size,
        price,
        filledSize: parseFloat(order.filled_size || 0),
        createdTime: order.created_time,
      };
    });
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

  /**
   * Place a stop-limit sell order (GTC)
   * Triggers a limit sell when price drops to stopPrice
   * @param {string} productId - Product ID (e.g., 'BTC-USDC')
   * @param {number} baseAmount - Amount of base currency to sell
   * @param {number} stopPrice - Price that triggers the order
   * @param {number} limitPrice - Limit price for execution once triggered
   * @returns {Promise<{orderId: string, clientOrderId: string, success: boolean, errorMessage?: string, baseSize: number, stopPrice: number, limitPrice: number}>}
   */
  adapter.placeStopLimitSell = async (productId, baseAmount, stopPrice, limitPrice) => {
    const clientOrderId = crypto.randomUUID();

    const product = await adapter.getProductDetails(productId);

    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);

    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
    const roundedStopPrice = Math.floor(stopPrice / quoteIncrement) * quoteIncrement;
    const roundedLimitPrice = Math.floor(limitPrice / quoteIncrement) * quoteIncrement;

    const basePrecision = Math.max(0, -Math.floor(Math.log10(baseIncrement)));
    const quotePrecision = Math.max(0, -Math.floor(Math.log10(quoteIncrement)));

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'SELL',
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: roundedAmount.toFixed(basePrecision),
          limit_price: roundedLimitPrice.toFixed(quotePrecision),
          stop_price: roundedStopPrice.toFixed(quotePrecision),
          stop_direction: 'STOP_DIRECTION_STOP_DOWN',
        },
      },
    };

    const result = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

    return {
      orderId: result.order_id || result.success_response?.order_id,
      clientOrderId,
      success: result.success || !!result.success_response,
      errorMessage: result.failure_response?.message || result.error_response?.message,
      baseSize: roundedAmount,
      stopPrice: roundedStopPrice,
      limitPrice: roundedLimitPrice,
    };
  };

  /**
   * Place a market sell order using base currency amount
   * @param {string} productId - Product ID (e.g., 'BTC-USDC')
   * @param {number} baseAmount - Amount of base currency to sell
   * @returns {Promise<{orderId: string, clientOrderId: string, success: boolean, errorMessage?: string, baseSize: number}>}
   */
  adapter.placeMarketSell = async (productId, baseAmount) => {
    const clientOrderId = crypto.randomUUID();

    const product = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(product.baseIncrement);
    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
    const basePrecision = Math.max(0, -Math.floor(Math.log10(baseIncrement)));

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'SELL',
      order_configuration: {
        market_market_ioc: {
          base_size: roundedAmount.toFixed(basePrecision),
        },
      },
    };

    const result = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

    return {
      orderId: result.order_id || result.success_response?.order_id,
      clientOrderId,
      success: result.success || !!result.success_response,
      errorMessage: result.failure_response?.message || result.error_response?.message,
      baseSize: roundedAmount,
    };
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
  getBidAsk: defaultAdapter.getBidAsk,
  getProductDetails: defaultAdapter.getProductDetails,
  placeMarketBuy: defaultAdapter.placeMarketBuy,
  placeLimitBuy: defaultAdapter.placeLimitBuy,
  placeLimitSell: defaultAdapter.placeLimitSell,
  getOrder: defaultAdapter.getOrder,
  getOpenOrders: defaultAdapter.getOpenOrders,
  cancelOrder: defaultAdapter.cancelOrder,
  getOrderFills: defaultAdapter.getOrderFills,
  getOrderFillSummary: defaultAdapter.getOrderFillSummary,
  getCandles: defaultAdapter.getCandles,
  placeStopLimitSell: defaultAdapter.placeStopLimitSell,
  placeMarketSell: defaultAdapter.placeMarketSell,
};
