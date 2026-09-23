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

// Implemented identically by both executors and exported, but NOT required by
// the contract: nothing in src/, scripts/, admin/, or server.js ever calls
// them (issue #725 verified this — a superset of the three #678 deleted).
// Unlike #678's three, these carry real, still-valuable test coverage with no
// clean production-path substitute (race-conditions.test.js exercises
// getActiveTpOrderId for TP-placement concurrency safety; order-executor /
// placement-intents / regime-placement-adoption / dry-run-executor tests rely
// on isBodyTpOrder + getBodyByTpOrderId — including the #133/#213E dry-run
// cost-basis regression suite, which has no other way to read a body's
// stamped cost basis) — so they stay implemented and test-only rather than
// being deleted outright. Keep this list in sync with types.js's OrderExecutor
// typedef (documented there as optional, bracketed properties).
const TEST_ONLY_EXECUTOR_METHODS = [
  'getActiveTpOrderId',
  'isBodyTpOrder',
  'getBodyByTpOrderId',
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
  TEST_ONLY_EXECUTOR_METHODS,
  validateExecutor,
};
