import { useState, useEffect, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell } from 'recharts'
import { Activity } from 'lucide-react'

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h']
const MAX_HISTORY = 60

export default function IndicatorCharts({ indicators }) {
  const [selectedTf, setSelectedTf] = useState('5m')
  const [rsiHistory, setRsiHistory] = useState([])
  const [stochHistory, setStochHistory] = useState([])
  const [macdHistory, setMacdHistory] = useState([])
  const [wrHistory, setWrHistory] = useState([])
  const [adxHistory, setAdxHistory] = useState([])
  const [obvHistory, setObvHistory] = useState([])

  // Accumulate indicator history for selected timeframe.
  // Each setter skips the append when the latest tracked value is unchanged,
  // so the 5s server tick doesn't flood charts with duplicate points and
  // doesn't trigger needless React re-renders of the chart subtree.
  useEffect(() => {
    const tf = indicators?.[selectedTf]
    if (!tf) return

    const now = Date.now()
    const label = new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

    const append = (setter, point, isUnchanged) => setter(prev => {
      if (prev.length && isUnchanged(prev[prev.length - 1])) return prev
      const next = [...prev, { time: now, label, ...point }]
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
    })

    if (tf.rsi != null) {
      append(setRsiHistory, { rsi: tf.rsi }, last => last.rsi === tf.rsi)
    }
    if (tf.stochastic) {
      append(setStochHistory, { k: tf.stochastic.k, d: tf.stochastic.d },
        last => last.k === tf.stochastic.k && last.d === tf.stochastic.d)
    }
    if (tf.macd) {
      append(setMacdHistory, { macd: tf.macd.macd, signal: tf.macd.signal, histogram: tf.macd.histogram },
        last => last.macd === tf.macd.macd && last.signal === tf.macd.signal && last.histogram === tf.macd.histogram)
    }
    if (tf.williamsR != null) {
      append(setWrHistory, { wr: tf.williamsR }, last => last.wr === tf.williamsR)
    }
    if (tf.adx) {
      append(setAdxHistory, { adx: tf.adx.adx, plusDI: tf.adx.plusDI, minusDI: tf.adx.minusDI },
        last => last.adx === tf.adx.adx && last.plusDI === tf.adx.plusDI && last.minusDI === tf.adx.minusDI)
    }
    if (tf.obv) {
      append(setObvHistory, { slope: tf.obv.slope }, last => last.slope === tf.obv.slope)
    }
  }, [indicators, selectedTf])

  // Reset history when timeframe changes
  useEffect(() => {
    setRsiHistory([])
    setStochHistory([])
    setMacdHistory([])
    setWrHistory([])
    setAdxHistory([])
    setObvHistory([])
  }, [selectedTf])

  const currentTf = indicators?.[selectedTf]

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-yellow-400" />
          <h3 className="text-sm font-semibold">Indicators</h3>
        </div>
        {/* Timeframe selector */}
        <div className="flex gap-1">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => setSelectedTf(tf)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                selectedTf === tf
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Current values summary */}
      {currentTf && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4 text-xs">
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500 mb-0.5">RSI</div>
            <div className={`font-mono font-medium ${
              (currentTf.rsi ?? 50) > 70 ? 'text-red-400' : (currentTf.rsi ?? 50) < 30 ? 'text-green-400' : 'text-white'
            }`}>
              {currentTf.rsi?.toFixed(1) ?? '---'}
            </div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500 mb-0.5">Stoch K/D</div>
            <div className="font-mono font-medium text-white">
              {currentTf.stochastic?.k?.toFixed(1) ?? '---'} / {currentTf.stochastic?.d?.toFixed(1) ?? '---'}
            </div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500 mb-0.5">MACD</div>
            <div className={`font-mono font-medium ${
              (currentTf.macd?.histogram ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
            }`}>
              {currentTf.macd?.histogram?.toFixed(2) ?? '---'}
            </div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500 mb-0.5">Williams %R</div>
            <div className={`font-mono font-medium ${
              (currentTf.williamsR ?? -50) > -20 ? 'text-red-400' : (currentTf.williamsR ?? -50) < -80 ? 'text-green-400' : 'text-white'
            }`}>
              {currentTf.williamsR?.toFixed(1) ?? '---'}
            </div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500 mb-0.5">CCI</div>
            <div className={`font-mono font-medium ${
              (currentTf.cci ?? 0) > 100 ? 'text-red-400' : (currentTf.cci ?? 0) < -100 ? 'text-green-400' : 'text-white'
            }`}>
              {currentTf.cci?.toFixed(0) ?? '---'}
            </div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500 mb-0.5">ADX</div>
            <div className={`font-mono font-medium ${
              (currentTf.adx?.adx ?? 0) > 25 ? 'text-yellow-400' : 'text-white'
            }`}>
              {currentTf.adx?.adx?.toFixed(1) ?? '---'}
              <span className="text-gray-500 ml-1 text-[10px]">{currentTf.adx?.trending ? 'TREND' : 'RANGE'}</span>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {/* RSI Chart */}
        {rsiHistory.length >= 2 && (
          <div>
            <div className="text-xs text-gray-500 mb-1">RSI ({selectedTf})</div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={rsiHistory} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                  formatter={v => [v?.toFixed(1), 'RSI']}
                />
                <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line type="monotone" dataKey="rsi" stroke="#a855f7" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Stochastic Chart */}
        {stochHistory.length >= 2 && (
          <div>
            <div className="text-xs text-gray-500 mb-1">Stochastic ({selectedTf})</div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={stochHistory} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                  formatter={(v, name) => [v?.toFixed(1), name === 'k' ? '%K' : '%D']}
                />
                <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={20} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line type="monotone" dataKey="k" stroke="#3b82f6" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="d" stroke="#f97316" strokeWidth={1} dot={false} strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* MACD Chart */}
        {macdHistory.length >= 2 && (
          <div>
            <div className="text-xs text-gray-500 mb-1">MACD ({selectedTf})</div>
            <ResponsiveContainer width="100%" height={120}>
              <MacdLineChart data={macdHistory} />
            </ResponsiveContainer>
          </div>
        )}

        {/* Williams %R Chart */}
        {wrHistory.length >= 2 && (
          <div>
            <div className="text-xs text-gray-500 mb-1">Williams %R ({selectedTf})</div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={wrHistory} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
                <YAxis domain={[-100, 0]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                  formatter={v => [v?.toFixed(1), '%R']}
                />
                <ReferenceLine y={-20} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
                <ReferenceLine y={-80} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line type="monotone" dataKey="wr" stroke="#ec4899" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ADX Chart */}
        {adxHistory.length >= 2 && (
          <div>
            <div className="text-xs text-gray-500 mb-1">ADX / DI ({selectedTf})</div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={adxHistory} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
                <YAxis domain={[0, 'auto']} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                  formatter={(v, name) => [v?.toFixed(1), name === 'adx' ? 'ADX' : name === 'plusDI' ? '+DI' : '-DI']}
                />
                <ReferenceLine y={25} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Line type="monotone" dataKey="adx" stroke="#eab308" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="plusDI" stroke="#10b981" strokeWidth={1} dot={false} />
                <Line type="monotone" dataKey="minusDI" stroke="#ef4444" strokeWidth={1} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* OBV Slope Chart */}
        {obvHistory.length >= 2 && (
          <div>
            <div className="text-xs text-gray-500 mb-1">OBV Slope ({selectedTf})</div>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={obvHistory} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
                <YAxis domain={[-1, 1]} tick={{ fontSize: 9, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                  formatter={v => [v?.toFixed(3), 'OBV Slope']}
                />
                <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="slope" stroke="#06b6d4" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* No data state */}
        {!currentTf && (
          <div className="text-gray-500 text-sm text-center py-8">
            Waiting for indicator data ({selectedTf})...
          </div>
        )}
      </div>
    </div>
  )
}

// Separate MACD chart component to keep it clean
function MacdLineChart({ data }) {
  return (
    <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
      <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
      <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} width={40} />
      <Tooltip
        contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
        formatter={(v, name) => {
          const labels = { macd: 'MACD', signal: 'Signal', histogram: 'Histogram' }
          return [v?.toFixed(2), labels[name] || name]
        }}
      />
      <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
      <Line type="monotone" dataKey="macd" stroke="#3b82f6" strokeWidth={1.5} dot={false} />
      <Line type="monotone" dataKey="signal" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="3 3" />
      <Line type="monotone" dataKey="histogram" stroke="#10b981" strokeWidth={1} dot={false} />
    </LineChart>
  )
}
