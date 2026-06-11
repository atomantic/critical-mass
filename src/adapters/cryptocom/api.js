// @ts-check
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAuthenticatedRequest } = require('./auth');
const { createBaseAdapter } = require('../base-adapter');
const { incrementToDecimals } = require('../../shared-utils');

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    let rawText;
    try {
      response = await fetch(`${REST_BASE_URL}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      rawText = await response.text();
    } catch (err) {
      clearTimeout(timeout);
      const cleanError = new Error(`Crypto.com API network: ${err.message}`);
      cleanError.status = 'network';
      cleanError.endpoint = method;
      throw cleanError;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      let errData;
      try { errData = safeParseBigInt(rawText); } catch { errData = {}; }
      const detail = errData?.message || errData?.description || '';
      const cleanError = new Error(`Crypto.com API ${response.status}: ${response.statusText}${detail ? ` (${detail})` : ''}`);
      cleanError.status = response.status;
      cleanError.endpoint = method;
      cleanError.responseData = errData;
      throw cleanError;
    }

    const data = safeParseBigInt(rawText);

    if (data.code !== 0) {
      throw new Error(`Crypto.com API error: ${data.message || 'Unknown error'} (code: ${data.code})`);
    }

    return data.result;
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    let rawText;
    try {
      response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      rawText = await response.text();
    } catch (err) {
      clearTimeout(timeout);
      const networkError = new Error(
        err && err.name === 'AbortError'
          ? `Crypto.com public request timed out for ${method}`
          : `Crypto.com public request failed for ${method}: ${err && err.message ? err.message : String(err)}`
      );
      networkError.status = 'network';
      networkError.endpoint = method;
      networkError.cause = err;
      throw networkError;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Crypto.com API ${response.status}: ${response.statusText}`);
    }

    const data = safeParseBigInt(rawText);

    if (data.code !== 0) {
      throw new Error(`Crypto.com API error: ${data.message || 'Unknown error'} (code: ${data.code})`);
    }

    return data.result;
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
   * Get current bid/ask for a product
   * @param {string} productId - Product ID (e.g., 'BTC-USDT' or 'BTC_USDT')
   * @returns {Promise<{bid: number, ask: number}>} Bid and ask prices
   */
  adapter.getBidAsk = async (productId) => {
    const instrument = toCryptocomSymbol(productId);
    const result = await makePublicRequest('public/get-tickers', {
      instrument_name: instrument,
    });

    const ticker = result.data?.find(t => t.i === instrument);
    if (!ticker) {
      throw new Error(`Ticker not found for ${instrument}`);
    }

    // 'b' is best bid, 'k' is best ask
    return {
      bid: parseFloat(ticker.b || 0),
      ask: parseFloat(ticker.k || 0),
    };
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
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');

    // Get product details for quantity precision
    const details = await adapter.getProductDetails(productId);
    const qtyTickSize = parseFloat(details.baseIncrement) || 1;
    const price = details.price;

    // Calculate quantity from notional, round down to tick size
    const rawQuantity = quoteAmount / price;
    const roundedQuantity = floorToIncrement(rawQuantity, qtyTickSize);

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
  adapter.placeLimitSell = async (productId, baseAmount, price, options = {}) => {
    const instrument = toCryptocomSymbol(productId);
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');
    const postOnly = options.postOnly !== false; // Default to true

    // Get product details for proper rounding
    const details = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(details.baseIncrement);
    const priceTickSize = parseFloat(details.quoteIncrement);

    const priceDecimals = incrementToDecimals(details.quoteIncrement);
    const qtyDecimals = incrementToDecimals(details.baseIncrement);

    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    const roundedPrice = floorToIncrement(price, priceTickSize);

    const orderParams = {
      instrument_name: instrument,
      side: 'SELL',
      type: 'LIMIT',
      quantity: roundedAmount.toFixed(qtyDecimals),
      price: roundedPrice.toFixed(priceDecimals),
      client_oid: clientOrderId,
      spot_margin: 'SPOT',
      time_in_force: 'GOOD_TILL_CANCEL',
      exec_inst: postOnly ? ['POST_ONLY'] : [],
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
   * Place a limit buy order
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to buy
   * @param {number} price - Limit price
   * @param {Object} [options] - Order options
   * @param {boolean} [options.postOnly] - Whether to use post-only mode (default: true)
   * @returns {Promise<Object>} Order result
   */
  adapter.placeLimitBuy = async (productId, baseAmount, price, options = {}) => {
    const instrument = toCryptocomSymbol(productId);
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');
    const postOnly = options.postOnly !== false;

    const details = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(details.baseIncrement);
    const priceTickSize = parseFloat(details.quoteIncrement);

    const priceDecimals = incrementToDecimals(details.quoteIncrement);
    const qtyDecimals = incrementToDecimals(details.baseIncrement);

    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    const roundedPrice = floorToIncrement(price, priceTickSize);

    // Validate quantity is non-zero and meets minimum
    const minQty = parseFloat(details.baseMinSize) || baseIncrement;
    if (roundedAmount < minQty) {
      console.log(`⚠️ Crypto.com order qty ${roundedAmount} (from ${baseAmount}) below minimum ${minQty} (tick_size=${baseIncrement})`);
      return {
        orderId: '',
        clientOrderId: '',
        success: false,
        errorMessage: `Order quantity ${baseAmount} rounds to ${roundedAmount}, below minimum ${minQty}`,
        baseSize: roundedAmount,
        limitPrice: roundedPrice,
      };
    }

    const orderParams = {
      instrument_name: instrument,
      side: 'BUY',
      type: 'LIMIT',
      quantity: roundedAmount.toFixed(qtyDecimals),
      price: roundedPrice.toFixed(priceDecimals),
      client_oid: clientOrderId,
      spot_margin: 'SPOT',
      time_in_force: 'GOOD_TILL_CANCEL',
      exec_inst: postOnly ? ['POST_ONLY'] : [],
    };

    console.log(`Crypto.com limit buy: ${orderParams.quantity} ${instrument.split('_')[0]} @ ${orderParams.price}`);

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

    return orders.map(order => {
      const quantity = parseFloat(order.quantity || order.order_value || 0);
      const filledQty = parseFloat(order.cumulative_quantity || order.filled_quantity || 0);
      return {
        orderId: order.order_id?.toString(),
        productId: order.instrument_name,
        side: (order.side || '').toUpperCase(),
        status: filledQty > 0 ? 'PARTIALLY_FILLED' : 'OPEN',
        size: quantity - filledQty, // Remaining unfilled size
        originalSize: quantity,
        filledSize: filledQty,
        price: parseFloat(order.price || order.limit_price || 0),
        createdTime: order.create_time
          ? new Date(order.create_time).toISOString()
          : new Date().toISOString(),
      };
    });
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
   * Get fills for an order.
   *
   * Crypto.com has no per-order trades endpoint. `private/get-trades` returns
   * at most 100 trades and applies an implicit ~24h window when no time range
   * is set — so the naive "fetch recent trades and filter" approach silently
   * drops fills for orders whose partial fills span longer than the window or
   * happen after >100 other trades. That's how the May 2026 CRO partial-fill
   * leak happened (28k CRO across 32 fills on 14 orders went unrecorded).
   *
   * Fix: look up the order to bound the trade scan to its actual lifetime
   * (create_time → update_time, padded), scope by instrument_name, and walk
   * the window in 24h buckets with halving if a bucket hits the 100-trade cap.
   *
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderFill[]>} List of fills
   */
  adapter.getOrderFills = async (orderId) => {
    // Step 1: locate the order so we can bound the scan
    let orderInfo = {};
    try {
      const detail = await makePrivateRequest('private/get-order-detail', { order_id: orderId });
      orderInfo = detail?.order_info || detail || {};
    } catch (err) {
      console.log(`⚠️ Crypto.com getOrderFills: order-detail lookup failed for ${orderId}: ${err.message}`);
    }
    const instrument = orderInfo.instrument_name;
    const createTime = Number(orderInfo.create_time || 0);
    const updateTime = Number(orderInfo.update_time || 0);

    // Pad the window to absorb clock skew + late-arriving cancel/fill events.
    // Cap historical lookback at 7d so an old orderId can't fan out into an
    // unbounded scan.
    const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let windowEnd, windowStart;
    if (createTime > 0) {
      windowStart = Math.max(createTime - 60_000, now - MAX_LOOKBACK_MS);
      windowEnd = Math.min(Math.max(updateTime, createTime) + 5 * 60_000, now);
    } else {
      // Order-detail unavailable — fall back to last hour, instrument-agnostic.
      windowStart = now - 60 * 60 * 1000;
      windowEnd = now;
    }

    // Step 2: walk the window in 24h buckets, halving on 100-cap hits.
    const baseParams = instrument ? { instrument_name: instrument } : {};
    const seen = new Set();
    const matching = [];
    let cursor = windowEnd;
    let pages = 0;
    while (cursor > windowStart && pages < 50) {
      pages++;
      let span = Math.min(24 * 60 * 60 * 1000, cursor - windowStart);
      let trades = [];
      let halvings = 0;
      while (true) {
        const ws = cursor - span;
        const result = await makePrivateRequest('private/get-trades', {
          ...baseParams,
          start_time: String(ws),
          end_time: String(cursor),
        });
        trades = result?.data || [];
        if (trades.length < 100 || span <= 60_000 || halvings >= 10) break;
        span = Math.floor(span / 2);
        halvings++;
      }
      for (const t of trades) {
        const tid = String(t.trade_id);
        if (seen.has(tid)) continue;
        seen.add(tid);
        if (String(t.order_id) === String(orderId)) matching.push(t);
      }
      cursor -= span;
    }

    return matching.map(trade => {
      const price = parseFloat(trade.traded_price || trade.price || 0);
      const size = parseFloat(trade.traded_quantity || trade.quantity || 0);
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
        tradeTime: (trade.create_time || trade.trade_time)
          ? new Date(trade.create_time || trade.trade_time).toISOString()
          : new Date().toISOString(),
        liquidityIndicator: trade.liquidity_indicator || 'TAKER',
      };
    });
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

    // Granularity → seconds per candle, used to size the count parameter
    const granularitySeconds = {
      'ONE_MINUTE': 60,
      'FIVE_MINUTE': 300,
      'FIFTEEN_MINUTE': 900,
      'THIRTY_MINUTE': 1800,
      'ONE_HOUR': 3600,
      'SIX_HOUR': 14400,
      'ONE_DAY': 86400,
    };

    const timeframe = granularityMap[granularity] || '1D';
    const granSec = granularitySeconds[granularity] || 86400;

    // Crypto.com defaults count=25 and caps at 300. Without an explicit
    // count, large windows silently return only the 25 most recent candles
    // — which broke the long-term candle store. Compute a count that fills
    // the requested window, capped at the API's maximum.
    const windowSec = Math.max(0, end - start);
    const requestedCount = Math.min(300, Math.max(1, Math.ceil(windowSec / granSec)));

    const result = await makePublicRequest('public/get-candlestick', {
      instrument_name: instrument,
      timeframe,
      start_ts: start * 1000, // Convert to milliseconds
      end_ts: end * 1000,
      count: requestedCount,
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
