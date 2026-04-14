import { useState, useCallback, useMemo } from 'react'
import { formatCurrency, formatPrice, formatDateTime } from './charts/chartUtils'
import { pairQuery as buildPairQuery } from '../utils/api'

const STATUS_COLORS = {
  sell_recorded: 'bg-blue-600/30 text-blue-400 border-blue-500/30',
  buy_pending: 'bg-yellow-600/30 text-yellow-400 border-yellow-500/30',
  buy_recorded: 'bg-cyan-600/30 text-cyan-400 border-cyan-500/30',
  tp_pending: 'bg-orange-600/30 text-orange-400 border-orange-500/30',
  completed: 'bg-green-600/30 text-green-400 border-green-500/30',
  dismissed: 'bg-gray-600/30 text-gray-400 border-gray-500/30',
}

const STATUS_LABELS = {
  sell_recorded: 'Sell Recorded',
  buy_pending: 'Buy Pending',
  buy_recorded: 'Buy Recorded',
  tp_pending: 'TP Pending',
  buy_filled: 'Buy Filled',
  completed: 'Completed',
  dismissed: 'Dismissed',
}

/**
 * Compute match suggestions for an order from the unaccounted list.
 * Returns opposite-side orders scored by match quality.
 */
const computeMatchSuggestions = (order, allOrders) => {
  const oppositeSide = order.side === 'buy' ? 'sell' : 'buy'
  const candidates = allOrders.filter(o => o.side === oppositeSide && o.orderId !== order.orderId)

  if (candidates.length === 0) return []

  const scored = candidates.map(c => {
    // Size similarity (40% weight)
    const maxSize = Math.max(order.totalBtc, c.totalBtc)
    const sizeSim = maxSize > 0 ? 1 - Math.abs(order.totalBtc - c.totalBtc) / maxSize : 0

    // Temporal proximity (30% weight) — closer in time is better
    const hoursDiff = Math.abs(new Date(order.time).getTime() - new Date(c.time).getTime()) / 3600000
    const timeSim = 1 / (1 + hoursDiff / 24)

    // Price relationship (20% weight) — buy < sell is preferred
    const buyPrice = order.side === 'buy' ? order.avgPrice : c.avgPrice
    const sellPrice = order.side === 'sell' ? order.avgPrice : c.avgPrice
    const priceScore = sellPrice > buyPrice ? 1 : 0.3

    // Spread (10% weight) — higher profit margin is better
    const spreadPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0
    const spreadScore = Math.min(Math.max(spreadPct / 5, 0), 1) // 0-5% → 0-1

    const score = sizeSim * 0.4 + timeSim * 0.3 + priceScore * 0.2 + spreadScore * 0.1

    return { ...c, score, sizeSim, timeSim, spreadPct }
  })

  return scored.sort((a, b) => b.score - a.score).slice(0, 8)
}

