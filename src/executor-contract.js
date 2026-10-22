// @ts-check
/**
 * Order Executor Contract
 *
 * Declares the required interface and validation for order executors
 * (live and dry-run). Mirrors the adapter contract pattern in
 * src/adapters/base-adapter.js.
 */

const REQUIRED_EXECUTOR_METHODS = [
  'placeEntryBid',
  'placeTakeProfitOrder',
  'cancelTpOrder',
  'cancelAllEntries',
  'handleOrderFill',
  'handleOrderCancel',
  'getPendingCounts',
  'getPendingEntries',
  'restorePendingOrder',
  'markSettled',
  'isTrackedTpOrder',
  'getOrderPlacedAt',
  'placeBodyTpOrder',
  'cancelBodyTpOrder',
  'restoreBodyTpOrder',
  'removeBodyTracking',
  'placeLadderOrders',
  'cancelAllLadderOrders',
  'getPendingLadderOrders',
  'isLadderOrder',
  'setPriceIncrement',
  'clearTimers',
];

// Test-only accessors (`getActiveTpOrderId`, `getBodyByTpOrderId`) are exposed by
// both executors under a `_test` namespace, not as contract methods (issue #1611).

/**
 * Validate that an executor implements all required methods
 * @param {Object} executor - Executor instance to validate
 * @param {string} name - Executor name for error messages ('live' | 'dry-run')
 * @returns {void}
 * @throws {Error} If executor is missing required methods
 */
const validateExecutor = (executor, name) => {
  if (!executor || typeof executor !== 'object') {
    throw new Error(`Executor '${name}' must be an object`);
  }
  const missing = REQUIRED_EXECUTOR_METHODS.filter(method => typeof executor[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Executor '${name}' missing required methods: ${missing.join(', ')}`);
  }
};

/**
 * Order lookups that are byte-identical in both executors. Both close over
 * their own `pendingOrders` Map, so this factory takes it and returns the
 * shared read-only helpers to be spread into each executor's return object.
 * @param {Map<string, any>} pendingOrders - Executor's pending order map
 * @returns {{isLadderOrder: (orderId: string) => boolean, getOrderPlacedAt: (orderId: string) => (number|null)}}
 */
const createOrderLookups = (pendingOrders) => ({
  isLadderOrder: (orderId) => pendingOrders.get(orderId)?.type === 'ladder_entry',
  getOrderPlacedAt: (orderId) => {
    const order = pendingOrders.get(orderId);
    return order ? order.placedAt : null;
  },
});

module.exports = {
  createOrderLookups,
  REQUIRED_EXECUTOR_METHODS,
  validateExecutor,
};
