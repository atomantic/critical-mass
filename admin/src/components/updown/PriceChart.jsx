import { useMemo } from 'react'
import BTCPriceChart from '../charts/BTCPriceChart'
import { formatBTCPrice } from '../charts/chartUtils'

export default function PriceChart({ tick, indicators, contract }) {
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
    <BTCPriceChart
      exchange="cryptocom"
      tickPrice={tick?.price}
      tickTimestamp={tick?.timestamp}
      indicators={indicators}
      overlays={['atomoku', 'bollinger', 'vwap']}
      subCharts={['rsi', 'stochastic', 'macd']}
      referenceLines={referenceLines}
    />
  )
}
