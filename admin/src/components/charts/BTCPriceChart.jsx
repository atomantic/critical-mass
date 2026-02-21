import { useEffect, useMemo } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, CartesianGrid, LineChart,
} from 'recharts'
import { BarChart3 } from 'lucide-react'
import useCandleData, { DEFAULT_VIEWS } from '../../hooks/useCandleData'
import { BTC_TOOLTIP_STYLE, formatBTCPrice } from './chartUtils'

// Stable empty arrays to avoid re-render loops from default prop values
const EMPTY_ARRAY = []

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
 * @param {Array<string>} [props.overlays] - ['bollinger', 'vwap']
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

  // Build indicator-attached data
  const dataWithIndicators = useMemo(() => {
    if (!indicators || !indicatorTf || !enrichedData.length) return enrichedData

    const tfData = indicators[indicatorTf]
    if (!tfData) return enrichedData

    // Attach current indicators to the last data point for display
    const data = enrichedData.map(d => ({ ...d }))
    const last = data[data.length - 1]
    if (last && tfData) {
      const bb = tfData.bollingerBands || tfData.bollinger
      if (bb) {
        last.bollingerUpper = bb.upper
        last.bollingerLower = bb.lower
        last.bollingerMiddle = bb.middle
      }
      if (tfData.vwap != null) last.vwap = tfData.vwap
      if (tfData.rsi != null) last.rsi = tfData.rsi
      if (tfData.stochastic) {
        last.stochK = tfData.stochastic.k
        last.stochD = tfData.stochastic.d
      }
      if (tfData.macd) {
        last.macdLine = tfData.macd.macd
        last.macdSignal = tfData.macd.signal
        last.macdHistogram = tfData.macd.histogram
      }
    }
    return data
  }, [enrichedData, indicators, indicatorTf])

  const displayData = dataWithIndicators

  const showBollinger = overlays.includes('bollinger')
  const showVwap = overlays.includes('vwap')

  // Current indicator values (for display badges below chart)
  const currentInd = indicators?.[indicatorTf]

  // Y-axis domain
  const priceDomain = useMemo(() => {
    if (!displayData.length) return ['auto', 'auto']
    const vals = []
    for (const d of displayData) {
      if (d.price) vals.push(d.price)
      if (d.bollingerUpper) vals.push(d.bollingerUpper)
      if (d.bollingerLower) vals.push(d.bollingerLower)
      for (const line of exchangeLines) {
        if (d[line.dataKey]) vals.push(d[line.dataKey])
      }
    }
    for (const ref of referenceLines) {
      if (ref.y) vals.push(ref.y)
    }
    if (!vals.length) return ['auto', 'auto']
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const pad = (max - min) * 0.05 || 50
    return [min - pad, max + pad]
  }, [displayData, referenceLines, exchangeLines])

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
              <YAxis domain={priceDomain} tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={formatBTCPrice} width={70} />
              <Tooltip
                contentStyle={BTC_TOOLTIP_STYLE}
                labelStyle={{ color: '#9ca3af' }}
                formatter={(value, name) => {
                  const labels = {
                    price: 'Price', bollingerUpper: 'BB Upper', bollingerLower: 'BB Lower',
                    bollingerMiddle: 'BB Mid', vwap: 'VWAP',
                  }
                  // Add exchange line labels
                  for (const line of exchangeLines) {
                    labels[line.dataKey] = line.label
                  }
                  return [formatBTCPrice(value), labels[name] || name]
                }}
              />

              {/* Bollinger Band overlays */}
              {showBollinger && (
                <>
                  <Area type="monotone" dataKey="bollingerUpper" stroke="none" fill="none" connectNulls />
                  <Area type="monotone" dataKey="bollingerLower" stroke="none" fill="rgba(99,102,241,0.08)" connectNulls />
                  <Line type="monotone" dataKey="bollingerUpper" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
                  <Line type="monotone" dataKey="bollingerLower" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
                  <Line type="monotone" dataKey="bollingerMiddle" stroke="#818cf8" strokeWidth={1} strokeDasharray="5 5" dot={false} connectNulls />
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
