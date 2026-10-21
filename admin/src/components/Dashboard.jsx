import { getIntervalMs } from '../utils/intervals.mjs'
import { plural } from '../utils/plural.mjs'
import { fetchConvertPreview } from './regime/useDcaConversion'
import { useState, useEffect, useCallback, useId, useRef } from 'react'
import ActivityFeed from './ActivityFeed'
import ModalDialog from './ModalDialog'
import FailedSellPlacements from './FailedSellPlacements'
import DcaPlacementRecovery from './DcaPlacementRecovery'
import DcaPendingBuyRecovery from './DcaPendingBuyRecovery'
import { useToast } from './Toast'
import { formatCurrency, formatPrice, formatAsset } from './charts/chartUtils'
import { getBaseCurrency, getQuoteCurrency } from '../App'
import { pairQuery as buildPairQuery } from '../utils/api'
import { createRequestOwner } from '../utils/requestOwner.mjs'
import { runDashboardAction } from '../utils/dashboardAction.mjs'
import { formatCountdown } from '../utils/countdown.mjs'
import ToggleSwitch from './ToggleSwitch'
import StatCard from './StatCard'

function Dashboard({ summary, onRefresh, exchange = 'coinbase', pair }) {
  const convertTitleId = useId()
  const convertDescId = useId()
  const [liveData, setLiveData] = useState(null)
  const [liveError, setLiveError] = useState(null)
  const [updating, setUpdating] = useState(false)
  const [countdown, setCountdown] = useState('')
  const [consolidating, setConsolidating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [regimeRunning, setRegimeRunning] = useState(true)
  const [regimeStatusError, setRegimeStatusError] = useState(false)
  const [regimeStatusNonce, setRegimeStatusNonce] = useState(0)
  const [convertPreview, setConvertPreview] = useState(null)
  const [showConvertConfirm, setShowConvertConfirm] = useState(false)
  const [converting, setConverting] = useState(false)
  const [retryingBuyId, setRetryingBuyId] = useState(null)
  const [recoveringBuy, setRecoveringBuy] = useState(false)
  const [buyRecoveryNotice, setBuyRecoveryNotice] = useState(null)
  const buyRecoveryRef = useRef(false)
  const { addToast } = useToast()
  const pairQuery = buildPairQuery(pair)
  const liveOwnerRef = useRef(null)
  if (!liveOwnerRef.current) liveOwnerRef.current = createRequestOwner()

  // The live status read is the authoritative DCA state.json view: failed sell
  // placements come from here alongside current exchange balances and price.
  const fetchLive = useCallback(async () => {
    if (buyRecoveryRef.current) return false
    const { owned, data } = await liveOwnerRef.current.read(`/api/${exchange}/status${pairQuery}`)
    if (owned && data) setLiveData(data)
    if (owned) setLiveError(data ? data.apiError || null : 'Could not load live status.')
    return Boolean(owned && data)
  }, [exchange, pairQuery])

  const handleResumeBuy = async (orderId) => {
    if (buyRecoveryRef.current) return
    buyRecoveryRef.current = true
    const token = liveOwnerRef.current.claim()
    setRecoveringBuy(true)
    setBuyRecoveryNotice(null)
    let message
    try {
      const res = await fetch(`/api/${exchange}/resume-pending-buy${pairQuery}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId }),
      })
      const data = await res.json()
      if (!liveOwnerRef.current.owns(token)) return
      const sellFailed = data.status === 'sell_placement_failed' && data.recoveredPendingBuy
      if (!sellFailed && (!res.ok || (!data.success && data.status !== 'buy_fill_pending'))) {
        throw new Error(data.error || data.message || 'Buy recovery could not be confirmed')
      }
      message = sellFailed
        ? `Buy fill recorded, but its covering sell failed: ${data.error || 'see engine logs'}. Check Failed Sell Placements below or the engine logs before resuming automation.`
        : data.message || 'Buy recovery checked.'
      setBuyRecoveryNotice({ message, error: Boolean(sellFailed) })
      setLiveData(previous => ({ ...previous, state: { ...(previous?.state || {}),
        pendingDcaBuy: data.status === 'buy_fill_pending' ? data.pendingBuy : null } }))
    } catch (err) {
      if (!liveOwnerRef.current.owns(token)) return
      setBuyRecoveryNotice({ error: true, message: `${err.message || 'Buy recovery unavailable'}. Refresh status or retry recovery for the same order.` })
    } finally {
      buyRecoveryRef.current = false
      if (liveOwnerRef.current.owns(token)) setRecoveringBuy(false)
    }
    if (!liveOwnerRef.current.owns(token)) return
    // A failed status read after an acknowledged recovery is a read failure,
    // not a failed mutation. Do not invite another purchase or lose its result.
    if (!await fetchLive() && message) {
      setBuyRecoveryNotice({ message: `${message} Dashboard status could not refresh; reload to check the current state.` })
    }
  }

  useEffect(() => {
    fetchLive()
    const interval = setInterval(fetchLive, 10000)
    return () => {
      clearInterval(interval)
      liveOwnerRef.current.invalidate()
    }
  }, [fetchLive])

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
    await runDashboardAction({
      setBusy: setUpdating,
      request: () => fetch(`/api/${exchange}/config${pairQuery}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value })
      }),
      addToast,
      failureTitle: 'Configuration Update Failed',
      failureMessage: 'Could not update DCA configuration',
      onSuccess: () => onRefresh?.(),
    })
  }

  const handleConsolidate = async () => {
    await runDashboardAction({
      setBusy: setConsolidating,
      request: () => fetch(`/api/${exchange}/consolidate${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      addToast,
      failureTitle: 'Consolidation Failed',
      failureMessage: 'Could not consolidate DCA orders',
      onSuccess: () => onRefresh?.(),
    })
  }

  const handleSync = async () => {
    await runDashboardAction({
      setBusy: setSyncing,
      request: () => fetch(`/api/${exchange}/sync${pairQuery}`, { method: 'POST' }),
      addToast,
      failureTitle: 'Order Sync Failed',
      failureMessage: 'Could not sync DCA orders',
      onSuccess: () => onRefresh?.(),
    })
  }

  const handleRetrySell = async (buyOrderId) => {
    await runDashboardAction({
      setBusy: (busy) => setRetryingBuyId(busy ? buyOrderId : null),
      request: () => fetch(`/api/${exchange}/retry-failed-sell${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyOrderId })
      }),
      addToast,
      failureTitle: 'Sell Retry Failed',
      failureMessage: 'Could not place the sell for this buy',
      onSuccess: async (res) => {
        const data = await res.json()
        addToast({ type: 'success', title: 'Sell Placed', message: data.message || `Sell placed for buy ${buyOrderId}` })
        onRefresh?.()
      },
      onSettled: () => fetchLive(),
    })
  }

  // Check if regime engine is running (for Export to Regime button)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/${exchange}/regime/status${pairQuery}`, { signal: controller.signal })
      .then(async r => {
        // Keep the Export button hidden when the engine state is unknown
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        setRegimeRunning(data.running || data.status?.isRunning || false)
        setRegimeStatusError(false)
      })
      .catch(() => { if (!controller.signal.aborted) { setRegimeStatusError(true); setRegimeRunning(true) } })
    return () => controller.abort()
  }, [exchange, pairQuery, regimeStatusNonce])

  const handlePreviewExport = useCallback(async () => {
    const data = await fetchConvertPreview({ exchange, pairQuery, addToast })
    if (!data) return
    setConvertPreview(data)
    setShowConvertConfirm(true)
  }, [exchange, pairQuery, addToast])

  const handleExecuteExport = useCallback(async () => {
    await runDashboardAction({
      setBusy: setConverting,
      request: () => fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: false, merge: true }),
      }),
      addToast,
      failureTitle: 'Export Failed',
      failureMessage: 'Could not export to regime',
      onSuccess: async (res) => {
        const data = await res.json()
        addToast({
          type: 'success',
          title: 'Positions Exported to Regime',
          message: `${plural(data.summary?.pendingOrders || 0, "position")} exported. Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.`,
        })
        onRefresh?.()
      },
      onSettled: () => {
        setShowConvertConfirm(false)
        setConvertPreview(null)
      },
    })
  }, [exchange, pairQuery, addToast, onRefresh])

  if (!summary) return null

  const { config, state, stats, costBasis, nextTrade } = summary
  const quoteCurrency = getQuoteCurrency(config?.productId)
  const baseCurrency = getBaseCurrency(config?.productId)
  // Missing or non-positive price is unknown, never 0 (would render $0 / -100%).
  const livePrice = Number(liveData?.currentPrice)
  const currentPrice = livePrice > 0 ? livePrice : null
  const priceKnown = currentPrice !== null
  const NA = '—'
  const assetValue = (state.assetReserves || 0) * (currentPrice || 0)
  const pendingAssetValue = (state.outstandingOrdersAsset || 0) * (currentPrice || 0)
  const totalAssetHeld = (state.assetReserves || 0) + (state.outstandingOrdersAsset || 0)
  const hasHoldingCostBasis = costBasis != null
  const totalAssetCostBasis = (costBasis?.reservesCostBasis || 0) + (costBasis?.pendingCostBasis || 0)

  // formatCurrency for balances/totals, formatPrice for prices.
  // Local wrapper preserves this page's trailing-zero-stripped "0.5 BTC" rendering.
  const formatAssetHeld = (n) => formatAsset(n, baseCurrency, { stripTrailingZeros: true })

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 overflow-hidden">
      {/* Main Content Column */}
      <div className="flex-1 space-y-4 min-w-0">
        <DcaPlacementRecovery
          intents={liveData?.placementIntents}
          exchange={exchange}
          pair={pair}
          onResolved={async (data) => {
            setLiveData(previous => ({ ...previous, placementIntents: data.placementIntents }))
            if (!await fetchLive()) throw new Error('Status unavailable')
          }}
        />
        <DcaPendingBuyRecovery
          pendingBuy={liveData ? liveData.state?.pendingDcaBuy : state.pendingDcaBuy}
          busy={recoveringBuy}
          dryRun={liveData?.config?.dryRun ?? config.dryRun}
          placementIntents={liveData?.placementIntents}
          onResume={handleResumeBuy}
          notice={buyRecoveryNotice}
        />
        {/* Live Price Banner + Controls */}
        <div className="bg-gray-800 rounded-lg p-4">
          {liveError && (
            <div role="alert" className="mb-3 flex items-center justify-between gap-2 text-sm text-red-400">
              <span>{liveError}</span>
              <button type="button" onClick={fetchLive} className="px-2 py-1 rounded bg-gray-700 text-white">Retry</button>
            </div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <span className="text-gray-400 shrink-0 text-sm sm:text-base">{config?.productId || 'BTC-' + quoteCurrency}</span>
              <span className="text-xl sm:text-3xl font-bold truncate">{priceKnown ? formatPrice(currentPrice) : NA}</span>
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
                <div className="text-xs text-gray-400">{quoteCurrency}</div>
              </div>
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-bold text-orange-400 truncate">{priceKnown ? formatCurrency(assetValue + pendingAssetValue) : NA}</div>
                <div className="text-xs text-gray-400">{baseCurrency} Value</div>
              </div>
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-bold text-blue-400 truncate">{priceKnown ? formatCurrency((state.usdcFundSize || 0) + assetValue + pendingAssetValue) : NA}</div>
                <div className="text-xs text-gray-400">Total</div>
              </div>
            </div>
            {/* Asset Holdings Breakdown */}
            <div className="mt-3 pt-3 border-t border-gray-700">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center min-w-0">
                  <div className="text-gray-400 mb-1">Pending Sale</div>
                  <div className="text-yellow-400 font-semibold truncate">{formatAssetHeld(state.outstandingOrdersAsset || 0)}</div>
                  <div className="text-gray-400 truncate">Cost: {hasHoldingCostBasis ? formatCurrency(costBasis.pendingCostBasis || 0) : '—'}</div>
                  <div className="text-green-400 truncate">Exp: {formatCurrency(state.outstandingOrdersUSDC || 0)}</div>
                </div>
                <div className="text-center min-w-0">
                  <div className="text-gray-400 mb-1">Reserves</div>
                  <div className="text-orange-400 font-semibold truncate">{formatAssetHeld(state.assetReserves || 0)}</div>
                  <div className="text-gray-400 truncate">Cost: {hasHoldingCostBasis ? formatCurrency(costBasis.reservesCostBasis || 0) : '—'}</div>
                  <div className="text-gray-400 truncate">Val: {priceKnown ? formatCurrency(assetValue) : NA}</div>
                </div>
                <div className="text-center min-w-0">
                  <div className="text-gray-400 mb-1">Total {baseCurrency}</div>
                  <div className="text-purple-400 font-semibold truncate">{formatAssetHeld(totalAssetHeld)}</div>
                  <div className="text-gray-400 truncate">Cost: {hasHoldingCostBasis ? formatCurrency(totalAssetCostBasis) : '—'}</div>
                  <div className="text-gray-400 truncate">Avg: {hasHoldingCostBasis ? formatPrice(totalAssetHeld > 0 ? totalAssetCostBasis / totalAssetHeld : 0) : '—'}/{baseCurrency}</div>
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
                const totalAssetMarketValue = totalAssetHeld * (currentPrice || 0)
                // Float P&L: if we sold everything at current price, what's the profit?
                const floatPnL = totalAssetMarketValue - totalAssetCostBasis
                const floatPnLPct = totalAssetCostBasis > 0 ? (floatPnL / totalAssetCostBasis) * 100 : 0
                const hasRealizedPnL = Number.isFinite(stats.realizedProfit)
                const realizedPnL = stats.realizedProfit
                const assetReserves = state.assetReserves || 0
                const reservesValue = assetReserves * (currentPrice || 0)
                const totalRealizedLiquid = realizedPnL + reservesValue
                return (
                  <>
                    <StatCard
                      label={`${baseCurrency} Mkt Val`}
                      value={priceKnown ? formatCurrency(totalAssetMarketValue) : NA}
                      subtext={hasHoldingCostBasis ? `Cost: ${formatCurrency(totalAssetCostBasis)}` : 'Cost unavailable'}
                      color="blue"
                    />
                    <StatCard
                      label="Float P&L"
                      value={hasHoldingCostBasis && priceKnown ? `${floatPnL >= 0 ? '+' : ''}${formatCurrency(floatPnL)}` : NA}
                      subtext={!hasHoldingCostBasis ? 'Unavailable for Fibonacci DCA' : priceKnown ? `${floatPnLPct >= 0 ? '+' : ''}${floatPnLPct.toFixed(1)}%` : 'Price unavailable'}
                      color={!hasHoldingCostBasis || !priceKnown ? 'blue' : floatPnL >= 0 ? 'green' : 'red'}
                    />
                    <StatCard
                      label="Realized"
                      value={hasRealizedPnL ? `${totalRealizedLiquid >= 0 ? '+' : ''}${formatCurrency(totalRealizedLiquid)}` : NA}
                      subtext={!hasRealizedPnL ? 'Unavailable for Simple DCA' : assetReserves > 0 ? <span className="flex flex-col leading-tight"><span className="text-white">{formatCurrency(realizedPnL)} USD</span><span className="text-orange-400">+{assetReserves.toFixed(8)} {baseCurrency}</span></span> : null}
                      color={!hasRealizedPnL ? 'blue' : totalRealizedLiquid >= 0 ? 'green' : 'red'}
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
            <div className="flex flex-wrap justify-between mt-2 text-xs text-gray-400 gap-x-2">
              <span>{stats.intervalsRun || 0} of {config.intervalsToSpread || config.daysToSpread} intervals</span>
              <span>{formatCurrency(stats.allocationRemaining)} remaining</span>
            </div>
            {nextTrade && !nextTrade.fullyAllocated && nextTrade.nextTradeAmount > 0 && (() => {
              const intervalsRemaining = Math.ceil(stats.allocationRemaining / nextTrade.nextTradeAmount)
              const intervalMs = getIntervalMs(config.intervalType)
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
              <div className="truncate"><span className="text-gray-400">Product:</span> <span className="text-white">{config.productId}</span></div>
              <div className="truncate"><span className="text-gray-400">Interval:</span> <span className="text-white">{config.intervalType || 'daily'}</span></div>
              <div className="truncate"><span className="text-gray-400">Buy:</span> <span className="text-white">{formatCurrency(config.totalAllocation / (config.intervalsToSpread || config.daysToSpread || 1))}</span></div>
              <div className="truncate"><span className="text-gray-400">Intervals:</span> <span className="text-white">{config.intervalsToSpread || config.daysToSpread}</span></div>
              <div className="truncate"><span className="text-gray-400">Markup:</span> <span className="text-white">+{config.sellMarkupPercent}%</span></div>
              <div className="truncate"><span className="text-gray-400">Holdback:</span> <span className="text-white">{config.holdbackPercent}%</span></div>
              <div className="truncate"><span className="text-gray-400">Max Price:</span> <span className="text-white">{formatPrice(config.maxBuyPrice)}</span></div>
              <div className="truncate"><span className="text-gray-400">Consolidate:</span> <span className="text-white">{config.consolidateAfterOrders || 'Off'}</span></div>
            </div>
          </div>
        </div>

        {/* Failed Sell Placements — bought asset with no tracked sell (issue #1035) */}
        <FailedSellPlacements
          failedSells={liveData?.failedSells}
          placementIntents={liveData?.placementIntents}
          baseCurrency={baseCurrency}
          retryingBuyId={retryingBuyId}
          onRetry={handleRetrySell}
        />

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
                {regimeStatusError && (
                  <span role="alert" className="flex items-center gap-2 text-xs text-yellow-400">
                    Regime status unavailable
                    <button type="button" onClick={() => setRegimeStatusNonce(n => n + 1)} className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 inline-flex items-center justify-center px-2 py-0.5 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-200">Retry</button>
                  </span>
                )}
                {!regimeRunning && (
                  <button
                    onClick={handlePreviewExport}
                    className="px-3 py-1 text-xs rounded-sm font-medium bg-blue-600 hover:bg-blue-500 text-white"
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
                    <tr key={order.orderId || order.buyOrderId || i} className="border-t border-gray-700">
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
      <div className="w-80 shrink-0 hidden lg:block">
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
                  <span className="ml-2 px-1.5 py-0.5 bg-yellow-800 text-yellow-100 text-xs rounded-sm">DRY RUN</span>
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
                <div className="mt-1 text-xs text-gray-400">
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
        <ModalDialog
          onClose={() => setShowConvertConfirm(false)}
          dismissible={!converting}
          labelledBy={convertTitleId}
          describedBy={convertDescId}
        >
          <h3 id={convertTitleId} className="text-white text-lg font-medium mb-3">Export to Regime Engine</h3>
          <p id={convertDescId} className="text-gray-300 text-sm mb-4">
            {convertPreview.merge
              ? `Merge ${convertPreview.pending} DCA position${convertPreview.pending !== 1 ? 's' : ''} into the existing regime engine (${plural(convertPreview.existingBodies, 'body', 'bodies')}, ${convertPreview.existingAsset?.toFixed(8)} ${baseCurrency}). Existing DCA sell orders may remain open on the exchange, but the regime engine will not track them. Before starting the regime engine, cancel those DCA sell orders on the exchange and confirm that they are no longer open.`
              : `Export ${convertPreview.pending} DCA position${convertPreview.pending !== 1 ? 's' : ''} to a new regime engine state. Existing DCA sell orders may remain open on the exchange, but the regime engine will not track them. Before starting the regime engine, cancel those DCA sell orders on the exchange and confirm that they are no longer open.`}
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
          <p className="text-gray-400 text-xs mb-4">
            Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.
          </p>
          <div className="flex justify-end gap-3">
            <button
              className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-sm transition-colors"
              onClick={() => setShowConvertConfirm(false)}
              disabled={converting}
              autoFocus
            >
              Cancel
            </button>
            <button
              className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-sm transition-colors disabled:opacity-50"
              onClick={handleExecuteExport}
              disabled={converting}
            >
              {converting ? 'Exporting...' : 'Confirm Export'}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}

export default Dashboard
