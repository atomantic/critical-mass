import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
} from 'recharts'

function Charts({ summary, quoteCurrency = 'USDC' }) {
  if (!summary) return null

  const { transactions = [], state, stats } = summary

  // Process transactions for charts
  const buyTx = transactions.filter(t => t.Type === 'BUY')
  const sellTx = transactions.filter(t => t.Type === 'SELL_FILLED')

  // Fund balance over time
  const fundHistory = transactions
    .filter(t => t['Fund Size'] != null)
    .map(t => ({
      date: t.Date,
      fundSize: t['Fund Size'],
      btcReserves: t['BTC Reserves'],
    }))

  // Price history from buys
  const priceHistory = buyTx.map(t => ({
    date: t.Date,
    price: t.Price,
  }))

  // Cumulative fees
  let cumFees = 0
  let cumRebates = 0
  const feeHistory = transactions.map(t => {
    cumFees += t.Fees || 0
    cumRebates += t.Rebates || 0
    return {
      date: t.Date,
      type: t.Type,
      fees: t.Fees || 0,
      rebates: t.Rebates || 0,
      cumFees,
      cumRebates,
      netFees: cumFees - cumRebates,
    }
  })

  // Daily volume
  const dailyVolume = {}
  transactions.forEach(t => {
    if (!dailyVolume[t.Date]) {
      dailyVolume[t.Date] = { date: t.Date, bought: 0, sold: 0 }
    }
    if (t.Type === 'BUY') {
      dailyVolume[t.Date].bought += Math.abs(t['USDC Amount'] || 0)
    }
    if (t.Type === 'SELL_FILLED') {
      dailyVolume[t.Date].sold += t['USDC Amount'] || 0
    }
  })
  const volumeData = Object.values(dailyVolume)

  const formatUSD = (n) => `$${(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  return (
    <div className="space-y-6">
      {/* Fund Balance Chart */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Fund Balance Over Time</h3>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={fundHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="date" stroke="#9CA3AF" fontSize={12} />
              <YAxis stroke="#9CA3AF" fontSize={12} tickFormatter={formatUSD} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151' }}
                labelStyle={{ color: '#9CA3AF' }}
                formatter={(value) => [formatUSD(value), '']}
              />
              <Area
                type="monotone"
                dataKey="fundSize"
                stroke="#3B82F6"
                fill="#3B82F6"
                fillOpacity={0.3}
                name="Fund Size"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Price History */}
      {priceHistory.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Buy Prices</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priceHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="date" stroke="#9CA3AF" fontSize={12} />
                <YAxis stroke="#9CA3AF" fontSize={12} tickFormatter={formatUSD} domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151' }}
                  labelStyle={{ color: '#9CA3AF' }}
                  formatter={(value) => [formatUSD(value), 'Price']}
                />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="#F59E0B"
                  strokeWidth={2}
                  dot={{ fill: '#F59E0B', strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Volume Chart */}
      {volumeData.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Daily Volume</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={volumeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="date" stroke="#9CA3AF" fontSize={12} />
                <YAxis stroke="#9CA3AF" fontSize={12} tickFormatter={formatUSD} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151' }}
                  labelStyle={{ color: '#9CA3AF' }}
                  formatter={(value) => [formatUSD(value), '']}
                />
                <Legend />
                <Bar dataKey="bought" fill="#3B82F6" name={`Bought (${quoteCurrency})`} />
                <Bar dataKey="sold" fill="#10B981" name={`Sold (${quoteCurrency})`} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Fees Chart */}
      {feeHistory.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Cumulative Fees & Rebates</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={feeHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="date" stroke="#9CA3AF" fontSize={12} />
                <YAxis stroke="#9CA3AF" fontSize={12} tickFormatter={formatUSD} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151' }}
                  labelStyle={{ color: '#9CA3AF' }}
                  formatter={(value) => [formatUSD(value), '']}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="cumFees"
                  fill="#EF4444"
                  fillOpacity={0.3}
                  stroke="#EF4444"
                  name="Total Fees"
                />
                <Area
                  type="monotone"
                  dataKey="cumRebates"
                  fill="#10B981"
                  fillOpacity={0.3}
                  stroke="#10B981"
                  name="Total Rebates"
                />
                <Line
                  type="monotone"
                  dataKey="netFees"
                  stroke="#A855F7"
                  strokeWidth={2}
                  dot={false}
                  name="Net Fees"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-blue-400">{stats.totalBuys}</div>
          <div className="text-sm text-gray-400">Total Buys</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-green-400">{stats.totalSells}</div>
          <div className="text-sm text-gray-400">Sells Filled</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-yellow-400">{stats.pendingOrders}</div>
          <div className="text-sm text-gray-400">Pending Orders</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 text-center">
          <div className="text-3xl font-bold text-purple-400">{stats.daysRun}</div>
          <div className="text-sm text-gray-400">Days Run</div>
        </div>
      </div>
    </div>
  )
}

export default Charts
