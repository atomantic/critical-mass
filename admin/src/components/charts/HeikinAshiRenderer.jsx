/**
 * Custom SVG renderer for Heikin Ashi candlesticks inside Recharts <Customized>.
 * Same pattern as AtomokuCloudRenderer — reads data from formattedGraphicalItems.
 */
const HeikinAshiRenderer = ({ formattedGraphicalItems, yAxisMap }) => {
  const yAxis = yAxisMap && Object.values(yAxisMap)[0]
  if (!yAxis?.scale || !formattedGraphicalItems?.length) return null

  const yScale = yAxis.scale

  // Get X positions and data payload from any graphical item's points
  let points = null
  for (const item of formattedGraphicalItems) {
    const pts = item?.props?.points
    if (pts?.length > 1) { points = pts; break }
  }
  if (!points || points.length < 2) return null

  // Auto-compute candle width from point spacing (70% of gap, min 2px)
  const xGap = points.length > 1 ? Math.abs(points[1].x - points[0].x) : 8
  const bodyWidth = Math.max(2, xGap * 0.7)
  const halfBody = bodyWidth / 2

  const candles = []

  for (let i = 0; i < points.length; i++) {
    const d = points[i]?.payload
    if (!d || d.haOpen == null || d.haClose == null || d.haHigh == null || d.haLow == null) continue

    const x = points[i].x
    if (x == null) continue

    const yOpen = yScale(d.haOpen)
    const yClose = yScale(d.haClose)
    const yHigh = yScale(d.haHigh)
    const yLow = yScale(d.haLow)

    if ([yOpen, yClose, yHigh, yLow].some(v => isNaN(v))) continue

    const bullish = d.haClose >= d.haOpen
    const color = bullish ? '#10b981' : '#ef4444'
    const bodyTop = Math.min(yOpen, yClose)
    const bodyHeight = Math.max(Math.abs(yClose - yOpen), 1)

    candles.push(
      <g key={`ha-${i}`}>
        {/* Upper wick */}
        <line x1={x} x2={x} y1={yHigh} y2={bodyTop} stroke={color} strokeWidth={1} />
        {/* Lower wick */}
        <line x1={x} x2={x} y1={bodyTop + bodyHeight} y2={yLow} stroke={color} strokeWidth={1} />
        {/* Body */}
        <rect
          x={x - halfBody}
          y={bodyTop}
          width={bodyWidth}
          height={bodyHeight}
          fill={bullish ? color : color}
          stroke={color}
          strokeWidth={0.5}
        />
      </g>
    )
  }

  return <g>{candles}</g>
}

export default HeikinAshiRenderer
