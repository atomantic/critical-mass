import { useState, useEffect } from 'react'

// Extract quote currency from product ID (e.g., "BTC-USDC" -> "USDC", "BTCUSD" -> "USD")
function getQuoteCurrency(productId) {
  if (!productId) return 'USDC'
  if (productId.includes('-')) {
    return productId.split('-')[1]
  }
  // For Gemini-style (BTCUSD), strip BTC prefix
  return productId.replace(/^BTC/, '') || 'USD'
}

function ToggleSwitch({ label, checked, onChange, disabled, colorOn = 'bg-green-500', colorOff = 'bg-gray-600' }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <span className="text-sm text-gray-400">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${checked ? colorOn : colorOff}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  )
}

function StatCard({ label, value, subtext, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-900/50 border-blue-700',
    green: 'bg-green-900/50 border-green-700',
    yellow: 'bg-yellow-900/50 border-yellow-700',
    purple: 'bg-purple-900/50 border-purple-700',
    red: 'bg-red-900/50 border-red-700',
  }

  return (
    <div className={`p-4 rounded-lg border ${colors[color]}`}>
      <div className="text-sm text-gray-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {subtext && <div className="text-xs text-gray-500 mt-1">{subtext}</div>}
    </div>
  )
}

// Format countdown from milliseconds
function formatCountdown(ms) {
  if (ms <= 0) return 'now'

  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

function Dashboard({ summary, onRefresh, exchange = 'coinbase' }) {
  const [liveData, setLiveData] = useState(null)
  const [updating, setUpdating] = useState(false)
  const [countdown, setCountdown] = useState('')

  useEffect(() => {
    const fetchLive = async () => {
      const res = await fetch(`/api/${exchange}/status`)
      if (res.ok) {
        const data = await res.json()
        setLiveData(data)
      }
    }
    fetchLive()
    const interval = setInterval(fetchLive, 10000)
    return () => clearInterval(interval)
  }, [exchange])

  // Live countdown timer
  useEffect(() => {
    const { nextTrade } = summary || {}
    if (!nextTrade?.nextTradeTime || !nextTrade.enabled || nextTrade.fullyAllocated) {
      setCountdown('')
      return
    }

    const updateCountdown = () => {
      const now = Date.now()
      const target = new Date(nextTrade.nextTradeTime).getTime()
      const remaining = target - now
      setCountdown(formatCountdown(remaining))
    }

    updateCountdown()
    const interval = setInterval(updateCountdown, 1000)
    return () => clearInterval(interval)
  }, [summary?.nextTrade?.nextTradeTime, summary?.nextTrade?.enabled, summary?.nextTrade?.fullyAllocated])

  const toggleConfig = async (key, value) => {
    setUpdating(true)
    const res = await fetch(`/api/${exchange}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value })
    })
    if (res.ok && onRefresh) {
      onRefresh()
    }
    setUpdating(false)
  }

  if (!summary) return null

  const { config, state, stats, costBasis, nextTrade } = summary
  const quoteCurrency = getQuoteCurrency(config?.productId)
  const currentPrice = liveData?.currentPrice || 0
  const btcValue = (state.btcReserves || 0) * currentPrice
  const pendingBtcValue = (state.outstandingOrdersBTC || 0) * currentPrice
  const totalBTCHeld = (state.btcReserves || 0) + (state.outstandingOrdersBTC || 0)
  const totalBTCCostBasis = (costBasis?.reservesCostBasis || 0) + (costBasis?.pendingCostBasis || 0)

  const formatUSD = (n) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const formatBTC = (n) => `${(n || 0).toFixed(8)} BTC`

  return (
    <div className="space-y-6">
      {/* Live Price Banner */}
      <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
        <div>
          <span className="text-gray-400">{config?.productId || 'BTC-' + quoteCurrency}</span>
          <span className="text-3xl font-bold ml-4">{formatUSD(currentPrice)}</span>
        </div>
        <div className="flex items-center gap-6">
          <ToggleSwitch
            label="Automation"
            checked={config.enabled}
            onChange={(v) => toggleConfig('enabled', v)}
            disabled={updating}
            colorOn="bg-green-500"
          />
          <ToggleSwitch
            label="Dry Run"
            checked={config.dryRun}
            onChange={(v) => toggleConfig('dryRun', v)}
            disabled={updating}
            colorOn="bg-yellow-500"
          />
          <div className="text-right pl-4 border-l border-gray-700">
            <div className="text-sm text-gray-400">Mode</div>
            <div className={`text-lg font-semibold ${
              !config.enabled ? 'text-red-400' :
              config.dryRun ? 'text-yellow-400' : 'text-green-400'
            }`}>
              {!config.enabled ? 'Disabled' : config.dryRun ? 'Dry Run' : 'Live'}
            </div>
          </div>
        </div>
      </div>

      {/* Next Trade Info */}
      {nextTrade && (
        <div className={`rounded-lg p-4 border ${
          !nextTrade.enabled ? 'bg-red-900/30 border-red-700' :
          nextTrade.fullyAllocated ? 'bg-yellow-900/30 border-yellow-700' :
          nextTrade.dryRun ? 'bg-yellow-900/30 border-yellow-600' :
          'bg-blue-900/30 border-blue-700'
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-gray-400">
                Next {nextTrade.intervalLabel || 'Daily'} Trade
                {nextTrade.dryRun && nextTrade.enabled && (
                  <span className="ml-2 px-2 py-0.5 bg-yellow-600 text-yellow-100 text-xs rounded">DRY RUN</span>
                )}
              </div>
              <div className="text-xl font-bold">
                {!nextTrade.enabled ? (
                  <span className="text-red-400">Bot Disabled</span>
                ) : nextTrade.fullyAllocated ? (
                  <span className="text-yellow-400">Fully Allocated</span>
                ) : (
                  <span className={nextTrade.dryRun ? 'text-yellow-400' : 'text-blue-400'}>
                    {countdown ? `in ${countdown}` : new Date(nextTrade.nextTradeTime).toLocaleString([], {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </span>
                )}
              </div>
              {nextTrade.ranThisInterval && !nextTrade.fullyAllocated && (
                <div className="text-xs text-green-400 mt-1">✓ Already traded this interval</div>
              )}
            </div>
            <div className="text-right">
              <div className="text-sm text-gray-400">Trade Amount</div>
              <div className="text-2xl font-bold text-white">
                {formatUSD(nextTrade.nextTradeAmount)}
              </div>
              <div className="text-xs text-gray-500">
                {formatUSD(nextTrade.remaining)} remaining
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Fund Assets */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Fund Assets</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-2xl font-bold text-green-400">{formatUSD(state.usdcFundSize)}</div>
            <div className="text-sm text-gray-500">{quoteCurrency}</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-yellow-400">{formatBTC(totalBTCHeld)}</div>
            <div className="text-sm text-gray-500">Total BTC</div>
            <div className="text-xs text-gray-600">{formatBTC(state.btcReserves)} reserves + {formatBTC(state.outstandingOrdersBTC)} on orders</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-purple-400">{formatUSD(totalBTCCostBasis)}</div>
            <div className="text-sm text-gray-500">BTC Cost Basis</div>
            <div className="text-xs text-gray-600">Avg: {formatUSD(totalBTCHeld > 0 ? totalBTCCostBasis / totalBTCHeld : 0)}/BTC</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-blue-400">{formatUSD((state.usdcFundSize || 0) + btcValue + pendingBtcValue)}</div>
            <div className="text-sm text-gray-500">Total Value</div>
            <div className="text-xs text-gray-600">at current price</div>
          </div>
        </div>
      </div>

      {/* Allocation Progress */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex justify-between mb-2">
          <span className="text-gray-400">Allocation Progress</span>
          <span className="text-white">
            {formatUSD(stats.allocationUsed)} / {formatUSD(config.totalAllocation)}
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-3">
          <div
            className="bg-blue-500 h-3 rounded-full transition-all"
            style={{ width: `${Math.min(100, (stats.allocationUsed / config.totalAllocation) * 100)}%` }}
          />
        </div>
        <div className="flex justify-between mt-2 text-sm text-gray-500">
          <span>{stats.intervalsRun || stats.daysRun || 0} intervals run</span>
          <span>{formatUSD(stats.allocationRemaining)} remaining</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Total Buys" value={stats.totalBuys} color="blue" />
        <StatCard label="Total Sells" value={stats.totalSells} color="green" />
        <StatCard label="Pending Orders" value={stats.pendingOrders} color="yellow" />
        <StatCard label="Total Fees" value={formatUSD(stats.totalFees)} color="red" />
        <StatCard label="Total Rebates" value={formatUSD(stats.totalRebates)} color="green" />
        <StatCard label="Net Fees" value={formatUSD(stats.netFees)} color="purple" />
      </div>

      {/* Config Summary */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-3">Current Configuration</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-400">Product:</span>
            <span className="ml-2 text-white">{config.productId}</span>
          </div>
          <div>
            <span className="text-gray-400">Interval:</span>
            <span className="ml-2 text-white">{config.intervalType || 'daily'}</span>
          </div>
          <div>
            <span className="text-gray-400">Buy Amount:</span>
            <span className="ml-2 text-white">{formatUSD(config.totalAllocation / (config.intervalsToSpread || config.daysToSpread || 1))}</span>
          </div>
          <div>
            <span className="text-gray-400">Intervals:</span>
            <span className="ml-2 text-white">{config.intervalsToSpread || config.daysToSpread}</span>
          </div>
          <div>
            <span className="text-gray-400">Sell Markup:</span>
            <span className="ml-2 text-white">+{config.sellMarkupPercent}%</span>
          </div>
          <div>
            <span className="text-gray-400">Holdback:</span>
            <span className="ml-2 text-white">{config.holdbackPercent}%</span>
          </div>
          <div>
            <span className="text-gray-400">Max Buy Price:</span>
            <span className="ml-2 text-white">{formatUSD(config.maxBuyPrice)}</span>
          </div>
          <div>
            <span className="text-gray-400">Last Run:</span>
            <span className="ml-2 text-white">{state.lastRunId || state.lastRunDate || 'Never'}</span>
          </div>
        </div>
      </div>

      {/* Pending Orders */}
      {(state.orders || []).filter(o => o.status === 'pending').length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-3">Pending Sell Orders</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="pb-2">Created</th>
                  <th className="pb-2">Buy Price</th>
                  <th className="pb-2">Sell Price</th>
                  <th className="pb-2">Amount</th>
                  <th className="pb-2">Expected {quoteCurrency}</th>
                </tr>
              </thead>
              <tbody>
                {(state.orders || []).filter(o => o.status === 'pending').map((order, i) => (
                  <tr key={i} className="border-t border-gray-700">
                    <td className="py-2">{new Date(order.createdAt).toLocaleDateString()}</td>
                    <td className="py-2">{formatUSD(order.buyPrice)}</td>
                    <td className="py-2">{formatUSD(order.sellPrice)}</td>
                    <td className="py-2">{order.sellQuantityBTC?.toFixed(8)} BTC</td>
                    <td className="py-2">{formatUSD(order.sellQuantityBTC * order.sellPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard
