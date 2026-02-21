import { useState, useEffect, useCallback } from 'react'
import { formatCurrency, formatPrice } from './charts/chartUtils'
import { getBaseCurrency } from '../App'

function CostBasisRegime({ exchange = 'coinbase' }) {
  const [status, setStatus] = useState(null)
  const [fills, setFills] = useState([])
  const [loading, setLoading] = useState(true)
  const [currentPrice, setCurrentPrice] = useState(0)
  const [productId, setProductId] = useState(null)

  const formatAsset = (n) => (n || 0).toFixed(8)

  const fetchData = useCallback(async () => {
    const [statusRes, fillsRes, configRes] = await Promise.all([
      fetch(`/api/${exchange}/regime/status`),
      fetch(`/api/${exchange}/regime/fills`),
      fetch(`/api/${exchange}/config`),
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
  }, [exchange])

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

  const cycles = Object.values(cycleData).sort((a, b) => {
    // Sort current cycle first, then by most recent
    if (a.cycleId === 'current') return -1
    if (b.cycleId === 'current') return 1
    return b.cycleId.localeCompare(a.cycleId)
  })

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
    <div className="space-y-6">
      {/* Current Price Banner */}
      <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
        <div>
          <span className="text-gray-400">Current {baseCurrency} Price:</span>
          <span className="text-3xl font-bold ml-4">{formatPrice(currentPrice)}</span>
        </div>
        <div>
          <span className="text-gray-400">Avg Cost Basis:</span>
          <span className="text-2xl font-semibold ml-4">{formatPrice(avgCost)}</span>
        </div>
        {isDryRun && (
          <span className="px-3 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-sm rounded">
            Dry-Run Mode
          </span>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Asset Position */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-orange-400 mb-3">{baseCurrency} Position</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Total {baseCurrency}:</span>
              <span className="font-mono">{formatAsset(totalAsset)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cost Basis:</span>
              <span>{formatCurrency(totalCostBasis)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Current Value:</span>
              <span>{formatCurrency(currentValue)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-700 pt-2 mt-2">
              <span className="text-gray-400">Unrealized P&L:</span>
              <span className={unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
                {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                <span className="text-sm ml-1">({unrealizedPnLPercent >= 0 ? '+' : ''}{unrealizedPnLPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </div>

        {/* Asset Reserves (Holdback) */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-cyan-400 mb-3">{baseCurrency} Reserves</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Amount:</span>
              <span className="font-mono">{formatAsset(assetReserves)} {baseCurrency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Current Value:</span>
              <span>{formatCurrency(assetReservesUsd)}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-500 pt-2">
              <span>Accumulated from holdback on profitable cycles</span>
            </div>
          </div>
        </div>

        {/* Realized P&L */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-green-400 mb-3">Realized P&L</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">USDC Profit:</span>
              <span className={`text-2xl font-bold ${realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {realizedPnL >= 0 ? '+' : ''}{formatCurrency(realizedPnL)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cycles Completed:</span>
              <span className="font-mono">{position.cyclesCompleted || 0}</span>
            </div>
          </div>
        </div>

        {/* Combined Value */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-purple-400 mb-3">Total Value</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Position + Reserves:</span>
              <span className="font-mono">{formatAsset(totalAsset + assetReserves)} {baseCurrency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Combined Value:</span>
              <span className="text-xl font-semibold">{formatCurrency(currentValue + assetReservesUsd)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-700 pt-2 mt-2">
              <span className="text-gray-400">Total Return:</span>
              <span className={`${(realizedPnL + unrealizedPnL + assetReservesUsd) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {(realizedPnL + unrealizedPnL + assetReservesUsd) >= 0 ? '+' : ''}
                {formatCurrency(realizedPnL + unrealizedPnL + assetReservesUsd)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Cycle History */}
      <div className="bg-gray-800 rounded-lg p-4">
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
                <div key={cycle.cycleId} className="border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-1 rounded text-xs ${
                        cycle.cycleId === 'current'
                          ? 'bg-blue-900/50 text-blue-400'
                          : isComplete
                            ? 'bg-green-900/50 text-green-400'
                            : 'bg-yellow-900/50 text-yellow-400'
                      }`}>
                        {cycle.cycleId === 'current' ? 'Current Cycle' : cycle.cycleId}
                      </span>
                      <span className="text-sm text-gray-500">
                        {cycle.entries.length} entries, {cycle.exits.length} exits
                      </span>
                    </div>
                    {isComplete && (
                      <span className={`text-sm ${cyclePnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        P&L: {cyclePnL >= 0 ? '+' : ''}{formatCurrency(cyclePnL)}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Bought:</span>
                      <span className="ml-2 font-mono">{formatAsset(cycle.totalBought)} {baseCurrency}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Cost:</span>
                      <span className="ml-2">{formatCurrency(cycle.totalCost)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Avg Entry:</span>
                      <span className="ml-2">{formatPrice(avgEntry)}</span>
                    </div>
                    {cycle.totalSold > 0 && (
                      <div>
                        <span className="text-gray-500">Avg Exit:</span>
                        <span className="ml-2">{formatPrice(avgExit)}</span>
                      </div>
                    )}
                  </div>

                  {/* Fill details (collapsed by default for completed cycles) */}
                  {cycle.cycleId === 'current' && cycle.entries.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-700">
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
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Explanation */}
      <div className="bg-gray-800/50 rounded-lg p-4 text-sm text-gray-400">
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
