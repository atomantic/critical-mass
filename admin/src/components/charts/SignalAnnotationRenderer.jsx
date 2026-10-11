import { usePlotArea } from 'recharts'
import usePriceChartCoordinates from './usePriceChartCoordinates'

/**
 * Custom SVG renderer for signal change annotations on the price chart.
 * Uses the public Recharts coordinate hooks, like the other price layers.
 *
 * Reads `signalChange` field from chart data points and renders small markers
 * at the bottom of the chart area.
 */
const MARKER_COLORS = {
  STRONG_BUY: '#10b981',
  BUY: '#10b981',
  OPEN: '#10b981',
  ADD: '#14b8a6',
  STRONG_SELL: '#ef4444',
  SELL: '#ef4444',
  CLOSE: '#ef4444',
}

const MARKER_LABELS = {
  STRONG_BUY: 'OPEN',
  BUY: 'OPEN',
  OPEN: 'OPEN',
  ADD: 'ADD',
  STRONG_SELL: 'CLOSE',
  SELL: 'CLOSE',
  CLOSE: 'CLOSE',
}

const SignalAnnotationRenderer = ({ data }) => {
  const { points } = usePriceChartCoordinates(data)
  const plot = usePlotArea()
  if (!plot || points.length < 2) return null
  const yBottom = plot.y + plot.height - 6

  const markers = []

  for (let i = 0; i < points.length; i++) {
    const d = points[i]?.payload
    if (!d?.signalChange) continue

    const x = points[i].x
    if (!Number.isFinite(x)) continue

    const { type } = d.signalChange
    const isBuy = type === 'BUY' || type === 'STRONG_BUY' || type === 'OPEN' || type === 'ADD'
    const isSell = type === 'SELL' || type === 'STRONG_SELL' || type === 'CLOSE'

    // Only render Open/Add/Close markers — skip HOLD
    if (!isBuy && !isSell) continue

    const color = MARKER_COLORS[type]
    const label = MARKER_LABELS[type]

    if (isBuy) {
      // Upward triangle
      markers.push(
        <g key={`sig-${i}`}>
          <polygon
            points={`${x},${yBottom - 8} ${x - 5},${yBottom} ${x + 5},${yBottom}`}
            fill={color}
            opacity={0.9}
          />
          <text x={x} y={yBottom + 10} textAnchor="middle" fontSize={8} fill={color} fontWeight="bold">
            {label}
          </text>
        </g>
      )
    } else {
      // Downward triangle
      markers.push(
        <g key={`sig-${i}`}>
          <polygon
            points={`${x},${yBottom} ${x - 5},${yBottom - 8} ${x + 5},${yBottom - 8}`}
            fill={color}
            opacity={0.9}
          />
          <text x={x} y={yBottom + 10} textAnchor="middle" fontSize={8} fill={color} fontWeight="bold">
            {label}
          </text>
        </g>
      )
    }
  }

  if (!markers.length) return null
  return <g>{markers}</g>
}

export default SignalAnnotationRenderer
