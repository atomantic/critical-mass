import { useId, useMemo } from 'react'
import { areaPath, extent, formatTime, linePath, linearScale, max, timeScale } from '../../lib/chart-math'
import { formatPriceCompact, regimeZones } from './chartUtils'
import ChartDataAlternative from './ChartDataAlternative'
import { Axis, solidAxis } from './primitives/Axis'
import { useElementSize } from './primitives/Responsive'
import {
  REGIME_INTERVAL_COLUMNS,
  buildRegimeIntervals,
  describeRegimeIntervals,
  describeSeries,
  describeWindow,
  formatClock,
  formatPct,
  formatStamp,
  formatUsd,
  regimeIntervalRows,
  summarizeSeries,
} from './chartDataText'

// Regime colors for background zones
const REGIME_COLORS = {
  HARVEST: 'rgba(34, 197, 94, 0.1)',
  CAUTION: 'rgba(234, 179, 8, 0.1)',
  TREND: 'rgba(239, 68, 68, 0.1)',
}

const AXIS_GRAY = '#6b7280'
const VOL_AMBER = '#f59e0b'
const formatHourMinute = formatTime('%H:%M')
const LEGEND_ITEMS = [
  { label: 'ATR 1m', color: '#3b82f6' },
  { label: 'ATR 5m', color: '#8b5cf6' },
  { label: 'Real Vol', color: VOL_AMBER, dashed: true },
]

/**
 * Volatility chart showing ATR 1m/5m as stacked areas
 * with realized vol line overlay and regime-colored background zones
 */
