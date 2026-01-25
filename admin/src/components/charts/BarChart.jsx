import { useRef, useEffect } from 'react'
import * as d3 from 'd3'
import {
  formatCurrencyCompact,
  formatCurrency,
  formatDateTimeFull,
  getResponsiveMargin,
  getAxisFontSize,
  getSmartDateFormatter,
  colors,
  colorWithOpacity,
} from './chartUtils'

export function BarChart({
  data,
  title,
  dateKey = 'date',
  series,
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !data || data.length === 0 || !series?.length) return

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

    // Parse dates and get time span for formatting
    const parsedData = data.map((d) => ({
      ...d,
      parsedDate: d[dateKey] instanceof Date ? d[dateKey] : new Date(d[dateKey]),
    }))

    const dates = parsedData.map((d) => d.parsedDate)
    const [minDate, maxDate] = [Math.min(...dates), Math.max(...dates)]
    const dateFormatter = getSmartDateFormatter(minDate, maxDate)

    // X scale for dates (band scale)
    const x0 = d3
      .scaleBand()
      .domain(data.map((d) => d[dateKey]))
      .range([0, width])
      .padding(0.2)

    // X scale for grouped bars within each date
    const x1 = d3
      .scaleBand()
      .domain(series.map((s) => s.key))
      .range([0, x0.bandwidth()])
      .padding(0.05)

    // Y scale
    const maxValue = d3.max(data, (d) =>
      d3.max(series, (s) => d[s.key] || 0)
    )
    const y = d3.scaleLinear().domain([0, maxValue * 1.1]).nice().range([height, 0])

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

    // Draw bars
    const barGroups = g
      .selectAll('.bar-group')
      .data(data)
      .enter()
      .append('g')
      .attr('class', 'bar-group')
      .attr('transform', (d) => `translate(${x0(d[dateKey])},0)`)

    series.forEach((s, i) => {
      barGroups
        .append('rect')
        .attr('x', x1(s.key))
        .attr('y', (d) => y(d[s.key] || 0))
        .attr('width', x1.bandwidth())
        .attr('height', (d) => height - y(d[s.key] || 0))
        .attr('fill', s.color)
        .attr('rx', 2)
    })

    // X Axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x0).tickFormat((d) => dateFormatter(new Date(d))))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)
      .attr('transform', 'rotate(-45)')
      .attr('text-anchor', 'end')

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)

    // Y Axis
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

    // Tooltip on hover
    const tooltip = d3
      .select('body')
      .append('div')
      .attr('class', 'd3-tooltip')
      .style('position', 'absolute')
      .style('background', colors.darkBg)
      .style('border', `1px solid ${colors.darkGray}`)
      .style('border-radius', '4px')
      .style('padding', '8px 12px')
      .style('font-size', '12px')
      .style('color', colors.lightGray)
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('z-index', 1000)

    barGroups
      .selectAll('rect')
      .on('mouseover', function (event, d) {
        const seriesItem = series[Array.from(this.parentNode.querySelectorAll('rect')).indexOf(this)]
        tooltip
          .style('opacity', 1)
          .html(
            `<div style="color: ${seriesItem.color}; font-weight: bold;">${seriesItem.label}</div>
             <div>${formatDateTimeFull(new Date(d[dateKey]))}</div>
             <div>${formatCurrency(d[seriesItem.key] || 0)}</div>`
          )
      })
      .on('mousemove', function (event) {
        tooltip.style('left', event.pageX + 10 + 'px').style('top', event.pageY - 28 + 'px')
      })
      .on('mouseout', function () {
        tooltip.style('opacity', 0)
      })

    return () => {
      tooltip.remove()
    }
  }, [data, title, dateKey, series, resize])

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No data available
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export function HorizontalBarChart({
  data,
  title,
  labelKey = 'label',
  valueKey = 'value',
  color = colors.blue,
  formatValue = formatCurrencyCompact,
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !data || data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const containerHeight = ref.current.clientHeight
    const margin = { top: 10, right: 60, bottom: 20, left: 80 }
    const width = containerWidth - margin.left - margin.right
    const height = containerHeight - margin.top - margin.bottom
    const axisFontSize = getAxisFontSize(containerWidth)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Y scale (categories)
    const y = d3
      .scaleBand()
      .domain(data.map((d) => d[labelKey]))
      .range([0, height])
      .padding(0.2)

    // X scale (values)
    const maxValue = d3.max(data, (d) => d[valueKey])
    const x = d3.scaleLinear().domain([0, maxValue * 1.1]).nice().range([0, width])

    // Draw bars
    g.selectAll('.bar')
      .data(data)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('y', (d) => y(d[labelKey]))
      .attr('x', 0)
      .attr('height', y.bandwidth())
      .attr('width', (d) => x(d[valueKey]))
      .attr('fill', color)
      .attr('rx', 3)

    // Value labels
    g.selectAll('.value-label')
      .data(data)
      .enter()
      .append('text')
      .attr('class', 'value-label')
      .attr('y', (d) => y(d[labelKey]) + y.bandwidth() / 2)
      .attr('x', (d) => x(d[valueKey]) + 5)
      .attr('dy', '0.35em')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)
      .text((d) => formatValue(d[valueKey]))

    // Y Axis
    g.append('g')
      .call(d3.axisLeft(y))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)
  }, [data, title, labelKey, valueKey, color, formatValue, resize])

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No data available
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export default BarChart
