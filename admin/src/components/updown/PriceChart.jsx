import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, CartesianGrid, LineChart } from 'recharts'
import { BarChart3 } from 'lucide-react'

/**
 * View config: each view buckets ticks into fixed time intervals,
 * maps to the best-matching indicator timeframe, and caps displayed points.
 */
const VIEWS = {
  '1h':  { bucketMs: 60_000,    maxBuckets: 60,  indicatorTf: '1m',  label: '1H' },
  '6h':  { bucketMs: 300_000,   maxBuckets: 72,  indicatorTf: '5m',  label: '6H' },
  '1d':  { bucketMs: 900_000,   maxBuckets: 96,  indicatorTf: '15m', label: '1D' },
  '7d':  { bucketMs: 3_600_000, maxBuckets: 168, indicatorTf: '1h',  label: '7D' },
}
const VIEW_KEYS = Object.keys(VIEWS)
const SYNC_INTERVAL_MS = 5_000

function formatPrice(value) {
  if (value == null) return ''
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function formatBucketLabel(ts, bucketMs) {
  const d = new Date(ts)
  if (bucketMs >= 3_600_000) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
  }
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

const TOOLTIP_STYLE = {
  backgroundColor: '#1f2937',
  border: '1px solid #374151',
  borderRadius: '8px',
  fontSize: '12px',
}

export default function PriceChart({ tick, indicators, contract }) {
  const [view, setView] = useState('1d')
  const [chartData, setChartData] = useState([])

  const bucketsRef = useRef(new Map())
  const lastBucketKeyRef = useRef(null)

  const { bucketMs, maxBuckets, indicatorTf } = VIEWS[view]

  // Reset on view change
  useEffect(() => {
    bucketsRef.current = new Map()
    lastBucketKeyRef.current = null
    setChartData([])
  }, [view])

  // Sync buckets ref → chart state
  const syncChart = useCallback(() => {
    const { maxBuckets: max, bucketMs: bms } = VIEWS[view]
    const arr = [...bucketsRef.current.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-max)
      .map(([key, d]) => ({ ...d, label: formatBucketLabel(key, bms) }))
    setChartData(arr)
  }, [view])

  // Process ticks into buckets (ref mutation only — no re-render per tick)
  useEffect(() => {
    if (!tick?.price) return
    const now = Date.now()
    const bKey = Math.floor(now / bucketMs) * bucketMs
    const map = bucketsRef.current

    const b = map.get(bKey)
    if (b) {
      b.price = tick.price
      if (tick.price > b.high) b.high = tick.price
      if (tick.price < b.low) b.low = tick.price
    } else {
      map.set(bKey, {
        time: bKey, price: tick.price, high: tick.price, low: tick.price,
        bollingerUpper: null, bollingerLower: null, bollingerMiddle: null,
        vwap: null, rsi: null, stochK: null, stochD: null,
        macdLine: null, macdSignal: null, macdHistogram: null,
      })
    }

    // Prune old buckets
    const cutoff = now - maxBuckets * bucketMs * 1.1
    for (const k of map.keys()) { if (k < cutoff) map.delete(k) }

    // Immediate sync when a new bucket opens
    if (lastBucketKeyRef.current != null && lastBucketKeyRef.current !== bKey) syncChart()
    lastBucketKeyRef.current = bKey
  }, [tick?.price, bucketMs, maxBuckets, syncChart])

  // Attach indicator data to current bucket
  useEffect(() => {
    const tf = indicators?.[indicatorTf]
    if (!tf) return
    const bKey = Math.floor(Date.now() / bucketMs) * bucketMs
    const b = bucketsRef.current.get(bKey)
    if (!b) return

    const bb = tf.bollingerBands || tf.bollinger
    if (bb) { b.bollingerUpper = bb.upper; b.bollingerLower = bb.lower; b.bollingerMiddle = bb.middle }
    if (tf.vwap != null) b.vwap = tf.vwap
    if (tf.rsi != null) b.rsi = tf.rsi
    if (tf.stochastic) { b.stochK = tf.stochastic.k; b.stochD = tf.stochastic.d }
    if (tf.macd) { b.macdLine = tf.macd.macd; b.macdSignal = tf.macd.signal; b.macdHistogram = tf.macd.histogram }
  }, [indicators, indicatorTf, bucketMs])

  // Periodic sync (renders chart at most every 5s)
  useEffect(() => {
    const t = setInterval(syncChart, SYNC_INTERVAL_MS)
    return () => clearInterval(t)
  }, [syncChart])

  // Current indicator values (from live data, always fresh)
  const currentInd = indicators?.[indicatorTf]

  const priceDomain = useMemo(() => {
    if (!chartData.length) return ['auto', 'auto']
    const vals = []
    for (const d of chartData) {
      if (d.price) vals.push(d.price)
      if (d.bollingerUpper) vals.push(d.bollingerUpper)
      if (d.bollingerLower) vals.push(d.bollingerLower)
    }
    if (contract?.target) vals.push(contract.target)
    if (contract?.stop) vals.push(contract.stop)
    if (!vals.length) return ['auto', 'auto']
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const pad = (max - min) * 0.05 || 50
    return [min - pad, max + pad]
  }, [chartData, contract])

  const hasRsi = chartData.some(d => d.rsi != null)
  const hasStoch = chartData.some(d => d.stochK != null)
  const hasMacd = chartData.some(d => d.macdLine != null)

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      {/* Header with view selector */}
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 size={16} className="text-blue-400" />
        <h3 className="text-sm font-semibold">Price Chart</h3>
        {tick?.price && (
          <span className="text-sm font-mono text-white">{formatPrice(tick.price)}</span>
        )}
        <div className="ml-auto flex gap-1">
          {VIEW_KEYS.map(k => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                view === k ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {VIEWS[k].label}
            </button>
          ))}
        </div>
      </div>

      {chartData.length < 2 ? (
        <div className="text-gray-500 text-sm text-center py-12">
          Waiting for price data...
          <div className="text-xs text-gray-600 mt-1">
            {view === '7d' ? 'First data point every hour' :
             view === '1d' ? 'First data point every 15 min' :
             view === '6h' ? 'First data point every 5 min' :
             'First data point every minute'}
          </div>
        </div>
      ) : (
        <div className="space-y-0">
          {/* Main Price Chart */}
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} interval="preserveStartEnd" />
              <YAxis domain={priceDomain} tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={formatPrice} width={70} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: '#9ca3af' }}
                formatter={(value, name) => {
                  const labels = { price: 'Price', bollingerUpper: 'BB Upper', bollingerLower: 'BB Lower', bollingerMiddle: 'BB Mid', vwap: 'VWAP' }
                  return [formatPrice(value), labels[name] || name]
                }}
              />

              {/* Bollinger Band fill */}
              <Area type="monotone" dataKey="bollingerUpper" stroke="none" fill="none" connectNulls />
              <Area type="monotone" dataKey="bollingerLower" stroke="none" fill="rgba(99,102,241,0.08)" connectNulls />

              {/* Bollinger lines */}
              <Line type="monotone" dataKey="bollingerUpper" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
              <Line type="monotone" dataKey="bollingerLower" stroke="#6366f1" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
              <Line type="monotone" dataKey="bollingerMiddle" stroke="#818cf8" strokeWidth={1} strokeDasharray="5 5" dot={false} connectNulls />

              {/* VWAP */}
              <Line type="monotone" dataKey="vwap" stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" dot={false} connectNulls />

              {/* Price line */}
              <Line type="monotone" dataKey="price" stroke="#3b82f6" strokeWidth={2} dot={false} />

              {/* Target / Stop reference lines */}
              {contract?.target && (
                <ReferenceLine y={contract.target} stroke="#10b981" strokeDasharray="3 3"
                  label={{ value: `Target ${formatPrice(contract.target)}`, position: 'right', fontSize: 10, fill: '#10b981' }} />
              )}
              {contract?.stop && (
                <ReferenceLine y={contract.stop} stroke="#ef4444" strokeDasharray="3 3"
                  label={{ value: `Stop ${formatPrice(contract.stop)}`, position: 'right', fontSize: 10, fill: '#ef4444' }} />
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Current Indicator Values */}
          {currentInd && (
            <div className="grid grid-cols-3 gap-2 py-2 text-xs">
              <div className="bg-gray-900 rounded px-2 py-1 flex items-center justify-between">
                <span className="text-gray-500">RSI</span>
                <span className={`font-mono font-medium ${
                  (currentInd.rsi ?? 50) > 70 ? 'text-red-400' : (currentInd.rsi ?? 50) < 30 ? 'text-green-400' : 'text-white'
                }`}>{currentInd.rsi?.toFixed(1) ?? '---'}</span>
              </div>
              <div className="bg-gray-900 rounded px-2 py-1 flex items-center justify-between">
                <span className="text-gray-500">Stoch</span>
                <span className="font-mono font-medium text-white">
                  {currentInd.stochastic?.k?.toFixed(0) ?? '---'}/{currentInd.stochastic?.d?.toFixed(0) ?? '---'}
                </span>
              </div>
              <div className="bg-gray-900 rounded px-2 py-1 flex items-center justify-between">
                <span className="text-gray-500">MACD</span>
                <span className={`font-mono font-medium ${
                  (currentInd.macd?.histogram ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>{currentInd.macd?.histogram?.toFixed(1) ?? '---'}</span>
              </div>
            </div>
          )}

          {/* RSI Sub-chart */}
          {hasRsi && (
            <div>
              <div className="text-[10px] text-gray-500 pl-8 -mb-1">RSI ({indicatorTf})</div>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={chartData} margin={{ top: 2, right: 5, bottom: 0, left: 5 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} ticks={[30, 70]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={v => [v?.toFixed(1), 'RSI']} />
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
                <LineChart data={chartData} margin={{ top: 2, right: 5, bottom: 0, left: 5 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} ticks={[20, 80]} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
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
                <LineChart data={chartData} margin={{ top: 2, right: 5, bottom: 0, left: 5 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
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
