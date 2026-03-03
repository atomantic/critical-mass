import { useMemo } from 'react'
import { TrendingUp, TrendingDown, Minus, AlertTriangle, ChevronsUp, ChevronsDown } from 'lucide-react'

const TF_ORDER = ['1w', '1d', '4h', '2h', '1h', '30m', '15m', '10m', '5m', '3m', '1m']
const MACD_MIN_CANDLES = 35

const TF_TOOLTIPS = {
  '1w': 'Weekly — macro trend context (EMA4/EMA8)',
  '1d': 'Daily — longest-term trend direction',
  '4h': '4-hour — macro trend bias',
  '2h': '2-hour — intermediate trend',
  '1h': '1-hour — medium-term signal (contributes 15% to composite)',
  '30m': '30-minute — mid-range momentum',
  '15m': '15-minute — short-term signal (contributes 30% to composite)',
  '10m': '10-minute — granular momentum',
  '5m': '5-minute — primary signal timeframe (contributes 30% to composite)',
  '3m': '3-minute — quick momentum (contributes 15% to composite)',
  '1m': '1-minute — fastest signal (contributes 10% to composite)',
}

const getDirection = (score) => {
  if (score > 15) return 'up'
  if (score < -15) return 'down'
  return 'neutral'
}

const DIRECTION_CONFIG = {
  up: { Icon: TrendingUp, color: 'text-green-400', barColor: 'bg-green-500', bgTint: 'bg-green-900/20' },
  down: { Icon: TrendingDown, color: 'text-red-400', barColor: 'bg-red-500', bgTint: 'bg-red-900/20' },
  neutral: { Icon: Minus, color: 'text-gray-500', barColor: 'bg-gray-500', bgTint: '' },
}

const TICK_DIRECTION_CONFIG = {
  up: { Icon: TrendingUp, color: 'text-green-400', bgTint: 'bg-green-900/20' },
  down: { Icon: TrendingDown, color: 'text-red-400', bgTint: 'bg-red-900/20' },
  neutral: { Icon: Minus, color: 'text-gray-500', bgTint: '' },
}

