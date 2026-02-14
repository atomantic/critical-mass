import { useState, useEffect, useCallback } from 'react'
import { formatCurrency, formatPrice } from './charts/chartUtils'
import { getBaseCurrency } from '../App'

function TransactionsRegime({ exchange = 'coinbase' }) {
  const [fills, setFills] = useState([])
  const [openOrders, setOpenOrders] = useState([])
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [cycleFilter, setCycleFilter] = useState('all')
  const [sortField, setSortField] = useState('timestamp')
  const [sortDir, setSortDir] = useState('desc')
  const [productId, setProductId] = useState(null)

  const formatAsset = (n) => (n || 0).toFixed(8)

  const fetchData = useCallback(async () => {
    const [fillsRes, statusRes, ordersRes, configRes] = await Promise.all([
      fetch(`/api/${exchange}/regime/fills`),
      fetch(`/api/${exchange}/regime/status`),
      fetch(`/api/${exchange}/regime/open-orders`),
      fetch(`/api/${exchange}/config`),
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
    if (configRes.ok) {
      const data = await configRes.json()
      setProductId(data.config?.productId || data.productId || null)
    }
    setLoading(false)
  }, [exchange])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const isDryRun = status?.isDryRun
  const baseCurrency = getBaseCurrency(productId)

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

  // Calculate P&L for sell fills using buy-sell linkage (sellOrderId) and running avg fallback
  const fillsWithPnL = (() => {
    // Use ALL fills for P&L calculation (not filtered) so running avg is correct
    const chronological = [...fills].sort((a, b) => a.timestamp - b.timestamp)

    // Build buy→sell linkage map: buys annotated with sellOrderId point to their matching sell
    const buysBySellId = new Map()
    for (const fill of chronological) {
      if (fill.side === 'buy' && fill.sellOrderId) {
        if (!buysBySellId.has(fill.sellOrderId)) buysBySellId.set(fill.sellOrderId, [])
        buysBySellId.get(fill.sellOrderId).push(fill)
      }
    }

    // Pre-compute total sell value per orderId for proportional P&L on multi-fill orders
    const sellTotalsByOrderId = new Map()
    for (const fill of chronological) {
      if (fill.side !== 'sell') continue
      const prev = sellTotalsByOrderId.get(fill.orderId)
      if (prev) {
        prev.totalQuote += fill.quoteAmount || fill.size * fill.price
        prev.totalFee += fill.netFee || fill.fee || 0
      } else {
        sellTotalsByOrderId.set(fill.orderId, {
          totalQuote: fill.quoteAmount || fill.size * fill.price,
          totalFee: fill.netFee || fill.fee || 0,
        })
      }
    }

    let totalBtc = 0
    let totalCost = 0
    const pnlMap = new Map()

    for (let i = 0; i < chronological.length; i++) {
      const fill = chronological[i]
      if (fill.side === 'buy') {
        const isBody = fill.isBodyOwned || fill.isSatellite || fill.bodyId
        if (!isBody) {
          totalBtc += fill.size
          totalCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || fill.fee || 0)
        }
        pnlMap.set(i, { pnl: null, holdbackAsset: null, holdbackValue: null, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0 })
        continue
      }
      // Sell fill
      const isBody = fill.isBodyOwned || fill.isSatellite || fill.bodyId
      const annotatedPnl = fill.bodyPnl ?? fill.satellitePnl
      let pnl

      if (annotatedPnl != null) {
        // 1. Server-annotated P&L (most trusted)
        pnl = annotatedPnl
      } else {
        // 2. Try buy-sell linkage via sellOrderId
        const linkedBuys = buysBySellId.get(fill.orderId)
        if (linkedBuys && linkedBuys.length > 0) {
          const buyCost = linkedBuys.reduce((s, b) => s + (b.quoteAmount || b.size * b.price) + (b.netFee || b.fee || 0), 0)
          const orderTotals = sellTotalsByOrderId.get(fill.orderId)
          const totalSellProceeds = orderTotals.totalQuote - orderTotals.totalFee
          const totalPnl = totalSellProceeds - buyCost
          // Distribute proportionally for multi-fill orders
          const fillValue = fill.quoteAmount || fill.size * fill.price
          pnl = totalPnl * (fillValue / orderTotals.totalQuote)
        } else if (isBody && (fill.bodyCostBasis ?? fill.satelliteCostBasis)) {
          // 3. Body/satellite sell with cost basis annotation but no P&L
          const costBasis = fill.bodyCostBasis ?? fill.satelliteCostBasis
          pnl = (fill.quoteAmount - (fill.netFee || fill.fee || 0)) - costBasis
        } else {
          // 4. Fallback: running avg for truly unlinked core sells
          const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
          const proceeds = (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0)
          pnl = proceeds - avgCost * fill.size
        }
      }

      const holdbackAsset = fill.bodyHoldbackAsset ?? fill.satelliteHoldbackAsset ?? null
      const holdbackValue = holdbackAsset != null && holdbackAsset > 0 ? holdbackAsset * fill.price : 0

      // Update running position for non-body sells without linkage (core TP)
      if (!isBody && !buysBySellId.has(fill.orderId)) {
        const remainingBtc = totalBtc - fill.size
        if (remainingBtc > 0) {
          const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
          totalBtc = remainingBtc
          totalCost = avgCost * remainingBtc
        } else {
          totalBtc = 0
          totalCost = 0
        }
      }

      pnlMap.set(i, { pnl, holdbackAsset: holdbackAsset != null && holdbackAsset > 0 ? holdbackAsset : null, holdbackValue: holdbackValue > 0 ? holdbackValue : null, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0 })
    }

    // Map back to filtered fills with their P&L
    const filteredSet = new Set(filteredFills)
    return chronological
      .map((fill, i) => filteredSet.has(fill) ? { ...fill, ...pnlMap.get(i) } : null)
      .filter(Boolean)
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
  const totalAssetBought = filteredFills
    .filter(f => f.side === 'buy')
    .reduce((sum, f) => sum + f.size, 0)
  const totalBtcSold = filteredFills
    .filter(f => f.side === 'sell')
    .reduce((sum, f) => sum + f.size, 0)
  const totalFees = filteredFills.reduce((sum, f) => sum + (f.netFee || f.fee || 0), 0)
  const totalPnL = fillsWithPnL
    .filter(f => f.pnl !== null)
    .reduce((sum, f) => sum + f.pnl, 0)
  const totalHoldbackBtc = fillsWithPnL
    .filter(f => f.holdbackAsset !== null)
    .reduce((sum, f) => sum + f.holdbackAsset, 0)
  const totalHoldbackValue = fillsWithPnL
    .filter(f => f.holdbackValue !== null)
    .reduce((sum, f) => sum + f.holdbackValue, 0)

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
                  <th className="px-4 py-2">Size ({baseCurrency})</th>
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
                      {order.type === 'entry' ? (
                        <span className="px-2 py-0.5 rounded text-xs bg-emerald-900/50 text-emerald-400" title="Limit buy entry order">Entry</span>
                      ) : (order.type === 'satellite_tp' || order.type === 'body_tp') ? (
                        <span className="px-2 py-0.5 rounded text-xs bg-purple-900/50 text-purple-400" title={`Celestial body take-profit (${order.type.replace('_tp', '')})`}>
                          {order.tierEmoji || '🛰️'}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-400" title="Take-profit sell order">TP</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 font-medium ${
                      order.side === 'buy' ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {(order.side || (order.type === 'take_profit' ? 'sell' : 'buy')).toUpperCase()}
                    </td>
                    <td className="px-4 py-2 font-mono">{formatAsset(order.size)}</td>
                    <td className="px-4 py-2">{formatPrice(order.price)}</td>
                    <td className="px-4 py-2">{formatCurrency((order.price || 0) * (order.size || 0))}</td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-400">
                        {order.status || 'open'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs font-mono">
                      {order.orderId}
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
                  { key: 'size', label: `Size (${baseCurrency})` },
                  { key: 'price', label: 'Price' },
                  { key: 'quoteAmount', label: 'Value' },
                  { key: 'fee', label: 'Fee' },
                  { key: 'holdbackAsset', label: 'Holdback' },
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
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
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
                      {formatAsset(fill.size)}
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
                      {fill.holdbackAsset !== null ? (
                        <span className="text-cyan-400" title={`≈${formatCurrency(fill.holdbackValue)}`}>
                          +{formatAsset(fill.holdbackAsset)}
                        </span>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Buy Orders:</span>
              <span className="ml-2 text-green-400">{totalBuys}</span>
            </div>
            <div>
              <span className="text-gray-500">Sell Orders:</span>
              <span className="ml-2 text-red-400">{totalSells}</span>
            </div>
            <div>
              <span className="text-gray-500">{baseCurrency} Bought:</span>
              <span className="ml-2 text-white font-mono">{formatAsset(totalAssetBought)}</span>
            </div>
            <div>
              <span className="text-gray-500">{baseCurrency} Sold:</span>
              <span className="ml-2 text-white font-mono">{formatAsset(totalBtcSold)}</span>
            </div>
            <div>
              <span className="text-gray-500">Total Fees:</span>
              <span className="ml-2 text-gray-400">{formatCurrency(totalFees)}</span>
            </div>
            <div>
              <span className="text-gray-500">{baseCurrency} Holdback:</span>
              <span className="ml-2 text-cyan-400 font-mono" title={`≈${formatCurrency(totalHoldbackValue)}`}>
                +{formatAsset(totalHoldbackBtc)}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Holdback Value:</span>
              <span className="ml-2 text-cyan-400">{formatCurrency(totalHoldbackValue)}</span>
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
