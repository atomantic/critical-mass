import { useRef, useEffect } from 'react'
import * as d3 from 'd3'
import {
  formatCurrencyCompact,
  formatCurrency,
  formatAssetCompact,
  formatDate,
  getAxisFontSize,
  colors,
  colorWithOpacity,
} from './chartUtils'

export function PendingOrdersChart({
  orders,
  currentPrice,
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !orders || orders.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const containerHeight = ref.current.clientHeight
    const margin = { top: 30, right: 20, bottom: 40, left: 70 }
    const width = containerWidth - margin.left - margin.right
    const height = containerHeight - margin.top - margin.bottom
    const axisFontSize = getAxisFontSize(containerWidth)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Sort orders by sell price
    const sortedOrders = [...orders].sort((a, b) => a.sellPrice - b.sellPrice)

    // Price range (include current price)
    const allPrices = [...sortedOrders.map((o) => o.sellPrice), ...sortedOrders.map((o) => o.buyPrice), currentPrice]
    const [minPrice, maxPrice] = d3.extent(allPrices)
    const priceRange = maxPrice - minPrice
    const padding = priceRange * 0.1

    // Y scale (price)
    const y = d3
      .scaleLinear()
      .domain([minPrice - padding, maxPrice + padding])
      .nice()
      .range([height, 0])

    // X scale (order index or BTC amount)
    const x = d3
      .scaleLinear()
      .domain([0, d3.max(sortedOrders, (d) => d.sellQuantity)])
      .nice()
      .range([0, width * 0.7])

    // Draw current price line
    g.append('line')
      .attr('x1', 0)
      .attr('x2', width)
      .attr('y1', y(currentPrice))
      .attr('y2', y(currentPrice))
      .attr('stroke', colors.yellow)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5,5')

    g.append('text')
      .attr('x', width)
      .attr('y', y(currentPrice) - 5)
      .attr('text-anchor', 'end')
      .attr('fill', colors.yellow)
      .style('font-size', '11px')
      .text(`Current: ${formatCurrency(currentPrice)}`)

    // Draw order bars
    const barHeight = Math.min(20, (height - 60) / sortedOrders.length)
    const barGap = 2

    sortedOrders.forEach((order, i) => {
      const yPos = y(order.sellPrice)

      // Horizontal bar representing BTC amount
      g.append('rect')
        .attr('x', 0)
        .attr('y', yPos - barHeight / 2)
        .attr('width', x(order.sellQuantity))
        .attr('height', barHeight)
        .attr('fill', order.sellPrice <= currentPrice ? colors.green : colorWithOpacity(colors.purple, 0.7))
        .attr('rx', 2)
        .attr('stroke', order.sellPrice <= currentPrice ? colors.green : colors.purple)
        .attr('stroke-width', 1)

      // Buy price marker
      g.append('circle')
        .attr('cx', x(order.sellQuantity) + 15)
        .attr('cy', y(order.buyPrice))
        .attr('r', 4)
        .attr('fill', colors.blue)

      // Line connecting buy price to sell price
      g.append('line')
        .attr('x1', x(order.sellQuantity) + 15)
        .attr('y1', y(order.buyPrice))
        .attr('x2', x(order.sellQuantity) + 15)
        .attr('y2', yPos)
        .attr('stroke', colors.gray)
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')

      // Sell price label
      g.append('text')
        .attr('x', x(order.sellQuantity) + 25)
        .attr('y', yPos + 4)
        .attr('fill', order.sellPrice <= currentPrice ? colors.green : colors.lightGray)
        .style('font-size', axisFontSize)
        .text(formatCurrency(order.sellPrice))
    })

    // Y Axis (Price)
    g.append('g')
      .call(d3.axisLeft(y).ticks(6).tickFormat(formatCurrencyCompact))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)

    // Axis label
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -height / 2)
      .attr('y', -55)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.lightGray)
      .style('font-size', '11px')
      .text('Price')

    // Legend
    const legend = g.append('g').attr('transform', `translate(0, -20)`)

    const legendItems = [
      { color: colors.green, label: 'Ready to Fill' },
      { color: colors.purple, label: 'Waiting' },
      { color: colors.blue, label: 'Buy Price' },
      { color: colors.yellow, label: 'Current Price' },
    ]

    legendItems.forEach((item, i) => {
      const legendItem = legend.append('g').attr('transform', `translate(${i * 100}, 0)`)

      if (item.label === 'Current Price') {
        legendItem
          .append('line')
          .attr('x1', 0)
          .attr('x2', 15)
          .attr('y1', 5)
          .attr('y2', 5)
          .attr('stroke', item.color)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '3,3')
      } else {
        legendItem.append('circle').attr('r', 5).attr('cx', 7).attr('cy', 5).attr('fill', item.color)
      }

      legendItem
        .append('text')
        .attr('x', 20)
        .attr('y', 9)
        .attr('fill', colors.lightGray)
        .style('font-size', '10px')
        .text(item.label)
    })
  }, [orders, currentPrice, resize])

  if (!orders || orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No pending orders
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export function CostBasisDistributionChart({
  orders,
  currentPrice,
  resize = 0,
}) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !orders || orders.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const containerHeight = ref.current.clientHeight
    const margin = { top: 20, right: 20, bottom: 40, left: 60 }
    const width = containerWidth - margin.left - margin.right
    const height = containerHeight - margin.top - margin.bottom
    const axisFontSize = getAxisFontSize(containerWidth)

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Create histogram bins based on buy price
    const buyPrices = orders.map((o) => o.buyPrice)
    const [minPrice, maxPrice] = d3.extent(buyPrices)
    const binCount = Math.min(20, orders.length)

    const histogram = d3
      .bin()
      .domain([minPrice, maxPrice])
      .thresholds(binCount)

    const bins = histogram(buyPrices)

    // X scale (price ranges)
    const x = d3
      .scaleLinear()
      .domain([minPrice, maxPrice])
      .nice()
      .range([0, width])

    // Y scale (count)
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(bins, (d) => d.length)])
      .nice()
      .range([height, 0])

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
    g.selectAll('.bar')
      .data(bins)
      .enter()
      .append('rect')
      .attr('class', 'bar')
      .attr('x', (d) => x(d.x0) + 1)
      .attr('y', (d) => y(d.length))
      .attr('width', (d) => Math.max(0, x(d.x1) - x(d.x0) - 2))
      .attr('height', (d) => height - y(d.length))
      .attr('fill', (d) => {
        const midPrice = (d.x0 + d.x1) / 2
        return midPrice < currentPrice ? colors.green : colors.blue
      })
      .attr('rx', 2)

    // Current price line
    if (currentPrice >= minPrice && currentPrice <= maxPrice) {
      g.append('line')
        .attr('x1', x(currentPrice))
        .attr('x2', x(currentPrice))
        .attr('y1', 0)
        .attr('y2', height)
        .attr('stroke', colors.yellow)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '5,5')

      g.append('text')
        .attr('x', x(currentPrice))
        .attr('y', -5)
        .attr('text-anchor', 'middle')
        .attr('fill', colors.yellow)
        .style('font-size', '10px')
        .text('Current')
    }

    // X Axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(formatCurrencyCompact))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    g.selectAll('.domain').attr('stroke', colors.darkGray)
    g.selectAll('.tick line').attr('stroke', colors.darkGray)

    // Y Axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5))
      .selectAll('text')
      .attr('fill', colors.lightGray)
      .style('font-size', axisFontSize)

    // Axis labels
    g.append('text')
      .attr('x', width / 2)
      .attr('y', height + 35)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.lightGray)
      .style('font-size', '11px')
      .text('Buy Price')

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -height / 2)
      .attr('y', -45)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.lightGray)
      .style('font-size', '11px')
      .text('Order Count')
  }, [orders, currentPrice, resize])

  if (!orders || orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No orders for distribution
      </div>
    )
  }

  return <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }} />
}

export default PendingOrdersChart
