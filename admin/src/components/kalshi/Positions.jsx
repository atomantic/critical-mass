import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, TrendingUp, ExternalLink, ChevronDown, ChevronUp, History, Target } from 'lucide-react'

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0)
}

function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ${diffMins % 60}m ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTimestamp(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

const ACTION_STYLES = {
  buy: 'bg-blue-900/50 text-blue-300',
  sell: 'bg-orange-900/50 text-orange-300',
  settlement: 'bg-purple-900/50 text-purple-300',
}

const ITEMS_PER_PAGE = 25

export default function Positions() {
  const [positions, setPositions] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [historyFilter, setHistoryFilter] = useState('completed') // 'completed' | 'all'
  const [strategySortDir, setStrategySortDir] = useState('desc')
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE)

  const fetchData = async () => {
    setLoading(true)
    setError(null)

    const [posRes, analyticsRes] = await Promise.all([
      fetch('/api/kalshi/positions'),
      fetch('/api/kalshi/analytics?limit=500'),
    ])

    if (!posRes.ok) {
      const data = await posRes.json().catch(() => ({}))
      setError(data.error || 'Failed to fetch positions')
      setLoading(false)
      return
    }

    const posData = await posRes.json().catch(() => ({}))
    // Filter out settled positions with 0 contracts (historical entries from API)
    const activePositions = (posData.positions || []).filter(p => Math.abs(p.position || 0) > 0)
    setPositions(activePositions)

    if (analyticsRes.ok) {
      const aData = await analyticsRes.json().catch(() => ({}))
      setAnalytics(aData)
    }

    setLoading(false)
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 15000)
    return () => clearInterval(interval)
  }, [])

  const totalValue = positions.reduce((sum, pos) => {
    const value = Math.abs(pos.position || 0) * ((pos.market_exposure || 0) / 100)
    return sum + value
  }, 0)

  const summary = analytics?.summary ?? {}
  const recentTrades = analytics?.recentTrades ?? []

  const filteredTrades = useMemo(() => {
    if (historyFilter === 'completed') {
      return recentTrades.filter(t => t.action === 'sell' || t.action === 'settlement')
    }
    return recentTrades
  }, [recentTrades, historyFilter])

  const visibleTrades = filteredTrades.slice(0, visibleCount)
  const hasMore = visibleCount < filteredTrades.length

  const strategyEntries = useMemo(() => {
    const entries = Object.entries(analytics?.byStrategy ?? {})
    return entries.sort((a, b) => {
      const valA = a[1].pnl ?? 0
      const valB = b[1].pnl ?? 0
      return strategySortDir === 'desc' ? valB - valA : valA - valB
    })
  }, [analytics?.byStrategy, strategySortDir])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Positions</h1>
        <button
          onClick={fetchData}
          disabled={loading}
          className="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400">Open</div>
          <div className="text-xl font-bold">{positions.length}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400">Exposure</div>
          <div className="text-xl font-bold">{formatCurrency(totalValue)}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400">Realized P&L</div>
          <div className={`text-xl font-bold ${(summary.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatCurrency(summary.totalPnl)}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400">Win Rate</div>
          <div className="text-xl font-bold">{summary.winRate ?? 0}%</div>
          <div className="text-xs text-gray-500">{summary.wins ?? 0}W / {summary.losses ?? 0}L</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400">Fees</div>
          <div className="text-xl font-bold text-yellow-400">{formatCurrency(summary.totalFees)}</div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Open Positions */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Target size={18} className="text-blue-400" />
          <h2 className="text-lg font-semibold">Open Positions</h2>
          <span className="text-sm text-gray-400">({positions.length})</span>
        </div>

        {loading && positions.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="text-gray-400">Loading positions...</div>
          </div>
        ) : positions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400 bg-gray-800/50 rounded-lg">
            <TrendingUp size={32} className="mb-2 opacity-50" />
            <p className="text-sm">No open positions</p>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-gray-400 text-left text-xs border-b border-gray-700">
                    <th className="p-3">Market</th>
                    <th className="p-3">Side</th>
                    <th className="p-3">Contracts</th>
                    <th className="p-3">Avg Price</th>
                    <th className="p-3">Exposure</th>
                    <th className="p-3">P&L</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos, i) => {
                    const isYes = (pos.position || 0) > 0
                    const contracts = Math.abs(pos.position || 0)
                    const avgPrice = pos.average_price || pos.avgPrice || 0
                    const exposure = (pos.market_exposure || 0) / 100
                    const pnl = (pos.realized_pnl || 0) / 100

                    return (
                      <tr key={pos.ticker || i} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="p-3">
                          <Link
                            to={`/kalshi/markets/${pos.ticker}`}
                            className="text-blue-400 hover:underline font-mono text-sm"
                          >
                            {pos.ticker}
                          </Link>
                        </td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            isYes ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
                          }`}>
                            {isYes ? 'YES' : 'NO'}
                          </span>
                        </td>
                        <td className="p-3 font-medium">{contracts}</td>
                        <td className="p-3">{avgPrice}c</td>
                        <td className="p-3">{formatCurrency(exposure)}</td>
                        <td className={`p-3 font-medium ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                        </td>
                        <td className="p-3">
                          <Link
                            to={`/kalshi/markets/${pos.ticker}`}
                            className="p-1 hover:bg-gray-600 rounded inline-flex"
                            title="View Market"
                          >
                            <ExternalLink size={14} />
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Strategy Performance */}
      {strategyEntries.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-lg font-semibold">By Strategy</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {strategyEntries.map(([name, stats]) => (
              <div key={name} className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium capitalize">{name.replace(/-/g, ' ')}</span>
                  <span className={`text-sm font-bold ${stats.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {formatCurrency(stats.pnl)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span>{stats.trades} trades</span>
                  <span>{stats.winRate?.toFixed(0) ?? 0}% win</span>
                  <span>avg {formatCurrency(stats.avgPnl)}</span>
                </div>
                <div className="mt-2 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${stats.winRate >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min(100, stats.winRate || 0)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trade History */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History size={18} className="text-gray-400" />
            <h2 className="text-lg font-semibold">Trade History</h2>
            <span className="text-sm text-gray-400">({filteredTrades.length})</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5">
            <button
              onClick={() => { setHistoryFilter('completed'); setVisibleCount(ITEMS_PER_PAGE) }}
              className={`px-3 py-1 rounded text-xs transition-colors ${
                historyFilter === 'completed' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Completed
            </button>
            <button
              onClick={() => { setHistoryFilter('all'); setVisibleCount(ITEMS_PER_PAGE) }}
              className={`px-3 py-1 rounded text-xs transition-colors ${
                historyFilter === 'all' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              All Trades
            </button>
          </div>
        </div>

        {filteredTrades.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400 bg-gray-800/50 rounded-lg">
            <History size={32} className="mb-2 opacity-50" />
            <p className="text-sm">No trade history yet</p>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-gray-400 text-left text-xs border-b border-gray-700">
                    <th className="p-3">Time</th>
                    <th className="p-3">Market</th>
                    <th className="p-3">Action</th>
                    <th className="p-3">Side</th>
                    <th className="p-3">Qty</th>
                    <th className="p-3">Price</th>
                    {historyFilter === 'completed' && <th className="p-3">Cost Basis</th>}
                    <th className="p-3">P&L</th>
                    <th className="p-3">Strategy</th>
                    <th className="p-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTrades.map((trade, i) => {
                    const pnl = trade.pnl ?? null
                    const hasPnl = pnl !== null && pnl !== undefined

                    return (
                      <tr key={trade.id || `${trade.ticker}-${trade.timestamp}-${i}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="p-3 text-xs text-gray-400 whitespace-nowrap" title={trade.timestamp}>
                          {formatTime(trade.timestamp)}
                        </td>
                        <td className="p-3">
                          <Link
                            to={`/kalshi/markets/${trade.ticker}`}
                            className="text-blue-400 hover:underline font-mono text-xs"
                          >
                            {trade.ticker}
                          </Link>
                        </td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${ACTION_STYLES[trade.action] || 'bg-gray-700 text-gray-300'}`}>
                            {trade.action}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className={`text-xs font-medium ${
                            trade.side === 'yes' ? 'text-green-400' : 'text-red-400'
                          }`}>
                            {trade.side?.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-3 text-sm">{trade.count}</td>
                        <td className="p-3 text-sm">{trade.price}c</td>
                        {historyFilter === 'completed' && (
                          <td className="p-3 text-sm text-gray-400">
                            {trade.costBasis != null ? formatCurrency(trade.costBasis) : '-'}
                          </td>
                        )}
                        <td className={`p-3 text-sm font-medium ${
                          !hasPnl ? 'text-gray-500' : pnl >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {hasPnl ? `${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}` : '-'}
                        </td>
                        <td className="p-3">
                          <span className="text-xs text-gray-400 capitalize">
                            {trade.strategy?.replace(/-/g, ' ') || '-'}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className="text-xs text-gray-500 max-w-[200px] truncate block" title={trade.reason}>
                            {trade.reason || '-'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <div className="p-3 border-t border-gray-700 text-center">
                <button
                  onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                  className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Show more ({filteredTrades.length - visibleCount} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
