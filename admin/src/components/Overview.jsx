import Button from './ui/Button'
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { Link, useNavigate } from '../lib/router'
import { ExternalLink } from './icons'
import { useMultiRegimeStatuses } from '../hooks/useTradeEvents'
import { getBaseCurrency, getQuoteCurrency } from '../App'
import { formatCurrency, formatPrice, formatAsset } from './charts/chartUtils'
import AddFundModal from './AddFundModal'
import ClosedFundCard from './ClosedFundCard'
import { EXCHANGE_ICONS, EXCHANGE_COLORS } from './exchangeStyles'
import { REGIME_COLORS, HEALTH_COLORS } from './regime/regimeStyles'
import { apiGet } from '../utils/apiClient'
import { pnlColorClass, signedPrefix } from '../utils/pnlFormat.mjs'
import { mergeRegimeStatus, nextRegimeStatusSeq } from '../utils/regimeStatusSnapshot.mjs'

const CelestialVisualization = lazy(() => import('./celestial/CelestialVisualization'))

const getEngineStatus = (isRunning, isDryRun, lifecycle) => {
  if (lifecycle === 'closed') {
    return { label: 'Closed', color: 'bg-gray-700', textColor: 'text-gray-400' }
  }
  if (lifecycle === 'draining') {
    return { label: 'Draining', color: 'bg-yellow-700', textColor: 'text-yellow-200', pulse: true }
  }
  if (isRunning) {
    return isDryRun
      ? { label: 'Dry-Run', color: 'bg-purple-600', textColor: 'text-purple-100', pulse: true }
      : { label: 'Running', color: 'bg-green-600', textColor: 'text-green-100', pulse: true }
  }
  return { label: 'Stopped', color: 'bg-gray-600', textColor: 'text-gray-300' }
}

