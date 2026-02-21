import { useEffect, useMemo } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, CartesianGrid, LineChart, Customized,
} from 'recharts'
import { BarChart3 } from 'lucide-react'
import useCandleData, { DEFAULT_VIEWS } from '../../hooks/useCandleData'
import { BTC_TOOLTIP_STYLE, formatBTCPrice } from './chartUtils'

// Stable empty arrays to avoid re-render loops from default prop values
const EMPTY_ARRAY = []

/**
 * Render atomoku cloud fills as raw SVG polygons.
 * Uses formattedGraphicalItems for accurate X positions and yAxis.scale for Y.
 */
const AtomokuCloudRenderer = ({ formattedGraphicalItems, yAxisMap }) => {
  const yAxis = yAxisMap && Object.values(yAxisMap)[0]
  if (!yAxis?.scale || !formattedGraphicalItems?.length) return null

  const yScale = yAxis.scale

  // Get X positions and data payload from any graphical item's points
  let points = null
  for (const item of formattedGraphicalItems) {
    const pts = item?.props?.points
    if (pts?.length > 1) { points = pts; break }
  }
  if (!points) return null

  const n = points.length
  const polygons = []
  let polyKey = 0

  const buildCloud = (key1, key2, bullColor, bearColor) => {
    let segStart = -1
    let segBull = null

    const flush = (end) => {
      if (segStart < 0 || end <= segStart) return
      const top = []
      const bot = []
      for (let i = segStart; i <= end; i++) {
        const d = points[i]?.payload
        const v1 = d?.[key1]
        const v2 = d?.[key2]
        if (v1 == null || v2 == null) continue
        const x = points[i].x
        const yT = yScale(Math.max(v1, v2))
        const yB = yScale(Math.min(v1, v2))
        if (x == null || isNaN(yT) || isNaN(yB)) continue
        top.push(`${x},${yT}`)
        bot.unshift(`${x},${yB}`)
      }
      if (top.length < 2) return
      polygons.push(
        <polygon key={`cloud-${polyKey++}`} points={[...top, ...bot].join(' ')}
          fill={segBull ? bullColor : bearColor} strokeWidth={0} />
      )
    }

    for (let i = 0; i < n; i++) {
      const d = points[i]?.payload
      const v1 = d?.[key1]
      const v2 = d?.[key2]
      if (v1 == null || v2 == null) {
        flush(i - 1); segStart = -1; segBull = null
        continue
      }
      const bull = v1 >= v2
      if (segStart < 0) {
        segStart = i; segBull = bull
      } else if (bull !== segBull) {
        flush(i); segStart = i; segBull = bull
      }
    }
    flush(n - 1)
  }

  buildCloud('atomokuLead1', 'atomokuLead2', 'rgba(0,128,0,0.4)', 'rgba(255,0,0,0.4)')
  buildCloud('atomokuConv', 'atomokuBase', 'rgba(0,51,51,0.3)', 'rgba(128,0,0,0.3)')

  return <g>{polygons}</g>
}

/**
 * Shared composable BTC price chart.
 *
 * @param {Object} props
 * @param {string} props.exchange - 'cryptocom' | 'coinbase'
 * @param {number} [props.tickPrice] - live price from socket
 * @param {number} [props.tickTimestamp] - live tick timestamp
 *
 * @param {Object} [props.views] - custom VIEWS config (defaults to DEFAULT_VIEWS)
 * @param {string} [props.defaultView] - default view key ('1d')
 * @param {boolean} [props.showViewSelector] - show view selector buttons (true)
 *
 * @param {Array<string>} [props.overlays] - ['bollinger', 'vwap', 'atomoku']
 * @param {Object} [props.indicators] - indicator data from socket (keyed by timeframe)
 * @param {Array<{y: number, stroke: string, strokeDasharray?: string, label?: string, labelFill?: string}>} [props.referenceLines]
 *
 * @param {Array<{dataKey: string, stroke: string, label: string}>} [props.exchangeLines]
 * @param {Object} [props.exchangeTickData] - {coinbase: price, kraken: price}
 *
 * @param {Array<string>} [props.subCharts] - ['rsi', 'stochastic', 'macd']
 *
 * @param {number} [props.height] - main chart height (260)
 * @param {string} [props.className]
 */
