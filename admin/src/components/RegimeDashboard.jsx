import { useState, useEffect, useCallback, useRef } from 'react'
import { useRegimeEvents, useTradeEvents } from '../hooks/useTradeEvents'
import { useChartDataBuffer } from '../hooks/useChartDataBuffer'
import RegimePriceChart from './charts/RegimePriceChart'
import VolatilityChart from './charts/VolatilityChart'
import RegimeTimeline from './charts/RegimeTimeline'

// Format duration in human readable form
const formatDuration = (ms) => {
  if (!ms || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

// Format countdown timer
const formatCountdown = (ms) => {
  if (!ms || ms <= 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

// Regime mode colors
const REGIME_COLORS = {
  HARVEST: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400', label: 'Harvest' },
  CAUTION: { bg: 'bg-yellow-900/50', border: 'border-yellow-500', text: 'text-yellow-400', label: 'Caution' },
  TREND: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400', label: 'Trend' },
}

// Health mode colors
const HEALTH_COLORS = {
  ACTIVE: { bg: 'bg-green-900/50', text: 'text-green-400', icon: '●' },
  SAFE: { bg: 'bg-yellow-900/50', text: 'text-yellow-400', icon: '◐' },
  PAUSED: { bg: 'bg-gray-700', text: 'text-gray-400', icon: '○' },
}

function StatCard({ label, value, subValue, color = 'text-white' }) {
  return (
    <div className="bg-gray-800 rounded-lg p-3">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      {subValue && <div className="text-xs text-gray-500">{subValue}</div>}
    </div>
  )
}

// Live price ticker with animation
function LivePriceTicker({ price, prevPrice }) {
  const direction = price > prevPrice ? 'up' : price < prevPrice ? 'down' : 'none'
  const directionColors = {
    up: 'text-green-400',
    down: 'text-red-400',
    none: 'text-white',
  }

  return (
    <div className="flex items-center gap-1">
      <span className={`text-lg font-bold font-mono transition-colors duration-300 ${directionColors[direction]}`}>
        ${price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '-'}
      </span>
      {direction !== 'none' && (
        <span className={`text-sm ${directionColors[direction]} animate-pulse`}>
          {direction === 'up' ? '▲' : '▼'}
        </span>
      )}
    </div>
  )
}

// Countdown/Timer display
function LiveTimer({ label, targetTime, elapsed, total, variant = 'countdown' }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  if (variant === 'countdown' && targetTime) {
    const remaining = Math.max(0, targetTime - now)
    const progress = total ? Math.min(100, ((total - remaining) / total) * 100) : 0

    return (
      <div className="bg-gray-900 rounded p-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
        <div className="flex items-center gap-1">
          <span className="text-sm font-mono text-cyan-400">{formatCountdown(remaining)}</span>
          {remaining === 0 && <span className="text-[10px] text-yellow-400 animate-pulse">Ready</span>}
        </div>
        {total && (
          <div className="h-0.5 bg-gray-700 rounded-full mt-1 overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all duration-1000"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  if (variant === 'elapsed' && elapsed !== undefined) {
    const elapsedMs = now - elapsed
    return (
      <div className="bg-gray-900 rounded p-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
        <span className="text-sm font-mono text-gray-300">{formatDuration(elapsedMs)}</span>
      </div>
    )
  }

  return null
}

// Trigger distance indicator
function TriggerDistance({ currentPrice, anchorPrice, atr, kFactor }) {
  if (!currentPrice || !atr || atr === 0) return null

  const triggerDistance = kFactor * atr
  const priceMove = anchorPrice ? Math.abs(currentPrice - anchorPrice) : 0
  const progress = anchorPrice ? Math.min(100, (priceMove / triggerDistance) * 100) : 0
  const distanceToTrigger = Math.max(0, triggerDistance - priceMove)

  return (
    <div className="bg-gray-900 rounded p-1.5">
      <div className="text-[10px] text-gray-500 mb-0.5">ATR Trigger Distance</div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">
          ${distanceToTrigger.toFixed(2)} to go
        </span>
        <span className="text-[10px] text-gray-500">
          ({progress.toFixed(0)}%)
        </span>
      </div>
      <div className="h-1 bg-gray-700 rounded-full mt-0.5 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            progress >= 100 ? 'bg-green-500 animate-pulse' : progress >= 75 ? 'bg-yellow-500' : 'bg-blue-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
        <span>Anchor: ${anchorPrice?.toFixed(2) || '-'}</span>
        <span>Target: ±${triggerDistance.toFixed(2)}</span>
      </div>
    </div>
  )
}

// Data freshness indicator
function DataFreshness({ lastUpdate }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  if (!lastUpdate) return null

  const age = now - lastUpdate
  const isStale = age > 30000
  const isWarning = age > 10000

  return (
    <div className={`flex items-center gap-1 text-xs ${isStale ? 'text-red-400' : isWarning ? 'text-yellow-400' : 'text-green-400'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isStale ? 'bg-red-400' : isWarning ? 'bg-yellow-400' : 'bg-green-400 animate-pulse'}`} />
      <span>{age < 1000 ? 'Live' : `${(age / 1000).toFixed(0)}s ago`}</span>
    </div>
  )
}

function RegimeDashboard({ exchange = 'coinbase' }) {
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [liveFills, setLiveFills] = useState([])
  const [showAllCycles, setShowAllCycles] = useState(false)
  const [recalculating, setRecalculating] = useState(false)
  const [recalcPreview, setRecalcPreview] = useState(null)
  const prevPriceRef = useRef(null)

  const { connected, status: socketStatus, regimeState, healthState, positionState, events: regimeEvents, clearEvents } = useRegimeEvents(exchange)
  const { events: tradeEvents } = useTradeEvents(exchange)

  // Use socket status when available, fall back to local status (for initial load / when engine stopped)
  const status = socketStatus || localStatus

  // Chart data buffering
  const { priceHistory, atrHistory, regimeHistory } = useChartDataBuffer(status)

  // Track previous price for animation
  useEffect(() => {
    if (status?.market?.lastPrice) {
      prevPriceRef.current = status.market.lastPrice
    }
  }, [status?.market?.lastPrice])

  // Combine and filter regime-related trade events
  const allEvents = [...regimeEvents, ...tradeEvents.filter(e =>
    ['regime_change', 'entry_placed', 'entry_filled', 'tp_placed', 'tp_filled', 'tp_adjusted', 'flash_move', 'safe_mode', 'active_mode'].includes(e.type)
  )].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 30)

  // Fetch status (only used for initial load and when engine is stopped)
  const fetchStatus = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/status`)
    if (res.ok) {
      const data = await res.json()
      setLocalStatus(data.status)
      setError(null)
    }
  }, [exchange])

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/config`)
    if (res.ok) {
      const data = await res.json()
      setConfig(data.config)
    }
  }, [exchange])

  // Fetch live fills from fill ledger
  const fetchFills = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/fills`)
    if (res.ok) {
      const data = await res.json()
      setLiveFills(data.fills || [])
    }
  }, [exchange])

  // Initial load only - no polling needed, socket provides live updates
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([fetchStatus(), fetchConfig(), fetchFills()])
      setLoading(false)
    }
    load()
  }, [exchange, fetchStatus, fetchConfig, fetchFills])

  // Resume from drawdown pause
  const handleResumeDrawdown = async () => {
    if (!confirm('Resume trading from drawdown pause? This will reset the peak equity to current levels.')) return
    const res = await fetch(`/api/${exchange}/regime/resume-drawdown`, { method: 'POST' })
    if (res.ok) await fetchStatus()
  }

  // Force regime
  const handleForceRegime = async (regime) => {
    const res = await fetch(`/api/${exchange}/regime/force-regime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regime, reason: 'Manual override from UI' }),
    })
    if (res.ok) await fetchStatus()
  }

  // Preview recalculate
  const handleRecalculatePreview = async () => {
    setRecalculating(true)
    const res = await fetch(`/api/${exchange}/regime/recalculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply: false }),
    })
    const data = await res.json()
    if (data.success) {
      setRecalcPreview(data)
    }
    setRecalculating(false)
  }

  // Apply recalculate
  const handleRecalculateApply = async () => {
    setRecalculating(true)
    const res = await fetch(`/api/${exchange}/regime/recalculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    })
    const data = await res.json()
    if (data.success) {
      setRecalcPreview(null)
      await fetchStatus()
    }
    setRecalculating(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime engine status...</div>
      </div>
    )
  }

  const isRunning = status?.isRunning
  const isDryRun = status?.isDryRun || config?.dryRun
  const market = status?.market || {}
  const position = status?.position || {}
  const regime = status?.regime || {}
  const health = status?.health || {}
  const risk = status?.risk || {}
  const dryRunState = status?.dryRun || {}
  // Use pendingOrders from dryRunState for dry-run, from status for live
  const pendingOrdersList = isDryRun ? (dryRunState?.pendingOrders || []) : (status?.pendingOrders || [])

  const regimeStyle = REGIME_COLORS[regime.mode] || REGIME_COLORS.HARVEST
  const healthStyle = HEALTH_COLORS[health.mode] || HEALTH_COLORS.ACTIVE
  const apy = status?.apy || {}
  const tpOptimizer = status?.tpOptimizer || {}

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-200 text-sm">
          {error}
        </div>
      )}

      {isRunning ? (
        <>
          {/* Live Status Bar */}
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {/* Live Price */}
              <div className="col-span-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">BTC Price</span>
                  <DataFreshness lastUpdate={market.lastUpdate} />
                </div>
                <LivePriceTicker
                  price={market.lastPrice}
                  prevPrice={prevPriceRef.current}
                />
                <div className="text-xs text-gray-500 mt-1">
                  Spread: ${market.spread?.toFixed(2) || '-'} ({market.spread && market.lastPrice ? ((market.spread / market.lastPrice) * 10000).toFixed(1) : '-'} bps)
                </div>
              </div>

              {/* Time Since Last Entry */}
              <div className="col-span-1">
                <LiveTimer
                  label="Since Last Entry"
                  elapsed={position.lastEntryTime}
                  variant="elapsed"
                />
              </div>

              {/* Countdown to Max Interval */}
              <div className="col-span-1">
                <LiveTimer
                  label="Max Interval Timer"
                  targetTime={position.lastEntryTime ? position.lastEntryTime + (config?.maxIntervalMs || 3600000) : null}
                  total={config?.maxIntervalMs || 3600000}
                  variant="countdown"
                />
              </div>

              {/* ATR Trigger Distance */}
              <div className="col-span-1">
                <TriggerDistance
                  currentPrice={market.lastPrice}
                  anchorPrice={position.anchorPrice}
                  atr={market.atr1m}
                  kFactor={config?.kFactor || 0.6}
                />
              </div>

              {/* Entry Status */}
              <div className="col-span-1">
                <div className="bg-gray-900 rounded p-1.5 h-full">
                  <div className="text-[10px] text-gray-500 mb-0.5">Entry Status</div>
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${health.mode === 'ACTIVE' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                      <span className="text-xs">{health.mode === 'ACTIVE' ? 'Ready' : health.mode}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${regime.mode === 'TREND' ? 'bg-red-400' : 'bg-green-400'}`} />
                      <span className="text-xs text-gray-400">
                        {regime.mode === 'TREND' ? 'Entries blocked' : 'Entries allowed'}
                      </span>
                    </div>
                    {status?.orders && (
                      <div className="text-[10px] text-gray-500">
                        Open: {status.orders.entries || 0} entry, {status.orders.takeProfits || 0} TP
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Left Column: Regime, Volatility & Risk */}
          <div className="space-y-4">
            {/* Regime Status */}
            <div className={`${regimeStyle.bg} border ${regimeStyle.border} rounded-lg p-4`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-400">Current Regime</h3>
                <span className={`${healthStyle.bg} ${healthStyle.text} px-2 py-0.5 rounded text-xs`}>
                  {healthStyle.icon} {health.mode || 'ACTIVE'}
                </span>
              </div>
              <div className={`text-3xl font-bold ${regimeStyle.text} mb-2`}>
                {regime.mode || 'HARVEST'}
              </div>
              <div className="text-xs text-gray-400">
                Since {regime.since ? new Date(regime.since).toLocaleTimeString() : '-'}
              </div>
              <div className="flex gap-1 mt-3">
                {['HARVEST', 'CAUTION', 'TREND'].map((r) => (
                  <button
                    key={r}
                    onClick={() => handleForceRegime(r)}
                    disabled={regime.mode === r}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      regime.mode === r
                        ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                        : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Volatility Metrics */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Volatility Metrics</h3>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">ATR (1m)</span>
                  <span className="text-white font-mono">${market.atr1m?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">ATR (5m)</span>
                  <span className="text-white font-mono">${market.atr5m?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">VWAP</span>
                  <span className="text-white font-mono">${market.vwap?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">VWAP Distance</span>
                  <span className={`font-mono ${
                    Math.abs(market.vwapDistance || 0) > 1 ? 'text-yellow-400' : 'text-white'
                  }`}>
                    {market.vwapDistance?.toFixed(2) || '-'} ATR
                  </span>
                </div>
                <div className="border-t border-gray-700 my-2" />
                <div className="flex justify-between">
                  <span className="text-gray-400">Realized Vol</span>
                  <span className="text-white font-mono">{market.realizedVol?.toFixed(2) || '-'}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Vol Baseline</span>
                  <span className="text-white font-mono">{market.volBaseline?.toFixed(2) || '-'}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Vol Expansion</span>
                  <span className={`font-mono ${
                    (market.realizedVol / market.volBaseline) > 1.5 ? 'text-yellow-400' : 'text-white'
                  }`}>
                    {market.volBaseline ? (market.realizedVol / market.volBaseline).toFixed(2) : '-'}x
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Middle Column: Position, Risk & Timeline */}
          <div className="space-y-4">
            {/* Position */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Position</h3>
                <div className="flex items-center gap-2">
                  {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
                  <span className="text-xs text-gray-500">Step {position.ladderStep || 0}/{config?.maxLadderSteps || 10}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-gray-500">BTC Held</div>
                  <div className="text-orange-400 font-mono">{position.totalBTC?.toFixed(8) || '0'}</div>
                </div>
                <div>
                  <div className="text-gray-500">On Order</div>
                  <div className="text-yellow-400 font-mono">{(isDryRun && dryRunState?.pnl?.btcOnOrder ? dryRunState.pnl.btcOnOrder : position.btcOnOrder || 0).toFixed(8)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Reserves</div>
                  <div className="text-cyan-400 font-mono">{(position.realizedBtcPnL || 0).toFixed(8)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Cost Basis</div>
                  <div className="text-white font-mono">${position.totalCostBasis?.toFixed(2) || '0'}</div>
                </div>
                <div>
                  <div className="text-gray-500">Avg Cost</div>
                  <div className="text-white font-mono">${position.avgCostBasis?.toFixed(2) || '0'}</div>
                </div>
                <div>
                  <div className="text-gray-500">Cycles</div>
                  <div className="text-white font-mono">{position.cyclesCompleted || 0}</div>
                </div>
              </div>
              <div className="mt-2 pt-2 border-t border-gray-700 grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-900/50 rounded p-2">
                  <div className="text-gray-500">Unrealized P&L</div>
                  <div className={`font-mono text-base ${position.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${position.unrealizedPnL?.toFixed(2) || '0'}
                  </div>
                </div>
                <div className="bg-gray-900/50 rounded p-2">
                  <div className="text-gray-500">Realized P&L</div>
                  <div className={`font-mono text-base ${position.realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${position.realizedPnL?.toFixed(2) || '0'}
                    {(position.realizedBtcPnL || 0) > 0 && <span className="text-cyan-400 text-xs ml-1">+{position.realizedBtcPnL?.toFixed(8)} BTC</span>}
                  </div>
                </div>
              </div>
              
              {/* Recalculate Preview Modal */}
              {recalcPreview && (
                <div className="mt-3 p-3 bg-gray-900 rounded border border-yellow-600/50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-yellow-400">Recalculate Preview</span>
                    <button
                      onClick={() => setRecalcPreview(null)}
                      className="text-gray-400 hover:text-white"
                    >
                      ×
                    </button>
                  </div>

                  {recalcPreview.orphansFixed > 0 && (
                    <div className="text-xs text-blue-400 mb-2">
                      Will fix {recalcPreview.orphansFixed} fills with missing cycle ID
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                    <div className="text-gray-400">Field</div>
                    <div className="text-gray-400">Before</div>
                    <div className="text-gray-400">After</div>

                    <div className="text-gray-300">Cycles</div>
                    <div className="text-gray-500">{recalcPreview.changes?.cyclesCompleted?.before}</div>
                    <div className={recalcPreview.changes?.cyclesCompleted?.before !== recalcPreview.changes?.cyclesCompleted?.after ? 'text-yellow-400' : 'text-gray-500'}>
                      {recalcPreview.changes?.cyclesCompleted?.after}
                    </div>

                    <div className="text-gray-300">P&L</div>
                    <div className="text-gray-500">${recalcPreview.changes?.realizedPnL?.before?.toFixed(2)}</div>
                    <div className={recalcPreview.changes?.realizedPnL?.before !== recalcPreview.changes?.realizedPnL?.after ? 'text-yellow-400' : 'text-gray-500'}>
                      ${recalcPreview.changes?.realizedPnL?.after?.toFixed(2)}
                    </div>

                    <div className="text-gray-300">BTC Reserves</div>
                    <div className="text-gray-500">{recalcPreview.changes?.realizedBtcPnL?.before?.toFixed(8)}</div>
                    <div className={recalcPreview.changes?.realizedBtcPnL?.before !== recalcPreview.changes?.realizedBtcPnL?.after ? 'text-cyan-400' : 'text-gray-500'}>
                      {recalcPreview.changes?.realizedBtcPnL?.after?.toFixed(8)}
                    </div>

                    <div className="text-gray-300">Ladder Step</div>
                    <div className="text-gray-500">{recalcPreview.changes?.ladderStep?.before}</div>
                    <div className={recalcPreview.changes?.ladderStep?.before !== recalcPreview.changes?.ladderStep?.after ? 'text-yellow-400' : 'text-gray-500'}>
                      {recalcPreview.changes?.ladderStep?.after}
                    </div>
                  </div>

                  {recalcPreview.cycleDetails?.length > 0 && (
                    <div className="mb-3">
                      <div className="text-xs text-gray-400 mb-1">Completed Cycles:</div>
                      {recalcPreview.cycleDetails.map((cycle, i) => (
                        <div key={i} className="text-xs text-gray-500 pl-2">
                          {cycle.cycleId?.slice(0, 20)}... - {cycle.buys} buys, P&L: ${cycle.pnl?.toFixed(2)}, holdback: {cycle.holdbackBtc?.toFixed(8)} BTC
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={handleRecalculateApply}
                      disabled={recalculating}
                      className="flex-1 text-xs px-3 py-1.5 rounded bg-yellow-600 hover:bg-yellow-500 text-white disabled:opacity-50"
                    >
                      {recalculating ? 'Applying...' : 'Apply Changes'}
                    </button>
                    <button
                      onClick={() => setRecalcPreview(null)}
                      className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* APY & Returns Section */}
              {apy.engineStartTime && (
                <div className="mt-2 pt-2 border-t border-gray-700 text-xs">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-500 mb-2">
                    <span>Capital: ${apy.initialCapital?.toLocaleString()}</span>
                    <span>Running: {apy.elapsedDays?.toFixed(1)}d</span>
                    <span>{apy.cyclesPerDay?.toFixed(1)} cycles/day</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="bg-gray-900/50 rounded p-1.5">
                      <div className="text-gray-500 text-[10px]">Return</div>
                      <div className={`font-mono ${(apy.totalLiquidValue || 0) >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                        ${(apy.totalLiquidValue || 0).toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-gray-900/50 rounded p-1.5">
                      <div className="text-gray-500 text-[10px]">Daily</div>
                      <div className={`font-mono ${(apy.dailyReturnPercent || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {(apy.dailyReturnPercent || 0).toFixed(2)}%
                      </div>
                    </div>
                    <div className="bg-green-900/20 border border-green-700/30 rounded p-1.5">
                      <div className="text-green-400/70 text-[10px]">Annual</div>
                      <div className={`font-mono ${(apy.estimatedAnnualReturn || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {(apy.estimatedAnnualReturn || 0) > 9999 ? '>9999' : (apy.estimatedAnnualReturn || 0).toFixed(0)}%
                      </div>
                    </div>
                    <div className="bg-cyan-900/20 border border-cyan-700/30 rounded p-1.5">
                      <div className="text-cyan-400/70 text-[10px]">APY</div>
                      <div className={`font-mono ${(apy.estimatedApy || 0) >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                        {(apy.estimatedApy || 0) > 9999 ? '>9999' : (apy.estimatedApy || 0).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {isDryRun && dryRunState?.pnl && (
                <div className="mt-3 pt-3 border-t border-gray-700 text-xs">
                  <div className="text-purple-400 mb-1">Dry-Run Stats</div>
                  <div className="grid grid-cols-2 gap-2 text-gray-400">
                    <div>Simulated Buys: {dryRunState.pnl.totalBought?.toFixed(8) || 0} BTC</div>
                    <div>Simulated Sells: {dryRunState.pnl.totalSold?.toFixed(8) || 0} BTC</div>
                    <div>BTC on Order: <span className="text-yellow-400">{dryRunState.pnl.btcOnOrder?.toFixed(8) || 0}</span></div>
                    <div>BTC Reserves: <span className="text-cyan-400">{position.realizedBtcPnL?.toFixed(8) || 0}</span></div>
                    <div>Filled Orders: {dryRunState.pnl.filledOrderCount || 0}</div>
                    <div>Avg Entry: ${dryRunState.pnl.avgEntryPrice?.toFixed(2) || 0}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Risk Limits */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Risk Limits</h3>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">BTC Exposure</span>
                    <span className="text-white">
                      {position.totalBTC?.toFixed(4) || 0} / {config?.maxBtcExposure || 0.5}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-orange-500 transition-all"
                      style={{ width: `${Math.min(100, ((position.totalBTC || 0) / (config?.maxBtcExposure || 0.5)) * 100)}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">USDC Deployed</span>
                    <span className="text-white">
                      ${position.totalCostBasis?.toFixed(0) || 0} / ${config?.maxUsdcDeployed || 10000}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${Math.min(100, ((position.totalCostBasis || 0) / (config?.maxUsdcDeployed || 10000)) * 100)}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">Max Drawdown</span>
                    <span className={position.maxDrawdownSeen > config?.maxDrawdownPercent * 0.8 ? 'text-yellow-400' : 'text-white'}>
                      {position.maxDrawdownSeen?.toFixed(1) || 0}% / {config?.maxDrawdownPercent || 20}%
                    </span>
                  </div>
                  <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-red-500 transition-all"
                      style={{ width: `${Math.min(100, ((position.maxDrawdownSeen || 0) / (config?.maxDrawdownPercent || 20)) * 100)}%` }}
                    />
                  </div>
                </div>
                {/* Drawdown Pause Warning */}
                {risk.isDrawdownPaused && (
                  <div className="mt-3 p-3 bg-red-900/30 border border-red-500/50 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-red-400 font-medium text-sm flex items-center gap-2">
                          <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
                          Entries Paused (Drawdown Limit)
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          Paused for {risk.drawdownPausedHours?.toFixed(1) || 0}h
                          {risk.drawdownResetHours > 0 && (
                            <span className="ml-2">
                              (auto-reset in {Math.max(0, risk.drawdownResetHours - (risk.drawdownPausedHours || 0)).toFixed(1)}h)
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={handleResumeDrawdown}
                        className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded transition-colors"
                      >
                        Resume Trading
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Regime Timeline */}
            <RegimeTimeline
              data={regimeHistory}
              currentRegime={regime}
              height={80}
            />
          </div>

          {/* Right Column: Charts */}
          <div className="space-y-4">
            <RegimePriceChart
              priceData={priceHistory}
              regimeData={regimeHistory}
              currentPrice={market.lastPrice}
              anchorPrice={position.anchorPrice}
              atr={market.atr1m}
              kFactor={config?.kFactor || 0.6}
              height={280}
            />
            <VolatilityChart
              atrData={atrHistory}
              regimeData={regimeHistory}
              height={240}
            />
          </div>
        </div>

        {/* Orders Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
          {/* Open Orders */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Open Orders</h3>
              {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
            </div>
            {pendingOrdersList.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">No open orders</div>
            ) : (
              <div className="overflow-x-auto">
                {(() => {
                  const openOrders = pendingOrdersList.filter(o => o.status === 'open')
                  const avgCost = position.avgCostBasis || 0
                  const holdbackRatio = config?.holdbackRatio ?? 0.5

                  const ordersWithCalcs = openOrders.map(order => {
                    const age = Date.now() - order.placedAt
                    const estPnl = order.type === 'take_profit' && avgCost > 0
                      ? (order.price - avgCost) * order.size
                      : null
                    const profitPerBTC = order.price - avgCost
                    const denominator = order.price * (1 - holdbackRatio) + avgCost * holdbackRatio
                    const estHoldback = order.type === 'take_profit' && profitPerBTC > 0 && denominator > 0
                      ? order.size * profitPerBTC * holdbackRatio / denominator
                      : null
                    const estHoldbackValue = estHoldback ? estHoldback * order.price : null

                    return { ...order, age, estPnl, estHoldback, estHoldbackValue }
                  })

                  return (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-400 text-xs border-b border-gray-700">
                          <th className="text-left py-2 pr-2">Type</th>
                          <th className="text-left py-2 pr-2">Side</th>
                          <th className="text-right py-2 pr-2">Size (BTC)</th>
                          <th className="text-right py-2 pr-2">Price</th>
                          <th className="text-right py-2 pr-2">Est. P&L</th>
                          <th className="text-right py-2 pr-2">Holdback</th>
                          <th className="text-right py-2">Age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersWithCalcs.map((order) => (
                          <tr key={order.orderId} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="py-2 pr-2">
                              <span className={`px-1.5 py-0.5 rounded text-xs ${
                                order.type === 'entry' ? 'bg-blue-900/50 text-blue-400' : 'bg-cyan-900/50 text-cyan-400'
                              }`}>
                                {order.type === 'entry' ? 'Entry' : 'TP'}
                              </span>
                            </td>
                            <td className={`py-2 pr-2 ${order.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
                              {order.side?.toUpperCase()}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-white">
                              {order.size?.toFixed(8)}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-white">
                              ${order.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className={`text-right py-2 pr-2 font-mono text-xs ${order.estPnl !== null ? (order.estPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                              {order.estPnl !== null ? `${order.estPnl >= 0 ? '+' : ''}$${order.estPnl.toFixed(2)}` : '—'}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                              {order.estHoldback !== null ? (
                                <span title={`≈$${order.estHoldbackValue?.toFixed(2)}`}>+{order.estHoldback.toFixed(8)}</span>
                              ) : '—'}
                            </td>
                            <td className="text-right py-2 font-mono text-gray-500 text-xs">
                              {formatDuration(order.age)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                })()}
              </div>
            )}
          </div>

          {/* Filled Orders */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Filled Orders</h3>
              <div className="flex items-center gap-3">
                {!isDryRun && liveFills?.length > 0 && (
                  <button
                    onClick={() => setShowAllCycles(!showAllCycles)}
                    className={`text-xs px-2 py-1 rounded transition-colors ${
                      showAllCycles
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {showAllCycles ? 'All Cycles' : 'Current Cycle'}
                  </button>
                )}
                {((isDryRun && dryRunState?.filledOrders?.length > 0) || (!isDryRun && liveFills?.length > 0)) && (
                  <span className="text-xs text-gray-500">
                    {isDryRun
                      ? dryRunState.filledOrders.length
                      : (showAllCycles
                          ? liveFills.length
                          : liveFills.filter(f => !f.cycleId || f.cycleId.startsWith('cycle-') === false).length
                        )
                    } fills
                  </span>
                )}
              </div>
            </div>
            {(isDryRun
              ? (dryRunState?.filledOrders?.length || 0)
              : (showAllCycles
                  ? liveFills?.length
                  : liveFills?.filter(f => !f.cycleId || !f.cycleId.startsWith('cycle-')).length
                ) || 0
            ) === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">
                {!isDryRun && liveFills?.length > 0 && !showAllCycles
                  ? 'No fills in current cycle (toggle to see all cycles)'
                  : 'No filled orders yet'
                }
              </div>
            ) : isDryRun ? (
              /* Dry Run Mode - Split Buy/Sell Tables */
              <div className="space-y-3">
                {(() => {
                  const allOrders = [...dryRunState.filledOrders].reverse().slice(0, 40)
                  const buyOrders = allOrders.filter(o => o.side === 'buy')
                  const sellOrders = allOrders.filter(o => o.side === 'sell')

                  // Calculate buy totals
                  let totalBuySize = 0
                  let totalBuyValue = 0
                  buyOrders.forEach(order => {
                    totalBuySize += order.size || 0
                    totalBuyValue += (order.size || 0) * (order.fillPrice || 0)
                  })

                  return (
                    <>
                      {/* Buys Table */}
                      <div>
                        <div className="text-xs text-green-400 mb-1 font-medium">Buys ({buyOrders.length})</div>
                        <div className="overflow-x-auto max-h-32 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">Value</th>
                                <th className="text-right py-1.5">Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {buyOrders.length > 1 && (
                                <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {totalBuySize.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 text-gray-400 text-xs">
                                    avg ${totalBuySize > 0 ? (totalBuyValue / totalBuySize).toFixed(2) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${totalBuyValue.toFixed(2)}
                                  </td>
                                  <td className="text-right py-1.5 text-gray-400 text-xs">Totals</td>
                                </tr>
                              )}
                              {buyOrders.map((order, idx) => (
                                <tr key={`buy-${order.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {order.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${order.fillPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-400 text-xs">
                                    ${((order.size || 0) * (order.fillPrice || 0)).toFixed(2)}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {order.filledAt ? new Date(order.filledAt).toLocaleTimeString() : '-'}
                                  </td>
                                </tr>
                              ))}
                              {buyOrders.length === 0 && (
                                <tr><td colSpan={4} className="text-center py-2 text-gray-500 text-xs">No buys yet</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Sells Table */}
                      <div>
                        <div className="text-xs text-red-400 mb-1 font-medium">Sells ({sellOrders.length})</div>
                        <div className="overflow-x-auto max-h-32 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">P&L</th>
                                <th className="text-right py-1.5 pr-2">Holdback</th>
                                <th className="text-right py-1.5">Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sellOrders.map((order, idx) => (
                                <tr key={`sell-${order.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {order.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${order.fillPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${
                                    order.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                                  }`}>
                                    {order.pnl !== undefined ? `${order.pnl >= 0 ? '+' : ''}$${order.pnl.toFixed(2)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-xs text-cyan-400">
                                    {order.holdbackBtc !== undefined ? `+${order.holdbackBtc.toFixed(8)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {order.filledAt ? new Date(order.filledAt).toLocaleTimeString() : '-'}
                                  </td>
                                </tr>
                              ))}
                              {sellOrders.length === 0 && (
                                <tr><td colSpan={5} className="text-center py-2 text-gray-500 text-xs">No sells yet</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  )
                })()}
              </div>
            ) : (
              /* Live Mode Fills - Split Buy/Sell Tables */
              <div className="space-y-3">
                {(() => {
                  // Filter fills based on cycle toggle
                  const filteredFills = showAllCycles
                    ? liveFills
                    : liveFills.filter(f => !f.cycleId || !f.cycleId.startsWith('cycle-'))

                  // Calculate running avg cost basis and P&L for sells
                  const sortedFills = [...filteredFills].sort((a, b) => a.timestamp - b.timestamp)
                  let runningBtc = 0
                  let runningCost = 0
                  const fillsWithPnl = sortedFills.map(fill => {
                    if (fill.side === 'buy') {
                      runningBtc += fill.size
                      runningCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || fill.fee || 0)
                      return { ...fill, pnl: null, holdback: null }
                    } else {
                      const avgCost = runningBtc > 0 ? runningCost / runningBtc : 0
                      const proceeds = (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0)
                      const costBasis = avgCost * fill.size
                      const pnl = proceeds - costBasis
                      const holdback = runningBtc - fill.size
                      runningBtc = holdback > 0 ? holdback : 0
                      runningCost = holdback > 0 ? avgCost * holdback : 0
                      return { ...fill, pnl, holdback: holdback > 0 ? holdback : 0, avgCost }
                    }
                  })

                  const allFills = fillsWithPnl.sort((a, b) => b.timestamp - a.timestamp)
                  const buyFills = allFills.filter(f => f.side === 'buy').slice(0, showAllCycles ? 25 : 10)
                  const sellFills = allFills.filter(f => f.side === 'sell').slice(0, showAllCycles ? 25 : 10)

                  // Calculate buy totals
                  let totalBuySize = 0
                  let totalBuyValue = 0
                  buyFills.forEach(fill => {
                    totalBuySize += fill.size || 0
                    totalBuyValue += fill.quoteAmount || 0
                  })

                  return (
                    <>
                      {/* Buys Table */}
                      <div>
                        <div className="text-xs text-green-400 mb-1 font-medium">Buys ({buyFills.length})</div>
                        <div className="overflow-x-auto max-h-32 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                {showAllCycles && <th className="text-left py-1.5 pr-2">Cycle</th>}
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">Value</th>
                                <th className="text-right py-1.5">Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {buyFills.length > 1 && (
                                <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                  {showAllCycles && <td className="py-1.5 pr-2"></td>}
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {totalBuySize.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 text-gray-400 text-xs">
                                    avg ${totalBuySize > 0 ? (totalBuyValue / totalBuySize).toFixed(2) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${totalBuyValue.toFixed(2)}
                                  </td>
                                  <td className="text-right py-1.5 text-gray-400 text-xs">Totals</td>
                                </tr>
                              )}
                              {buyFills.map((fill, idx) => (
                                <tr key={`buy-${fill.tradeId || fill.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  {showAllCycles && (
                                    <td className="py-1.5 pr-2 text-xs text-gray-500">
                                      {fill.cycleId ? fill.cycleId.replace('cycle-', '#') : 'current'}
                                    </td>
                                  )}
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {fill.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${fill.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-400 text-xs">
                                    ${fill.quoteAmount?.toFixed(2)}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {fill.timestamp ? new Date(fill.timestamp).toLocaleTimeString() : '-'}
                                  </td>
                                </tr>
                              ))}
                              {buyFills.length === 0 && (
                                <tr><td colSpan={showAllCycles ? 5 : 4} className="text-center py-2 text-gray-500 text-xs">No buys yet</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Sells Table */}
                      <div>
                        <div className="text-xs text-red-400 mb-1 font-medium">Sells ({sellFills.length})</div>
                        <div className="overflow-x-auto max-h-32 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                {showAllCycles && <th className="text-left py-1.5 pr-2">Cycle</th>}
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">P&L</th>
                                <th className="text-right py-1.5 pr-2">Holdback</th>
                                <th className="text-right py-1.5">Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sellFills.map((fill, idx) => (
                                <tr key={`sell-${fill.tradeId || fill.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  {showAllCycles && (
                                    <td className="py-1.5 pr-2 text-xs text-gray-500">
                                      {fill.cycleId ? fill.cycleId.replace('cycle-', '#') : 'current'}
                                    </td>
                                  )}
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {fill.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${fill.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${
                                    fill.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                                  }`}>
                                    {fill.pnl !== null ? `${fill.pnl >= 0 ? '+' : ''}$${fill.pnl.toFixed(2)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-xs text-cyan-400">
                                    {fill.holdback > 0 ? `+${fill.holdback.toFixed(8)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {fill.timestamp ? new Date(fill.timestamp).toLocaleTimeString() : '-'}
                                  </td>
                                </tr>
                              ))}
                              {sellFills.length === 0 && (
                                <tr><td colSpan={showAllCycles ? 6 : 5} className="text-center py-2 text-gray-500 text-xs">No sells yet</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  )
                })()}
              </div>
            )}
          </div>
        </div>
        </>
      ) : (
        /* Not Running State */
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <div className="text-gray-400">
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <p className="text-lg">Regime Engine is not running</p>
            <p className="text-sm text-gray-500 mt-2">
              The regime engine uses volatility-driven entries instead of fixed intervals.
              {isDryRun ? (
                <span className="block mt-1 text-purple-400">
                  Dry-run mode is enabled - trades will be simulated against live data.
                </span>
              ) : (
                ' Click Start in the header to begin adaptive trading.'
              )}
            </p>
          </div>
        </div>
      )}

      {/* Configuration Summary */}
      {config && (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-400">Configuration Summary</h3>
            {config.dryRun && (
              <span className="px-2 py-0.5 bg-purple-900/50 text-purple-400 text-xs rounded">
                Dry-Run Enabled
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 text-xs">
            <div>
              <span className="text-gray-500">Mode</span>
              <div className={config.dryRun ? 'text-purple-400' : 'text-green-400'}>
                {config.dryRun ? 'Dry-Run' : 'Live'}
              </div>
            </div>
            <div>
              <span className="text-gray-500">Base Size</span>
              <div className="text-white">${config.baseSizeUsdc}</div>
            </div>
            <div>
              <span className="text-gray-500">k Factor</span>
              <div className="text-white">{config.kFactor}</div>
            </div>
            <div>
              <span className="text-gray-500">Min Interval</span>
              <div className="text-white">{config.minIntervalMs / 1000}s</div>
            </div>
            <div>
              <span className="text-gray-500">Max Interval</span>
              <div className="text-white">{config.maxIntervalMs / 60000}m</div>
            </div>
            <div>
              <span className="text-gray-500">TP Range</span>
              <div className="flex items-center gap-1">
                <span className="text-white">{config.tpMinPercent}% - {config.tpMaxPercent}%</span>
                {config.tpAutoManaged && (
                  <span className="px-1 py-0.5 bg-cyan-900/50 text-cyan-400 text-xs rounded">Auto</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default RegimeDashboard
