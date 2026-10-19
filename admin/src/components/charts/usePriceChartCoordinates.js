import { useChartContext } from './primitives/chartContext'

// Positions BTCPriceChart samples by their unique chartIndex category (independent of the
// display labels) using the enclosing CartesianChart's own scales.
export default function usePriceChartCoordinates(data) {
  const chart = useChartContext()
  if (!chart) return { points: [], yScale: null, plot: null }
  return {
    points: data.map(payload => ({ payload, x: chart.x(payload.chartIndex) })),
    yScale: chart.y(),
    plot: chart.plot,
  }
}
