import { useState, useEffect, useCallback } from 'react'
import ActivityFeed from './ActivityFeed'
import { useToast } from './Toast'
import { formatCurrency, formatPrice } from './charts/chartUtils'
import { getBaseCurrency, getQuoteCurrency } from '../App'
import { pairQuery as buildPairQuery } from '../utils/api'

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
    <div className={`p-2 rounded-lg border min-w-0 overflow-hidden ${colors[color]}`}>
      <div className="text-xs text-gray-400 truncate">{label}</div>
      <div className="text-sm sm:text-base font-bold truncate">{value}</div>
      {subtext && <div className="text-xs text-gray-500 overflow-hidden">{subtext}</div>}
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

function Dashboard({ summary, onRefresh, exchange = 'coinbase', pair }) {
  const [liveData, setLiveData] = useState(null)
  const [updating, setUpdating] = useState(false)
  const [countdown, setCountdown] = useState('')
  const [consolidating, setConsolidating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [regimeRunning, setRegimeRunning] = useState(true)
  const [convertPreview, setConvertPreview] = useState(null)
  const [showConvertConfirm, setShowConvertConfirm] = useState(false)
  const [converting, setConverting] = useState(false)
  const { addToast } = useToast()
  const pairQuery = buildPairQuery(pair)

  useEffect(() => {
    const fetchLive = async () => {
      const res = await fetch(`/api/${exchange}/status${pairQuery}`)
      if (res.ok) {
        const data = await res.json()
        setLiveData(data)
      }
    }
    fetchLive()
    const interval = setInterval(fetchLive, 10000)
    return () => clearInterval(interval)
  }, [exchange, pairQuery])

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
    const res = await fetch(`/api/${exchange}/config${pairQuery}`, {
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
    const res = await fetch(`/api/${exchange}/consolidate${pairQuery}`, {
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
    const res = await fetch(`/api/${exchange}/sync${pairQuery}`, { method: 'POST' })
    if (res.ok && onRefresh) {
      onRefresh()
    }
    setSyncing(false)
  }

  // Check if regime engine is running (for Export to Regime button)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/${exchange}/regime/status${pairQuery}`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => setRegimeRunning(data.running || data.status?.isRunning || false))
      .catch(() => {})
    return () => controller.abort()
  }, [exchange, pairQuery])

  const handlePreviewExport = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: true, merge: true }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      addToast({ type: 'error', title: 'Preview Failed', message: err.error || 'Could not preview export' })
      return
    }
    const data = await res.json()
    setConvertPreview(data)
    setShowConvertConfirm(true)
  }, [exchange, pairQuery, addToast])

  const handleExecuteExport = useCallback(async () => {
    setConverting(true)
    const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: false, merge: true }),
    })
    setConverting(false)
    setShowConvertConfirm(false)
    setConvertPreview(null)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      addToast({ type: 'error', title: 'Export Failed', message: err.error || 'Could not export to regime' })
      return
    }

    const data = await res.json()
    addToast({
      type: 'success',
      title: 'Positions Exported to Regime',
      message: `${data.summary?.pendingOrders || 0} positions exported. Start the regime engine to place sell orders.`,
    })
    if (onRefresh) onRefresh()
  }, [exchange, pairQuery, addToast, onRefresh])

  if (!summary) return null

  const { config, state, stats, costBasis, nextTrade } = summary
  const quoteCurrency = getQuoteCurrency(config?.productId)
  const baseCurrency = getBaseCurrency(config?.productId)
  const currentPrice = liveData?.currentPrice || 0
  const assetValue = (state.assetReserves || 0) * currentPrice
  const pendingAssetValue = (state.outstandingOrdersAsset || 0) * currentPrice
  const totalAssetHeld = (state.assetReserves || 0) + (state.outstandingOrdersAsset || 0)
  const totalAssetCostBasis = (costBasis?.reservesCostBasis || 0) + (costBasis?.pendingCostBasis || 0)

  // formatCurrency for balances/totals, formatPrice for prices
  const formatAsset = (n) => `${parseFloat((n || 0).toFixed(8))} ${baseCurrency}`

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 overflow-hidden">
      {/* Main Content Column */}
      <div className="flex-1 space-y-4 min-w-0">
        {/* Live Price Banner + Controls */}
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <span className="text-gray-400 shrink-0 text-sm sm:text-base">{config?.productId || 'BTC-' + quoteCurrency}</span>
              <span className="text-xl sm:text-3xl font-bold truncate">{formatPrice(currentPrice)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
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
              <div className="text-right pl-2 sm:pl-4 border-l border-gray-700">
                <div className="text-xs text-gray-400">Mode</div>
                <div className={`text-xs sm:text-sm font-semibold ${
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
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-bold text-green-400 truncate">{formatCurrency(state.usdcFundSize)}</div>
                <div className="text-xs text-gray-500">{quoteCurrency}</div>
              </div>
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-bold text-orange-400 truncate">{formatCurrency(assetValue + pendingAssetValue)}</div>
                <div className="text-xs text-gray-500">{baseCurrency} Value</div>
              </div>
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-bold text-blue-400 truncate">{formatCurrency((state.usdcFundSize || 0) + assetValue + pendingAssetValue)}</div>
                <div className="text-xs text-gray-400">Total</div>
              </div>
            </div>
            {/* Asset Holdings Breakdown */}
            <div className="mt-3 pt-3 border-t border-gray-700">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center min-w-0">
                  <div className="text-gray-400 mb-1">Pending Sale</div>
                  <div className="text-yellow-400 font-semibold truncate">{formatAsset(state.outstandingOrdersAsset || 0)}</div>
                  <div className="text-gray-500 truncate">Cost: {formatCurrency(costBasis?.pendingCostBasis || 0)}</div>
                  <div className="text-green-400 truncate">Exp: {formatCurrency(state.outstandingOrdersUSDC || 0)}</div>
                </div>
                <div className="text-center min-w-0">
                  <div className="text-gray-400 mb-1">Reserves</div>
                  <div className="text-orange-400 font-semibold truncate">{formatAsset(state.assetReserves || 0)}</div>
                  <div className="text-gray-500 truncate">Cost: {formatCurrency(costBasis?.reservesCostBasis || 0)}</div>
                  <div className="text-gray-500 truncate">Val: {formatCurrency(assetValue)}</div>
                </div>
                <div className="text-center min-w-0">
                  <div className="text-gray-400 mb-1">Total {baseCurrency}</div>
                  <div className="text-purple-400 font-semibold truncate">{formatAsset(totalAssetHeld)}</div>
                  <div className="text-gray-500 truncate">Cost: {formatCurrency(totalAssetCostBasis)}</div>
                  <div className="text-gray-500 truncate">Avg: {formatPrice(totalAssetHeld > 0 ? totalAssetCostBasis / totalAssetHeld : 0)}/{baseCurrency}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Stats Grid - 3 rows of 3 */}
          <div className="space-y-2">
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-2">
              <StatCard label="Total Buys" value={stats.totalBuys} color="blue" />
              <StatCard label="Total Sells" value={stats.totalSells} color="green" />
              <StatCard label="Pending" value={stats.pendingOrders} color="yellow" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(() => {
                // Current market value of all asset holdings
                const totalAssetMarketValue = totalAssetHeld * currentPrice
                // Float P&L: if we sold everything at current price, what's the profit?
                const floatPnL = totalAssetMarketValue - totalAssetCostBasis
                const floatPnLPct = totalAssetCostBasis > 0 ? (floatPnL / totalAssetCostBasis) * 100 : 0
                const realizedPnL = stats.realizedProfit || 0
                const assetReserves = state.assetReserves || 0
                const reservesValue = assetReserves * currentPrice
                const totalRealizedLiquid = realizedPnL + reservesValue
                return (
                  <>
                    <StatCard
                      label={`${baseCurrency} Mkt Val`}
                      value={formatCurrency(totalAssetMarketValue)}
                      subtext={`Cost: ${formatCurrency(totalAssetCostBasis)}`}
                      color="blue"
                    />
                    <StatCard
                      label="Float P&L"
                      value={`${floatPnL >= 0 ? '+' : ''}${formatCurrency(floatPnL)}`}
                      subtext={`${floatPnLPct >= 0 ? '+' : ''}${floatPnLPct.toFixed(1)}%`}
                      color={floatPnL >= 0 ? 'green' : 'red'}
                    />
                    <StatCard
                      label="Realized"
                      value={`${totalRealizedLiquid >= 0 ? '+' : ''}${formatCurrency(totalRealizedLiquid)}`}
                      subtext={assetReserves > 0 ? <span className="flex flex-col leading-tight"><span className="text-white">{formatCurrency(realizedPnL)} USD</span><span className="text-orange-400">+{assetReserves.toFixed(8)} {baseCurrency}</span></span> : null}
                      color={totalRealizedLiquid >= 0 ? 'green' : 'red'}
                    />
                  </>
                )
              })()}
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-2">
              <StatCard label="Fees" value={formatCurrency(stats.totalFees)} color="red" />
              <StatCard label="Rebates" value={formatCurrency(stats.totalRebates)} color="green" />
              <StatCard label="Net Fees" value={formatCurrency(stats.netFees)} color="purple" />
            </div>
          </div>
        </div>

        {/* Allocation Progress + Config Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Allocation Progress */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex flex-wrap justify-between mb-2 text-sm gap-x-2">
              <span className="text-gray-400">Allocation Progress</span>
              <span className="text-white truncate">
                {formatCurrency(stats.allocationUsed)} / {formatCurrency(config.totalAllocation)}
              </span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${Math.min(100, (stats.allocationUsed / config.totalAllocation) * 100)}%` }}
              />
            </div>
            <div className="flex flex-wrap justify-between mt-2 text-xs text-gray-500 gap-x-2">
              <span>{stats.intervalsRun || 0} of {config.intervalsToSpread || config.daysToSpread} intervals</span>
              <span>{formatCurrency(stats.allocationRemaining)} remaining</span>
            </div>
            {nextTrade && !nextTrade.fullyAllocated && nextTrade.nextTradeAmount > 0 && (() => {
              const intervalsRemaining = Math.ceil(stats.allocationRemaining / nextTrade.nextTradeAmount)
              const intervalMs = {
                '1min': 60 * 1000,
                '5min': 5 * 60 * 1000,
                'hourly': 60 * 60 * 1000,
                '1hour': 60 * 60 * 1000,
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
            <div className="grid grid-cols-2 gap-x-3 sm:gap-x-4 gap-y-1 text-xs">
              <div className="truncate"><span className="text-gray-500">Product:</span> <span className="text-white">{config.productId}</span></div>
              <div className="truncate"><span className="text-gray-500">Interval:</span> <span className="text-white">{config.intervalType || 'daily'}</span></div>
              <div className="truncate"><span className="text-gray-500">Buy:</span> <span className="text-white">{formatCurrency(config.totalAllocation / (config.intervalsToSpread || config.daysToSpread || 1))}</span></div>
              <div className="truncate"><span className="text-gray-500">Intervals:</span> <span className="text-white">{config.intervalsToSpread || config.daysToSpread}</span></div>
              <div className="truncate"><span className="text-gray-500">Markup:</span> <span className="text-white">+{config.sellMarkupPercent}%</span></div>
              <div className="truncate"><span className="text-gray-500">Holdback:</span> <span className="text-white">{config.holdbackPercent}%</span></div>
              <div className="truncate"><span className="text-gray-500">Max Price:</span> <span className="text-white">{formatPrice(config.maxBuyPrice)}</span></div>
              <div className="truncate"><span className="text-gray-500">Consolidate:</span> <span className="text-white">{config.consolidateAfterOrders || 'Off'}</span></div>
            </div>
          </div>
        </div>

        {/* Pending Orders */}
        {(state.orders || []).filter(o => o.status === 'pending').length > 0 && (
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold">Pending Sell Orders ({stats.pendingOrders})</h3>
              <div className="flex flex-wrap gap-2">
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
                {!regimeRunning && (
                  <button
                    onClick={handlePreviewExport}
                    className="px-3 py-1 text-xs rounded font-medium bg-indigo-600 hover:bg-indigo-500 text-white"
                  >
                    Export to Regime
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
                      <td className="py-2 whitespace-nowrap">{new Date(order.createdAt).toISOString().replace('T', ' ').slice(0, 19)}</td>
                      <td className="py-2 whitespace-nowrap">{formatPrice(order.buyPrice)}</td>
                      <td className="py-2 whitespace-nowrap">{formatPrice(order.sellPrice)}</td>
                      <td className="py-2 whitespace-nowrap">{order.sellQuantity?.toFixed(8)} {baseCurrency}</td>
                      <td className="py-2 whitespace-nowrap">{formatCurrency(order.sellQuantity * order.sellPrice)}</td>
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
                <span className="text-gray-400">Amount: <span className="text-white font-medium">{formatCurrency(nextTrade.nextTradeAmount)}</span></span>
                <span className="text-gray-400">{formatCurrency(nextTrade.remaining)} left</span>
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

      {/* Export to Regime confirmation modal */}
      {showConvertConfirm && convertPreview && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !converting && setShowConvertConfirm(false)}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">Export to Regime Engine</h3>
            <p className="text-gray-300 text-sm mb-4">
              {convertPreview.merge
                ? `Merge ${convertPreview.pending} DCA position${convertPreview.pending !== 1 ? 's' : ''} into the existing regime engine (${convertPreview.existingBodies} bodies, ${convertPreview.existingAsset?.toFixed(8)} ${baseCurrency}).`
                : `Export ${convertPreview.pending} DCA position${convertPreview.pending !== 1 ? 's' : ''} to a new regime engine state.`}
            </p>
            <div className="bg-gray-900 rounded-lg p-3 mb-4 text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-gray-400">Positions to import</span>
                <span className="text-white font-mono">{convertPreview.pending}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">{baseCurrency} amount</span>
                <span className="text-yellow-400 font-mono">{convertPreview.pendingBaseQty?.toFixed(8)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Cost basis</span>
                <span className="text-yellow-400 font-mono">{formatCurrency(convertPreview.pendingCostBasis)}</span>
              </div>
              {convertPreview.merge && (
                <div className="border-t border-gray-700 pt-1.5 flex justify-between">
                  <span className="text-gray-400">Existing regime bodies</span>
                  <span className="text-green-400 font-mono">{convertPreview.existingBodies}</span>
                </div>
              )}
            </div>
            <p className="text-gray-500 text-xs mb-4">
              New sell orders will be placed automatically when the regime engine is started.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => setShowConvertConfirm(false)}
                disabled={converting}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded transition-colors disabled:opacity-50"
                onClick={handleExecuteExport}
                disabled={converting}
              >
                {converting ? 'Exporting...' : 'Confirm Export'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard
