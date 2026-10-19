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

export function AreaChart({
  data,
  title,
  valueKey = 'value',
  dateKey = 'date',
  color = colors.blue,
  formatValue = formatCurrencyCompact,
  formatTooltip = formatCurrency,
  showTooltip = true,
}) {
  const [ref, size] = useElementSize()
  const clipId = svgId(`clip-area-${title?.replace(/\s+/g, '-') || 'chart'}`, useId())
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
    const yExtent = extent(parsedData, (d) => d[valueKey])
    const y = linearScale([Math.min(0, yExtent[0]), yExtent[1] * 1.1], [height, 0]).nice()
    const at = { x: (d) => x(d.parsedDate), y1: (d) => y(d[valueKey]) }

    return {
      margin, width, height, parsedData, x, y,
      dateFormatter: getSmartDateFormatter(minDate, maxDate),
      tickCount: getSmartTickCount(maxDate - minDate, size.width),
      axisFontSize: getAxisFontSize(size.width),
      area: areaPath(parsedData, { x: at.x, y0: height, y1: at.y1 }),
      line: linePath(parsedData, { x: at.x, y: at.y1 }),
    }
  }, [hasData, data, dateKey, valueKey, size.width, size.height])

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Not enough data for chart
      </div>
    )
  }

  const renderHover = () => {
    const { x, y, width, height } = chart
    const xPos = x(hovered.parsedDate)
    const yPos = y(hovered[valueKey])
    return (
      <HoverMarker
        x={xPos}
        height={height}
        dot={{ y: yPos, color }}
        box={{ x: xPos > width / 2 ? xPos - 110 : xPos + 10, y: yPos < 40 ? yPos + 10 : yPos - 45, width: 140, height: 40 }}
        rows={[
          { text: formatDateTimeFull(hovered.parsedDate), color: colors.lightGray, fontSize: '10px' },
          { text: formatTooltip(hovered[valueKey]), color, fontSize: '12px', bold: true },
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
          <path clipPath={`url(#${clipId})`} fill={colorWithOpacity(color, 0.3)} d={chart.area} />
          <path clipPath={`url(#${clipId})`} fill="none" stroke={color} strokeWidth={2} d={chart.line} />
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
          <Axis orient="left" scale={chart.y} ticks={chart.y.ticks(5)} format={formatValue} textFill={colors.lightGray} fontSize={chart.axisFontSize} />
          {showTooltip && hovered && renderHover()}
          {showTooltip && (
            <rect
              className="overlay"
              width={chart.width}
              height={chart.height}
              fill="none"
              pointerEvents="all"
              onMouseMove={(event) => setHovered(nearestByDate(chart.parsedData, chart.x.invert(localPoint(event)[0])))}
              onMouseLeave={() => setHovered(null)}
            />
          )}
        </g>
      )}
    </svg>
  )
}

export default AreaChart
