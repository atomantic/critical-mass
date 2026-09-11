import { useState, useEffect, useCallback } from 'react'
import { formatCurrency, formatPrice, formatAsset } from './charts/chartUtils'
import { getBaseCurrency } from '../App'
import { pairQuery as buildPairQuery } from '../utils/api'
import { compareCycleIds } from '../utils/regimeFillGroups.mjs'

function CostBasisRegime({ exchange = 'coinbase', pair }) {
  const [status, setStatus] = useState(null)
  const [fills, setFills] = useState([])
  const [loading, setLoading] = useState(true)
  const [currentPrice, setCurrentPrice] = useState(0)
  const [productId, setProductId] = useState(null)

  const pairQuery = buildPairQuery(pair)

  const fetchData = useCallback(async () => {
    const [statusRes, fillsRes, configRes] = await Promise.all([
      fetch(`/api/${exchange}/regime/status${pairQuery}`),
      fetch(`/api/${exchange}/regime/fills${pairQuery}`),
      fetch(`/api/${exchange}/config${pairQuery}`),
    ])

    if (statusRes.ok) {
      const data = await statusRes.json()
      setStatus(data.status)
      setCurrentPrice(data.status?.market?.lastPrice || 0)
    }
    if (fillsRes.ok) {
      const data = await fillsRes.json()
      setFills(data.fills || [])
    }
    if (configRes.ok) {
      const data = await configRes.json()
      setProductId(data.config?.productId || data.productId || null)
    }
    setLoading(false)
  }, [exchange, pairQuery])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

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

  // Calculate cycle-based P&L from fills
  const cycleData = fills.reduce((acc, fill) => {
    const cycleId = fill.cycleId || 'current'
    if (!acc[cycleId]) {
      acc[cycleId] = {
        cycleId,
        entries: [],
        exits: [],
        totalBought: 0,
        totalSold: 0,
        totalCost: 0,
        totalProceeds: 0,
        holdback: 0,
      }
    }
    if (fill.side === 'buy') {
      acc[cycleId].entries.push(fill)
      acc[cycleId].totalBought += fill.size
      acc[cycleId].totalCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || 0)
    } else {
      acc[cycleId].exits.push(fill)
      acc[cycleId].totalSold += fill.size
      acc[cycleId].totalProceeds += (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || 0)
    }
    return acc
  }, {})

  const cycles = Object.values(cycleData).sort((a, b) => compareCycleIds(a.cycleId, b.cycleId))

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
      {/* Current Price Banner */}
      <div className="bg-gray-800 rounded-lg p-4 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <span className="block text-gray-400 break-words">Current {baseCurrency} Price:</span>
          <span className="block text-3xl font-bold break-words">{formatPrice(currentPrice)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <span className="block text-gray-400 break-words">Avg Cost Basis:</span>
          <span className="block text-2xl font-semibold break-words">{formatPrice(avgCost)}</span>
        </div>
        {isDryRun && (
          <span className="self-start shrink-0 px-3 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-sm rounded sm:self-auto">
            Dry-Run Mode
          </span>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Asset Position */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 break-words text-lg font-semibold text-orange-400 mb-3">{baseCurrency} Position</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Total {baseCurrency}:</span>
              <span className="min-w-0 max-w-full break-words text-right font-mono">{formatAsset(totalAsset)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Cost Basis:</span>
              <span className="min-w-0 max-w-full break-words text-right">{formatCurrency(totalCostBasis)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Current Value:</span>
              <span className="min-w-0 max-w-full break-words text-right">{formatCurrency(currentValue)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-gray-700 pt-2 mt-2">
              <span className="min-w-0 break-words text-gray-400">Unrealized P&L:</span>
              <span className={`min-w-0 max-w-full break-words text-right ${unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                <span className="text-sm ml-1">({unrealizedPnLPercent >= 0 ? '+' : ''}{unrealizedPnLPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </div>

        {/* Asset Reserves (Holdback) */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 break-words text-lg font-semibold text-cyan-400 mb-3">{baseCurrency} Reserves</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Amount:</span>
              <span className="min-w-0 max-w-full break-words text-right font-mono">{formatAsset(assetReserves)} {baseCurrency}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Current Value:</span>
              <span className="min-w-0 max-w-full break-words text-right">{formatCurrency(assetReservesUsd)}</span>
            </div>
            <div className="flex flex-wrap text-sm text-gray-500 pt-2">
              <span className="min-w-0 break-words">Accumulated from holdback on profitable cycles</span>
            </div>
          </div>
        </div>

        {/* Realized P&L */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 break-words text-lg font-semibold text-green-400 mb-3">Realized P&L</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">USDC Profit:</span>
              <span className={`min-w-0 max-w-full break-words text-right text-2xl font-bold ${realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {realizedPnL >= 0 ? '+' : ''}{formatCurrency(realizedPnL)}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Cycles Completed:</span>
              <span className="min-w-0 max-w-full break-words text-right font-mono">{position.cyclesCompleted || 0}</span>
            </div>
          </div>
        </div>

        {/* Combined Value */}
        <div className="min-w-0 bg-gray-800 rounded-lg p-4">
          <h3 className="min-w-0 break-words text-lg font-semibold text-purple-400 mb-3">Total Value</h3>
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Position + Reserves:</span>
              <span className="min-w-0 max-w-full break-words text-right font-mono">{formatAsset(totalAsset + assetReserves)} {baseCurrency}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-gray-400">Combined Value:</span>
              <span className="min-w-0 max-w-full break-words text-right text-xl font-semibold">{formatCurrency(currentValue + assetReservesUsd)}</span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-gray-700 pt-2 mt-2">
              <span className="min-w-0 break-words text-gray-400">Total Return:</span>
              <span className={`min-w-0 max-w-full break-words text-right ${(realizedPnL + unrealizedPnL + assetReservesUsd) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {(realizedPnL + unrealizedPnL + assetReservesUsd) >= 0 ? '+' : ''}
                {formatCurrency(realizedPnL + unrealizedPnL + assetReservesUsd)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Cycle History */}
      <div className="min-w-0 bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Cycle-Based Cost Breakdown</h3>
        {cycles.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
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
                      <span className="min-w-0 break-words text-sm text-gray-500">
                        {cycle.entries.length} entries, {cycle.exits.length} exits
                      </span>
                    </div>
                    {isComplete && (
                      <span className={`min-w-0 break-words text-sm ${cyclePnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        P&L: {cyclePnL >= 0 ? '+' : ''}{formatCurrency(cyclePnL)}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
                    <div className="min-w-0">
                      <span className="block text-gray-500">Bought:</span>
                      <span className="block min-w-0 break-words font-mono">{formatAsset(cycle.totalBought)} {baseCurrency}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="block text-gray-500">Cost:</span>
                      <span className="block min-w-0 break-words">{formatCurrency(cycle.totalCost)}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="block text-gray-500">Avg Entry:</span>
                      <span className="block min-w-0 break-words">{formatPrice(avgEntry)}</span>
                    </div>
                    {cycle.totalSold > 0 && (
                      <div className="min-w-0">
                        <span className="block text-gray-500">Avg Exit:</span>
                        <span className="block min-w-0 break-words">{formatPrice(avgExit)}</span>
                      </div>
                    )}
                  </div>

                  {/* Fill details (collapsed by default for completed cycles) */}
                  {cycle.cycleId === 'current' && cycle.entries.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-700">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500">
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
          <li><strong>Realized P&L</strong>: USDC profit from completed cycles</li>
          <li><strong>Total Value</strong>: Combines position + reserves + realized profit</li>
        </ul>
      </div>
    </div>
  )
}

export default CostBasisRegime
