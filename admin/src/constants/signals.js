import { TrendingUp, TrendingDown, Minus, ShieldAlert } from 'lucide-react'

export const SIGNAL_TYPES = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  NEUTRAL: 'NEUTRAL',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
  NO_TRADE_ZONE: 'NO_TRADE_ZONE',
}

export const signalBadgeColors = {
  STRONG_BUY: 'bg-green-500/20 border-green-500/40 text-green-400',
  BUY: 'bg-green-500/10 border-green-500/20 text-green-400',
  NEUTRAL: 'bg-gray-500/10 border-gray-500/20 text-gray-400',
  SELL: 'bg-red-500/10 border-red-500/20 text-red-400',
  STRONG_SELL: 'bg-red-500/20 border-red-500/40 text-red-400',
  NO_TRADE_ZONE: 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400',
}

export const signalIcons = {
  STRONG_BUY: TrendingUp,
  BUY: TrendingUp,
  NEUTRAL: Minus,
  SELL: TrendingDown,
  STRONG_SELL: TrendingDown,
  NO_TRADE_ZONE: ShieldAlert,
}

export const getSignalColor = (type) => signalBadgeColors[type] || signalBadgeColors.NEUTRAL
export const getSignalIcon = (type) => signalIcons[type] || Minus
