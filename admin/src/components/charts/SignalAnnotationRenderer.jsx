/**
 * Custom SVG renderer for signal change annotations on the price chart.
 * Uses the same <Customized> pattern as HeikinAshiRenderer / AtomokuCloudRenderer.
 *
 * Reads `signalChange` field from chart data points and renders small markers
 * at the bottom of the chart area.
 */
const MARKER_COLORS = {
  STRONG_BUY: '#10b981',
  BUY: '#10b981',
  STRONG_SELL: '#ef4444',
  SELL: '#ef4444',
}

const MARKER_LABELS = {
  STRONG_BUY: 'BUY',
  BUY: 'BUY',
  STRONG_SELL: 'SELL',
  SELL: 'SELL',
}

const SignalAnnotationRenderer = ({ formattedGraphicalItems, yAxisMap }) => {
  const yAxis = yAxisMap && Object.values(yAxisMap)[0]
  if (!yAxis?.scale || !formattedGraphicalItems?.length) return null

  const yScale = yAxis.scale
  const domain = yScale.domain()
  // Place markers near the bottom of the chart (at 5% above the min)
  const yBottom = yScale(domain[0]) - 6

  let points = null
  for (const item of formattedGraphicalItems) {
    const pts = item?.props?.points
    if (pts?.length > 1) { points = pts; break }
  }
  if (!points) return null

  const markers = []

  for (let i = 0; i < points.length; i++) {
    const d = points[i]?.payload
    if (!d?.signalChange) continue

    const x = points[i].x
    if (x == null) continue

    const { type } = d.signalChange
    const isBuy = type === 'BUY' || type === 'STRONG_BUY'
    const isSell = type === 'SELL' || type === 'STRONG_SELL'

    // Only render BUY/SELL markers — skip NEUTRAL and NTZ
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
