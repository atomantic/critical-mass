// @ts-check
/**
 * Canonical implementation of UpDown signal action resolution for both Node.js and Vite.
 * Used by both server (src/updown/) and client (admin/src/).
 *
 * Operator-facing actions for the UP-only perp-long predictor.
 * Internal engine types stay BUY / NEUTRAL / SELL (hysteresis, gates, journals).
 * The dashboard prints Open / Add / Hold / Close:
 *   BUY while flat  → OPEN
 *   BUY while long  → ADD
 *   any non-BUY while long → CLOSE  (lost the long thesis, including NEUTRAL)
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
  if (long) return 'CLOSE'
  return 'HOLD'
}

/**
 * Operator-facing label for UI display. Reconciles diverged contracts:
 * - null/undefined type yields 'CALCULATING...'
 * - already-resolved action string ('OPEN'|'ADD'|'HOLD'|'CLOSE') passes through unchanged
 * - otherwise resolves via resolveAction
 * NO_TRADE_ZONE is HOLD (do not open/add); a SELL that survived the no-trade-zone
 * filter is already type=SELL and maps to CLOSE when long.
 * @param {string|null|undefined} type
 * @param {boolean|{direction?: string, contracts?: number}|null|undefined} [held]
 * @returns {string}
 */
const resolveActionLabel = (type, held = null) => {
  if (!type) return 'CALCULATING...'
  if (type === 'OPEN' || type === 'ADD' || type === 'HOLD' || type === 'CLOSE') return type
  return resolveAction(type, held)
}

/**
 * Relabel a chronological-or-not history of engine types as Open/Add/Hold/Close
 * using a virtual long/flat book. A BUY after OPEN (no CLOSE yet) is ADD.
 * @param {Array<{type?: string, action?: string, timestamp?: number}>} entries
 * @returns {Array<Object>} new array, original objects not mutated
 */
const labelHistoryActions = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const sorted = entries
    .map((e, i) => ({ e, i, ts: Number(e?.timestamp) || 0 }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
  let long = false
  const byIndex = new Array(entries.length)
  for (const { e, i } of sorted) {
    const type = e?.type
      || (e?.action === 'CLOSE' ? 'SELL' : e?.action === 'HOLD' ? 'NEUTRAL' : (e?.action === 'OPEN' || e?.action === 'ADD') ? 'BUY' : 'NEUTRAL')
    const action = resolveAction(type, long)
    if (action === 'OPEN' || action === 'ADD') long = true
    else if (action === 'CLOSE') long = false
    byIndex[i] = { ...e, action }
  }
  return byIndex
}

// Export for CommonJS (Node.js server)
module.exports = {
  BUY_SIDE,
  SELL_SIDE,
  isBuyType,
  isSellType,
  signalSide,
  isHeldLong,
  resolveAction,
  resolveActionLabel,
  labelHistoryActions,
}
