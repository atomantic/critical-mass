// @ts-check
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAuthenticatedRequest } = require('./auth');
const { createBaseAdapter, createAmbiguousPlacementError } = require('../base-adapter');
const { incrementToDecimals, floorToIncrement, finiteFloat } = require('../../shared-utils');
const { createContextLogger } = require('../../logger');

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

// The only method that can create an order. A transport or response-decoding
// failure here is AMBIGUOUS (Crypto.com may already hold the order), so it
// surfaces as an unknown outcome carrying the client_oid instead of a plain
// network error a caller would read as "it never happened". (#427)
const ORDER_PLACEMENT_METHOD = 'private/create-order';

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
  const logger = createContextLogger({ exchange: 'cryptocom' });

  /**
   * Check if keys file exists and contains valid-looking credentials
   * @returns {boolean}
   */
  adapter.hasValidKeys = () => {
    if (!fs.existsSync(resolvedKeysPath)) return false;

    try {
      const keys = JSON.parse(fs.readFileSync(resolvedKeysPath, 'utf8'));
      const apiKey = keys.apiKey || keys.key;
      const apiSecret = keys.apiSecret || keys.secret;

      // Check for valid-looking credentials
      if (!apiKey || !apiSecret) return false;
      if (apiKey.length < 10 || apiSecret.length < 10) return false;

      return true;
    } catch {
      return false;
    }
  };

  /**
   * Load API credentials from keys file
   * @returns {ApiCredentials}
   */
  adapter.loadCredentials = () => {
    if (!fs.existsSync(resolvedKeysPath)) {
      throw new Error('API keys not configured. Please add your Crypto.com API keys.');
    }

    let keys;
    try {
      keys = JSON.parse(fs.readFileSync(resolvedKeysPath, 'utf8'));
    } catch (err) {
      throw new Error('Failed to parse API keys file: corrupted or invalid JSON');
    }
    const apiKey = keys.apiKey || keys.key;
    const apiSecret = keys.apiSecret || keys.secret;

    if (!apiKey || !apiSecret) {
      throw new Error('Invalid API keys. Both API key and secret are required.');
    }

    return { apiKey, apiSecret };
  };

  /**
   * Crypto.com's positive "this order does not exist" signal: HTTP 404, the
   * 40401 NOT_FOUND / 316 NO_ORDER reject codes, or a not-found message.
   * Anything else (auth, rate limit, transport) is an INCONCLUSIVE lookup and
   * must NOT read as absent — that reading is what permits a double-place.
   * @param {any} err
   * @returns {boolean}
   */
  const isOrderNotFound = (err) =>
    err?.status === 404
    || Number(err?.code) === 40401
    || Number(err?.code) === 316
    || /order\s*not\s*found|no\s*order\s*found/i.test(err?.message ?? '');

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
      // Placement must not degrade to a plain network error: the request may
      // have reached the matching engine, so the outcome is unknown and must
      // stay reconcilable by client_oid rather than look like a clean failure.
      if (method === ORDER_PLACEMENT_METHOD) {
        throw createAmbiguousPlacementError('Crypto.com', method, params?.client_oid, err.message);
      }
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
      cleanError.code = errData?.code;
      cleanError.orderNotFound = isOrderNotFound(cleanError);
      throw cleanError;
    }

    // A 2xx whose body we cannot decode is the same ambiguity as a lost
    // response: Crypto.com accepted something we can't read. A try/catch is
    // required here — JSON.parse signals only by throwing.
    let data;
    try {
      data = safeParseBigInt(rawText);
    } catch (err) {
      if (method === ORDER_PLACEMENT_METHOD) {
        throw createAmbiguousPlacementError('Crypto.com', method, params?.client_oid, `undecodable response: ${err.message}`);
      }
      throw err;
    }

    // A non-zero code is a DEFINITIVE exchange rejection (the order was read and
    // refused), so it stays an ordinary error — only transport/decode ambiguity
    // becomes an unknown outcome.
    if (data.code !== 0) {
      const cleanError = new Error(`Crypto.com API error: ${data.message || 'Unknown error'} (code: ${data.code})`);
      cleanError.code = data.code;
      cleanError.responseData = data;
      cleanError.endpoint = method;
      cleanError.orderNotFound = isOrderNotFound(cleanError);
      throw cleanError;
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
    // Format to the instrument's decimal precision: floorToIncrement returns a
    // mathematically-correct tick but can carry binary float artifacts
    // (e.g. 8.200000000000001), and raw toString() would send over-precision
    // digits that Crypto.com rejects. The limit paths already toFixed; match them.
    const qtyDecimals = incrementToDecimals(details.baseIncrement);
    const quantityStr = roundedQuantity.toFixed(qtyDecimals);

    // Use quantity for more control over rounding
    const orderParams = {
      instrument_name: instrument,
      side: 'BUY',
      type: 'MARKET',
      quantity: quantityStr,
      client_oid: clientOrderId,
      spot_margin: 'SPOT',
    };

    logger.info(`Crypto.com market buy: ${quoteAmount} USD -> ${roundedQuantity} ${instrument.split('_')[0]} @ ${price}`, {
      pair: productId,
      clientOrderId,
      side: 'BUY',
      quoteAmount,
      baseAmount: roundedQuantity,
      price,
    });

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
   * Place a limit buy or sell order through Crypto.com's shared create-order shape.
   * @param {'BUY'|'SELL'} side
   * @param {string} productId
   * @param {number} baseAmount
   * @param {number} price
   * @param {{postOnly?: boolean}} [options]
   * @returns {Promise<LimitSellResult|Object>}
   */
  const placeLimitOrder = async (side, productId, baseAmount, price, options = {}) => {
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

    const minQty = parseFloat(details.baseMinSize) || baseIncrement;
    if (roundedAmount < minQty) {
      logger.warn(`⚠️ Crypto.com order qty ${roundedAmount} (from ${baseAmount}) below minimum ${minQty} (tick_size=${baseIncrement})`, {
        pair: productId,
        side,
        requestedAmount: baseAmount,
        roundedAmount,
        minimumAmount: minQty,
        baseIncrement,
      });
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
      side,
      type: 'LIMIT',
      quantity: roundedAmount.toFixed(qtyDecimals),
      price: roundedPrice.toFixed(priceDecimals),
      client_oid: clientOrderId,
      spot_margin: 'SPOT',
      time_in_force: 'GOOD_TILL_CANCEL',
      exec_inst: postOnly ? ['POST_ONLY'] : [],
    };

    logger.info(`Crypto.com limit ${side.toLowerCase()}: ${orderParams.quantity} ${instrument.split('_')[0]} @ ${orderParams.price}`, {
      pair: productId,
      clientOrderId,
      side,
      baseAmount: roundedAmount,
      price: roundedPrice,
      postOnly,
    });

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
   * Place a limit sell order
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to sell
   * @param {number} price - Limit price
   * @returns {Promise<LimitSellResult>} Order result
   */
  adapter.placeLimitSell = (productId, baseAmount, price, options = {}) =>
    placeLimitOrder('SELL', productId, baseAmount, price, options);

  /**
   * Place a limit buy order
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to buy
   * @param {number} price - Limit price
   * @param {Object} [options] - Order options
   * @param {boolean} [options.postOnly] - Whether to use post-only mode (default: true)
   * @returns {Promise<Object>} Order result
   */
  adapter.placeLimitBuy = (productId, baseAmount, price, options = {}) =>
    placeLimitOrder('BUY', productId, baseAmount, price, options);

  /**
   * Get order status
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderDetails>} Order details
   */
  adapter.getOrder = async (orderId) => {
    const result = await makePrivateRequest('private/get-order-detail', {
      order_id: orderId,
    });

    const order = extractOrderInfo(result);
    if (!order) {
      throw new Error(`No order data returned for order ${orderId}`);
    }

    return normalizeOrderDetail(order, orderId);
  };

  /**
   * Find an order on the exchange by the deterministic client_oid we sent.
   * Resolves an ambiguous placement outcome (#427): get-order-detail accepts
   * client_oid in place of order_id, so this is an authoritative point lookup.
   *
   * Returns null ONLY when Crypto.com positively reports no such order — i.e.
   * the placement never landed and is safe to re-place. Any other lookup
   * failure propagates: "we could not check" must never be read as "it isn't
   * there", which is exactly how a live order gets double-placed.
   * @param {string} clientOrderId - Deterministic client order id we submitted
   * @param {string|null} [_productId] - Unused; the lookup is global by id
   * @returns {Promise<OrderDetails|null>} Normalized order details, or null if absent
   */
  adapter.findOrderByClientOrderId = async (clientOrderId, _productId = null) => {
    if (!clientOrderId) return null;

    const notFound = Symbol('order-not-found');
    const result = await makePrivateRequest('private/get-order-detail', { client_oid: clientOrderId })
      .catch((err) => {
        if (isOrderNotFound(err)) return notFound;
        throw err;
      });

    if (result === notFound) return null;

    // A decoded response that carries no order_id is INCONCLUSIVE, not absent.
    // Throwing keeps the placement unresolved (the caller re-raises rather than
    // re-placing); returning null here would invite a double-place, and
    // adopting it would register the client_oid as if it were an exchange id.
    const order = extractOrderInfo(result);
    if (!order?.order_id) {
      throw new Error(`Crypto.com order lookup for client_oid ${clientOrderId} returned no order id — outcome still unresolved`);
    }

    return normalizeOrderDetail(order, clientOrderId);
  };

  /**
   * Unwrap the order payload, which the API nests under `order_info`.
   * @param {any} result
   * @returns {any|null}
   */
  const extractOrderInfo = (result) => {
    const order = result?.order_info || result;
    return order && typeof order === 'object' ? order : null;
  };

  /**
   * Normalize a get-order-detail payload into the shared OrderDetails shape.
   * Shared by getOrder and findOrderByClientOrderId so a reconcile lookup never
   * classifies the same order differently than the ordinary poll.
   * @param {any} order - Raw order payload
   * @param {string} fallbackId - Id to report when the payload omits order_id
   * @returns {OrderDetails}
   */
  const normalizeOrderDetail = (order, fallbackId) => {
    const filledQuantity = parseFloat(order.cumulative_quantity || order.filled_quantity || 0);
    const originalQuantity = parseFloat(order.quantity || order.order_value || 0);
    const avgPrice = parseFloat(order.avg_price || order.filled_price || 0);
    const filledValue = parseFloat(order.cumulative_value || 0) || filledQuantity * avgPrice;

    // Map status.
    //
    // Every order that is off the book MUST normalize to a terminal status
    // (mirrors the Gemini adapter's guard, issue #316): EXPIRED is a
    // documented Crypto.com Exchange v1 order status, and letting it fall
    // through to UNKNOWN means isTerminalStatus()/isCancelledStatus() never
    // fire, cancelPartialFillOrder never confirms terminal, and
    // NON_ADOPTABLE_STATUSES (order-manager.js) doesn't recognize it either,
    // so an expired order gets adopted as if it were still live (issue #682).
    let status = 'UNKNOWN';
    const orderStatus = (order.status || '').toUpperCase();
    if (orderStatus === 'FILLED' || orderStatus === 'COMPLETED') {
      status = 'FILLED';
    } else if (orderStatus === 'CANCELED' || orderStatus === 'CANCELLED' || orderStatus === 'REJECTED') {
      status = 'CANCELLED';
    } else if (orderStatus === 'EXPIRED') {
      status = 'EXPIRED';
    } else if (orderStatus === 'ACTIVE' || orderStatus === 'NEW' || orderStatus === 'PENDING') {
      status = filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
    } else if (orderStatus === 'PARTIALLY_FILLED') {
      status = 'PARTIALLY_FILLED';
    } else if (orderStatus) {
      // Genuinely unrecognised — leave UNKNOWN, but log once so a new
      // exchange status doesn't silently orphan orders the way EXPIRED did.
      logger.warn(`Crypto.com order status not recognized, reporting UNKNOWN: ${orderStatus}`, {
        orderId: order.order_id || fallbackId,
      });
    }

    return {
      orderId: (order.order_id || fallbackId).toString(),
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
      // finiteFloat (not a bare `parseFloat(x || 0)`) guards a TRUTHY but
      // non-numeric field too — e.g. quantity: "N/A" — which would otherwise
      // parse to NaN and poison the size subtraction below (issue #684).
      const quantity = finiteFloat(order.quantity || order.order_value);
      const filledQty = finiteFloat(order.cumulative_quantity || order.filled_quantity);
      return {
        orderId: order.order_id?.toString(),
        productId: order.instrument_name,
        side: (order.side || '').toUpperCase(),
        status: filledQty > 0 ? 'PARTIALLY_FILLED' : 'OPEN',
        size: Math.max(0, quantity - filledQty), // Remaining unfilled size, clamped at 0 (issue #684 follow-up)
        originalSize: quantity,
        filledSize: filledQty,
        price: finiteFloat(order.price || order.limit_price),
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
   * Walk `private/get-trades` backward from `endNs` to `startNs`, in
   * nanosecond-precision windows, halving any window that saturates the
   * API's 100-row response cap and throwing rather than silently accepting
   * an under-sampled bucket. Shared by `getOrderFills` (bounded to one
   * order's own lifetime) and `getReconciliationFills` (bounded to a
   * reconciliation start time) so the two walkers can no longer drift apart
   * on acceptance thresholds (issue #679).
   * @param {Object} params
   * @param {string} [params.instrument] - instrument_name filter, or every product when omitted
   * @param {bigint} params.startNs - lower bound, nanoseconds
   * @param {bigint} params.endNs - upper bound, nanoseconds
   * @returns {Promise<any[]>} Raw trade rows in the window, deduped by trade_id
   */
  const walkTrades = async ({ instrument, startNs, endNs }) => {
    const NS_PER_MS = 1_000_000n;
    const DAY_NS = 24n * 60n * 60n * 1000n * NS_PER_MS;
    const baseParams = instrument ? { instrument_name: instrument } : {};
    const seen = new Set();
    const rawFills = [];
    let cursor = endNs;

    while (cursor > startNs) {
      let span = cursor - startNs < DAY_NS ? cursor - startNs : DAY_NS;
      let trades = [];
      while (true) {
        const ws = cursor - span;
        const result = await makePrivateRequest('private/get-trades', {
          ...baseParams,
          start_time: String(ws),
          end_time: String(cursor),
          limit: 100,
        });
        trades = result?.data || [];
        if (trades.length < 100) break;
        if (span <= 1n) {
          throw new Error(`Crypto.com trade scan is still saturated at 1ns for ${instrument || 'all instruments'} in [${ws}, ${cursor}]; refusing to return incomplete fills`);
        }
        span /= 2n;
      }
      for (const t of trades) {
        const tid = String(t.trade_id);
        if (seen.has(tid)) continue;
        seen.add(tid);
        rawFills.push(t);
      }
      cursor -= span;
    }

    return rawFills;
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
   * the window (via the shared `walkTrades`) in 24h buckets with halving if a
   * bucket hits the 100-trade cap — throwing rather than accepting a
   * still-saturated bucket. The scan is bounded by the order's own
   * `create_time`, not an artificial lookback cap, so a GTC order that rests
   * for weeks is still scanned in full (issue #679).
   *
   * A failed order-detail lookup, or a matched-fill total short of the
   * order's own `cumulative_quantity`, throws `{ incompleteFills: true }`
   * instead of returning a partial set with no error — callers already treat
   * a throw here as retryable (see `ingestNewFillsForOrder`).
   *
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderFill[]>} List of fills
   */
  adapter.getOrderFills = async (orderId) => {
    // Step 1: locate the order so we can bound the scan and verify
    // completeness. A lookup failure means we can do neither — rethrow
    // instead of degrading to a short, instrument-agnostic fallback scan
    // that would silently under-report a fully-filled sell.
    let detail;
    try {
      detail = await makePrivateRequest('private/get-order-detail', { order_id: orderId });
    } catch (err) {
      // Prefix the message on the SAME error object rather than throwing a
      // fresh plain Error — makePrivateRequest attaches `status`/`code`/
      // `responseData` that health-monitor's isAuthDeniedError relies on to
      // route an auth rejection into non-self-healing AUTH_DENIED instead of
      // treating it as a retryable REST error; a new Error() would silently
      // discard that metadata.
      err.message = `Crypto.com getOrderFills: order-detail lookup failed for ${orderId}: ${err.message}`;
      throw err;
    }
    const orderInfo = detail?.order_info || detail || {};
    const instrument = orderInfo.instrument_name;
    const createTime = Number(orderInfo.create_time || 0);
    const updateTime = Number(orderInfo.update_time || 0);
    const cumulativeQuantity = parseFloat(orderInfo.cumulative_quantity || orderInfo.filled_quantity || 0);

    if (!(createTime > 0)) {
      throw new Error(`Crypto.com getOrderFills: order-detail for ${orderId} has no create_time — cannot bound the trade scan`);
    }

    // Pad the window to absorb clock skew + late-arriving cancel/fill events.
    const now = Date.now();
    const windowStartMs = createTime - 60_000;
    const windowEndMs = Math.min(Math.max(updateTime, createTime) + 5 * 60_000, now);
    const NS_PER_MS = 1_000_000n;

    // Step 2: walk the window, then filter to this order.
    // Step 3: verify the matched fills actually account for everything the
    // exchange says filled — a short sum is the "partial fill" case worth
    // guarding against (distinct from designed holdback, which is computed
    // downstream from the fills this function returns). The most common
    // cause of a short match right after a fill is Crypto.com's own
    // trade-history indexing lag (the fill just landed and
    // private/get-trades hasn't surfaced it yet), which normally clears
    // within a couple of seconds — retry briefly before rejecting. The
    // window itself does not need to move: updateTime already bounds it
    // past the trade's own timestamp, so a retry only needs to re-poll for
    // a record the backend hasn't indexed yet. This matters beyond this
    // call alone: order-executor's polling-based fill detection
    // (checkPendingOrderFills) removes a terminal order from tracking
    // BEFORE invoking its fill callback, so a reject here on a merely
    // transient gap can strand that fill with no automatic retry path.
    const FILL_SCAN_RETRIES = 2;
    const FILL_SCAN_RETRY_DELAY_MS = 750;
    let matching;
    let totalMatched;
    for (let attempt = 0; ; attempt++) {
      const rawTrades = await walkTrades({
        instrument,
        startNs: BigInt(Math.trunc(windowStartMs)) * NS_PER_MS,
        endNs: BigInt(Math.trunc(windowEndMs)) * NS_PER_MS,
      });
      matching = rawTrades.filter(t => String(t.order_id) === String(orderId));
      totalMatched = matching.reduce((sum, t) => sum + parseFloat(t.traded_quantity || t.quantity || 0), 0);
      if (totalMatched >= cumulativeQuantity - 1e-9 || attempt >= FILL_SCAN_RETRIES) break;
      await new Promise(resolve => setTimeout(resolve, FILL_SCAN_RETRY_DELAY_MS));
    }

    if (totalMatched < cumulativeQuantity - 1e-9) {
      throw Object.assign(
        new Error(`Crypto.com getOrderFills: fills incomplete for ${orderId}: ${totalMatched} of ${cumulativeQuantity}`),
        { incompleteFills: true }
      );
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
   * Fetch and normalize every fill used by the ledger reconciliation tools.
   * Crypto.com's trade endpoint caps responses at 100 rows, so walk backward
   * in daily windows (via the shared `walkTrades`) and halve any saturated
   * window before accepting it.
   * @param {string|undefined} productId
   * @param {number} startTimestampMs
   * @returns {Promise<import('../../types').ReconciliationFill[]>}
   */
  adapter.getReconciliationFills = async (productId, startTimestampMs) => {
    const normalizedProductId = productId || 'BTC_USDT';
    const instrument = toCryptocomSymbol(normalizedProductId);
    const NS_PER_MS = 1_000_000n;
    const startTimestampNs = BigInt(Math.trunc(startTimestampMs)) * NS_PER_MS;
    const endTimestampNs = BigInt(Date.now()) * NS_PER_MS;

    const rawFills = await walkTrades({ instrument, startNs: startTimestampNs, endNs: endTimestampNs });

    const seenTrades = new Set();
    return rawFills.flatMap(raw => {
      const tradeId = String(raw.trade_id || '');
      if (!tradeId || seenTrades.has(tradeId)) return [];
      seenTrades.add(tradeId);
      const price = parseFloat(raw.traded_price || raw.price || 0);
      const size = parseFloat(raw.traded_quantity || raw.quantity || 0);
      const fee = raw.fees !== undefined
        ? -parseFloat(raw.fees || 0)
        : parseFloat(raw.fee || 0);
      return [{
        tradeId,
        orderId: String(raw.order_id || ''),
        side: String(raw.side || '').toLowerCase(),
        price,
        size,
        quoteAmount: price * size,
        fee,
        feeCurrency: raw.fee_instrument_name || raw.fee_currency || getQuoteCurrency(normalizedProductId),
        timestamp: Number(raw.create_time || raw.trade_time || 0),
        liquidityIndicator: raw.taker_side || raw.liquidity_indicator || 'TAKER',
      }];
    });
  };

  adapter.capabilities.fillReconciliation = true;

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
