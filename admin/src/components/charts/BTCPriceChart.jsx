import { useEffect, useMemo } from 'react'
import { BarChart3 } from '../icons'
import useCandleData, { DEFAULT_VIEWS } from '../../hooks/useCandleData'
import { BTC_TOOLTIP_STYLE, formatBTCPrice } from './chartUtils'
import { CartesianChart } from './primitives/CartesianChart'
import AtomokuCloudRenderer from './AtomokuCloudRenderer'
import HeikinAshiRenderer from './HeikinAshiRenderer'
import SignalAnnotationRenderer from './SignalAnnotationRenderer'

// Stable empty arrays to avoid re-render loops from default prop values
const EMPTY_ARRAY = []

const AXIS_TICK = { fontSize: 10, fill: '#9ca3af' }
const SUB_AXIS_TICK = { fontSize: 9, fill: '#6b7280' }
const SUB_MARGIN = { top: 2, right: 5, bottom: 0, left: 5 }
const SUB_X_AXIS = { dataKey: 'label', hide: true }
const MAIN_MARGIN = { top: 5, right: 5, bottom: 0, left: 5 }
const GRID = { stroke: '#374151', strokeDasharray: '3 3' }

const SERIES_LABELS = {
  price: 'Price', bollingerUpper: 'BB Upper', bollingerLower: 'BB Lower',
  bollingerMiddle: 'BB Mid', vwap: 'VWAP',
  atomokuConv: 'Conversion', atomokuBase: 'Base Line',
  atomokuLead1: 'Lead 1', atomokuLead2: 'Lead 2',
  atomokuLagging: 'Lagging Span',
}