export default function BTCPriceChart({
  exchange,
  tickPrice,
  tickTimestamp,

  views: customViews,
  defaultView = '1d',
  showViewSelector = true,

  overlays = EMPTY_ARRAY,
  indicators,
  referenceLines = EMPTY_ARRAY,

  exchangeLines = EMPTY_ARRAY,
  exchangeTickData,

  subCharts = EMPTY_ARRAY,

  height = 260,
  className,
}) {
  const views = customViews || DEFAULT_VIEWS
  const viewKeys = useMemo(() => Object.keys(views), [views])

  const { chartData, view, setView, isLoading, viewConfig } = useCandleData(
    exchange, tickPrice, tickTimestamp, { views, defaultView }
  )

  const { bucketMs, indicatorTf } = viewConfig

  // Merge exchange tick data into the most recent chart data point
  const enrichedData = useMemo(() => {
    if (!chartData.length) return chartData
    if (!exchangeTickData || !exchangeLines.length) return chartData

    // Clone last point and add exchange-specific prices
    const data = [...chartData]
    const last = { ...data[data.length - 1] }
    for (const line of exchangeLines) {
      const val = exchangeTickData[line.dataKey]
      if (val) last[line.dataKey] = val
    }
    data[data.length - 1] = last
    return data
  }, [chartData, exchangeTickData, exchangeLines])

  // Attach indicator data to current bucket
  useEffect(() => {
    if (!indicators || !indicatorTf) return
    const tf = indicators[indicatorTf]
    if (!tf) return
    // This is deliberately a ref-style mutation on the Map inside useCandleData.
    // The periodic syncChart() in the hook will pick it up.
  }, [indicators, indicatorTf])

  // displayData = enrichedData (indicators are now computed client-side in useCandleData)
  const displayData = enrichedData

  const showBollinger = overlays.includes('bollinger')
  const showVwap = overlays.includes('vwap')
  const showAtomoku = overlays.includes('atomoku')

  // Current indicator values (for display badges below chart)
  const currentInd = indicators?.[indicatorTf]

  // Y-axis domain — only include positive numeric values
  const priceDomain = useMemo(() => {
    if (!displayData.length) return ['auto', 'auto']
    const vals = []
    for (const d of displayData) {
      if (d.price > 0) vals.push(d.price)
      if (d.high > 0) vals.push(d.high)
      if (d.low > 0) vals.push(d.low)
      if (d.bollingerUpper > 0) vals.push(d.bollingerUpper)
      if (d.bollingerLower > 0) vals.push(d.bollingerLower)
      if (showAtomoku) {
        if (d.atomokuConv > 0) vals.push(d.atomokuConv)
        if (d.atomokuBase > 0) vals.push(d.atomokuBase)
        if (d.atomokuLead1 > 0) vals.push(d.atomokuLead1)
        if (d.atomokuLead2 > 0) vals.push(d.atomokuLead2)
        if (d.atomokuLagging > 0) vals.push(d.atomokuLagging)
      }
      for (const line of exchangeLines) {
        if (d[line.dataKey] > 0) vals.push(d[line.dataKey])
      }
    }
    for (const ref of referenceLines) {
      if (ref.y > 0) vals.push(ref.y)
    }
    if (!vals.length) return ['auto', 'auto']
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const pad = (max - min) * 0.05 || 50
    return [min - pad, max + pad]
  }, [displayData, referenceLines, exchangeLines, showAtomoku])

  const hasRsi = subCharts.includes('rsi') && displayData.some(d => d.rsi != null)
  const hasStoch = subCharts.includes('stochastic') && displayData.some(d => d.stochK != null)
  const hasMacd = subCharts.includes('macd') && displayData.some(d => d.macdLine != null)

  return (
    <div className={`bg-gray-800 rounded-lg p-4 border border-gray-700 ${className || ''}`}>
      {/* Header with view selector */}
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 size={16} className="text-blue-400" />
        <h3 className="text-sm font-semibold">Price Chart</h3>
        {tickPrice && (
          <span className="text-sm font-mono text-white">{formatBTCPrice(tickPrice)}</span>
        )}
        {showViewSelector && (
          <div className="ml-auto flex gap-1">
            {viewKeys.map(k => (
              <button
                key={k}
                onClick={() => setView(k)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  view === k ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                {views[k].label}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading || displayData.length < 2 ? (
        <div className="text-gray-500 text-sm text-center py-12">
          {isLoading ? 'Loading chart data...' : 'Waiting for price data...'}
          {!isLoading && (
            <div className="text-xs text-gray-600 mt-1">
              {view === '7d' ? 'First data point every hour' :
               view === '1d' ? 'First data point every 15 min' :
               view === '6h' ? 'First data point every 5 min' :
               'First data point every minute'}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-0">
          {/* Main Price Chart */}
          <ResponsiveContainer width="100%" height={height}>
            <ComposedChart data={displayData} margin={{ top: 5, right: 5, bottom: 0, left: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} interval="preserveStartEnd" />
              <YAxis domain={priceDomain} allowDataOverflow tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={formatBTCPrice} width={70} />
              <Tooltip
                contentStyle={BTC_TOOLTIP_STYLE}
                labelStyle={{ color: '#9ca3af' }}
                formatter={(value, name) => {
                  if (value == null || value <= 0) return [null, null]
                  const labels = {
                    price: 'Price', bollingerUpper: 'BB Upper', bollingerLower: 'BB Lower',
                    bollingerMiddle: 'BB Mid', vwap: 'VWAP',
                    atomokuConv: 'Conversion', atomokuBase: 'Base Line',
                    atomokuLead1: 'Lead 1', atomokuLead2: 'Lead 2',
                    atomokuLagging: 'Lagging Span',
                  }
                  for (const line of exchangeLines) {
                    labels[line.dataKey] = line.label
                  }
                  return [formatBTCPrice(value), labels[name] || name]
                }}
              />

              {/* Atomoku cloud fills (rendered behind everything via Customized SVG) */}
              {showAtomoku && (
                <Customized component={AtomokuCloudRenderer} />
              )}

              {/* Atomoku lines */}
              {showAtomoku && (
                <>
                  <Line type="monotone" dataKey="atomokuConv" stroke="#0496ff" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="atomokuBase" stroke="#991515" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="atomokuLead1" stroke="green" strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="atomokuLead2" stroke="red" strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="atomokuLagging" stroke="#459915" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
                </>
              )}

              {/* Bollinger Band overlays */}
              {showBollinger && (
                <>
                  <Line type="monotone" dataKey="bollingerUpper" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="bollingerLower" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="bollingerMiddle" stroke="#818cf8" strokeWidth={1} strokeDasharray="5 5" dot={false} connectNulls isAnimationActive={false} />
                </>
              )}

              {/* VWAP overlay */}
              {showVwap && (
                <Line type="monotone" dataKey="vwap" stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" dot={false} connectNulls />
              )}

              {/* Exchange-specific lines (e.g., Coinbase, Kraken for Kalshi) */}
              {exchangeLines.map(line => (
                <Line
                  key={line.dataKey}
                  type="monotone"
                  dataKey={line.dataKey}
                  stroke={line.stroke}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}

              {/* Main price line */}
              <Line type="monotone" dataKey="price" stroke="#3b82f6" strokeWidth={2} dot={false} />

              {/* Reference lines (target, stop, strike, entry, etc.) */}
              {referenceLines.map((ref, i) => (
                <ReferenceLine
                  key={`ref-${i}`}
                  y={ref.y}
                  stroke={ref.stroke}
                  strokeDasharray={ref.strokeDasharray || '3 3'}
                  label={ref.label ? {
                    value: ref.label,
                    position: 'right',
                    fontSize: 10,
                    fill: ref.labelFill || ref.stroke,
                  } : undefined}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Current Indicator Values */}
          {currentInd && subCharts.length > 0 && (
            <div className="grid grid-cols-3 gap-2 py-2 text-xs">
              {subCharts.includes('rsi') && (
                <div className="bg-gray-900 rounded px-2 py-1 flex items-center justify-between">
                  <span className="text-gray-500">RSI</span>
                  <span className={`font-mono font-medium ${
                    (currentInd.rsi ?? 50) > 70 ? 'text-red-400' : (currentInd.rsi ?? 50) < 30 ? 'text-green-400' : 'text-white'
                  }`}>{currentInd.rsi?.toFixed(1) ?? '---'}</span>
                </div>
              )}
              {subCharts.includes('stochastic') && (
                <div className="bg-gray-900 rounded px-2 py-1 flex items-center justify-between">
                  <span className="text-gray-500">Stoch</span>
                  <span className="font-mono font-medium text-white">
                    {currentInd.stochastic?.k?.toFixed(0) ?? '---'}/{currentInd.stochastic?.d?.toFixed(0) ?? '---'}
                  </span>
                </div>
              )}
              {subCharts.includes('macd') && (
                <div className="bg-gray-900 rounded px-2 py-1 flex items-center justify-between">
                  <span className="text-gray-500">MACD</span>
                  <span className={`font-mono font-medium ${
                    (currentInd.macd?.histogram ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>{currentInd.macd?.histogram?.toFixed(1) ?? '---'}</span>
                </div>
              )}
            </div>
          )}

          {/* RSI Sub-chart */}
          {hasRsi && (
            <div>
              <div className="text-[10px] text-gray-500 pl-8 -mb-1">RSI ({indicatorTf})</div>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={displayData} margin={{ top: 2, right: 5, bottom: 0, left: 5 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} ticks={[30, 70]} />
                  <Tooltip contentStyle={BTC_TOOLTIP_STYLE} formatter={v => [v?.toFixed(1), 'RSI']} />
                  <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.4} />
                  <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.4} />
                  <Line type="monotone" dataKey="rsi" stroke="#a855f7" strokeWidth={1.5} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Stochastic Sub-chart */}
          {hasStoch && (
            <div>
              <div className="text-[10px] text-gray-500 pl-8 -mb-1">Stochastic ({indicatorTf})</div>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={displayData} margin={{ top: 2, right: 5, bottom: 0, left: 5 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} ticks={[20, 80]} />
                  <Tooltip
                    contentStyle={BTC_TOOLTIP_STYLE}
                    formatter={(v, name) => [v?.toFixed(1), name === 'stochK' ? '%K' : '%D']}
                  />
                  <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.4} />
                  <ReferenceLine y={20} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.4} />
                  <Line type="monotone" dataKey="stochK" stroke="#3b82f6" strokeWidth={1.5} dot={false} connectNulls />
                  <Line type="monotone" dataKey="stochD" stroke="#f97316" strokeWidth={1} dot={false} strokeDasharray="3 3" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* MACD Sub-chart */}
          {hasMacd && (
            <div>
              <div className="text-[10px] text-gray-500 pl-8 -mb-1">MACD ({indicatorTf})</div>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={displayData} margin={{ top: 2, right: 5, bottom: 0, left: 5 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                  <Tooltip
                    contentStyle={BTC_TOOLTIP_STYLE}
                    formatter={(v, name) => {
                      const labels = { macdLine: 'MACD', macdSignal: 'Signal', macdHistogram: 'Histogram' }
                      return [v?.toFixed(2), labels[name] || name]
                    }}
                  />
                  <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="macdLine" stroke="#3b82f6" strokeWidth={1.5} dot={false} connectNulls />
                  <Line type="monotone" dataKey="macdSignal" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="3 3" connectNulls />
                  <Line type="monotone" dataKey="macdHistogram" stroke="#10b981" strokeWidth={1} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
