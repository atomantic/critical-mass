import { useChartContext } from './chartContext'

/**
 * Horizontal rule at value `y` on a CartesianChart axis, labelled inside the right edge.
 * Values outside the axis domain are not drawn.
 */
export function ReferenceLine({ y, yAxisId, stroke = '#ccc', strokeDasharray, strokeOpacity, label }) {
  const chart = useChartContext()
  const scale = chart?.y(yAxisId)
  if (!scale) return null
  const [d0, d1] = scale.domain()
  if (!(y >= Math.min(d0, d1) && y <= Math.max(d0, d1))) return null
  const { plot } = chart
  const position = scale(y)
  return (
    <g className="reference-line">
      <line
        x1={plot.x}
        x2={plot.x + plot.width}
        y1={position}
        y2={position}
        stroke={stroke}
        strokeDasharray={strokeDasharray}
        strokeOpacity={strokeOpacity}
      />
      {label && (
        <text x={plot.x + plot.width - 4} y={position - 4} textAnchor="end" fill={label.fill ?? stroke} fontSize={label.fontSize}>
          {label.value}
        </text>
      )}
    </g>
  )
}
