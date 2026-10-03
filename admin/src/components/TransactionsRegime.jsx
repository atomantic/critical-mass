import { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react'
import { formatCurrency, formatPrice, formatAsset } from './charts/chartUtils'
import { getBaseCurrency } from '../App'
import { pairQuery as buildPairQuery } from '../utils/api'
import ManualTrades from './ManualTrades'
import { createTransactionsReader } from '../utils/transactionsRead.mjs'

const EMPTY_SUMMARY = { totalBuys: 0, totalSells: 0, totalAssetBought: 0, totalBtcSold: 0, totalFees: 0, totalPnL: 0, totalHoldbackBtc: 0, totalHoldbackValue: 0 }
const EMPTY_PAGE = { page: 0, pageCount: 1, total: 0, start: 0, end: 0, hasPrev: false, hasNext: false }

function TransactionsRegime({ exchange = 'coinbase', pair }) {
  const cycleFilterId = useId()
  const [snapshot, setSnapshot] = useState({ fills: [], summary: EMPTY_SUMMARY, pageInfo: EMPTY_PAGE, cycleIds: [] })
  const [openOrders, setOpenOrders] = useState([])
  const [ordersError, setOrdersError] = useState(null)
  const [fillsError, setFillsError] = useState(null)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [cycleFilter, setCycleFilter] = useState('all')
  const [sortField, setSortField] = useState('timestamp')
  const [sortDir, setSortDir] = useState('desc')
  const [productId, setProductId] = useState(null)
  const [page, setPage] = useState(0)
  const reader = useMemo(() => createTransactionsReader(), [])
  const revision = useRef(null)
  const fund = `${exchange}:${pair || ''}`
  const activeFund = useRef(fund)
  activeFund.current = fund
  const pairQuery = buildPairQuery(pair)

  // Config is stable between edits. Leaving/re-entering Config remounts this
  // route, and a fund change explicitly invalidates it; polling never fetches it.
  useEffect(() => {
    const controller = new AbortController()
    setProductId(null)
    setStatus(null)
    setSnapshot({ fills: [], summary: EMPTY_SUMMARY, pageInfo: EMPTY_PAGE, cycleIds: [] })
    setOpenOrders([])
    setOrdersError(null)
    setFillsError(null)
    setPage(0)
    revision.current = null
    fetch(`/api/${exchange}/config${pairQuery}`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!controller.signal.aborted && activeFund.current === fund && data) {
          setProductId(data.config?.productId || data.productId || null)
        }
      }).catch(() => {})
    return () => controller.abort()
  }, [exchange, pairQuery, fund])

  const fetchData = useCallback(async () => {
    const query = new URLSearchParams({ paged: 'true', page: String(page), pageSize: '100', side: filter, cycle: cycleFilter, sortField, sortDir })
    if (pair) query.set('pair', pair)
    if (revision.current) query.set('revision', revision.current)
    const { owned, data } = await reader.read({ exchange, pairQuery, query })
    if (!owned || activeFund.current !== fund) return
    if (data) {
      const { fillsOk, fillsStatus, fillsData, statusData, ordersOk, ordersStatus, ordersData } = data
      if (fillsOk && fillsData?.pageInfo && fillsData?.summary && Array.isArray(fillsData.fills)) {
        revision.current = fillsData.revision
        setSnapshot(fillsData)
        setPage(fillsData.pageInfo.page)
        setFillsError(null)
      } else setFillsError(fillsData?.error || `Transactions unavailable (HTTP ${fillsStatus})`)
      if (statusData) setStatus(statusData.status)
      if (ordersOk) {
        setOpenOrders(ordersData?.orders || [])
        setOrdersError(null)
      } else setOrdersError(ordersData?.error || `Open orders unavailable (HTTP ${ordersStatus})`)
    } else {
      setFillsError('Transactions unavailable: request failed')
      setOrdersError('Open orders unavailable: request failed')
    }
    setLoading(false)
  }, [exchange, pair, pairQuery, fund, page, filter, cycleFilter, sortField, sortDir, reader])

  useEffect(() => {
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      await fetchData()
      pending = false
    }
    setLoading(true)
    refresh()
    const interval = setInterval(refresh, 10000)
    return () => { reader.invalidate(); clearInterval(interval) }
  }, [fetchData, reader])

  const isDryRun = status?.isDryRun
  const baseCurrency = getBaseCurrency(productId)
  const { fills: displayFills, cycleIds, pageInfo, summary } = snapshot
  const { totalBuys, totalSells, totalAssetBought, totalBtcSold, totalFees, totalPnL, totalHoldbackBtc, totalHoldbackValue } = summary
  const handleSort = (field) => {
    setPage(0)
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime transactions...</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {fillsError && <div role="alert" className="text-sm text-yellow-400">
        {fillsError} <button type="button" onClick={() => fetchData()} className="px-2 py-1 rounded bg-gray-700">Retry</button>
      </div>}
      {/* Header with status */}
      {isDryRun && (
        <div className="bg-purple-900/30 border border-purple-700/50 rounded-lg p-3 text-sm text-purple-400">
          Viewing dry-run simulated transactions
        </div>
      )}

      {/* Open Orders Section */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
          {openOrders.length > 0 && <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></span>}
          Open Orders
        </h3>
        {ordersError && (
          <div className="flex items-center gap-3 text-sm text-yellow-400 mb-2" role="alert">
            <span>
              {openOrders.length > 0
                ? `Open orders may be stale: ${ordersError}`
                : `Open orders unavailable: ${ordersError}`}
            </span>
            <button type="button" onClick={() => fetchData()} className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs">
              Retry
            </button>
          </div>
        )}
        {openOrders.length > 0 && (
          <div className={`overflow-x-auto ${ordersError ? 'opacity-60' : ''}`}>
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
                    <td className="px-4 py-2 font-mono">
                      {formatAsset(order.size)}
                      {order.filledSize > 0 && (
                        <span className="ml-1 text-yellow-400 text-xs" title={`${formatAsset(order.filledSize)} filled of ${formatAsset(order.size)}`}>
                          ({formatAsset(order.filledSize)} filled)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">{formatPrice(order.price)}</td>
                    <td className="px-4 py-2">{formatCurrency((order.price || 0) * (order.size || 0))}</td>
                    <td className="px-4 py-2">
                      {order.filledSize > 0 ? (
                        <span className="px-2 py-0.5 rounded text-xs bg-orange-900/50 text-orange-400">
                          partial
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-400">
                          {order.status || 'open'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs font-mono">
                      {order.orderId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {openOrders.length === 0 && !ordersError && (
          <div className="text-sm text-gray-400">No open orders</div>
        )}
      </div>

      {/* Summary */}
      {pageInfo.total > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-400">Buy Orders:</span>
              <span className="ml-2 text-green-400">{totalBuys}</span>
            </div>
            <div>
              <span className="text-gray-400">Sell Orders:</span>
              <span className="ml-2 text-red-400">{totalSells}</span>
            </div>
            <div>
              <span className="text-gray-400">{baseCurrency} Bought:</span>
              <span className="ml-2 text-white font-mono">{formatAsset(totalAssetBought)}</span>
            </div>
            <div>
              <span className="text-gray-400">{baseCurrency} Sold:</span>
              <span className="ml-2 text-white font-mono">{formatAsset(totalBtcSold)}</span>
            </div>
            <div>
              <span className="text-gray-400">Total Fees:</span>
              <span className="ml-2 text-gray-400">{formatCurrency(totalFees)}</span>
            </div>
            <div>
              <span className="text-gray-400">{baseCurrency} Holdback:</span>
              <span className={`ml-2 font-mono ${totalHoldbackBtc < 0 ? 'text-amber-400' : 'text-cyan-400'}`} title={`≈${formatCurrency(totalHoldbackValue)}`}>
                {totalHoldbackBtc < 0 ? '−' : '+'}{formatAsset(Math.abs(totalHoldbackBtc))}
              </span>
            </div>
            <div>
              <span className="text-gray-400">Holdback Value:</span>
              <span className="ml-2 text-cyan-400">{formatCurrency(totalHoldbackValue)}</span>
            </div>
            <div>
              <span className="text-gray-400">Total P&L:</span>
              <span className={`ml-2 font-medium ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {totalPnL >= 0 ? '+' : ''}{formatCurrency(totalPnL)}
              </span>
            </div>
          </div>
        </div>
      )}
      {/* Manual Trades Section */}
      <ManualTrades exchange={exchange} pair={pair} />

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex gap-2">
          {['all', 'buy', 'sell'].map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(0) }}
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
          <label htmlFor={cycleFilterId} className="text-sm text-gray-400">Cycle:</label>
          <select
            id={cycleFilterId}
            value={cycleFilter}
            onChange={(e) => { setCycleFilter(e.target.value); setPage(0) }}
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
          {pageInfo.total} transactions
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
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                    No transactions found. Start the regime engine to begin trading.
                  </td>
                </tr>
              ) : (
                displayFills.map((fill, i) => (
                  <tr key={`${fill.tradeId || fill.orderId}-${pageInfo.start + i}`} className="border-t border-gray-700 hover:bg-gray-700/50">
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
                    <td className="px-4 py-3 text-gray-400">
                      {formatCurrency(fill.netFee || fill.fee || 0)}
                    </td>
                    <td className="px-4 py-3">
                      {fill.holdbackAsset !== null ? (
                        <span
                          className={fill.holdbackAsset < 0 ? 'text-amber-400' : 'text-cyan-400'}
                          title={fill.holdbackAsset < 0 ? `Sold beyond the body's holdings — drawn from reserves (≈${formatCurrency(fill.holdbackValue)})` : `≈${formatCurrency(fill.holdbackValue)}`}
                        >
                          {fill.holdbackAsset < 0 ? '−' : '+'}{formatAsset(Math.abs(fill.holdbackAsset))}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {fill.pnl !== null ? (
                        <span className={fill.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {fill.pnl >= 0 ? '+' : ''}{formatCurrency(fill.pnl)}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pageInfo.total > 0 && (
          <nav aria-label="Transactions pagination" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-700 text-sm text-gray-400">
            <span aria-live="polite">
              Showing {pageInfo.start}–{pageInfo.end} of {pageInfo.total} · Page {pageInfo.page + 1} of {pageInfo.pageCount}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage(pageInfo.page - 1)}
                disabled={!pageInfo.hasPrev}
                className="px-3 py-1 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage(pageInfo.page + 1)}
                disabled={!pageInfo.hasNext}
                className="px-3 py-1 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </nav>
        )}
      </div>

    </div>
  )
}

export default TransactionsRegime
