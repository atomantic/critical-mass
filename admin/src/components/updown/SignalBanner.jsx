import { useMemo } from 'react'
import { TrendingUp, TrendingDown, Minus, Plus, CircleDot, Clock } from 'lucide-react'
import { formatCountdown } from './TimeWarningBanner'
import { getActionLabel } from '../../constants/signals'

const BANNER_COLORS = {
  OPEN: 'bg-green-900/40 border-green-600/50',
  ADD: 'bg-teal-900/40 border-teal-600/50',
  HOLD: 'bg-gray-800 border-gray-600/40',
  CLOSE: 'bg-red-900/40 border-red-600/50',
}

const LABEL_COLORS = {
  OPEN: 'text-green-300',
  ADD: 'text-teal-300',
  HOLD: 'text-gray-400',
  CLOSE: 'text-red-300',
}

const CONFIDENCE_BAR_COLORS = {
  OPEN: 'bg-green-500',
  ADD: 'bg-teal-500',
  HOLD: 'bg-gray-500',
  CLOSE: 'bg-red-500',
}

const SIGNAL_ICONS = {
  OPEN: CircleDot,
  ADD: Plus,
  HOLD: Minus,
  CLOSE: TrendingDown,
}

const getHorizonArrow = (score) => {
  if (score > 20) return { icon: TrendingUp, label: 'text-green-400' }
  if (score < -20) return { icon: TrendingDown, label: 'text-red-400' }
  return { icon: Minus, label: 'text-gray-400' }
}

