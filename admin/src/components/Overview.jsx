import Button from './ui/Button'
import { memo, useState, useEffect, useEffectEvent, useCallback, useRef } from 'react'
import { Link } from '../lib/router'
import { ExternalLink } from './icons'
import { useMultiRegimeStatuses } from '../hooks/useTradeEvents'
import { getBaseCurrency, getQuoteCurrency } from '../utils/productId.mjs'
import { formatCurrency, formatPrice, formatAsset } from './charts/chartUtils'
import ClosedFundCard from './ClosedFundCard'
import { EXCHANGE_ICONS, EXCHANGE_COLORS } from './exchangeStyles'
import { REGIME_COLORS, HEALTH_COLORS } from './regime/regimeStyles'
import { apiGet } from '../utils/apiClient'
import { readRegimeStatus } from '../utils/readRegimeStatus'
import { pairQuery } from '../utils/api'
import { TIER_COLORS, TIER_EMOJIS, TIER_ORDER } from './celestial/celestialConstants'
import { pnlColorClass, signedPrefix } from '../utils/pnlFormat.mjs'
import { createFundStatusOwner, nextRegimeStatusSeq } from '../utils/regimeStatusSnapshot.mjs'

// The gateway lists each (exchange, pair) fund separately.
const fundKey = (ex) => `${ex.name}::${ex.pair || ex.productId || ex.name || 'default'}`

function CelestialPreview({ bodies }) {
  const counts = new Map()
  for (const { tier } of bodies) counts.set(tier, (counts.get(tier) ?? 0) + 1)
  return (
    <div className="mb-3 flex flex-wrap gap-2 rounded-sm bg-gray-900 p-2 text-xs text-gray-300" aria-label="Celestial bodies by tier">
      {TIER_ORDER.filter(tier => counts.has(tier)).map(tier => (
        <span key={tier} className="rounded-full border px-2 py-1" style={{ borderColor: TIER_COLORS[tier] }}>
          {TIER_EMOJIS[tier]} {tier.replace('_', ' ')} ×{counts.get(tier)}
        </span>
      ))}
    </div>
  )
}

const getEngineStatus = (isRunning, isDryRun, lifecycle, engineDown) => {
  if (lifecycle === 'closed') {
    return { label: 'Closed', color: 'bg-gray-700', textColor: 'text-gray-400' }
  }
  if (lifecycle === 'draining') {
    return { label: 'Draining', color: 'bg-yellow-700', textColor: 'text-yellow-200', pulse: true }
  }
  if (engineDown) {
    return { label: 'Unreachable', color: 'bg-orange-700', textColor: 'text-orange-200' }
  }
  if (isRunning) {
    return isDryRun
      ? { label: 'Dry-Run', color: 'bg-purple-600', textColor: 'text-purple-100', pulse: true }
      : { label: 'Running', color: 'bg-green-600', textColor: 'text-green-100', pulse: true }
  }
  return { label: 'Stopped', color: 'bg-gray-600', textColor: 'text-gray-300' }
}

