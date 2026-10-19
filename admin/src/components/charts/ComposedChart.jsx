import { useId, useMemo, useState } from 'react'
import { areaPath, extent, linePath, linearScale, timeScale } from '../../lib/chart-math'
import { Axis } from './primitives/Axis'
import { ClipRect, Grid } from './primitives/Grid'
import { HoverMarker } from './primitives/Tooltip'
import { localPoint, svgId, useElementSize } from './primitives/Responsive'
import {
  formatCurrencyCompact,
  formatCurrency,
  formatDateTimeFull,
  getResponsiveMargin,
  getAxisFontSize,
  getSmartDateFormatter,
  getSmartTickCount,
  colors,
  DASHED_GRID,
  colorWithOpacity,
  nearestByDate,
  parseDates,
} from './chartUtils'

export function ComposedChart({
  data,
  title,
  dateKey = 'date',
  areas = [],
  lines = [],
}) {
  const [ref, size] = useElementSize()
  const clipId = svgId(`clip-composed-${title?.replace(/\s+/g, '-') || 'chart'}`, useId())
  const [hovered, setHovered] = useState(null)
  const hasData = data?.length >= 2

  const chart = useMemo(() => {
    if (!hasData || !size.width) return null
    const margin = getResponsiveMargin(size.width)
    const width = size.width - margin.left - margin.right
    const height = size.height - margin.top - margin.bottom
    const parsedData = parseDates(data, dateKey)

    const [minDate, maxDate] = extent(parsedData, (d) => d.parsedDate)
    const x = timeScale([minDate, maxDate], [0, width])

    // One y domain across every series, padded 10% and always including zero.
    const allKeys = [...areas.map((a) => a.key), ...lines.map((l) => l.key)]
    const [yMin, yMax] = extent(parsedData.flatMap((d) => allKeys.map((k) => d[k] || 0)))
    const yPadding = (yMax - yMin) * 0.1
    const y = linearScale([Math.min(0, yMin - yPadding), yMax + yPadding], [height, 0]).nice()
    const atX = (d) => x(d.parsedDate)

    return {
      margin, width, height, parsedData, x, y,
      dateFormatter: getSmartDateFormatter(minDate, maxDate),
      tickCount: getSmartTickCount(maxDate - minDate, size.width),
      axisFontSize: getAxisFontSize(size.width),
      areaPaths: areas.map((a) => areaPath(parsedData, { x: atX, y0: y(0), y1: (d) => y(d[a.key] || 0) })),
      linePaths: lines.map((l) => linePath(parsedData, { x: atX, y: (d) => y(d[l.key] || 0) })),
    }
  }, [hasData, data, dateKey, areas, lines, size.width, size.height])

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Not enough data for chart
      </div>
    )
  }

  const allSeries = [...areas, ...lines]

  const renderHover = () => {
    const { x, width, height } = chart
    const xPos = x(hovered.parsedDate)
    return (
      <HoverMarker
        x={xPos}
        height={height}
        box={{ x: xPos > width / 2 ? xPos - 130 : xPos + 10, y: 20, width: 120, height: 20 + allSeries.length * 16 }}
        rows={[
          { text: formatDateTimeFull(hovered.parsedDate), color: colors.lightGray, fontSize: '10px' },
          ...allSeries.map((s) => ({ text: `${s.label}: ${formatCurrency(hovered[s.key] || 0)}`, color: s.color, fontSize: '11px' })),
        ]}
      />
    )
  }

  return (
    <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }}>
      {chart && (
        <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
          <ClipRect id={clipId} width={chart.width} height={chart.height} />
          <Grid width={chart.width} rows={chart.y.ticks(5).map(chart.y)} {...DASHED_GRID} />
          {areas.map((a, i) => (
            <path key={a.key} clipPath={`url(#${clipId})`} fill={colorWithOpacity(a.color, 0.3)} stroke={a.color} strokeWidth={1} d={chart.areaPaths[i]} />
          ))}
          {lines.map((l, i) => (
            <path
              key={l.key}
              clipPath={`url(#${clipId})`}
              fill="none"
              stroke={l.color}
              strokeWidth={l.strokeWidth || 2}
              strokeDasharray={l.dashed ? '5,3' : undefined}
              d={chart.linePaths[i]}
            />
          ))}
          <Axis
            orient="bottom"
            transform={`translate(0,${chart.height})`}
            scale={chart.x}
            ticks={chart.x.ticks(chart.tickCount)}
            format={chart.dateFormatter}
            stroke={colors.darkGray}
            textFill={colors.lightGray}
            fontSize={chart.axisFontSize}
          />
          <Axis orient="left" scale={chart.y} ticks={chart.y.ticks(5)} format={formatCurrencyCompact} textFill={colors.lightGray} fontSize={chart.axisFontSize} />
          <g className="legend" transform="translate(10, 10)">
            {allSeries.map((s, i) => (
              <g key={s.key} transform={`translate(${i * 90}, 0)`}>
                {lines.includes(s) ? (
                  <line x1={0} x2={15} y1={5} y2={5} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '3,2' : undefined} />
                ) : (
                  <rect width={12} height={12} fill={colorWithOpacity(s.color, 0.5)} stroke={s.color} rx={2} />
                )}
                <text x={20} y={10} fill={colors.lightGray} style={{ fontSize: '10px' }}>{s.label}</text>
              </g>
            ))}
          </g>
          {hovered && renderHover()}
          <rect
            className="overlay"
            width={chart.width}
            height={chart.height}
            fill="none"
            pointerEvents="all"
            onMouseMove={(event) => setHovered(nearestByDate(chart.parsedData, chart.x.invert(localPoint(event)[0])))}
            onMouseLeave={() => setHovered(null)}
          />
        </g>
      )}
    </svg>
  )
}

export default ComposedChart
