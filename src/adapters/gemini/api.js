// @ts-check
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { getWebSocketAuthHeaders, getRestAuthHeaders } = require('./auth');
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

const REST_BASE_URL = 'https://api.gemini.com';
const WS_FAST_API_URL = 'wss://api.gemini.com/v1/order/events';
const WS_MARKET_DATA_URL = 'wss://api.gemini.com/v1/marketdata';

/**
 * Create a Gemini adapter instance
 * @param {string|null} [keysPath] - Path to keys file (defaults to data/gemini-keys.json)
 * @returns {ExchangeAdapter} Gemini adapter with all required methods
 */
const createGeminiAdapter = (keysPath = null) => {
  // Resolve keys path
  const resolvedKeysPath = keysPath || path.join(__dirname, '..', '..', '..', 'data', 'gemini-keys.json');

  // Start with base adapter
  const adapter = createBaseAdapter('gemini');

  // WebSocket connection state
  let wsConnection = null;
  let wsConnected = false;
  const pendingOrders = new Map();
  const orderUpdates = new Map();

  /**
   * Check if keys file exists and contains valid-looking credentials
   * @returns {boolean}
   */
  adapter.hasValidKeys = () => {
    if (!fs.existsSync(resolvedKeysPath)) return false;

    const keys = JSON.parse(fs.readFileSync(resolvedKeysPath, 'utf8'));
    const apiKey = keys.apiKey || keys.key;
    const apiSecret = keys.apiSecret || keys.secret;

    // Check for valid-looking credentials
    if (!apiKey || !apiSecret) return false;
    if (apiKey.length < 10 || apiSecret.length < 10) return false;

    return true;
  };

  /**
   * Load API credentials from keys file
   * @returns {ApiCredentials}
   */
  adapter.loadCredentials = () => {
    if (!fs.existsSync(resolvedKeysPath)) {
      throw new Error('API keys not configured. Please add your Gemini API keys.');
    }

    const keys = JSON.parse(fs.readFileSync(resolvedKeysPath, 'utf8'));
    const apiKey = keys.apiKey || keys.key;
    const apiSecret = keys.apiSecret || keys.secret;

    if (!apiKey || !apiSecret) {
      throw new Error('Invalid API keys. Both API key and secret are required.');
    }

    return { apiKey, apiSecret };
  };

  /**
   * Make authenticated REST request to Gemini API
   * @param {string} endpoint - API endpoint (e.g., '/v1/balances')
   * @param {Object} [payload] - Request payload
   * @returns {Promise<any>} API response
   */
  const makeRestRequest = async (endpoint, payload = {}) => {
    const { apiKey, apiSecret } = adapter.loadCredentials();
    const headers = getRestAuthHeaders(apiKey, apiSecret, endpoint, payload);

    const response = await axios.post(`${REST_BASE_URL}${endpoint}`, null, { headers });
    return response.data;
  };

  /**
   * Make public REST request (no auth)
   * @param {string} endpoint - API endpoint
   * @returns {Promise<any>} API response
   */
  const makePublicRequest = async (endpoint) => {
    const response = await axios.get(`${REST_BASE_URL}${endpoint}`);
    return response.data;
  };

  /**
   * Convert product ID to Gemini symbol format
   * Coinbase: BTC-USDC -> Gemini: btcusd (lowercase, no dash)
   * @param {string} productId - Product ID in standard format
   * @returns {string} Gemini symbol
   */
  const toGeminiSymbol = (productId) => {
    // Handle common conversions
    const symbol = productId.toLowerCase().replace('-', '');
    // USDC on Gemini might be different
    return symbol.replace('usdc', 'usd');
  };

  /**
   * Get account balance for a specific currency
   * @param {string} currency - Currency code (e.g., 'USD', 'BTC')
   * @returns {Promise<AccountBalance>}
   */
  adapter.getAccountBalance = async (currency) => {
    // Map USDC to USD for Gemini
    const geminiCurrency = currency.toUpperCase() === 'USDC' ? 'USD' : currency.toUpperCase();

    const balances = await makeRestRequest('/v1/balances');

    const account = balances.find(b => b.currency.toUpperCase() === geminiCurrency);

    if (!account) {
      return { available: 0, hold: 0, total: 0 };
    }

    const available = parseFloat(account.available || 0);
    const total = parseFloat(account.amount || 0);
    const hold = total - available;

    return { available, hold, total };
  };

  /**
   * Get current price for a product
   * @param {string} productId - Product ID (e.g., 'BTC-USD' or 'BTCUSD')
   * @returns {Promise<number>} Current price
   */
  adapter.getCurrentPrice = async (productId) => {
    const symbol = toGeminiSymbol(productId);
    const ticker = await makePublicRequest(`/v1/pubticker/${symbol}`);
    return parseFloat(ticker.last);
  };

  /**
   * Get product details
   * @param {string} productId - Product ID
   * @returns {Promise<ProductDetails>} Product details
   */
  adapter.getProductDetails = async (productId) => {
    const symbol = toGeminiSymbol(productId);
    const details = await makePublicRequest(`/v1/symbols/details/${symbol}`);
    const price = await adapter.getCurrentPrice(productId);

    return {
      baseIncrement: details.tick_size?.toString() || '0.00000001',
      quoteIncrement: details.quote_increment?.toString() || '0.01',
      baseMinSize: details.min_order_size?.toString() || '0.00001',
      quoteMinSize: (parseFloat(details.min_order_size || 0.00001) * price).toString(),
      price,
    };
  };

  /**
   * Place a market buy order
   * Gemini doesn't have true market orders, so we use IOC limit at slightly above market
   * @param {string} productId - Product ID
   * @param {number} quoteAmount - Amount in quote currency to spend
   * @returns {Promise<MarketBuyResult>} Order result
   */
  adapter.placeMarketBuy = async (productId, quoteAmount) => {
    const symbol = toGeminiSymbol(productId);
    const clientOrderId = uuidv4().replace(/-/g, '').substring(0, 32);

    // Get current price and add slippage for IOC order
    const currentPrice = await adapter.getCurrentPrice(productId);
    const slippagePrice = currentPrice * 1.005; // 0.5% slippage allowance
    const quantity = quoteAmount / slippagePrice;

    const orderPayload = {
      symbol,
      amount: quantity.toFixed(8),
      price: slippagePrice.toFixed(2),
      side: 'buy',
      type: 'exchange limit',
      client_order_id: clientOrderId,
      options: ['immediate-or-cancel'], // IOC to simulate market order
    };

    const result = await makeRestRequest('/v1/order/new', orderPayload);

    const success = !result.is_cancelled && result.order_id;

    return {
      orderId: result.order_id,
      clientOrderId,
      success,
      errorMessage: result.reason || (result.is_cancelled ? 'Order was cancelled' : null),
    };
  };

  /**
   * Place a limit sell order
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to sell
   * @param {number} price - Limit price
   * @returns {Promise<LimitSellResult>} Order result
   */
  adapter.placeLimitSell = async (productId, baseAmount, price) => {
    const symbol = toGeminiSymbol(productId);
    const clientOrderId = uuidv4().replace(/-/g, '').substring(0, 32);

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);

    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
    const roundedPrice = Math.floor(price / quoteIncrement) * quoteIncrement;

    const orderPayload = {
      symbol,
      amount: roundedAmount.toFixed(8),
      price: roundedPrice.toFixed(2),
      side: 'sell',
      type: 'exchange limit',
      client_order_id: clientOrderId,
      options: ['maker-or-cancel'], // Post-only equivalent
    };

    const result = await makeRestRequest('/v1/order/new', orderPayload);

    const success = !result.is_cancelled && result.order_id;

    return {
      orderId: result.order_id,
      clientOrderId,
      success,
      errorMessage: result.reason || (result.is_cancelled ? 'Order was cancelled (maker-or-cancel rejected)' : null),
      baseSize: roundedAmount,
      limitPrice: roundedPrice,
    };
  };

  /**
   * Get order status
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderDetails>} Order details
   */
  adapter.getOrder = async (orderId) => {
    const result = await makeRestRequest('/v1/order/status', { order_id: parseInt(orderId) });

    const executedAmount = parseFloat(result.executed_amount || 0);
    const originalAmount = parseFloat(result.original_amount || 0);
    const avgPrice = parseFloat(result.avg_execution_price || 0);

    // Map Gemini status to standard format
    let status = 'UNKNOWN';
    if (result.is_cancelled) {
      status = 'CANCELLED';
    } else if (result.is_live) {
      status = executedAmount > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
    } else if (executedAmount >= originalAmount) {
      status = 'FILLED';
    }

    return {
      orderId: result.order_id?.toString(),
      productId: result.symbol,
      side: result.side?.toUpperCase(),
      status,
      filledSize: executedAmount,
      filledValue: executedAmount * avgPrice,
      averageFilledPrice: avgPrice,
      completionPercentage: originalAmount > 0 ? (executedAmount / originalAmount) * 100 : 0,
      totalFees: 0, // Gemini fees are deducted from proceeds, need to calculate separately
      createdTime: new Date(result.timestampms).toISOString(),
    };
  };

  /**
   * Get all open orders for a product
   * @param {string} productId - Product ID
   * @returns {Promise<OpenOrder[]>} List of open orders
   */
  adapter.getOpenOrders = async (productId) => {
    const orders = await makeRestRequest('/v1/orders');

    return orders
      .filter(order => toGeminiSymbol(productId) === order.symbol.toLowerCase())
      .map(order => ({
        orderId: order.order_id?.toString(),
        productId: order.symbol,
        side: order.side?.toUpperCase(),
        status: order.is_live ? 'OPEN' : 'CLOSED',
        filledSize: parseFloat(order.executed_amount || 0),
        createdTime: new Date(order.timestampms).toISOString(),
      }));
  };

  /**
   * Cancel an order
   * @param {string} orderId - Order ID
   * @returns {Promise<CancelResult>} Cancel result
   */
  adapter.cancelOrder = async (orderId) => {
    const result = await makeRestRequest('/v1/order/cancel', { order_id: parseInt(orderId) });

    return {
      success: result.is_cancelled === true,
    };
  };

  /**
   * Get fills for an order
   * Gemini includes fees in the trade response
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderFill[]>} List of fills
   */
  adapter.getOrderFills = async (orderId) => {
    // Get trades for this account and filter by order
    const trades = await makeRestRequest('/v1/mytrades', { symbol: 'btcusd', limit_trades: 100 });

    const fills = trades
      .filter(trade => trade.order_id?.toString() === orderId.toString())
      .map(trade => {
        const price = parseFloat(trade.price || 0);
        const size = parseFloat(trade.amount || 0);
        const feeAmount = parseFloat(trade.fee_amount || 0);

        return {
          tradeId: trade.tid?.toString(),
          orderId: trade.order_id?.toString(),
          productId: trade.symbol,
          side: trade.type?.toUpperCase(),
          price,
          size,
          sizeInQuote: price * size,
          commission: feeAmount,
          totalCommission: feeAmount,
          rebate: 0, // Gemini doesn't have maker rebates in the same way
          netFee: feeAmount,
          tradeTime: new Date(trade.timestampms).toISOString(),
          liquidityIndicator: trade.is_maker ? 'MAKER' : 'TAKER',
        };
      });

    return fills;
  };

  /**
   * Get historical price candles
   * @param {string} productId - Product ID
   * @param {number} start - Start timestamp (seconds) - not used by Gemini, fetches latest
   * @param {number} end - End timestamp (seconds) - not used by Gemini
   * @param {string} granularity - Candle granularity (1m, 5m, 15m, 30m, 1hr, 6hr, 1day)
   * @returns {Promise<Candle[]>} Array of candle data
   */
  adapter.getCandles = async (productId, start, end, granularity) => {
    const symbol = toGeminiSymbol(productId);

    // Map Coinbase granularity to Gemini
    const granularityMap = {
      'ONE_MINUTE': '1m',
      'FIVE_MINUTE': '5m',
      'FIFTEEN_MINUTE': '15m',
      'THIRTY_MINUTE': '30m',
      'ONE_HOUR': '1hr',
      'SIX_HOUR': '6hr',
      'ONE_DAY': '1day',
    };

    const geminiGranularity = granularityMap[granularity] || '1day';
    const candles = await makePublicRequest(`/v2/candles/${symbol}/${geminiGranularity}`);

    // Gemini returns [timestamp, open, high, low, close, volume]
    return candles.map(c => ({
      timestamp: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  };

  return adapter;
};

module.exports = {
  createGeminiAdapter,
};