function Overview({ funds, fundsLoaded, fundsError, refreshFunds, onAddFund }) {
  const [localExchanges, setLocalExchanges] = useState([])
  const exchanges = funds ?? localExchanges
  const [snapshotMap, setSnapshotMap] = useState({})
  const [exchangesError, setExchangesError] = useState(null)
  const [loading, setLoading] = useState(true)
  const loadOwnerRef = useRef(0)
  const abortControllerRef = useRef(null)

  const { snapshots: wsSnapshots, statuses: wsStatuses } = useMultiRegimeStatuses()
  const ownersRef = useRef(new Map())
  const fallbackStatusesRef = useRef(new Map())

  const getOrCreateOwner = useCallback((ex) => {
    const key = fundKey(ex)
    let owner = ownersRef.current.get(key)
    if (!owner) {
      const pairParam = ex.pair || ex.productId || ''
      owner = createFundStatusOwner({
        exchange: ex.name,
        pair: pairParam,
        onUpdate: (snap) => {
          setSnapshotMap(prev => {
            const current = prev[key]
            if (current && snap.seq < current.seq) return prev
            const state = snap.probeFailed ? 'error' : (snap.isStale ? 'stale' : 'ok')
            if (current?.status === snap.status && current.seq === snap.seq && current.state === state) return prev
            return { ...prev, [key]: { status: snap.status, seq: snap.seq, state } }
          })
        },
      })
      ownersRef.current.set(key, owner)
    }
    return owner
  }, [])

  const retryFund = useCallback((key) => ownersRef.current.get(key)?.retry(), [])

  // Render each fund as soon as its status settles. A slow engine only leaves
  // its own card pending and cannot hold up the other cards or their totals.
  const loadStatuses = useCallback((exchangeList) => {
    const loadId = ++loadOwnerRef.current
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    const activeKeys = new Set(exchangeList.map(fundKey))
    for (const [key, owner] of ownersRef.current.entries()) {
      if (!activeKeys.has(key)) {
        owner.dispose()
        ownersRef.current.delete(key)
        fallbackStatusesRef.current.delete(key)
      }
    }

    setSnapshotMap(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => activeKeys.has(key))))
    for (const ex of exchangeList) {
      const key = fundKey(ex)
      const owner = getOrCreateOwner(ex)
      const query = pairQuery(ex.pair || ex.productId)
      const url = `/api/${ex.name}/regime/status${query}`
      const fail = (seq) => {
        if (loadOwnerRef.current !== loadId) return
        setSnapshotMap(prev => {
          const current = prev[key]
          if (current && current.seq >= seq) return prev
          return { ...prev, [key]: { ...current, seq, state: 'error' } }
        })
      }
      const readSeq = nextRegimeStatusSeq()
      readRegimeStatus(url, { signal: controller.signal }).then(result => {
        if (loadOwnerRef.current !== loadId) return
        if (result.ok && result.data?.status) {
          owner.acceptSnapshot(result.data.status, result.seq, { isSocket: false })
        } else {
          fail(result.seq)
        }
      }).catch(() => fail(readSeq))
    }
  }, [getOrCreateOwner])

  const load = useCallback(async () => {
    if (refreshFunds) return refreshFunds()
    const loadId = ++loadOwnerRef.current
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const result = await apiGet('/api/exchanges', { signal: controller.signal })
      if (loadId !== loadOwnerRef.current) return
      if (!result.ok) throw new Error(`Exchange list request failed (HTTP ${result.status})`)
      setExchangesError(null)
      setLoading(false)
      const list = result.data.exchanges || []
      setLocalExchanges(list)
      loadStatuses(list)
    } catch (error) {
      if (loadId !== loadOwnerRef.current) return
      setExchangesError(error.message || 'Failed to load exchanges')
      setLoading(false)
    }
  }, [loadStatuses, refreshFunds])

  useEffect(() => {
    if (fundsLoaded) loadStatuses(funds)
  }, [funds, fundsLoaded, loadStatuses])

  const loadStandaloneOnMount = useEffectEvent(() => {
    if (!funds) load()
  })

  useEffect(() => {
    loadStandaloneOnMount()
    const owners = ownersRef.current
    const fallbackStatuses = fallbackStatusesRef.current
    return () => {
      loadOwnerRef.current += 1
      abortControllerRef.current?.abort()
      for (const owner of owners.values()) {
        owner.dispose()
      }
      owners.clear()
      fallbackStatuses.clear()
    }
  }, [])

  // Merge WebSocket updates into snapshot map. wsSnapshots is keyed by
  // `${exchange}::${pair}` with monotonic generations so each fund updates
  // independently and HTTP/socket ordering is strictly arbitrated (#1817).
  // Status owners also track freshness and silence timeouts (#1816).
  useEffect(() => {
    const hasSnapshots = wsSnapshots && Object.keys(wsSnapshots).length > 0
    const hasStatuses = wsStatuses && Object.keys(wsStatuses).length > 0
    if (!hasSnapshots && !hasStatuses) return

    if (hasSnapshots) {
      for (const [key, snap] of Object.entries(wsSnapshots)) {
        if (!snap?.status) continue
        let owner = ownersRef.current.get(key)
        if (!owner) {
          const ex = exchanges.find(e => fundKey(e) === key)
          if (ex) owner = getOrCreateOwner(ex)
        }
        if (owner) {
          owner.acceptSnapshot(snap.status, snap.seq, { isSocket: true })
        }
      }
    } else {
      // Fallback for tests or mocks providing only wsStatuses
      for (const [key, status] of Object.entries(wsStatuses)) {
        if (!status) continue
        if (fallbackStatusesRef.current.get(key) === status) continue
        let owner = ownersRef.current.get(key)
        if (!owner) {
          const ex = exchanges.find(e => fundKey(e) === key)
          if (ex) owner = getOrCreateOwner(ex)
        }
        if (owner) {
          owner.acceptSnapshot(status, nextRegimeStatusSeq(), { isSocket: true })
          fallbackStatusesRef.current.set(key, status)
        }
      }
    }
  }, [wsSnapshots, wsStatuses, exchanges, getOrCreateOwner])

  // Build card data from exchanges + statuses
  const cards = exchanges.map(ex => {
    const key = fundKey(ex)
    const status = snapshotMap[key]?.status
    const state = snapshotMap[key]?.state
    const hasSnapshot = Boolean(status)
    const isStale = Boolean(status?.market?.stale || status?.statusSilent || status?.probeFailed || state === 'stale' || (state === 'error' && hasSnapshot))
    const statusUnavailable = state === 'error' && !hasSnapshot
    const statusPending = !hasSnapshot && !statusUnavailable
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
    const engineDown = Boolean(status?.engineDown)
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
    const projectionReady = apy != null && (apy.projectionReady ?? elapsedDays >= 1)
    const estimatedDailyUsdc = apy?.estimatedDailyUsdc ?? 0
    const estimatedDailyAsset = apy?.estimatedDailyAsset ?? 0
    const totalLiquidValuePercent = depositedCapital > 0 ? 100 * realizedPnL / depositedCapital : null
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
      key,
      status,
      hasSnapshot,
      statusUnavailable,
      statusPending,
      stale: isStale,
      probeFailed: Boolean(status?.probeFailed || (state === 'error' && hasSnapshot)),
      baseCurrency,
      quoteCurrency,
      isRunning,
      isDryRun,
      engineDown,
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
      projectionReady,
      isApyClamped: Boolean(apy?.isApyClamped),
      estimatedDailyUsdc,
      estimatedDailyAsset,
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
  const availableCards = cards.filter(c => !c.statusPending && !c.statusUnavailable && !c.stale)
  const unavailableCount = cards.filter(c => c.statusUnavailable || c.stale).length
  const pendingCount = cards.filter(c => c.statusPending).length
  const closedCards = cards.filter(c => c.lifecycle === 'closed' && !c.statusPending && !c.statusUnavailable)
  const activeCards = cards.filter(c => c.lifecycle !== 'closed' || c.statusPending || c.statusUnavailable)
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
    if (c.realizedAssetPnL !== 0) {
      if (!acc[c.baseCurrency]) acc[c.baseCurrency] = { qty: 0, usd: 0 }
      acc[c.baseCurrency].qty += c.realizedAssetPnL
      acc[c.baseCurrency].usd += c.realizedAssetPnL * c.lastPrice
    }
    return acc
  }, {})

  const projectedCards = availableCards.filter(c => c.projectionReady && c.depositedCapital > 0)
  const projectedCapital = projectedCards.reduce((sum, c) => sum + c.depositedCapital, 0)
  const weightedApy = projectedCapital > 0
    ? projectedCards.reduce((sum, c) => sum + c.estimatedApy * c.depositedCapital, 0) / projectedCapital
    : null

  // Aggregate annual yield projections
  const totalAnnualUsdc = availableCards.reduce((sum, c) => sum + (c.estimatedDailyUsdc * 365), 0)
  const annualAssetBreakdown = availableCards.reduce((acc, c) => {
    if (c.estimatedDailyAsset !== 0) {
      const key = c.baseCurrency
      if (!acc[key]) acc[key] = { qty: 0, usd: 0 }
      acc[key].qty += c.estimatedDailyAsset * 365
      acc[key].usd += c.estimatedDailyAsset * 365 * c.lastPrice
    }
    return acc
  }, {})
  const totalAnnualAssetUsd = Object.values(annualAssetBreakdown).reduce((sum, a) => sum + a.usd, 0)
  const totalAnnualLiquid = totalAnnualUsdc + totalAnnualAssetUsd

  const listError = funds ? fundsError : exchangesError
  if (funds ? !fundsLoaded && !fundsError : loading) {
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
          onClick={onAddFund}
          variant="primary" size="compact" className="font-medium"
          title="Create a new trading fund on an existing exchange"
        >
          + Add Fund
        </Button>
      </div>

      {listError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-700 bg-red-900/20 p-4 mb-4 text-red-200">
          <span>Unable to load exchanges: {listError}</span>
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
          <div className="text-xs text-gray-400 mb-1">Total Realized (USD + Reserves)</div>
          <div className={`text-base sm:text-lg font-bold truncate ${pnlColorClass(totals.realized)}`}>
            {signedPrefix(totals.realized)}{formatCurrency(totals.realized)}
          </div>
          {Object.entries(quoteBreakdown).map(([quote, amounts]) => (
            <div key={quote} className="text-xs text-white font-mono truncate">{formatCurrency(amounts.realized)} {quote}</div>
          ))}
          {Object.entries(assetBreakdown).map(([asset, { qty, usd }]) => (
            <div key={asset} className="text-xs text-orange-400 font-mono truncate">{signedPrefix(qty)}{formatAsset(qty, asset)} ({formatCurrency(usd)})</div>
          ))}
        </div>
        <div className="bg-gray-800 rounded-lg p-3 sm:p-4 min-w-0 overflow-hidden">
          <div className="text-xs text-gray-400 mb-1">Deposit-weighted total-return APY</div>
          <div className={`text-base sm:text-lg font-bold ${pnlColorClass(weightedApy)}`}>
            {weightedApy == null ? '—' : `${weightedApy.toFixed(1)}%`}
          </div>
          {projectedCards.some(c => c.isApyClamped) && <div className="text-xs text-amber-300">Includes capped APY</div>}
          {totalAnnualLiquid !== 0 && (
            <div className="mt-1">
              <div className={`text-xs sm:text-sm font-mono font-semibold truncate ${totalAnnualLiquid >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                Realized run rate: {formatCurrency(totalAnnualLiquid)}/yr
              </div>
              {Object.entries(quoteBreakdown).map(([quote, amounts]) => (
                <div key={quote} className="text-xs text-white font-mono truncate">{formatCurrency(amounts.annual)} {quote}</div>
              ))}
              {Object.entries(annualAssetBreakdown).map(([asset, { qty, usd }]) => (
                <div key={asset} className="text-xs text-orange-400 font-mono truncate">
                  {signedPrefix(qty)}{qty.toFixed(6)} {asset} ({formatCurrency(usd)})
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {unavailableCount > 0 && (
        <div className="text-sm text-amber-300 mb-4" role="status">{unavailableCount} {unavailableCount === 1 ? 'fund' : 'funds'} unavailable; excluded from totals.</div>
      )}

      {pendingCount > 0 && (
        <div className="text-sm text-gray-400 mb-4" role="status">Waiting for {pendingCount} {pendingCount === 1 ? 'fund' : 'funds'} to report status. Totals reflect loaded funds.</div>
      )}

      {/* Active fund cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {activeCards.map(({ key, ...card }) => card.statusPending || card.statusUnavailable ? (
          <div key={key} className={`bg-gray-800 rounded-lg border ${card.statusUnavailable ? 'border-amber-700' : 'border-gray-700'} p-4`}>
            <div className="flex items-center justify-between gap-3">
              <Link to={`/${card.exchange}/${card.pair}`} className="text-white font-medium capitalize hover:opacity-80">
                {card.exchange} / {card.pair}
              </Link>
              <span className="text-xs text-gray-300" role="status">
                {card.statusUnavailable ? 'Status unavailable' : 'Loading status…'}
              </span>
            </div>
            {card.statusUnavailable && <Button onClick={load} variant="primary" size="compact" className="mt-4">Retry</Button>}
          </div>
        ) : <FundCard key={key} fundKey={key} retryFund={retryFund} {...card} />)}
      </div>

      {/* Closed funds section */}
      {closedCards.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-gray-400 mb-2">Closed Funds</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {closedCards.map(card => (
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

      {cards.length === 0 && !listError && (
        <div className="text-center text-gray-400 py-12">
          No exchanges configured. Add an exchange to get started.
        </div>
      )}
    </div>
  )
}

const FundCard = memo(function FundCard({ retryFund, ...card }) {
  const engineStatus = getEngineStatus(card.isRunning, card.isDryRun, card.lifecycle, card.engineDown)
  const regimeColor = REGIME_COLORS[card.regimeMode] || {}
  const healthColor = HEALTH_COLORS[card.healthMode]?.text || 'text-gray-400'

  return (
    <div className={`bg-gray-800 rounded-lg border ${card.stale ? 'border-amber-700/80' : 'border-gray-700'} transition-colors p-4 block`}>
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
        <div className="flex items-center gap-2">
          {card.stale && (
            <span className="text-xs px-2 py-0.5 rounded-sm bg-amber-900/60 text-amber-200">
              Status stale
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-sm ${engineStatus.color} ${engineStatus.textColor} ${engineStatus.pulse ? 'animate-pulse' : ''}`}>
            {engineStatus.label}
          </span>
        </div>
      </Link>

      {/* Stale retry banner */}
      {card.stale && (
        <div className="flex items-center justify-between bg-amber-950/40 border border-amber-700/50 rounded-sm px-2.5 py-1.5 mb-3 text-xs text-amber-200">
          <span>{card.probeFailed ? 'Status probe failed' : 'Showing last known data (stale)'}</span>
          <Button onClick={(e) => { e.preventDefault(); e.stopPropagation(); retryFund(card.fundKey); }} variant="primary" size="compact">Retry</Button>
        </div>
      )}

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

      {card.celestial?.enabled && card.celestial.bodies?.length > 0 && (
        <CelestialPreview bodies={card.celestial.bodies} />
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
            {card.totalAssetQty > 0 && card.lastPrice > 0
              ? `${signedPrefix(card.unrealizedPnL)}${formatCurrency(card.unrealizedPnL)}`
              : '-'}
          </div>
          {card.totalAssetQty > 0 && card.lastPrice > 0 && (
            <div className={`text-xs ${card.unrealizedPct >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {signedPrefix(card.unrealizedPct)}{card.unrealizedPct.toFixed(2)}%
            </div>
          )}
          {card.totalAssetQty > 0 && card.lastPrice > 0 && <div className="text-2xs text-gray-400">if sold now</div>}
          {card.expectedCycleGain > 0 && (
            <div className="text-2xs text-cyan-400 font-mono truncate">+{formatCurrency(card.expectedCycleGain)} at target</div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-gray-400 truncate">Total Realized (USD + Reserves) {card.totalLiquidValuePercent ? `(${card.totalLiquidValuePercent.toFixed(2)}%)` : ''}</div>
          <div className={`font-mono truncate ${pnlColorClass(card.realizedPnL)}`}>
            {signedPrefix(card.realizedPnL)}{formatCurrency(card.realizedPnL)}
          </div>
          <div className="text-xs text-white font-mono truncate">{formatCurrency(card.realizedUsdcPnL)} {card.quoteCurrency}</div>
          {card.realizedAssetPnL !== 0 && (
            <div className="text-xs text-orange-400 truncate">{signedPrefix(card.realizedAssetPnL)}{card.realizedAssetPnL.toFixed(8)} {card.baseCurrency}</div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Total-return APY</div>
          <div className={`font-mono ${pnlColorClass(card.estimatedApy)}`}>
            {card.projectionReady ? `${card.estimatedApy.toFixed(1)}%${card.isApyClamped ? ' (capped)' : ''}` : 'Awaiting 24h'}
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
          {card.projectionReady && <div className="grid grid-cols-2 gap-2">
            <div className="bg-green-900/20 border border-green-700/30 rounded-sm p-1.5 min-w-0 overflow-hidden">
              <div className="text-green-400/70 text-2xs">Daily realized run rate</div>
              <div className="font-mono text-xs text-green-400 truncate">
                {formatCurrency(card.estimatedDailyUsdc + (card.estimatedDailyAsset * card.lastPrice))}
              </div>
              <div className="text-white text-2xs font-mono truncate">{formatCurrency(card.estimatedDailyUsdc)} {card.quoteCurrency}</div>
              {card.estimatedDailyAsset !== 0 && (
                <div className="text-orange-400 text-2xs font-mono truncate">
                  {signedPrefix(card.estimatedDailyAsset)}{formatAsset(card.estimatedDailyAsset, card.baseCurrency)} ({formatCurrency(card.estimatedDailyAsset * card.lastPrice)})
                </div>
              )}
            </div>
            <div className="bg-cyan-900/20 border border-cyan-700/30 rounded-sm p-1.5 min-w-0 overflow-hidden">
              <div className="text-cyan-400/70 text-2xs truncate">Annual realized run rate</div>
              <div className="font-mono text-xs text-cyan-400 truncate">
                {formatCurrency((card.estimatedDailyUsdc * 365) + (card.estimatedDailyAsset * 365 * card.lastPrice))}/yr
              </div>
              <div className="text-white text-2xs font-mono truncate">{formatCurrency(card.estimatedDailyUsdc * 365)} {card.quoteCurrency}</div>
              {card.estimatedDailyAsset !== 0 && (
                <div className="text-orange-400 text-2xs font-mono truncate">
                  {signedPrefix(card.estimatedDailyAsset)}{(card.estimatedDailyAsset * 365).toFixed(6)} {card.baseCurrency} ({formatCurrency(card.estimatedDailyAsset * 365 * card.lastPrice)})
                </div>
              )}
            </div>
          </div>}
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
})

export default Overview
