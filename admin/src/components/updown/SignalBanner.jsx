import { useMemo } from 'react'
import { TrendingUp, TrendingDown, Minus, ShieldAlert, Clock } from 'lucide-react'
import { formatCountdown } from './TimeWarningBanner'

const BANNER_COLORS = {
  STRONG_BUY: 'bg-green-900/40 border-green-600/50',
  BUY: 'bg-green-900/30 border-green-700/40',
  NEUTRAL: 'bg-gray-800 border-gray-600/40',
  SELL: 'bg-red-900/30 border-red-700/40',
  STRONG_SELL: 'bg-red-900/40 border-red-600/50',
  NO_TRADE_ZONE: 'bg-yellow-900/30 border-yellow-700/40',
}

const LABEL_COLORS = {
  STRONG_BUY: 'text-green-300',
  BUY: 'text-green-400',
  NEUTRAL: 'text-gray-400',
  SELL: 'text-red-400',
  STRONG_SELL: 'text-red-300',
  NO_TRADE_ZONE: 'text-yellow-400',
}

const CONFIDENCE_BAR_COLORS = {
  STRONG_BUY: 'bg-green-500',
  BUY: 'bg-green-500',
  NEUTRAL: 'bg-gray-500',
  SELL: 'bg-red-500',
  STRONG_SELL: 'bg-red-500',
  NO_TRADE_ZONE: 'bg-yellow-500',
}

const SIGNAL_ICONS = {
  STRONG_BUY: TrendingUp,
  BUY: TrendingUp,
  NEUTRAL: Minus,
  SELL: TrendingDown,
  STRONG_SELL: TrendingDown,
  NO_TRADE_ZONE: ShieldAlert,
}

const getActionLabel = (score, type) => {
  if (type === 'NO_TRADE_ZONE') return 'NO TRADE'
  if (score > 40) return 'BUY UP'
  if (score < -40) return 'BUY DOWN'
  return 'HOLD'
}

const getHorizonArrow = (score) => {
  if (score > 20) return { icon: TrendingUp, label: 'text-green-400' }
  if (score < -20) return { icon: TrendingDown, label: 'text-red-400' }
  return { icon: Minus, label: 'text-gray-400' }
}

export default function SignalBanner({ signal, indicators, timeRemaining }) {
  const type = signal?.type || 'NEUTRAL'
  const score = signal?.score ?? 0
  const confidence = signal?.confidence ?? 0
  const Icon = SIGNAL_ICONS[type] || Minus

  const trendFilter = indicators?.trendFilter
  const volatility = indicators?.volatility
  const confluence = indicators?.confluence
  const horizonPrediction = signal?.horizonPrediction

  const horizons = useMemo(() => {
    const tf = indicators?.timeframes
    if (!tf) return null
    const shortScore = (tf['1m']?.score || 0) * 0.3 + (tf['3m']?.score || 0) * 0.3 + (tf['5m']?.score || 0) * 0.4
    const midScore = (tf['10m']?.score || 0) * 0.2 + (tf['15m']?.score || 0) * 0.4 + (tf['30m']?.score || 0) * 0.4
    const longScore = (tf['1h']?.score || 0) * 0.3 + (tf['2h']?.score || 0) * 0.3 + (tf['4h']?.score || 0) * 0.25 + (tf['1d']?.score || 0) * 0.15
    return [
      { key: 'Short', score: shortScore },
      { key: 'Mid', score: midScore },
      { key: 'Long', score: longScore },
    ]
  }, [indicators?.timeframes])

  const actionLabel = getActionLabel(score, type)
  const confPct = Math.max(0, Math.min(100, confidence * 100))
  const bannerColor = BANNER_COLORS[type] || BANNER_COLORS.NEUTRAL
  const labelColor = LABEL_COLORS[type] || LABEL_COLORS.NEUTRAL
  const barColor = CONFIDENCE_BAR_COLORS[type] || CONFIDENCE_BAR_COLORS.NEUTRAL

  const hasTime = Number.isFinite(timeRemaining) && timeRemaining > 0

  return (
    <div className={`rounded-lg border p-3 transition-colors duration-500 ${bannerColor}`}>
      <div className="flex items-center gap-4 flex-wrap">
        {/* Left: Signal + action label + confidence */}
        <div className="flex items-center gap-3 min-w-0">
          <Icon size={22} className={labelColor} />
          <span className={`text-lg font-bold whitespace-nowrap ${labelColor}`}>
            {actionLabel}
          </span>
          <div className="flex items-center gap-2 min-w-[120px]">
            <div className="w-20 bg-gray-700 rounded-full h-2.5">
              <div
                className={`${barColor} h-2.5 rounded-full transition-all duration-500`}
                style={{ width: `${confPct}%` }}
              />
            </div>
            <span className="text-sm font-mono text-gray-300">{confPct.toFixed(0)}%</span>
          </div>
        </div>

        {/* Center: Horizon pills */}
        {horizons && (
          <div className="flex items-center gap-2 ml-auto">
            {horizons.map(h => {
              const { icon: HIcon, label: hColor } = getHorizonArrow(h.score)
              return (
                <div
                  key={h.key}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-gray-800/60 border border-gray-700/50"
                >
                  <span className="text-xs text-gray-500">{h.key}</span>
                  <HIcon size={12} className={hColor} />
                  <span className={`text-xs font-mono ${hColor}`}>{h.score >= 0 ? '+' : ''}{h.score.toFixed(0)}</span>
                </div>
              )
            })}
          </div>
        )}

        {/* Confluence pill */}
        {confluence && (
          <div className={`px-2 py-1 rounded text-xs font-bold ${
            confluence.quality === 'selective' ? 'bg-green-900/40 text-green-400'
            : confluence.quality === 'moderate' ? 'bg-yellow-900/40 text-yellow-400'
            : 'bg-red-900/40 text-red-400'
          }`}>
            {confluence.agreeing <= 5 ? `${confluence.agreeing} TF` : confluence.agreeing === 6 ? '6 TF' : '7+ TF'}
          </div>
        )}

        {/* Trend bias pill */}
        {trendFilter?.trendBias && trendFilter.trendBias !== 'neutral' && (
          <div className={`px-2 py-1 rounded text-xs font-bold ${
            trendFilter.trendBias === 'bullish' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
          }`}>
            {trendFilter.trendBias === 'bullish' ? 'BULL' : 'BEAR'}
          </div>
        )}
        {trendFilter?.trendBias === 'neutral' && (
          <div className="px-2 py-1 rounded text-xs font-bold bg-gray-700/40 text-gray-500">FLAT</div>
        )}

        {/* Volatility regime pill */}
        {volatility?.ratio != null && (
          <div className={`px-2 py-1 rounded text-xs font-mono ${
            volatility.ratio > 1.5 ? 'bg-orange-900/40 text-orange-400'
            : volatility.ratio < 0.7 ? 'bg-blue-900/40 text-blue-400'
            : 'bg-gray-700/40 text-gray-500'
          }`}>
            {volatility.ratio.toFixed(1)}x
          </div>
        )}

        {/* Best horizon badge */}
        {horizonPrediction?.bestHorizon && (
          <div className="px-2 py-1 rounded text-xs font-mono bg-purple-900/40 text-purple-400 border border-purple-700/40">
            Best: {horizonPrediction.bestHorizon}
          </div>
        )}

        {/* Right: Time remaining */}
        {hasTime && (
          <div className="flex items-center gap-1.5 ml-auto text-gray-400">
            <Clock size={14} />
            <span className="text-sm font-mono">{formatCountdown(timeRemaining)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
