// @ts-check
/**
 * Server-side re-exports of canonical UpDown signal action resolution.
 * Canonical implementation lives in shared/signal-actions.js.
 */

const {
  BUY_SIDE,
  SELL_SIDE,
  isBuyType,
  isSellType,
  signalSide,
  isHeldLong,
  resolveAction,
  resolveActionLabel,
  labelHistoryActions,
} = require('../../shared/signal-actions')

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
