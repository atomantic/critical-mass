// @ts-check
/**
 * Resolve a stuck placement intent from exchange evidence.
 *
 * A client-order-id lookup cannot settle every intent: a process that died
 * before the response never recorded the id, and an empty lookup may reflect
 * bounded exchange history. Both used to block the fund until an operator
 * searched the exchange by hand. This does that search: it looks for an order
 * this engine does not already own that matches the intent's side, price and
 * size and was created when the intent was dispatched, either still resting or
 * visible through fills. One match is adopted, none clears the intent, and
 * anything ambiguous leaves it blocking.
 */

// Exchange order timestamps may skew slightly ahead of ours, and a dispatch can
// sit in retries or a slow response for a while after the intent was written.
const CREATED_BEFORE_INTENT_MS = 10_000;
const CREATED_AFTER_INTENT_MS = 120_000;
// Wait until any dispatch tied to the intent has landed on the exchange.
const MIN_INTENT_AGE_MS = 2 * 60_000;
// Each untracked fill's order costs a status request; above this the result is
// treated as inconclusive rather than spending a burst of requests.
const MAX_ORDER_LOOKUPS = 20;
// Adapters round the requested size to the product's increment before sending.
const SIZE_TOLERANCE = 1e-3;
const PRICE_TOLERANCE = 1e-6;

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} tolerance - Relative tolerance
 * @returns {boolean}
 */
const withinTolerance = (actual, expected, tolerance) =>
  Number.isFinite(actual) && Math.abs(actual - expected) <= Math.abs(expected) * tolerance + 1e-12;

/**
 * @param {string|number|undefined} createdTime - Exchange order creation time (ISO string or ms)
 * @param {number} intentCreatedAt - When the intent was written (ms)
 * @returns {boolean}
 */
const createdWithDispatch = (createdTime, intentCreatedAt) => {
  const created = typeof createdTime === 'number' ? createdTime : Date.parse(createdTime ?? '');
  return Number.isFinite(created)
    && created >= intentCreatedAt - CREATED_BEFORE_INTENT_MS
    && created <= intentCreatedAt + CREATED_AFTER_INTENT_MS;
};

/**
 * @param {{side?: string}} order
 * @param {string} side - Lowercase intent side
 * @returns {boolean}
 */
const sameSide = (order, side) => !order.side || String(order.side).toLowerCase() === side;

/**
 * Whether a resting order is the intent's placement.
 * @param {import('./types').OpenOrder} order
 * @param {Object} intent
 * @param {string} side
 * @returns {boolean}
 */
const openOrderMatches = (order, intent, side) =>
  String(order.side).toLowerCase() === side
  && (intent.price == null || withinTolerance(order.price, intent.price, PRICE_TOLERANCE))
  && withinTolerance(order.originalSize ?? order.size, intent.size, SIZE_TOLERANCE)
  && createdWithDispatch(order.createdTime, intent.createdAt);

/**
 * Whether one order's fills could have come from the intent's placement: no
 * fill on the wrong side of the limit, and no more filled than was requested.
 * @param {Array<import('./types').ReconciliationFill>} fills
 * @param {Object} intent
 * @param {string} side
 * @returns {boolean}
 */
const fillsFitIntent = (fills, intent, side) => {
  const filled = fills.reduce((sum, f) => sum + f.size, 0);
  if (filled > intent.size * (1 + SIZE_TOLERANCE) + 1e-12) return false;
  if (intent.price == null) return true;
  const limit = intent.price * (side === 'buy' ? 1 + PRICE_TOLERANCE : 1 - PRICE_TOLERANCE);
  return fills.every(f => (side === 'buy' ? f.price <= limit : f.price >= limit));
};

/**
 * @typedef {{verdict: 'absent'}
 *   | {verdict: 'match', order: import('./types').OrderDetails}
 *   | {verdict: 'inconclusive', reason: string}} PlacementEvidence
 */

/**
 * Search the exchange for the order behind a placement intent.
 * @param {Object} params
 * @param {Object} params.adapter - Exchange adapter
 * @param {string} params.productId - Product the intent was placed on
 * @param {Object} params.intent - Persisted placement intent
 * @param {(orderId: string) => boolean} params.isKnownOrder - True for orders this fund already owns
 * @param {(tradeId: string) => boolean} params.isKnownTrade - True for fills already in this fund's ledger
 * @param {number} [params.now] - Clock override for tests
 * @returns {Promise<PlacementEvidence>}
 */
const findPlacementOnExchange = async ({ adapter, productId, intent, isKnownOrder, isKnownTrade, now = Date.now() }) => {
  const inconclusive = (reason) => ({ verdict: /** @type {const} */ ('inconclusive'), reason });
  const side = String(intent?.side ?? '').toLowerCase();
  if ((side !== 'buy' && side !== 'sell') || !(intent.size > 0) || !Number.isFinite(intent.createdAt)) {
    return inconclusive('the intent lacks the side, size or time needed to match exchange orders');
  }
  if (now - intent.createdAt < MIN_INTENT_AGE_MS) {
    return inconclusive('the intent is too recent to rule out an order still landing');
  }
  if (!['getOpenOrders', 'getReconciliationFills', 'getOrder'].every(m => typeof adapter[m] === 'function')) {
    return inconclusive('this exchange adapter cannot list open orders and fills');
  }

  /** @type {Set<string>} */
  const candidates = new Set();
  const openOrders = await adapter.getOpenOrders(productId);
  for (const order of openOrders ?? []) {
    if (order?.orderId && !isKnownOrder(order.orderId) && openOrderMatches(order, intent, side)) {
      candidates.add(order.orderId);
    }
  }

  /** @type {Map<string, Array<import('./types').ReconciliationFill>>} */
  const untrackedFills = new Map();
  const fills = await adapter.getReconciliationFills(productId, intent.createdAt - CREATED_BEFORE_INTENT_MS);
  for (const fill of fills ?? []) {
    if (!fill?.orderId || fill.side !== side || isKnownTrade(fill.tradeId) || isKnownOrder(fill.orderId)) continue;
    if (candidates.has(fill.orderId)) continue;
    untrackedFills.set(fill.orderId, [...(untrackedFills.get(fill.orderId) ?? []), fill]);
  }
  const fillOrderIds = [...untrackedFills].filter(([, orderFills]) => fillsFitIntent(orderFills, intent, side)).map(([orderId]) => orderId);
  if (fillOrderIds.length > MAX_ORDER_LOOKUPS) {
    return inconclusive(`${fillOrderIds.length} untracked orders filled since the dispatch; too many to inspect`);
  }
  for (const orderId of fillOrderIds) {
    const order = await adapter.getOrder(orderId);
    if (sameSide(order, side) && createdWithDispatch(order.createdTime, intent.createdAt)) candidates.add(orderId);
  }

  if (candidates.size === 0) return { verdict: 'absent' };
  if (candidates.size > 1) {
    return inconclusive(`${candidates.size} untracked exchange orders (${[...candidates].join(', ')}) match the intent`);
  }
  const [orderId] = candidates;
  return { verdict: 'match', order: await adapter.getOrder(orderId) };
};

module.exports = {
  findPlacementOnExchange,
  MIN_INTENT_AGE_MS,
};
