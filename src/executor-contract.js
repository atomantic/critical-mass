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
  'refreshStaleOrders',
  'atomicReplace',
  'cancelAllEntries',
  'handleOrderFill',
  'handleOrderCancel',
  'getPendingCounts',
  'getPendingEntries',
  'checkInvariants',
  'getActiveTpOrderId',
  'getSummary',
  'clearPendingOrders',
  'restorePendingOrder',
  'markSettled',
  'getOrderPlacedAt',
  'placeBodyTpOrder',
  'cancelBodyTpOrder',
  'cancelAllBodyTpOrders',
  'isBodyTpOrder',
  'getBodyByTpOrderId',
  'restoreBodyTpOrder',
  'removeBodyTracking',
  'placeLadderOrders',
  'cancelAllLadderOrders',
  'getPendingLadderOrders',
  'isLadderOrder',
  'setPriceIncrement',
  'clearTimers',
];

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

module.exports = {
  REQUIRED_EXECUTOR_METHODS,
  validateExecutor,
};
