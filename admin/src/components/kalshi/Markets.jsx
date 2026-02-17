import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RefreshCw, Clock, TrendingUp, TrendingDown, Filter } from 'lucide-react'

function formatTimeRemaining(closeTime) {
  const now = Date.now()
  const close = new Date(closeTime).getTime()
  const diff = close - now

  if (diff <= 0) return 'Closed'

  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

function MarketCard({ market }) {
  const yesPrice = market.yes_bid || market.yes_price || 50
  const noPrice = market.no_bid || market.no_price || 50

  return (
    <Link
      to={`/kalshi/markets/${market.ticker}`}
      className="block bg-gray-800 rounded-lg p-4 hover:bg-gray-700 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-500 font-mono">{market.ticker}</div>
          <div className="font-medium truncate" title={market.title}>
            {market.title}
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-400 ml-2">
          <Clock size={12} />
          {formatTimeRemaining(market.close_time)}
        </div>
      </div>

      <div className="flex items-center gap-4 mt-3">
        <div className="flex-1 bg-green-900/30 rounded p-2 text-center">
          <div className="text-xs text-gray-400">YES</div>
          <div className="text-lg font-bold text-green-400">{yesPrice}c</div>
        </div>
        <div className="flex-1 bg-red-900/30 rounded p-2 text-center">
          <div className="text-xs text-gray-400">NO</div>
          <div className="text-lg font-bold text-red-400">{noPrice}c</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 text-xs text-gray-500">
        <span className={`px-2 py-0.5 rounded ${
          market.type === 'crypto' ? 'bg-blue-900/50 text-blue-300' :
          market.type === 'sports' ? 'bg-purple-900/50 text-purple-300' :
          'bg-gray-700 text-gray-400'
        }`}>
          {market.type}
        </span>
        {market.asset && (
          <span className="px-2 py-0.5 rounded bg-orange-900/50 text-orange-300">
            {market.asset}
          </span>
        )}
        {market.sport && (
          <span className="px-2 py-0.5 rounded bg-green-900/50 text-green-300">
            {market.sport}
          </span>
        )}
        {market.timeframe && market.timeframe !== 'unknown' && (
          <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400">
            {market.timeframe}
          </span>
        )}
      </div>
    </Link>
  )
}

export default function Markets() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [markets, setMarkets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const type = searchParams.get('type') || ''
  const asset = searchParams.get('asset') || ''
  const sport = searchParams.get('sport') || ''

  const fetchMarkets = async () => {
    setLoading(true)
    setError(null)

    const params = new URLSearchParams()
    if (type) params.append('type', type)
    if (asset) params.append('asset', asset)
    if (sport) params.append('sport', sport)
    params.append('limit', '100')

    const res = await fetch(`/api/kalshi/markets?${params}`)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to fetch markets')
      setLoading(false)
      return
    }

    const data = await res.json().catch(() => ({}))
    setMarkets(data.markets || [])
    setLoading(false)
  }

  useEffect(() => {
    fetchMarkets()
  }, [type, asset, sport])

  const setFilter = (key, value) => {
    const newParams = new URLSearchParams(searchParams)
    if (value) {
      newParams.set(key, value)
    } else {
      newParams.delete(key)
    }
    if (key === 'type') {
      newParams.delete('asset')
      newParams.delete('sport')
    }
    setSearchParams(newParams)
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Markets</h1>
        <button
          onClick={fetchMarkets}
          disabled={loading}
          className="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Filter size={16} />
          Type:
        </div>
        <button
          onClick={() => setFilter('type', '')}
          className={`px-3 py-1 rounded-full text-sm transition-colors ${
            !type ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('type', 'crypto')}
          className={`px-3 py-1 rounded-full text-sm transition-colors ${
            type === 'crypto' ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600'
          }`}
        >
          Crypto
        </button>
        <button
          onClick={() => setFilter('type', 'sports')}
          className={`px-3 py-1 rounded-full text-sm transition-colors ${
            type === 'sports' ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600'
          }`}
        >
          Sports
        </button>
      </div>

      {/* Sub-filters */}
      {type === 'crypto' && (
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            Asset:
          </div>
          <span className="px-3 py-1 rounded-full text-sm bg-orange-600 text-white">
            BTC
          </span>
        </div>
      )}

      {type === 'sports' && (
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            League:
          </div>
          {['', 'NFL', 'NBA', 'MLB', 'NHL'].map(s => (
            <button
              key={s || 'all'}
              onClick={() => setFilter('sport', s)}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                sport === s ? 'bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200">
          {error}
        </div>
      )}

      {/* Markets Grid */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-400">Loading markets...</div>
        </div>
      ) : markets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-400">
          <p>No markets found</p>
          <p className="text-sm mt-2">Try adjusting your filters or check API keys configuration</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500">{markets.length} markets found</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {markets.map(market => (
              <MarketCard key={market.ticker} market={market} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
