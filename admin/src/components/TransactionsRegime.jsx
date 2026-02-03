import { useState, useEffect, useCallback } from 'react'
import { formatCurrency, formatPrice } from './charts/chartUtils'

function TransactionsRegime({ exchange = 'coinbase' }) {
  const [fills, setFills] = useState([])
  const [openOrders, setOpenOrders] = useState([])
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [cycleFilter, setCycleFilter] = useState('all')
  const [sortField, setSortField] = useState('timestamp')
  const [sortDir, setSortDir] = useState('desc')

  const formatBTC = (n) => (n || 0).toFixed(8)

  const fetchData = useCallback(async () => {
    const [fillsRes, statusRes, ordersRes] = await Promise.all([
      fetch(`/api/${exchange}/regime/fills`),
      fetch(`/api/${exchange}/regime/status`),
      fetch(`/api/${exchange}/regime/open-orders`),
    ])

    if (fillsRes.ok) {
      const data = await fillsRes.json()
      setFills(data.fills || [])
    }
    if (statusRes.ok) {
      const data = await statusRes.json()
      setStatus(data.status)
    }
    if (ordersRes.ok) {
      const data = await ordersRes.json()
      setOpenOrders(data.orders || [])
    }
    setLoading(false)
  }, [exchange])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const isDryRun = status?.isDryRun

  // Get unique cycle IDs for filtering
  const cycleIds = [...new Set(fills.map(f => f.cycleId || 'current'))].sort().reverse()

  // Filter fills
  const filteredFills = fills.filter(fill => {
    if (filter !== 'all' && fill.side !== filter) return false
    if (cycleFilter !== 'all') {
      const fillCycle = fill.cycleId || 'current'
      if (fillCycle !== cycleFilter) return false
    }
    return true
  })

  // Sort fills
  const sortedFills = [...filteredFills].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortField === 'timestamp') {
      return (a.timestamp - b.timestamp) * dir
    }
    const aVal = a[sortField]
    const bVal = b[sortField]
    if (typeof aVal === 'number') return (aVal - bVal) * dir
    return String(aVal).localeCompare(String(bVal)) * dir
  })

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  // Calculate P&L for sell fills based on running avg cost
  const fillsWithPnL = (() => {
    // Sort by timestamp to calculate running avg
    const chronological = [...filteredFills].sort((a, b) => a.timestamp - b.timestamp)
    let totalBtc = 0
    let totalCost = 0

    return chronological.map(fill => {
      if (fill.side === 'buy') {
        totalBtc += fill.size
        totalCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || fill.fee || 0)
        return { ...fill, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0, pnl: null }
      }
      // Sell fill - calculate P&L
      const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
      const proceeds = (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0)
      const costBasis = avgCost * fill.size
      const pnl = proceeds - costBasis

      // Update position after sell
      const btcSold = fill.size
      const remainingBtc = totalBtc - btcSold
      if (remainingBtc > 0) {
        totalBtc = remainingBtc
        totalCost = avgCost * remainingBtc
      } else {
        totalBtc = 0
        totalCost = 0
      }

      return { ...fill, avgCost, pnl }
    })
  })()

  // Re-sort based on user preference
  const displayFills = [...fillsWithPnL].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortField === 'timestamp') {
      return (a.timestamp - b.timestamp) * dir
    }
    return 0
  })

  // Calculate summary stats
  const totalBuys = filteredFills.filter(f => f.side === 'buy').length
  const totalSells = filteredFills.filter(f => f.side === 'sell').length
  const totalBtcBought = filteredFills
    .filter(f => f.side === 'buy')
    .reduce((sum, f) => sum + f.size, 0)
  const totalBtcSold = filteredFills
    .filter(f => f.side === 'sell')
    .reduce((sum, f) => sum + f.size, 0)
  const totalFees = filteredFills.reduce((sum, f) => sum + (f.netFee || f.fee || 0), 0)
  const totalPnL = fillsWithPnL
    .filter(f => f.pnl !== null)
    .reduce((sum, f) => sum + f.pnl, 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime transactions...</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with status */}
      {isDryRun && (
        <div className="bg-purple-900/30 border border-purple-700/50 rounded-lg p-3 text-sm text-purple-400">
          Viewing dry-run simulated transactions
        </div>
      )}

      {/* Open Orders Section */}
      {openOrders.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></span>
            Open Orders
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-700">
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Side</th>
                  <th className="px-4 py-2">Size (BTC)</th>
                  <th className="px-4 py-2">Price</th>
                  <th className="px-4 py-2">Value</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Order ID</th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map(order => (
                  <tr key={order.orderId} className="border-t border-gray-700/50 hover:bg-gray-700/30">
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        order.type === 'take_profit'
                          ? 'bg-green-900/50 text-green-400'
                          : 'bg-blue-900/50 text-blue-400'
                      }`}>
                        {order.type === 'take_profit' ? 'TP' : 'Entry'}
                      </span>
                    </td>
                    <td className={`px-4 py-2 font-medium ${
                      order.side === 'buy' ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {(order.side || (order.type === 'take_profit' ? 'sell' : 'buy')).toUpperCase()}
                    </td>
                    <td className="px-4 py-2 font-mono">{formatBTC(order.size)}</td>
                    <td className="px-4 py-2">{formatPrice(order.price)}</td>
                    <td className="px-4 py-2">{formatCurrency((order.price || 0) * (order.size || 0))}</td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-400">
                        {order.status || 'open'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs font-mono">
                      {order.orderId?.slice(0, 8)}...
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex gap-2">
          {['all', 'buy', 'sell'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded text-sm ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) + 's'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Cycle:</span>
          <select
            value={cycleFilter}
            onChange={(e) => setCycleFilter(e.target.value)}
            className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
          >
            <option value="all">All Cycles</option>
            <option value="current">Current</option>
            {cycleIds.filter(id => id !== 'current').map(id => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <span className="ml-auto text-gray-400 text-sm">
          {sortedFills.length} transactions
        </span>
      </div>

      {/* Table */}
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-700 text-gray-300 text-left">
                {[
                  { key: 'timestamp', label: 'Time' },
                  { key: 'cycleId', label: 'Cycle' },
                  { key: 'side', label: 'Side' },
                  { key: 'size', label: 'Size (BTC)' },
                  { key: 'price', label: 'Price' },
                  { key: 'quoteAmount', label: 'Value' },
                  { key: 'fee', label: 'Fee' },
                  { key: 'pnl', label: 'P&L' },
                ].map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className="px-4 py-3 cursor-pointer hover:bg-gray-600"
                  >
                    <div className="flex items-center gap-1">
                      {col.label}
                      {sortField === col.key && (
                        <span>{sortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayFills.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No transactions found. Start the regime engine to begin trading.
                  </td>
                </tr>
              ) : (
                displayFills.map((fill, i) => (
                  <tr key={`${fill.tradeId || fill.orderId}-${i}`} className="border-t border-gray-700 hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-gray-400">
                      {new Date(fill.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        !fill.cycleId || fill.cycleId === 'current'
                          ? 'bg-blue-900/50 text-blue-400'
                          : 'bg-gray-700 text-gray-400'
                      }`}>
                        {fill.cycleId || 'current'}
                      </span>
                    </td>
                    <td className={`px-4 py-3 font-medium ${
                      fill.side === 'buy' ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {fill.side.toUpperCase()}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {formatBTC(fill.size)}
                    </td>
                    <td className="px-4 py-3">
                      {formatPrice(fill.price)}
                    </td>
                    <td className="px-4 py-3">
                      {formatCurrency(fill.quoteAmount || fill.size * fill.price)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatCurrency(fill.netFee || fill.fee || 0)}
                    </td>
                    <td className="px-4 py-3">
                      {fill.pnl !== null ? (
                        <span className={fill.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {fill.pnl >= 0 ? '+' : ''}{formatCurrency(fill.pnl)}
                        </span>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Summary */}
      {displayFills.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Buy Orders:</span>
              <span className="ml-2 text-green-400">{totalBuys}</span>
            </div>
            <div>
              <span className="text-gray-500">Sell Orders:</span>
              <span className="ml-2 text-red-400">{totalSells}</span>
            </div>
            <div>
              <span className="text-gray-500">BTC Bought:</span>
              <span className="ml-2 text-white font-mono">{formatBTC(totalBtcBought)}</span>
            </div>
            <div>
              <span className="text-gray-500">BTC Sold:</span>
              <span className="ml-2 text-white font-mono">{formatBTC(totalBtcSold)}</span>
            </div>
            <div>
              <span className="text-gray-500">Total Fees:</span>
              <span className="ml-2 text-gray-400">{formatCurrency(totalFees)}</span>
            </div>
            <div>
              <span className="text-gray-500">Total P&L:</span>
              <span className={`ml-2 font-medium ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {totalPnL >= 0 ? '+' : ''}{formatCurrency(totalPnL)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TransactionsRegime
