// @ts-check
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createAuthenticatedRequest } = require('./auth');
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

const REST_BASE_URL = 'https://api.crypto.com/exchange/v1';

/**
 * Custom JSON parser that converts large integers to strings to avoid precision loss.
 * Order IDs from Crypto.com exceed JavaScript's MAX_SAFE_INTEGER (9007199254740991).
 * @param {string} data - Raw JSON string
 * @returns {any} Parsed object with large integers preserved as strings
 */
const safeParseBigInt = (data) => {
  // Match integers larger than MAX_SAFE_INTEGER and wrap them in quotes
  // This regex finds standalone integers (not already in quotes) that are 16+ digits
  const processed = data.replace(/:(\s*)(\d{16,})(\s*[,}\]])/g, ':$1"$2"$3');
  return JSON.parse(processed);
};

/**
 * Create a Crypto.com adapter instance
 * @param {string|null} [keysPath] - Path to keys file (defaults to data/cryptocom-keys.json)
 * @returns {ExchangeAdapter} Crypto.com adapter with all required methods
 */
const createCryptocomAdapter = (keysPath = null) => {
  // Resolve keys path
  const resolvedKeysPath = keysPath || path.join(__dirname, '..', '..', '..', 'data', 'cryptocom-keys.json');

  // Start with base adapter
  const adapter = createBaseAdapter('cryptocom');

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
      throw new Error('API keys not configured. Please add your Crypto.com API keys.');
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
   * Make authenticated REST request to Crypto.com API
   * @param {string} method - API method (e.g., 'private/user-balance')
   * @param {Object} [params] - Request parameters
   * @returns {Promise<any>} API response result
   */
  const makePrivateRequest = async (method, params = {}) => {
    const { apiKey, apiSecret } = adapter.loadCredentials();
    const body = createAuthenticatedRequest(method, params, apiKey, apiSecret);

    const response = await axios.post(`${REST_BASE_URL}/${method}`, body, {
      headers: {
        'Content-Type': 'application/json',
      },
      transformResponse: [safeParseBigInt],
    }).catch(err => {
      // Log the full error for debugging
      const errData = err.response?.data;
      console.error(`Crypto.com API error (${method}):`, JSON.stringify(errData || err.message));
      throw err;
    });

    if (response.data.code !== 0) {
      throw new Error(`Crypto.com API error: ${response.data.message || 'Unknown error'} (code: ${response.data.code})`);
    }

    return response.data.result;
  };

  /**
   * Make public REST request (no auth)
   * @param {string} method - API method
   * @param {Object} [params] - Query parameters
   * @returns {Promise<any>} API response result
   */
  const makePublicRequest = async (method, params = {}) => {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');

    const url = queryString
      ? `${REST_BASE_URL}/${method}?${queryString}`
      : `${REST_BASE_URL}/${method}`;

    const response = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
      },
      transformResponse: [safeParseBigInt],
    });

    if (response.data.code !== 0) {
      throw new Error(`Crypto.com API error: ${response.data.message || 'Unknown error'} (code: ${response.data.code})`);
    }

    return response.data.result;
  };

  /**
   * Convert product ID to Crypto.com instrument format
   * Standard: BTC-USDC -> Crypto.com: BTC_USDC (underscore, uppercase)
   * @param {string} productId - Product ID in standard format
   * @returns {string} Crypto.com instrument name
   */
  const toCryptocomSymbol = (productId) => {
    // Replace dash with underscore, ensure uppercase
    return productId.toUpperCase().replace('-', '_');
  };

  /**
   * Extract quote currency from product ID
   * @param {string} productId - Product ID (e.g., 'BTC-USDC' or 'BTC_USDT')
   * @returns {string} Quote currency
   */
  const getQuoteCurrency = (productId) => {
    const parts = productId.replace('_', '-').split('-');
    return parts[1] || 'USDT';
  };

  /**
   * Extract base currency from product ID
   * @param {string} productId - Product ID (e.g., 'BTC-USDC' or 'BTC_USDT')
   * @returns {string} Base currency
   */
  const getBaseCurrency = (productId) => {
    const parts = productId.replace('_', '-').split('-');
    return parts[0] || 'BTC';
  };

  /**
   * Get account balance for a specific currency
   * @param {string} currency - Currency code (e.g., 'USDT', 'BTC')
   * @returns {Promise<AccountBalance>}
   */
  adapter.getAccountBalance = async (currency) => {
    const normalizedCurrency = currency.toUpperCase();

    const result = await makePrivateRequest('private/user-balance', {});

    // Find position balance for the currency
    const data = result.data?.[0];
    if (!data || !data.position_balances) {
      return { available: 0, hold: 0, total: 0 };
    }

    const position = data.position_balances.find(
      p => p.instrument_name?.toUpperCase() === normalizedCurrency
    );

    if (!position) {
      return { available: 0, hold: 0, total: 0 };
    }

    const total = parseFloat(position.quantity || 0);
    const available = parseFloat(position.max_withdrawal_balance || position.quantity || 0);
    const hold = total - available;

    return { available, hold: Math.max(0, hold), total };
  };

  /**
   * Get current price for a product
   * @param {string} productId - Product ID (e.g., 'BTC-USDT' or 'BTC_USDT')
   * @returns {Promise<number>} Current price
   */
  adapter.getCurrentPrice = async (productId) => {
    const instrument = toCryptocomSymbol(productId);
    const result = await makePublicRequest('public/get-tickers', {
      instrument_name: instrument,
    });

    const ticker = result.data?.find(t => t.i === instrument);
    if (!ticker) {
      throw new Error(`Ticker not found for ${instrument}`);
    }

    // 'a' is the last trade price
    return parseFloat(ticker.a || ticker.b || 0);
  };

  /**
   * Get product details
   * @param {string} productId - Product ID
   * @returns {Promise<ProductDetails>} Product details
   */
  adapter.getProductDetails = async (productId) => {
    const instrument = toCryptocomSymbol(productId);
    const result = await makePublicRequest('public/get-instruments', {});

    const instrumentData = result.data?.find(i => i.symbol === instrument);
    if (!instrumentData) {
      throw new Error(`Instrument not found: ${instrument}`);
    }

    const price = await adapter.getCurrentPrice(productId);

    // Crypto.com uses qty_tick_size for base increment and price_tick_size for quote
    const baseIncrement = instrumentData.qty_tick_size?.toString() || '0.00000001';
    const quoteIncrement = instrumentData.price_tick_size?.toString() || '0.01';
    const baseMinSize = instrumentData.min_quantity?.toString() || '0.00001';

    return {
      baseIncrement,
      quoteIncrement,
      baseMinSize,
      quoteMinSize: (parseFloat(baseMinSize) * price).toString(),
      price,
    };
  };

  /**
   * Place a market buy order using notional (quote amount)
   * @param {string} productId - Product ID
   * @param {number} quoteAmount - Amount in quote currency to spend
   * @returns {Promise<MarketBuyResult>} Order result
   */
  adapter.placeMarketBuy = async (productId, quoteAmount) => {
    const instrument = toCryptocomSymbol(productId);
    const clientOrderId = uuidv4().replace(/-/g, '').substring(0, 36);

    // Get product details for quantity precision
    const details = await adapter.getProductDetails(productId);
    const qtyTickSize = parseFloat(details.baseIncrement) || 1;
    const price = details.price;

    // Calculate quantity from notional, round down to tick size
    const rawQuantity = quoteAmount / price;
    const roundedQuantity = Math.floor(rawQuantity / qtyTickSize) * qtyTickSize;

    // Use quantity for more control over rounding
    const orderParams = {
      instrument_name: instrument,
      side: 'BUY',
      type: 'MARKET',
      quantity: roundedQuantity.toString(),
      client_oid: clientOrderId,
      spot_margin: 'SPOT',
    };

    console.log(`Crypto.com market buy: ${quoteAmount} USD -> ${roundedQuantity} ${instrument.split('_')[0]} @ ${price}`);

    const result = await makePrivateRequest('private/create-order', orderParams);

    const success = !!result.order_id;

    return {
      orderId: result.order_id?.toString() || '',
      clientOrderId,
      success,
      errorMessage: success ? undefined : 'Order placement failed',
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
    const instrument = toCryptocomSymbol(productId);
    const clientOrderId = uuidv4().replace(/-/g, '').substring(0, 36);

    // Get product details for proper rounding
    const details = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(details.baseIncrement);
    const priceTickSize = parseFloat(details.quoteIncrement);

    // Calculate decimal places from tick size (e.g., 0.00001 -> 5 decimals)
    const priceDecimals = Math.max(0, -Math.floor(Math.log10(priceTickSize)));
    const qtyDecimals = Math.max(0, -Math.floor(Math.log10(baseIncrement)));

    const roundedAmount = Math.floor(baseAmount / baseIncrement) * baseIncrement;
    const roundedPrice = Math.floor(price / priceTickSize) * priceTickSize;

    const orderParams = {
      instrument_name: instrument,
      side: 'SELL',
      type: 'LIMIT',
      quantity: roundedAmount.toFixed(qtyDecimals),
      price: roundedPrice.toFixed(priceDecimals),
      client_oid: clientOrderId,
      spot_margin: 'SPOT',
      time_in_force: 'GOOD_TILL_CANCEL',
      exec_inst: ['POST_ONLY'],
    };

    console.log(`Crypto.com limit sell: ${orderParams.quantity} ${instrument.split('_')[0]} @ ${orderParams.price}`);

    const result = await makePrivateRequest('private/create-order', orderParams);

    const success = !!result.order_id;

    return {
      orderId: result.order_id?.toString() || '',
      clientOrderId,
      success,
      errorMessage: success ? undefined : 'Order placement failed',
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
    const result = await makePrivateRequest('private/get-order-detail', {
      order_id: orderId,
    });

    // API returns order nested under result.order_info
    const order = result?.order_info || result;
    if (!order || typeof order !== 'object') {
      throw new Error(`No order data returned for order ${orderId}`);
    }

    const filledQuantity = parseFloat(order.cumulative_quantity || order.filled_quantity || 0);
    const originalQuantity = parseFloat(order.quantity || order.order_value || 0);
    const avgPrice = parseFloat(order.avg_price || order.filled_price || 0);
    const filledValue = parseFloat(order.cumulative_value || 0) || filledQuantity * avgPrice;

    // Map status
    let status = 'UNKNOWN';
    const orderStatus = (order.status || '').toUpperCase();
    if (orderStatus === 'FILLED' || orderStatus === 'COMPLETED') {
      status = 'FILLED';
    } else if (orderStatus === 'CANCELED' || orderStatus === 'CANCELLED' || orderStatus === 'REJECTED') {
      status = 'CANCELLED';
    } else if (orderStatus === 'ACTIVE' || orderStatus === 'NEW' || orderStatus === 'PENDING') {
      status = filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
    } else if (orderStatus === 'PARTIALLY_FILLED') {
      status = 'PARTIALLY_FILLED';
    }

    return {
      orderId: (order.order_id || orderId).toString(),
      productId: order.instrument_name || '',
      side: (order.side || '').toUpperCase(),
      status,
      filledSize: filledQuantity,
      filledValue,
      averageFilledPrice: avgPrice,
      completionPercentage: originalQuantity > 0 ? (filledQuantity / originalQuantity) * 100 : 0,
      totalFees: parseFloat(order.cumulative_fee || order.fee || order.total_fee || 0),
      createdTime: order.create_time
        ? new Date(order.create_time).toISOString()
        : new Date().toISOString(),
    };
  };

  /**
   * Get all open orders for a product
   * @param {string} productId - Product ID
   * @returns {Promise<OpenOrder[]>} List of open orders
   */
  adapter.getOpenOrders = async (productId) => {
    const instrument = toCryptocomSymbol(productId);

    const result = await makePrivateRequest('private/get-open-orders', {
      instrument_name: instrument,
    });

    const orders = result.data || [];

    return orders.map(order => ({
      orderId: order.order_id?.toString(),
      productId: order.instrument_name,
      side: (order.side || '').toUpperCase(),
      status: 'OPEN',
      filledSize: parseFloat(order.cumulative_quantity || order.filled_quantity || 0),
      createdTime: order.create_time
        ? new Date(order.create_time).toISOString()
        : new Date().toISOString(),
    }));
  };

  /**
   * Cancel an order
   * @param {string} orderId - Order ID
   * @returns {Promise<CancelResult>} Cancel result
   */
  adapter.cancelOrder = async (orderId) => {
    await makePrivateRequest('private/cancel-order', {
      order_id: orderId,
    });

    // If no error thrown, cancellation was submitted successfully
    // Note: Crypto.com cancel is async, actual cancellation confirmed via order events
    return { success: true };
  };

  /**
   * Get fills for an order
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderFill[]>} List of fills
   */
  adapter.getOrderFills = async (orderId) => {
    // Crypto.com doesn't have a direct order fills endpoint
    // We need to use get-trades and filter by order_id, or use order detail
    const result = await makePrivateRequest('private/get-trades', {
      // Get recent trades and filter
    });

    const trades = result.data || [];

    const fills = trades
      .filter(trade => trade.order_id?.toString() === orderId.toString())
      .map(trade => {
        const price = parseFloat(trade.price || 0);
        const size = parseFloat(trade.quantity || trade.traded_quantity || 0);
        const feeAmount = parseFloat(trade.fee || 0);

        return {
          tradeId: trade.trade_id?.toString(),
          orderId: trade.order_id?.toString(),
          productId: trade.instrument_name,
          side: (trade.side || '').toUpperCase(),
          price,
          size,
          sizeInQuote: price * size,
          commission: feeAmount,
          totalCommission: feeAmount,
          rebate: 0,
          netFee: feeAmount,
          tradeTime: trade.trade_time
            ? new Date(trade.trade_time).toISOString()
            : new Date().toISOString(),
          liquidityIndicator: trade.liquidity_indicator || 'TAKER',
        };
      });

    return fills;
  };

  /**
   * Get historical price candles
   * @param {string} productId - Product ID
   * @param {number} start - Start timestamp (seconds)
   * @param {number} end - End timestamp (seconds)
   * @param {string} granularity - Candle granularity
   * @returns {Promise<Candle[]>} Array of candle data
   */
  adapter.getCandles = async (productId, start, end, granularity) => {
    const instrument = toCryptocomSymbol(productId);

    // Map standard granularity to Crypto.com format
    const granularityMap = {
      'ONE_MINUTE': '1m',
      'FIVE_MINUTE': '5m',
      'FIFTEEN_MINUTE': '15m',
      'THIRTY_MINUTE': '30m',
      'ONE_HOUR': '1h',
      'SIX_HOUR': '4h', // Crypto.com doesn't have 6h, use 4h
      'ONE_DAY': '1D',
    };

    const timeframe = granularityMap[granularity] || '1D';

    const result = await makePublicRequest('public/get-candlestick', {
      instrument_name: instrument,
      timeframe,
      start_ts: start * 1000, // Convert to milliseconds
      end_ts: end * 1000,
    });

    const candles = result.data || [];

    return candles.map(c => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }));
  };

  return adapter;
};

module.exports = {
  createCryptocomAdapter,
};
