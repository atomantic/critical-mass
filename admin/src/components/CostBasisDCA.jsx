import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { formatCurrency, formatPrice } from './charts/chartUtils'
import { getBaseCurrency } from '../App'

function CostBasisDCA({ summary, quoteCurrency = 'USDC' }) {
  const baseCurrency = getBaseCurrency(summary?.config?.productId)
  const { exchange = 'coinbase' } = useParams()
  const [currentPrice, setCurrentPrice] = useState(0)

  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res = await fetch(`/api/${exchange}/status`)
        const data = await res.json()
        setCurrentPrice(data.currentPrice || 0)
      } catch (err) {
        console.error('Failed to fetch price:', err)
      }
    }
    fetchPrice()
    const interval = setInterval(fetchPrice, 10000)
    return () => clearInterval(interval)
  }, [exchange])

  if (!summary?.costBasis) {
    return (
      <div className="text-center text-gray-400 py-8">
        No cost basis data available yet. Run the bot to generate data.
      </div>
    )
  }

  const { costBasis } = summary
  // formatCurrency for totals, formatPrice for per-unit prices
  const formatAsset = (n) => (n || 0).toFixed(8)

  // Calculate unrealized P&L
  const reservesCurrentValue = costBasis.reservesAsset * currentPrice
  const reservesUnrealizedPnL = reservesCurrentValue - costBasis.reservesCostBasis
  const reservesPnLPercent = costBasis.reservesCostBasis > 0
    ? ((reservesCurrentValue / costBasis.reservesCostBasis) - 1) * 100
    : 0

  const pendingCurrentValue = costBasis.pendingAsset * currentPrice
  const pendingUnrealizedPnL = pendingCurrentValue - costBasis.pendingCostBasis
  const pendingPnLPercent = costBasis.pendingCostBasis > 0
    ? ((pendingCurrentValue / costBasis.pendingCostBasis) - 1) * 100
    : 0

  const totalCurrentValue = reservesCurrentValue + pendingCurrentValue
  const totalHeldCostBasis = costBasis.reservesCostBasis + costBasis.pendingCostBasis
  const totalUnrealizedPnL = totalCurrentValue - totalHeldCostBasis
  const totalPnLPercent = totalHeldCostBasis > 0
    ? ((totalCurrentValue / totalHeldCostBasis) - 1) * 100
    : 0

  // Realized P&L from filled orders
  const realizedPnL = costBasis.orderBreakdown
    .filter(o => o.status === 'filled' && o.realizedPnL !== null)
    .reduce((sum, o) => sum + o.realizedPnL, 0)

  return (
    <div className="space-y-6">
      {/* Current Price Banner */}
      <div className="bg-gray-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <span className="text-gray-400">Current {baseCurrency} Price:</span>
          <span className="text-2xl sm:text-3xl font-bold ml-2 sm:ml-4">{formatPrice(currentPrice)}</span>
        </div>
        <div>
          <span className="text-gray-400">Avg Cost Basis:</span>
          <span className="text-xl sm:text-2xl font-semibold ml-2 sm:ml-4">{formatPrice(costBasis.avgCostPerAsset)}</span>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Reserves */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">{baseCurrency} Reserves (Holdback)</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Amount:</span>
              <span className="font-mono">{formatAsset(costBasis.reservesAsset)} {baseCurrency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cost Basis:</span>
              <span>{formatCurrency(costBasis.reservesCostBasis)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Cost/{baseCurrency}:</span>
              <span>{formatPrice(costBasis.reservesAvgCost)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Current Value:</span>
              <span>{formatCurrency(reservesCurrentValue)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-700 pt-2 mt-2">
              <span className="text-gray-400">Unrealized P&L:</span>
              <span className={reservesUnrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
                {reservesUnrealizedPnL >= 0 ? '+' : ''}{formatCurrency(reservesUnrealizedPnL)}
                <span className="text-sm ml-1">({reservesPnLPercent >= 0 ? '+' : ''}{reservesPnLPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </div>

        {/* Pending Orders */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-purple-400 mb-3">Pending Sell Orders</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Amount:</span>
              <span className="font-mono">{formatAsset(costBasis.pendingAsset)} {baseCurrency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cost Basis:</span>
              <span>{formatCurrency(costBasis.pendingCostBasis)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Cost/{baseCurrency}:</span>
              <span>{formatPrice(costBasis.pendingAvgCost)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Current Value:</span>
              <span>{formatCurrency(pendingCurrentValue)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-700 pt-2 mt-2">
              <span className="text-gray-400">Unrealized P&L:</span>
              <span className={pendingUnrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
                {pendingUnrealizedPnL >= 0 ? '+' : ''}{formatCurrency(pendingUnrealizedPnL)}
                <span className="text-sm ml-1">({pendingPnLPercent >= 0 ? '+' : ''}{pendingPnLPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </div>

        {/* Total */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-blue-400 mb-3">Total {baseCurrency} Holdings</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Amount:</span>
              <span className="font-mono">{formatAsset(costBasis.reservesAsset + costBasis.pendingAsset)} {baseCurrency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cost Basis:</span>
              <span>{formatCurrency(totalHeldCostBasis)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg Cost/{baseCurrency}:</span>
              <span>{formatPrice(costBasis.avgCostPerAsset)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Current Value:</span>
              <span>{formatCurrency(totalCurrentValue)}</span>
            </div>
            <div className="flex justify-between border-t border-gray-700 pt-2 mt-2">
              <span className="text-gray-400">Unrealized P&L:</span>
              <span className={totalUnrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
                {totalUnrealizedPnL >= 0 ? '+' : ''}{formatCurrency(totalUnrealizedPnL)}
                <span className="text-sm ml-1">({totalPnLPercent >= 0 ? '+' : ''}{totalPnLPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Realized P&L */}
      {realizedPnL !== 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-3">Realized P&L (from filled sell orders)</h3>
          <div className={`text-3xl font-bold ${realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {realizedPnL >= 0 ? '+' : ''}{formatCurrency(realizedPnL)}
          </div>
        </div>
      )}

      {/* Order Breakdown Table */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Cost Basis by Order</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-2 whitespace-nowrap">Date</th>
                <th className="pb-2 whitespace-nowrap">Buy Price</th>
                <th className="pb-2 whitespace-nowrap">{baseCurrency} Bought</th>
                <th className="pb-2 whitespace-nowrap">Cost Basis</th>
                <th className="pb-2 whitespace-nowrap">Net Fees</th>
                <th className="pb-2 whitespace-nowrap">Cost/{baseCurrency}</th>
                <th className="pb-2 whitespace-nowrap">Holdback</th>
                <th className="pb-2 whitespace-nowrap">Sell Order</th>
                <th className="pb-2 whitespace-nowrap">Status</th>
                <th className="pb-2 whitespace-nowrap">P&L</th>
              </tr>
            </thead>
            <tbody>
              {costBasis.orderBreakdown.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-4 text-center text-gray-500">
                    No orders yet
                  </td>
                </tr>
              ) : (
                costBasis.orderBreakdown.map((order, i) => {
                  const currentOrderValue = order.btcBought * currentPrice
                  const unrealized = currentOrderValue - order.costBasis
                  const unrealizedPercent = order.costBasis > 0
                    ? ((currentOrderValue / order.costBasis) - 1) * 100
                    : 0

                  return (
                    <tr key={i} className="border-t border-gray-700">
                      <td className="py-2 whitespace-nowrap">{order.date}</td>
                      <td className="py-2 whitespace-nowrap">{formatPrice(order.buyPrice)}</td>
                      <td className="py-2 font-mono whitespace-nowrap">{formatAsset(order.btcBought)}</td>
                      <td className="py-2 whitespace-nowrap">{formatCurrency(order.costBasis)}</td>
                      <td className="py-2 text-red-400 whitespace-nowrap">{formatCurrency(order.netFees)}</td>
                      <td className="py-2 whitespace-nowrap">{formatPrice(order.costPerAsset)}</td>
                      <td className="py-2 font-mono text-yellow-400 whitespace-nowrap">{formatAsset(order.holdback)}</td>
                      <td className="py-2 whitespace-nowrap">
                        {formatAsset(order.sellQuantity)} @ {formatPrice(order.sellPrice)}
                      </td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          order.status === 'filled'
                            ? 'bg-green-900 text-green-300'
                            : 'bg-yellow-900 text-yellow-300'
                        }`}>
                          {order.status}
                        </span>
                      </td>
                      <td className="py-2">
                        {order.status === 'filled' ? (
                          <span className={order.realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {order.realizedPnL >= 0 ? '+' : ''}{formatCurrency(order.realizedPnL)}
                          </span>
                        ) : (
                          <span className={unrealized >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {unrealized >= 0 ? '+' : ''}{unrealizedPercent.toFixed(1)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Explanation */}
      <div className="bg-gray-800/50 rounded-lg p-4 text-sm text-gray-400">
        <h4 className="font-semibold text-gray-300 mb-2">Understanding Cost Basis</h4>
        <ul className="list-disc list-inside space-y-1">
          <li><strong>Cost Basis</strong> = Amount spent ({quoteCurrency}) + Net fees paid</li>
          <li><strong>Reserves</strong> = {baseCurrency} held permanently (holdback from each buy)</li>
          <li><strong>Pending</strong> = {baseCurrency} in open sell orders (may convert back to {quoteCurrency})</li>
          <li><strong>Unrealized P&L</strong> = Current market value - Cost basis</li>
          <li><strong>Realized P&L</strong> = Actual profit from completed sell orders</li>
        </ul>
      </div>
    </div>
  )
}

export default CostBasisDCA
