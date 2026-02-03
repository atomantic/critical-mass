import { useRef, useEffect, useMemo, useId } from 'react'
import * as d3 from 'd3'

/**
 * Compact price sparkline for status bar
 * Shows last 5 minutes of price data with ATR bands overlay
 */
function MiniPriceSparkline({
  data = [],
  width = 200,
  height = 40,
  currentPrice,
  atr,
  kFactor = 0.6,
  className = '',
}) {
  const svgRef = useRef(null)
  const gradientId = useId() // Unique ID per instance to avoid gradient collisions

  // Filter to last 5 minutes of data
  const chartData = useMemo(() => {
    const cutoff = Date.now() - 5 * 60 * 1000
    return data.filter(d => d.timestamp > cutoff)
  }, [data])

  useEffect(() => {
    if (!svgRef.current || chartData.length < 2) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const margin = { top: 4, right: 4, bottom: 4, left: 4 }
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Scales
    const xScale = d3.scaleTime()
      .domain(d3.extent(chartData, d => d.timestamp))
      .range([0, innerWidth])

    const prices = chartData.map(d => d.price)
    const minPrice = d3.min(prices)
    const maxPrice = d3.max(prices)
    const padding = (maxPrice - minPrice) * 0.1 || 10

    const yScale = d3.scaleLinear()
      .domain([minPrice - padding, maxPrice + padding])
      .range([innerHeight, 0])

    // ATR bands (trigger zones)
    if (currentPrice && atr && atr > 0) {
      const triggerDistance = kFactor * atr
      const upperTrigger = currentPrice + triggerDistance
      const lowerTrigger = currentPrice - triggerDistance

      // Upper trigger zone
      g.append('rect')
        .attr('x', 0)
        .attr('y', Math.max(0, yScale(upperTrigger)))
        .attr('width', innerWidth)
        .attr('height', Math.min(innerHeight, yScale(currentPrice) - yScale(upperTrigger)))
        .attr('fill', 'rgba(34, 197, 94, 0.15)')

      // Lower trigger zone
      g.append('rect')
        .attr('x', 0)
        .attr('y', yScale(currentPrice))
        .attr('width', innerWidth)
        .attr('height', Math.min(innerHeight - yScale(currentPrice), yScale(lowerTrigger) - yScale(currentPrice)))
        .attr('fill', 'rgba(239, 68, 68, 0.15)')

      // Trigger lines
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScale(upperTrigger))
        .attr('y2', yScale(upperTrigger))
        .attr('stroke', 'rgba(34, 197, 94, 0.4)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')

      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScale(lowerTrigger))
        .attr('y2', yScale(lowerTrigger))
        .attr('stroke', 'rgba(239, 68, 68, 0.4)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')
    }

    // Price line
    const line = d3.line()
      .x(d => xScale(d.timestamp))
      .y(d => yScale(d.price))
      .curve(d3.curveMonotoneX)

    // Gradient for line (use unique ID to avoid collisions with multiple instances)
    const safeGradientId = `priceGradient-${gradientId.replace(/:/g, '')}`
    const gradient = svg.append('defs')
      .append('linearGradient')
      .attr('id', safeGradientId)
      .attr('x1', '0%')
      .attr('x2', '100%')

    gradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', '#60a5fa')
      .attr('stop-opacity', 0.5)

    gradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', '#60a5fa')
      .attr('stop-opacity', 1)

    // Area under line
    const area = d3.area()
      .x(d => xScale(d.timestamp))
      .y0(innerHeight)
      .y1(d => yScale(d.price))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', area)
      .attr('fill', 'rgba(96, 165, 250, 0.1)')

    g.append('path')
      .datum(chartData)
      .attr('d', line)
      .attr('fill', 'none')
      .attr('stroke', `url(#${safeGradientId})`)
      .attr('stroke-width', 1.5)

    // Current price dot
    const lastPoint = chartData[chartData.length - 1]
    if (lastPoint) {
      g.append('circle')
        .attr('cx', xScale(lastPoint.timestamp))
        .attr('cy', yScale(lastPoint.price))
        .attr('r', 3)
        .attr('fill', '#60a5fa')
        .attr('stroke', '#1e3a5f')
        .attr('stroke-width', 1)
    }

  }, [chartData, width, height, currentPrice, atr, kFactor, gradientId])

  if (chartData.length < 2) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-900 rounded ${className}`}
        style={{ width, height }}
      >
        <span className="text-xs text-gray-500">Collecting data...</span>
      </div>
    )
  }

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className={`bg-gray-900 rounded ${className}`}
    />
  )
}

export default MiniPriceSparkline
