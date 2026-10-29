import Button from './ui/Button'
import { useState, useEffect, useCallback, useRef } from 'react'
import { plural } from '../utils/plural.mjs'
import { formatCurrency, formatPrice, formatAsset } from './charts/chartUtils'
import { getBaseCurrency, getQuoteCurrency } from '../App'
import { pairQuery as buildPairQuery } from '../utils/api'
import { apiGet } from '../utils/apiClient'
import { pnlColorClass, signedPrefix } from '../utils/pnlFormat.mjs'
import useRealtimeRefresh from '../hooks/useRealtimeRefresh'
import { useRegimeEvents } from '../hooks/useTradeEvents'

function CostBasisRegime({ exchange = 'coinbase', pair }) {
  const [status, setStatus] = useState(null)
  const [fillAggregates, setFillAggregates] = useState(null)
  const [loading, setLoading] = useState(true)
  const [currentPrice, setCurrentPrice] = useState(0)
  const [productId, setProductId] = useState(null)
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false)

  const pairQuery = buildPairQuery(pair)

  const readState = useRef(null)
  const { status: liveStatus } = useRegimeEvents(exchange, pair)
  const liveStatusRef = useRef(liveStatus)
  liveStatusRef.current = liveStatus

  const fetchData = useCallback(async () => {
    const session = readState.current
    if (!session?.active) return
    // A change that lands mid-read must not be lost: read again once this one ends.
    if (session.inFlight) { session.rerun = true; return }
    session.inFlight = true
    const liveStatusAtStart = liveStatusRef.current
    const controller = new AbortController()
    session.controller = controller

    const read = async (endpoint, name, revision) => {
      const conditionalQuery = revision ? `${pairQuery ? '&' : '?'}revision=${encodeURIComponent(revision)}` : ''
      const result = await apiGet(`/api/${exchange}/${endpoint}${pairQuery}${conditionalQuery}`, { signal: controller.signal })
      if (!result.ok) throw new Error(result.status ? `${name} fetch failed: HTTP ${result.status}` : result.error)
      return result.data
    }

    try {
      // Settle the whole batch even when one endpoint fails, so interval ticks
      // cannot overlap a still-pending request from the failed batch.
      const results = await Promise.allSettled([
        read('regime/status', 'Status'),
        read('regime/fills/cycles', 'Fill cycles', session.aggregates?.revision),
        session.config ? Promise.resolve(session.config) : read('config', 'Config'),
      ])
      if (!session.active) return
      const failure = results.find(result => result.status === 'rejected')
      if (failure) throw failure.reason
      const [statusData, fillsData, configData] = results.map(result => result.value)

      if (fillsData.unchanged && (!session.aggregates || fillsData.revision !== session.aggregates.revision)) {
        throw new Error('Fill cycles returned an invalid unchanged revision')
      }

      // Commit a complete snapshot only while this fund still owns the read.
      session.config = configData
      session.hasSnapshot = true
      setStatus(statusData.status)
      // A newer socket price may have arrived while this batch was in flight.
      if (liveStatusRef.current === liveStatusAtStart || !(liveStatusRef.current?.market?.lastPrice > 0)) {
        setCurrentPrice(statusData.status?.market?.lastPrice || 0)
      }
      if (!fillsData.unchanged) {
        session.aggregates = fillsData
        setFillAggregates(fillsData)
      }
      setProductId(configData.config?.productId || configData.productId || null)
      setError(null)
      setStale(false)
    } catch (err) {
      if (!session.active) return
      if (!session.hasSnapshot) {
        setError(err.message || 'Failed to load regime cost basis')
      } else {
        setStale(true)
      }
    } finally {
      session.inFlight = false
      if (session.active) setLoading(false)
      if (session.active && session.rerun) {
        session.rerun = false
        fetchData()
      }
    }
  }, [exchange, pairQuery])

  useEffect(() => {
    const session = { active: true, inFlight: false, hasSnapshot: false, config: null, aggregates: null, controller: null }
    readState.current = session
    setStatus(null)
    setFillAggregates(null)
    setCurrentPrice(0)
    setProductId(null)
    setError(null)
    setStale(false)
    setLoading(true)
    return () => {
      session.active = false
      session.controller?.abort()
    }
  }, [fetchData])
  // Declared after the reset effect so each restart reseeds the session first.
  // One read, then re-read when this fund's orders, cycles or state change (#1880).
  useEffect(() => {
    fetchData()
  }, [fetchData])
  useRealtimeRefresh({
    events: ['regime:changed', 'regime:state'],
    filter: (event) => event?.exchange === exchange && (!pair || !event.pair || event.pair === pair),
    minIntervalMs: 2000,
    onRefresh: fetchData,
  })
  // The price follows the fund's live status stream instead of a read per poll.
  const livePrice = liveStatus?.market?.lastPrice
  useEffect(() => {
    if (livePrice > 0) setCurrentPrice(livePrice)
  }, [livePrice])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-red-400">Error: {error}</div>
        <Button
          onClick={fetchData}
          variant="primary" size="md"
        >
          Retry
        </Button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime cost basis...</div>
      </div>
    )
  }

  const position = status?.position || {}
  const isDryRun = status?.isDryRun
  const baseCurrency = getBaseCurrency(productId)
  const quoteCurrency = getQuoteCurrency(productId || pair)

  const cycles = (fillAggregates?.cycles || []).map(cycle => ({
    ...cycle,
    entries: (fillAggregates.detailFills || []).filter(fill => (fill.cycleId || 'current') === cycle.cycleId && fill.side === 'buy'),
    exits: (fillAggregates.detailFills || []).filter(fill => (fill.cycleId || 'current') === cycle.cycleId && fill.side === 'sell'),
  }))

  // Calculate totals
  const totalAsset = position.totalAsset || 0
  const totalCostBasis = position.totalCostBasis || 0
  const avgCost = position.avgCostBasis || 0
  const currentValue = totalAsset * currentPrice
  const unrealizedPnL = currentValue - totalCostBasis
  const unrealizedPnLPercent = totalCostBasis > 0 ? ((currentValue / totalCostBasis) - 1) * 100 : 0
  const realizedPnL = position.realizedPnL || 0
  const assetReserves = position.realizedAssetPnL || 0
  const assetReservesUsd = assetReserves * currentPrice

  return (
    <div className="min-w-0 space-y-6">
      {/* Stale/Error Notice */}
      {stale && (
        <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-yellow-400">Data is stale. Waiting for the next successful refresh...</span>
          <Button
            onClick={fetchData}
            variant="warning" size="sm" className="self-start sm:self-auto"
          >
            Refresh Now
          </Button>
        </div>
      )}

      {/* Current Price Banner */}
      <div className="bg-gray-800 rounded-lg p-4 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <span className="block text-gray-400 wrap-break-word">Current {baseCurrency} Price:</span>
          <span className="block text-3xl font-bold wrap-break-word">{formatPrice(currentPrice)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <span className="block text-gray-400 wrap-break-word">Avg Cost Basis:</span>
          <span className="block text-2xl font-semibold wrap-break-word">{formatPrice(avgCost)}</span>
        </div>
        {isDryRun && (
          <span className="self-start shrink-0 px-3 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-sm rounded-sm sm:self-auto">
            Dry-Run Mode
          </span>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Asset Position */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 wrap-break-word text-lg font-semibold text-orange-400 mb-3">{baseCurrency} Position</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Total {baseCurrency}:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right font-mono">{formatAsset(totalAsset)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Cost Basis:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right">{formatCurrency(totalCostBasis)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Current Value:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right">{formatCurrency(currentValue)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-gray-700 pt-2 mt-2">
              <span className="min-w-0 wrap-break-word text-gray-400">Unrealized P&L:</span>
              <span className={`min-w-0 max-w-full wrap-break-word text-right ${pnlColorClass(unrealizedPnL)}`}>
                {signedPrefix(unrealizedPnL)}{formatCurrency(unrealizedPnL)}
                <span className="text-sm ml-1">({signedPrefix(unrealizedPnLPercent)}{unrealizedPnLPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </div>

        {/* Asset Reserves (Holdback) */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 wrap-break-word text-lg font-semibold text-cyan-400 mb-3">{baseCurrency} Reserves</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Amount:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right font-mono">{formatAsset(assetReserves)} {baseCurrency}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Current Value:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right">{formatCurrency(assetReservesUsd)}</span>
            </div>
            <div className="flex flex-wrap text-sm text-gray-400 pt-2">
              <span className="min-w-0 wrap-break-word">Accumulated from holdback on profitable cycles</span>
            </div>
          </div>
        </div>

        {/* Realized P&L */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 wrap-break-word text-lg font-semibold text-green-400 mb-3">Realized P&L</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">{quoteCurrency} Profit:</span>
              <span className={`min-w-0 max-w-full wrap-break-word text-right text-2xl font-bold ${pnlColorClass(realizedPnL)}`}>
                {signedPrefix(realizedPnL)}{formatCurrency(realizedPnL)}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Cycles Completed:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right font-mono">{position.cyclesCompleted || 0}</span>
            </div>
          </div>
        </div>

        {/* Combined Value */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 wrap-break-word text-lg font-semibold text-purple-400 mb-3">Total Value</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Position + Reserves:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right font-mono">{formatAsset(totalAsset + assetReserves)} {baseCurrency}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 wrap-break-word text-gray-400">Combined Value:</span>
              <span className="min-w-0 max-w-full wrap-break-word text-right text-xl font-semibold">{formatCurrency(currentValue + assetReservesUsd)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-gray-700 pt-2 mt-2">
              <span className="min-w-0 wrap-break-word text-gray-400">Total Return:</span>
              <span className={`min-w-0 max-w-full wrap-break-word text-right ${pnlColorClass(realizedPnL + unrealizedPnL + assetReservesUsd)}`}>
                {signedPrefix(realizedPnL + unrealizedPnL + assetReservesUsd)}
                {formatCurrency(realizedPnL + unrealizedPnL + assetReservesUsd)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Cycle History */}
      <div className="min-w-0 bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Cycle-Based Cost Breakdown</h3>
        {fillAggregates?.cyclesTruncated && <p className="text-sm text-gray-400 mb-3">Showing the latest {cycles.length} of {fillAggregates.cycleCount} cycles. Position totals include all history.</p>}
        {cycles.length === 0 ? (
          <div className="text-center text-gray-400 py-8">
            No cycle data available. Start the regime engine to begin trading.
          </div>
        ) : (
          <div className="space-y-4">
            {cycles.map((cycle, i) => {
              const isComplete = cycle.cycleId !== 'current' && cycle.totalSold > 0
              const cyclePnL = cycle.totalProceeds - (cycle.totalCost * (cycle.totalSold / cycle.totalBought || 0))
              const avgEntry = cycle.totalBought > 0 ? cycle.totalCost / cycle.totalBought : 0
              const avgExit = cycle.totalSold > 0 ? cycle.totalProceeds / cycle.totalSold : 0

              return (
                <div key={cycle.cycleId} className="min-w-0 border border-gray-700 rounded-lg p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                    <div className="min-w-0 flex-1 flex flex-wrap items-center gap-3">
                      <span className={`px-2 py-1 rounded text-xs ${
                        cycle.cycleId === 'current'
                          ? 'bg-blue-900/50 text-blue-400'
                          : isComplete
                            ? 'bg-green-900/50 text-green-400'
                            : 'bg-yellow-900/50 text-yellow-400'
                      }`}>
                        {cycle.cycleId === 'current' ? 'Current Cycle' : cycle.cycleId}
                      </span>
                      <span className="min-w-0 wrap-break-word text-sm text-gray-400">
                        {plural(cycle.entryCount, "entry", "entries")}, {plural(cycle.exitCount, "exit")}
                      </span>
                    </div>
                    {isComplete && (
                      <span className={`min-w-0 wrap-break-word text-sm ${pnlColorClass(cyclePnL)}`}>
                        P&L: {signedPrefix(cyclePnL)}{formatCurrency(cyclePnL)}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                    <div className="min-w-0">
                      <span className="block text-gray-400">Bought:</span>
                      <span className="block min-w-0 wrap-break-word font-mono">{formatAsset(cycle.totalBought)} {baseCurrency}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="block text-gray-400">Cost:</span>
                      <span className="block min-w-0 wrap-break-word">{formatCurrency(cycle.totalCost)}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="block text-gray-400">Avg Entry:</span>
                      <span className="block min-w-0 wrap-break-word">{formatPrice(avgEntry)}</span>
                    </div>
                    {cycle.totalSold > 0 && (
                      <div className="min-w-0">
                        <span className="block text-gray-400">Avg Exit:</span>
                        <span className="block min-w-0 wrap-break-word">{formatPrice(avgExit)}</span>
                      </div>
                    )}
                  </div>

                  {/* Fill details (collapsed by default for completed cycles) */}
                  {cycle.cycleId === 'current' && cycle.entries.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-700">
                      {cycle.entryCount + cycle.exitCount > cycle.entries.length + cycle.exits.length && <p className="text-xs text-gray-400 mb-2">Recent fill details shown; cycle totals include all fills.</p>}
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-400">
                              <th className="text-left pb-1">Time</th>
                              <th className="text-left pb-1">Side</th>
                              <th className="text-right pb-1">Size</th>
                              <th className="text-right pb-1">Price</th>
                              <th className="text-right pb-1">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...cycle.entries, ...cycle.exits]
                              .sort((a, b) => a.timestamp - b.timestamp)
                              .map((fill, idx) => (
                                <tr key={idx} className="border-t border-gray-700/50">
                                  <td className="py-1 text-gray-400">
                                    {new Date(fill.timestamp).toLocaleTimeString()}
                                  </td>
                                  <td className={`py-1 ${fill.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
                                    {fill.side.toUpperCase()}
                                  </td>
                                  <td className="py-1 text-right font-mono">{formatAsset(fill.size)}</td>
                                  <td className="py-1 text-right">{formatPrice(fill.price)}</td>
                                  <td className="py-1 text-right">{formatCurrency(fill.quoteAmount || fill.size * fill.price)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Explanation */}
      <div className="min-w-0 bg-gray-800/50 rounded-lg p-4 text-sm text-gray-400">
        <h4 className="font-semibold text-gray-300 mb-2">Understanding Regime Cost Basis</h4>
        <ul className="list-disc list-inside space-y-1">
          <li><strong>Cycle-based</strong>: Each trading cycle (entry to TP fill) is tracked separately</li>
          <li><strong>Position</strong>: Current {baseCurrency} held from active entries</li>
          <li><strong>{baseCurrency} Reserves</strong>: Accumulated holdback from profitable take-profit fills</li>
          <li><strong>Realized P&L</strong>: {quoteCurrency} profit from completed cycles</li>
          <li><strong>Total Value</strong>: Combines position + reserves + realized profit</li>
        </ul>
      </div>
    </div>
  )
}

export default CostBasisRegime
