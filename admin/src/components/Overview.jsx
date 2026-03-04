import { useState, useEffect, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { useMultiRegimeStatuses } from '../hooks/useTradeEvents'
import { getBaseCurrency, getQuoteCurrency } from '../App'
import { formatCurrency, formatPrice } from './charts/chartUtils'

const CelestialVisualization = lazy(() => import('./celestial/CelestialVisualization'))

const EXCHANGE_ICONS = {
  coinbase: '\u20bf',
  gemini: '\u264a',
  cryptocom: '\ud83d\udd37',
}

const EXCHANGE_COLORS = {
  coinbase: 'bg-blue-600',
  gemini: 'bg-cyan-600',
  cryptocom: 'bg-indigo-600',
}

const REGIME_COLORS = {
  HARVEST: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400' },
  CAUTION: { bg: 'bg-yellow-900/50', border: 'border-yellow-500', text: 'text-yellow-400' },
  TREND: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400' },
}

const HEALTH_COLORS = {
  ACTIVE: 'text-green-400',
  SAFE: 'text-yellow-400',
  PAUSED: 'text-gray-400',
  STOPPED: 'text-red-400',
}

const getEngineStatus = (isRunning, isDryRun) => {
  if (isRunning) {
    return isDryRun
      ? { label: 'Dry-Run', color: 'bg-purple-600', textColor: 'text-purple-100', pulse: true }
      : { label: 'Running', color: 'bg-green-600', textColor: 'text-green-100', pulse: true }
  }
  return { label: 'Stopped', color: 'bg-gray-600', textColor: 'text-gray-300' }
}

function Overview() {
  const [exchanges, setExchanges] = useState([])
  const [statusMap, setStatusMap] = useState({})
  const [loading, setLoading] = useState(true)
  const { statuses: wsStatuses, connected } = useMultiRegimeStatuses()

  // Fetch exchange list and initial statuses
  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/exchanges')
      if (!res.ok) { setLoading(false); return }
      const data = await res.json()
      const exchangeList = data.exchanges || []
      setExchanges(exchangeList)

      // Fetch regime status for each exchange in parallel
      const entries = await Promise.all(
        exchangeList.map(async (ex) => {
          const r = await fetch(`/api/${ex.name}/regime/status`)
          if (!r.ok) return [ex.name, null]
          const d = await r.json()
          return [ex.name, d.status || null]
        })
      )
      setStatusMap(Object.fromEntries(entries))
      setLoading(false)
    }
    load()
  }, [])

  // Merge WebSocket updates into status map
  useEffect(() => {
    if (Object.keys(wsStatuses).length === 0) return
    setStatusMap(prev => {
      const next = { ...prev }
      for (const [exchange, status] of Object.entries(wsStatuses)) {
        next[exchange] = status
      }
      return next
    })
  }, [wsStatuses])

  // Build card data from exchanges + statuses
  const cards = exchanges.map(ex => {
    const status = statusMap[ex.name]
    const pair = ex.productId || 'BTC-USDC'
    const baseCurrency = getBaseCurrency(pair)
    const quoteCurrency = getQuoteCurrency(pair)
    const position = status?.position
    const market = status?.market
    const apy = status?.apy
    const regime = status?.regime
    const health = status?.health
    const celestial = status?.celestial
    const isRunning = status?.isRunning ?? false
    const isDryRun = status?.isDryRun ?? false

    const coreAssetQty = position?.totalAssetQty ?? 0
    const coreCostBasis = position?.totalCostBasis ?? 0
    // Include celestial bodies in totals for display
    const bodiesCostBasis = (celestial?.bodies || []).reduce((sum, b) => sum + (b.costBasis || 0), 0)
    const bodiesAssetQty = (celestial?.bodies || []).reduce((sum, b) => sum + (b.assetQty || 0), 0)
    const totalAssetQty = coreAssetQty + bodiesAssetQty
    const totalCostBasis = coreCostBasis + bodiesCostBasis
    const lastPrice = market?.lastPrice ?? 0
    // Use server-computed unrealizedPnL (accounts for celestial bodies with assets on order)
    const unrealizedPnL = position?.unrealizedPnL ?? 0
    const unrealizedPct = totalCostBasis > 0 ? (unrealizedPnL / totalCostBasis) * 100 : 0
    const realizedPnL = position?.realizedPnL ?? celestial?.bodiesRealizedPnL ?? 0
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
    const realizedAssetPnL = position?.realizedAssetPnL ?? 0
    const engineStartTime = apy?.engineStartTime
    const cycleBuys = position?.cycleBuys ?? position?.ladderStep ?? 0
    const maxCycleBuys = status?.config?.maxCycleBuys ?? 10
    const cyclesCompleted = celestial?.bodiesCompleted ?? position?.cyclesCompleted ?? 0
    const bodiesActive = celestial?.bodiesActive ?? 0
    const tierSummary = celestial?.tierSummary || ''
    const regimeMode = regime?.mode || (status?.config?.regimeMode) || null
    const healthMode = health?.mode || 'STOPPED'

    return {
      exchange: ex.name,
      pair,
      baseCurrency,
      quoteCurrency,
      isRunning,
      isDryRun,
      healthMode,
      regimeMode,
      lastPrice,
      totalAssetQty,
      totalCostBasis,
      availableCapital,
      unrealizedPnL,
      unrealizedPct,
      realizedPnL,
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
      maxUsdcDeployed: status?.config?.maxUsdcDeployed ?? apy?.maxUsdcDeployed ?? 0,
    }
  })

  // Aggregate summary
  const totals = cards.reduce((acc, c) => ({
    deployed: acc.deployed + c.totalCostBasis,
    available: acc.available + c.availableCapital,
    unrealized: acc.unrealized + c.unrealizedPnL,
    realized: acc.realized + c.realizedPnL,
  }), { deployed: 0, available: 0, unrealized: 0, realized: 0 })

  // Weighted APY (by cost basis)
  const totalCostBasisAll = cards.reduce((sum, c) => sum + c.totalCostBasis, 0)
  const weightedApy = totalCostBasisAll > 0
    ? cards.reduce((sum, c) => sum + c.estimatedApy * c.totalCostBasis, 0) / totalCostBasisAll
    : 0

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div>
      {/* Aggregate summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-1">Capital</div>
          <div className="flex items-baseline gap-2">
            <div className="text-lg font-bold text-white">{formatCurrency(totals.deployed)}</div>
            <div className="text-xs text-gray-500">deployed</div>
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-sm text-cyan-400">{formatCurrency(totals.available)}</div>
            <div className="text-xs text-gray-500">available</div>
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-1">Unrealized P&L</div>
          <div className={`text-lg font-bold ${totals.unrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totals.unrealized >= 0 ? '+' : ''}{formatCurrency(totals.unrealized)}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-1">Realized P&L</div>
          <div className={`text-lg font-bold ${totals.realized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totals.realized >= 0 ? '+' : ''}{formatCurrency(totals.realized)}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-400 mb-1">Estimated APY</div>
          <div className={`text-lg font-bold ${weightedApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {weightedApy.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.map(card => {
          const engineStatus = getEngineStatus(card.isRunning, card.isDryRun)
          const regimeColor = REGIME_COLORS[card.regimeMode] || {}
          const healthColor = HEALTH_COLORS[card.healthMode] || 'text-gray-400'

          return (
            <Link
              key={`${card.exchange}-${card.pair}`}
              to={`/${card.exchange}/${card.pair}`}
              className="bg-gray-800 rounded-lg border border-gray-700 hover:border-gray-500 transition-colors p-4 block"
            >
              {/* Header: icon + name + pair + badges */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`w-7 h-7 flex items-center justify-center rounded shrink-0 ${EXCHANGE_COLORS[card.exchange] || 'bg-gray-600'}`}>
                    {EXCHANGE_ICONS[card.exchange] || '?'}
                  </span>
                  <div>
                    <span className="font-medium capitalize text-white">{card.exchange}</span>
                    <span className="text-gray-400 mx-1">/</span>
                    <span className="text-sm text-gray-300">{card.pair}</span>
                  </div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ${engineStatus.color} ${engineStatus.textColor} ${engineStatus.pulse ? 'animate-pulse' : ''}`}>
                  {engineStatus.label}
                </span>
              </div>

              {/* Status pills */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-xs px-2 py-0.5 rounded bg-gray-700 ${healthColor}`}>
                  {card.healthMode}
                </span>
                {card.regimeMode && (
                  <span className={`text-xs px-2 py-0.5 rounded ${regimeColor.bg || 'bg-gray-700'} ${regimeColor.text || 'text-gray-400'}`}>
                    {card.regimeMode}
                  </span>
                )}
              </div>

              {/* Celestial Visualization */}
              {card.celestial?.enabled && card.celestial?.bodies?.length > 0 && (
                <div className="pointer-events-none mb-3">
                  <Suspense fallback={<div className="bg-gray-900 rounded p-2 text-xs text-gray-500">Loading...</div>}>
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
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-3">
                <div>
                  <div className="text-xs text-gray-400">Position</div>
                  <div className="text-gray-200 font-mono">
                    {card.totalAssetQty > 0 ? `${card.totalAssetQty.toFixed(6)} ${card.baseCurrency}` : '-'}
                  </div>
                  {card.totalCostBasis > 0 && (
                    <div className="text-xs text-gray-500">{formatCurrency(card.totalCostBasis)} cost</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-400">Unrealized P&L</div>
                  <div className={`font-mono ${card.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {card.totalCostBasis > 0
                      ? `${card.unrealizedPnL >= 0 ? '+' : ''}${formatCurrency(card.unrealizedPnL)}`
                      : '-'}
                  </div>
                  {card.totalCostBasis > 0 && (
                    <div className={`text-xs ${card.unrealizedPct >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {card.unrealizedPct >= 0 ? '+' : ''}{card.unrealizedPct.toFixed(2)}%
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-400">Realized P&L {card.totalLiquidValuePercent ? `(${card.totalLiquidValuePercent.toFixed(2)}%)` : ''}</div>
                  <div className={`font-mono ${card.realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {card.realizedPnL !== 0
                      ? `${card.realizedPnL >= 0 ? '+' : ''}${formatCurrency(card.realizedPnL)}`
                      : '-'}
                  </div>
                  {card.realizedAssetPnL > 0 && (
                    <div className="text-xs text-orange-400">+{card.realizedAssetPnL.toFixed(8)} {card.baseCurrency}</div>
                  )}
                  {card.totalLiquidValue !== undefined && card.totalLiquidValue > 0 && (
                    <div className="text-xs text-cyan-400">= {formatCurrency(card.totalLiquidValue)}</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-400">Est. APY</div>
                  <div className={`font-mono ${card.estimatedApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {card.estimatedApy !== 0 ? `${card.estimatedApy.toFixed(1)}%` : '-'}
                  </div>
                </div>
              </div>

              {/* APY & Returns (matching RegimeDashboard) */}
              {(card.engineStartTime || card.isRunning) && (
                <div className="mb-3 pt-2 border-t border-gray-700 text-xs">
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-500 mb-2">
                    <span>Deposited: {formatCurrency(card.depositedCapital)}</span>
                    <span className="text-green-400">Max: {formatCurrency(card.maxUsdcDeployed)}</span>
                    <span className="text-cyan-400">Avail: {formatCurrency(card.availableCapital)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-500 mb-2">
                    <span>{card.elapsedDays.toFixed(1)}d running</span>
                    <span>{card.cyclesPerDay.toFixed(1)} cycles/day</span>
                    <span>Buys {card.cycleBuys}/{card.maxCycleBuys}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-green-900/20 border border-green-700/30 rounded p-1.5">
                      <div className="text-green-400/70 text-[10px]">Daily ({card.dailyReturnPercent.toFixed(2)}%)</div>
                      <div className="font-mono text-xs text-green-400">
                        ${card.estimatedDailyUsdc.toFixed(2)}
                        {card.estimatedDailyAsset > 0 && <span className="text-orange-400"> +{card.estimatedDailyAsset.toFixed(8)}</span>}
                      </div>
                    </div>
                    <div className="bg-cyan-900/20 border border-cyan-700/30 rounded p-1.5">
                      <div className="text-cyan-400/70 text-[10px]">Annual ({card.estimatedApy > 9999 ? '>9999' : card.estimatedApy.toFixed(0)}% APY)</div>
                      <div className="font-mono text-xs text-cyan-400">
                        ${(card.estimatedDailyUsdc * 365).toFixed(2)}
                        {card.estimatedDailyAsset > 0 && <span className="text-orange-400"> +{(card.estimatedDailyAsset * 365).toFixed(6)}</span>}
                      </div>
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
            </Link>
          )
        })}
      </div>

      {cards.length === 0 && (
        <div className="text-center text-gray-400 py-12">
          No exchanges configured. Add an exchange to get started.
        </div>
      )}
    </div>
  )
}

export default Overview
