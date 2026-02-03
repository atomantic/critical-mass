import { useRef, useEffect, useMemo, useState } from 'react'
import * as d3 from 'd3'

// Regime colors for background zones
const REGIME_COLORS = {
  HARVEST: 'rgba(34, 197, 94, 0.1)',
  CAUTION: 'rgba(234, 179, 8, 0.1)',
  TREND: 'rgba(239, 68, 68, 0.1)',
}

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
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // Filter to last 15 minutes
  const chartData = useMemo(() => {
    const cutoff = Date.now() - 15 * 60 * 1000
    return atrData.filter(d => d.timestamp > cutoff)
  }, [atrData])

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || chartData.length < 2 || containerWidth === 0) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const margin = { top: 20, right: 60, bottom: 30, left: 50 }
    const width = containerWidth
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    svg.attr('width', width).attr('height', height)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // X scale (time)
    const xExtent = d3.extent(chartData, d => d.timestamp)
    const xScale = d3.scaleTime()
      .domain(xExtent)
      .range([0, innerWidth])

    // Y scale for ATR (left)
    const atrMax = d3.max(chartData, d => Math.max(d.atr1m, d.atr5m)) || 100
    const yScaleAtr = d3.scaleLinear()
      .domain([0, atrMax * 1.1])
      .range([innerHeight, 0])

    // Y scale for volatility % (right)
    const volMax = d3.max(chartData, d => Math.max(d.realizedVol, d.volBaseline)) || 5
    const yScaleVol = d3.scaleLinear()
      .domain([0, volMax * 1.1])
      .range([innerHeight, 0])

    // Regime background zones
    if (regimeData.length > 0) {
      const sortedRegimes = [...regimeData].sort((a, b) => a.timestamp - b.timestamp)

      sortedRegimes.forEach((regime, i) => {
        const startX = xScale(Math.max(regime.timestamp, xExtent[0]))
        const endX = i < sortedRegimes.length - 1
          ? xScale(sortedRegimes[i + 1].timestamp)
          : innerWidth

        if (startX < innerWidth && endX > 0) {
          g.append('rect')
            .attr('x', Math.max(0, startX))
            .attr('y', 0)
            .attr('width', Math.min(innerWidth, endX) - Math.max(0, startX))
            .attr('height', innerHeight)
            .attr('fill', REGIME_COLORS[regime.mode] || 'transparent')
        }
      })
    }

    // ATR 5m area (background)
    const atr5mArea = d3.area()
      .x(d => xScale(d.timestamp))
      .y0(innerHeight)
      .y1(d => yScaleAtr(d.atr5m))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', atr5mArea)
      .attr('fill', 'rgba(139, 92, 246, 0.2)')

    // ATR 1m area (foreground)
    const atr1mArea = d3.area()
      .x(d => xScale(d.timestamp))
      .y0(innerHeight)
      .y1(d => yScaleAtr(d.atr1m))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', atr1mArea)
      .attr('fill', 'rgba(59, 130, 246, 0.3)')

    // ATR lines
    const atr1mLine = d3.line()
      .x(d => xScale(d.timestamp))
      .y(d => yScaleAtr(d.atr1m))
      .curve(d3.curveMonotoneX)

    const atr5mLine = d3.line()
      .x(d => xScale(d.timestamp))
      .y(d => yScaleAtr(d.atr5m))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', atr1mLine)
      .attr('fill', 'none')
      .attr('stroke', '#3b82f6')
      .attr('stroke-width', 2)

    g.append('path')
      .datum(chartData)
      .attr('d', atr5mLine)
      .attr('fill', 'none')
      .attr('stroke', '#8b5cf6')
      .attr('stroke-width', 2)

    // Realized volatility line (uses right Y axis)
    const volLine = d3.line()
      .x(d => xScale(d.timestamp))
      .y(d => yScaleVol(d.realizedVol))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', volLine)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')

    // Volatility baseline
    const lastPoint = chartData[chartData.length - 1]
    if (lastPoint?.volBaseline) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScaleVol(lastPoint.volBaseline))
        .attr('y2', yScaleVol(lastPoint.volBaseline))
        .attr('stroke', '#f59e0b')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,4')
        .attr('opacity', 0.5)
    }

    // X axis
    const xAxis = d3.axisBottom(xScale)
      .ticks(6)
      .tickFormat(d3.timeFormat('%H:%M'))

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(xAxis)
      .selectAll('text, line, path')
      .attr('fill', '#6b7280')
      .attr('stroke', '#6b7280')

    // Y axis left (ATR)
    const yAxisLeft = d3.axisLeft(yScaleAtr)
      .ticks(5)
      .tickFormat(d => `$${d.toFixed(0)}`)

    g.append('g')
      .call(yAxisLeft)
      .selectAll('text, line, path')
      .attr('fill', '#6b7280')
      .attr('stroke', '#6b7280')

    // Y axis right (Vol %)
    const yAxisRight = d3.axisRight(yScaleVol)
      .ticks(5)
      .tickFormat(d => `${d.toFixed(1)}%`)

    g.append('g')
      .attr('transform', `translate(${innerWidth},0)`)
      .call(yAxisRight)
      .selectAll('text, line, path')
      .attr('fill', '#f59e0b')
      .attr('stroke', '#f59e0b')

    // Legend (positioned at bottom-left with background)
    const legendItems = [
      { label: 'ATR 1m', color: '#3b82f6' },
      { label: 'ATR 5m', color: '#8b5cf6' },
      { label: 'Real Vol', color: '#f59e0b', dashed: true },
    ]

    const legend = g.append('g')
      .attr('transform', `translate(5, ${innerHeight - 50})`)

    // Legend background
    legend.append('rect')
      .attr('x', -4)
      .attr('y', -8)
      .attr('width', 75)
      .attr('height', 50)
      .attr('fill', 'rgba(31, 41, 55, 0.9)')
      .attr('rx', 4)

    legendItems.forEach((item, i) => {
      const legendItem = legend.append('g')
        .attr('transform', `translate(0, ${i * 14})`)

      legendItem.append('line')
        .attr('x1', 0)
        .attr('x2', 16)
        .attr('y1', 0)
        .attr('y2', 0)
        .attr('stroke', item.color)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', item.dashed ? '4,2' : 'none')

      legendItem.append('text')
        .attr('x', 20)
        .attr('y', 4)
        .attr('fill', '#9ca3af')
        .attr('font-size', '10px')
        .text(item.label)
    })

  }, [chartData, regimeData, height, containerWidth])

  // Handle resize
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
      setContainerWidth(containerRef.current.clientWidth)
    }

    return () => resizeObserver.disconnect()
  }, [])

  if (chartData.length < 2) {
    return (
      <div
        ref={containerRef}
        className={`flex items-center justify-center bg-gray-800 rounded-lg ${className}`}
        style={{ height }}
      >
        <span className="text-sm text-gray-500">Collecting volatility data...</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`bg-gray-800 rounded-lg p-4 ${className}`}>
      <h3 className="text-sm font-medium text-gray-400 mb-2">Volatility</h3>
      <svg ref={svgRef} className="w-full" style={{ height }} />
    </div>
  )
}

export default VolatilityChart
