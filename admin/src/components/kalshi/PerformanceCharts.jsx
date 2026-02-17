import { useMemo } from 'react'
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine
} from 'recharts'

/**
 * Format currency for tooltip
 * @param {number} value
 * @returns {string}
 */
const formatCurrency = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0)

/**
 * Format time for X axis
 * @param {string} timestamp
 * @returns {string}
 */
const formatTime = (timestamp) => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Custom tooltip component
 */
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null

  return (
    <div className="bg-gray-800 border border-gray-600 rounded-lg p-3 shadow-lg">
      <p className="text-gray-400 text-xs mb-2">{new Date(label).toLocaleString()}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-sm" style={{ color: entry.color }}>
          {entry.name}: {entry.name.includes('Rate') ? `${entry.value.toFixed(1)}%` : formatCurrency(entry.value)}
        </p>
      ))}
    </div>
  )
}

/**
 * Compute historical data points from trades
 * @param {Array} trades - Array of trade objects
 * @param {number} startingBalance - Initial balance
 * @returns {Array} Historical data points
 */
const computeHistoricalData = (trades, startingBalance) => {
  if (!trades?.length) return []

  // Sort trades by timestamp
  const sortedTrades = [...trades].sort((a, b) =>
    new Date(a.timestamp) - new Date(b.timestamp)
  )

  let cumulativePnl = 0
  let cumulativeFees = 0
  let available = startingBalance
  let inPositions = 0
  let wins = 0
  let totalSells = 0

  const dataPoints = []

  // Add starting point
  dataPoints.push({
    timestamp: sortedTrades[0]?.timestamp || new Date().toISOString(),
    pnl: 0,
    available: startingBalance,
    inPositions: 0,
    totalValue: startingBalance,
    winRate: 0,
    fees: 0
  })

  for (const trade of sortedTrades) {
    if (trade.action === 'buy') {
      const cost = trade.cost || 0
      const fee = trade.fee || 0
      available -= (cost + fee)
      inPositions += cost
      cumulativeFees += fee
    } else if (trade.action === 'sell' || trade.action === 'settlement') {
      const proceeds = trade.proceeds || 0
      const costBasis = trade.costBasis || 0
      const pnl = trade.pnl || 0
      const fee = trade.fee || 0

      available += (proceeds - fee)
      inPositions -= costBasis
      cumulativePnl += pnl
      cumulativeFees += fee
      totalSells++
      if (pnl > 0) wins++
    }

    dataPoints.push({
      timestamp: trade.timestamp,
      pnl: parseFloat(cumulativePnl.toFixed(2)),
      available: parseFloat(available.toFixed(2)),
      inPositions: parseFloat(Math.max(0, inPositions).toFixed(2)),
      totalValue: parseFloat((available + Math.max(0, inPositions)).toFixed(2)),
      winRate: totalSells > 0 ? parseFloat(((wins / totalSells) * 100).toFixed(1)) : 0,
      fees: parseFloat(cumulativeFees.toFixed(2)),
      tradeAction: trade.action,
      tradePnl: trade.pnl
    })
  }

  return dataPoints
}

/**
 * Performance Charts component
 * @param {Object} props
 * @param {Array} props.trades - Array of trade objects
 * @param {number} props.startingBalance - Initial balance before any trades
 * @param {{ available: number, inPositions: number }} props.currentBalance - Current balance
 */
export default function PerformanceCharts({ trades = [], startingBalance = 10000, currentBalance }) {
  const historicalData = useMemo(
    () => computeHistoricalData(trades, startingBalance),
    [trades, startingBalance]
  )

  if (historicalData.length < 2) {
    return (
      <div className="bg-gray-800 rounded-lg p-6 text-center text-gray-400">
        <p>Not enough trade data to display charts.</p>
        <p className="text-sm mt-2">Charts will appear after trades are executed.</p>
      </div>
    )
  }

  const latestData = historicalData[historicalData.length - 1]
  const pnlColor = latestData.pnl >= 0 ? '#22c55e' : '#ef4444'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* P&L Chart */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Cumulative P&L</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={historicalData}>
              <defs>
                <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={pnlColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={pnlColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTime}
                stroke="#9ca3af"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                tickFormatter={(v) => `$${v}`}
                stroke="#9ca3af"
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="pnl"
                name="P&L"
                stroke={pnlColor}
                fill="url(#pnlGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Balance Chart */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Balance Over Time</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={historicalData}>
              <defs>
                <linearGradient id="availableGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="positionsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTime}
                stroke="#9ca3af"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                tickFormatter={(v) => `$${v}`}
                stroke="#9ca3af"
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Area
                type="monotone"
                dataKey="available"
                name="Available"
                stroke="#22c55e"
                fill="url(#availableGradient)"
                strokeWidth={2}
                stackId="1"
              />
              <Area
                type="monotone"
                dataKey="inPositions"
                name="In Positions"
                stroke="#3b82f6"
                fill="url(#positionsGradient)"
                strokeWidth={2}
                stackId="1"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Win Rate & Fees Chart */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Win Rate & Cumulative Fees</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={historicalData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTime}
                stroke="#9ca3af"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                yAxisId="left"
                tickFormatter={(v) => `${v}%`}
                stroke="#a855f7"
                tick={{ fontSize: 12 }}
                domain={[0, 100]}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tickFormatter={(v) => `$${v}`}
                stroke="#f59e0b"
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="winRate"
                name="Win Rate"
                stroke="#a855f7"
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="fees"
                name="Cumulative Fees"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
