import usePriceChartCoordinates from './usePriceChartCoordinates'
import { colors } from './chartUtils'

/** Aggressive buy volume (green) with sell volume (red) stacked on it, one bar per slot. */
const VolumeRenderer = ({ data }) => {
  const { points, yScale } = usePriceChartCoordinates(data)
  if (!yScale || points.length < 2) return null
  const width = Math.max(1, Math.abs(points[1].x - points[0].x) * 0.7)
  const base = yScale(0)

  return (
    <g>
      {points.map(({ payload, x }) => {
        const { buyVolume, sellVolume } = payload
        if (!(buyVolume + sellVolume > 0)) return null
        const buyTop = yScale(buyVolume)
        const top = yScale(buyVolume + sellVolume)
        return (
          <g key={payload.chartIndex}>
            <rect className="volume-buy" x={x - width / 2} width={width} y={buyTop} height={base - buyTop} fill={colors.green} />
            <rect className="volume-sell" x={x - width / 2} width={width} y={top} height={buyTop - top} fill={colors.red} />
          </g>
        )
      })}
    </g>
  )
}

export default VolumeRenderer
