// @ts-check
const path = require('path');
const crypto = require('crypto');
const { getAuthHeaders } = require('./auth');
const { createBaseAdapter, createAmbiguousPlacementError, isUsableOrderId, buildFill, createPriceUnavailableError } = require('../base-adapter');
const { withAbortTimeout, createNetworkError } = require('../http');
const { incrementToDecimals, floorToIncrement, finiteFloat, sleep: defaultSleep } = require('../../shared-utils');
const { createContextLogger } = require('../../logger');
const { DATA_DIR } = require('../../paths');
const { validateCoinbaseKeys, createKeyFileLoader } = require('../key-validation');

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

// GET-only HTTP retry (#1621): 429 and gateway-class 5xx are transient. 3 total
// attempts (2 retries), each delay capped at 10s. POSTs are never retried.
const HTTP_RETRY_MAX = 2;
const HTTP_RETRY_BASE_MS = 1000;
const HTTP_RETRY_CEILING_MS = 10000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
// Returned from the deadline-scoped request body to ask the attempt loop to retry.
const HTTP_RETRY = Symbol('coinbase-http-retry');
const CLIENT_ORDER_LOOKUP_MAX_PAGES = 64;

/**
 * Parse a Retry-After header (delta-seconds or HTTP date) to milliseconds.
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {number|null}
 */
