import Button from '../ui/Button'
import { memo, useMemo, useState } from 'react'
import BTCPriceChart from '../charts/BTCPriceChart'
import { formatBTCPrice } from '../charts/chartUtils'

const LEFT_TFS = [
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

const CANDLE_COUNT_OPTIONS = [
  { label: 'Auto', value: null },
  { label: '100', value: 100 },
  { label: '300', value: 300 },
]

const OVERLAYS = ['bollinger', 'vwap']
const WEEKLY_OVERLAYS = ['bollinger']
const EMPTY_LINES = []

const TimeframePriceChart = memo(function TimeframePriceChart({
  label, signal, signalColor, interval, range, subscribeTicks, referenceLines,
  signalAnnotations, candleCount, weekly = false,
}) {
  return (
    <BTCPriceChart
      exchange="coinbase"
      subscribeTicks={subscribeTicks}
      chartType="heikinAshi"
      defaultInterval={interval}
      defaultRange={range}
      overlays={weekly ? WEEKLY_OVERLAYS : OVERLAYS}
      referenceLines={referenceLines}
      signalAnnotations={signalAnnotations}
      maxBucketsOverride={candleCount}
      height={weekly ? 180 : 220}
      headerLabel={<><span className="text-white font-bold">{label}:</span> <span className={signalColor}>{signal}</span></>}
    />
  )
})

export default function PriceChart({ subscribeTicks, indicators, weeklyTrend, dailySMA, contract, signalAnnotations }) {
  const [candleCount, setCandleCount] = useState(null)
  // Levels of an expired contract can sit far from price and flatten the candles.
  const expired = contract?.expiry != null && contract.expiry <= Date.now()
  const referenceLines = useMemo(() => {
    const lines = []
    if (expired) return lines
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
  }, [contract?.target, contract?.stop, expired])

  const dailySMALines = useMemo(() => {
    const lines = []
    if (dailySMA?.sma50 > 0) {
      lines.push({ y: dailySMA.sma50, stroke: '#3b82f6', strokeDasharray: '4 2', label: `SMA50 ${formatBTCPrice(dailySMA.sma50)}`, labelFill: '#3b82f6' })
    }
    if (dailySMA?.sma100 > 0) {
      lines.push({ y: dailySMA.sma100, stroke: '#f59e0b', strokeDasharray: '4 2', label: `SMA100 ${formatBTCPrice(dailySMA.sma100)}`, labelFill: '#f59e0b' })
    }
    if (dailySMA?.sma200 > 0) {
      lines.push({ y: dailySMA.sma200, stroke: '#ef4444', strokeDasharray: '6 3', label: `SMA200 ${formatBTCPrice(dailySMA.sma200)}`, labelFill: '#ef4444' })
    }
    return lines
  }, [dailySMA?.sma50, dailySMA?.sma100, dailySMA?.sma200])

  const renderChart = (tf) => {
    const tfScore = indicators?.[tf.interval]?.score ?? 0
    const tfSignal = tfScoreToSignal(tfScore)
    return (
      <TimeframePriceChart
        key={tf.interval}
        label={tf.interval}
        signal={tfSignal.replace(/_/g, ' ')}
        signalColor={SIGNAL_COLORS[tfSignal]}
        subscribeTicks={subscribeTicks}
        interval={tf.interval}
        range={tf.range}
        referenceLines={tf.interval === '5m' ? referenceLines : tf.interval === '1d' ? dailySMALines : EMPTY_LINES}
        signalAnnotations={signalAnnotations}
        candleCount={candleCount}
      />
    )
  }

  const weeklyBias = weeklyTrend?.weeklyBias || 'neutral'
  const weeklyColor = WEEKLY_SIGNAL_COLORS[weeklyBias] || WEEKLY_SIGNAL_COLORS.neutral
  const weeklyLabel = weeklyBias.toUpperCase()

  return (
    <div className="space-y-2">
      {/* Candle count selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-gray-400">Candles:</span>
        {CANDLE_COUNT_OPTIONS.map(opt => (
          <Button
            key={opt.label}
            onClick={() => setCandleCount(opt.value)}
            variant={candleCount === opt.value ? 'primary' : 'secondary'} size="xs"
          >
            {opt.label}
          </Button>
        ))}
      </div>
      {/* 1-minute chart — full width */}
      {renderChart({ interval: '1m', range: '1h' })}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          {LEFT_TFS.map(renderChart)}
        </div>
        <div className="space-y-2">
          {RIGHT_TFS.map(renderChart)}
        </div>
      </div>
      {/* Weekly macro chart — full width at bottom */}
      <TimeframePriceChart
        label="1W"
        signal={weeklyLabel}
        signalColor={weeklyColor}
        subscribeTicks={subscribeTicks}
        interval="1w"
        range="52w"
        signalAnnotations={signalAnnotations}
        weekly
      />
    </div>
  )
}
