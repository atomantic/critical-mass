import { useXAxisScale, useYAxisScale } from 'recharts'

// BTCPriceChart uses a unique chartIndex category, independent of display labels.
export default function usePriceChartCoordinates(data) {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  return {
    points: xScale ? data.map(payload => ({ payload, x: xScale(payload.chartIndex) })) : [],
    yScale,
  }
}
