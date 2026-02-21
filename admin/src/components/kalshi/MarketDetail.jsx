import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Clock, DollarSign } from 'lucide-react'

function formatTimeRemaining(closeTime) {
  const now = Date.now()
  const close = new Date(closeTime).getTime()
  const diff = close - now

  if (diff <= 0) return 'Closed'

  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h ${mins % 60}m`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

function OrderbookSide({ orders, side }) {
  const isYes = side === 'yes'

  return (
    <div className={`flex-1 ${isYes ? 'bg-green-900/20' : 'bg-red-900/20'} rounded-lg p-3`}>
      <div className={`text-sm font-medium mb-2 ${isYes ? 'text-green-400' : 'text-red-400'}`}>
        {isYes ? 'YES' : 'NO'} Orders
      </div>
      <div className="space-y-1 text-xs font-mono">
        <div className="flex justify-between text-gray-500 pb-1 border-b border-gray-700">
          <span>Price</span>
          <span>Qty</span>
        </div>
        {orders?.length > 0 ? (
          orders.map((order, i) => (
            <div key={i} className="flex justify-between">
              <span>{order[0]}c</span>
              <span className="text-gray-400">{order[1]}</span>
            </div>
          ))
        ) : (
          <div className="text-gray-500 text-center py-2">No orders</div>
        )}
      </div>
    </div>
  )
}

export default function MarketDetail() {
  const { ticker } = useParams()
  const [market, setMarket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [ordering, setOrdering] = useState(false)
  const [orderForm, setOrderForm] = useState({
    side: 'yes',
    action: 'buy',
    count: 1,
    price: 50
  })
  const [orderResult, setOrderResult] = useState(null)

  const fetchMarket = async () => {
    setLoading(true)
    setError(null)

    const res = await fetch(`/api/kalshi/markets/${ticker}`)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to fetch market')
      setLoading(false)
      return
    }

    const data = await res.json().catch(() => ({}))
    setMarket(data)

    // Set initial price from market
    if (data.yes_bid || data.no_bid) {
      setOrderForm(f => ({
        ...f,
        price: f.side === 'yes' ? (data.yes_ask || 50) : (data.no_ask || 50)
      }))
    }

    setLoading(false)
  }

  useEffect(() => {
    fetchMarket()
    const interval = setInterval(fetchMarket, 5000)
    return () => clearInterval(interval)
  }, [ticker])

  const handleOrder = async (e) => {
    e.preventDefault()
    setOrdering(true)
    setOrderResult(null)

    const res = await fetch('/api/kalshi/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker,
        ...orderForm
      })
    })

    const data = await res.json().catch(() => ({}))

    if (res.ok) {
      setOrderResult({ success: true, order: data.order })
    } else {
      setOrderResult({ success: false, error: data.error || 'Order failed' })
    }

    setOrdering(false)
  }

  if (loading && !market) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="text-gray-400">Loading market...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <Link to="/kalshi/markets" className="flex items-center gap-2 text-gray-400 hover:text-white mb-4">
          <ArrowLeft size={18} />
          Back to Markets
        </Link>
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200">
          {error}
        </div>
      </div>
    )
  }

  const yesPrice = market?.yes_bid || market?.yes_price || 50
  const noPrice = market?.no_bid || market?.no_price || 50
  const cost = orderForm.count * orderForm.price
  const maxProfit = orderForm.count * (100 - orderForm.price)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <Link to="/kalshi/markets" className="flex items-center gap-2 text-gray-400 hover:text-white">
          <ArrowLeft size={18} />
          Back to Markets
        </Link>
        <button
          onClick={fetchMarket}
          disabled={loading}
          className="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Market Header */}
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-sm text-gray-500 font-mono mb-1">{market?.ticker}</div>
            <h1 className="text-xl font-bold">{market?.title}</h1>
          </div>
          <div className="flex items-center gap-1 text-gray-400">
            <Clock size={16} />
            <span>{formatTimeRemaining(market?.close_time)}</span>
          </div>
        </div>

        {/* Tags */}
        <div className="flex items-center gap-2 mb-4">
          {market?.type && (
            <span className={`px-2 py-0.5 rounded text-xs ${
              market.type === 'crypto' ? 'bg-blue-900/50 text-blue-300' :
              market.type === 'sports' ? 'bg-purple-900/50 text-purple-300' :
              'bg-gray-700 text-gray-400'
            }`}>
              {market.type}
            </span>
          )}
          {market?.asset && (
            <span className="px-2 py-0.5 rounded text-xs bg-orange-900/50 text-orange-300">
              {market.asset}
            </span>
          )}
          {market?.sport && (
            <span className="px-2 py-0.5 rounded text-xs bg-green-900/50 text-green-300">
              {market.sport}
            </span>
          )}
          {market?.timeframe && market.timeframe !== 'unknown' && (
            <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-400">
              {market.timeframe}
            </span>
          )}
        </div>

        {/* Price Display */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-green-900/30 rounded-lg p-4 text-center">
            <div className="text-sm text-gray-400 mb-1">YES</div>
            <div className="text-3xl font-bold text-green-400">{yesPrice}c</div>
            <div className="text-xs text-gray-500 mt-1">
              Bid: {market?.yes_bid || '-'} / Ask: {market?.yes_ask || '-'}
            </div>
          </div>
          <div className="bg-red-900/30 rounded-lg p-4 text-center">
            <div className="text-sm text-gray-400 mb-1">NO</div>
            <div className="text-3xl font-bold text-red-400">{noPrice}c</div>
            <div className="text-xs text-gray-500 mt-1">
              Bid: {market?.no_bid || '-'} / Ask: {market?.no_ask || '-'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Order Book */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Order Book</h3>
          <div className="flex gap-4">
            <OrderbookSide orders={market?.orderbook?.yes} side="yes" />
            <OrderbookSide orders={market?.orderbook?.no} side="no" />
          </div>
        </div>

        {/* Order Form */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Place Order</h3>

          <form onSubmit={handleOrder} className="space-y-4">
            {/* Side */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Side</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOrderForm(f => ({ ...f, side: 'yes', price: market?.yes_ask || 50 }))}
                  className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                    orderForm.side === 'yes'
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  YES
                </button>
                <button
                  type="button"
                  onClick={() => setOrderForm(f => ({ ...f, side: 'no', price: market?.no_ask || 50 }))}
                  className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                    orderForm.side === 'no'
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  NO
                </button>
              </div>
            </div>

            {/* Action */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Action</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOrderForm(f => ({ ...f, action: 'buy' }))}
                  className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                    orderForm.action === 'buy'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() => setOrderForm(f => ({ ...f, action: 'sell' }))}
                  className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                    orderForm.action === 'sell'
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  Sell
                </button>
              </div>
            </div>

            {/* Contracts */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Contracts</label>
              <input
                type="number"
                min="1"
                value={orderForm.count}
                onChange={(e) => setOrderForm(f => ({ ...f, count: parseInt(e.target.value) || 1 }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Price */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Price (cents)</label>
              <input
                type="number"
                min="1"
                max="99"
                value={orderForm.price}
                onChange={(e) => setOrderForm(f => ({ ...f, price: parseInt(e.target.value) || 50 }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Order Summary */}
            <div className="bg-gray-700/50 rounded-lg p-3 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-gray-400">Cost:</span>
                <span>${(cost / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Max Profit:</span>
                <span className="text-green-400">${(maxProfit / 100).toFixed(2)}</span>
              </div>
            </div>

            {/* Order Result */}
            {orderResult && (
              <div className={`p-3 rounded-lg ${
                orderResult.success
                  ? 'bg-green-900/50 border border-green-700 text-green-200'
                  : 'bg-red-900/50 border border-red-700 text-red-200'
              }`}>
                {orderResult.success
                  ? `Order placed: ${orderResult.order?.order_id || 'Success'}`
                  : orderResult.error
                }
              </div>
            )}

            <button
              type="submit"
              disabled={ordering}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 rounded-lg font-medium transition-colors"
            >
              {ordering ? 'Placing Order...' : `${orderForm.action === 'buy' ? 'Buy' : 'Sell'} ${orderForm.count} ${orderForm.side.toUpperCase()}`}
            </button>
          </form>
        </div>
      </div>

      {/* Market Details */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Market Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-400">Open Time</div>
            <div>{market?.open_time ? new Date(market.open_time).toLocaleString() : '-'}</div>
          </div>
          <div>
            <div className="text-gray-400">Close Time</div>
            <div>{market?.close_time ? new Date(market.close_time).toLocaleString() : '-'}</div>
          </div>
          <div>
            <div className="text-gray-400">Volume</div>
            <div>{market?.volume || market?.volume_24h || '-'}</div>
          </div>
          <div>
            <div className="text-gray-400">Status</div>
            <div className="capitalize">{market?.status || '-'}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
