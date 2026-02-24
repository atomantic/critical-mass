import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid, Legend,
} from 'recharts'

const RANGES = [
  { label: '1d', days: 1 },
  { label: '3d', days: 3 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]

const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum']
const INDICATOR_LABELS = {
  rsi: 'RSI', stochastic: 'Stoch', macd: 'MACD',
  bollinger: 'Bollinger', vwap: 'VWAP', momentum: 'Momentum',
}
const INDICATOR_COLORS = {
  rsi: '#f97316', stochastic: '#06b6d4', macd: '#a855f7',
  bollinger: '#eab308', vwap: '#22c55e', momentum: '#ec4899',
}
const TF_ORDER = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d']

function heatmapColor(accuracy) {
  if (accuracy == null) return 'bg-gray-700/50 text-gray-600'
  if (accuracy >= 60) return 'bg-green-900/60 text-green-300'
  if (accuracy >= 50) return 'bg-yellow-900/50 text-yellow-300'
  if (accuracy >= 45) return 'bg-orange-900/50 text-orange-300'
  return 'bg-red-900/50 text-red-300'
}

function formatHour(hour) {
  if (!hour) return ''
  // hour = "YYYY-MM-DDTHH"
  const parts = hour.split('T')
  if (parts.length < 2) return hour
  return `${parts[0].slice(5)} ${parts[1]}:00`
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-bold font-mono text-white">{value ?? '---'}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function ScorecardAnalysis() {
  const [range, setRange] = useState(7)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const to = new Date()
    const from = new Date(to.getTime() - range * 86400000)
    const params = new URLSearchParams({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    })
    const res = await fetch(`/api/updown/scorecard-analysis?${params}`).catch(() => null)
    if (res?.ok) {
      const json = await res.json()
      setData(json)
    }
    setLoading(false)
  }, [range])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60000)
    return () => clearInterval(interval)
  }, [fetchData])

  const s = data?.summary

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/updown" className="text-gray-400 hover:text-white transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <div>
              <h2 className="text-lg font-bold">Scorecard Analysis</h2>
              <div className="text-xs text-gray-400">Historical prediction performance</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {RANGES.map(r => (
              <button
                key={r.days}
                onClick={() => setRange(r.days)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  range === r.days
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={fetchData}
              disabled={loading}
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors text-gray-400 hover:text-white"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading analysis...</div>
      ) : !data?.summary ? (
        <div className="bg-gray-800 rounded-lg p-8 border border-gray-700 text-center text-gray-500">
          No scorecard data found for this date range.
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard
              label="Overall Accuracy"
              value={s.accuracy != null ? `${s.accuracy}%` : null}
              sub={`${s.outcomes} evaluated`}
            />
            <StatCard label="Predictions" value={s.predictions} />
            <StatCard
              label="Best Indicator"
              value={s.bestIndicator ? INDICATOR_LABELS[s.bestIndicator] || s.bestIndicator : null}
            />
            <StatCard label="Best Timeframe" value={s.bestTimeframe} />
            <StatCard label="Best Window" value={s.bestWindow} />
          </div>

          {/* Accuracy Over Time */}
          {data.accuracyOverTime?.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Accuracy Over Time</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.accuracyOverTime}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={formatHour} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={formatHour}
                      formatter={(v) => [`${v}%`, 'Accuracy']}
                    />
                    <ReferenceLine y={50} stroke="#6b7280" strokeDasharray="4 4" />
                    <Area
                      type="monotone"
                      dataKey="accuracy"
                      stroke="#3b82f6"
                      fill="#3b82f680"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Indicator × Timeframe Heatmap */}
          {data.heatmap && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Indicator × Timeframe Accuracy</h3>
              <div className="overflow-x-auto">
                <div className="min-w-[600px]">
                  {/* Header row */}
                  <div className="grid gap-1" style={{ gridTemplateColumns: `80px repeat(${TF_ORDER.length}, 1fr)` }}>
                    <div />
                    {TF_ORDER.map(tf => (
                      <div key={tf} className="text-center text-xs text-gray-400 font-medium py-1">{tf}</div>
                    ))}
                  </div>
                  {/* Data rows */}
                  {INDICATORS.map(ind => (
                    <div key={ind} className="grid gap-1 mb-1" style={{ gridTemplateColumns: `80px repeat(${TF_ORDER.length}, 1fr)` }}>
                      <div className="text-xs text-gray-400 flex items-center">{INDICATOR_LABELS[ind]}</div>
                      {TF_ORDER.map(tf => {
                        const cell = data.heatmap[ind]?.[tf]
                        return (
                          <div
                            key={tf}
                            className={`text-center p-1.5 rounded text-xs font-mono ${heatmapColor(cell?.accuracy)}`}
                            title={cell?.total > 0 ? `${cell.correct}/${cell.total}` : 'No data'}
                          >
                            {cell?.accuracy != null ? `${cell.accuracy.toFixed(0)}%` : '---'}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Indicator Accuracy Over Time */}
          {data.indicatorAccuracyOverTime?.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Indicator Accuracy Trends</h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.indicatorAccuracyOverTime}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={formatHour} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={formatHour}
                      formatter={(v, name) => [v != null ? `${v}%` : '---', INDICATOR_LABELS[name] || name]}
                    />
                    <Legend
                      formatter={(value) => INDICATOR_LABELS[value] || value}
                      wrapperStyle={{ fontSize: 11 }}
                    />
                    <ReferenceLine y={50} stroke="#6b7280" strokeDasharray="4 4" />
                    {INDICATORS.map(ind => (
                      <Line
                        key={ind}
                        type="monotone"
                        dataKey={ind}
                        stroke={INDICATOR_COLORS[ind]}
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Weight Evolution */}
          {data.weightEvolution?.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Weight Evolution</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.weightEvolution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis
                      dataKey="ts"
                      tick={{ fontSize: 10, fill: '#9ca3af' }}
                      tickFormatter={(v) => v?.slice(11, 16) || ''}
                    />
                    <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} domain={[0, 'auto']} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(v) => v?.slice(0, 16)?.replace('T', ' ') || ''}
                      formatter={(v, name) => [(v * 100).toFixed(1) + '%', INDICATOR_LABELS[name] || name]}
                    />
                    <Legend
                      formatter={(value) => INDICATOR_LABELS[value] || value}
                      wrapperStyle={{ fontSize: 11 }}
                    />
                    {INDICATORS.map(ind => (
                      <Line
                        key={ind}
                        type="monotone"
                        dataKey={ind}
                        stroke={INDICATOR_COLORS[ind]}
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Failure Patterns */}
          {data.failurePatterns?.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Failure Patterns</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700">
                      <th className="text-left py-2 pr-4">Indicators</th>
                      <th className="text-right py-2 px-2">Failure Rate</th>
                      <th className="text-right py-2 px-2">Failures</th>
                      <th className="text-right py-2 pl-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.failurePatterns.map((p, i) => (
                      <tr key={i} className="border-b border-gray-700/50">
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {p.indicators.map(ind => (
                              <span
                                key={ind}
                                className="px-1.5 py-0.5 rounded text-xs font-medium"
                                style={{ backgroundColor: INDICATOR_COLORS[ind] + '30', color: INDICATOR_COLORS[ind] }}
                              >
                                {INDICATOR_LABELS[ind] || ind}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="text-right py-2 px-2 font-mono text-red-400">{p.failureRate}%</td>
                        <td className="text-right py-2 px-2 font-mono text-gray-300">{p.failures}</td>
                        <td className="text-right py-2 pl-2 font-mono text-gray-400">{p.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
