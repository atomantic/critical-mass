import { useMemo } from 'react'
import { extent, histogram, linearScale, max } from '../../lib/chart-math'
import { Axis } from './primitives/Axis'
import { Grid } from './primitives/Grid'
import { useElementSize } from './primitives/Responsive'
import {
  formatCurrencyCompact,
  formatCurrency,
  getAxisFontSize,
  colors,
  DASHED_GRID,
  colorWithOpacity,
} from './chartUtils'

const PENDING_LEGEND = [
  { color: colors.green, label: 'Ready to Fill' },
  { color: colors.purple, label: 'Waiting' },
  { color: colors.blue, label: 'Buy Price' },
  { color: colors.yellow, label: 'Current Price' },
]

export function PendingOrdersChart({
  orders,
  currentPrice,
}) {
  const [ref, size] = useElementSize()
  const hasData = orders?.length > 0

  const chart = useMemo(() => {
    if (!hasData || !size.width) return null
    const margin = { top: 30, right: 20, bottom: 40, left: 70 }
    const width = size.width - margin.left - margin.right
    const height = size.height - margin.top - margin.bottom
    const sortedOrders = [...orders].sort((a, b) => a.sellPrice - b.sellPrice)

    // Price range covers every sell and buy price plus the current price.
    const [minPrice, maxPrice] = extent([...sortedOrders.map((o) => o.sellPrice), ...sortedOrders.map((o) => o.buyPrice), currentPrice])
    const padding = (maxPrice - minPrice) * 0.1
    const y = linearScale([minPrice - padding, maxPrice + padding], [height, 0]).nice()
    // Bar length is the asset quantity, using 70% of the width to leave room for labels.
    const x = linearScale([0, max(sortedOrders, (d) => d.sellQuantity)], [0, width * 0.7]).nice()

    return {
      margin, width, height, sortedOrders, x, y,
      barHeight: Math.min(20, (height - 60) / sortedOrders.length),
      axisFontSize: getAxisFontSize(size.width),
    }
  }, [hasData, orders, currentPrice, size.width, size.height])

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        No pending orders
      </div>
    )
  }

  return (
    <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }}>
      {chart && (
        <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
          <line
            x1={0}
            x2={chart.width}
            y1={chart.y(currentPrice)}
            y2={chart.y(currentPrice)}
            stroke={colors.yellow}
            strokeWidth={2}
            strokeDasharray="5,5"
          />
          <text x={chart.width} y={chart.y(currentPrice) - 5} textAnchor="end" fill={colors.yellow} style={{ fontSize: '11px' }}>
            {`Current: ${formatCurrency(currentPrice)}`}
          </text>
          {chart.sortedOrders.map((order, i) => {
            const yPos = chart.y(order.sellPrice)
            const barEnd = chart.x(order.sellQuantity)
            const ready = order.sellPrice <= currentPrice
            return (
              <g key={i}>
                <rect
                  x={0}
                  y={yPos - chart.barHeight / 2}
                  width={barEnd}
                  height={chart.barHeight}
                  fill={ready ? colors.green : colorWithOpacity(colors.purple, 0.7)}
                  rx={2}
                  stroke={ready ? colors.green : colors.purple}
                  strokeWidth={1}
                />
                <circle cx={barEnd + 15} cy={chart.y(order.buyPrice)} r={4} fill={colors.blue} />
                <line
                  x1={barEnd + 15}
                  y1={chart.y(order.buyPrice)}
                  x2={barEnd + 15}
                  y2={yPos}
                  stroke={colors.gray}
                  strokeWidth={1}
                  strokeDasharray="2,2"
                />
                <text x={barEnd + 25} y={yPos + 4} fill={ready ? colors.green : colors.lightGray} style={{ fontSize: chart.axisFontSize }}>
                  {formatCurrency(order.sellPrice)}
                </text>
              </g>
            )
          })}
          <Axis
            orient="left"
            scale={chart.y}
            ticks={chart.y.ticks(6)}
            format={formatCurrencyCompact}
            stroke={colors.darkGray}
            textFill={colors.lightGray}
            fontSize={chart.axisFontSize}
          />
          <text transform="rotate(-90)" x={-chart.height / 2} y={-55} textAnchor="middle" fill={colors.lightGray} style={{ fontSize: '11px' }}>
            Price
          </text>
          <g transform="translate(0, -20)">
            {PENDING_LEGEND.map((item, i) => (
              <g key={item.label} transform={`translate(${i * 100}, 0)`}>
                {item.label === 'Current Price' ? (
                  <line x1={0} x2={15} y1={5} y2={5} stroke={item.color} strokeWidth={2} strokeDasharray="3,3" />
                ) : (
                  <circle r={5} cx={7} cy={5} fill={item.color} />
                )}
                <text x={20} y={9} fill={colors.lightGray} style={{ fontSize: '10px' }}>{item.label}</text>
              </g>
            ))}
          </g>
        </g>
      )}
    </svg>
  )
}