function ManualTrades({ exchange = 'coinbase', pair }) {
  const [expanded, setExpanded] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [unaccountedOrders, setUnaccountedOrders] = useState([])
  const [manualTrades, setManualTrades] = useState([])
  const [loading, setLoading] = useState(false)
  const [tradesLoading, setTradesLoading] = useState(false)
  const [error, setError] = useState(null)

  // Import modal state
  const [importModal, setImportModal] = useState(null) // { order } or null
  const [importTab, setImportTab] = useState('orphan') // 'orphan' | 'pair'
  const [selectedMatch, setSelectedMatch] = useState(null) // paired order

  // Orphan sell fields (existing flow)
  const [importMode, setImportMode] = useState('place') // 'place' or 'link'
  const [recoveryBuyPrice, setRecoveryBuyPrice] = useState('')
  const [existingBuyOrderId, setExistingBuyOrderId] = useState('')

  // Orphan buy fields
  const [createBody, setCreateBody] = useState(true)

  // Shared
  const [importNote, setImportNote] = useState('')
  const [importing, setImporting] = useState(false)
  const [checking, setChecking] = useState(null)
  const [dismissing, setDismissing] = useState(null)

  const pairQuery = buildPairQuery(pair)
  const pairSep = pairQuery ? '&' : '?'

  const fetchUnaccounted = useCallback(async () => {
    if (!startDate) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/${exchange}/regime/unaccounted-fills${pairQuery}${pairSep}startDate=${encodeURIComponent(startDate)}`)
      const data = await res.json()
      if (data.success) {
        setUnaccountedOrders(data.unaccountedOrders || [])
      } else {
        setError(data.error || 'Failed to fetch')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [exchange, pairQuery, pairSep, startDate])

  const fetchManualTrades = useCallback(async () => {
    setTradesLoading(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/manual-trades${pairQuery}`)
      const data = await res.json()
      if (data.success) {
        setManualTrades(data.trades || [])
      }
    } catch {
      // silent
    } finally {
      setTradesLoading(false)
    }
  }, [exchange, pairQuery])

  const handleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next) fetchManualTrades()
  }

  const openImportModal = (order) => {
    setImportModal(order)
    setImportTab('orphan')
    setSelectedMatch(null)
    setImportNote('')
    setCreateBody(true)
    if (order.side === 'sell') {
      setRecoveryBuyPrice(Math.floor(order.avgPrice * 0.97).toString())
      setImportMode('place')
    }
    setExistingBuyOrderId('')
  }

  // Match suggestions for the currently selected order
  const matchSuggestions = useMemo(() => {
    if (!importModal) return []
    return computeMatchSuggestions(importModal, unaccountedOrders)
  }, [importModal, unaccountedOrders])

  // Handle orphan sell import (existing flow)
  const handleImportOrphanSell = async () => {
    if (!importModal) return
    setImporting(true)
    try {
      const body = {
        sellOrderId: importModal.orderId,
        note: importNote,
      }
      if (importMode === 'place' && recoveryBuyPrice) {
        body.recoveryBuyPrice = parseFloat(recoveryBuyPrice)
      } else if (importMode === 'link' && existingBuyOrderId) {
        body.existingBuyOrderId = existingBuyOrderId
      }

      const res = await fetch(`/api/${exchange}/regime/manual-trade${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        setImportModal(null)
        fetchManualTrades()
        setUnaccountedOrders(prev => prev.filter(o => o.orderId !== importModal.orderId))
      } else {
        setError(data.error || 'Import failed')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  // Handle orphan buy import
  const handleImportOrphanBuy = async () => {
    if (!importModal) return
    setImporting(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/manual-trade-buy${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyOrderId: importModal.orderId,
          note: importNote,
          createBody,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setImportModal(null)
        fetchManualTrades()
        setUnaccountedOrders(prev => prev.filter(o => o.orderId !== importModal.orderId))
      } else {
        setError(data.error || 'Import failed')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  // Handle paired import
  const handleImportPaired = async () => {
    if (!importModal || !selectedMatch) return
    setImporting(true)
    try {
      const buyOrder = importModal.side === 'buy' ? importModal : selectedMatch
      const sellOrder = importModal.side === 'sell' ? importModal : selectedMatch

      const res = await fetch(`/api/${exchange}/regime/manual-trade-pair${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyOrderId: buyOrder.orderId,
          sellOrderId: sellOrder.orderId,
          note: importNote,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setImportModal(null)
        setSelectedMatch(null)
        fetchManualTrades()
        setUnaccountedOrders(prev =>
          prev.filter(o => o.orderId !== buyOrder.orderId && o.orderId !== sellOrder.orderId)
        )
      } else {
        setError(data.error || 'Import failed')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  const handleImport = () => {
    if (importTab === 'pair') return handleImportPaired()
    if (importModal?.side === 'buy') return handleImportOrphanBuy()
    return handleImportOrphanSell()
  }

  const handleCheckStatus = async (tradeId) => {
    setChecking(tradeId)
    try {
      const res = await fetch(`/api/${exchange}/regime/manual-trade/${tradeId}/check${pairQuery}`, {
        method: 'POST',
      })
      const data = await res.json()
      if (data.success) {
        fetchManualTrades()
      }
    } catch {
      // silent
    } finally {
      setChecking(null)
    }
  }

  const handleDismiss = async (orderId) => {
    setDismissing(orderId)
    try {
      const res = await fetch(`/api/${exchange}/regime/dismiss-fills${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: [orderId] }),
      })
      const data = await res.json()
      if (data.success) {
        setUnaccountedOrders(prev => prev.filter(o => o.orderId !== orderId))
      }
    } catch {
      // silent
    } finally {
      setDismissing(null)
    }
  }

  const fmtDate = (ts) => ts ? formatDateTime(ts) : '-'
  const truncId = (id) => id ? id.slice(0, 8) + '...' : '-'

  // Determine import button disabled state and label
  const getImportButtonState = () => {
    if (importing) return { disabled: true, label: 'Importing...' }
    if (importTab === 'pair') {
      if (!selectedMatch) return { disabled: true, label: 'Select a match' }
      return { disabled: false, label: 'Import Pair' }
    }
    if (importModal?.side === 'buy') {
      return { disabled: false, label: createBody ? 'Import & Create Body' : 'Import Buy' }
    }
    // Sell orphan
    if (importMode === 'place' && !recoveryBuyPrice) return { disabled: true, label: 'Enter buy price' }
    if (importMode === 'link' && !existingBuyOrderId) return { disabled: true, label: 'Enter buy order ID' }
    return { disabled: false, label: importMode === 'place' ? 'Import & Place Buy' : 'Import & Link Buy' }
  }

  const importBtnState = importModal ? getImportButtonState() : { disabled: true, label: 'Import' }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3
        className="text-sm font-medium text-gray-300 mb-3 cursor-pointer flex items-center gap-2"
        onClick={handleExpand}
      >
        <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9654;</span>
        Manual Trades
        {manualTrades.filter(t => t.status === 'buy_pending' || t.status === 'tp_pending').length > 0 && (
          <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
        )}
      </h3>

      {expanded && (
        <div className="space-y-4">
          {/* Unaccounted Fills Section */}
          <div className="bg-gray-900/40 rounded-lg p-3">
            <h4 className="text-xs font-medium text-purple-400 mb-2">Unaccounted Exchange Fills</h4>
            <div className="flex items-center gap-2 mb-3">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-gray-300"
              />
              <button
                onClick={fetchUnaccounted}
                disabled={loading || !startDate}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  loading || !startDate
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-purple-600/30 text-purple-400 hover:bg-purple-600/50 border border-purple-500/30'
                }`}
              >
                {loading ? 'Fetching...' : 'Fetch'}
              </button>
              {unaccountedOrders.length > 0 && (
                <span className="text-xs text-gray-500">{unaccountedOrders.length} unaccounted orders</span>
              )}
            </div>

            {error && (
              <div className="mb-2 p-2 rounded text-xs bg-red-900/30 border border-red-700/50 text-red-400">
                {error}
                <button onClick={() => setError(null)} className="ml-2 text-red-300 hover:text-red-100">&times;</button>
              </div>
            )}

            {unaccountedOrders.length > 0 && (
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr className="text-gray-500 text-left">
                      <th className="px-2 py-1">Order ID</th>
                      <th className="px-2 py-1">Side</th>
                      <th className="px-2 py-1 text-right">Size (BTC)</th>
                      <th className="px-2 py-1 text-right">Avg Price</th>
                      <th className="px-2 py-1 text-right">Total</th>
                      <th className="px-2 py-1">Time</th>
                      <th className="px-2 py-1">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unaccountedOrders.map((order) => (
                      <tr key={order.orderId} className="border-t border-gray-700/50 hover:bg-gray-700/30">
                        <td className="px-2 py-1 font-mono text-gray-400">{truncId(order.orderId)}</td>
                        <td className={`px-2 py-1 font-medium ${order.side === 'sell' ? 'text-red-400' : 'text-green-400'}`}>
                          {order.side.toUpperCase()}
                        </td>
                        <td className="px-2 py-1 text-right text-gray-300">{order.totalBtc.toFixed(8)}</td>
                        <td className="px-2 py-1 text-right text-gray-300">{formatPrice(order.avgPrice)}</td>
                        <td className="px-2 py-1 text-right text-gray-300">{formatCurrency(order.totalUsdc)}</td>
                        <td className="px-2 py-1 text-gray-400">{fmtDate(order.time)}</td>
                        <td className="px-2 py-1 flex gap-1">
                          <button
                            onClick={() => openImportModal(order)}
                            className="px-2 py-0.5 rounded text-[10px] bg-blue-600/30 text-blue-400 hover:bg-blue-600/50 border border-blue-500/30"
                          >
                            Import
                          </button>
                          <button
                            onClick={() => handleDismiss(order.orderId)}
                            disabled={dismissing === order.orderId}
                            className="px-2 py-0.5 rounded text-[10px] bg-gray-600/30 text-gray-400 hover:bg-gray-600/50 border border-gray-500/30"
                          >
                            {dismissing === order.orderId ? '...' : 'Dismiss'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Import Modal */}
          {importModal && (
            <div className="bg-gray-900/60 rounded-lg p-4 border border-purple-500/30">
              <h4 className="text-xs font-medium text-purple-400 mb-3">
                Import {importModal.side.toUpperCase()}: {truncId(importModal.orderId)}
              </h4>

              {/* Order summary */}
              <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
                <div>
                  <span className="text-gray-500">Size:</span>
                  <span className="ml-1 text-gray-300">{importModal.totalBtc.toFixed(8)} BTC</span>
                </div>
                <div>
                  <span className="text-gray-500">Price:</span>
                  <span className="ml-1 text-gray-300">{formatPrice(importModal.avgPrice)}</span>
                </div>
                <div>
                  <span className="text-gray-500">Total:</span>
                  <span className="ml-1 text-gray-300">{formatCurrency(importModal.totalUsdc)}</span>
                </div>
              </div>

              {/* Tab selector */}
              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => { setImportTab('orphan'); setSelectedMatch(null) }}
                  className={`px-3 py-1 rounded text-xs ${
                    importTab === 'orphan'
                      ? 'bg-purple-600/50 text-purple-300 border border-purple-400/50'
                      : 'bg-gray-700 text-gray-400 border border-gray-600'
                  }`}
                >
                  Import as Orphan
                </button>
                <button
                  onClick={() => setImportTab('pair')}
                  className={`px-3 py-1 rounded text-xs ${
                    importTab === 'pair'
                      ? 'bg-purple-600/50 text-purple-300 border border-purple-400/50'
                      : 'bg-gray-700 text-gray-400 border border-gray-600'
                  }`}
                >
                  Pair with Match
                  {matchSuggestions.length > 0 && (
                    <span className="ml-1 text-[10px] opacity-60">({matchSuggestions.length})</span>
                  )}
                </button>
              </div>

              {/* Orphan tab */}
              {importTab === 'orphan' && (
                <div>
                  {importModal.side === 'sell' ? (
                    <>
                      {/* Existing sell orphan flow */}
                      <div className="flex gap-2 mb-3">
                        <button
                          onClick={() => setImportMode('place')}
                          className={`px-3 py-1 rounded text-xs ${
                            importMode === 'place'
                              ? 'bg-purple-600/50 text-purple-300 border border-purple-400/50'
                              : 'bg-gray-700 text-gray-400 border border-gray-600'
                          }`}
                        >
                          Place Recovery Buy
                        </button>
                        <button
                          onClick={() => setImportMode('link')}
                          className={`px-3 py-1 rounded text-xs ${
                            importMode === 'link'
                              ? 'bg-purple-600/50 text-purple-300 border border-purple-400/50'
                              : 'bg-gray-700 text-gray-400 border border-gray-600'
                          }`}
                        >
                          Link Existing Buy
                        </button>
                      </div>

                      {importMode === 'place' ? (
                        <div className="mb-3">
                          <label className="block text-[10px] text-gray-500 mb-1">Recovery Buy Limit Price (USD)</label>
                          <input
                            type="number"
                            value={recoveryBuyPrice}
                            onChange={(e) => setRecoveryBuyPrice(e.target.value)}
                            placeholder="e.g. 70000"
                            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-gray-300"
                          />
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            Will place a GTC limit buy for {importModal.totalBtc.toFixed(8)} BTC
                          </div>
                        </div>
                      ) : (
                        <div className="mb-3">
                          <label className="block text-[10px] text-gray-500 mb-1">Existing Buy Order ID</label>
                          <input
                            type="text"
                            value={existingBuyOrderId}
                            onChange={(e) => setExistingBuyOrderId(e.target.value)}
                            placeholder="e.g. abc123-def456-..."
                            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-gray-300 font-mono"
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    /* Buy orphan flow */
                    <div className="mb-3">
                      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createBody}
                          onChange={(e) => setCreateBody(e.target.checked)}
                          className="rounded border-gray-600 bg-gray-700"
                        />
                        Create celestial body for TP management
                      </label>
                      <div className="text-[10px] text-gray-500 mt-1 ml-5">
                        {createBody
                          ? 'Engine will create a satellite body and place a take-profit sell order'
                          : 'Buy fills will be ingested into the ledger without TP management'}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Pair tab */}
              {importTab === 'pair' && (
                <div>
                  {matchSuggestions.length === 0 ? (
                    <p className="text-xs text-gray-500 mb-3">
                      No {importModal.side === 'buy' ? 'sell' : 'buy'} orders available to pair with.
                    </p>
                  ) : (
                    <div className="mb-3 max-h-48 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-gray-800">
                          <tr className="text-gray-500 text-left">
                            <th className="px-2 py-1"></th>
                            <th className="px-2 py-1">Order ID</th>
                            <th className="px-2 py-1 text-right">Size</th>
                            <th className="px-2 py-1 text-right">Price</th>
                            <th className="px-2 py-1 text-right">Total</th>
                            <th className="px-2 py-1">Time</th>
                            <th className="px-2 py-1 text-right">Match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {matchSuggestions.map((s) => {
                            const isSelected = selectedMatch?.orderId === s.orderId
                            const buyPrice = importModal.side === 'buy' ? importModal.avgPrice : s.avgPrice
                            const sellPrice = importModal.side === 'sell' ? importModal.avgPrice : s.avgPrice
                            const pnlEst = (sellPrice - buyPrice) * Math.min(importModal.totalBtc, s.totalBtc)
                            return (
                              <tr
                                key={s.orderId}
                                onClick={() => setSelectedMatch(isSelected ? null : s)}
                                className={`border-t border-gray-700/50 cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'bg-purple-600/20 border-l-2 border-l-purple-400'
                                    : 'hover:bg-gray-700/30'
                                }`}
                              >
                                <td className="px-2 py-1">
                                  <span className={`w-3 h-3 rounded-full border inline-block ${
                                    isSelected ? 'bg-purple-400 border-purple-400' : 'border-gray-600'
                                  }`} />
                                </td>
                                <td className="px-2 py-1 font-mono text-gray-400">{truncId(s.orderId)}</td>
                                <td className="px-2 py-1 text-right text-gray-300">{s.totalBtc.toFixed(8)}</td>
                                <td className="px-2 py-1 text-right text-gray-300">{formatPrice(s.avgPrice)}</td>
                                <td className="px-2 py-1 text-right text-gray-300">{formatCurrency(s.totalUsdc)}</td>
                                <td className="px-2 py-1 text-gray-400">{fmtDate(s.time)}</td>
                                <td className="px-2 py-1 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <div className="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${s.score > 0.7 ? 'bg-green-400' : s.score > 0.4 ? 'bg-yellow-400' : 'bg-red-400'}`}
                                        style={{ width: `${s.score * 100}%` }}
                                      />
                                    </div>
                                    <span className="text-[10px] text-gray-500 w-8 text-right">
                                      {(s.score * 100).toFixed(0)}%
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* P&L preview when a match is selected */}
                  {selectedMatch && (
                    <div className="mb-3 p-2 rounded bg-gray-800/50 border border-gray-700">
                      <div className="text-xs text-gray-400 flex items-center gap-3">
                        {(() => {
                          const buyPrice = importModal.side === 'buy' ? importModal.avgPrice : selectedMatch.avgPrice
                          const sellPrice = importModal.side === 'sell' ? importModal.avgPrice : selectedMatch.avgPrice
                          const size = Math.min(importModal.totalBtc, selectedMatch.totalBtc)
                          const pnl = (sellPrice - buyPrice) * size
                          return (
                            <>
                              <span>Buy @ {formatPrice(buyPrice)}</span>
                              <span className="text-gray-600">&rarr;</span>
                              <span>Sell @ {formatPrice(sellPrice)}</span>
                              <span className="text-gray-600">=</span>
                              <span className={`font-medium ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)} P&L
                              </span>
                              {Math.abs(importModal.totalBtc - selectedMatch.totalBtc) > 0.000001 && (
                                <span className="text-[10px] text-yellow-500">
                                  (size mismatch: {importModal.totalBtc.toFixed(8)} vs {selectedMatch.totalBtc.toFixed(8)})
                                </span>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Note field */}
              <div className="mb-3">
                <label className="block text-[10px] text-gray-500 mb-1">Note (optional)</label>
                <input
                  type="text"
                  value={importNote}
                  onChange={(e) => setImportNote(e.target.value)}
                  placeholder="e.g. Manual rebalancing"
                  className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-gray-300"
                />
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={handleImport}
                  disabled={importBtnState.disabled}
                  className={`px-3 py-1 rounded text-xs font-medium ${
                    importBtnState.disabled
                      ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      : 'bg-purple-600/50 text-purple-300 hover:bg-purple-600/70 border border-purple-400/50'
                  }`}
                >
                  {importBtnState.label}
                </button>
                <button
                  onClick={() => setImportModal(null)}
                  className="px-3 py-1 rounded text-xs text-gray-400 hover:text-gray-300 bg-gray-700 border border-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Manual Trades List */}
          <div className="bg-gray-900/40 rounded-lg p-3">
            <h4 className="text-xs font-medium text-purple-400 mb-2 flex items-center gap-2">
              Tracked Manual Trades
              <button
                onClick={fetchManualTrades}
                disabled={tradesLoading}
                className="ml-auto px-2 py-0.5 rounded text-[10px] bg-gray-700 text-gray-400 hover:bg-gray-600 border border-gray-600"
              >
                {tradesLoading ? '...' : 'Refresh'}
              </button>
            </h4>

            {manualTrades.length === 0 ? (
              <p className="text-xs text-gray-500">No manual trades tracked yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 text-left">
                      <th className="px-2 py-1">Status</th>
                      <th className="px-2 py-1">Type</th>
                      <th className="px-2 py-1">Anchor</th>
                      <th className="px-2 py-1 text-right">Size</th>
                      <th className="px-2 py-1 text-right">Buy Price</th>
                      <th className="px-2 py-1 text-right">Sell Price</th>
                      <th className="px-2 py-1 text-right">P&L</th>
                      <th className="px-2 py-1">Note</th>
                      <th className="px-2 py-1">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manualTrades.map((trade) => {
                      const isBuyFirst = trade.tradeType === 'buy_first'
                      const isPaired = trade.tradeType === 'paired'
                      const anchorId = isBuyFirst ? trade.buyOrderId : trade.sellOrderId
                      const anchorSize = isBuyFirst ? trade.buySize : trade.sellSize

                      const pnl = trade.status === 'completed' && trade.buyPrice && trade.sellPrice
                        ? (trade.sellPrice - trade.buyPrice) * (trade.sellSize || trade.buySize)
                        : null

                      return (
                        <tr key={trade.id} className="border-t border-gray-700/50 hover:bg-gray-700/30">
                          <td className="px-2 py-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_COLORS[trade.status] || STATUS_COLORS.dismissed}`}>
                              {STATUS_LABELS[trade.status] || trade.status}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-[10px] text-gray-500">
                            {isPaired ? 'Pair' : isBuyFirst ? 'Buy\u2192TP' : 'Sell\u2192Buy'}
                          </td>
                          <td className="px-2 py-1 font-mono text-gray-400">{truncId(anchorId)}</td>
                          <td className="px-2 py-1 text-right text-gray-300">{anchorSize?.toFixed(8)}</td>
                          <td className="px-2 py-1 text-right text-green-400">
                            {trade.buyPrice ? formatPrice(trade.buyPrice) : '-'}
                          </td>
                          <td className="px-2 py-1 text-right text-red-400">
                            {trade.sellPrice ? formatPrice(trade.sellPrice) : '-'}
                          </td>
                          <td className={`px-2 py-1 text-right font-medium ${pnl === null ? 'text-gray-500' : pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {pnl !== null ? `${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}` : '-'}
                          </td>
                          <td className="px-2 py-1 text-gray-500 max-w-[120px] truncate" title={trade.note}>
                            {trade.note || '-'}
                          </td>
                          <td className="px-2 py-1">
                            {(trade.status === 'buy_pending' || trade.status === 'tp_pending') && (
                              <button
                                onClick={() => handleCheckStatus(trade.id)}
                                disabled={checking === trade.id}
                                className="px-2 py-0.5 rounded text-[10px] bg-yellow-600/30 text-yellow-400 hover:bg-yellow-600/50 border border-yellow-500/30"
                              >
                                {checking === trade.id ? 'Checking...' : 'Check Status'}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default ManualTrades
