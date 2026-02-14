import { useRef, useEffect, useMemo, useState } from 'react'
import * as d3 from 'd3'
import { formatPriceCompact } from './chartUtils'

// Regime colors for background zones
const REGIME_COLORS = {
  HARVEST: 'rgba(34, 197, 94, 0.08)',
  CAUTION: 'rgba(234, 179, 8, 0.08)',
  TREND: 'rgba(239, 68, 68, 0.08)',
}

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
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // Filter to last 1 hour
  const chartData = useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000
    return priceData.filter(d => d.timestamp > cutoff)
  }, [priceData])

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || chartData.length < 2 || containerWidth === 0) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const margin = { top: 20, right: 60, bottom: 30, left: 60 }
    const width = containerWidth
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    svg.attr('width', width).attr('height', height)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Scales
    const xExtent = d3.extent(chartData, d => d.timestamp)
    const xScale = d3.scaleTime()
      .domain(xExtent)
      .range([0, innerWidth])

    const prices = chartData.map(d => d.price)
    const minPrice = d3.min(prices)
    const maxPrice = d3.max(prices)
    const padding = (maxPrice - minPrice) * 0.15 || 50

    const yScale = d3.scaleLinear()
      .domain([minPrice - padding, maxPrice + padding])
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

    // ATR trigger bands (if we have anchor and ATR)
    if (anchorPrice && atr && atr > 0) {
      const triggerDistance = kFactor * atr
      const upperTrigger = anchorPrice + triggerDistance
      const lowerTrigger = anchorPrice - triggerDistance

      // Upper trigger zone
      g.append('rect')
        .attr('x', 0)
        .attr('y', yScale(upperTrigger + triggerDistance * 0.5))
        .attr('width', innerWidth)
        .attr('height', yScale(upperTrigger) - yScale(upperTrigger + triggerDistance * 0.5))
        .attr('fill', 'rgba(34, 197, 94, 0.1)')

      // Lower trigger zone
      g.append('rect')
        .attr('x', 0)
        .attr('y', yScale(lowerTrigger))
        .attr('width', innerWidth)
        .attr('height', yScale(lowerTrigger - triggerDistance * 0.5) - yScale(lowerTrigger))
        .attr('fill', 'rgba(239, 68, 68, 0.1)')

      // Anchor price line
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScale(anchorPrice))
        .attr('y2', yScale(anchorPrice))
        .attr('stroke', '#60a5fa')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,4')

      // Upper trigger line
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScale(upperTrigger))
        .attr('y2', yScale(upperTrigger))
        .attr('stroke', '#22c55e')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')

      // Lower trigger line
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScale(lowerTrigger))
        .attr('y2', yScale(lowerTrigger))
        .attr('stroke', '#ef4444')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')

      // Labels
      const anchorLabel = g.append('text')
        .attr('x', innerWidth - 5)
        .attr('y', yScale(anchorPrice) - 4)
        .attr('text-anchor', 'end')
        .attr('fill', '#60a5fa')
        .attr('font-size', '9px')
        .attr('cursor', 'help')
        .text(`Anchor ${formatPriceCompact(anchorPrice)}`)
      anchorLabel.append('title')
        .text('Anchor price: the reference price used to calculate ATR trigger bands')

      const upperLabel = g.append('text')
        .attr('x', innerWidth - 5)
        .attr('y', yScale(upperTrigger) - 4)
        .attr('text-anchor', 'end')
        .attr('fill', '#22c55e')
        .attr('font-size', '9px')
        .attr('cursor', 'help')
        .text(`+${kFactor}x ATR`)
      upperLabel.append('title')
        .text(`Upper trigger: ${formatPriceCompact(upperTrigger)} — price ${kFactor}× ATR above anchor signals bullish momentum`)

      const lowerLabel = g.append('text')
        .attr('x', innerWidth - 5)
        .attr('y', yScale(lowerTrigger) + 12)
        .attr('text-anchor', 'end')
        .attr('fill', '#ef4444')
        .attr('font-size', '9px')
        .attr('cursor', 'help')
        .text(`-${kFactor}x ATR`)
      lowerLabel.append('title')
        .text(`Lower trigger: ${formatPriceCompact(lowerTrigger)} — price ${kFactor}× ATR below anchor signals bearish pressure`)
    }

    // Price area
    const area = d3.area()
      .x(d => xScale(d.timestamp))
      .y0(innerHeight)
      .y1(d => yScale(d.price))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', area)
      .attr('fill', 'rgba(96, 165, 250, 0.1)')

    // Price line
    const line = d3.line()
      .x(d => xScale(d.timestamp))
      .y(d => yScale(d.price))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(chartData)
      .attr('d', line)
      .attr('fill', 'none')
      .attr('stroke', '#60a5fa')
      .attr('stroke-width', 2)

    // Current price dot and label
    const lastPoint = chartData[chartData.length - 1]
    if (lastPoint) {
      g.append('circle')
        .attr('cx', xScale(lastPoint.timestamp))
        .attr('cy', yScale(lastPoint.price))
        .attr('r', 4)
        .attr('fill', '#60a5fa')
        .attr('stroke', '#1e3a5f')
        .attr('stroke-width', 2)

      // Current price line extending to Y axis
      g.append('line')
        .attr('x1', xScale(lastPoint.timestamp))
        .attr('x2', innerWidth)
        .attr('y1', yScale(lastPoint.price))
        .attr('y2', yScale(lastPoint.price))
        .attr('stroke', '#60a5fa')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')
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

    // Y axis
    const yAxis = d3.axisLeft(yScale)
      .ticks(6)
      .tickFormat(d => formatPriceCompact(d))

    g.append('g')
      .call(yAxis)
      .selectAll('text, line, path')
      .attr('fill', '#6b7280')
      .attr('stroke', '#6b7280')

    // Right Y axis (current price)
    const yAxisRight = d3.axisRight(yScale)
      .tickValues([lastPoint?.price || currentPrice].filter(Boolean))
      .tickFormat(d => formatPriceCompact(d))

    g.append('g')
      .attr('transform', `translate(${innerWidth},0)`)
      .call(yAxisRight)
      .selectAll('text')
      .attr('fill', '#60a5fa')
      .attr('font-weight', '600')

    g.selectAll('g:last-child line, g:last-child path')
      .attr('stroke', '#60a5fa')

  }, [chartData, regimeData, height, anchorPrice, atr, kFactor, currentPrice, containerWidth])

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
        <span className="text-sm text-gray-500">Collecting price data...</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`bg-gray-800 rounded-lg p-4 ${className}`}>
      <h3 className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-1.5">
        Price & ATR Triggers
        <span className="relative group cursor-help">
          <svg className="w-3.5 h-3.5 text-gray-500 group-hover:text-gray-300 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 border border-gray-700 text-xs text-gray-300 rounded-lg shadow-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
            <strong className="text-gray-100">ATR</strong> (Average True Range) measures market volatility.
            <br />Trigger lines at ±{kFactor}× ATR from anchor price signal regime shifts.
          </span>
        </span>
      </h3>
      <svg ref={svgRef} className="w-full" style={{ height: height - 40 }} />
    </div>
  )
}

export default RegimePriceChart
