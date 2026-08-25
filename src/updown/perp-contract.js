// @ts-check

/** BTC represented by one UpDown perpetual contract. */
const PERP_CONTRACT_SIZE_BTC = 0.01

/**
 * Calculate USD P&L for an UpDown perpetual position.
 *
 * @param {number} entryPrice
 * @param {number} exitPrice
 * @param {number} contracts
 * @param {1|-1} [direction=1]
 * @returns {number}
 */
const calculatePerpPnl = (entryPrice, exitPrice, contracts, direction = 1) => {
  if (![entryPrice, exitPrice, contracts, direction].every(Number.isFinite)) return 0
  return (exitPrice - entryPrice) * contracts * PERP_CONTRACT_SIZE_BTC * direction
}

module.exports = { PERP_CONTRACT_SIZE_BTC, calculatePerpPnl }