function Overview() {
  const navigate = useNavigate()
  const [exchanges, setExchanges] = useState([])
  const [snapshotMap, setSnapshotMap] = useState({})
  const [statusState, setStatusState] = useState({})
  const [exchangesError, setExchangesError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [addFundOpen, setAddFundOpen] = useState(false)
  const loadOwnerRef = useRef(0)
  const abortControllerRef = useRef(null)
  const snapshotMapRef = useRef(snapshotMap)
  snapshotMapRef.current = snapshotMap

  const { snapshots: wsSnapshots, statuses: wsStatuses, connected } = useMultiRegimeStatuses()

  const refreshExchanges = async () => {
    // A failed read leaves the existing exchange list as-is; caller UI isn't gated on this.
    const result = await apiGet('/api/exchanges')
    if (result.ok) setExchanges(result.data.exchanges || [])
  }

  // Per-fund key used in snapshotMap. The /api/exchanges response now returns
  // one entry per (exchange, pair) fund — we use composite keys so two funds
  // on the same exchange (e.g., coinbase BTC-USDC and coinbase ETH-USDC) keep
  // independent status entries.
  const fundKey = (ex) => `${ex.name}::${ex.pair || ex.productId || ex.name || 'default'}`

  // Fetch exchange list and each fund status as one retryable, fenced page load (#1817).
  const load = async () => {
    const loadId = ++loadOwnerRef.current
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    setLoading(true)
    try {
      const res = await apiGet('/api/exchanges', { signal: controller.signal })
      if (loadOwnerRef.current !== loadId) return
      if (!res.ok) throw new Error(`Exchange list request failed (HTTP ${res.status})`)
      const exchangeList = res.data.exchanges || []
      setExchanges(exchangeList)
      setExchangesError(null)

      const entries = await Promise.all(exchangeList.map(async (ex) => {
        const pairParam = ex.pair || ex.productId || ''
        const readSeq = nextRegimeStatusSeq()
        const r = await apiGet(`/api/${ex.name}/regime/status?pair=${encodeURIComponent(pairParam)}`, { signal: controller.signal })
        if (loadOwnerRef.current !== loadId) return null
        const key = fundKey(ex)
        if (!r.ok) return { key, status: null, state: 'error', seq: readSeq }
        return { key, status: r.data?.status || null, state: r.data?.status ? 'ok' : 'error', seq: readSeq }
      }))
      if (loadOwnerRef.current !== loadId) return

      const validKeys = new Set(exchangeList.map(fundKey))

      setSnapshotMap(prev => {
        const next = {}
        // Retain only currently valid funds
        for (const [key, snap] of Object.entries(prev)) {
          if (validKeys.has(key)) next[key] = snap
        }
        for (const entry of entries) {
          if (!entry) continue
          const { key, status, seq, state } = entry
          const current = next[key]
          // If a newer snapshot already arrived (e.g. from socket while HTTP was in flight), keep it
          if (current && current.seq > seq) continue
          if (state === 'error') {
            if (!current?.status) {
              next[key] = { status: null, seq }
            }
          } else {
            const merged = mergeRegimeStatus(current?.status, status)
            next[key] = { status: merged, seq }
          }
        }
        return next
      })

      setStatusState(prev => {
        const next = {}
        for (const [key, state] of Object.entries(prev)) {
          if (validKeys.has(key)) next[key] = state
        }
        for (const entry of entries) {
          if (!entry) continue
          const { key, seq, state } = entry
          const currentSnap = snapshotMapRef.current[key]
          if (currentSnap && currentSnap.seq > seq) {
            if (currentSnap.status) next[key] = 'ok'
            continue
          }
          next[key] = state
        }
        return next
      })
    } catch (error) {
      if (loadOwnerRef.current === loadId) {
        setExchangesError(error.message || 'Failed to load exchanges')
      }
    } finally {
      if (loadOwnerRef.current === loadId) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    load()
    return () => {
      loadOwnerRef.current += 1
      abortControllerRef.current?.abort()
    }
  }, [])

  // Merge WebSocket updates into snapshot map. wsSnapshots is keyed by
  // `${exchange}::${pair}` with monotonic generations so each fund updates
  // independently and HTTP/socket ordering is strictly arbitrated (#1817).
  useEffect(() => {
    const hasSnapshots = wsSnapshots && Object.keys(wsSnapshots).length > 0
    const hasStatuses = wsStatuses && Object.keys(wsStatuses).length > 0
    if (!hasSnapshots && !hasStatuses) return

    setSnapshotMap(prev => {
      const next = { ...prev }
      if (hasSnapshots) {
        for (const [key, snap] of Object.entries(wsSnapshots)) {
          if (!snap?.status) continue
          const current = next[key]
          if (current && current.seq > snap.seq) continue
          const merged = mergeRegimeStatus(current?.status, snap.status)
          next[key] = { status: merged, seq: snap.seq }
        }
      } else {
        // Fallback for tests or mocks providing only wsStatuses
        for (const [key, status] of Object.entries(wsStatuses)) {
          if (!status) continue
          const current = next[key]
          if (current?.status === status) continue
          const nextSeq = nextRegimeStatusSeq()
          const merged = mergeRegimeStatus(current?.status, status)
          next[key] = { status: merged, seq: nextSeq }
        }
      }
      return next
    })

    setStatusState(prev => {
      const next = { ...prev }
      const source = hasSnapshots ? wsSnapshots : wsStatuses
      for (const [key, val] of Object.entries(source)) {
        if (hasSnapshots ? val?.status : val) {
          next[key] = 'ok'
        }
      }
      return next
    })
  }, [wsSnapshots, wsStatuses])

  // Build card data from exchanges + statuses
  const cards = exchanges.map(ex => {
    const key = fundKey(ex)
    const status = snapshotMap[key]?.status
    const statusUnavailable = statusState[key] === 'error'
    const pair = ex.pair || ex.productId || 'BTC-USDC'
    const baseCurrency = getBaseCurrency(ex.productId || pair)
    const quoteCurrency = getQuoteCurrency(ex.productId || pair)
    const position = status?.position
    const market = status?.market
    const apy = status?.apy
    const regime = status?.regime
    const health = status?.health
    const celestial = status?.celestial
    const isRunning = status?.isRunning ?? false
    const isDryRun = status?.isDryRun ?? false
    const lifecycle = status?.lifecycle?.lifecycle || ex.lifecycle || 'active'

    const lastPrice = market?.lastPrice ?? 0

    // Position asset qty (syncPositionState already sums body assets into totalAsset)
    const totalAssetQty = position?.totalAsset ?? 0
    const totalAssetCostBasis = position?.totalCostBasis ?? 0
    // Total capital deployed including pending orders (for Capital widget)
    const totalCostBasis = apy?.deployedInPosition ?? totalAssetCostBasis
    // Calculate unrealized from full asset position
    const unrealizedPnL = totalAssetQty > 0 && lastPrice > 0
      ? (totalAssetQty * lastPrice) - totalAssetCostBasis
      : 0
    const unrealizedPct = totalAssetCostBasis > 0 ? (unrealizedPnL / totalAssetCostBasis) * 100 : 0

    // Realized P&L includes USD profits + asset holdback valued at current price
    const realizedUsdcPnL = position?.realizedPnL ?? celestial?.bodiesRealizedPnL ?? 0
    const realizedAssetPnL = position?.realizedAssetPnL ?? 0
    const realizedPnL = realizedUsdcPnL + (realizedAssetPnL * lastPrice)
    const availableCapital = apy?.availableCapital ?? 0
    const estimatedApy = apy?.estimatedApy ?? 0
    const depositedCapital = apy?.depositedCapital ?? apy?.originalCapital ?? apy?.initialCapital ?? 0
    const elapsedDays = apy?.elapsedDays ?? 0
    const cyclesPerDay = apy?.cyclesPerDay ?? 0
    const dailyReturnPercent = apy?.dailyReturnPercent ?? 0
    const estimatedDailyUsdc = apy?.estimatedDailyUsdc ?? 0
    const estimatedDailyAsset = apy?.estimatedDailyAsset ?? 0
    const totalLiquidValue = apy?.totalLiquidValue
    const totalLiquidValuePercent = apy?.totalLiquidValuePercent
    const engineStartTime = apy?.engineStartTime
    const cycleBuys = position?.cycleBuys ?? position?.ladderStep ?? 0
    const maxCycleBuys = status?.config?.maxCycleBuys ?? 10
    const cyclesCompleted = celestial?.bodiesCompleted ?? position?.cyclesCompleted ?? 0
    const bodiesActive = celestial?.bodiesActive ?? 0
    const tierSummary = celestial?.tierSummary || ''
    const regimeMode = regime?.mode || (status?.config?.regimeMode) || null
    const healthMode = health?.mode || 'STOPPED'

    // Expected gain if all pending sell orders fill at their target prices
    const expectedCycleGain = (celestial?.bodies || []).reduce((sum, body) => {
      if (body.tpPrice > 0 && body.assetOnOrder > 0) {
        return sum + body.assetOnOrder * (body.tpPrice - body.avgPrice)
      }
      return sum
    }, 0)

    return {
      exchange: ex.name,
      pair,
      statusUnavailable,
      baseCurrency,
      quoteCurrency,
      isRunning,
      isDryRun,
      lifecycle,
      healthMode,
      regimeMode,
      lastPrice,
      totalAssetQty,
      totalCostBasis,
      availableCapital,
      unrealizedPnL,
      unrealizedPct,
      expectedCycleGain,
      realizedPnL,
      realizedUsdcPnL,
      estimatedApy,
      depositedCapital,
      elapsedDays,
      cyclesPerDay,
      dailyReturnPercent,
      estimatedDailyUsdc,
      estimatedDailyAsset,
      totalLiquidValue,
      totalLiquidValuePercent,
      realizedAssetPnL,
      engineStartTime,
      cycleBuys,
      maxCycleBuys,
      cyclesCompleted,
      bodiesActive,
      tierSummary,
      celestial,
      totalAssetCostBasis,
      maxUsdcDeployed: status?.config?.maxUsdcDeployed ?? apy?.maxUsdcDeployed ?? 0,
    }
  })

  // Aggregate summary
  const availableCards = cards.filter(c => !c.statusUnavailable)
  const unavailableCount = cards.length - availableCards.length
  const totals = availableCards.reduce((acc, c) => ({
    deployed: acc.deployed + c.totalCostBasis,
    available: acc.available + c.availableCapital,
    unrealized: acc.unrealized + c.unrealizedPnL,
    realized: acc.realized + c.realizedPnL,
    expectedCycleGain: acc.expectedCycleGain + c.expectedCycleGain,
  }), { deployed: 0, available: 0, unrealized: 0, realized: 0, expectedCycleGain: 0 })

  // Keep quote profits grouped by currency alongside the per-asset breakdown.
  const quoteBreakdown = availableCards.reduce((acc, card) => {
    const quote = card.quoteCurrency
    if (!acc[quote]) acc[quote] = { realized: 0, annual: 0 }
    acc[quote].realized += card.realizedUsdcPnL
    acc[quote].annual += card.estimatedDailyUsdc * 365
    return acc
  }, {})
  const assetBreakdown = availableCards.reduce((acc, c) => {
    if (c.realizedAssetPnL > 0) {
      if (!acc[c.baseCurrency]) acc[c.baseCurrency] = { qty: 0, usd: 0 }
      acc[c.baseCurrency].qty += c.realizedAssetPnL
      acc[c.baseCurrency].usd += c.realizedAssetPnL * c.lastPrice
    }
    return acc
  }, {})

  // Weighted APY (by cost basis)
  const totalCostBasisAll = availableCards.reduce((sum, c) => sum + c.totalCostBasis, 0)
  const weightedApy = totalCostBasisAll > 0
    ? availableCards.reduce((sum, c) => sum + c.estimatedApy * c.totalCostBasis, 0) / totalCostBasisAll
    : 0

  // Aggregate annual yield projections
  const totalAnnualUsdc = availableCards.reduce((sum, c) => sum + (c.estimatedDailyUsdc * 365), 0)
  const annualAssetBreakdown = availableCards.reduce((acc, c) => {
    if (c.estimatedDailyAsset > 0) {
      const key = c.baseCurrency
      if (!acc[key]) acc[key] = { qty: 0, usd: 0 }
      acc[key].qty += c.estimatedDailyAsset * 365
      acc[key].usd += c.estimatedDailyAsset * 365 * c.lastPrice
    }
    return acc
  }, {})
  const totalAnnualAssetUsd = Object.values(annualAssetBreakdown).reduce((sum, a) => sum + a.usd, 0)
  const totalAnnualLiquid = totalAnnualUsdc + totalAnnualAssetUsd

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div>
      {/* Header with Add Fund button */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white">Funds</h1>
        <Button
          onClick={() => setAddFundOpen(true)}
          variant="primary" size="compact" className="font-medium"
          title="Create a new trading fund on an existing exchange"
        >
          + Add Fund
        </Button>
      </div>

      <AddFundModal
        open={addFundOpen}
        onClose={() => setAddFundOpen(false)}
        exchanges={exchanges}
        onCreated={async ({ exchange, pair }) => {
          await refreshExchanges()
          // Navigate to the new fund's config page so the operator can review/enable it
          navigate(`/${exchange}/${pair}/config`)
        }}
      />

      {exchangesError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-700 bg-red-900/20 p-4 mb-4 text-red-200">
          <span>Unable to load exchanges: {exchangesError}</span>
          <Button onClick={load} variant="primary" size="compact">Retry</Button>
        </div>
      )}

      {/* Aggregate summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 min-w-0 overflow-hidden">
          <div className="text-xs text-gray-400 mb-1">Capital</div>
          <div className="text-base sm:text-lg font-bold text-white truncate">{formatCurrency(totals.deployed)}</div>
          <div className="text-xs text-gray-400">deployed</div>
          <div className="text-sm text-cyan-400 truncate">{formatCurrency(totals.available)}</div>
          <div className="text-xs text-gray-400">available</div>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 min-w-0 overflow-hidden">
          <div className="text-xs text-gray-400 mb-1">Unrealized P&L</div>
          <div className={`text-base sm:text-lg font-bold truncate ${pnlColorClass(totals.unrealized)}`}>
            {signedPrefix(totals.unrealized)}{formatCurrency(totals.unrealized)}
          </div>
          <div className="text-xs text-gray-400 truncate">paper value if sold now</div>
          {totals.expectedCycleGain > 0 && (
            <div className="mt-1">
              <div className="text-xs text-cyan-400 font-mono truncate">+{formatCurrency(totals.expectedCycleGain)}</div>
              <div className="text-xs text-gray-400 truncate">expected when cycles close</div>
            </div>
          )}
        </div>
        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 min-w-0 overflow-hidden">
          <div className="text-xs text-gray-400 mb-1">Realized P&L</div>
          <div className={`text-base sm:text-lg font-bold truncate ${pnlColorClass(totals.realized)}`}>
            {signedPrefix(totals.realized)}{formatCurrency(totals.realized)}
          </div>
          {Object.entries(quoteBreakdown).map(([quote, amounts]) => (
            <div key={quote} className="text-xs text-white font-mono truncate">{formatCurrency(amounts.realized)} {quote}</div>
          ))}
          {Object.entries(assetBreakdown).map(([asset, { qty, usd }]) => (
            <div key={asset} className="text-xs text-orange-400 font-mono truncate">+{formatAsset(qty, asset)} ({formatCurrency(usd)})</div>
          ))}
        </div>
        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 min-w-0 overflow-hidden">
          <div className="text-xs text-gray-400 mb-1">Estimated APY</div>
          <div className={`text-base sm:text-lg font-bold ${pnlColorClass(weightedApy)}`}>
            {weightedApy.toFixed(1)}%
          </div>
          {totalAnnualLiquid > 0 && (
            <div className="mt-1">
              <div className={`text-xs sm:text-sm font-mono font-semibold truncate ${totalAnnualLiquid >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                {formatCurrency(totalAnnualLiquid)}/yr
              </div>
              {Object.entries(quoteBreakdown).map(([quote, amounts]) => (
                <div key={quote} className="text-xs text-white font-mono truncate">{formatCurrency(amounts.annual)} {quote}</div>
              ))}
              {Object.entries(annualAssetBreakdown).map(([asset, { qty, usd }]) => (
                <div key={asset} className="text-xs text-orange-400 font-mono truncate">
                  +{qty.toFixed(6)} {asset} ({formatCurrency(usd)})
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {unavailableCount > 0 && (
        <div className="text-sm text-amber-300 mb-4" role="status">{unavailableCount} {unavailableCount === 1 ? 'fund' : 'funds'} unavailable; excluded from totals.</div>
      )}

      {/* Active fund cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.filter(c => c.lifecycle !== 'closed').map(card => {
          if (card.statusUnavailable) {
            return (
              <div key={`${card.exchange}-${card.pair}`} className="bg-gray-800 rounded-lg border border-amber-700 p-4">
                <div className="flex items-center justify-between gap-3">
                  <Link to={`/${card.exchange}/${card.pair}`} className="text-white font-medium capitalize hover:opacity-80">
                    {card.exchange} / {card.pair}
                  </Link>
                  <span className="text-xs px-2 py-0.5 rounded-sm bg-amber-900/60 text-amber-200">Status unavailable</span>
                </div>
                <Button onClick={load} variant="primary" size="compact" className="mt-4">Retry</Button>
              </div>
            )
          }
          const engineStatus = getEngineStatus(card.isRunning, card.isDryRun, card.lifecycle)
          const regimeColor = REGIME_COLORS[card.regimeMode] || {}
          const healthColor = HEALTH_COLORS[card.healthMode]?.text || 'text-gray-400'

          return (
            <div
              key={`${card.exchange}-${card.pair}`}
              className="bg-gray-800 rounded-lg border border-gray-700 transition-colors p-4 block"
            >
              {/* Header: icon + name + pair + badges */}
              <Link to={`/${card.exchange}/${card.pair}`} className="flex items-center justify-between mb-3 hover:opacity-80 transition-opacity">
                <div className="flex items-center gap-2">
                  <span className={`w-7 h-7 flex items-center justify-center rounded-sm shrink-0 ${EXCHANGE_COLORS[card.exchange] || 'bg-gray-600'}`}>
                    {EXCHANGE_ICONS[card.exchange] || '?'}
                  </span>
                  <div>
                    <span className="font-medium capitalize text-white">{card.exchange}</span>
                    <span className="text-gray-400 mx-1">/</span>
                    <span className="text-sm text-gray-300">{card.pair}</span>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-sm ${engineStatus.color} ${engineStatus.textColor} ${engineStatus.pulse ? 'animate-pulse' : ''}`}>
                  {engineStatus.label}
                </span>
              </Link>

              {/* Status pills */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-xs px-2 py-0.5 rounded-sm bg-gray-700 ${healthColor}`}>
                  {card.healthMode}
                </span>
                {card.regimeMode && (
                  <span className={`text-xs px-2 py-0.5 rounded-sm ${regimeColor.bg || 'bg-gray-700'} ${regimeColor.text || 'text-gray-400'}`}>
                    {card.regimeMode}
                  </span>
                )}
              </div>

              {/* Celestial Visualization */}
              {card.celestial?.enabled && card.celestial?.bodies?.length > 0 && (
                <div className="pointer-events-none mb-3">
                  <Suspense fallback={<div className="bg-gray-900 rounded-sm p-2 text-xs text-gray-400">Loading...</div>}>
                    <CelestialVisualization
                      celestial={card.celestial}
                      currentPrice={card.lastPrice}
                      maxUsdcDeployed={card.maxUsdcDeployed}
                      baseCurrency={card.baseCurrency}
                    />
                  </Suspense>
                </div>
              )}

              {/* Live price */}
              <div className="mb-3">
                <div className="text-xs text-gray-400 mb-0.5">Price</div>
                <div className="text-lg font-bold font-mono text-white">
                  {card.lastPrice ? formatPrice(card.lastPrice) : '-'}
                </div>
              </div>

              {/* Position info */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm mb-3 min-w-0">
                <div className="min-w-0">
                  <div className="text-xs text-gray-400">Position</div>
                  <div className="text-gray-200 font-mono truncate">
                    {card.totalAssetQty > 0 ? `${card.totalAssetQty.toFixed(6)} ${card.baseCurrency}` : '-'}
                  </div>
                  {card.totalAssetCostBasis > 0 && (
                    <div className="text-xs text-gray-400 truncate">{formatCurrency(card.totalAssetCostBasis)} cost</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-gray-400">Unrealized P&L</div>
                  <div className={`font-mono truncate ${pnlColorClass(card.unrealizedPnL)}`}>
                    {card.totalCostBasis > 0
                      ? `${signedPrefix(card.unrealizedPnL)}${formatCurrency(card.unrealizedPnL)}`
                      : '-'}
                  </div>
                  {card.totalCostBasis > 0 && (
                    <div className={`text-xs ${card.unrealizedPct >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {signedPrefix(card.unrealizedPct)}{card.unrealizedPct.toFixed(2)}%
                    </div>
                  )}
                  {card.totalCostBasis > 0 && <div className="text-2xs text-gray-400">if sold now</div>}
                  {card.expectedCycleGain > 0 && (
                    <div className="text-2xs text-cyan-400 font-mono truncate">+{formatCurrency(card.expectedCycleGain)} at target</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-gray-400 truncate">Realized P&L {card.totalLiquidValuePercent ? `(${card.totalLiquidValuePercent.toFixed(2)}%)` : ''}</div>
                  <div className={`font-mono truncate ${pnlColorClass(card.totalLiquidValue ?? card.realizedUsdcPnL)}`}>
                    {card.totalLiquidValue !== undefined
                      ? `${signedPrefix(card.totalLiquidValue)}${formatCurrency(card.totalLiquidValue)}`
                      : card.realizedUsdcPnL !== 0
                        ? `${signedPrefix(card.realizedUsdcPnL)}${formatCurrency(card.realizedUsdcPnL)}`
                        : '-'}
                  </div>
                  <div className="text-xs text-white font-mono truncate">{formatCurrency(card.realizedUsdcPnL)} {card.quoteCurrency}</div>
                  {card.realizedAssetPnL > 0 && (
                    <div className="text-xs text-orange-400 truncate">+{card.realizedAssetPnL.toFixed(8)} {card.baseCurrency}</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-gray-400">Est. APY</div>
                  <div className={`font-mono ${pnlColorClass(card.estimatedApy)}`}>
                    {card.estimatedApy !== 0 ? `${card.estimatedApy.toFixed(1)}%` : '-'}
                  </div>
                </div>
              </div>

              {/* APY & Returns (matching RegimeDashboard) */}
              {(card.engineStartTime || card.isRunning) && (
                <div className="mb-3 pt-2 border-t border-gray-700 text-xs">
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-400 mb-2">
                    <span>Deposited: {formatCurrency(card.depositedCapital)}</span>
                    <span className="text-green-400">Max: {formatCurrency(card.maxUsdcDeployed)}</span>
                    <span className="text-cyan-400">Avail: {formatCurrency(card.availableCapital)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-400 mb-2">
                    <span>{card.elapsedDays.toFixed(1)}d running</span>
                    <span>{card.cyclesPerDay.toFixed(1)} cycles/day</span>
                    <span>Buys {card.cycleBuys}/{card.maxCycleBuys}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-green-900/20 border border-green-700/30 rounded-sm p-1.5 min-w-0 overflow-hidden">
                      <div className="text-green-400/70 text-2xs">Daily ({card.dailyReturnPercent.toFixed(2)}%)</div>
                      <div className="font-mono text-xs text-green-400 truncate">
                        {formatCurrency(card.estimatedDailyUsdc + (card.estimatedDailyAsset * card.lastPrice))}
                      </div>
                      <div className="text-white text-2xs font-mono truncate">{formatCurrency(card.estimatedDailyUsdc)} {card.quoteCurrency}</div>
                      {card.estimatedDailyAsset > 0 && (
                        <div className="text-orange-400 text-2xs font-mono truncate">
                          +{formatAsset(card.estimatedDailyAsset, card.baseCurrency)} ({formatCurrency(card.estimatedDailyAsset * card.lastPrice)})
                        </div>
                      )}
                    </div>
                    <div className="bg-cyan-900/20 border border-cyan-700/30 rounded-sm p-1.5 min-w-0 overflow-hidden">
                      <div className="text-cyan-400/70 text-2xs truncate">Annual ({card.estimatedApy > 9999 ? '>9999' : card.estimatedApy.toFixed(0)}% APY)</div>
                      <div className="font-mono text-xs text-cyan-400 truncate">
                        {formatCurrency((card.estimatedDailyUsdc * 365) + (card.estimatedDailyAsset * 365 * card.lastPrice))}/yr
                      </div>
                      <div className="text-white text-2xs font-mono truncate">{formatCurrency(card.estimatedDailyUsdc * 365)} {card.quoteCurrency}</div>
                      {card.estimatedDailyAsset > 0 && (
                        <div className="text-orange-400 text-2xs font-mono truncate">
                          +{(card.estimatedDailyAsset * 365).toFixed(6)} {card.baseCurrency} ({formatCurrency(card.estimatedDailyAsset * 365 * card.lastPrice)})
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Footer: cycles + celestial */}
              <div className="flex items-center justify-between text-xs text-gray-400 border-t border-gray-700 pt-2">
                <span>Cycles: {card.cyclesCompleted}</span>
                {card.bodiesActive > 0 && (
                  <span>{card.bodiesActive} active {card.tierSummary ? `(${card.tierSummary})` : ''}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Closed funds section */}
      {cards.some(c => c.lifecycle === 'closed') && (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Closed Funds</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cards.filter(c => c.lifecycle === 'closed').map(card => (
              <ClosedFundCard
                key={`${card.exchange}-${card.pair}`}
                card={card}
                icon={EXCHANGE_ICONS[card.exchange] || '?'}
                iconClass={EXCHANGE_COLORS[card.exchange] || 'bg-gray-600'}
              />
            ))}
          </div>
        </div>
      )}

      {cards.length === 0 && !exchangesError && (
        <div className="text-center text-gray-400 py-12">
          No exchanges configured. Add an exchange to get started.
        </div>
      )}
    </div>
  )
}

export default Overview
