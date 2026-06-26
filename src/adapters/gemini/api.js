// @ts-check
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const { getWebSocketAuthHeaders, getRestAuthHeaders } = require('./auth');
const { createBaseAdapter } = require('../base-adapter');
const { incrementToDecimals, floorToIncrement } = require('../../shared-utils');

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

const REST_BASE_URL = 'https://api.gemini.com';
const WS_FAST_API_URL = 'wss://api.gemini.com/v1/order/events';
const WS_MARKET_DATA_URL = 'wss://api.gemini.com/v1/marketdata';

// Gemini private REST limit is ~5 req/s; spacing every 200ms keeps a reconcile
// burst (order/status × N + balances + mytrades) from starving the heartbeat —
// the call that keeps resting orders alive (issue #193).
const REST_MIN_INTERVAL_MS = 200;
const RATE_LIMIT_MAX_RETRIES = 2;   // attempts beyond the first, on HTTP 429 only
const RATE_LIMIT_BACKOFF_MS = 500;  // linear: 500ms, 1000ms

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a self-spacing gate that serializes callers to at most one request per
 * `minIntervalMs`. Each caller atomically reserves the next slot (no await
 * between reading and bumping `nextSlot`, so concurrent callers can't collide).
 * Returns the wait promise ONLY when a delay is needed, else `null` — so a
 * caller with an open slot proceeds synchronously (no microtask deferral of the
 * subsequent request). Pure aside from the injected clock/sleep.
 * @param {{minIntervalMs:number, now?:()=>number, sleep?:(ms:number)=>Promise<void>}} opts
 * @returns {()=>(Promise<void>|null)} acquire — await its result before each rate-limited request
 */
const createRestThrottle = ({ minIntervalMs, now = Date.now, sleep = defaultSleep } = {}) => {
  let nextSlot = 0;
  return () => {
    const current = now();
    const wait = Math.max(0, nextSlot - current);
    nextSlot = Math.max(current, nextSlot) + minIntervalMs;
    return wait > 0 ? sleep(wait) : null;
  };
};

/**
 * A 429 is a pre-processing rejection (the request never reached the matching
 * engine), so retrying is safe even for order placement — unlike a network
 * error, where the order may have landed. Only 429 is retried.
 * @param {number} status
 * @param {number} attempt - zero-based attempt index already performed
 * @param {number} maxRetries
 * @returns {boolean}
 */
const isRetryableRateLimit = (status, attempt, maxRetries) =>
  status === 429 && attempt < maxRetries;

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

  // Serializes all private REST calls to ~5 req/s (issue #193).
  const acquireRestSlot = createRestThrottle({ minIntervalMs: REST_MIN_INTERVAL_MS });

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
   * Preserves large order IDs (exceeding JavaScript's MAX_SAFE_INTEGER) as strings
   * @param {string} endpoint - API endpoint (e.g., '/v1/balances')
   * @param {Object} [payload] - Request payload
   * @returns {Promise<any>} API response
   */
  const makeRestRequest = async (endpoint, payload = {}) => {
    // attempt is zero-based; we may retry on 429 up to RATE_LIMIT_MAX_RETRIES.
    // Credentials/headers are regenerated per attempt so the nonce strictly
    // increases (Gemini rejects a reused/stale nonce).
    for (let attempt = 0; ; attempt++) {
      const slotWait = acquireRestSlot();
      if (slotWait) await slotWait;
      const { apiKey, apiSecret } = adapter.loadCredentials();
      const headers = getRestAuthHeaders(apiKey, apiSecret, endpoint, payload);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response;
      let rawText;
      try {
        response = await fetch(`${REST_BASE_URL}${endpoint}`, {
          method: 'POST',
          headers,
          signal: controller.signal,
        });
        // Preserve big integers as strings using regex before JSON parse
        rawText = await response.text();
      } catch (err) {
        clearTimeout(timeout);
        // Network errors are NOT retried: the request may have reached the
        // matching engine, so a blind retry could double-place an order.
        const cleanError = new Error(`Gemini API network: ${err.message}`);
        cleanError.status = 'network';
        cleanError.endpoint = `POST ${endpoint}`;
        throw cleanError;
      }
      clearTimeout(timeout);

      if (!response.ok) {
        if (isRetryableRateLimit(response.status, attempt, RATE_LIMIT_MAX_RETRIES)) {
          await defaultSleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
          continue;
        }
        let errData;
        try { errData = JSON.parse(rawText); } catch { errData = {}; }
        const detail = errData.reason || errData.message || '';
        const cleanError = new Error(`Gemini API ${response.status}: ${response.statusText}${detail ? ` (${detail})` : ''}`);
        cleanError.status = response.status;
        cleanError.endpoint = `POST ${endpoint}`;
        cleanError.responseData = errData;
        throw cleanError;
      }

      const preserved = rawText.replace(/"(order_id|tid)":\s*(\d{15,})/g, '"$1":"$2"');
      return JSON.parse(preserved);
    }
  };

  /**
   * Make public REST request (no auth)
   * @param {string} endpoint - API endpoint
   * @returns {Promise<any>} API response
   */
  const makePublicRequest = async (endpoint) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    let json;
    try {
      response = await fetch(`${REST_BASE_URL}${endpoint}`, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Gemini API ${response.status}: ${response.statusText}`);
      }
      json = await response.json();
    } catch (err) {
      clearTimeout(timeout);
      if (err.status || err.message?.startsWith('Gemini API')) throw err;
      const networkError = new Error(
        err && err.name === 'AbortError'
          ? `Gemini public request timed out for ${endpoint}`
          : `Gemini public request failed for ${endpoint}: ${err && err.message ? err.message : String(err)}`
      );
      networkError.status = 'network';
      networkError.endpoint = endpoint;
      networkError.cause = err;
      throw networkError;
    }
    clearTimeout(timeout);
    return json;
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
   * Get current bid/ask for a product
   * @param {string} productId - Product ID (e.g., 'BTC-USD' or 'BTCUSD')
   * @returns {Promise<{bid: number, ask: number}>} Bid and ask prices
   */
  adapter.getBidAsk = async (productId) => {
    const symbol = toGeminiSymbol(productId);
    const ticker = await makePublicRequest(`/v1/pubticker/${symbol}`);
    return {
      bid: parseFloat(ticker.bid),
      ask: parseFloat(ticker.ask),
    };
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
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');

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
  adapter.placeLimitSell = async (productId, baseAmount, price, options = {}) => {
    const symbol = toGeminiSymbol(productId);
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');
    const postOnly = options.postOnly !== false; // Default to true

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);
    const baseDecimals = incrementToDecimals(product.baseIncrement);
    const quoteDecimals = incrementToDecimals(product.quoteIncrement);

    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    const roundedPrice = floorToIncrement(price, quoteIncrement);

    const baseMinSize = parseFloat(product.baseMinSize) || baseIncrement;
    if (roundedAmount < baseMinSize) {
      return {
        orderId: '',
        clientOrderId,
        success: false,
        errorMessage: `Order quantity ${baseAmount} rounds to ${roundedAmount}, below minimum ${baseMinSize}`,
        baseSize: roundedAmount,
        limitPrice: roundedPrice,
      };
    }

    const orderPayload = {
      symbol,
      amount: roundedAmount.toFixed(baseDecimals),
      price: roundedPrice.toFixed(quoteDecimals),
      side: 'sell',
      type: 'exchange limit',
      client_order_id: clientOrderId,
      options: postOnly ? ['maker-or-cancel'] : [],
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
   * Place a post-only limit buy order (maker-prefer)
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to buy
   * @param {number} price - Limit price in quote currency
   * @param {Object} [options] - Order options
   * @param {boolean} [options.postOnly] - Whether to use post-only mode (default: true)
   * @returns {Promise<LimitBuyResult>} Order result
   */
  adapter.placeLimitBuy = async (productId, baseAmount, price, options = {}) => {
    const symbol = toGeminiSymbol(productId);
    const clientOrderId = crypto.randomUUID().replace(/-/g, '');
    const postOnly = options.postOnly !== false; // Default to true

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);
    const baseDecimals = incrementToDecimals(product.baseIncrement);
    const quoteDecimals = incrementToDecimals(product.quoteIncrement);

    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    const roundedPrice = floorToIncrement(price, quoteIncrement);

    const baseMinSize = parseFloat(product.baseMinSize) || baseIncrement;
    if (roundedAmount < baseMinSize) {
      return {
        orderId: '',
        clientOrderId,
        success: false,
        errorMessage: `Order quantity ${baseAmount} rounds to ${roundedAmount}, below minimum ${baseMinSize}`,
        baseSize: roundedAmount,
        limitPrice: roundedPrice,
      };
    }

    const orderPayload = {
      symbol,
      amount: roundedAmount.toFixed(baseDecimals),
      price: roundedPrice.toFixed(quoteDecimals),
      side: 'buy',
      type: 'exchange limit',
      client_order_id: clientOrderId,
      options: postOnly ? ['maker-or-cancel'] : [],
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
   * @param {string} orderId - Order ID (kept as string to preserve precision for large IDs)
   * @returns {Promise<OrderDetails>} Order details
   */
  adapter.getOrder = async (orderId) => {
    // Gemini order IDs can exceed JavaScript's MAX_SAFE_INTEGER
    // Pass as number but let JSON serialization handle it
    const result = await makeRestRequest('/v1/order/status', { order_id: orderId });

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
   * @param {string} orderId - Order ID (kept as string to preserve precision for large IDs)
   * @returns {Promise<CancelResult>} Cancel result
   */
  adapter.cancelOrder = async (orderId) => {
    const result = await makeRestRequest('/v1/order/cancel', { order_id: orderId });

    return {
      success: result.is_cancelled === true,
    };
  };

  /**
   * Walk /v1/mytrades forward from a timestamp, paginating past the
   * per-request trade cap and stitching slices so the whole [since, now]
   * window is reachable even when it holds far more than one page of trades.
   * @param {string|null} symbol - Gemini symbol (e.g., 'ethusd'), or null for all symbols
   * @param {number} sinceTimestampMs - Start timestamp in milliseconds
   * @returns {Promise<Array>} Raw trade rows since the timestamp (deduped by tid)
   */
  const fetchTradesSince = async (symbol, sinceTimestampMs) => {
    const PAGE_SIZE = 500;

    // /v1/mytrades treats `timestamp` as a SINCE lower bound and, when more
    // than limit_trades match, returns the OLDEST limit_trades at-or-after it
    // (the page is rendered most-recent-first, which originally looked like a
    // "newest page", but live-probing 2026-06-11 with limit=1/5/50 against a
    // fixed early `since` showed the OLDEST trade is always retained while the
    // newest edge grows with the limit — i.e. the cap drops the NEWEST overflow,
    // not the oldest). symbol omitted (null) → all-symbol scan (also
    // live-verified: HTTP 200, trades across all symbols).
    //
    // Because the cap keeps the oldest matches, a forward-advancing `since`
    // cursor is the correct pagination idiom (Gemini has no upper-bound/
    // older-than param, but it doesn't need one here): each full page tells us
    // the newest timestamp it reached, and re-requesting with `since` set to
    // that timestamp walks forward into the next slice. The boundary trade(s)
    // at exactly that second reappear and are dropped by tid dedup. This
    // reaches EVERY trade in [since, now], so >500-fill orders are no longer
    // truncated (issue #130).
    const symbolLabel = symbol || 'all-symbols';
    const byTid = new Map();
    let sinceMs = sinceTimestampMs;
    let prevNewestMs = -1;

    // Each full page must advance `since` past at least one trade, so a finite
    // window yields finite pages. Cap iterations anyway to guarantee
    // termination against a pathological response.
    const MAX_PAGES = 10000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = { limit_trades: PAGE_SIZE, timestamp: Math.floor(sinceMs / 1000) };
      if (symbol) params.symbol = symbol;
      const trades = await makeRestRequest('/v1/mytrades', params);

      if (!Array.isArray(trades) || trades.length === 0) break;

      let newestMs = -1;
      for (const trade of trades) {
        // tid is a big-int string (preserved by makeRestRequest); never Number() it.
        const tid = trade.tid?.toString();
        if (tid !== undefined && !byTid.has(tid)) byTid.set(tid, trade);
        const ts = Number(trade.timestampms || 0);
        if (ts > newestMs) newestMs = ts;
      }

      // Partial page → the whole window is covered, we're done.
      if (trades.length < PAGE_SIZE) break;

      // Full page. Advance `since` to the newest timestamp reached so the next
      // slice starts where this one ended (boundary trades dedup by tid).
      if (newestMs <= sinceMs && newestMs === prevNewestMs) {
        // No forward progress is possible — >PAGE_SIZE trades share the same
        // second AND we already requested that second. Gemini's `timestamp` is
        // second-granular with no sub-second/older-than cursor, so the newest
        // of that same-second cluster is genuinely unreachable. Surface it
        // rather than loop forever.
        console.log(`⚠️ [gemini] mytrades has >${PAGE_SIZE} trades at the same second for ${symbolLabel} (${new Date(newestMs).toISOString()}); the newest of that cluster is unreachable via Gemini's API — fill recovery may be incomplete`);
        break;
      }
      prevNewestMs = newestMs;
      sinceMs = newestMs;
    }

    return Array.from(byTid.values());
  };

  /**
   * Get fills for an order.
   * Gemini includes fees in the trade response.
   *
   * Gemini has no per-order trades endpoint — fills are synthesized from
   * /v1/mytrades. The old implementation hardcoded symbol 'btcusd' and the
   * most recent 100 trades with no time bound, so non-BTC funds always got
   * [] (fees lost, offline TP recovery corrupted) and even BTC orders became
   * unfindable once 100 newer trades occurred — the same failure mode as the
   * May 2026 Crypto.com CRO partial-fill leak (cryptocom/api.js getOrderFills).
   *
   * Fix (mirrors the Crypto.com approach): look up the order to learn its
   * symbol and creation time, then walk /v1/mytrades forward from that time
   * with pagination so fills are found regardless of product or trade volume.
   * @param {string} orderId - Order ID
   * @returns {Promise<OrderFill[]>} List of fills
   */
  adapter.getOrderFills = async (orderId) => {
    // Step 1: locate the order so the trade scan uses the right symbol and
    // is bounded to the order's actual lifetime.
    let symbol = null;
    let sinceMs = Date.now() - 60 * 60 * 1000; // fallback: last hour, all symbols
    try {
      const order = await makeRestRequest('/v1/order/status', { order_id: orderId });
      if (order?.symbol) symbol = order.symbol.toLowerCase();
      const createdMs = Number(order?.timestampms || (order?.timestamp ? Number(order.timestamp) * 1000 : 0));
      if (createdMs > 0) sinceMs = createdMs - 60000; // 60s pad for clock skew
    } catch (err) {
      console.log(`⚠️ [gemini] getOrderFills: order-status lookup failed for ${orderId}: ${err.message} — scanning last hour across all symbols`);
    }

    // Step 2: paginate trades since order creation and filter by order
    const trades = await fetchTradesSince(symbol, sinceMs);

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
   * NOTE: Gemini's public candles API only returns ~500 most recent candles
   * and is limited to 7 calendar days of data. The start/end params are ignored.
   * For longer backtests, cached data should be used.
   * @param {string} productId - Product ID
   * @param {number} start - Start timestamp (seconds) - NOT USED by Gemini API
   * @param {number} end - End timestamp (seconds) - NOT USED by Gemini API
   * @param {string} granularity - Candle granularity (1m, 5m, 15m, 30m, 1hr, 6hr, 1day)
   * @returns {Promise<Candle[]>} Array of candle data (max ~500 candles)
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

    const candles = await makePublicRequest(`/v2/candles/${symbol}/${geminiGranularity}`)
      .catch(err => {
        console.error(`Gemini candles API error for ${symbol}: ${err.message}`);
        return []; // Return empty array on error
      });

    if (!Array.isArray(candles)) {
      console.error(`Gemini candles API returned unexpected format for ${symbol}`);
      return [];
    }

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

  /**
   * Start sending periodic heartbeats to keep orders alive.
   * Gemini API keys with "Requires Heartbeat" enabled will cancel
   * all open orders if no heartbeat is received within ~5 minutes.
   *
   * The adapter is a cached per-exchange singleton shared by every fund in
   * the process, so the single heartbeat timer is refcounted by owner key:
   * each consumer (fund) registers on start and deregisters on stop, and the
   * timer is only cleared when the last consumer stops. This prevents
   * stopping fund A from killing fund B's heartbeat (which would let Gemini
   * auto-cancel fund B's open orders ~5 minutes later).
   * Calls are idempotent per owner — double-start/double-stop from the same
   * engine cannot skew the refcount.
   */
  let heartbeatTimer = null;
  const heartbeatOwners = new Set();
  adapter.startHeartbeat = (owner = 'default') => {
    heartbeatOwners.add(owner);
    if (heartbeatTimer) {
      console.log(`💓 [gemini] Heartbeat already running — ${owner} registered (${heartbeatOwners.size} consumer(s))`);
      return;
    }
    const HEARTBEAT_MS = 60000; // Send every 60s (well within 5-min timeout)
    const sendHeartbeat = () => {
      makeRestRequest('/v1/heartbeat')
        .then(res => {
          if (res?.result !== 'ok') {
            console.log(`⚠️ [gemini] Heartbeat response: ${JSON.stringify(res)}`);
          }
        })
        .catch(err => {
          console.log(`⚠️ [gemini] Heartbeat failed: ${err.message}`);
        });
    };
    sendHeartbeat(); // Send immediately
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    console.log(`💓 [gemini] Heartbeat started by ${owner} (every ${HEARTBEAT_MS / 1000}s)`);
  };

  adapter.stopHeartbeat = (owner = 'default') => {
    heartbeatOwners.delete(owner);
    if (heartbeatOwners.size > 0) {
      console.log(`💓 [gemini] Heartbeat kept alive after ${owner} stopped (${heartbeatOwners.size} consumer(s) remain)`);
      return;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      console.log(`💔 [gemini] Heartbeat stopped by ${owner} (no consumers remain)`);
    }
  };

  /**
   * Get all trades for a symbol since a timestamp (paginated)
   * @param {string} symbol - Trading pair symbol (e.g., 'btcusd')
   * @param {number} sinceTimestampMs - Start timestamp in milliseconds
   * @returns {Promise<Array>} All trades since the timestamp
   */
  adapter.getAllTrades = (symbol, sinceTimestampMs) => fetchTradesSince(symbol, sinceTimestampMs);

  return adapter;
};

module.exports = {
  createGeminiAdapter,
  createRestThrottle,
  isRetryableRateLimit,
};
