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
} from './chartUtils'

export function PriceChart({
  priceData,
  buyData,
  sellData,
  avgCostBasis,
  title = 'Price History',
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !priceData || priceData.length < 1) return

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

    // Parse dates and add index
    const parsedPriceData = priceData.map((d, i) => ({
      ...d,
      index: i,
      parsedDate: d.date instanceof Date ? d.date : new Date(d.date),
    }))

    const parsedBuyData = (buyData || []).map((d, i) => ({
      ...d,
      index: i,
      parsedDate: d.date instanceof Date ? d.date : new Date(d.date),
    }))

    // Check if all dates are the same (or very close) - use index-based scale
    const [minDate, maxDate] = d3.extent(parsedPriceData, (d) => d.parsedDate)
    const timeSpanMs = maxDate - minDate
    const useIndexScale = timeSpanMs < 60000 // Less than 1 minute span = use index

    // X Scale - either time-based or index-based
    let x, xAxisGenerator, getX

    if (useIndexScale) {
      // Use index-based scale when all dates are the same
      x = d3
        .scaleLinear()
        .domain([0, parsedPriceData.length - 1])
        .range([0, width])

      getX = (d) => x(d.index)

      xAxisGenerator = d3
        .axisBottom(x)
        .ticks(Math.min(parsedPriceData.length, 8))
        .tickFormat((d) => `#${d + 1}`)
    } else {
      // Use time-based scale
      x = d3
        .scaleTime()
        .domain([minDate, maxDate])
        .range([0, width])

      getX = (d) => x(d.parsedDate)

      const dateFormatter = getSmartDateFormatter(minDate, maxDate)
      const tickCount = getSmartTickCount(timeSpanMs, containerWidth)

      xAxisGenerator = d3
        .axisBottom(x)
        .ticks(tickCount)
        .tickFormat(dateFormatter)
    }

    // Parse sell data if provided
    const parsedSellData = (sellData || []).map((d, i) => ({
      ...d,
      index: i,
      parsedDate: d.date instanceof Date ? d.date : new Date(d.date),
    }))

    // Y Scale - include sell prices in range
    const [minPrice, maxPrice] = d3.extent(parsedPriceData, (d) => d.price)
    const sellPrices = parsedSellData.map((d) => d.sellPrice).filter(Boolean)
    const allMaxPrice = sellPrices.length > 0 ? Math.max(maxPrice, ...sellPrices) : maxPrice
    const pricePadding = (allMaxPrice - minPrice) * 0.1 || allMaxPrice * 0.05
    const y = d3
      .scaleLinear()
      .domain([minPrice - pricePadding, allMaxPrice + pricePadding])
      .nice()
      .range([height, 0])

    // Clip path
    const clipId = `clip-price-${Date.now()}`
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

    // Line generator
    const line = d3
      .line()
      .x((d) => getX(d))
      .y((d) => y(d.price))
      .curve(d3.curveMonotoneX)

    // Draw price line
    g.append('path')
      .datum(parsedPriceData)
      .attr('clip-path', `url(#${clipId})`)
      .attr('fill', 'none')
      .attr('stroke', colors.yellow)
      .attr('stroke-width', 2)
      .attr('d', line)

    // Draw buy markers - match by index when using index scale
    if (parsedBuyData.length > 0) {
      g.selectAll('.buy-marker')
        .data(parsedBuyData)
        .enter()
        .append('circle')
        .attr('class', 'buy-marker')
        .attr('cx', (d) => getX(d))
        .attr('cy', (d) => y(d.price))
        .attr('r', 5)
        .attr('fill', colors.blue)
        .attr('stroke', 'white')
        .attr('stroke-width', 2)
    }

    // Draw sell price markers (triangles pointing up)
    if (parsedSellData.length > 0) {
      const triangleSize = 6
      g.selectAll('.sell-marker')
        .data(parsedSellData)
        .enter()
        .append('path')
        .attr('class', 'sell-marker')
        .attr('d', d3.symbol().type(d3.symbolTriangle).size(triangleSize * triangleSize * 2))
        .attr('transform', (d) => `translate(${getX(d)},${y(d.sellPrice)})`)
        .attr('fill', colors.green)
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)

      // Draw dashed lines connecting buy to sell
      g.selectAll('.buy-sell-line')
        .data(parsedSellData)
        .enter()
        .append('line')
        .attr('class', 'buy-sell-line')
        .attr('x1', (d) => getX(d))
        .attr('y1', (d) => y(d.price))
        .attr('x2', (d) => getX(d))
        .attr('y2', (d) => y(d.sellPrice))
        .attr('stroke', colors.green)
        .attr('stroke-dasharray', '2,2')
        .attr('stroke-opacity', 0.5)
    }

    // Draw average cost basis line
    if (avgCostBasis && avgCostBasis > 0) {
      g.append('line')
        .attr('class', 'cost-basis-line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(avgCostBasis))
        .attr('y2', y(avgCostBasis))
        .attr('stroke', colors.purple)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '6,3')

      // Label for cost basis
      g.append('text')
        .attr('x', width - 5)
        .attr('y', y(avgCostBasis) - 5)
        .attr('text-anchor', 'end')
        .attr('fill', colors.purple)
        .style('font-size', '10px')
        .style('font-weight', 'bold')
        .text(`Avg Cost: ${formatCurrencyCompact(avgCostBasis)}`)
    }

    // X Axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(xAxisGenerator)
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)

    // Y Axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(formatCurrencyCompact))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    // Interactive hover
    const focus = g.append('g').attr('class', 'focus').style('display', 'none')

    focus
      .append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', colors.lightGray)
      .attr('stroke-dasharray', '3,3')

    focus
      .append('circle')
      .attr('r', 5)
      .attr('fill', colors.yellow)
      .attr('stroke', 'white')
      .attr('stroke-width', 2)

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

    tooltip
      .append('text')
      .attr('class', 'tooltip-price')
      .attr('fill', colors.yellow)
      .style('font-size', '12px')
      .attr('font-weight', 'bold')

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

        // Find nearest data point
        let nearestIdx = 0
        let minDist = Infinity
        parsedPriceData.forEach((d, i) => {
          const dist = Math.abs(getX(d) - mouseX)
          if (dist < minDist) {
            minDist = dist
            nearestIdx = i
          }
        })

        const d = parsedPriceData[nearestIdx]
        if (!d) return

        const xPos = getX(d)
        const yPos = y(d.price)

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)
        focus.select('circle').attr('cx', xPos).attr('cy', yPos)

        const tooltipX = xPos > width / 2 ? xPos - 120 : xPos + 10
        const tooltipY = yPos < 40 ? yPos + 10 : yPos - 45

        const label = useIndexScale ? `Trade #${d.index + 1}` : formatDateTimeFull(d.parsedDate)

        tooltip.attr('transform', `translate(${tooltipX},${tooltipY})`)
        tooltip.select('.tooltip-date').text(label).attr('x', 8).attr('y', 16)
        tooltip.select('.tooltip-price').text(formatCurrency(d.price)).attr('x', 8).attr('y', 32)
        tooltip.select('.tooltip-bg').attr('width', 110).attr('height', 40)
      })

    // Legend
    const legend = g
      .append('g')
      .attr('class', 'legend')
      .attr('transform', `translate(10, 10)`)

    const legendItems = [
      { color: colors.yellow, label: 'Price', shape: 'circle' },
      { color: colors.blue, label: 'Buy', shape: 'circle' },
      { color: colors.green, label: 'Sell', shape: 'triangle' },
      { color: colors.purple, label: 'Cost Basis', shape: 'line' },
    ]

    legendItems.forEach((item, i) => {
      const legendItem = legend.append('g').attr('transform', `translate(${i * 70}, 0)`)

      if (item.shape === 'triangle') {
        legendItem
          .append('path')
          .attr('d', d3.symbol().type(d3.symbolTriangle).size(40))
          .attr('transform', 'translate(5, 5)')
          .attr('fill', item.color)
      } else if (item.shape === 'line') {
        legendItem
          .append('line')
          .attr('x1', 0)
          .attr('y1', 5)
          .attr('x2', 10)
          .attr('y2', 5)
          .attr('stroke', item.color)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '4,2')
      } else {
        legendItem.append('circle').attr('r', 5).attr('cx', 5).attr('cy', 5).attr('fill', item.color)
      }

      legendItem
        .append('text')
        .attr('x', 15)
        .attr('y', 9)
        .attr('fill', colors.lightGray)
        .style('font-size', '10px')
        .text(item.label)
    })
  }, [priceData, buyData, sellData, avgCostBasis, title, resize])

  if (!priceData || priceData.length < 1) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Not enough price data
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export default PriceChart
