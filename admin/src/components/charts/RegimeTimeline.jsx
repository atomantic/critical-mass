import { useRef, useEffect, useMemo } from 'react'
import * as d3 from 'd3'

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
  const containerRef = useRef(null)
  const svgRef = useRef(null)

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

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return

    const containerWidth = containerRef.current.clientWidth
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const margin = { top: 20, right: 10, bottom: 20, left: 10 }
    const width = containerWidth
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom
    const barHeight = Math.min(24, innerHeight)

    svg.attr('width', width).attr('height', height)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Time range: last 15 minutes
    const now = Date.now()
    const timeStart = now - 15 * 60 * 1000

    const xScale = d3.scaleTime()
      .domain([timeStart, now])
      .range([0, innerWidth])

    // Background
    g.append('rect')
      .attr('x', 0)
      .attr('y', (innerHeight - barHeight) / 2)
      .attr('width', innerWidth)
      .attr('height', barHeight)
      .attr('fill', '#374151')
      .attr('rx', 4)

    // Draw regime segments
    if (regimeData.length > 0) {
      regimeData.forEach((regime, i) => {
        const startTime = Math.max(regime.timestamp, timeStart)
        const endTime = i < regimeData.length - 1
          ? regimeData[i + 1].timestamp
          : now

        if (startTime < now && endTime > timeStart) {
          const x = xScale(startTime)
          const segmentWidth = xScale(endTime) - x

          if (segmentWidth > 0) {
            // Segment rectangle
            g.append('rect')
              .attr('x', Math.max(0, x))
              .attr('y', (innerHeight - barHeight) / 2)
              .attr('width', Math.min(segmentWidth, innerWidth - Math.max(0, x)))
              .attr('height', barHeight)
              .attr('fill', REGIME_BG_COLORS[regime.mode] || REGIME_BG_COLORS.HARVEST)
              .attr('stroke', REGIME_COLORS[regime.mode] || REGIME_COLORS.HARVEST)
              .attr('stroke-width', 1)
              .attr('rx', i === 0 ? 4 : 0)

            // Regime label (if segment is wide enough)
            if (segmentWidth > 50) {
              g.append('text')
                .attr('x', Math.max(0, x) + Math.min(segmentWidth, innerWidth - Math.max(0, x)) / 2)
                .attr('y', innerHeight / 2 + 4)
                .attr('text-anchor', 'middle')
                .attr('fill', REGIME_COLORS[regime.mode] || '#fff')
                .attr('font-size', '10px')
                .attr('font-weight', '500')
                .text(regime.mode)
            }
          }
        }
      })
    } else {
      // No data - show placeholder
      g.append('text')
        .attr('x', innerWidth / 2)
        .attr('y', innerHeight / 2 + 4)
        .attr('text-anchor', 'middle')
        .attr('fill', '#6b7280')
        .attr('font-size', '10px')
        .text('No regime history')
    }

    // Current time marker
    g.append('line')
      .attr('x1', innerWidth)
      .attr('x2', innerWidth)
      .attr('y1', (innerHeight - barHeight) / 2 - 4)
      .attr('y2', (innerHeight + barHeight) / 2 + 4)
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)

    // Time labels
    const timeFormat = d3.timeFormat('%H:%M')

    g.append('text')
      .attr('x', 0)
      .attr('y', innerHeight + 12)
      .attr('fill', '#6b7280')
      .attr('font-size', '9px')
      .text(timeFormat(new Date(timeStart)))

    g.append('text')
      .attr('x', innerWidth)
      .attr('y', innerHeight + 12)
      .attr('text-anchor', 'end')
      .attr('fill', '#6b7280')
      .attr('font-size', '9px')
      .text('Now')

    // Title
    g.append('text')
      .attr('x', 0)
      .attr('y', -6)
      .attr('fill', '#9ca3af')
      .attr('font-size', '11px')
      .attr('font-weight', '500')
      .text('Regime Timeline (15 min)')

  }, [regimeData, height])

  // Handle resize
  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      if (svgRef.current && containerRef.current) {
        // Trigger re-render
        const event = new Event('resize')
        window.dispatchEvent(event)
      }
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    return () => resizeObserver.disconnect()
  }, [regimeData])

  return (
    <div ref={containerRef} className={`bg-gray-800 rounded-lg p-3 ${className}`}>
      <svg ref={svgRef} className="w-full" style={{ height }} />
    </div>
  )
}

export default RegimeTimeline
