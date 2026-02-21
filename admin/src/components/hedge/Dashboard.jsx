import { useState, useEffect, useCallback, useMemo } from 'react'
import { Shield, Play, Square, RefreshCw, TrendingUp, TrendingDown, Activity, AlertTriangle, Clock, DollarSign, BarChart3, Target, Zap } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine, Area, AreaChart, CartesianGrid } from 'recharts'
import BTCPriceChart from '../charts/BTCPriceChart'
import { formatBTCPrice } from '../charts/chartUtils'

function formatCurrency(value) {
  if (value == null) return '---'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

function formatPct(value, decimals = 2) {
  if (value == null) return '---'
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`
}

function formatTime(iso) {
  if (!iso) return '---'
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })
}

function formatTimeAgo(ms) {
  if (!ms) return '---'
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function formatCountdown(iso) {
  if (!iso) return '---'
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Settled'
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// ====== Stat Card ======
function StatCard({ label, value, subValue, icon: Icon, color = 'gray', pulse = false }) {
  const colorMap = {
    green: 'bg-green-500/10 border-green-500/20 text-green-400',
    red: 'bg-red-500/10 border-red-500/20 text-red-400',
    blue: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    yellow: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
    purple: 'bg-purple-500/10 border-purple-500/20 text-purple-400',
    gray: 'bg-gray-800/50 border-gray-700 text-gray-400',
  }

  return (
    <div className={`rounded-lg border p-3 ${colorMap[color]}`}>
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon size={14} className="opacity-60" />}
        <span className="text-xs opacity-70">{label}</span>
        {pulse && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
      </div>
      <div className="text-lg font-bold text-white">{value}</div>
      {subValue && <div className="text-xs mt-0.5 opacity-60">{subValue}</div>}
    </div>
  )
}

// ====== Active Pair Monitor ======
function ActivePairMonitor({ pair, btcPrice }) {
  if (!pair) return null

  const entryPrice = pair.exchange?.entryPrice || 0
  const pctFromEntry = entryPrice > 0 ? ((btcPrice - entryPrice) / entryPrice) * 100 : 0
  const unrealizedPnl = (pair.exchange?.btcAmount || 0) * (btcPrice - entryPrice)

  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-blue-500/30">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-blue-400" />
          <h3 className="text-base font-semibold">Active Position</h3>
        </div>
        <span className="px-2 py-0.5 text-xs rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
          {pair.exitMode}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div>
          <div className="text-xs text-gray-400">Entry Price</div>
          <div className="text-sm font-medium">{formatCurrency(entryPrice)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-400">Current</div>
          <div className={`text-sm font-medium ${pctFromEntry >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatCurrency(btcPrice)} ({formatPct(pctFromEntry)})
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-400">Unrealized P&L</div>
          <div className={`text-sm font-medium ${unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatCurrency(unrealizedPnl)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-400">Size</div>
          <div className="text-sm font-medium">{pair.exchange?.btcAmount} BTC</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div>
          <div className="text-xs text-gray-400">Stop Loss</div>
          <div className="text-sm text-red-400">{formatCurrency(pair.exchange?.stopPrice)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-400">Take Profit</div>
          <div className="text-sm text-green-400">{formatCurrency(pair.exchange?.tpPrice)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-400">MAE / MFE</div>
          <div className="text-sm">
            <span className="text-red-400">{formatPct(pair.exchange?.mae)}</span>
            {' / '}
            <span className="text-green-400">{formatPct(pair.exchange?.mfe)}</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-400">Opened</div>
          <div className="text-sm">{formatTime(pair.openedAt)}</div>
        </div>
      </div>

      {/* Kalshi hedge leg */}
      <div className="border-t border-gray-700 pt-3 mt-1">
        <div className="flex items-center gap-2 mb-2">
          <Shield size={14} className="text-purple-400" />
          <span className="text-xs text-gray-400 font-medium">Kalshi Hedge</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <div className="text-xs text-gray-400">Contract</div>
            <div className="text-sm font-mono text-purple-300 truncate" title={pair.kalshi?.ticker}>
              {pair.kalshi?.ticker?.split('-').slice(0, 2).join('-') || '---'}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-400">Contracts</div>
            <div className="text-sm">{pair.kalshi?.contracts || 0} NO @ {pair.kalshi?.entryPriceCents || 0}c</div>
          </div>
          <div>
            <div className="text-xs text-gray-400">Premium Paid</div>
            <div className="text-sm">{formatCurrency((pair.kalshi?.contracts * pair.kalshi?.entryPriceCents) / 100)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400">Settles In</div>
            <div className="text-sm font-mono">{formatCountdown(pair.kalshi?.closeTime)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ====== Trade History Table ======
function TradeHistory({ pairs }) {
  if (!pairs?.length) {
    return (
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-base font-semibold mb-3">Trade History</h3>
        <div className="text-gray-500 text-sm text-center py-8">No completed trades yet</div>
      </div>
    )
  }

  const resultColors = {
    tp_win: 'text-green-400 bg-green-500/10',
    sl_hedged: 'text-blue-400 bg-blue-500/10',
    double_loss: 'text-red-400 bg-red-500/10',
    settlement_exit: 'text-yellow-400 bg-yellow-500/10',
    manual_exit: 'text-gray-400 bg-gray-500/10',
  }

  const resultLabels = {
    tp_win: 'TP Win',
    sl_hedged: 'SL Hedged',
    double_loss: 'Double Loss',
    settlement_exit: 'Settlement',
    manual_exit: 'Manual',
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-base font-semibold mb-3">Trade History</h3>
      <div className="overflow-x-auto -mx-4 px-4" style={{ WebkitOverflowScrolling: 'touch' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left text-xs border-b border-gray-700">
              <th className="pb-2 pr-3">Time</th>
              <th className="pb-2 pr-3">Entry</th>
              <th className="pb-2 pr-3">Exit</th>
              <th className="pb-2 pr-3">BTC P&L</th>
              <th className="pb-2 pr-3">Kalshi P&L</th>
              <th className="pb-2 pr-3">Net P&L</th>
              <th className="pb-2 pr-3">MAE/MFE</th>
              <th className="pb-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {pairs.slice().reverse().slice(0, 50).map((pair, i) => (
              <tr key={pair.id || i} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td className="py-2 pr-3 text-xs text-gray-400">{formatTime(pair.openedAt)}</td>
                <td className="py-2 pr-3">{formatCurrency(pair.exchange?.entryPrice)}</td>
                <td className="py-2 pr-3">{formatCurrency(pair.exchange?.exitPrice)}</td>
                <td className={`py-2 pr-3 ${(pair.pnl?.exchangePnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(pair.pnl?.exchangePnl)}
                </td>
                <td className={`py-2 pr-3 ${(pair.pnl?.kalshiPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(pair.pnl?.kalshiPnl)}
                </td>
                <td className={`py-2 pr-3 font-medium ${(pair.pnl?.netPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(pair.pnl?.netPnl)}
                </td>
                <td className="py-2 pr-3 text-xs">
                  <span className="text-red-400">{formatPct(pair.exchange?.mae, 1)}</span>
                  {' / '}
                  <span className="text-green-400">{formatPct(pair.exchange?.mfe, 1)}</span>
                </td>
                <td className="py-2">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${resultColors[pair.resultType] || 'text-gray-400 bg-gray-500/10'}`}>
                    {resultLabels[pair.resultType] || pair.resultType || '---'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ====== Decision Report Panel ======
function DecisionReport({ report }) {
  if (!report || report.status === 'insufficient_data') {
    return null
  }

  const statusColors = {
    go: 'border-green-500/30 bg-green-500/5',
    no_go: 'border-red-500/30 bg-red-500/5',
    caution: 'border-yellow-500/30 bg-yellow-500/5',
  }

  const statusIcons = {
    go: <TrendingUp className="text-green-400" size={18} />,
    no_go: <AlertTriangle className="text-red-400" size={18} />,
    caution: <AlertTriangle className="text-yellow-400" size={18} />,
  }

  return (
    <div className={`rounded-lg border p-4 ${statusColors[report.status] || 'border-gray-700'}`}>
      <div className="flex items-center gap-2 mb-3">
        {statusIcons[report.status]}
        <h3 className="text-base font-semibold">Decision Report</h3>
      </div>
      <div className="text-sm font-medium mb-3">{report.recommendation}</div>

      {report.issues?.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-gray-400 mb-1">Issues</div>
          <ul className="text-sm space-y-1">
            {report.issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2">
                <AlertTriangle size={12} className="text-yellow-400 mt-0.5 shrink-0" />
                <span className="text-gray-300">{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div className="text-gray-400">Double-Loss Rate</div>
          <div className={`font-medium ${(report.rates?.doubleLossRate ?? 0) > 0.1 ? 'text-red-400' : 'text-green-400'}`}>
            {((report.rates?.doubleLossRate ?? 0) * 100).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-gray-400">Hedge Success Rate</div>
          <div className="font-medium text-blue-400">{((report.rates?.hedgeSuccessRate ?? 0) * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-gray-400">Win Rate</div>
          <div className="font-medium">{((report.rates?.winRate ?? 0) * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-gray-400">Skip Rate</div>
          <div className="font-medium">{((report.rates?.skipRate ?? 0) * 100).toFixed(1)}%</div>
        </div>
      </div>
    </div>
  )
}

// ====== P&L Equity Curve ======
function EquityCurve({ pairs }) {
  const chartData = useMemo(() => {
    if (!pairs?.length) return []
    let cumPnl = 0
    return pairs.map((p, i) => {
      cumPnl += p.pnl?.netPnl ?? 0
      return {
        trade: i + 1,
        pnl: cumPnl,
        netPnl: p.pnl?.netPnl ?? 0,
        time: p.closedAt || p.openedAt,
      }
    })
  }, [pairs])

  if (chartData.length < 2) return null

  const minPnl = Math.min(...chartData.map(d => d.pnl))
  const maxPnl = Math.max(...chartData.map(d => d.pnl))

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-base font-semibold mb-3">Equity Curve</h3>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis dataKey="trade" tick={{ fontSize: 11, fill: '#9ca3af' }} />
          <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} domain={[Math.min(minPnl, 0), Math.max(maxPnl, 0)]} tickFormatter={v => `$${v.toFixed(0)}`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
            labelStyle={{ color: '#9ca3af' }}
            formatter={(value) => [formatCurrency(value), 'Cumulative P&L']}
          />
          <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
          <defs>
            <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="pnl" stroke="#10b981" fill="url(#pnlGradient)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ====== Main Dashboard ======
export default function HedgeDashboard() {
  const [status, setStatus] = useState(null)
  const [state, setState] = useState(null)
  const [config, setConfig] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState(null)

  const fetchAll = useCallback(async () => {
    const results = await Promise.all([
      fetch('/api/hedge/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/hedge/state').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/hedge/config').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/hedge/report').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
    setStatus(results[0])
    setState(results[1])
    setConfig(results[2])
    setReport(results[3])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 5000)
    return () => clearInterval(interval)
  }, [fetchAll])

  const handleStart = async () => {
    setStarting(true)
    setError(null)
    const res = await fetch('/api/hedge/start', { method: 'POST' })
    const data = await res.json()
    if (!res.ok || data.error) {
      setError(data.error || 'Failed to start')
    }
    setStarting(false)
    fetchAll()
  }

  const handleStop = async () => {
    setStopping(true)
    await fetch('/api/hedge/stop', { method: 'POST' })
    setStopping(false)
    fetchAll()
  }

  const handleSaveReport = async () => {
    await fetch('/api/hedge/report/save', { method: 'POST' })
    fetchAll()
  }

  const isRunning = status?.running || false
  const isDryRun = status?.dryRun ?? config?.dryRun ?? true
  const activePair = status?.activePair || null
  const dailyStats = status?.dailyStats || state?.dailyStats || {}
  const aggregateStats = status?.aggregateStats || state?.aggregateStats || {}
  const closedPairs = state?.closedPairs || []
  const btcPrice = status?.lastBtcPrice || 0

  // Reference lines for the BTC price chart (entry, stop loss, take profit from active pair)
  const hedgeReferenceLines = useMemo(() => {
    const lines = []
    if (activePair?.exchange?.entryPrice) {
      lines.push({
        y: activePair.exchange.entryPrice,
        stroke: '#3b82f6',
        strokeDasharray: '6 3',
        label: `Entry ${formatBTCPrice(activePair.exchange.entryPrice)}`,
        labelFill: '#3b82f6',
      })
    }
    if (activePair?.exchange?.stopPrice) {
      lines.push({
        y: activePair.exchange.stopPrice,
        stroke: '#ef4444',
        strokeDasharray: '3 3',
        label: `SL ${formatBTCPrice(activePair.exchange.stopPrice)}`,
        labelFill: '#ef4444',
      })
    }
    if (activePair?.exchange?.tpPrice) {
      lines.push({
        y: activePair.exchange.tpPrice,
        stroke: '#10b981',
        strokeDasharray: '3 3',
        label: `TP ${formatBTCPrice(activePair.exchange.tpPrice)}`,
        labelFill: '#10b981',
      })
    }
    return lines
  }, [activePair?.exchange?.entryPrice, activePair?.exchange?.stopPrice, activePair?.exchange?.tpPrice])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading hedge engine...</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Error banner */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-200 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 ml-3">&times;</button>
        </div>
      )}

      {/* Top Controls */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Shield size={24} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-bold">Hedge Engine</h2>
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <span>BTC Spot + Kalshi Insurance</span>
                {config && <span>| {config.position?.btcAmount} BTC | SL {config.stopLoss?.percentFromEntry}% | TP {config.takeProfit?.percentFromEntry}%</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isDryRun && (
              <span className="px-2 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-xs font-medium rounded">
                DRY-RUN
              </span>
            )}
            <div className="flex items-center gap-1.5 text-sm">
              <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
              <span className={isRunning ? 'text-green-400' : 'text-gray-400'}>
                {isRunning ? 'Running' : 'Stopped'}
              </span>
            </div>
            {btcPrice > 0 && (
              <span className="text-sm font-mono text-gray-300">
                BTC {formatCurrency(btcPrice)}
              </span>
            )}
            <button
              onClick={fetchAll}
              className="p-2 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
            {isRunning ? (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 rounded text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                <Square size={14} />
                {stopping ? '...' : 'Stop'}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={starting}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-green-800 rounded text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                <Play size={14} />
                {starting ? '...' : 'Start'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* BTC Price Chart */}
      <BTCPriceChart
        exchange="cryptocom"
        tickPrice={btcPrice || undefined}
        referenceLines={hedgeReferenceLines}
        height={200}
        defaultView="6h"
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard
          label="Today P&L"
          value={formatCurrency(dailyStats.pnl)}
          subValue={`${dailyStats.wins || 0}W / ${dailyStats.losses || 0}L`}
          icon={DollarSign}
          color={(dailyStats.pnl ?? 0) >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Total P&L"
          value={formatCurrency(aggregateStats.totalPnl)}
          subValue={`${aggregateStats.totalPairs || 0} trades`}
          icon={BarChart3}
          color={(aggregateStats.totalPnl ?? 0) >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Hedge Drag"
          value={formatCurrency(aggregateStats.hedgeDrag)}
          subValue="premiums - payouts"
          icon={Shield}
          color={(aggregateStats.hedgeDrag ?? 0) > 0 ? 'yellow' : 'green'}
        />
        <StatCard
          label="Double-Loss Rate"
          value={`${((aggregateStats.doubleLossRate ?? 0) * 100).toFixed(1)}%`}
          subValue={`${dailyStats.doubleLosses || 0} today`}
          icon={AlertTriangle}
          color={(aggregateStats.doubleLossRate ?? 0) > 0.1 ? 'red' : 'green'}
        />
        <StatCard
          label="Hedge Success"
          value={`${((aggregateStats.hedgeSuccessRate ?? 0) * 100).toFixed(1)}%`}
          subValue={`${dailyStats.hedgeSuccesses || 0} today`}
          icon={Target}
          color={(aggregateStats.hedgeSuccessRate ?? 0) > 0.3 ? 'green' : 'gray'}
        />
        <StatCard
          label="Today Pairs"
          value={`${dailyStats.pairs || 0} / ${config?.risk?.maxDailyPairs || 10}`}
          subValue={`skip: ${((aggregateStats.skipRate ?? 0) * 100).toFixed(0)}%`}
          icon={Zap}
          color="blue"
          pulse={isRunning}
        />
      </div>

      {/* Active Pair Monitor */}
      {activePair && (
        <ActivePairMonitor pair={activePair} btcPrice={btcPrice} />
      )}

      {/* No active pair indicator */}
      {isRunning && !activePair && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="flex items-center gap-3 text-gray-400">
            <Clock size={18} className="animate-pulse" />
            <div>
              <div className="text-sm font-medium">Evaluating markets...</div>
              <div className="text-xs">
                {state?.consecutiveLosses > 0 && (
                  <span className="text-yellow-400 mr-3">
                    {state.consecutiveLosses} consecutive losses
                  </span>
                )}
                <span>Evaluated: {dailyStats.evaluated || 0} | Skipped: {dailyStats.skipped || 0}</span>
                {state?.lastEntryTime && (
                  <span className="ml-3">Last entry: {formatTimeAgo(state.lastEntryTime)}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Equity Curve */}
      <EquityCurve pairs={closedPairs} />

      {/* Decision Report */}
      {report && report.status !== 'insufficient_data' && (
        <div>
          <DecisionReport report={report} />
          <div className="flex justify-end mt-2">
            <button
              onClick={handleSaveReport}
              className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              Save Report to Disk
            </button>
          </div>
        </div>
      )}

      {/* Detailed Stats */}
      {closedPairs.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-base font-semibold mb-3">P&L Breakdown</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Exchange P&L</span>
                <span className={`font-medium ${(report?.pnl?.totalExchangePnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(report?.pnl?.totalExchangePnl)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Kalshi P&L</span>
                <span className={`font-medium ${(report?.pnl?.totalKalshiPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(report?.pnl?.totalKalshiPnl)}
                </span>
              </div>
              <div className="flex justify-between border-t border-gray-700 pt-2">
                <span className="text-gray-400">Net P&L</span>
                <span className={`font-bold ${(report?.pnl?.totalNetPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatCurrency(report?.pnl?.totalNetPnl)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Avg P&L / Trade</span>
                <span className="font-medium">{formatCurrency(report?.pnl?.avgPnlPerTrade)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Hedge Drag</span>
                <span className="font-medium text-yellow-400">{formatCurrency(report?.pnl?.hedgeDrag)}</span>
              </div>
            </div>
          </div>
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-base font-semibold mb-3">Result Distribution</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-green-400">TP Wins</span>
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-gray-700 rounded-full h-2">
                    <div className="bg-green-500 h-2 rounded-full" style={{ width: `${((report?.summary?.tpWins ?? 0) / Math.max(closedPairs.length, 1)) * 100}%` }} />
                  </div>
                  <span className="font-medium w-8 text-right">{report?.summary?.tpWins || 0}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-blue-400">SL Hedged</span>
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-gray-700 rounded-full h-2">
                    <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${((report?.summary?.slHedged ?? 0) / Math.max(closedPairs.length, 1)) * 100}%` }} />
                  </div>
                  <span className="font-medium w-8 text-right">{report?.summary?.slHedged || 0}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-red-400">Double Loss</span>
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-gray-700 rounded-full h-2">
                    <div className="bg-red-500 h-2 rounded-full" style={{ width: `${((report?.summary?.doubleLosses ?? 0) / Math.max(closedPairs.length, 1)) * 100}%` }} />
                  </div>
                  <span className="font-medium w-8 text-right">{report?.summary?.doubleLosses || 0}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-yellow-400">Settlement Exit</span>
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-gray-700 rounded-full h-2">
                    <div className="bg-yellow-500 h-2 rounded-full" style={{ width: `${((report?.summary?.settlementExits ?? 0) / Math.max(closedPairs.length, 1)) * 100}%` }} />
                  </div>
                  <span className="font-medium w-8 text-right">{report?.summary?.settlementExits || 0}</span>
                </div>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-400">
              Avg MAE: <span className="text-red-400">{formatPct(report?.excursions?.avgMAE, 2)}</span>
              {' | '}
              Avg MFE: <span className="text-green-400">{formatPct(report?.excursions?.avgMFE, 2)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Trade History */}
      <TradeHistory pairs={closedPairs} />
    </div>
  )
}
