import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { bandScale, linearScale, max } from '../../lib/chart-math'
import { Axis } from './primitives/Axis'
import { Grid } from './primitives/Grid'
import { useElementSize } from './primitives/Responsive'
import {
  formatCurrencyCompact,
  formatCurrency,
  formatDateTimeFull,
  getResponsiveMargin,
  getAxisFontSize,
  getSmartDateFormatter,
  colors,
  DASHED_GRID,
} from './chartUtils'

const TOOLTIP_STYLE = {
  position: 'absolute',
  background: colors.darkBg,
  border: `1px solid ${colors.darkGray}`,
  borderRadius: '4px',
  padding: '8px 12px',
  fontSize: '12px',
  color: colors.lightGray,
  pointerEvents: 'none',
  zIndex: 1000,
}

export function BarChart({
  data,
  dateKey = 'date',
  series,
}) {
  const [ref, size] = useElementSize()
  const [hovered, setHovered] = useState(null)
  const hasData = data?.length > 0

  const chart = useMemo(() => {
    if (!hasData || !series?.length || !size.width) return null
    const margin = getResponsiveMargin(size.width)
    const width = size.width - margin.left - margin.right
    const height = size.height - margin.top - margin.bottom

    const dates = data.map((d) => (d[dateKey] instanceof Date ? d[dateKey] : new Date(d[dateKey])))
    const dateFormatter = getSmartDateFormatter(Math.min(...dates), Math.max(...dates))

    // One band per date, subdivided into one bar per series.
    const x0 = bandScale(data.map((d) => d[dateKey]), [0, width], { padding: 0.2 })
    const x1 = bandScale(series.map((s) => s.key), [0, x0.bandwidth()], { padding: 0.05 })
    const maxValue = max(data, (d) => max(series, (s) => d[s.key] || 0))
    const y = linearScale([0, maxValue * 1.1], [height, 0]).nice()

    return { margin, width, height, x0, x1, y, dateFormatter, axisFontSize: getAxisFontSize(size.width) }
  }, [hasData, data, dateKey, series, size.width, size.height])

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        No data available
      </div>
    )
  }

  const tooltip = hovered && createPortal(
    <div className="d3-tooltip" style={{ ...TOOLTIP_STYLE, left: hovered.pageX + 10, top: hovered.pageY - 28 }}>
      <div style={{ color: hovered.series.color, fontWeight: 'bold' }}>{hovered.series.label}</div>
      <div>{formatDateTimeFull(new Date(hovered.datum[dateKey]))}</div>
      <div>{formatCurrency(hovered.datum[hovered.series.key] || 0)}</div>
    </div>,
    document.body,
  )

  return (
    <>
      <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }}>
        {chart && (
          <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
            <Grid width={chart.width} rows={chart.y.ticks(5).map(chart.y)} {...DASHED_GRID} />
            {data.map((d, i) => (
              <g key={i} className="bar-group" transform={`translate(${chart.x0(d[dateKey])},0)`}>
                {series.map((s) => {
                  const value = d[s.key] || 0
                  const track = (event) => setHovered({ datum: d, series: s, pageX: event.pageX, pageY: event.pageY })
                  return (
                    <rect
                      key={s.key}
                      x={chart.x1(s.key)}
                      y={chart.y(value)}
                      width={chart.x1.bandwidth()}
                      height={chart.height - chart.y(value)}
                      fill={s.color}
                      rx={2}
                      onMouseEnter={track}
                      onMouseMove={track}
                      onMouseLeave={() => setHovered(null)}
                    />
                  )
                })}
              </g>
            ))}
            <Axis
              orient="bottom"
              transform={`translate(0,${chart.height})`}
              scale={chart.x0}
              ticks={chart.x0.domain()}
              format={(d) => chart.dateFormatter(new Date(d))}
              stroke={colors.darkGray}
              textFill={colors.lightGray}
              fontSize={chart.axisFontSize}
              textTransform="rotate(-45)"
              textAnchor="end"
            />
            <Axis orient="left" scale={chart.y} ticks={chart.y.ticks(5)} format={formatCurrencyCompact} textFill={colors.lightGray} fontSize={chart.axisFontSize} />
            <g className="legend" transform={`translate(${chart.width - 100}, 10)`}>
              {series.map((s, i) => (
                <g key={s.key} transform={`translate(0, ${i * 18})`}>
                  <rect width={12} height={12} fill={s.color} rx={2} />
                  <text x={18} y={10} fill={colors.lightGray} style={{ fontSize: '10px' }}>{s.label}</text>
                </g>
              ))}
            </g>
          </g>
        )}
      </svg>
      {tooltip}
    </>
  )
}

export default BarChart