export default function TimeframeGrid({ indicators, tickMomentum }) {
  const rows = useMemo(() => {
    const tf = indicators?.timeframes
    if (!tf) return []
    return TF_ORDER.map(key => {
      const data = tf[key]
      if (!data) return { key, score: 0, direction: 'neutral', candleCount: 0, volumeSurge: null, divergence: null, momentum: null }
      return {
        key,
        score: data.score ?? 0,
        direction: getDirection(data.score ?? 0),
        candleCount: data.candleCount ?? 0,
        volumeSurge: data.indicators?.volumeSurge ?? null,
        divergence: data.indicators?.divergence ?? null,
        momentum: data.indicators?.momentum ?? null,
      }
    })
  }, [indicators?.timeframes])

  const tickDir = tickMomentum?.direction || 'neutral'
  const tickCfg = TICK_DIRECTION_CONFIG[tickDir]

  const alignment = useMemo(() => {
    const counts = { up: 0, down: 0, neutral: 0 }
    for (const r of rows) counts[r.direction]++
    // Include tick
    counts[tickDir]++
    return counts
  }, [rows, tickDir])

  const alignmentTint = alignment.up > alignment.down + 2
    ? 'border-green-700/40'
    : alignment.down > alignment.up + 2
      ? 'border-red-700/40'
      : 'border-gray-700'

  return (
    <div className={`bg-gray-800 rounded-lg border p-2 ${alignmentTint} lg:col-span-1`}>
      <h3
        className="text-[10px] font-semibold text-gray-400 mb-1 uppercase tracking-wider cursor-help"
        title="Shows weighted indicator scores across 10 timeframes. When most timeframes agree on direction, signals are stronger. The 5 core timeframes (1m, 3m, 5m, 15m, 1h) contribute to the composite score."
      >Timeframe Alignment</h3>

      <div className="space-y-0">
        {rows.map(row => {
          const cfg = DIRECTION_CONFIG[row.direction]
          const barWidth = Math.min(100, Math.abs(row.score) * 1.2)
          const lowCandles = row.candleCount > 0 && row.candleCount < MACD_MIN_CANDLES

          return (
            <div key={row.key} className={`flex items-center gap-1.5 px-1.5 rounded ${cfg.bgTint}`} title={TF_TOOLTIPS[row.key]}>
              <span className="text-[10px] font-mono text-gray-400 w-6 text-right shrink-0 cursor-help">{row.key}</span>
              <cfg.Icon size={12} className={cfg.color} />
              <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden" title={`Signal strength: ${Math.abs(row.score).toFixed(0)}% — bar shows relative magnitude`}>
                <div
                  className={`h-full rounded-full ${cfg.barColor}`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <span
                className={`text-[10px] font-mono w-8 text-right cursor-help ${cfg.color}`}
                title={`Weighted score: ${row.score.toFixed(1)} (range -100 to +100). >+15 = bullish, <-15 = bearish`}
              >
                {row.score >= 0 ? '+' : ''}{row.score.toFixed(0)}
              </span>
              {row.volumeSurge?.surgeRatio > 1.5 && (
                <span className="text-[9px] font-mono text-yellow-400 shrink-0" title={`Volume surge ${row.volumeSurge.surgeRatio.toFixed(1)}x`}>
                  V{row.volumeSurge.surgeRatio.toFixed(1)}x
                </span>
              )}
              {row.divergence?.type === 'bullish' && (
                <span className="text-[9px] font-bold text-green-400 shrink-0" title={`Bullish divergence (${(row.divergence.strength * 100).toFixed(0)}%)`}>DIV</span>
              )}
              {row.divergence?.type === 'bearish' && (
                <span className="text-[9px] font-bold text-red-400 shrink-0" title={`Bearish divergence (${(row.divergence.strength * 100).toFixed(0)}%)`}>DIV</span>
              )}
              {row.momentum?.acceleration === 'accelerating' && (
                <ChevronsUp size={10} className={`shrink-0 ${row.momentum.direction === 'up' ? 'text-green-400' : 'text-red-400'}`} title="Accelerating" />
              )}
              {row.momentum?.acceleration === 'fading' && (
                <ChevronsDown size={10} className="text-gray-500 shrink-0" title="Fading" />
              )}
              {lowCandles && (
                <AlertTriangle size={10} className="text-yellow-500 shrink-0" title={`${row.candleCount} candles (need ${MACD_MIN_CANDLES} for MACD)`} />
              )}
            </div>
          )
        })}

        {/* Tick momentum row */}
        <div
          className={`flex items-center gap-1.5 px-1.5 rounded border-t border-gray-700 mt-1 pt-1 ${tickCfg.bgTint}`}
          title="Real-time tick momentum from raw price updates (not candle-based). Shows basis points moved and price velocity in $/sec."
        >
          <span className="text-[10px] font-mono text-gray-400 w-6 text-right shrink-0 cursor-help">Tick</span>
          <tickCfg.Icon size={12} className={tickCfg.color} />
          <div className="flex-1 text-[10px] font-mono text-gray-500">
            {tickMomentum
              ? `${tickMomentum.magnitude.toFixed(1)}bp ${tickMomentum.velocity >= 0 ? '+' : ''}${tickMomentum.velocity.toFixed(1)}$/s`
              : '---'}
          </div>
        </div>
      </div>

      {/* Alignment summary */}
      <div className="mt-1 flex items-center gap-2 text-[10px] font-mono cursor-help" title="Count of timeframes pointing up/down/neutral (includes tick). Strong alignment (3+ majority) tints the panel border green or red.">
        <span className="text-green-400">{alignment.up}&#8593;</span>
        <span className="text-red-400">{alignment.down}&#8595;</span>
        <span className="text-gray-500">{alignment.neutral}&mdash;</span>
      </div>
    </div>
  )
}