const parseRetryAfterMs = (value, now = Date.now()) => {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : null;
  const date = Date.parse(String(value));
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

/**
 * Backoff before the next GET retry: exponential with up to 25% jitter,
 * raised to Retry-After when the server sent one, capped at the ceiling.
 * @param {number} retryIndex - zero-based retry number
 * @param {number|null} retryAfterMs
 * @param {() => number} random
 * @returns {number}
 */
const computeHttpRetryDelayMs = (retryIndex, retryAfterMs, random) => {
  const backoff = HTTP_RETRY_BASE_MS * Math.pow(2, retryIndex);
  const withJitter = backoff + backoff * 0.25 * random();
  return Math.min(Math.max(withJitter, retryAfterMs ?? 0), HTTP_RETRY_CEILING_MS);
};

/**
 * Map a Coinbase create-order response to the adapter's placement result.
 * @param {any} result - Raw create-order response
 * @param {string} clientOrderId
 * @param {Object} [extra] - Call-specific fields (baseSize, limitPrice, ...)
 */
const mapOrderResponse = (result, clientOrderId, extra = {}) => ({
  orderId: result.order_id || result.success_response?.order_id,
  clientOrderId,
  success: result.success !== false && isUsableOrderId(result.order_id || result.success_response?.order_id),
  errorMessage: result.failure_response?.message || result.error_response?.message,
  ...extra,
});

/**
 * Create a Coinbase adapter instance
 * @param {string|null} [keysPath] - Path to keys file (defaults to data/coinbase-keys.json)
 * @param {{sleep?: (ms: number) => Promise<void>, random?: () => number}} [deps] - Injectable for tests
 * @returns {ExchangeAdapter} Coinbase adapter with all required methods
 */
const createCoinbaseAdapter = (keysPath = null, { sleep = defaultSleep, random = Math.random } = {}) => {
  // Resolve keys path
  const resolvedKeysPath = keysPath || path.join(DATA_DIR, 'coinbase-keys.json');

  // Start with base adapter
  const adapter = createBaseAdapter('coinbase');
  const logger = createContextLogger({ exchange: 'coinbase' });

  // Shared keys-file loader. Only ever reads `resolvedKeysPath` — no legacy
  // root-`keys.json` fallback (issue #688: a fallback here meant deleting the
  // configured key via the API left the engine signing with the old credential).
  // `src/migration.js`'s one-time migration is the only way a legacy file is consumed.
  const keyLoader = createKeyFileLoader({
    keysPath: resolvedKeysPath,
    label: 'Coinbase',
    validate: validateCoinbaseKeys,
    // Handle both old format (name/privateKey) and direct format
    pick: (keys) => ({ apiKey: keys.name || keys.apiKey, apiSecret: keys.privateKey || keys.apiSecret }),
    requiredMessage: 'Invalid API keys. Both API key name and private key are required.',
  });
  adapter.hasValidKeys = keyLoader.hasValidKeys;
  adapter.loadCredentials = keyLoader.loadCredentials;

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
   * Whether this endpoint places a new order. A network error on one of these
   * POSTs is the ambiguous case: the request may have reached the matching
   * engine and executed, so it must NOT be blind-retried (the retry re-sends
   * the same deterministic client_order_id → duplicate-rejected while the first
   * order actually filled → untracked position + double-spend). See issue #199.
   * batch_cancel is intentionally excluded — it is not order placement.
   * @param {string} apiPath - API path (may include a query string)
   * @returns {boolean}
   */
  const isOrderPlacementEndpoint = (apiPath) =>
    apiPath.split('?')[0] === '/api/v3/brokerage/orders';

  /**
   * Extract product context from Coinbase product paths and query parameters.
   * @param {string} apiPath
   * @returns {string|undefined}
   */
  const getPairFromApiPath = (apiPath) => {
    const [endpoint, query = ''] = apiPath.split('?');
    const pathMatch = endpoint.match(/\/products\/([^/]+)/);
    if (pathMatch) return decodeURIComponent(pathMatch[1]);
    const params = new URLSearchParams(query);
    return params.get('product_id') || params.get('product_ids') || undefined;
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
    const body = data ? JSON.stringify(data) : undefined;

    let lastError;
    let httpRetries = 0;
    let pendingDelayMs = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (pendingDelayMs > 0) {
        await sleep(pendingDelayMs);
        pendingDelayMs = 0;
      }
      // Sign per attempt: the JWT expires after 120s, so a late retry must not
      // reuse the first attempt's token (#1621).
      const authHeaders = getAuthHeaders(apiKey, apiSecret, method, apiPath);
      const fetchOptions = {
        method,
        headers: data ? { ...authHeaders, 'Content-Type': 'application/json' } : authHeaders,
        ...(body !== undefined ? { body } : {}),
      };
      // The abort deadline must stay armed through the awaited body read, not
      // just the header phase: a reset or stalled body has no application
      // deadline once the timer is cleared early, so it can hang forever
      // instead of surfacing as a retryable/reconcilable failure. Cleared in
      // `finally` only after the whole request (headers + body) settles —
      // mirrors the Gemini/Crypto.com adapters, which keep body reads inside
      // the same try/signal scope. (#428)
      try {
        const outcome = await withAbortTimeout(async (signal, controller) => {
          const response = await fetch(`${BASE_URL}${apiPath}`, {
            ...fetchOptions,
            signal,
          });

          if (!response.ok) {
            // A server/gateway failure is not proof that the matching engine
            // rejected the order. Reconcile the sent id instead of releasing
            // its intent and allowing the next cycle to submit another order.
            if (method === 'POST' && isOrderPlacementEndpoint(apiPath) && response.status >= 500) {
              // We do not need the error body; abort it before finally clears
              // the deadline so a stalled body cannot retain the connection.
              controller.abort();
              throw createAmbiguousPlacementError('Coinbase', `${method} ${apiPath.split('?')[0]}`, data?.client_order_id, `HTTP ${response.status}`);
            }
            if (method === 'GET' && RETRYABLE_HTTP_STATUSES.has(response.status) && httpRetries < HTTP_RETRY_MAX && attempt < retries) {
              const delay = computeHttpRetryDelayMs(httpRetries, parseRetryAfterMs(response.headers?.get?.('retry-after')), random);
              const endpoint = apiPath.split('?')[0];
              logger.warn(`⚠️ [coinbase] HTTP ${response.status} on ${method} ${endpoint}, retrying in ${delay}ms (retry ${httpRetries + 1}/${HTTP_RETRY_MAX})`, {
                pair: getPairFromApiPath(apiPath),
                method,
                endpoint,
                status: response.status,
                delayMs: delay,
              });
              httpRetries++;
              pendingDelayMs = delay;
              controller.abort();
              return HTTP_RETRY; // withAbortTimeout's finally clears the deadline timer
            }
            const errData = await response.json().catch(() => ({}));
            const message = errData.message || errData.error_details || response.statusText;
            const errorData = errData.error || '';
            const cleanError = new Error(`Coinbase API ${response.status}: ${message}${errorData ? ` (${errorData})` : ''}`);
            cleanError.status = response.status;
            cleanError.endpoint = `${method} ${apiPath}`;
            throw cleanError;
          }

          // A 2xx whose body we cannot decode (undecodable JSON, or the body
          // stalls/resets and the deadline above aborts it) is the same
          // ambiguity as a lost response on a placement POST: Coinbase accepted
          // something we can't read, so the outcome is unknown, not a clean
          // failure. (#427/#428)
          if (method === 'POST' && isOrderPlacementEndpoint(apiPath)) {
            let acknowledgement;
            try {
              acknowledgement = await response.json();
            } catch (err) {
              throw createAmbiguousPlacementError('Coinbase', `${method} ${apiPath.split('?')[0]}`, data?.client_order_id, `undecodable response: ${err.message}`);
            }
            const orderId = acknowledgement?.order_id || acknowledgement?.success_response?.order_id;
            const rejected = acknowledgement?.success === false &&
              [acknowledgement.error_response?.error, acknowledgement.error_response?.message,
                acknowledgement.failure_response?.message].some(value => typeof value === 'string' && value.trim());
            // An empty success envelope is not proof that the submitted order
            // was refused. Keep the dispatched id on the reconciliation path.
            if (!rejected && (!isUsableOrderId(orderId) || acknowledgement?.success === false)) {
              throw createAmbiguousPlacementError('Coinbase', `${method} ${apiPath.split('?')[0]}`, data?.client_order_id, 'malformed order acknowledgement');
            }
            return acknowledgement;
          }
          return await response.json();
        });
        if (outcome === HTTP_RETRY) continue;
        return outcome;
      } catch (err) {
        lastError = err;
        // Already-classified outcomes must propagate untouched: a definitive
        // HTTP client rejection (numeric status) and an ambiguous placement
        // outcome (unknownOutcome —
        // thrown above for exactly this attempt, never retried) both bypass
        // the network-error classification below.
        if (typeof lastError.status === 'number' || lastError.unknownOutcome) {
          throw lastError;
        }
      }

      // Only reachable for an unclassified transport/decode failure: either
      // fetch() itself failed before headers arrived, or (new in #428) a
      // non-placement success-body read stalled/reset/failed to parse after a
      // 2xx. Both look identical here — neither carries a `.status`.

      // Order-placement POST whose fetch() failed before headers arrived: the
      // outcome is UNKNOWN — the order may have executed on the exchange.
      // Surface a distinct status so the caller can reconcile against the
      // exchange by the deterministic client_order_id the request carried,
      // instead of blind-retrying or assuming a clean failure and re-buying.
      // See issues #199/#226. (The 2xx-body-read case is handled above, before
      // this classification, so this is a single attempt either way.)
      if (method === 'POST' && isOrderPlacementEndpoint(apiPath)) {
        throw createAmbiguousPlacementError('Coinbase', `${method} ${apiPath.split('?')[0]}`, data?.client_order_id, lastError.message);
      }

      // Only retry idempotent GETs on a network error — including a body read
      // that failed/stalled after 2xx headers, per the existing retry ceiling.
      // A POST that network-errors may have already reached the matching
      // engine, so a blind retry re-sends the same client_order_id and risks a
      // double-place — the same reasoning the Gemini adapter documents
      // (gemini/api.js: "Network errors are NOT retried"). Non-GET methods
      // fall through to a terminal throw below. (429/other HTTP errors are
      // handled by the !response.ok branch above and are never
      // network-retried here.)
      if (attempt < retries && method === 'GET' && isTransientNetworkError(lastError)) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        const endpoint = apiPath.split('?')[0];
        logger.warn(`⚠️ [coinbase] Network error on ${method} ${endpoint}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`, {
          pair: getPairFromApiPath(apiPath),
          method,
          endpoint,
          delayMs: delay,
          attempt: attempt + 1,
          retries,
          error: lastError.message,
        });
        pendingDelayMs = delay;
        continue;
      }

      // Non-retryable error or out of retries
      throw createNetworkError(`Coinbase API network error: ${lastError.message}`, `${method} ${apiPath}`);
    }
  };

  /**
   * Get account balance for a specific currency (handles pagination)
   * Prefers non-vault accounts with balances
   * @param {string} currency - Currency code (e.g., 'USDC', 'BTC')
   * @returns {Promise<AccountBalance>}
   */
  adapter.getAccountBalance = async (currency) => {
    // Paginate defensively, mirroring the hardened getOrderFills loop: this API
    // family can echo a non-empty cursor on the final page, and a stuck cursor
    // that round-trips to the same page would otherwise spin an infinite loop
    // on the hot path (entry sizing, reconcile) — burning rate limit until
    // restart. Guards: honor has_next === false, stop on a repeated cursor,
    // cap total pages, and encodeURIComponent the opaque cursor token. (#208C)
    const basePath = '/api/v3/brokerage/accounts?limit=250';
    const MAX_PAGES = 1000;
    let cursor = null;
    let allMatchingAccounts = [];

    // Collect all accounts for this currency across pages
    for (let page = 0; page < MAX_PAGES; page++) {
      const apiPath = cursor ? `${basePath}&cursor=${encodeURIComponent(cursor)}` : basePath;
      const data = await makeRequest('GET', apiPath);

      const matches = (data.accounts || []).filter(a => a.currency === currency);
      allMatchingAccounts = allMatchingAccounts.concat(matches);

      const nextCursor = data.cursor;
      cursor = (data.has_next !== false && nextCursor && nextCursor !== cursor) ? nextCursor : null;
      if (!cursor) break;
    }

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
    const price = parseFloat(data?.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw createPriceUnavailableError('coinbase', productId, data?.price);
    }
    return price;
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

    return mapOrderResponse(result, clientOrderId);
  };

  /**
   * Place a post-only GTC limit order (shared implementation for buy and sell)
   * @param {'BUY'|'SELL'} side - Order side
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency
   * @param {number} price - Limit price in quote currency
   * @param {Object} [options] - Order options
   * @param {boolean} [options.postOnly] - Whether to use post-only mode (default: true)
   * @param {string} [options.clientOrderId] - Deterministic client order id to send (random when omitted)
   * @returns {Promise<LimitSellResult|LimitBuyResult>} Order result
   */
  const placeLimitOrder = async (side, productId, baseAmount, price, options = {}) => {
    // A caller-supplied id makes the placement reconcilable from its own
    // durable record (manual recovery buys, issue #1058).
    const clientOrderId = options.clientOrderId || crypto.randomUUID();
    const postOnly = options.postOnly !== false; // Default to true

    // Get product details for proper rounding
    const product = await adapter.getProductDetails(productId);

    // Round to proper increments (use floats for arithmetic, strings for precision)
    const baseIncrement = parseFloat(product.baseIncrement);
    const quoteIncrement = parseFloat(product.quoteIncrement);

    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    const roundedPrice = floorToIncrement(price, quoteIncrement);

    // Derive decimal precision from original increment strings to avoid float → scientific-notation issues
    const basePrecision = incrementToDecimals(product.baseIncrement);
    const quotePrecision = incrementToDecimals(product.quoteIncrement);

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: {
        limit_limit_gtc: {
          base_size: roundedAmount.toFixed(basePrecision),
          limit_price: roundedPrice.toFixed(quotePrecision),
          post_only: postOnly,
        },
      },
    };

    const result = await makeRequest('POST', '/api/v3/brokerage/orders', orderData);

    return mapOrderResponse(result, clientOrderId, { baseSize: roundedAmount, limitPrice: roundedPrice, postOnly });
  };

  /**
   * Place a post-only limit sell order
   * @param {string} productId - Product ID
   * @param {number} baseAmount - Amount of base currency to sell
   * @param {number} price - Limit price in quote currency
   * @param {Object} [options] - Order options
   * @returns {Promise<LimitSellResult>} Order result
   */
  adapter.placeLimitSell = async (productId, baseAmount, price, options = {}) => {
    return placeLimitOrder('SELL', productId, baseAmount, price, options);
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
    return placeLimitOrder('BUY', productId, baseAmount, price, options);
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
   * Find an order on the exchange by its deterministic client_order_id.
   * Used to reconcile an ambiguous 'unknown' placement outcome (issue #226): a
   * network error after the order POST may have reached the matching engine, so
   * before re-placing we look for an order carrying the client_order_id we sent.
   * Scans paginated history (scoped to productId when provided) and normalizes
   * the match into the same shape as getOrder. Only a completed scan returns
   * null; incomplete or malformed history throws so callers retain ownership.
   * @param {string} clientOrderId - Deterministic client order ID we submitted
   * @param {string|null} [productId] - Optional product to scope the lookup
   * @returns {Promise<OrderDetails|null>} Normalized order details, or null if absent
   */
  adapter.findOrderByClientOrderId = async (clientOrderId, productId = null) => {
    if (!clientOrderId) return null;

    const params = productId
      ? `?product_ids=${encodeURIComponent(productId)}&limit=100`
      : '?limit=100';
    let cursor = null;
    const seenCursors = new Set();
    let match;
    for (let page = 0; page < CLIENT_ORDER_LOOKUP_MAX_PAGES; page++) {
      const continuation = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      let data;
      try {
        data = await makeRequest('GET', `/api/v3/brokerage/orders/historical/batch${params}${continuation}`);
      } catch (err) {
        throw new Error(`Coinbase client order lookup inconclusive: ${err.message}`, { cause: err });
      }
      if (!data || !Array.isArray(data.orders) || typeof data.has_next !== 'boolean'
        || data.orders.some(order => !order || typeof order !== 'object' || Array.isArray(order))) {
        throw new Error('Coinbase client order lookup inconclusive: malformed history page');
      }
      match = data.orders.find(order => order.client_order_id === clientOrderId);
      if (match) break;
      if (!data.has_next) return null;
      if (typeof data.cursor !== 'string' || !data.cursor.trim() || seenCursors.has(data.cursor)) {
        throw new Error('Coinbase client order lookup inconclusive: missing or repeated history cursor');
      }
      seenCursors.add(data.cursor);
      cursor = data.cursor;
    }
    if (!match) {
      throw new Error(`Coinbase client order lookup inconclusive: exceeded ${CLIENT_ORDER_LOOKUP_MAX_PAGES}-page history budget`);
    }

    return {
      orderId: match.order_id,
      productId: match.product_id,
      side: match.side,
      status: match.status,
      filledSize: parseFloat(match.filled_size || 0),
      filledValue: parseFloat(match.filled_value || 0),
      averageFilledPrice: parseFloat(match.average_filled_price || 0),
      completionPercentage: parseFloat(match.completion_percentage || 0),
      totalFees: parseFloat(match.total_fees || 0),
      createdTime: match.created_time,
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
      // finiteFloat (not a bare `parseFloat(x || 0)`) guards a TRUTHY but
      // non-numeric field too — e.g. filled_size: "N/A" — which would
      // otherwise parse to NaN and poison the size subtraction below (NaN
      // fails every `> 0` gate the same way undefined did before this fix).
      const originalSize = finiteFloat(limitCfg.base_size || stopCfg.base_size);
      const price = finiteFloat(limitCfg.limit_price || stopCfg.limit_price);
      const filledSize = finiteFloat(order.filled_size);
      // size is the REMAINING unfilled quantity, not the size the order was
      // originally placed for (issue #684 — a caller like the orphan-sell
      // detector wants "how much is still on the book," and reporting the
      // original size on a partial fill misrepresents it). Clamp at zero: an
      // unrecognized order_configuration shape can leave originalSize at its
      // 0 fallback while filled_size is still reported nonzero, which would
      // otherwise yield a negative size.
      const size = Math.max(0, originalSize - filledSize);

      return {
        orderId: order.order_id,
        productId: order.product_id,
        side: order.side,
        status: order.status,
        size,
        originalSize,
        price,
        filledSize,
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
    // Coinbase paginates this endpoint (~100 fills/page by default). Loop on the
    // response cursor accumulating every page so high-fill-count orders aren't
    // truncated — a truncated set under-reports totalSize and corrupts cost-basis
    // proration, holdback, and partial-fill detection downstream. Mirrors the
    // cursor loop in getAccountBalance.
    const PAGE_LIMIT = 250;
    const basePath = `/api/v3/brokerage/orders/historical/fills?order_id=${orderId}&limit=${PAGE_LIMIT}`;
    let cursor = null;
    const allFills = [];

    do {
      // Cursors are opaque tokens that may contain =, +, / — encode before interpolating.
      const apiPath = cursor ? `${basePath}&cursor=${encodeURIComponent(cursor)}` : basePath;
      const data = await makeRequest('GET', apiPath);

      allFills.push(...(data.fills || []));

      // Terminate on Coinbase's documented has_next === false signal (the response
      // can echo a non-empty cursor on the final page). Fall back to an empty/absent
      // cursor, and guard against a stuck cursor that repeats to avoid an infinite loop.
      const nextCursor = data.cursor;
      cursor = (data.has_next !== false && nextCursor && nextCursor !== cursor) ? nextCursor : null;
    } while (cursor);

    const fillsByTradeId = new Map();
    return allFills.map(fill => {
      // Extract detailed commission breakdown
      const commissionDetail = fill.commission_detail_total || {};

      // Coinbase returns `size_in_quote` as a boolean flag (not a numeric size).
      // When true (e.g. market-buy fills), `size` is denominated in quote
      // currency (USDC), so convert it to base currency and derive the quote
      // notional separately — mirroring the reconciliation contract and the
      // Gemini/Crypto.com adapters, where `size` is base currency and
      // `sizeInQuote` is the quote-currency amount.
      const price = parseFloat(fill.price);
      const rawSize = parseFloat(fill.size);
      const sizeInQuote = fill.size_in_quote === true || fill.size_in_quote === 'true';
      const size = sizeInQuote && price > 0 ? rawSize / price : rawSize;
      const quoteAmount = sizeInQuote ? rawSize : price * size;

      return {
        ...buildFill({
          tradeId: fill.trade_id,
          orderId: fill.order_id,
          productId: fill.product_id,
          side: fill.side,
          price,
          size,
          sizeInQuote: quoteAmount,
          // Fee breakdown
          commission: parseFloat(fill.commission || 0),
          totalCommission: parseFloat(commissionDetail.total_commission || fill.commission || 0),
          rebate: parseFloat(commissionDetail.rebate || 0),
          tradeTime: fill.trade_time,
          liquidityIndicator: fill.liquidity_indicator, // MAKER or TAKER
        }),
        // Raw commission detail for debugging
        commissionDetail,
      };
    }).filter(fill => {
      // Dedup before callers size bodies/recovery orders, but reject conflicting
      // copies instead of hiding malformed economics behind a valid execution.
      const tradeId = fill.tradeId;
      if (typeof tradeId !== 'string' || !tradeId) return true;
      const prior = fillsByTradeId.get(tradeId);
      if (prior) {
        // commissionDetail is debug-only; normalized scalar fields are canonical.
        if (Object.keys(fill).some(key => key !== 'commissionDetail' && !Object.is(prior[key], fill[key]))) {
          throw new Error(`Conflicting Coinbase fill data for trade ${tradeId} on order ${orderId}`);
        }
        return false;
      }
      fillsByTradeId.set(tradeId, fill);
      return true;
    });
  };

  /**
   * Fetch and normalize every fill used by the ledger reconciliation tools.
   * @param {string|undefined} productId
   * @param {number} startTimestampMs
   * @returns {Promise<import('../../types').ReconciliationFill[]>}
   */
  adapter.getReconciliationFills = async (productId, startTimestampMs) => {
    const normalizedProductId = productId || 'BTC-USDC';
    const startISO = new Date(startTimestampMs).toISOString();
    const basePath = `/api/v3/brokerage/orders/historical/fills?product_id=${encodeURIComponent(normalizedProductId)}&start_sequence_timestamp=${encodeURIComponent(startISO)}&limit=500`;
    const rawFills = [];
    const seenCursors = new Set();
    let cursor = null;
    let truncated = false;

    while (true) {
      const apiPath = cursor ? `${basePath}&cursor=${encodeURIComponent(cursor)}` : basePath;
      const data = await makeRequest('GET', apiPath);
      rawFills.push(...(data.fills || []));

      if (data.has_next === false) break;

      const nextCursor = data.cursor;
      if (!nextCursor) {
        // Coinbase has returned has_next=true without a cursor for otherwise
        // complete responses. There is no safe request to make for a page the
        // API did not identify, so preserve the fills received and stop rather
        // than making every reconciliation pass fail on the inconsistent flag.
        // Routine API quirk, so info rather than warn — it repeats every sweep.
        logger.info(`Coinbase reconciliation response for ${normalizedProductId} indicated more pages without a cursor; treating the current page as final`, {
          productId: normalizedProductId,
          fills: rawFills.length,
        });
        truncated = true;
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`Coinbase reconciliation cursor repeated for ${normalizedProductId}; refusing to return incomplete fills`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const seenTrades = new Set();
    const fills = rawFills.flatMap(raw => {
      const tradeId = String(raw.trade_id || '');
      if (!tradeId || seenTrades.has(tradeId)) return [];
      seenTrades.add(tradeId);
      const price = parseFloat(raw.price || 0);
      const rawSize = parseFloat(raw.size || 0);
      const sizeInQuote = raw.size_in_quote === true || raw.size_in_quote === 'true';
      const size = sizeInQuote && price > 0 ? rawSize / price : rawSize;
      return [{
        tradeId,
        orderId: String(raw.order_id || ''),
        side: String(raw.side || '').toLowerCase(),
        price,
        size,
        quoteAmount: sizeInQuote ? rawSize : price * size,
        fee: parseFloat(raw.commission || 0),
        feeCurrency: normalizedProductId.split('-')[1] || 'USDC',
        timestamp: new Date(raw.trade_time).getTime(),
        liquidityIndicator: raw.liquidity_indicator || 'TAKER',
      }];
    });
    // Callers that must prove a fill is absent (placement-evidence) check this;
    // non-enumerable so the array still compares and serializes as before.
    if (truncated) Object.defineProperty(fills, 'incomplete', { value: true });
    return fills;
  };

  adapter.capabilities.fillReconciliation = true;

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

    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    const roundedStopPrice = floorToIncrement(stopPrice, quoteIncrement);
    const roundedLimitPrice = floorToIncrement(limitPrice, quoteIncrement);

    // Derive decimal precision from original increment strings to avoid float → scientific-notation issues
    const basePrecision = incrementToDecimals(product.baseIncrement);
    const quotePrecision = incrementToDecimals(product.quoteIncrement);

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

    return mapOrderResponse(result, clientOrderId, { baseSize: roundedAmount, stopPrice: roundedStopPrice, limitPrice: roundedLimitPrice });
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
    const roundedAmount = floorToIncrement(baseAmount, baseIncrement);
    // Derive precision from original increment string to avoid float → scientific-notation issues
    const basePrecision = incrementToDecimals(product.baseIncrement);

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

    return mapOrderResponse(result, clientOrderId, { baseSize: roundedAmount });
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
  findOrderByClientOrderId: defaultAdapter.findOrderByClientOrderId,
  getOpenOrders: defaultAdapter.getOpenOrders,
  cancelOrder: defaultAdapter.cancelOrder,
  getOrderFills: defaultAdapter.getOrderFills,
  getOrderFillSummary: defaultAdapter.getOrderFillSummary,
  getCandles: defaultAdapter.getCandles,
  placeStopLimitSell: defaultAdapter.placeStopLimitSell,
  placeMarketSell: defaultAdapter.placeMarketSell,
};
