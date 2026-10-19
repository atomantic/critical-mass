import { useId, useMemo, useState } from 'react'
import { extent, linePath, linearScale, timeScale, trianglePath } from '../../lib/chart-math'
import { Axis } from './primitives/Axis'
import { ClipRect, Grid } from './primitives/Grid'
import { HoverMarker } from './primitives/Tooltip'
import { localPoint, svgId, useElementSize } from './primitives/Responsive'
import {
  formatCurrencyCompact,
  formatCurrency,
  formatDateTimeFull,
  getResponsiveMargin,
  getAxisFontSize,
  getSmartDateFormatter,
  getSmartTickCount,
  colors,
  DASHED_GRID,
} from './chartUtils'

const SELL_MARKER = trianglePath(6 * 6 * 2)
const LEGEND_TRIANGLE = trianglePath(40)
const LEGEND_ITEMS = [
  { color: colors.yellow, label: 'Price', shape: 'circle' },
  { color: colors.blue, label: 'Buy', shape: 'circle' },
  { color: colors.green, label: 'Sell', shape: 'triangle' },
  { color: colors.purple, label: 'Cost Basis', shape: 'line' },
]

const indexed = (data) => (data || []).map((d, i) => ({
  ...d,
  index: i,
  parsedDate: d.date instanceof Date ? d.date : new Date(d.date),
}))

