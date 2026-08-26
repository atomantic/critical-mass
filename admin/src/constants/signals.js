import { TrendingUp, TrendingDown, Minus, Plus, CircleDot } from 'lucide-react'

export const SIGNAL_TYPES = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  NEUTRAL: 'NEUTRAL',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
  NO_TRADE_ZONE: 'NO_TRADE_ZONE',
}

export const ACTIONS = {
  OPEN: 'OPEN',
  ADD: 'ADD',
  HOLD: 'HOLD',
  CLOSE: 'CLOSE',
}

export const signalBadgeColors = {
  STRONG_BUY: 'bg-green-500/20 border-green-500/40 text-green-400',
  BUY: 'bg-green-500/10 border-green-500/20 text-green-400',
  NEUTRAL: 'bg-gray-500/10 border-gray-500/20 text-gray-400',
  SELL: 'bg-red-500/10 border-red-500/20 text-red-400',
  STRONG_SELL: 'bg-red-500/20 border-red-500/40 text-red-400',
  NO_TRADE_ZONE: 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400',
  OPEN: 'bg-green-500/20 border-green-500/40 text-green-400',
  ADD: 'bg-teal-500/20 border-teal-500/40 text-teal-400',
  HOLD: 'bg-gray-500/10 border-gray-500/20 text-gray-400',
  CLOSE: 'bg-red-500/20 border-red-500/40 text-red-400',
}

export const signalIcons = {
  STRONG_BUY: TrendingUp,
  BUY: TrendingUp,
  NEUTRAL: Minus,
  SELL: TrendingDown,
  STRONG_SELL: TrendingDown,
  NO_TRADE_ZONE: Minus,
  OPEN: CircleDot,
  ADD: Plus,
  HOLD: Minus,
  CLOSE: TrendingDown,
}

export const getSignalColor = (type) => signalBadgeColors[type] || signalBadgeColors.NEUTRAL
export const getSignalIcon = (type) => signalIcons[type] || Minus

const isBuyType = (type) => type === 'BUY' || type === 'STRONG_BUY'
const isSellType = (type) => type === 'SELL' || type === 'STRONG_SELL'

const isHeldLong = (held) => {
  if (!held) return false
  if (held === true) return true
  if (typeof held.contracts === 'number') return held.contracts > 0 && held.direction !== 'down'
  return held.direction === 'up'
}

/** Perp-long actions: Open / Add / Hold / Close. Never BUY DOWN. */
export const resolveAction = (type, heldPosition) => {
  const long = isHeldLong(heldPosition)
  if (isBuyType(type)) return long ? 'ADD' : 'OPEN'
  if (long) return 'CLOSE'
  return 'HOLD'
}

export const getActionLabel = (type, heldPosition) => {
  if (!type) return 'CALCULATING...'
  if (type === 'OPEN' || type === 'ADD' || type === 'HOLD' || type === 'CLOSE') return type
  return resolveAction(type, heldPosition)
}

/** Walk history oldest-first so OPEN cannot repeat until after CLOSE. */
export const labelHistoryActions = (entries) => {
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
