import { useId, useMemo } from 'react'
import { formatTime, timeScale } from '../../lib/chart-math'
import ChartDataAlternative from './ChartDataAlternative'
import { useElementSize } from './primitives/Responsive'
import {
  REGIME_INTERVAL_COLUMNS,
  buildRegimeIntervals,
  describeRegimeIntervals,
  formatClock,
  regimeIntervalRows,
} from './chartDataText'

// Regime colors
const REGIME_COLORS = {
  HARVEST: '#22c55e',
  CAUTION: '#eab308',
  TREND: '#ef4444',
}

const REGIME_BG_COLORS = {
  HARVEST: 'rgba(34, 197, 94, 0.3)',
  CAUTION: 'rgba(234, 179, 8, 0.3)',
  TREND: 'rgba(239, 68, 68, 0.3)',
}

const formatHourMinute = formatTime('%H:%M')

/**
 * Horizontal bar showing regime history
 * Color-coded segments (green=HARVEST, yellow=CAUTION, red=TREND)
 * Compact ~60px height
 */
function RegimeTimeline({
  data = [],
  currentRegime,
  height = 60,
  className = '',
}) {
  const [containerRef, { width: containerWidth }] = useElementSize()
  const headingId = useId()
  const summaryId = useId()

  // Sort and prepare regime data
  const regimeData = useMemo(() => {
    if (data.length === 0 && currentRegime) {
      // If no history but we have current regime, show it
      return [{
        mode: currentRegime.mode,
        timestamp: currentRegime.since || Date.now() - 60000,
      }]
    }
    return [...data].sort((a, b) => a.timestamp - b.timestamp)
  }, [data, currentRegime])

  // One-hour window ending "now", fixed per data change so the drawn bar and the text equivalent
  // below use identical boundaries.
  const timeWindow = useMemo(() => {
    const now = Date.now()
    return { now, timeStart: now - 60 * 60 * 1000 }
  }, [regimeData])

  const textAlternative = useMemo(() => {
    const { now, timeStart } = timeWindow
    const intervals = buildRegimeIntervals(regimeData, timeStart, now)
    return {
      summary: [
        `Window: ${formatClock(timeStart)} to now (${formatClock(now)}).`,
        describeRegimeIntervals(intervals),
      ],
      tables: [{
        caption: `Regime intervals from ${formatClock(timeStart)} to now`,
        columns: REGIME_INTERVAL_COLUMNS,
        rows: regimeIntervalRows(intervals),
      }],
    }
  }, [regimeData, timeWindow])

  const chart = useMemo(() => {
    if (containerWidth === 0) return null
    const margin = { top: 20, right: 10, bottom: 20, left: 10 }
    const innerWidth = containerWidth - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom
    const barHeight = Math.min(24, innerHeight)
    const { now, timeStart } = timeWindow
    const xScale = timeScale([timeStart, now], [0, innerWidth])

    // One segment per regime, from its start (clamped to the window) to the next regime or now.
    const segments = regimeData.flatMap((regime, i) => {
      const startTime = Math.max(regime.timestamp, timeStart)
      const endTime = i < regimeData.length - 1 ? regimeData[i + 1].timestamp : now
      if (!(startTime < now && endTime > timeStart)) return []
      const x = xScale(startTime)
      const segmentWidth = xScale(endTime) - x
      if (!(segmentWidth > 0)) return []
      const left = Math.max(0, x)
      return [{ mode: regime.mode, first: i === 0, left, width: Math.min(segmentWidth, innerWidth - left), segmentWidth }]
    })
    return { margin, innerWidth, innerHeight, barHeight, segments, timeStart }
  }, [regimeData, timeWindow, height, containerWidth])

  return (
    <div ref={containerRef} className={`bg-gray-800 rounded-lg p-3 ${className}`}>
      <span id={headingId} className="sr-only">Regime Timeline (1 hour)</span>
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
            <rect x={0} y={(chart.innerHeight - chart.barHeight) / 2} width={chart.innerWidth} height={chart.barHeight} fill="#374151" rx={4} />
            {regimeData.length > 0 ? chart.segments.map((segment, i) => (
              <g key={i}>
                <rect
                  x={segment.left}
                  y={(chart.innerHeight - chart.barHeight) / 2}
                  width={segment.width}
                  height={chart.barHeight}
                  fill={REGIME_BG_COLORS[segment.mode] || REGIME_BG_COLORS.HARVEST}
                  stroke={REGIME_COLORS[segment.mode] || REGIME_COLORS.HARVEST}
                  strokeWidth={1}
                  rx={segment.first ? 4 : 0}
                />
                {/* Label only segments wide enough to hold it */}
                {segment.segmentWidth > 50 && (
                  <text
                    x={segment.left + segment.width / 2}
                    y={chart.innerHeight / 2 + 4}
                    textAnchor="middle"
                    fill={REGIME_COLORS[segment.mode] || '#fff'}
                    fontSize="10px"
                    fontWeight="500"
                  >
                    {segment.mode}
                  </text>
                )}
              </g>
            )) : (
              <text x={chart.innerWidth / 2} y={chart.innerHeight / 2 + 4} textAnchor="middle" fill="#6b7280" fontSize="10px">
                No regime history
              </text>
            )}
            {/* Current time marker */}
            <line
              x1={chart.innerWidth}
              x2={chart.innerWidth}
              y1={(chart.innerHeight - chart.barHeight) / 2 - 4}
              y2={(chart.innerHeight + chart.barHeight) / 2 + 4}
              stroke="#fff"
              strokeWidth={2}
            />
            <text x={0} y={chart.innerHeight + 12} fill="#6b7280" fontSize="9px">{formatHourMinute(new Date(chart.timeStart))}</text>
            <text x={chart.innerWidth} y={chart.innerHeight + 12} textAnchor="end" fill="#6b7280" fontSize="9px">Now</text>
            <text x={0} y={-6} fill="#9ca3af" fontSize="11px" fontWeight="500">Regime Timeline (1 hour)</text>
          </g>
        )}
      </svg>
      <ChartDataAlternative summaryId={summaryId} summary={textAlternative.summary} tables={textAlternative.tables} />
    </div>
  )
}

export default RegimeTimeline