export function PriceChart({
  priceData,
  buyData,
  sellData,
  avgCostBasis,
}) {
  const [ref, size] = useElementSize()
  const clipId = svgId('clip-price', useId())
  const [hovered, setHovered] = useState(null)
  const hasData = priceData?.length >= 1

  const chart = useMemo(() => {
    if (!hasData || !size.width) return null
    const margin = getResponsiveMargin(size.width)
    const width = size.width - margin.left - margin.right
    const height = size.height - margin.top - margin.bottom
    const parsedPriceData = indexed(priceData)
    const parsedBuyData = indexed(buyData)
    const parsedSellData = indexed(sellData)

    // Samples less than a minute apart (e.g. all stamped at once) are spread by trade index.
    const [minDate, maxDate] = extent(parsedPriceData, (d) => d.parsedDate)
    const timeSpanMs = maxDate - minDate
    const useIndexScale = timeSpanMs < 60000
    let x, getX, xTicks, xFormat
    if (useIndexScale) {
      x = linearScale([0, parsedPriceData.length - 1], [0, width])
      getX = (d) => x(d.index)
      xTicks = x.ticks(Math.min(parsedPriceData.length, 8))
      xFormat = (d) => `#${d + 1}`
    } else {
      x = timeScale([minDate, maxDate], [0, width])
      getX = (d) => x(d.parsedDate)
      xTicks = x.ticks(getSmartTickCount(timeSpanMs, size.width))
      xFormat = getSmartDateFormatter(minDate, maxDate)
    }

    // Price range also covers the sell targets.
    const [minPrice, maxPrice] = extent(parsedPriceData, (d) => d.price)
    const sellPrices = parsedSellData.map((d) => d.sellPrice).filter(Boolean)
    const allMaxPrice = sellPrices.length > 0 ? Math.max(maxPrice, ...sellPrices) : maxPrice
    const pricePadding = (allMaxPrice - minPrice) * 0.1 || allMaxPrice * 0.05
    const y = linearScale([minPrice - pricePadding, allMaxPrice + pricePadding], [height, 0]).nice()

    return {
      margin, width, height, parsedPriceData, parsedBuyData, parsedSellData, useIndexScale,
      x, getX, xTicks, xFormat, y,
      axisFontSize: getAxisFontSize(size.width),
      line: linePath(parsedPriceData, { x: getX, y: (d) => y(d.price) }),
    }
  }, [hasData, priceData, buyData, sellData, size.width, size.height])

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Not enough price data
      </div>
    )
  }

  // Nearest sample by horizontal distance.
  const onMouseMove = (event) => {
    const [mouseX] = localPoint(event)
    let nearest = null
    let minDist = Infinity
    for (const d of chart.parsedPriceData) {
      const dist = Math.abs(chart.getX(d) - mouseX)
      if (dist < minDist) {
        minDist = dist
        nearest = d
      }
    }
    setHovered(nearest)
  }

  const renderHover = () => {
    const { getX, y, width, height, useIndexScale } = chart
    const xPos = getX(hovered)
    const yPos = y(hovered.price)
    return (
      <HoverMarker
        x={xPos}
        height={height}
        dot={{ y: yPos, color: colors.yellow }}
        box={{ x: xPos > width / 2 ? xPos - 120 : xPos + 10, y: yPos < 40 ? yPos + 10 : yPos - 45, width: 110, height: 40 }}
        rows={[
          { text: useIndexScale ? `Trade #${hovered.index + 1}` : formatDateTimeFull(hovered.parsedDate), color: colors.lightGray, fontSize: '10px' },
          { text: formatCurrency(hovered.price), color: colors.yellow, fontSize: '12px', bold: true },
        ]}
      />
    )
  }

  return (
    <svg ref={ref} className="w-full h-full" style={{ overflow: 'visible' }}>
      {chart && (
        <g transform={`translate(${chart.margin.left},${chart.margin.top})`}>
          <ClipRect id={clipId} width={chart.width} height={chart.height} />
          <Grid width={chart.width} rows={chart.y.ticks(5).map(chart.y)} {...DASHED_GRID} />
          <path clipPath={`url(#${clipId})`} fill="none" stroke={colors.yellow} strokeWidth={2} d={chart.line} />
          {chart.parsedBuyData.map((d) => (
            <circle key={d.index} className="buy-marker" cx={chart.getX(d)} cy={chart.y(d.price)} r={5} fill={colors.blue} stroke="white" strokeWidth={2} />
          ))}
          {chart.parsedSellData.map((d) => (
            <path
              key={d.index}
              className="sell-marker"
              d={SELL_MARKER}
              transform={`translate(${chart.getX(d)},${chart.y(d.sellPrice)})`}
              fill={colors.green}
              stroke="white"
              strokeWidth={1.5}
            />
          ))}
          {chart.parsedSellData.map((d) => (
            <line
              key={d.index}
              className="buy-sell-line"
              x1={chart.getX(d)}
              y1={chart.y(d.price)}
              x2={chart.getX(d)}
              y2={chart.y(d.sellPrice)}
              stroke={colors.green}
              strokeDasharray="2,2"
              strokeOpacity={0.5}
            />
          ))}
          {avgCostBasis > 0 && (
            <>
              <line
                className="cost-basis-line"
                x1={0}
                x2={chart.width}
                y1={chart.y(avgCostBasis)}
                y2={chart.y(avgCostBasis)}
                stroke={colors.purple}
                strokeWidth={2}
                strokeDasharray="6,3"
              />
              <text x={chart.width - 5} y={chart.y(avgCostBasis) - 5} textAnchor="end" fill={colors.purple} style={{ fontSize: '10px', fontWeight: 'bold' }}>
                {`Avg Cost: ${formatCurrencyCompact(avgCostBasis)}`}
              </text>
            </>
          )}
          <Axis
            orient="bottom"
            transform={`translate(0,${chart.height})`}
            scale={chart.x}
            ticks={chart.xTicks}
            format={chart.xFormat}
            stroke={colors.darkGray}
            textFill={colors.lightGray}
            fontSize={chart.axisFontSize}
          />
          <Axis orient="left" scale={chart.y} ticks={chart.y.ticks(5)} format={formatCurrencyCompact} textFill={colors.lightGray} fontSize={chart.axisFontSize} />
          {hovered && renderHover()}
          <rect
            className="overlay"
            width={chart.width}
            height={chart.height}
            fill="none"
            pointerEvents="all"
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHovered(null)}
          />
          <g className="legend" transform="translate(10, 10)">
            {LEGEND_ITEMS.map((item, i) => (
              <g key={item.label} transform={`translate(${i * 70}, 0)`}>
                {item.shape === 'triangle' && <path d={LEGEND_TRIANGLE} transform="translate(5, 5)" fill={item.color} />}
                {item.shape === 'line' && <line x1={0} y1={5} x2={10} y2={5} stroke={item.color} strokeWidth={2} strokeDasharray="4,2" />}
                {item.shape === 'circle' && <circle r={5} cx={5} cy={5} fill={item.color} />}
                <text x={15} y={9} fill={colors.lightGray} style={{ fontSize: '10px' }}>{item.label}</text>
              </g>
            ))}
          </g>
        </g>
      )}
    </svg>
  )
}

export default PriceChart
