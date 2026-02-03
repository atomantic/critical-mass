import { useState, useEffect, useMemo } from 'react'
import {
  AreaChart,
  BarChart,
  PriceChart,
  ComposedChart,
  PendingOrdersChart,
  CostBasisDistributionChart,
  colors,
} from './charts/index'

function ChartsDCA({ summary, quoteCurrency = 'USDC' }) {
  const [chartResize, setChartResize] = useState(0)

  // Handle window resize for responsive D3 charts
  useEffect(() => {
    const handleResize = () => setChartResize((n) => n + 1)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const { transactions = [], state, stats, costBasis } = summary || {}

  // Process data for charts - use orders for timestamps (they have createdAt)
  const chartData = useMemo(() => {
    const orders = state?.orders || []

    // Sort orders by createdAt timestamp
    const sortedOrders = [...orders]
      .filter((o) => o.createdAt)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))

    // Price history from orders - use createdAt timestamp
    const priceHistory = sortedOrders.map((o) => ({
      date: o.createdAt,
      price: o.buyPrice,
    }))

    // Buy data for price chart markers
    const buyData = sortedOrders.map((o) => ({
      date: o.createdAt,
      price: o.buyPrice,
      amount: o.buyQuantityBTC || 0,
    }))

    // Sell data for price chart (pending sell targets)
    const sellData = sortedOrders
      .filter((o) => o.status === 'pending' && o.sellPrice)
      .map((o) => ({
        date: o.createdAt,
        price: o.buyPrice,
        sellPrice: o.sellPrice,
      }))

    // Calculate average cost basis (weighted by BTC quantity)
    const totalBTC = sortedOrders.reduce((sum, o) => sum + (o.buyQuantityBTC || 0), 0)
    const totalCost = sortedOrders.reduce((sum, o) => sum + (o.buyCostBasis || o.buyUSDC || 0), 0)
    const avgCostBasisPrice = totalBTC > 0 ? totalCost / totalBTC : 0

    // Fund balance over time - use orders' createdAt for timeline
    // Calculate running fund size based on order sequence
    let runningFundSize = summary?.config?.totalAllocation || 0
    const fundHistory = sortedOrders.map((o) => {
      runningFundSize -= (o.buyUSDC || 0)
      return {
        date: o.createdAt,
        fundSize: runningFundSize,
      }
    })

    // Cumulative fees from orders
    let cumFees = 0
    let cumRebates = 0
    const feeHistory = sortedOrders.map((o) => {
      cumFees += o.buyFees || 0
      cumRebates += o.buyRebates || 0
      return {
        date: o.createdAt,
        fees: o.buyFees || 0,
        rebates: o.buyRebates || 0,
        cumFees,
        cumRebates,
        netFees: cumFees - cumRebates,
      }
    })

    // Volume aggregated by hour for intraday trading
    const hourlyVolume = {}
    sortedOrders.forEach((o) => {
      const ts = o.createdAt
      const dateObj = new Date(ts)
      // Round to hour for grouping
      const key = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), dateObj.getHours()).toISOString()

      if (!hourlyVolume[key]) {
        hourlyVolume[key] = { date: key, bought: 0, sold: 0 }
      }
      hourlyVolume[key].bought += o.buyUSDC || 0
    })

    // Add sells from transactions
    const sellTx = transactions.filter((t) => t.Type === 'SELL_FILLED')
    sellTx.forEach((t) => {
      const ts = t.Timestamp || t.Date
      const dateObj = new Date(ts)
      const hasTime = ts && ts.includes('T')
      const key = hasTime
        ? new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), dateObj.getHours()).toISOString()
        : ts

      if (!hourlyVolume[key]) {
        hourlyVolume[key] = { date: key, bought: 0, sold: 0 }
      }
      hourlyVolume[key].sold += t['USDC Amount'] || 0
    })

    const volumeData = Object.values(hourlyVolume).sort((a, b) => new Date(a.date) - new Date(b.date))

    return {
      fundHistory,
      priceHistory,
      buyData,
      sellData,
      avgCostBasisPrice,
      feeHistory,
      volumeData,
      orders: sortedOrders,
    }
  }, [state?.orders, transactions, summary?.config?.totalAllocation])

  // Get pending orders and current price for pending orders chart
  const pendingOrders = useMemo(() => {
    return (state?.orders || []).filter((o) => o.status === 'pending')
  }, [state?.orders])

  const currentPrice = costBasis?.currentPrice || 0

  if (!summary) return null

  return (
    <div className="space-y-4">
      {/* Stats Summary - Always on top */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-blue-400">{stats?.totalBuys || 0}</div>
          <div className="text-xs text-gray-400">Total Buys</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-green-400">{stats?.totalSells || 0}</div>
          <div className="text-xs text-gray-400">Sells Filled</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-yellow-400">{stats?.pendingOrders || 0}</div>
          <div className="text-xs text-gray-400">Pending Orders</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-purple-400">{stats?.daysRun || 0}</div>
          <div className="text-xs text-gray-400">Days Run</div>
        </div>
      </div>

      {/* Price History - Full width at top */}
      <div className="bg-gray-800 rounded-lg p-3">
        <h3 className="text-sm font-semibold mb-2 text-gray-300">Price History with Buy/Sell Targets & Cost Basis</h3>
        <div className="h-56">
          {chartData.priceHistory.length > 0 ? (
            <PriceChart
              priceData={chartData.priceHistory}
              buyData={chartData.buyData}
              sellData={chartData.sellData}
              avgCostBasis={chartData.avgCostBasisPrice}
              title="Price History"
              resize={chartResize}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No buy data yet</div>
          )}
        </div>
      </div>

      {/* Secondary Charts - 3 columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Fund Balance Chart */}
        <div className="bg-gray-800 rounded-lg p-3">
          <h3 className="text-sm font-semibold mb-2 text-gray-300">Fund Balance</h3>
          <div className="h-40">
            <AreaChart
              data={chartData.fundHistory}
              title="Fund Balance"
              valueKey="fundSize"
              dateKey="date"
              color={colors.blue}
              resize={chartResize}
            />
          </div>
        </div>

        {/* Volume Chart */}
        <div className="bg-gray-800 rounded-lg p-3">
          <h3 className="text-sm font-semibold mb-2 text-gray-300">Volume</h3>
          <div className="h-40">
            {chartData.volumeData.length > 0 ? (
              <BarChart
                data={chartData.volumeData}
                title="Volume"
                dateKey="date"
                series={[
                  { key: 'bought', color: colors.blue, label: `Bought (${quoteCurrency})` },
                  { key: 'sold', color: colors.green, label: `Sold (${quoteCurrency})` },
                ]}
                resize={chartResize}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">No volume data</div>
            )}
          </div>
        </div>

        {/* Fees Chart */}
        <div className="bg-gray-800 rounded-lg p-3">
          <h3 className="text-sm font-semibold mb-2 text-gray-300">Fees & Rebates</h3>
          <div className="h-40">
            {chartData.feeHistory.length > 0 ? (
              <ComposedChart
                data={chartData.feeHistory}
                title="Fees"
                dateKey="date"
                areas={[
                  { key: 'cumFees', color: colors.red, label: 'Fees' },
                  { key: 'cumRebates', color: colors.green, label: 'Rebates' },
                ]}
                lines={[
                  { key: 'netFees', color: colors.purple, label: 'Net', strokeWidth: 2 },
                ]}
                resize={chartResize}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">No fee data</div>
            )}
          </div>
        </div>
      </div>

      {/* Pending Orders Charts - Full width */}
      {pendingOrders.length > 0 && currentPrice > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-gray-800 rounded-lg p-3">
            <h3 className="text-sm font-semibold mb-2 text-gray-300">Pending Sell Orders vs Current Price</h3>
            <div className="h-48">
              <PendingOrdersChart
                orders={pendingOrders}
                currentPrice={currentPrice}
                resize={chartResize}
              />
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-3">
            <h3 className="text-sm font-semibold mb-2 text-gray-300">Cost Basis Distribution</h3>
            <div className="h-48">
              <CostBasisDistributionChart
                orders={pendingOrders}
                currentPrice={currentPrice}
                resize={chartResize}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ChartsDCA