const ATOMOKU_SERIES = [
  { dataKey: 'atomokuConv', stroke: '#0496ff', strokeWidth: 2, connectNulls: true },
  { dataKey: 'atomokuBase', stroke: '#991515', strokeWidth: 2, connectNulls: true },
  { dataKey: 'atomokuLead1', stroke: 'green', strokeWidth: 1, strokeDasharray: '4 3', connectNulls: true },
  { dataKey: 'atomokuLead2', stroke: 'red', strokeWidth: 1, strokeDasharray: '4 3', connectNulls: true },
  { dataKey: 'atomokuLagging', stroke: '#459915', strokeWidth: 1, connectNulls: true },
]
const BOLLINGER_SERIES = [
  { dataKey: 'bollingerUpper', stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '3 3', connectNulls: true },
  { dataKey: 'bollingerLower', stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '3 3', connectNulls: true },
  { dataKey: 'bollingerMiddle', stroke: '#818cf8', strokeWidth: 1, strokeDasharray: '5 5', connectNulls: true },
]
const VWAP_SERIES = { dataKey: 'vwap', stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 4', connectNulls: true }

const SUB_CHARTS = {
  rsi: {
    title: 'RSI',
    yAxes: [{ domain: [0, 100], tick: SUB_AXIS_TICK, width: 30, ticks: [30, 70] }],
    tooltip: { contentStyle: BTC_TOOLTIP_STYLE, formatter: v => [v?.toFixed(1), 'RSI'] },
    referenceLines: [
      { y: 70, stroke: '#ef4444', strokeDasharray: '3 3', strokeOpacity: 0.4 },
      { y: 30, stroke: '#10b981', strokeDasharray: '3 3', strokeOpacity: 0.4 },
    ],
    series: [{ dataKey: 'rsi', stroke: '#a855f7', strokeWidth: 1.5, connectNulls: true }],
  },
  stochastic: {
    title: 'Stochastic',
    yAxes: [{ domain: [0, 100], tick: SUB_AXIS_TICK, width: 30, ticks: [20, 80] }],
    tooltip: { contentStyle: BTC_TOOLTIP_STYLE, formatter: (v, name) => [v?.toFixed(1), name === 'stochK' ? '%K' : '%D'] },
    referenceLines: [
      { y: 80, stroke: '#ef4444', strokeDasharray: '3 3', strokeOpacity: 0.4 },
      { y: 20, stroke: '#10b981', strokeDasharray: '3 3', strokeOpacity: 0.4 },
    ],
    series: [
      { dataKey: 'stochK', stroke: '#3b82f6', strokeWidth: 1.5, connectNulls: true },
      { dataKey: 'stochD', stroke: '#f97316', strokeWidth: 1, strokeDasharray: '3 3', connectNulls: true },
    ],
  },
  macd: {
    title: 'MACD',
    yAxes: [{ tick: SUB_AXIS_TICK, width: 30 }],
    tooltip: {
      contentStyle: BTC_TOOLTIP_STYLE,
      formatter: (v, name) => {
        const labels = { macdLine: 'MACD', macdSignal: 'Signal', macdHistogram: 'Histogram' }
        return [v?.toFixed(2), labels[name] || name]
      },
    },
    referenceLines: [{ y: 0, stroke: '#6b7280', strokeDasharray: '3 3' }],
    series: [
      { dataKey: 'macdLine', stroke: '#3b82f6', strokeWidth: 1.5, connectNulls: true },
      { dataKey: 'macdSignal', stroke: '#ef4444', strokeWidth: 1, strokeDasharray: '3 3', connectNulls: true },
      { dataKey: 'macdHistogram', stroke: '#10b981', strokeWidth: 1, connectNulls: true },
    ],
  },
}

// 80px indicator panel under the price chart, sharing its sample positions.
function IndicatorSubChart({ kind, data, timeframe }) {
  const { title, ...chart } = SUB_CHARTS[kind]
  return (
    <div>
      <div className="text-[10px] text-gray-400 pl-8 -mb-1">{title} ({timeframe})</div>
      <CartesianChart data={data} height={80} margin={SUB_MARGIN} xAxis={SUB_X_AXIS} {...chart} />
    </div>
  )
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
 * @param {string} [props.chartType] - 'line' | 'heikinAshi' (default: 'line')
 * @param {boolean} [props.showIntervalSelector] - show interval/range toolbar
 * @param {string} [props.defaultInterval] - initial bar interval (e.g. '5m')
 * @param {string} [props.defaultRange] - initial time range (e.g. '6h')
 *
 * @param {Array<string>} [props.overlays] - ['bollinger', 'vwap', 'atomoku']
 * @param {Object} [props.indicators] - indicator data from socket (keyed by timeframe)
 * @param {Array<{y: number, stroke: string, strokeDasharray?: string, label?: string, labelFill?: string}>} [props.referenceLines]
 *
 * @param {Array<{dataKey: string, stroke: string, label: string}>} [props.exchangeLines]
 * @param {Object} [props.exchangeTickData] - {coinbase: price, gemini: price, cryptocom: price}
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

  chartType = 'line',
  showIntervalSelector = false,
  defaultInterval,
  defaultRange,

  overlays = EMPTY_ARRAY,
  indicators,
  referenceLines = EMPTY_ARRAY,

  exchangeLines = EMPTY_ARRAY,
  exchangeTickData,

  subCharts = EMPTY_ARRAY,

  signalAnnotations,

  maxBucketsOverride,

  height = 260,
  className,
  headerLabel,
}) {
  const isHA = chartType === 'heikinAshi'

  // Build hook options — interval/range mode when defaultInterval is provided
  const isIntervalMode = !!defaultInterval
  const hookOptions = useMemo(() => {
    if (defaultInterval) {
      return { defaultInterval, defaultRange, signalAnnotations, maxBucketsOverride }
    }
    return { views: customViews || DEFAULT_VIEWS, defaultView, signalAnnotations, maxBucketsOverride }
  }, [defaultInterval, defaultRange, customViews, defaultView, signalAnnotations, maxBucketsOverride])

  const {
    chartData, view, setView, isLoading, error, retry, viewConfig, views,
    interval, setInterval, timeRange, setTimeRange, availableRanges,
  } = useCandleData(exchange, tickPrice, tickTimestamp, hookOptions)

  const viewKeys = useMemo(() => Object.keys(views), [views])
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

  // A unique category keeps repeated time labels (e.g. across days) aligned.
  const displayData = useMemo(() => enrichedData.map((point, chartIndex) => ({ ...point, chartIndex })), [enrichedData])

  const showBollinger = overlays.includes('bollinger')
  const showVwap = overlays.includes('vwap')
  const showAtomoku = overlays.includes('atomoku')

  // Current indicator values (for display badges below chart)
  const currentInd = indicators?.[indicatorTf]

  // Y-axis domain — in HA mode, focus on candle range first and clamp overlay extension
  const priceDomain = useMemo(() => {
    if (!displayData.length) return ['auto', 'auto']

    // Core price values (candles define the primary range)
    const coreVals = []
    // Overlay values (only extend axis within a clamped range)
    const overlayVals = []

    for (const d of displayData) {
      if (d.price > 0) coreVals.push(d.price)
      if (d.high > 0) coreVals.push(d.high)
      if (d.low > 0) coreVals.push(d.low)
      if (isHA) {
        if (d.haHigh > 0) coreVals.push(d.haHigh)
        if (d.haLow > 0) coreVals.push(d.haLow)
      }
      if (d.bollingerUpper > 0) overlayVals.push(d.bollingerUpper)
      if (d.bollingerLower > 0) overlayVals.push(d.bollingerLower)
      if (showAtomoku) {
        if (d.atomokuConv > 0) overlayVals.push(d.atomokuConv)
        if (d.atomokuBase > 0) overlayVals.push(d.atomokuBase)
        if (d.atomokuLead1 > 0) overlayVals.push(d.atomokuLead1)
        if (d.atomokuLead2 > 0) overlayVals.push(d.atomokuLead2)
        if (d.atomokuLagging > 0) overlayVals.push(d.atomokuLagging)
      }
      for (const line of exchangeLines) {
        if (d[line.dataKey] > 0) overlayVals.push(d[line.dataKey])
      }
    }
    for (const ref of referenceLines) {
      if (ref.y > 0) coreVals.push(ref.y)
    }
    if (!coreVals.length) return ['auto', 'auto']

    const coreMin = Math.min(...coreVals)
    const coreMax = Math.max(...coreVals)
    const coreRange = coreMax - coreMin || 100

    // In HA mode, clamp overlay extension to 1.5x the candle range from center
    // so long-lookback indicators don't flatten the candles
    if (isHA && overlayVals.length) {
      const center = (coreMin + coreMax) / 2
      const maxExtent = coreRange * 1.5
      const clampedOverlays = overlayVals.filter(
        v => v >= center - maxExtent && v <= center + maxExtent
      )
      const allVals = [...coreVals, ...clampedOverlays]
      const min = Math.min(...allVals)
      const max = Math.max(...allVals)
      const pad = (max - min) * 0.05 || 50
      return [min - pad, max + pad]
    }

    // Line mode: include all overlay values as before
    const allVals = [...coreVals, ...overlayVals]
    const min = Math.min(...allVals)
    const max = Math.max(...allVals)
    const pad = (max - min) * 0.05 || 50
    return [min - pad, max + pad]
  }, [displayData, referenceLines, exchangeLines, showAtomoku, isHA])

  const hasRsi = subCharts.includes('rsi') && displayData.some(d => d.rsi != null)
  const hasStoch = subCharts.includes('stochastic') && displayData.some(d => d.stochK != null)
  const hasMacd = subCharts.includes('macd') && displayData.some(d => d.macdLine != null)

  // A unique chartIndex category keeps candles at distinct x positions; ticks and the
  // tooltip still show the sample's time label.
  const mainXAxis = useMemo(() => ({
    dataKey: 'chartIndex',
    tickFormatter: index => displayData[index]?.label ?? '',
    tick: AXIS_TICK,
    interval: 'preserveStartEnd',
  }), [displayData])

  const mainYAxes = useMemo(() => [
    { domain: priceDomain, allowDataOverflow: true, tick: AXIS_TICK, tickFormatter: formatBTCPrice, width: 70 },
  ], [priceDomain])

  const mainTooltip = useMemo(() => {
    const labels = { ...SERIES_LABELS }
    for (const line of exchangeLines) labels[line.dataKey] = line.label
    return {
      labelFormatter: index => displayData[index]?.label ?? '',
      contentStyle: BTC_TOOLTIP_STYLE,
      labelStyle: { color: '#9ca3af' },
      formatter: (value, name) => (value == null || value <= 0 ? [null, null] : [formatBTCPrice(value), labels[name] || name]),
    }
  }, [displayData, exchangeLines])

  // Overlays first, then exchange lines; the price line is transparent under Heikin Ashi
  // candles so it still feeds the tooltip.
  const mainSeries = useMemo(() => [
    ...(showAtomoku ? ATOMOKU_SERIES : []),
    ...(showBollinger ? BOLLINGER_SERIES : []),
    ...(showVwap ? [VWAP_SERIES] : []),
    ...exchangeLines.map(line => ({ dataKey: line.dataKey, stroke: line.stroke, strokeWidth: 1.5, connectNulls: true })),
    { dataKey: 'price', stroke: isHA ? 'transparent' : '#3b82f6', strokeWidth: isHA ? 1 : 2 },
  ], [showAtomoku, showBollinger, showVwap, exchangeLines, isHA])

  // Target, stop, strike, entry, SMA... lines.
  const mainReferenceLines = useMemo(() => referenceLines.map(ref => ({
    y: ref.y,
    stroke: ref.stroke,
    strokeDasharray: ref.strokeDasharray || '3 3',
    label: ref.label ? { value: ref.label, fontSize: 10, fill: ref.labelFill || ref.stroke } : undefined,
  })), [referenceLines])

  return (
    <div className={`bg-gray-800 rounded-lg p-4 border border-gray-700 ${className || ''}`}>
      {/* Header with view selector / interval selector */}
      <div className="flex items-center gap-2 mb-3">
        {headerLabel ? (
          <h3 className="text-sm font-semibold">{headerLabel}</h3>
        ) : (
          <>
            <BarChart3 size={16} className="text-blue-400" />
            <h3 className="text-sm font-semibold">Price Chart</h3>
            {tickPrice && (
              <span className="text-sm font-mono text-white">{formatBTCPrice(tickPrice)}</span>
            )}
          </>
        )}

        {/* Compact interval label when selector is hidden */}
        {isIntervalMode && !showIntervalSelector && (
          <span className="ml-auto text-xs font-mono text-gray-400 bg-gray-700 px-2 py-0.5 rounded-sm">{defaultInterval}</span>
        )}

        {/* Interval/range selector (new decoupled mode) */}
        {isIntervalMode && showIntervalSelector && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1D', '1W'].map(k => {
              const tfKey = k === '1D' ? '1d' : k === '1W' ? '1w' : k
              return (
                <button
                  key={tfKey}
                  onClick={() => setInterval(tfKey)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    interval === tfKey ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'
                  }`}
                >
                  {k}
                </button>
              )
            })}
            <span className="text-gray-600 text-xs px-1">/</span>
            {availableRanges.map(r => (
              <button
                key={r.key}
                onClick={() => setTimeRange(r.key)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  timeRange === r.key ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {/* Legacy view selector */}
        {!isIntervalMode && showViewSelector && (
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

      {error && !isLoading ? (
        <div role="alert" className="flex flex-col items-center justify-center gap-3 py-12">
          <div className="text-red-400 text-sm">Failed to load price history: {error}</div>
          <button type="button" onClick={retry} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-sm">Retry</button>
        </div>
      ) : isLoading || displayData.length < 2 ? (
        <div className="text-gray-400 text-sm text-center py-12">
          {isLoading ? 'Loading chart data...' : 'Waiting for price data...'}
          {!isLoading && !isIntervalMode && (
            <div className="text-xs text-gray-400 mt-1">
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
          <CartesianChart
            data={displayData}
            height={height}
            margin={MAIN_MARGIN}
            grid={GRID}
            xAxis={mainXAxis}
            yAxes={mainYAxes}
            tooltip={mainTooltip}
            series={mainSeries}
            referenceLines={mainReferenceLines}
            underlay={<>
              {/* Heikin Ashi candles, then Atomoku cloud fills, behind every line */}
              {isHA && <HeikinAshiRenderer data={displayData} />}
              {showAtomoku && <AtomokuCloudRenderer data={displayData} />}
            </>}
            overlay={signalAnnotations?.length > 0 && <SignalAnnotationRenderer data={displayData} />}
          />

          {/* Current Indicator Values */}
          {currentInd && subCharts.length > 0 && (
            <div className="grid grid-cols-3 gap-2 py-2 text-xs">
              {subCharts.includes('rsi') && (
                <div className="bg-gray-900 rounded-sm px-2 py-1 flex items-center justify-between">
                  <span className="text-gray-400">RSI</span>
                  <span className={`font-mono font-medium ${
                    (currentInd.rsi ?? 50) > 70 ? 'text-red-400' : (currentInd.rsi ?? 50) < 30 ? 'text-green-400' : 'text-white'
                  }`}>{currentInd.rsi?.toFixed(1) ?? '---'}</span>
                </div>
              )}
              {subCharts.includes('stochastic') && (
                <div className="bg-gray-900 rounded-sm px-2 py-1 flex items-center justify-between">
                  <span className="text-gray-400">Stoch</span>
                  <span className="font-mono font-medium text-white">
                    {currentInd.stochastic?.k?.toFixed(0) ?? '---'}/{currentInd.stochastic?.d?.toFixed(0) ?? '---'}
                  </span>
                </div>
              )}
              {subCharts.includes('macd') && (
                <div className="bg-gray-900 rounded-sm px-2 py-1 flex items-center justify-between">
                  <span className="text-gray-400">MACD</span>
                  <span className={`font-mono font-medium ${
                    (currentInd.macd?.histogram ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>{currentInd.macd?.histogram?.toFixed(1) ?? '---'}</span>
                </div>
              )}
            </div>
          )}

          {hasRsi && <IndicatorSubChart kind="rsi" data={displayData} timeframe={indicatorTf} />}
          {hasStoch && <IndicatorSubChart kind="stochastic" data={displayData} timeframe={indicatorTf} />}
          {hasMacd && <IndicatorSubChart kind="macd" data={displayData} timeframe={indicatorTf} />}
        </div>
      )}
    </div>
  )
}
