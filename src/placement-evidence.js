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

const { floorToIncrement } = require('./shared-utils');

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
// An order size derived from filled size and a completion percentage carries
// the exchange's rounding of that percentage.
const DERIVED_SIZE_TOLERANCE = 0.02;
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
 * The values an intent's order could carry on the exchange. The intent records
 * the requested size and price, but adapters floor both to the product's
 * increments before sending, which can move them well past the matching
 * tolerances on coarse-tick products (e.g. a ~$0.10 price on a 1e-5 tick).
 * Both the requested and the floored value are candidates.
 * @typedef {{sizes: number[], prices: number[]}} PlacementCandidates
 * @param {Object} intent
 * @param {{baseIncrement?: string|number, quoteIncrement?: string|number}|null} increments
 * @returns {PlacementCandidates}
 */
const placementCandidates = (intent, increments) => {
  const floored = (value, increment) => {
    const inc = Number(increment);
    return inc > 0 && Number.isFinite(value) ? floorToIncrement(value, inc) : value;
  };
  const sizes = [intent.size, floored(intent.size, increments?.baseIncrement)];
  const prices = intent.price == null ? [] : [intent.price, floored(intent.price, increments?.quoteIncrement)];
  return { sizes: [...new Set(sizes)], prices: [...new Set(prices)] };
};

/**
 * Whether a resting order is the intent's placement.
 * @param {import('./types').OpenOrder} order
 * @param {Object} intent
 * @param {string} side
 * @param {PlacementCandidates} candidates
 * @returns {boolean}
 */
const openOrderMatches = (order, intent, side, candidates) =>
  String(order.side).toLowerCase() === side
  && (intent.price == null || candidates.prices.some(p => withinTolerance(order.price, p, PRICE_TOLERANCE)))
  && candidates.sizes.some(s => withinTolerance(order.originalSize ?? order.size, s, SIZE_TOLERANCE))
  && createdWithDispatch(order.createdTime, intent.createdAt);

/**
 * An order's requested size from its status: filled size over the completion
 * percentage. Null when the status cannot say (nothing filled yet).
 * @param {import('./types').OrderDetails} order
 * @returns {number|null}
 */
const derivedOrderSize = (order) => (
  order.completionPercentage > 0 && order.filledSize > 0 ? order.filledSize * 100 / order.completionPercentage : null
);

/**
 * Whether one order's fills could have come from the intent's placement: no
 * fill on the wrong side of the limit, and no more filled than was requested.
 * The limit is the loosest candidate price, so a fill at the floored limit of a
 * sell still fits (a buy's floored limit is lower, so its requested price is
 * already the looser bound).
 * @param {Array<import('./types').ReconciliationFill>} fills
 * @param {Object} intent
 * @param {string} side
 * @param {PlacementCandidates} candidates
 * @returns {boolean}
 */
const fillsFitIntent = (fills, intent, side, candidates) => {
  const filled = fills.reduce((sum, f) => sum + f.size, 0);
  if (filled > Math.max(...candidates.sizes) * (1 + SIZE_TOLERANCE) + 1e-12) return false;
  if (intent.price == null) return true;
  const limit = side === 'buy'
    ? Math.max(...candidates.prices) * (1 + PRICE_TOLERANCE)
    : Math.min(...candidates.prices) * (1 - PRICE_TOLERANCE);
  return fills.every(f => (side === 'buy' ? f.price <= limit : f.price >= limit));
};

/**
 * @typedef {{verdict: 'absent'}
 *   | {verdict: 'match', order: import('./types').OrderDetails, resting: boolean}
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

  // Without the product's increments the exchange-rounded order may not match.
  let increments = null;
  if (typeof adapter.getProductDetails === 'function') {
    increments = await adapter.getProductDetails(productId).catch(() => null);
    if (!increments) return inconclusive('product increments are unavailable to match the exchange-rounded order');
  }
  const placement = placementCandidates(intent, increments);

  /** @type {Set<string>} */
  const candidates = new Set();
  const openOrders = await adapter.getOpenOrders(productId);
  // A truncated listing cannot prove the placement is not resting.
  if (openOrders?.incomplete) return inconclusive('the exchange returned an incomplete open-order list');
  for (const order of openOrders ?? []) {
    if (order?.orderId && !isKnownOrder(order.orderId) && openOrderMatches(order, intent, side, placement)) {
      candidates.add(order.orderId);
    }
  }
  const restingIds = new Set(candidates);

  /** @type {Map<string, Array<import('./types').ReconciliationFill>>} */
  const untrackedFills = new Map();
  const fills = await adapter.getReconciliationFills(productId, intent.createdAt - CREATED_BEFORE_INTENT_MS);
  // A partial history cannot prove that the placement never filled.
  if (fills?.incomplete) return inconclusive('the exchange returned an incomplete fill history');
  for (const fill of fills ?? []) {
    if (!fill?.orderId || fill.side !== side || isKnownTrade(fill.tradeId) || isKnownOrder(fill.orderId)) continue;
    if (candidates.has(fill.orderId)) continue;
    untrackedFills.set(fill.orderId, [...(untrackedFills.get(fill.orderId) ?? []), fill]);
  }
  const fillOrderIds = [...untrackedFills].filter(([, orderFills]) => fillsFitIntent(orderFills, intent, side, placement)).map(([orderId]) => orderId);
  if (fillOrderIds.length > MAX_ORDER_LOOKUPS) {
    return inconclusive(`${fillOrderIds.length} untracked orders filled since the dispatch; too many to inspect`);
  }
  let unsizedCandidates = 0;
  for (const orderId of fillOrderIds) {
    const order = await adapter.getOrder(orderId);
    if (!sameSide(order, side) || !createdWithDispatch(order.createdTime, intent.createdAt)) continue;
    // A smaller unrelated order also fits under the limit; require the order's
    // own size to match before treating it as the placement.
    const size = derivedOrderSize(order);
    if (size === null) unsizedCandidates += 1;
    else if (placement.sizes.some(s => withinTolerance(size, s, DERIVED_SIZE_TOLERANCE))) candidates.add(orderId);
  }
  if (unsizedCandidates > 0) {
    return inconclusive(`${unsizedCandidates} untracked order(s) filled at dispatch time without a reported size to compare`);
  }

  if (candidates.size === 0) return { verdict: 'absent' };
  if (candidates.size > 1) {
    return inconclusive(`${candidates.size} untracked exchange orders (${[...candidates].join(', ')}) match the intent`);
  }
  const [orderId] = candidates;
  // `resting` records that the open-order list showed this order live, so a
  // status that contradicts it is not taken as proof the placement is gone.
  return { verdict: 'match', order: await adapter.getOrder(orderId), resting: restingIds.has(orderId) };
};

module.exports = {
  findPlacementOnExchange,
  MIN_INTENT_AGE_MS,
};
