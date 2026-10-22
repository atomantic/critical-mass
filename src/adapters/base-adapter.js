// @ts-check
/**
 * Base adapter interface definition
 * All exchange adapters must implement these methods
 */
const { AsyncLocalStorage } = require('async_hooks');

/**
 * @typedef {import('../types').FillSummary} FillSummary
 * @typedef {import('../types').OrderFill} OrderFill
 */

/**
 * Carries per-call REST throttle/backoff wait time (ms) from an adapter's
 * request layer (e.g. Gemini's `makeRestRequest`) out to the health-monitor
 * instrumentation wrapper, so the wrapper can subtract time spent waiting in
 * a client-side rate-limit queue from the latency it attributes to the
 * exchange (issue #680). `instrumentAdapterForHealth` runs each call inside
 * `restQueueTiming.run({ queuedMs: 0 }, ...)`; the request layer adds to
 * `restQueueTiming.getStore()?.queuedMs` when a store is present (it is a
 * no-op — and therefore harmless — for adapters/call paths that never run
 * inside that store, e.g. outside instrumentation or during tests).
 * @type {import('async_hooks').AsyncLocalStorage<{queuedMs: number}>}
 */
const restQueueTiming = new AsyncLocalStorage();

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
 * getReconciliationFills(productId, startTimestampMs) - Get normalized fills for ledger reconciliation
 *   @param {string|undefined} productId - Exchange product ID; adapter supplies its legacy default when omitted
 *   @param {number} startTimestampMs - Inclusive start timestamp in milliseconds
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
  'getReconciliationFills',
  'getCandles',
];

/**
 * Build the ambiguous-placement error every adapter throws when an order POST
 * fails in transport (socket reset, timeout, abort), returns a server error,
 * or has an undecodable response. The exchange may ALREADY hold the order, so the
 * outcome is UNKNOWN — never a clean failure and never safe to blind-retry.
 *
 * `clientOrderId` is the deterministic id the adapter sent with the placement:
 * order-manager's placeWithUnknownReconcile reconciles by it (via the adapter's
 * findOrderByClientOrderId) and adopts the real exchange order instead of
 * placing a second one. Dropping the id here is what turns an accepted-but-
 * unacknowledged order into an untracked live position. (#199/#226/#427)
 * @param {string} exchange - Human-readable exchange name for the message
 * @param {string} endpoint - Endpoint label, e.g. 'POST /v1/order/new'
 * @param {string|undefined} clientOrderId - Deterministic client order id we sent
 * @param {string} cause - Underlying failure message
 * @returns {Error & {status: string, unknownOutcome: boolean, endpoint: string, clientOrderId: string|undefined}}
 */
const createAmbiguousPlacementError = (exchange, endpoint, clientOrderId, cause) => {
  const err = /** @type {any} */ (new Error(
    `${exchange} API unknown order outcome on ${endpoint}: ${cause} — order may have reached the matching engine; reconcile by client_order_id before re-placing`
  ));
  err.status = 'unknown';
  err.unknownOutcome = true;
  err.endpoint = endpoint;
  err.clientOrderId = clientOrderId;
  return err;
};

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
  capabilities: {
    fillReconciliation: false,
  },

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

// The one shared sleep (#1605); exported so adapters can inject/override it in tests.
const { sleep: defaultSleep } = require('../shared-utils');

/**
 * Await `waitPromise` (if any) and, when running inside a
 * `restQueueTiming.run(...)` store, add the elapsed time to `store.queuedMs`
 * so `instrumentAdapterForHealth` can subtract client-side throttle/backoff
 * wait from the latency it attributes to the exchange (issue #680). A no-op —
 * and therefore harmless — when no store is present (e.g. a call made outside
 * health instrumentation, or in tests).
 * @param {Promise<void>|null|undefined} waitPromise
 * @returns {Promise<void>}
 */
const awaitAndAccountQueuedTime = async (waitPromise) => {
  if (!waitPromise) return;
  const startedAt = Date.now();
  await waitPromise;
  const store = restQueueTiming.getStore();
  if (store) store.queuedMs += Date.now() - startedAt;
};

const FILL_SCAN_RETRIES = 2;
const FILL_SCAN_RETRY_DELAY_MS = 750;

