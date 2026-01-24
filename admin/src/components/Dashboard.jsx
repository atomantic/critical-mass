import { useState, useEffect } from 'react'
import ActivityFeed from './ActivityFeed'

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
    <div className={`p-2 rounded-lg border ${colors[color]}`}>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-base font-bold">{value}</div>
      {subtext && <div className="text-xs text-gray-500">{subtext}</div>}
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
  const [consolidating, setConsolidating] = useState(false)
  const [syncing, setSyncing] = useState(false)

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

  const handleConsolidate = async () => {
    setConsolidating(true)
    const res = await fetch(`/api/${exchange}/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    if (res.ok && onRefresh) {
      onRefresh()
    }
    setConsolidating(false)
  }

  const handleSync = async () => {
    setSyncing(true)
    const res = await fetch(`/api/${exchange}/sync`, { method: 'POST' })
    if (res.ok && onRefresh) {
      onRefresh()
    }
    setSyncing(false)
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
    <div className="flex gap-6">
      {/* Main Content Column */}
      <div className="flex-1 space-y-4 min-w-0">
        {/* Live Price Banner + Controls */}
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <span className="text-gray-400">{config?.productId || 'BTC-' + quoteCurrency}</span>
              <span className="text-3xl font-bold">{formatUSD(currentPrice)}</span>
            </div>
            <div className="flex items-center gap-4">
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
                <div className="text-xs text-gray-400">Mode</div>
                <div className={`text-sm font-semibold ${
                  !config.enabled ? 'text-red-400' :
                  config.dryRun ? 'text-yellow-400' : 'text-green-400'
                }`}>
                  {!config.enabled ? 'Disabled' : config.dryRun ? 'Dry Run' : 'Live'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Fund Assets + Stats Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Fund Assets */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-xs text-gray-400 mb-2">Fund Assets</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-lg font-bold text-green-400">{formatUSD(state.usdcFundSize)}</div>
                <div className="text-xs text-gray-500">{quoteCurrency}</div>
              </div>
              <div>
                <div className="text-lg font-bold text-blue-400">{formatUSD((state.usdcFundSize || 0) + btcValue + pendingBtcValue)}</div>
                <div className="text-xs text-gray-400">Total Value</div>
              </div>
            </div>
            {/* BTC Holdings Breakdown */}
            <div className="mt-3 pt-3 border-t border-gray-700">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center">
                  <div className="text-gray-400 mb-1">Pending Sale</div>
                  <div className="text-yellow-400 font-semibold">{formatBTC(state.outstandingOrdersBTC || 0)}</div>
                  <div className="text-gray-500">Cost: {formatUSD(costBasis?.pendingCostBasis || 0)}</div>
                  <div className="text-green-400">Exp: {formatUSD(state.outstandingOrdersUSDC || 0)}</div>
                </div>
                <div className="text-center">
                  <div className="text-gray-400 mb-1">Reserves</div>
                  <div className="text-orange-400 font-semibold">{formatBTC(state.btcReserves || 0)}</div>
                  <div className="text-gray-500">Cost: {formatUSD(costBasis?.reservesCostBasis || 0)}</div>
                  <div className="text-gray-500">Val: {formatUSD(btcValue)}</div>
                </div>
                <div className="text-center">
                  <div className="text-gray-400 mb-1">Total BTC</div>
                  <div className="text-purple-400 font-semibold">{formatBTC(totalBTCHeld)}</div>
                  <div className="text-gray-500">Cost: {formatUSD(totalBTCCostBasis)}</div>
                  <div className="text-gray-500">Avg: {formatUSD(totalBTCHeld > 0 ? totalBTCCostBasis / totalBTCHeld : 0)}/BTC</div>
                </div>
              </div>
            </div>
          </div>

          {/* Stats Grid - 2 rows of 3 */}
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <StatCard label="Total Buys" value={stats.totalBuys} color="blue" />
              <StatCard label="Total Sells" value={stats.totalSells} color="green" />
              <StatCard label="Pending" value={stats.pendingOrders} color="yellow" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <StatCard label="Fees" value={formatUSD(stats.totalFees)} color="red" />
              <StatCard label="Rebates" value={formatUSD(stats.totalRebates)} color="green" />
              <StatCard label="Net Fees" value={formatUSD(stats.netFees)} color="purple" />
            </div>
          </div>
        </div>

        {/* Allocation Progress + Config Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Allocation Progress */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex justify-between mb-2 text-sm">
              <span className="text-gray-400">Allocation Progress</span>
              <span className="text-white">
                {formatUSD(stats.allocationUsed)} / {formatUSD(config.totalAllocation)}
              </span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${Math.min(100, (stats.allocationUsed / config.totalAllocation) * 100)}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-gray-500">
              <span>{stats.intervalsRun || 0} of {config.intervalsToSpread || config.daysToSpread} intervals</span>
              <span>{formatUSD(stats.allocationRemaining)} remaining</span>
            </div>
            {nextTrade && !nextTrade.fullyAllocated && nextTrade.nextTradeAmount > 0 && (() => {
              const intervalsRemaining = Math.ceil(stats.allocationRemaining / nextTrade.nextTradeAmount)
              const intervalMs = {
                '1min': 60 * 1000,
                '5min': 5 * 60 * 1000,
                'hourly': 60 * 60 * 1000,
                'daily': 24 * 60 * 60 * 1000,
                'weekly': 7 * 24 * 60 * 60 * 1000,
              }[config.intervalType] || 24 * 60 * 60 * 1000
              const expectedEndDate = new Date(Date.now() + (intervalsRemaining * intervalMs))
              return (
                <div className="flex justify-between mt-1 text-xs text-gray-400">
                  <span>{intervalsRemaining} intervals left</span>
                  <span>Est: {expectedEndDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                </div>
              )
            })()}
          </div>

          {/* Config Summary */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-xs text-gray-400 mb-2">Configuration</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div><span className="text-gray-500">Product:</span> <span className="text-white">{config.productId}</span></div>
              <div><span className="text-gray-500">Interval:</span> <span className="text-white">{config.intervalType || 'daily'}</span></div>
              <div><span className="text-gray-500">Buy:</span> <span className="text-white">{formatUSD(config.totalAllocation / (config.intervalsToSpread || config.daysToSpread || 1))}</span></div>
              <div><span className="text-gray-500">Intervals:</span> <span className="text-white">{config.intervalsToSpread || config.daysToSpread}</span></div>
              <div><span className="text-gray-500">Markup:</span> <span className="text-white">+{config.sellMarkupPercent}%</span></div>
              <div><span className="text-gray-500">Holdback:</span> <span className="text-white">{config.holdbackPercent}%</span></div>
              <div><span className="text-gray-500">Max Price:</span> <span className="text-white">{formatUSD(config.maxBuyPrice)}</span></div>
              <div><span className="text-gray-500">Consolidate:</span> <span className="text-white">{config.consolidateAfterOrders || 'Off'}</span></div>
            </div>
          </div>
        </div>

        {/* Pending Orders */}
        {(state.orders || []).filter(o => o.status === 'pending').length > 0 && (
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Pending Sell Orders ({stats.pendingOrders})</h3>
              <div className="flex gap-2">
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className={`px-3 py-1 text-xs rounded font-medium ${
                    syncing
                      ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  }`}
                >
                  {syncing ? 'Syncing...' : 'Sync Orders'}
                </button>
                {stats.pendingOrders >= 2 && (
                  <button
                    onClick={handleConsolidate}
                    disabled={consolidating}
                    className={`px-3 py-1 text-xs rounded font-medium ${
                      consolidating
                        ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                        : 'bg-purple-600 hover:bg-purple-500 text-white'
                    }`}
                  >
                    {consolidating ? 'Consolidating...' : 'Consolidate'}
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
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
                  {(state.orders || []).filter(o => o.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((order, i) => (
                    <tr key={i} className="border-t border-gray-700">
                      <td className="py-2">{new Date(order.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
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

      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 hidden lg:block">
        <div className="sticky top-4 space-y-4">
          {/* Next Trade Info */}
          {nextTrade && (
            <div className={`rounded-lg p-4 border ${
              !nextTrade.enabled ? 'bg-red-900/30 border-red-700' :
              nextTrade.fullyAllocated ? 'bg-yellow-900/30 border-yellow-700' :
              nextTrade.dryRun ? 'bg-yellow-900/30 border-yellow-600' :
              'bg-blue-900/30 border-blue-700'
            }`}>
              <div className="text-xs text-gray-400 mb-1">
                Next {nextTrade.intervalLabel || 'Daily'} Trade
                {nextTrade.dryRun && nextTrade.enabled && (
                  <span className="ml-2 px-1.5 py-0.5 bg-yellow-600 text-yellow-100 text-xs rounded">DRY RUN</span>
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
              <div className="mt-2 pt-2 border-t border-gray-700/50 flex justify-between text-xs">
                <span className="text-gray-400">Amount: <span className="text-white font-medium">{formatUSD(nextTrade.nextTradeAmount)}</span></span>
                <span className="text-gray-400">{formatUSD(nextTrade.remaining)} left</span>
              </div>
              {state.lastRunTimestamp && (
                <div className="mt-1 text-xs text-gray-500">
                  Last run: {new Date(state.lastRunTimestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </div>
              )}
            </div>
          )}

          {/* Activity Feed */}
          <ActivityFeed exchange={exchange} maxEvents={15} />
        </div>
      </div>
    </div>
  )
}

export default Dashboard
