import { useState, useEffect, useCallback } from 'react'
import { Link } from '../../lib/router'
import { ArrowLeft, RefreshCw } from '../icons'
import { CartesianChart } from '../charts/primitives/CartesianChart'
import { AXIS_TICK, GRID } from '../charts/chartUtils'
import { INDICATORS, INDICATOR_LABELS } from '../../../../shared/indicator-config.mjs'
import StatCard from '../StatCard'
import { TF_ORDER } from '../../utils/timeframes.mjs'
import { createRequestOwner } from '../../utils/requestOwner.mjs'
import usePolling from '../../hooks/usePolling'

const RANGES = [
  { label: '1d', days: 1 },
  { label: '3d', days: 3 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]
const INDICATOR_COLORS = {
  rsi: '#f97316', stochastic: '#06b6d4', macd: '#a855f7',
  bollinger: '#eab308', vwap: '#22c55e', momentum: '#ec4899',
  obv: '#14b8a6', williamsR: '#f43f5e', cci: '#84cc16',
}
const DEFAULT_TF_ORDER = [...TF_ORDER].reverse()

const TOOLTIP_STYLE = { backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }
const PERCENT_AXES = [{ domain: [0, 100], tick: AXIS_TICK }]
const HOUR_X_AXIS = { dataKey: 'hour', tick: AXIS_TICK, tickFormatter: formatHour }
const COIN_FLIP_LINE = [{ y: 50, stroke: '#6b7280', strokeDasharray: '4 4' }]
const LEGEND_STYLE = { fontSize: 11 }

function heatmapColor(accuracy) {
  if (accuracy == null) return 'bg-gray-700/50 text-gray-400'
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

export default function ScorecardAnalysis() {
  const [range, setRange] = useState(7)
  // The snapshot remembers which range it answers, so a range switch never
  // shows the previous range's numbers under the new selection.
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Range switches, the poll and manual refreshes overlap; only the newest
  // read may commit, so a slow response for an older range cannot win.
  const [owner] = useState(createRequestOwner)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const to = new Date()
    const from = new Date(to.getTime() - range * 86400000)
    const params = new URLSearchParams({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    })
    const { owned, data: json } = await owner.read(`/api/updown/scorecard-analysis?${params}`)
    if (!owned) return
    if (json) {
      setSnapshot({ range, data: json })
      setError(null)
    } else {
      setError('Could not load scorecard analysis.')
    }
    setLoading(false)
  }, [range, owner])

  useEffect(() => {
    setError(null)
  }, [fetchData, owner])
  usePolling(fetchData, 60000, {
    deps: [fetchData, owner],
    onCleanup: () => owner.invalidate(),
  })

  const data = snapshot?.range === range ? snapshot.data : null
  const s = data?.summary
  const indicatorCatalog = data?.catalog?.indicators
  const indicators = indicatorCatalog?.map(item => item.key) || INDICATORS
  const indicatorLabels = indicatorCatalog
    ? Object.fromEntries(indicatorCatalog.map(item => [item.key, item.label]))
    : INDICATOR_LABELS
  const timeframes = data?.catalog?.timeframes || DEFAULT_TF_ORDER
  const indicatorSeries = indicators.map(ind => ({ dataKey: ind, stroke: INDICATOR_COLORS[ind], strokeWidth: 1.5, connectNulls: true }))

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
              <div className="text-xs text-gray-400">Perp-long paper book + directional accuracy</div>
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
              aria-label="Refresh scorecard analysis"
              className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded-sm transition-colors text-gray-400 hover:text-white"
            >
              <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      {error && data && (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm text-red-400">
          <span>{error} Showing the last loaded analysis.</span>
          <button onClick={fetchData} disabled={loading} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-sm text-xs shrink-0">Retry</button>
        </div>
      )}

      {error && !data && !loading ? (
        <div role="alert" className="bg-gray-800 rounded-lg p-8 border border-gray-700 text-center">
          <p className="text-red-400">{error}</p>
          <button onClick={fetchData} className="mt-3 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-sm text-sm">Retry</button>
        </div>
      ) : !data ? (
        <div className="flex items-center justify-center h-48 text-gray-400">Loading analysis...</div>
      ) : !data.summary ? (
        <div className="bg-gray-800 rounded-lg p-8 border border-gray-700 text-center text-gray-400">
          No scorecard data found for this date range.
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard
              label="Perp P&L"
              value={s.perpRealizedPnl != null
                ? s.perpRealizedPnl.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
                : null}
              subtext={s.perpRounds ? `${s.perpRounds} closed rounds` : '0.01 BTC / Open or Add'}
            />
            <StatCard
              label="Perp Win Rate"
              value={s.perpWinRate != null ? `${s.perpWinRate}%` : null}
              subtext={data.perpAnalysis ? `${data.perpAnalysis.wins}W / ${data.perpAnalysis.losses}L` : null}
            />
            <StatCard
              label="Directional Accuracy"
              value={s.perpDirectionalAccuracy != null ? `${s.perpDirectionalAccuracy}%` : null}
              subtext={`${s.outcomes} options-style outcomes`}
            />
            <StatCard label="Predictions" value={s.predictions} />
            <StatCard
              label="Best Indicator"
              value={s.bestIndicator ? indicatorLabels[s.bestIndicator] || s.bestIndicator : null}
            />
          </div>

          {/* Accuracy Over Time */}
          {data.accuracyOverTime?.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Accuracy Over Time</h3>
              <div className="h-48">
                <CartesianChart
                  data={data.accuracyOverTime}
                  height="100%"
                  grid={GRID}
                  xAxis={HOUR_X_AXIS}
                  yAxes={PERCENT_AXES}
                  tooltip={{ contentStyle: TOOLTIP_STYLE, labelFormatter: formatHour, formatter: (v) => [`${v}%`, 'Accuracy'] }}
                  referenceLines={COIN_FLIP_LINE}
                  series={[{ type: 'area', dataKey: 'accuracy', stroke: '#3b82f6', fill: '#3b82f680', strokeWidth: 2 }]}
                />
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
                  <div className="grid gap-1" style={{ gridTemplateColumns: `80px repeat(${timeframes.length}, 1fr)` }}>
                    <div />
                    {timeframes.map(tf => (
                      <div key={tf} className="text-center text-xs text-gray-400 font-medium py-1">{tf}</div>
                    ))}
                  </div>
                  {/* Data rows */}
                  {indicators.map(ind => (
                    <div key={ind} className="grid gap-1 mb-1" style={{ gridTemplateColumns: `80px repeat(${timeframes.length}, 1fr)` }}>
                      <div className="text-xs text-gray-400 flex items-center">{indicatorLabels[ind]}</div>
                      {timeframes.map(tf => {
                        const cell = data.heatmap[ind]?.[tf]
                        return (
                          <div
                            key={tf}
                            className={`text-center p-1.5 rounded-sm text-xs font-mono ${heatmapColor(cell?.accuracy)}`}
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
                <CartesianChart
                  data={data.indicatorAccuracyOverTime}
                  height="100%"
                  grid={GRID}
                  xAxis={HOUR_X_AXIS}
                  yAxes={PERCENT_AXES}
                  tooltip={{
                    contentStyle: TOOLTIP_STYLE,
                    labelFormatter: formatHour,
                    formatter: (v, name) => [v != null ? `${v}%` : '---', indicatorLabels[name] || name],
                  }}
                  legend={{ formatter: (value) => indicatorLabels[value] || value, wrapperStyle: LEGEND_STYLE }}
                  referenceLines={COIN_FLIP_LINE}
                  series={indicatorSeries}
                />
              </div>
            </div>
          )}

          {/* Weight Evolution */}
          {data.weightEvolution?.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-3">Weight Evolution</h3>
              <div className="h-48">
                <CartesianChart
                  data={data.weightEvolution}
                  height="100%"
                  grid={GRID}
                  xAxis={{ dataKey: 'ts', tick: AXIS_TICK, tickFormatter: (v) => v?.slice(11, 16) || '' }}
                  yAxes={[{ tick: AXIS_TICK, domain: [0, 'auto'] }]}
                  tooltip={{
                    contentStyle: TOOLTIP_STYLE,
                    labelFormatter: (v) => v?.slice(0, 16)?.replace('T', ' ') || '',
                    formatter: (v, name) => [(v * 100).toFixed(1) + '%', indicatorLabels[name] || name],
                  }}
                  legend={{ formatter: (value) => indicatorLabels[value] || value, wrapperStyle: LEGEND_STYLE }}
                  series={indicatorSeries}
                />
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
                    <tr className="text-gray-400 border-b border-gray-700">
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
                                className="px-1.5 py-0.5 rounded-sm text-xs font-medium"
                                style={{ backgroundColor: INDICATOR_COLORS[ind] + '30', color: INDICATOR_COLORS[ind] }}
                              >
                                {indicatorLabels[ind] || ind}
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