function VolatilityChart({
  atrData = [],
  regimeData = [],
  height = 300,
  className = '',
}) {
  const [containerRef, { width: containerWidth }] = useElementSize()
  const headingId = useId()
  const summaryId = useId()

  // Filter to last 15 minutes and sort by timestamp so the plotted lines (drawn in array order)
  // and the text equivalent below always share one chronological series.
  const chartData = useMemo(() => {
    const cutoff = Date.now() - 15 * 60 * 1000
    return atrData.filter(d => d.timestamp > cutoff).sort((a, b) => a.timestamp - b.timestamp)
  }, [atrData])

  const sortedRegimes = useMemo(() => [...regimeData].sort((a, b) => a.timestamp - b.timestamp), [regimeData])

  // Text equivalent derived from the exact samples and regime boundaries plotted.
  const textAlternative = useMemo(() => {
    if (chartData.length < 2) return null
    const start = chartData[0].timestamp
    const end = chartData[chartData.length - 1].timestamp
    const intervals = buildRegimeIntervals(sortedRegimes, start, end)
    const summary = [
      describeWindow(chartData, 'volatility samples'),
      describeSeries('ATR 1m', summarizeSeries(chartData, 'atr1m'), formatUsd),
      describeSeries('ATR 5m', summarizeSeries(chartData, 'atr5m'), formatUsd),
      describeSeries('Realized volatility', summarizeSeries(chartData, 'realizedVol'), formatPct),
      describeSeries('Volatility baseline', summarizeSeries(chartData, 'volBaseline'), formatPct),
      describeRegimeIntervals(intervals, 'the latest sample'),
    ]
    const rows = chartData.map(d => ({
      time: formatStamp(d.timestamp),
      atr1m: formatUsd(d.atr1m),
      atr5m: formatUsd(d.atr5m),
      realizedVol: formatPct(d.realizedVol),
      volBaseline: formatPct(d.volBaseline),
    }))
    return {
      summary,
      tables: [
        {
          caption: `Volatility samples from ${formatClock(start)} to ${formatClock(end)}`,
          columns: [
            { key: 'time', label: 'Time' },
            { key: 'atr1m', label: 'ATR 1m (USD)' },
            { key: 'atr5m', label: 'ATR 5m (USD)' },
            { key: 'realizedVol', label: 'Realized volatility (%)' },
            { key: 'volBaseline', label: 'Volatility baseline (%)' },
          ],
          rows,
        },
        {
          caption: 'Regime intervals in the plotted window',
          columns: REGIME_INTERVAL_COLUMNS,
          rows: regimeIntervalRows(intervals, 'Latest sample'),
        },
      ],
    }
  }, [chartData, sortedRegimes])

  const chart = useMemo(() => {
    if (chartData.length < 2 || containerWidth === 0) return null
    const margin = { top: 20, right: 60, bottom: 30, left: 50 }
    const innerWidth = containerWidth - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    const xExtent = extent(chartData, d => d.timestamp)
    const xScale = timeScale(xExtent, [0, innerWidth])
    // ATR in USD on the left axis, volatility % on the right.
    const atrMax = max(chartData, d => Math.max(d.atr1m, d.atr5m)) || 100
    const yAtr = linearScale([0, atrMax * 1.1], [innerHeight, 0])
    const volMax = max(chartData, d => Math.max(d.realizedVol, d.volBaseline)) || 5
    const yVol = linearScale([0, volMax * 1.1], [innerHeight, 0])

    const atX = d => xScale(d.timestamp)
    const atrArea = key => areaPath(chartData, { x: atX, y0: innerHeight, y1: d => yAtr(d[key]) })
    const atrLine = key => linePath(chartData, { x: atX, y: d => yAtr(d[key]) })
    return {
      margin, innerWidth, innerHeight, xScale, yAtr, yVol,
      zones: regimeZones(sortedRegimes, xScale, xExtent[0], innerWidth),
      atr5mArea: atrArea('atr5m'),
      atr1mArea: atrArea('atr1m'),
      atr1mLine: atrLine('atr1m'),
      atr5mLine: atrLine('atr5m'),
      volLine: linePath(chartData, { x: atX, y: d => yVol(d.realizedVol) }),
      baseline: chartData[chartData.length - 1]?.volBaseline,
    }
  }, [chartData, sortedRegimes, height, containerWidth])

  if (chartData.length < 2) {
    return (
      <div
        ref={containerRef}
        className={`flex items-center justify-center bg-gray-800 rounded-lg ${className}`}
        style={{ height }}
      >
        <span className="text-sm text-gray-400">Collecting volatility data...</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`bg-gray-800 rounded-lg p-4 ${className}`}>
      <h3 id={headingId} className="text-sm font-medium text-gray-400 mb-2">Volatility</h3>
      <svg
        role="img"
        aria-labelledby={headingId}
        aria-describedby={summaryId}
        className="w-full"
        width={chart ? containerWidth : undefined}
        height={chart ? height : undefined}
        style={{ height }}
      >
        {chart && (
          <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
            {chart.zones.map(({ mode, x, width }, i) => (
              <rect key={i} x={x} y={0} width={width} height={chart.innerHeight} fill={REGIME_COLORS[mode] || 'transparent'} />
            ))}
            <path d={chart.atr5mArea} fill="rgba(139, 92, 246, 0.2)" />
            <path d={chart.atr1mArea} fill="rgba(59, 130, 246, 0.3)" />
            <path d={chart.atr1mLine} fill="none" stroke="#3b82f6" strokeWidth={2} />
            <path d={chart.atr5mLine} fill="none" stroke="#8b5cf6" strokeWidth={2} />
            <path d={chart.volLine} fill="none" stroke={VOL_AMBER} strokeWidth={1.5} strokeDasharray="4,2" />
            {Boolean(chart.baseline) && (
              <line
                x1={0}
                x2={chart.innerWidth}
                y1={chart.yVol(chart.baseline)}
                y2={chart.yVol(chart.baseline)}
                stroke={VOL_AMBER}
                strokeWidth={1}
                strokeDasharray="2,4"
                opacity={0.5}
              />
            )}
            <Axis
              orient="bottom"
              transform={`translate(0,${chart.innerHeight})`}
              scale={chart.xScale}
              ticks={chart.xScale.ticks(6)}
              format={formatHourMinute}
              {...solidAxis(AXIS_GRAY)}
            />
            <Axis orient="left" scale={chart.yAtr} ticks={chart.yAtr.ticks(5)} format={formatPriceCompact} {...solidAxis(AXIS_GRAY)} />
            <Axis
              orient="right"
              transform={`translate(${chart.innerWidth},0)`}
              scale={chart.yVol}
              ticks={chart.yVol.ticks(5)}
              format={d => `${d.toFixed(1)}%`}
              {...solidAxis(VOL_AMBER)}
            />
            {/* Legend at bottom-left over a translucent backing */}
            <g transform={`translate(5, ${chart.innerHeight - 50})`}>
              <rect x={-4} y={-8} width={75} height={50} fill="rgba(31, 41, 55, 0.9)" rx={4} />
              {LEGEND_ITEMS.map((item, i) => (
                <g key={item.label} transform={`translate(0, ${i * 14})`}>
                  <line x1={0} x2={16} y1={0} y2={0} stroke={item.color} strokeWidth={2} strokeDasharray={item.dashed ? '4,2' : 'none'} />
                  <text x={20} y={4} fill="#9ca3af" fontSize="10px">{item.label}</text>
                </g>
              ))}
            </g>
          </g>
        )}
      </svg>
      <ChartDataAlternative summaryId={summaryId} summary={textAlternative.summary} tables={textAlternative.tables} />
    </div>
  )
}

export default VolatilityChart
