// @ts-check
/**
 * Fibonacci DCA Strategy Utilities
 *
 * Provides utility functions for the Fibonacci DCA strategy:
 * - Fibonacci sequence generation and lookup
 * - Buy amount calculations
 * - Cost basis and sell price calculations
 * - Cycle state management
 */

/**
 * Pre-computed Fibonacci sequence (first 20 numbers)
 * Position 0 and 1 both return 1 (standard Fibonacci)
 * @type {number[]}
 */
const FIBONACCI = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765];

/**
 * Get the Fibonacci number at a given position
 * @param {number} position - 0-indexed position in sequence
 * @returns {number} Fibonacci number at position
 */
const getFibonacciMultiplier = (position) => {
  if (position < 0) return 1;
  if (position >= FIBONACCI.length) {
    // Compute on-the-fly for positions beyond pre-computed
    let a = FIBONACCI[FIBONACCI.length - 2];
    let b = FIBONACCI[FIBONACCI.length - 1];
    for (let i = FIBONACCI.length; i <= position; i++) {
      const next = a + b;
      a = b;
      b = next;
    }
    return b;
  }
  return FIBONACCI[position];
};

/**
 * Calculate the buy amount for a given Fibonacci position
 * @param {number} position - Current position in Fibonacci sequence (0-indexed)
 * @param {number} baseAmount - Base amount to multiply
 * @returns {number} Buy amount for this position
 */
const getFibonacciBuyAmount = (position, baseAmount) => {
  return getFibonacciMultiplier(position) * baseAmount;
};

/**
 * Calculate weighted average cost basis per BTC
 * @param {number} cumulativeCost - Total cost spent (including fees)
 * @param {number} cumulativeBTC - Total BTC acquired
 * @returns {number} Average cost per BTC
 */
const getAverageCostBasis = (cumulativeCost, cumulativeBTC) => {
  if (cumulativeBTC <= 0) return 0;
  return cumulativeCost / cumulativeBTC;
};

/**
 * Calculate the target sell price for a Fibonacci cycle
 * @param {number} avgCostBasis - Weighted average cost basis per BTC
 * @param {number} markupPercent - Markup percentage for profit
 * @returns {number} Target sell price
 */
const getFibonacciSellPrice = (avgCostBasis, markupPercent) => {
  return avgCostBasis * (1 + markupPercent / 100);
};

/**
 * Calculate the quantity to sell in a Fibonacci cycle
 * @param {number} cumulativeBTC - Total BTC accumulated in cycle
 * @param {number} holdbackPercent - Percentage to keep as reserves
 * @returns {number} Amount of BTC to sell
 */
const getFibonacciSellQuantity = (cumulativeBTC, holdbackPercent) => {
  return cumulativeBTC * (1 - holdbackPercent / 100);
};

/**
 * Create initial Fibonacci state fields
 * @returns {Object} Initial Fibonacci state
 */
const createInitialFibState = () => ({
  fibPosition: 0,
  fibCycleStartTime: null,
  fibCumulativeCost: 0,
  fibCumulativeBTC: 0,
  fibActiveSellOrderId: null,
  fibPendingHoldback: 0, // Holdback tracked during cycle, credited to reserves on fill
});

/**
 * Reset Fibonacci state after a cycle completes
 * @returns {Object} Reset Fibonacci state
 */
const resetFibState = () => ({
  fibPosition: 0,
  fibCycleStartTime: null,
  fibCumulativeCost: 0,
  fibCumulativeBTC: 0,
  fibActiveSellOrderId: null,
  fibPendingHoldback: 0,
});

/**
 * Get a preview of the Fibonacci sequence amounts for display
 * @param {number} baseAmount - Base amount to multiply
 * @param {number} count - Number of positions to show (default: 8)
 * @returns {number[]} Array of buy amounts
 */
const getFibonacciPreview = (baseAmount, count = 8) => {
  const preview = [];
  for (let i = 0; i < count; i++) {
    preview.push(getFibonacciBuyAmount(i, baseAmount));
  }
  return preview;
};

/**
 * Calculate cumulative total spent after N Fibonacci buys
 * @param {number} position - Last position (0-indexed, inclusive)
 * @param {number} baseAmount - Base amount per multiplier
 * @returns {number} Total spent through position N
 */
const getFibonacciCumulativeSpend = (position, baseAmount) => {
  let total = 0;
  for (let i = 0; i <= position; i++) {
    total += getFibonacciBuyAmount(i, baseAmount);
  }
  return total;
};

module.exports = {
  FIBONACCI,
  getFibonacciMultiplier,
  getFibonacciBuyAmount,
  getAverageCostBasis,
  getFibonacciSellPrice,
  getFibonacciSellQuantity,
  createInitialFibState,
  resetFibState,
  getFibonacciPreview,
  getFibonacciCumulativeSpend,
};
