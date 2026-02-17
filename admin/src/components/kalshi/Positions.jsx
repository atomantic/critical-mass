import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, TrendingUp, TrendingDown, ExternalLink } from 'lucide-react'

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0)
}

export default function Positions() {
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchPositions = async () => {
    setLoading(true)
    setError(null)

    const res = await fetch('/api/kalshi/positions')

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to fetch positions')
      setLoading(false)
      return
    }

    const data = await res.json().catch(() => ({}))
    setPositions(data.positions || [])
    setLoading(false)
  }

  useEffect(() => {
    fetchPositions()
    const interval = setInterval(fetchPositions, 10000)
    return () => clearInterval(interval)
  }, [])

  const totalValue = positions.reduce((sum, pos) => {
    const value = Math.abs(pos.position || 0) * ((pos.market_exposure || 0) / 100)
    return sum + value
  }, 0)

  const totalPnL = positions.reduce((sum, pos) => {
    return sum + (pos.realized_pnl || 0) / 100
  }, 0)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Positions</h1>
        <button
          onClick={fetchPositions}
          disabled={loading}
          className="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Open Positions</div>
          <div className="text-2xl font-bold">{positions.length}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Total Value</div>
          <div className="text-2xl font-bold">{formatCurrency(totalValue)}</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Realized P&L</div>
          <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {formatCurrency(totalPnL)}
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Positions Table */}
      {loading && positions.length === 0 ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-400">Loading positions...</div>
        </div>
      ) : positions.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-400">
          <TrendingUp size={48} className="mb-4 opacity-50" />
          <p>No open positions</p>
          <Link to="/kalshi/markets" className="text-blue-400 hover:underline mt-2">
            Browse markets to start trading
          </Link>
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-gray-400 text-left text-sm border-b border-gray-700">
                <th className="p-4">Market</th>
                <th className="p-4">Side</th>
                <th className="p-4">Contracts</th>
                <th className="p-4">Avg Price</th>
                <th className="p-4">Exposure</th>
                <th className="p-4">P&L</th>
                <th className="p-4"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos, i) => {
                const isYes = (pos.position || 0) > 0
                const contracts = Math.abs(pos.position || 0)
                const avgPrice = pos.average_price || pos.avgPrice || 0
                const exposure = (pos.market_exposure || 0) / 100
                const pnl = (pos.realized_pnl || 0) / 100

                return (
                  <tr key={pos.ticker || i} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                    <td className="p-4">
                      <Link
                        to={`/kalshi/markets/${pos.ticker}`}
                        className="text-blue-400 hover:underline font-mono text-sm"
                      >
                        {pos.ticker}
                      </Link>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        isYes ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
                      }`}>
                        {isYes ? 'YES' : 'NO'}
                      </span>
                    </td>
                    <td className="p-4 font-medium">{contracts}</td>
                    <td className="p-4">{avgPrice}c</td>
                    <td className="p-4">{formatCurrency(exposure)}</td>
                    <td className={`p-4 font-medium ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                    </td>
                    <td className="p-4">
                      <Link
                        to={`/kalshi/markets/${pos.ticker}`}
                        className="p-1 hover:bg-gray-600 rounded inline-flex"
                        title="View Market"
                      >
                        <ExternalLink size={16} />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
