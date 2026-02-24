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

  // Accumulate indicator history for selected timeframe
  useEffect(() => {
    const tf = indicators?.[selectedTf]
    if (!tf) return

    const now = Date.now()
    const label = new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

    if (tf.rsi != null) {
      setRsiHistory(prev => {
        const next = [...prev, { time: now, label, rsi: tf.rsi }]
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
      })
    }

    if (tf.stochastic) {
      setStochHistory(prev => {
        const next = [...prev, { time: now, label, k: tf.stochastic.k, d: tf.stochastic.d }]
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
      })
    }

    if (tf.macd) {
      setMacdHistory(prev => {
        const next = [...prev, { time: now, label, macd: tf.macd.macd, signal: tf.macd.signal, histogram: tf.macd.histogram }]
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next
      })
    }
  }, [indicators, selectedTf])

  // Reset history when timeframe changes
  useEffect(() => {
    setRsiHistory([])
    setStochHistory([])
    setMacdHistory([])
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 text-xs">
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
