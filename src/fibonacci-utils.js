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
 * @param {number} cumulativeAsset - Total BTC acquired
 * @returns {number} Average cost per BTC
 */
const getAverageCostBasis = (cumulativeCost, cumulativeAsset) => {
  if (cumulativeAsset <= 0) return 0;
  return cumulativeCost / cumulativeAsset;
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
 * @param {number} cumulativeAsset - Total BTC accumulated in cycle
 * @param {number} holdbackPercent - Percentage to keep as reserves
 * @returns {number} Amount of BTC to sell
 */
const getFibonacciSellQuantity = (cumulativeAsset, holdbackPercent) => {
  return cumulativeAsset * (1 - holdbackPercent / 100);
};

/**
 * Create initial Fibonacci state fields
 * @returns {Object} Initial Fibonacci state
 */
const createInitialFibState = () => ({
  fibPosition: 0,
  fibCycleStartTime: null,
  fibCumulativeCost: 0,
  fibCumulativeAsset: 0,
  fibActiveSellOrderId: null,
  fibPendingHoldback: 0, // Holdback tracked during cycle, credited to reserves on fill
  // Snapshot of fibCumulative{Asset,Cost,Position} at the moment
  // fibActiveSellOrderId was last (re-)consolidated (issue #200, Bug A). Lets
  // updateAfterFibSellFill detect buys folded into cumulative AFTER the
  // active sell was sized (a failed/retried consolidation) and re-seed them
  // into the fresh cycle instead of silently discarding them on reset.
  fibSellOrderCoveredAsset: 0,
  fibSellOrderCoveredCost: 0,
  fibSellOrderCoveredPosition: 0,
  // Asset this cycle already sold through partially-executed sells (cancelled
  // live, or cancelled/expired by the exchange), and the ids of the sells
  // credited, so each is credited once and every replacement sell shrinks by
  // what already sold (issue #1887).
  fibCycleSoldAsset: 0,
  fibCreditedSellOrderIds: [],
});

/**
 * Read buys outside the active sell's placement-time coverage, including holdback.
 * Missing covered-asset means legacy fully-covered state; explicit zero is a real
 * snapshot. Asset presence alone selects all three differences, preserving the
 * arithmetic of incomplete snapshots without normalization.
 * @param {Partial<import('./types').BotState>} state - Current cumulative and covered fields
 * @returns {{ asset: number, cost: number, position: number }} Uncovered buys
 */
const getUncoveredFibBuys = (state) => {
  const hasCoverageSnapshot = state.fibSellOrderCoveredAsset !== undefined;
  return {
    asset: hasCoverageSnapshot ? (state.fibCumulativeAsset || 0) - state.fibSellOrderCoveredAsset : 0,
    cost: hasCoverageSnapshot ? (state.fibCumulativeCost || 0) - state.fibSellOrderCoveredCost : 0,
    position: hasCoverageSnapshot ? (state.fibPosition || 0) - state.fibSellOrderCoveredPosition : 0,
  };
};

/**
 * Asset the active Fibonacci sell's cycle already sold through earlier partial
 * sells, recovered from a state saved before fibCycleSoldAsset existed (issue
 * #1890). Each (re-)consolidated sell is sized as its covered asset less the
 * pending holdback less what already sold, so the persisted coverage snapshot,
 * holdback and outstanding remainder give back the sold quantity. No active
 * sell, or no coverage snapshot (legacy fully-covered state), means nothing
 * sold; dust and negative remainders read as zero.
 * @param {Partial<import('./types').BotState>} state - Persisted Fibonacci fields
 * @returns {number} Asset already sold in the active cycle
 */
const getLegacyFibCycleSoldAsset = (state) => {
  if (!state.fibActiveSellOrderId || state.fibSellOrderCoveredAsset === undefined) return 0;
  const sold = state.fibSellOrderCoveredAsset - (state.fibPendingHoldback || 0) - (state.outstandingOrdersAsset || 0);
  return sold > 1e-8 ? sold : 0;
};

/**
 * Reset Fibonacci state after a cycle completes
 * @returns {Object} Reset Fibonacci state
 */
const resetFibState = () => ({
  fibPosition: 0,
  fibCycleStartTime: null,
  fibCumulativeCost: 0,
  fibCumulativeAsset: 0,
  fibActiveSellOrderId: null,
  fibPendingHoldback: 0,
  fibSellOrderCoveredAsset: 0,
  fibSellOrderCoveredCost: 0,
  fibSellOrderCoveredPosition: 0,
  fibCycleSoldAsset: 0,
  fibCreditedSellOrderIds: [],
});

module.exports = {
  FIBONACCI,
  getFibonacciMultiplier,
  getFibonacciBuyAmount,
  getAverageCostBasis,
  getFibonacciSellPrice,
  getFibonacciSellQuantity,
  createInitialFibState,
  resetFibState,
  getUncoveredFibBuys,
  getLegacyFibCycleSoldAsset,
};