export function CostBasisDistributionChart({
  orders,
  currentPrice,
}) {
  const [ref, size] = useElementSize()
  const hasData = orders?.length > 0

  const chart = useMemo(() => {
    if (!hasData || !size.width) return null
    const margin = { top: 20, right: 20, bottom: 40, left: 60 }
    const width = size.width - margin.left - margin.right
    const height = size.height - margin.top - margin.bottom

    // Histogram of buy prices in up to 20 uniform bins.
    const buyPrices = orders.map((o) => o.buyPrice)
    const [minPrice, maxPrice] = extent(buyPrices)
    const bins = histogram(buyPrices, { domain: [minPrice, maxPrice], thresholds: Math.min(20, orders.length) })
    const x = linearScale([minPrice, maxPrice], [0, width]).nice()
    const y = linearScale([0, max(bins, (b) => b.values.length)], [height, 0]).nice()

    return { margin, width, height, minPrice, maxPrice, bins, x, y, axisFontSize: getAxisFontSize(size.width) }
  }, [hasData, orders, size.width, size.height])

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        No orders for distribution
      </div>
    )
  }

  return (
    <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }}>
      {chart && (
        <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
          <Grid width={chart.width} rows={chart.y.ticks(5).map(chart.y)} {...DASHED_GRID} />
          {chart.bins.map((bin, i) => (
            <rect
              key={i}
              className="bar"
              x={chart.x(bin.x0) + 1}
              y={chart.y(bin.values.length)}
              width={Math.max(0, chart.x(bin.x1) - chart.x(bin.x0) - 2)}
              height={chart.height - chart.y(bin.values.length)}
              fill={(bin.x0 + bin.x1) / 2 < currentPrice ? colors.green : colors.blue}
              rx={2}
            />
          ))}
          {currentPrice >= chart.minPrice && currentPrice <= chart.maxPrice && (
            <>
              <line
                x1={chart.x(currentPrice)}
                x2={chart.x(currentPrice)}
                y1={0}
                y2={chart.height}
                stroke={colors.yellow}
                strokeWidth={2}
                strokeDasharray="5,5"
              />
              <text x={chart.x(currentPrice)} y={-5} textAnchor="middle" fill={colors.yellow} style={{ fontSize: '10px' }}>
                Current
              </text>
            </>
          )}
          <Axis
            orient="bottom"
            transform={`translate(0,${chart.height})`}
            scale={chart.x}
            ticks={chart.x.ticks(5)}
            format={formatCurrencyCompact}
            stroke={colors.darkGray}
            textFill={colors.lightGray}
            fontSize={chart.axisFontSize}
          />
          <Axis orient="left" scale={chart.y} ticks={chart.y.ticks(5)} format={chart.y.tickFormat(5)} textFill={colors.lightGray} fontSize={chart.axisFontSize} />
          <text x={chart.width / 2} y={chart.height + 35} textAnchor="middle" fill={colors.lightGray} style={{ fontSize: '11px' }}>
            Buy Price
          </text>
          <text transform="rotate(-90)" x={-chart.height / 2} y={-45} textAnchor="middle" fill={colors.lightGray} style={{ fontSize: '11px' }}>
            Order Count
          </text>
        </g>
      )}
    </svg>
  )
}

export default PendingOrdersChart
