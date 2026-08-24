// @ts-check
/**
 * Operator-facing actions for the UP-only perp-long predictor.
 *
 * Internal engine types stay BUY / NEUTRAL / SELL (hysteresis, gates, journals).
 * The dashboard prints Open / Add / Hold / Close:
 *   BUY while flat  → OPEN
 *   BUY while long  → ADD
 *   SELL while long → CLOSE
 *   anything else   → HOLD  (flat + SELL is stand-aside, not a short)
 */

const BUY_SIDE = new Set(['BUY', 'STRONG_BUY'])
const SELL_SIDE = new Set(['SELL', 'STRONG_SELL'])

/** @param {string|null|undefined} type */
const isBuyType = (type) => BUY_SIDE.has(type)

/** @param {string|null|undefined} type */
const isSellType = (type) => SELL_SIDE.has(type)

/**
 * Coarse side for fill idempotency. BUY and STRONG_BUY are the same side so a
 * strength upgrade does not buy a second contract.
 * @param {string|null|undefined} type
 * @returns {'BUY' | 'SELL' | 'HOLD'}
 */
const signalSide = (type) => {
  if (isBuyType(type)) return 'BUY'
  if (isSellType(type)) return 'SELL'
  return 'HOLD'
}

/**
 * @param {boolean|{direction?: string, contracts?: number}|null|undefined} held
 * @returns {boolean}
 */
const isHeldLong = (held) => {
  if (!held) return false
  if (held === true) return true
  if (typeof held.contracts === 'number') {
    return held.contracts > 0 && held.direction !== 'down'
  }
  return held.direction === 'up'
}

/**
 * @param {string|null|undefined} type
 * @param {boolean|{direction?: string, contracts?: number}|null|undefined} [held]
 * @returns {'OPEN' | 'ADD' | 'HOLD' | 'CLOSE'}
 */
const resolveAction = (type, held = null) => {
  const long = isHeldLong(held)
  if (isBuyType(type)) return long ? 'ADD' : 'OPEN'
  if (isSellType(type) && long) return 'CLOSE'
  return 'HOLD'
}

/**
 * Operator-facing banner label. NO_TRADE_ZONE is HOLD (do not open/add); a
 * SELL that survived the no-trade-zone filter is already type=SELL and maps
 * to CLOSE when long.
 * @param {string|null|undefined} type
 * @param {boolean|{direction?: string, contracts?: number}|null|undefined} [held]
 * @returns {string}
 */
const resolveActionLabel = (type, held = null) => resolveAction(type, held)

module.exports = {
  BUY_SIDE,
  SELL_SIDE,
  isBuyType,
  isSellType,
  signalSide,
  isHeldLong,
  resolveAction,
  resolveActionLabel,
}
