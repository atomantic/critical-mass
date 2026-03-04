import { useMemo } from 'react'
import BTCPriceChart from '../charts/BTCPriceChart'
import { formatBTCPrice } from '../charts/chartUtils'

const LEFT_TFS = [
  { interval: '1m', range: '1h' },
  { interval: '3m', range: '3h' },
  { interval: '5m', range: '6h' },
  { interval: '10m', range: '12h' },
  { interval: '15m', range: '1d' },
]

const RIGHT_TFS = [
  { interval: '30m', range: '1d' },
  { interval: '1h', range: '3d' },
  { interval: '2h', range: '3d' },
  { interval: '4h', range: '7d' },
  { interval: '1d', range: '30d' },
]

const SIGNAL_COLORS = {
  STRONG_BUY: 'text-green-400',
  BUY: 'text-green-400',
  NEUTRAL: 'text-gray-400',
  SELL: 'text-red-400',
  STRONG_SELL: 'text-red-400',
}

const tfScoreToSignal = (score) => {
  if (score > 45) return 'STRONG_BUY'
  if (score > 25) return 'BUY'
  if (score < -45) return 'STRONG_SELL'
  if (score < -25) return 'SELL'
  return 'NEUTRAL'
}

const WEEKLY_SIGNAL_COLORS = {
  bullish: 'text-green-400',
  bearish: 'text-red-400',
  neutral: 'text-gray-400',
}

export default function PriceChart({ tick, indicators, contract, signalAnnotations }) {
  const referenceLines = useMemo(() => {
    const lines = []
    if (contract?.target) {
      lines.push({
        y: contract.target,
        stroke: '#10b981',
        strokeDasharray: '3 3',
        label: `Target ${formatBTCPrice(contract.target)}`,
        labelFill: '#10b981',
      })
    }
    if (contract?.stop) {
      lines.push({
        y: contract.stop,
        stroke: '#ef4444',
        strokeDasharray: '3 3',
        label: `Stop ${formatBTCPrice(contract.stop)}`,
        labelFill: '#ef4444',
      })
    }
    return lines
  }, [contract?.target, contract?.stop])

  const renderChart = (tf) => {
    const tfScore = indicators?.[tf.interval]?.score ?? 0
    const tfSignal = tfScoreToSignal(tfScore)
    const label = tf.interval
    const signalLabel = tfSignal.replace(/_/g, ' ')
    const signalColor = SIGNAL_COLORS[tfSignal] || SIGNAL_COLORS.NEUTRAL

    return (
      <BTCPriceChart
        key={tf.interval}
        exchange="coinbase"
        tickPrice={tick?.price}
        tickTimestamp={tick?.timestamp}
        indicators={indicators}
        chartType="heikinAshi"
        showIntervalSelector={false}
        defaultInterval={tf.interval}
        defaultRange={tf.range}
        overlays={['bollinger', 'vwap']}
        subCharts={[]}
        referenceLines={tf.interval === '5m' ? referenceLines : []}
        signalAnnotations={signalAnnotations}
        height={220}
        headerLabel={<><span className="text-white font-bold">{label}:</span> <span className={signalColor}>{signalLabel}</span></>}
      />
    )
  }

  const weeklyBias = indicators?.weeklyTrend?.weeklyBias || 'neutral'
  const weeklyColor = WEEKLY_SIGNAL_COLORS[weeklyBias] || WEEKLY_SIGNAL_COLORS.neutral
  const weeklyLabel = weeklyBias.toUpperCase()

  return (
    <div className="space-y-2">
      {/* Weekly macro chart banner */}
      <BTCPriceChart
        exchange="coinbase"
        tickPrice={tick?.price}
        tickTimestamp={tick?.timestamp}
        indicators={indicators}
        chartType="heikinAshi"
        showIntervalSelector={false}
        defaultInterval="1w"
        defaultRange="52w"
        overlays={['bollinger']}
        subCharts={[]}
        height={180}
        headerLabel={<><span className="text-white font-bold">1W:</span> <span className={weeklyColor}>{weeklyLabel}</span></>}
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          {LEFT_TFS.map(renderChart)}
        </div>
        <div className="space-y-2">
          {RIGHT_TFS.map(renderChart)}
        </div>
      </div>
    </div>
  )
}
