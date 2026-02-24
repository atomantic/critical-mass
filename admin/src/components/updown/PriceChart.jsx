import { useMemo } from 'react'
import BTCPriceChart from '../charts/BTCPriceChart'
import { formatBTCPrice } from '../charts/chartUtils'

const TIMEFRAMES = [
  { interval: '1m', range: '1h' },
  { interval: '3m', range: '3h' },
  { interval: '5m', range: '6h' },
  { interval: '15m', range: '12h' },
  { interval: '1h', range: '2d' },
]

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

  return (
    <div className="space-y-2">
      {TIMEFRAMES.map(tf => (
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
          signalAnnotations={tf.interval === '5m' ? signalAnnotations : undefined}
          height={160}
        />
      ))}
    </div>
  )
}