/**
 * Eventual-consistency verification shared by the `getOrderFills`
 * implementations. Fetches the fills matching an order, sums them, and — while
 * the sum is short of what the exchange says executed — retries a bounded
 * number of times (queued-time accounted) before throwing an
 * `incompleteFills` error. A short sum right after a fill is normally the
 * exchange's own trade-history indexing lag; a persistent shortfall must stay a
 * rejection because order-executor removes a terminal order from tracking
 * BEFORE invoking its fill callback, so a silent under-report would strand it.
 *
 * `fetchMatching` is invoked once per attempt, so any state it closes over
 * (e.g. Crypto.com's shared page `budget`) persists across retries.
 * @template T
 * @param {Object} params
 * @param {number} params.expected - Quantity the exchange reports as executed
 * @param {() => Promise<T[]>} params.fetchMatching - Fetch this order's matching rows
 * @param {(row: T) => number} params.sumOf - Quantity contributed by one row
 * @param {string} params.label - Message prefix (e.g. '[gemini]', 'Crypto.com')
 * @param {string|number} params.orderId
 * @param {number} [params.retries] - Re-scans after the first attempt
 * @param {number} [params.delayMs] - Wait between attempts
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @returns {Promise<T[]>} The matching rows once they account for `expected`
 */
const collectOrderFillsWithRetry = async ({
  expected,
  fetchMatching,
  sumOf,
  label,
  orderId,
  retries = FILL_SCAN_RETRIES,
  delayMs = FILL_SCAN_RETRY_DELAY_MS,
  sleep = defaultSleep,
}) => {
  let matching;
  let totalMatched;
  for (let attempt = 0; ; attempt++) {
    matching = await fetchMatching();
    totalMatched = matching.reduce((sum, row) => sum + sumOf(row), 0);
    if (totalMatched >= expected - 1e-9 || attempt >= retries) break;
    await awaitAndAccountQueuedTime(sleep(delayMs));
  }

  if (totalMatched < expected - 1e-9) {
    throw Object.assign(
      new Error(`${label} getOrderFills: fills incomplete for ${orderId}: ${totalMatched} of ${expected}`),
      { incompleteFills: true }
    );
  }
  return matching;
};

/**
 * Construct the normalized `OrderFill` returned by every adapter's
 * `getOrderFills`. Exchange-specific field mapping stays in the adapter; this
 * only owns the shape and the derived defaults.
 * @param {Object} f
 * @param {string|undefined} f.tradeId
 * @param {string|undefined} f.orderId
 * @param {string|undefined} f.productId
 * @param {string|undefined} f.side
 * @param {number} f.price
 * @param {number} f.size - Base-currency size
 * @param {number} [f.sizeInQuote] - Quote notional (default price * size)
 * @param {number} f.commission
 * @param {number} [f.totalCommission] - Default `commission`
 * @param {number} [f.rebate] - Default 0
 * @param {number} [f.netFee] - Default totalCommission - rebate
 * @param {string} f.tradeTime - ISO timestamp (or the exchange's raw value)
 * @param {string|undefined} f.liquidityIndicator
 * @returns {OrderFill}
 */
const buildFill = ({
  tradeId, orderId, productId, side, price, size,
  sizeInQuote = price * size,
  commission,
  totalCommission = commission,
  rebate = 0,
  netFee = totalCommission - rebate,
  tradeTime, liquidityIndicator,
}) => ({
  tradeId,
  orderId,
  productId,
  side,
  price,
  size,
  sizeInQuote,
  commission,
  totalCommission,
  rebate,
  netFee,
  tradeTime,
  liquidityIndicator,
});

/**
 * Error for a ticker reply that carried no usable price (missing, blank,
 * zero or negative). Worded and tagged as a transient dependency outage so
 * fund-start-supervisor's isTransientStartError retries it rather than
 * blocking the fund (its /invalid/ check would otherwise fail closed).
 * @param {string} exchange
 * @param {string} productId
 * @param {unknown} raw - the raw ticker value that failed validation
 * @returns {Error & { code: 'PRICE_UNAVAILABLE' }}
 */
const createPriceUnavailableError = (exchange, productId, raw) => Object.assign(
  new Error(`Price temporarily unavailable from ${exchange} for ${productId} (ticker returned ${JSON.stringify(raw ?? null)})`),
  { code: 'PRICE_UNAVAILABLE' }
);

module.exports = {
  REQUIRED_METHODS,
  createPriceUnavailableError,
  validateAdapter,
  createBaseAdapter,
  createAmbiguousPlacementError,
  restQueueTiming,
  defaultSleep,
  awaitAndAccountQueuedTime,
  collectOrderFillsWithRetry,
  buildFill,
};
