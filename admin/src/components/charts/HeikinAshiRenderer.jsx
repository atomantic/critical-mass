import usePriceChartCoordinates from './usePriceChartCoordinates'

const HA_FIELDS = { open: 'haOpen', high: 'haHigh', low: 'haLow', close: 'haClose' }

/**
 * Custom SVG candlesticks positioned by the chart's coordinate scales. Heikin Ashi by
 * default; `fields` names the OHLC properties to draw instead.
 */
const HeikinAshiRenderer = ({ data, fields = HA_FIELDS }) => {
  const { points, yScale } = usePriceChartCoordinates(data)
  if (!yScale || points.length < 2) return null

  // Auto-compute candle width from point spacing (70% of gap, min 2px)
  const xGap = points.length > 1 ? Math.abs(points[1].x - points[0].x) : 8
  const bodyWidth = Math.max(2, xGap * 0.7)
  const halfBody = bodyWidth / 2

  const candles = []

  for (let i = 0; i < points.length; i++) {
    const d = points[i]?.payload
    if (!d) continue
    const open = d[fields.open]
    const high = d[fields.high]
    const low = d[fields.low]
    const close = d[fields.close]
    if (open == null || close == null || high == null || low == null) continue

    const x = points[i].x
    if (!Number.isFinite(x)) continue

    const yOpen = yScale(open)
    const yClose = yScale(close)
    const yHigh = yScale(high)
    const yLow = yScale(low)

    if ([yOpen, yClose, yHigh, yLow].some(v => !Number.isFinite(v))) continue

    const bullish = close >= open
    const color = bullish ? '#10b981' : '#ef4444'
    const bodyTop = Math.min(yOpen, yClose)
    const bodyHeight = Math.max(Math.abs(yClose - yOpen), 1)

    candles.push(
      <g key={`ha-${i}`} className="candle">
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
          fill={color}
          stroke={color}
          strokeWidth={0.5}
        />
      </g>
    )
  }

  return <g>{candles}</g>
}

export default HeikinAshiRenderer
