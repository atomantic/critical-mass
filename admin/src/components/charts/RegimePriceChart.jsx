import { useId, useMemo } from 'react'
import { areaPath, extent, formatTime, linePath, linearScale, max, min, timeScale } from '../../lib/chart-math'
import { formatPriceCompact, regimeZones } from './chartUtils'
import InfoTooltip from '../InfoTooltip'
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
  formatStamp,
  formatUsd,
  isNum,
  regimeIntervalRows,
  summarizeSeries,
} from './chartDataText'

// Regime colors for background zones
const REGIME_COLORS = {
  HARVEST: 'rgba(34, 197, 94, 0.08)',
  CAUTION: 'rgba(234, 179, 8, 0.08)',
  TREND: 'rgba(239, 68, 68, 0.08)',
}

const AXIS_GRAY = '#6b7280'
const PRICE_BLUE = '#60a5fa'
const formatHourMinute = formatTime('%H:%M')

/**
 * Price chart with ATR bands for the regime dashboard
 * Shows 1 hour of price data with trigger zones
 */
function RegimePriceChart({
  priceData = [],
  regimeData = [],
  currentPrice,
  anchorPrice,
  atr,
  kFactor = 0.6,
  height = 280,
  className = '',
}) {
  const [containerRef, { width: containerWidth }] = useElementSize()
  const headingId = useId()
  const summaryId = useId()

  // Filter to last 1 hour and sort by timestamp — defense in depth against any
  // unsorted/overlapping upstream series (lines and areas draw in array order,
  // so an unsorted series produces a line that jumps backward in time).
  const chartData = useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000
    return priceData.filter(d => d.timestamp > cutoff).sort((a, b) => a.timestamp - b.timestamp)
  }, [priceData])

  const sortedRegimes = useMemo(() => [...regimeData].sort((a, b) => a.timestamp - b.timestamp), [regimeData])

  // Text equivalent derived from the exact samples, regime boundaries and trigger bands plotted.
  const textAlternative = useMemo(() => {
    if (chartData.length < 2) return null
    const start = chartData[0].timestamp
    const end = chartData[chartData.length - 1].timestamp
    const intervals = buildRegimeIntervals(sortedRegimes, start, end)
    const priceSummary = summarizeSeries(chartData, 'price')
    const summary = [
      describeWindow(chartData, 'price samples'),
      describeSeries('Price', priceSummary, formatUsd),
    ]
    if (anchorPrice && atr && atr > 0) {
      const distance = kFactor * atr
      summary.push(`ATR trigger bands (${kFactor}x ATR of ${formatUsd(atr)}): anchor ${formatUsd(anchorPrice)}, upper trigger ${formatUsd(anchorPrice + distance)}, lower trigger ${formatUsd(anchorPrice - distance)}.`)
    }
    summary.push(describeRegimeIntervals(intervals, 'the latest sample'))
    const priceRows = chartData.map(d => ({
      time: formatStamp(d.timestamp),
      price: isNum(d.price) ? formatUsd(d.price) : 'missing',
    }))
    return {
      summary,
      tables: [
        {
          caption: `Price samples from ${formatClock(start)} to ${formatClock(end)}`,
          columns: [{ key: 'time', label: 'Time' }, { key: 'price', label: 'Price (USD)' }],
          rows: priceRows,
        },
        {
          caption: 'Regime intervals in the plotted window',
          columns: REGIME_INTERVAL_COLUMNS,
          rows: regimeIntervalRows(intervals, 'Latest sample'),
        },
      ],
    }
  }, [chartData, sortedRegimes, anchorPrice, atr, kFactor])

  const chart = useMemo(() => {
    if (chartData.length < 2 || containerWidth === 0) return null
    const margin = { top: 20, right: 60, bottom: 30, left: 60 }
    const innerWidth = containerWidth - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    const xExtent = extent(chartData, d => d.timestamp)
    const xScale = timeScale(xExtent, [0, innerWidth])
    const prices = chartData.map(d => d.price)
    const minPrice = min(prices)
    const maxPrice = max(prices)
    const padding = (maxPrice - minPrice) * 0.15 || 50
    const yScale = linearScale([minPrice - padding, maxPrice + padding], [innerHeight, 0])

    const atX = d => xScale(d.timestamp)
    return {
      margin, innerWidth, innerHeight, xScale, yScale,
      zones: regimeZones(sortedRegimes, xScale, xExtent[0], innerWidth),
      area: areaPath(chartData, { x: atX, y0: innerHeight, y1: d => yScale(d.price) }),
      line: linePath(chartData, { x: atX, y: d => yScale(d.price) }),
      lastPoint: chartData[chartData.length - 1],
    }
  }, [chartData, sortedRegimes, height, containerWidth])

  if (chartData.length < 2) {
    return (
      <div
        ref={containerRef}
        className={`flex items-center justify-center bg-gray-800 rounded-lg ${className}`}
        style={{ height }}
      >
        <span className="text-sm text-gray-400">Collecting price data...</span>
      </div>
    )
  }

  const renderTriggers = () => {
    const { innerWidth, yScale } = chart
    const triggerDistance = kFactor * atr
    const upperTrigger = anchorPrice + triggerDistance
    const lowerTrigger = anchorPrice - triggerDistance
    const rule = (value, stroke, dash) => (
      <line x1={0} x2={innerWidth} y1={yScale(value)} y2={yScale(value)} stroke={stroke} strokeWidth={1} strokeDasharray={dash} />
    )
    const label = (y, fill, text, title) => (
      <text x={innerWidth - 5} y={y} textAnchor="end" fill={fill} fontSize="9px" cursor="help">
        {text}
        <title>{title}</title>
      </text>
    )
    return (
      <>
        <rect
          x={0}
          y={yScale(upperTrigger + triggerDistance * 0.5)}
          width={innerWidth}
          height={yScale(upperTrigger) - yScale(upperTrigger + triggerDistance * 0.5)}
          fill="rgba(34, 197, 94, 0.1)"
        />
        <rect
          x={0}
          y={yScale(lowerTrigger)}
          width={innerWidth}
          height={yScale(lowerTrigger - triggerDistance * 0.5) - yScale(lowerTrigger)}
          fill="rgba(239, 68, 68, 0.1)"
        />
        {rule(anchorPrice, PRICE_BLUE, '4,4')}
        {rule(upperTrigger, '#22c55e', '2,2')}
        {rule(lowerTrigger, '#ef4444', '2,2')}
        {label(yScale(anchorPrice) - 4, PRICE_BLUE, `Anchor ${formatPriceCompact(anchorPrice)}`,
          'Anchor price: the reference price used to calculate ATR trigger bands')}
        {label(yScale(upperTrigger) - 4, '#22c55e', `+${kFactor}x ATR`,
          `Upper trigger: ${formatPriceCompact(upperTrigger)} — price ${kFactor}× ATR above anchor signals bullish momentum`)}
        {label(yScale(lowerTrigger) + 12, '#ef4444', `-${kFactor}x ATR`,
          `Lower trigger: ${formatPriceCompact(lowerTrigger)} — price ${kFactor}× ATR below anchor signals bearish pressure`)}
      </>
    )
  }

  const rightTick = chart && [chart.lastPoint?.price || currentPrice].filter(Boolean)

  return (
    <div ref={containerRef} className={`bg-gray-800 rounded-lg p-4 ${className}`}>
      <h3 id={headingId} className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-1.5">
        Price & ATR Triggers
        <InfoTooltip
          label="About ATR triggers"
          width="w-80"
          iconClassName="w-3.5 h-3.5"
          className=""
          tip={<>
            <strong className="text-gray-100">ATR</strong> (Average True Range) measures market volatility.
            <br />Trigger lines at ±{kFactor}× ATR from anchor price signal regime shifts.
          </>}
        />
      </h3>
      <svg
        role="img"
        aria-labelledby={headingId}
        aria-describedby={summaryId}
        className="w-full"
        width={chart ? containerWidth : undefined}
        height={chart ? height : undefined}
        style={{ height: height - 40 }}
      >
        {chart && (
          <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
            {chart.zones.map(({ mode, x, width }, i) => (
              <rect key={i} x={x} y={0} width={width} height={chart.innerHeight} fill={REGIME_COLORS[mode] || 'transparent'} />
            ))}
            {Boolean(anchorPrice) && atr > 0 && renderTriggers()}
            <path d={chart.area} fill="rgba(96, 165, 250, 0.1)" />
            <path d={chart.line} fill="none" stroke={PRICE_BLUE} strokeWidth={2} />
            {chart.lastPoint && (
              <>
                <circle
                  cx={chart.xScale(chart.lastPoint.timestamp)}
                  cy={chart.yScale(chart.lastPoint.price)}
                  r={4}
                  fill={PRICE_BLUE}
                  stroke="#1e3a5f"
                  strokeWidth={2}
                />
                {/* Current price line extending to the right axis */}
                <line
                  x1={chart.xScale(chart.lastPoint.timestamp)}
                  x2={chart.innerWidth}
                  y1={chart.yScale(chart.lastPoint.price)}
                  y2={chart.yScale(chart.lastPoint.price)}
                  stroke={PRICE_BLUE}
                  strokeWidth={1}
                  strokeDasharray="2,2"
                  opacity={0.5}
                />
              </>
            )}
            <Axis
              orient="bottom"
              transform={`translate(0,${chart.innerHeight})`}
              scale={chart.xScale}
              ticks={chart.xScale.ticks(6)}
              format={formatHourMinute}
              {...solidAxis(AXIS_GRAY)}
            />
            <Axis orient="left" scale={chart.yScale} ticks={chart.yScale.ticks(6)} format={formatPriceCompact} {...solidAxis(AXIS_GRAY)} />
            <Axis
              orient="right"
              transform={`translate(${chart.innerWidth},0)`}
              scale={chart.yScale}
              ticks={rightTick}
              format={formatPriceCompact}
              stroke={PRICE_BLUE}
              textFill={PRICE_BLUE}
              fontWeight="600"
            />
          </g>
        )}
      </svg>
      <ChartDataAlternative summaryId={summaryId} summary={textAlternative.summary} tables={textAlternative.tables} />
    </div>
  )
}

export default RegimePriceChart
