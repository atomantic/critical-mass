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

export function ComposedChart({
  data,
  title,
  dateKey = 'date',
  areas = [],
  lines = [],
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

    // Parse dates
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

    // Find y extent from all series
    const allKeys = [...areas.map((a) => a.key), ...lines.map((l) => l.key)]
    const allValues = parsedData.flatMap((d) => allKeys.map((k) => d[k] || 0))
    const [yMin, yMax] = d3.extent(allValues)
    const yPadding = (yMax - yMin) * 0.1

    const y = d3
      .scaleLinear()
      .domain([Math.min(0, yMin - yPadding), yMax + yPadding])
      .nice()
      .range([height, 0])

    // Clip path
    const clipId = `clip-composed-${title?.replace(/\s+/g, '-') || 'chart'}-${Date.now()}`
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

    // Draw areas
    areas.forEach((areaConfig) => {
      const area = d3
        .area()
        .x((d) => x(d.parsedDate))
        .y0(y(0))
        .y1((d) => y(d[areaConfig.key] || 0))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(parsedData)
        .attr('clip-path', `url(#${clipId})`)
        .attr('fill', colorWithOpacity(areaConfig.color, 0.3))
        .attr('stroke', areaConfig.color)
        .attr('stroke-width', 1)
        .attr('d', area)
    })

    // Draw lines
    lines.forEach((lineConfig) => {
      const line = d3
        .line()
        .x((d) => x(d.parsedDate))
        .y((d) => y(d[lineConfig.key] || 0))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(parsedData)
        .attr('clip-path', `url(#${clipId})`)
        .attr('fill', 'none')
        .attr('stroke', lineConfig.color)
        .attr('stroke-width', lineConfig.strokeWidth || 2)
        .attr('stroke-dasharray', lineConfig.dashed ? '5,3' : null)
        .attr('d', line)
    })

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
    const allSeries = [...areas, ...lines]
    const legend = g
      .append('g')
      .attr('class', 'legend')
      .attr('transform', `translate(10, 10)`)

    allSeries.forEach((s, i) => {
      const legendItem = legend.append('g').attr('transform', `translate(${i * 90}, 0)`)

      if (lines.includes(s)) {
        legendItem
          .append('line')
          .attr('x1', 0)
          .attr('x2', 15)
          .attr('y1', 5)
          .attr('y2', 5)
          .attr('stroke', s.color)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', s.dashed ? '3,2' : null)
      } else {
        legendItem
          .append('rect')
          .attr('width', 12)
          .attr('height', 12)
          .attr('fill', colorWithOpacity(s.color, 0.5))
          .attr('stroke', s.color)
          .attr('rx', 2)
      }

      legendItem
        .append('text')
        .attr('x', 20)
        .attr('y', 10)
        .attr('fill', colors.lightGray)
        .style('font-size', '10px')
        .text(s.label)
    })

    // Interactive hover
    const bisect = d3.bisector((d) => d.parsedDate).left

    const focus = g.append('g').attr('class', 'focus').style('display', 'none')

    focus
      .append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', colors.lightGray)
      .attr('stroke-dasharray', '3,3')

    // Tooltip
    const tooltip = focus.append('g').attr('class', 'tooltip-group')

    tooltip
      .append('rect')
      .attr('class', 'tooltip-bg')
      .attr('fill', colors.darkBg)
      .attr('stroke', colors.darkGray)
      .attr('rx', 4)

    tooltip
      .append('text')
      .attr('class', 'tooltip-date')
      .attr('fill', colors.lightGray)
      .style('font-size', '10px')

    allSeries.forEach((s, i) => {
      tooltip
        .append('text')
        .attr('class', `tooltip-value-${i}`)
        .attr('fill', s.color)
        .style('font-size', '11px')
    })

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
        const d =
          d1 && x0.getTime() - d0.parsedDate.getTime() > d1.parsedDate.getTime() - x0.getTime() ? d1 : d0

        const xPos = x(d.parsedDate)

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)

        const tooltipX = xPos > width / 2 ? xPos - 130 : xPos + 10
        const tooltipHeight = 20 + allSeries.length * 16

        tooltip.attr('transform', `translate(${tooltipX}, 20)`)
        tooltip.select('.tooltip-date').text(formatDateTimeFull(d.parsedDate)).attr('x', 8).attr('y', 16)

        allSeries.forEach((s, idx) => {
          tooltip
            .select(`.tooltip-value-${idx}`)
            .text(`${s.label}: ${formatCurrency(d[s.key] || 0)}`)
            .attr('x', 8)
            .attr('y', 32 + idx * 16)
        })

        tooltip.select('.tooltip-bg').attr('width', 120).attr('height', tooltipHeight)
      })
  }, [data, title, dateKey, areas, lines, resize])

  if (!data || data.length < 2) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Not enough data for chart
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export default ComposedChart
