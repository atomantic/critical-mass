import { useRef, useEffect } from 'react'
import * as d3 from 'd3'
import {
  formatCurrencyCompact,
  formatCurrency,
  formatDateTimeFull,
  getResponsiveMargin,
  getAxisFontSize,
  getSmartDateFormatter,
  getSmartTickCount,
  colors,
  colorWithOpacity,
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
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !data || data.length < 2) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const containerHeight = ref.current.clientHeight
    const margin = getResponsiveMargin(containerWidth)
    const width = containerWidth - margin.left - margin.right
    const height = containerHeight - margin.top - margin.bottom
    const axisFontSize = getAxisFontSize(containerWidth)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Parse dates if needed
    const parsedData = data.map((d) => ({
      ...d,
      parsedDate: d[dateKey] instanceof Date ? d[dateKey] : new Date(d[dateKey]),
    }))

    // Scales
    const [minDate, maxDate] = d3.extent(parsedData, (d) => d.parsedDate)
    const timeSpanMs = maxDate - minDate

    const x = d3
      .scaleTime()
      .domain([minDate, maxDate])
      .range([0, width])

    // Smart formatting based on time span
    const dateFormatter = getSmartDateFormatter(minDate, maxDate)
    const tickCount = getSmartTickCount(timeSpanMs, containerWidth)

    const yExtent = d3.extent(parsedData, (d) => d[valueKey])
    const yMin = Math.min(0, yExtent[0])
    const yMax = yExtent[1] * 1.1
    const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([height, 0])

    // Clip path for chart area
    const clipId = `clip-area-${title?.replace(/\s+/g, '-') || 'chart'}-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // Gridlines
    g.append('g')
      .attr('class', 'grid')
      .selectAll('line')
      .data(y.ticks(5))
      .enter()
      .append('line')
      .attr('x1', 0)
      .attr('x2', width)
      .attr('y1', (d) => y(d))
      .attr('y2', (d) => y(d))
      .attr('stroke', colors.gridLine)
      .attr('stroke-dasharray', '3,3')
      .attr('stroke-opacity', 0.5)

    // Area generator
    const area = d3
      .area()
      .x((d) => x(d.parsedDate))
      .y0(height)
      .y1((d) => y(d[valueKey]))
      .curve(d3.curveMonotoneX)

    // Line generator
    const line = d3
      .line()
      .x((d) => x(d.parsedDate))
      .y((d) => y(d[valueKey]))
      .curve(d3.curveMonotoneX)

    // Draw area
    g.append('path')
      .datum(parsedData)
      .attr('clip-path', `url(#${clipId})`)
      .attr('fill', colorWithOpacity(color, 0.3))
      .attr('d', area)

    // Draw line
    g.append('path')
      .datum(parsedData)
      .attr('clip-path', `url(#${clipId})`)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('d', line)

    // X Axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(tickCount)
          .tickFormat(dateFormatter)
      )
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)

    // Y Axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(formatValue))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    // Interactive hover elements
    if (showTooltip) {
      const bisect = d3.bisector((d) => d.parsedDate).left

      const focus = g.append('g').attr('class', 'focus').style('display', 'none')

      focus
        .append('line')
        .attr('class', 'hover-line')
        .attr('y1', 0)
        .attr('y2', height)
        .attr('stroke', colors.lightGray)
        .attr('stroke-dasharray', '3,3')

      focus.append('circle').attr('r', 5).attr('fill', color).attr('stroke', 'white').attr('stroke-width', 2)

      const tooltip = focus.append('g').attr('class', 'tooltip-group')

      tooltip
        .append('rect')
        .attr('class', 'tooltip-bg')
        .attr('fill', colors.darkBg)
        .attr('stroke', colors.darkGray)
        .attr('rx', 4)

      tooltip.append('text').attr('class', 'tooltip-date').attr('fill', colors.lightGray).style('font-size', '10px')

      tooltip.append('text').attr('class', 'tooltip-value').attr('fill', color).style('font-size', '12px').attr('font-weight', 'bold')

      // Invisible overlay for mouse events
      g.append('rect')
        .attr('class', 'overlay')
        .attr('width', width)
        .attr('height', height)
        .attr('fill', 'none')
        .attr('pointer-events', 'all')
        .on('mouseover', () => focus.style('display', null))
        .on('mouseout', () => focus.style('display', 'none'))
        .on('mousemove', function (event) {
          const [mouseX] = d3.pointer(event)
          const x0 = x.invert(mouseX)
          const i = bisect(parsedData, x0, 1)
          const d0 = parsedData[i - 1]
          const d1 = parsedData[i]

          if (!d0) return
          const d = d1 && x0.getTime() - d0.parsedDate.getTime() > d1.parsedDate.getTime() - x0.getTime() ? d1 : d0

          const xPos = x(d.parsedDate)
          const yPos = y(d[valueKey])

          focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)

          focus.select('circle').attr('cx', xPos).attr('cy', yPos)

          // Position tooltip
          const tooltipX = xPos > width / 2 ? xPos - 110 : xPos + 10
          const tooltipY = yPos < 40 ? yPos + 10 : yPos - 45

          tooltip.attr('transform', `translate(${tooltipX},${tooltipY})`)
          tooltip.select('.tooltip-date').text(formatDateTimeFull(d.parsedDate)).attr('x', 8).attr('y', 16)
          tooltip.select('.tooltip-value').text(formatTooltip(d[valueKey])).attr('x', 8).attr('y', 32)
          tooltip.select('.tooltip-bg').attr('width', 140).attr('height', 40)
        })
    }
  }, [data, title, valueKey, dateKey, color, formatValue, formatTooltip, showTooltip, resize])

  if (!data || data.length < 2) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Not enough data for chart
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export function StackedAreaChart({
  data,
  title,
  dateKey = 'date',
  series,
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !data || data.length < 2 || !series?.length) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const containerHeight = ref.current.clientHeight
    const margin = getResponsiveMargin(containerWidth)
    const width = containerWidth - margin.left - margin.right
    const height = containerHeight - margin.top - margin.bottom
    const axisFontSize = getAxisFontSize(containerWidth)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Parse dates
    const parsedData = data.map((d) => ({
      ...d,
      parsedDate: d[dateKey] instanceof Date ? d[dateKey] : new Date(d[dateKey]),
    }))

    // Create stack
    const stackKeys = series.map((s) => s.key)
    const stack = d3.stack().keys(stackKeys).order(d3.stackOrderNone).offset(d3.stackOffsetNone)
    const stackedData = stack(parsedData)

    // Scales
    const [minDate, maxDate] = d3.extent(parsedData, (d) => d.parsedDate)
    const timeSpanMs = maxDate - minDate

    const x = d3
      .scaleTime()
      .domain([minDate, maxDate])
      .range([0, width])

    // Smart formatting based on time span
    const dateFormatter = getSmartDateFormatter(minDate, maxDate)
    const tickCount = getSmartTickCount(timeSpanMs, containerWidth)

    const yMax = d3.max(stackedData, (layer) => d3.max(layer, (d) => d[1]))
    const y = d3.scaleLinear().domain([0, yMax * 1.1]).nice().range([height, 0])

    // Clip path
    const clipId = `clip-stacked-${title?.replace(/\s+/g, '-') || 'chart'}-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // Area generator
    const area = d3
      .area()
      .x((d) => x(d.data.parsedDate))
      .y0((d) => y(d[0]))
      .y1((d) => y(d[1]))
      .curve(d3.curveMonotoneX)

    // Draw stacked areas
    g.selectAll('.area')
      .data(stackedData)
      .enter()
      .append('path')
      .attr('clip-path', `url(#${clipId})`)
      .attr('fill', (d, i) => colorWithOpacity(series[i].color, 0.7))
      .attr('stroke', (d, i) => series[i].color)
      .attr('stroke-width', 1)
      .attr('d', area)

    // Axes
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(tickCount)
          .tickFormat(dateFormatter)
      )
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)

    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(formatCurrencyCompact))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    // Legend
    const legend = g
      .append('g')
      .attr('class', 'legend')
      .attr('transform', `translate(${width - 100}, 10)`)

    series.forEach((s, i) => {
      const legendItem = legend.append('g').attr('transform', `translate(0, ${i * 18})`)

      legendItem.append('rect').attr('width', 12).attr('height', 12).attr('fill', s.color).attr('rx', 2)

      legendItem
        .append('text')
        .attr('x', 18)
        .attr('y', 10)
        .attr('fill', colors.lightGray)
        .style('font-size', '10px')
        .text(s.label)
    })
  }, [data, title, dateKey, series, resize])

  if (!data || data.length < 2) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Not enough data for chart
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export default AreaChart