export default function SignalBanner({ signal, indicators, timeRemaining, position }) {
  // Show loading state until live indicators arrive to avoid displaying stale signals
  const liveReady = !!indicators?.type || !!indicators?.timeframes
  const type = liveReady ? (indicators?.type || signal?.type || 'NEUTRAL') : null
  const score = indicators?.score ?? signal?.score ?? 0
  const confidence = indicators?.confidence ?? signal?.confidence ?? 0
  const held = indicators?.perp || signal?.perp || position
  const action = liveReady
    ? (indicators?.action || signal?.action || getActionLabel(type, held))
    : null
  const Icon = action ? (SIGNAL_ICONS[action] || Minus) : Clock

  const trendFilter = indicators?.trendFilter
  const volatility = indicators?.volatility
  const confluence = indicators?.confluence
  const horizonPrediction = signal?.horizonPrediction
  const dailySMA = indicators?.dailySMA

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

  const actionLabel = action || 'CALCULATING...'
  const trendGate = indicators?.trendGate
  const confPct = Math.max(0, Math.min(100, confidence * 100))
  const bannerColor = action ? (BANNER_COLORS[action] || BANNER_COLORS.HOLD) : 'bg-gray-800 border-gray-600/40'
  const labelColor = action ? (LABEL_COLORS[action] || LABEL_COLORS.HOLD) : 'text-gray-500'
  const barColor = action ? (CONFIDENCE_BAR_COLORS[action] || CONFIDENCE_BAR_COLORS.HOLD) : 'bg-gray-600'

  const hasTime = Number.isFinite(timeRemaining) && timeRemaining > 0

  return (
    <div className={`rounded-lg border p-3 transition-colors duration-500 ${bannerColor}`}>
      <div className="flex items-center gap-4 flex-wrap">
        {/* Left: Signal + action label + confidence */}
        <div className="flex items-center gap-3 min-w-0" title={`Composite score: ${score.toFixed(1)} — Action: ${actionLabel} — Engine: ${(type || 'LOADING').replace(/_/g, ' ')}`}>
          <Icon size={22} className={labelColor} />
          <span className={`text-lg font-bold whitespace-nowrap ${labelColor}`}>
            {actionLabel}
          </span>
          <div className="flex items-center gap-2 min-w-[160px]" title={`Heuristic signal strength: ${confPct.toFixed(0)}% — indicator agreement, not a calibrated probability`}>
            <div className="w-20 bg-gray-700 rounded-full h-2.5">
              <div
                className={`${barColor} h-2.5 rounded-full transition-all duration-500`}
                style={{ width: `${confPct}%` }}
              />
            </div>
            <span className="text-xs font-mono text-gray-300 whitespace-nowrap">Strength {confPct.toFixed(0)}%</span>
          </div>
        </div>

        {/* Center: Horizon pills */}
        {horizons && (
          <div className="flex items-center gap-2 ml-auto">
            {horizons.map(h => {
              const { icon: HIcon, label: hColor } = getHorizonArrow(h.score)
              const desc = h.key === 'Short' ? 'Short-term outlook (1m/3m/5m weighted)'
                : h.key === 'Mid' ? 'Mid-term outlook (10m/15m/30m weighted)'
                : 'Long-term outlook (1h/2h/4h/1d weighted)'
              return (
                <div
                  key={h.key}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-gray-800/60 border border-gray-700/50"
                  title={`${desc} — Score: ${h.score.toFixed(1)}`}
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
          <div
            className={`px-2 py-1 rounded text-xs font-bold ${
              confluence.quality === 'selective' ? 'bg-green-900/40 text-green-400'
              : confluence.quality === 'moderate' ? 'bg-yellow-900/40 text-yellow-400'
              : 'bg-red-900/40 text-red-400'
            }`}
            title={`Confluence: ${confluence.agreeing} of ${confluence.totalDirectional} directional timeframes agree — ${confluence.quality} (fewer agreeing = higher quality signal)`}
          >
            {confluence.agreeing <= 5 ? `${confluence.agreeing} TF` : confluence.agreeing === 6 ? '6 TF' : '7+ TF'}
          </div>
        )}

        {/* Trend bias pill */}
        {trendFilter?.trendBias && trendFilter.trendBias !== 'neutral' && (
          <div
            className={`px-2 py-1 rounded text-xs font-bold ${
              trendFilter.trendBias === 'bullish' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
            }`}
            title={`Trend: EMA(50) ${trendFilter.trendBias === 'bullish' ? '>' : '<'} EMA(200) on 1h candles — counter-trend signals dampened`}
          >
            {trendFilter.trendBias === 'bullish' ? 'BULL' : 'BEAR'}
          </div>
        )}
        {trendFilter?.trendBias === 'neutral' && (
          <div className="px-2 py-1 rounded text-xs font-bold bg-gray-700/40 text-gray-500" title="Trend: EMA(50) ≈ EMA(200) on 1h candles — no trend bias applied">FLAT</div>
        )}
        {trendGate && !trendGate.open && (
          <div
            className="px-2 py-1 rounded text-xs font-bold bg-yellow-900/40 text-yellow-400"
            title={`Long gate closed (${trendGate.reason}) — 15m/1h tape is bearish, no new UP entries`}
          >
            GATE CLOSED
          </div>
        )}

        {/* Daily SMA trend pill */}
        {dailySMA?.sma200 > 0 && (
          <div
            className={`px-2 py-1 rounded text-xs font-mono ${
              dailySMA.trend === 'bullish' ? 'bg-green-900/30 text-green-500'
              : dailySMA.trend === 'bearish' ? 'bg-red-900/30 text-red-500'
              : 'bg-gray-700/40 text-gray-500'
            }`}
            title={`Daily SMAs — 50: $${dailySMA.sma50?.toFixed(0)} | 100: $${dailySMA.sma100?.toFixed(0)} | 200: $${dailySMA.sma200?.toFixed(0)} | Price vs SMA200: ${dailySMA.priceVsSMA200?.toFixed(1)}% | ${dailySMA.goldenCross ? 'Golden Cross (50>200)' : dailySMA.deathCross ? 'Death Cross (50<200)' : 'No cross'}`}
          >
            {dailySMA.goldenCross ? 'GC' : dailySMA.deathCross ? 'DC' : 'SMA'}
            <span className="ml-1 text-[10px] opacity-70">{dailySMA.priceVsSMA200 >= 0 ? '+' : ''}{dailySMA.priceVsSMA200?.toFixed(1)}%</span>
          </div>
        )}

        {/* Volatility regime pill */}
        {volatility?.ratio != null && (
          <div
            className={`px-2 py-1 rounded text-xs font-mono ${
              volatility.ratio > 1.5 ? 'bg-orange-900/40 text-orange-400'
              : volatility.ratio < 0.7 ? 'bg-blue-900/40 text-blue-400'
              : 'bg-gray-700/40 text-gray-500'
            }`}
            title={`Volatility: ATR / baseline = ${volatility.ratio.toFixed(2)}x — ${volatility.ratio > 1.5 ? 'High vol: tighter signal thresholds' : volatility.ratio < 0.7 ? 'Low vol: wider signal thresholds' : 'Normal volatility'}`}
          >
            {volatility.ratio.toFixed(1)}x
          </div>
        )}

        {/* Best horizon badge */}
        {horizonPrediction?.bestHorizon && (
          <div
            className="px-2 py-1 rounded text-xs font-mono bg-purple-900/40 text-purple-400 border border-purple-700/40"
            title={`Best prediction window from scorecard — ${horizonPrediction.bestHorizon} has highest accuracy (${horizonPrediction.bestAccuracy?.toFixed(0) ?? '?'}%)`}
          >
            Best: {horizonPrediction.bestHorizon}
          </div>
        )}

        {/* Right: Time remaining */}
        {hasTime && (
          <div className="flex items-center gap-1.5 ml-auto text-gray-400" title="Time remaining until contract expiry">
            <Clock size={14} />
            <span className="text-sm font-mono">{formatCountdown(timeRemaining)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
