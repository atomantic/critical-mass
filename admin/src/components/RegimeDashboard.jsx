import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useRegimeEvents, useTradeEvents } from '../hooks/useTradeEvents'
import { useChartDataBuffer } from '../hooks/useChartDataBuffer'
import MiniPriceSparkline from './charts/MiniPriceSparkline'
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
    <div className="flex items-center gap-2">
      <span className={`text-2xl font-bold font-mono transition-colors duration-300 ${directionColors[direction]}`}>
        ${price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '-'}
      </span>
      {direction !== 'none' && (
        <span className={`text-lg ${directionColors[direction]} animate-pulse`}>
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
      <div className="bg-gray-900 rounded p-2">
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-mono text-cyan-400">{formatCountdown(remaining)}</span>
          {remaining === 0 && <span className="text-xs text-yellow-400 animate-pulse">Ready</span>}
        </div>
        {total && (
          <div className="h-1 bg-gray-700 rounded-full mt-1 overflow-hidden">
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
      <div className="bg-gray-900 rounded p-2">
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <span className="text-lg font-mono text-gray-300">{formatDuration(elapsedMs)}</span>
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
    <div className="bg-gray-900 rounded p-2">
      <div className="text-xs text-gray-500 mb-1">ATR Trigger Distance</div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-mono text-gray-300">
          ${distanceToTrigger.toFixed(2)} to go
        </span>
        <span className="text-xs text-gray-500">
          ({progress.toFixed(0)}%)
        </span>
      </div>
      <div className="h-1.5 bg-gray-700 rounded-full mt-1 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            progress >= 100 ? 'bg-green-500 animate-pulse' : progress >= 75 ? 'bg-yellow-500' : 'bg-blue-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-600 mt-0.5">
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
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState(null)
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

  // Initial load only - no polling needed, socket provides live updates
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([fetchStatus(), fetchConfig()])
      setLoading(false)
    }
    load()
  }, [exchange, fetchStatus, fetchConfig])

  // Start engine
  const handleStart = async () => {
    setStarting(true)
    setError(null)
    const res = await fetch(`/api/${exchange}/regime/start`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      await fetchStatus()
    } else {
      setError(data.error || 'Failed to start engine')
    }
    setStarting(false)
  }

  // Stop engine
  const handleStop = async () => {
    setStopping(true)
    const res = await fetch(`/api/${exchange}/regime/stop`, { method: 'POST' })
    if (res.ok) {
      await fetchStatus()
    }
    setStopping(false)
  }

  // Pause/Resume
  const handlePause = async () => {
    const res = await fetch(`/api/${exchange}/regime/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Manual pause from UI' }),
    })
    if (res.ok) await fetchStatus()
  }

  const handleResume = async () => {
    const res = await fetch(`/api/${exchange}/regime/resume`, { method: 'POST' })
    if (res.ok) await fetchStatus()
  }

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

  // Reset dry-run state
  const handleResetDryRun = async () => {
    if (!confirm('Reset all dry-run state? This will clear simulated orders, fills, and P&L.')) return
    setResetting(true)
    const res = await fetch(`/api/${exchange}/regime/dry-run/reset`, { method: 'POST' })
    if (res.ok) {
      await fetchStatus()
    }
    setResetting(false)
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

  const regimeStyle = REGIME_COLORS[regime.mode] || REGIME_COLORS.HARVEST
  const healthStyle = HEALTH_COLORS[health.mode] || HEALTH_COLORS.ACTIVE
  const apy = status?.apy || {}
  const tpOptimizer = status?.tpOptimizer || {}

  return (
    <div className="space-y-6">
      {/* Header with Controls */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-bold">Regime Engine</h2>
            {isDryRun && (
              <span className="px-2 py-1 bg-purple-900/50 border border-purple-500 text-purple-400 text-xs font-medium rounded">
                🧪 DRY-RUN MODE
              </span>
            )}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
              <span className={isRunning ? 'text-green-400' : 'text-gray-400'}>
                {isRunning ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-blue-500' : 'bg-red-500'}`} />
              <span className={connected ? 'text-blue-400' : 'text-red-400'}>
                WebSocket {connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <button
                onClick={handleStart}
                disabled={starting}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 rounded font-medium transition-colors"
              >
                {starting ? 'Starting...' : isDryRun ? 'Start Dry-Run' : 'Start Engine'}
              </button>
            ) : (
              <>
                {isDryRun && (
                  <button
                    onClick={handleResetDryRun}
                    disabled={resetting}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 rounded text-sm transition-colors"
                    title="Reset dry-run state (clear simulated orders and P&L)"
                  >
                    {resetting ? 'Resetting...' : 'Reset'}
                  </button>
                )}
                {health.mode === 'PAUSED' ? (
                  <button
                    onClick={handleResume}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm transition-colors"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    onClick={handlePause}
                    className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 rounded text-sm transition-colors"
                  >
                    Pause
                  </button>
                )}
                <button
                  onClick={handleStop}
                  disabled={stopping}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 rounded font-medium transition-colors"
                >
                  {stopping ? 'Stopping...' : 'Stop Engine'}
                </button>
              </>
            )}
            <Link
              to={`/${exchange}/config`}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
            >
              Configure
            </Link>
          </div>
        </div>

        {error && (
          <div className="mt-3 p-3 bg-red-900/50 border border-red-700 rounded text-red-200 text-sm">
            {error}
          </div>
        )}
      </div>

      {isRunning ? (
        <>
          {/* Live Status Bar */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="grid grid-cols-5 xl:grid-cols-6 gap-4">
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
                <div className="bg-gray-900 rounded p-2 h-full">
                  <div className="text-xs text-gray-500 mb-1">Entry Status</div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${health.mode === 'ACTIVE' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                      <span className="text-sm">{health.mode === 'ACTIVE' ? 'Ready' : health.mode}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${regime.mode === 'TREND' ? 'bg-red-400' : 'bg-green-400'}`} />
                      <span className="text-sm text-gray-400">
                        {regime.mode === 'TREND' ? 'Entries blocked' : 'Entries allowed'}
                      </span>
                    </div>
                    {status?.orders && (
                      <div className="text-xs text-gray-500">
                        Open: {status.orders.entries || 0} entry, {status.orders.takeProfits || 0} TP
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Mini Price Chart (xl+) */}
              <div className="hidden xl:block col-span-1">
                <div className="text-xs text-gray-500 mb-1">Price (5m)</div>
                <MiniPriceSparkline
                  data={priceHistory}
                  width={200}
                  height={60}
                  currentPrice={market.lastPrice}
                  atr={market.atr1m}
                  kFactor={config?.kFactor || 0.6}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
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
          </div>

          {/* Middle Column: Position */}
          <div className="space-y-4">
            {/* Position */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-400">Position</h3>
                {isDryRun && (
                  <span className="text-xs text-purple-400">(Simulated)</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  label="BTC Held"
                  value={position.totalBTC?.toFixed(8) || '0'}
                  color="text-orange-400"
                />
                <StatCard
                  label="BTC on Order"
                  value={(isDryRun && dryRunState?.pnl?.btcOnOrder ? dryRunState.pnl.btcOnOrder : position.btcOnOrder || 0).toFixed(8)}
                  subValue="in sell orders"
                  color="text-yellow-400"
                />
                <StatCard
                  label="Cost Basis"
                  value={`$${position.totalCostBasis?.toFixed(2) || '0'}`}
                />
                <StatCard
                  label="Avg Cost"
                  value={`$${position.avgCostBasis?.toFixed(2) || '0'}`}
                />
                <StatCard
                  label="Ladder Step"
                  value={position.ladderStep || 0}
                  subValue={`of ${config?.maxLadderSteps || 10}`}
                />
                <StatCard
                  label="BTC Reserves"
                  value={(position.realizedBtcPnL || 0).toFixed(8)}
                  subValue="from holdback"
                  color="text-cyan-400"
                />
              </div>
              <div className="mt-3 pt-3 border-t border-gray-700">
                <div className="grid grid-cols-2 gap-3">
                  <StatCard
                    label="Unrealized P&L"
                    value={`$${position.unrealizedPnL?.toFixed(2) || '0'}`}
                    color={position.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}
                  />
                  <div className="bg-gray-800 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">Realized P&L</div>
                    <div className={`text-lg font-semibold ${position.realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${position.realizedPnL?.toFixed(2) || '0'}
                    </div>
                    {(position.realizedBtcPnL || 0) > 0 && (
                      <div className="text-xs text-cyan-400 mt-0.5">
                        + {position.realizedBtcPnL?.toFixed(8)} BTC
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-500">
                Cycles completed: {position.cyclesCompleted || 0}
              </div>

              {/* APY & Returns Section */}
              {apy.engineStartTime && (
                <div className="mt-3 pt-3 border-t border-gray-700">
                  <div className="text-xs text-gray-400 mb-2">Performance Metrics</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-gray-900/50 rounded p-2">
                      <div className="text-gray-500">Initial Capital</div>
                      <div className="text-white font-mono">${apy.initialCapital?.toLocaleString()}</div>
                    </div>
                    <div className="bg-gray-900/50 rounded p-2">
                      <div className="text-gray-500">Running For</div>
                      <div className="text-white font-mono">{apy.elapsedDays?.toFixed(1)} days</div>
                    </div>
                  </div>

                  {/* Returns Breakdown */}
                  <div className="mt-2 p-2 bg-gray-900/50 rounded">
                    <div className="text-gray-500 text-xs mb-2">Total Return</div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-gray-400">USDC</div>
                        <div className={`font-mono ${(apy.totalUsdcReturn || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          ${(apy.totalUsdcReturn || 0).toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <div className="text-gray-400">BTC</div>
                        <div className="text-orange-400 font-mono">
                          {(apy.totalBtcReturn || 0).toFixed(8)}
                        </div>
                        <div className="text-gray-500 text-xs">
                          ≈ ${(apy.btcValueUsd || 0).toFixed(2)}
                        </div>
                      </div>
                      <div className="border-l border-gray-700 pl-2">
                        <div className="text-cyan-400/70">Live Total</div>
                        <div className={`font-mono font-semibold ${(apy.totalLiquidValue || 0) >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                          ${(apy.totalLiquidValue || 0).toFixed(2)}
                        </div>
                        <div className="text-gray-500 text-xs">
                          ({(apy.totalLiquidValuePercent || 0).toFixed(2)}%)
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Daily Return based on total liquid value */}
                  <div className="mt-2 bg-gray-900/50 rounded p-2">
                    <div className="text-gray-500 text-xs mb-1">Est. Daily Return (Live Value)</div>
                    <div className="flex items-baseline gap-2">
                      <div className={`font-mono text-lg ${apy.dailyReturnPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {apy.dailyReturnPercent > 99 ? '>99' : apy.dailyReturnPercent?.toFixed(2)}%
                      </div>
                      <div className="text-gray-400 text-xs">
                        (${(apy.estimatedDailyLiquid || 0).toFixed(2)}/day)
                      </div>
                    </div>
                    <div className="text-gray-500 text-xs mt-1 flex gap-3">
                      <span>${apy.estimatedDailyUsdc?.toFixed(2)} USDC</span>
                      <span>+{((apy.estimatedDailyBtc || 0) * 1e8).toFixed(0)} sats</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                    <div className="bg-gradient-to-r from-green-900/30 to-green-800/20 border border-green-700/30 rounded p-2">
                      <div className="text-green-400/70">Est. Annual Return</div>
                      <div className={`font-mono text-lg ${apy.estimatedAnnualReturn >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {apy.estimatedAnnualReturn > 9999 ? '>9999' : apy.estimatedAnnualReturn?.toFixed(0)}%
                      </div>
                    </div>
                    <div className="bg-gradient-to-r from-cyan-900/30 to-cyan-800/20 border border-cyan-700/30 rounded p-2">
                      <div className="text-cyan-400/70">Est. APY (Compound)</div>
                      <div className={`font-mono text-lg ${apy.estimatedApy >= 0 ? 'text-cyan-400' : 'text-red-400'}`}>
                        {apy.estimatedApy > 9999 ? '>9999' : apy.estimatedApy?.toFixed(0)}%
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-2">
                    <span>Cycles/Day: {apy.cyclesPerDay?.toFixed(1)}</span>
                    <span>Avg P&L/Cycle: ${apy.avgPnlPerCycle?.toFixed(2)}</span>
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
          </div>

          {/* Right Column: Analytics & Activity */}
          <div className="space-y-4">
            {/* Optimal TP Analytics */}
            {isDryRun && dryRunState?.optimalTpAnalytics && (
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-400">Optimal TP Analysis</h3>
                  <span className="text-xs text-purple-400">
                    {dryRunState.optimalTpAnalytics.cycleCount} cycles
                  </span>
                </div>

                {/* Current Cycle (if in position) */}
                {dryRunState.optimalTpAnalytics.currentCycle && (
                  <div className="mb-3 p-2 bg-blue-900/30 border border-blue-700/50 rounded">
                    <div className="text-xs text-blue-400 mb-1">Current Position</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-gray-500">Entry:</span>{' '}
                        <span className="text-white font-mono">${dryRunState.optimalTpAnalytics.currentCycle.entryPrice?.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Max seen:</span>{' '}
                        <span className="text-green-400 font-mono">${dryRunState.optimalTpAnalytics.currentCycle.currentMaxPrice?.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Min seen:</span>{' '}
                        <span className="text-red-400 font-mono">${dryRunState.optimalTpAnalytics.currentCycle.currentMinPrice?.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Optimal TP:</span>{' '}
                        <span className="text-cyan-400 font-mono">{dryRunState.optimalTpAnalytics.currentCycle.currentOptimalPct?.toFixed(2)}%</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Historical Analytics */}
                {dryRunState.optimalTpAnalytics.cycleCount > 0 ? (
                  <>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Avg Optimal TP</span>
                        <span className="text-cyan-400 font-mono font-semibold">
                          {dryRunState.optimalTpAnalytics.avgOptimalTpPct?.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Avg Actual TP</span>
                        <span className="text-white font-mono">
                          {dryRunState.optimalTpAnalytics.avgActualTpPct?.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Avg Missed Profit</span>
                        <span className={`font-mono ${dryRunState.optimalTpAnalytics.avgMissedProfitPct > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                          {dryRunState.optimalTpAnalytics.avgMissedProfitPct?.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Avg Time to Peak</span>
                        <span className="text-gray-300 font-mono">
                          {formatDuration(dryRunState.optimalTpAnalytics.avgTimeToMaxMs)}
                        </span>
                      </div>
                    </div>

                    {/* Recommended Range */}
                    {dryRunState.optimalTpAnalytics.recommendedTpRange && (
                      <div className="mt-3 pt-3 border-t border-gray-700">
                        <div className="text-xs text-gray-400 mb-2">Recommended TP Range (based on observed data)</div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-3 bg-gray-700 rounded-full relative overflow-hidden">
                            {/* Current config range indicator */}
                            <div
                              className="absolute h-full bg-blue-600/50"
                              style={{
                                left: `${Math.min(100, (config?.tpMinPercent || 0) / 5 * 100)}%`,
                                width: `${Math.min(100, ((config?.tpMaxPercent || 5) - (config?.tpMinPercent || 0)) / 5 * 100)}%`,
                              }}
                            />
                            {/* Observed range */}
                            <div
                              className="absolute h-full bg-cyan-500/70"
                              style={{
                                left: `${Math.min(100, (dryRunState.optimalTpAnalytics.recommendedTpRange.min || 0) / 5 * 100)}%`,
                                width: `${Math.min(100, ((dryRunState.optimalTpAnalytics.recommendedTpRange.max || 0) - (dryRunState.optimalTpAnalytics.recommendedTpRange.min || 0)) / 5 * 100)}%`,
                              }}
                            />
                            {/* Median marker */}
                            <div
                              className="absolute w-0.5 h-full bg-white"
                              style={{
                                left: `${Math.min(100, (dryRunState.optimalTpAnalytics.recommendedTpRange.median || 0) / 5 * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="flex justify-between text-xs mt-1">
                          <span className="text-gray-500">0%</span>
                          <span className="text-cyan-400">
                            {dryRunState.optimalTpAnalytics.recommendedTpRange.min?.toFixed(1)}% - {dryRunState.optimalTpAnalytics.recommendedTpRange.max?.toFixed(1)}%
                          </span>
                          <span className="text-gray-500">5%</span>
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>Current config: {config?.tpMinPercent}%-{config?.tpMaxPercent}%</span>
                          <span className="text-blue-400">■</span>
                          <span>Observed</span>
                          <span className="text-cyan-400">■</span>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-gray-500 text-xs text-center py-2">
                    Complete at least one cycle to see analytics
                  </div>
                )}
              </div>
            )}

            {/* TP Auto-Management Panel */}
            {tpOptimizer.enabled && (
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-400">TP Auto-Management</h3>
                  <span className="px-2 py-0.5 bg-green-900/50 text-green-400 text-xs rounded">
                    Active
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  {/* Current Config */}
                  <div className="p-2 bg-gray-900/50 rounded">
                    <div className="text-gray-500 mb-1">Current TP Settings</div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <span className="text-gray-400">Min:</span>{' '}
                        <span className="text-white font-mono">{tpOptimizer.currentConfig?.tpMinPercent?.toFixed(2)}%</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Max:</span>{' '}
                        <span className="text-white font-mono">{tpOptimizer.currentConfig?.tpMaxPercent?.toFixed(2)}%</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Holdback Ratio:</span>{' '}
                        <span className="text-white font-mono">{tpOptimizer.currentConfig?.holdbackRatio?.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Observed Percentiles */}
                  {tpOptimizer.sampleCount >= 3 && (
                    <div className="p-2 bg-cyan-900/20 border border-cyan-700/30 rounded">
                      <div className="text-cyan-400/70 mb-1">Observed Percentiles ({tpOptimizer.sampleCount} samples)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <span className="text-gray-400">p25:</span>{' '}
                          <span className="text-cyan-400 font-mono">{tpOptimizer.percentiles?.p25?.toFixed(2)}%</span>
                        </div>
                        <div>
                          <span className="text-gray-400">p50:</span>{' '}
                          <span className="text-cyan-400 font-mono">{tpOptimizer.percentiles?.p50?.toFixed(2)}%</span>
                        </div>
                        <div>
                          <span className="text-gray-400">p75:</span>{' '}
                          <span className="text-cyan-400 font-mono">{tpOptimizer.percentiles?.p75?.toFixed(2)}%</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Evaluation Status */}
                  <div className="flex justify-between text-gray-500">
                    <span>Cycles since eval: {tpOptimizer.cyclesSinceEval || 0}</span>
                    <span>Samples: {tpOptimizer.sampleCount || 0}</span>
                  </div>

                  {/* Recent Adjustments */}
                  {tpOptimizer.adjustmentHistory?.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-700">
                      <div className="text-gray-500 mb-1">Recent Adjustments</div>
                      <div className="space-y-1 max-h-24 overflow-y-auto">
                        {tpOptimizer.adjustmentHistory.slice(-3).reverse().map((adj, idx) => (
                          <div key={idx} className="text-xs text-gray-400 flex justify-between">
                            <span>{new Date(adj.timestamp).toLocaleTimeString()}</span>
                            <span className="text-cyan-400">{adj.tpMin?.toFixed(1)}%-{adj.tpMax?.toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Activity Feed */}
            <div className="bg-gray-800 rounded-lg p-4 h-fit">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Activity</h3>
              <button
                onClick={clearEvents}
                className="text-xs text-gray-500 hover:text-gray-400"
              >
                Clear
              </button>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {allEvents.length === 0 ? (
                <div className="text-gray-500 text-sm">No recent activity</div>
              ) : (
                allEvents.map((event, i) => {
                  const time = new Date(event.timestamp).toLocaleTimeString()
                  const typeColors = {
                    regime_change: 'text-purple-400',
                    health_change: 'text-yellow-400',
                    entry_placed: 'text-blue-400',
                    entry_filled: 'text-green-400',
                    tp_placed: 'text-cyan-400',
                    tp_filled: 'text-green-400',
                    tp_adjusted: 'text-cyan-400',
                    flash_move: 'text-red-400',
                    safe_mode: 'text-yellow-400',
                    error: 'text-red-400',
                  }
                  return (
                    <div key={`${event.timestamp}-${i}`} className="text-xs border-l-2 border-gray-700 pl-2">
                      <span className="text-gray-500">{time}</span>
                      <span className={`ml-2 ${typeColors[event.type] || 'text-gray-400'}`}>
                        {event.type?.replace(/_/g, ' ')}
                      </span>
                      <div className="text-gray-400 truncate">
                        {event.message || JSON.stringify(event.data || {}).slice(0, 50)}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        </div>

        {/* Live Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 3xl:grid-cols-3 gap-6">
          {/* Price Chart */}
          <RegimePriceChart
            priceData={priceHistory}
            regimeData={regimeHistory}
            currentPrice={market.lastPrice}
            anchorPrice={position.anchorPrice}
            atr={market.atr1m}
            kFactor={config?.kFactor || 0.6}
            height={280}
          />

          {/* Volatility Chart */}
          <VolatilityChart
            atrData={atrHistory}
            regimeData={regimeHistory}
            height={240}
          />

          {/* Regime Timeline */}
          <div className="lg:col-span-2 3xl:col-span-1">
            <RegimeTimeline
              data={regimeHistory}
              currentRegime={regime}
              height={80}
            />
          </div>
        </div>

        {/* Orders Section */}
        <div className="grid grid-cols-2 gap-6">
          {/* Open Orders */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Open Orders</h3>
              {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
            </div>
            {(dryRunState?.pendingOrders?.length || 0) === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">No open orders</div>
            ) : (
              <div className="overflow-x-auto">
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
                    {dryRunState.pendingOrders
                      .filter(o => o.status === 'open')
                      .map((order) => {
                        const age = Date.now() - order.placedAt
                        // Calculate expected P&L for TP orders
                        const avgCost = position.avgCostBasis || 0
                        const estPnl = order.type === 'take_profit' && avgCost > 0
                          ? (order.price - avgCost) * order.size
                          : null
                        // Calculate expected BTC holdback for TP orders
                        const holdbackRatio = config?.holdbackRatio ?? 0.5
                        const estHoldback = order.type === 'take_profit'
                          ? order.size * (holdbackRatio / (1 - holdbackRatio))
                          : null
                        return (
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
                            <td className={`text-right py-2 pr-2 font-mono text-xs ${estPnl !== null ? (estPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`}>
                              {estPnl !== null ? `${estPnl >= 0 ? '+' : ''}$${estPnl.toFixed(2)}` : '—'}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                              {estHoldback !== null ? `+${estHoldback.toFixed(8)}` : '—'}
                            </td>
                            <td className="text-right py-2 font-mono text-gray-500 text-xs">
                              {formatDuration(age)}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Filled Orders */}
          <div className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Filled Orders</h3>
              {isDryRun && dryRunState?.filledOrders?.length > 0 && (
                <span className="text-xs text-gray-500">
                  {dryRunState.filledOrders.length} fills
                </span>
              )}
            </div>
            {(dryRunState?.filledOrders?.length || 0) === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">No filled orders yet</div>
            ) : (
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-800">
                    <tr className="text-gray-400 text-xs border-b border-gray-700">
                      <th className="text-left py-2 pr-2">Type</th>
                      <th className="text-left py-2 pr-2">Side</th>
                      <th className="text-right py-2 pr-2">Size (BTC)</th>
                      <th className="text-right py-2 pr-2">Fill Price</th>
                      <th className="text-right py-2 pr-2">USD P&L</th>
                      <th className="text-right py-2 pr-2">BTC Hold</th>
                      <th className="text-right py-2">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...dryRunState.filledOrders]
                      .reverse()
                      .slice(0, 20)
                      .map((order, idx) => (
                        <tr key={`${order.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
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
                            ${order.fillPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className={`text-right py-2 pr-2 font-mono text-xs ${
                            order.type === 'take_profit'
                              ? (order.pnl >= 0 ? 'text-green-400' : 'text-red-400')
                              : 'text-gray-500'
                          }`}>
                            {order.type === 'take_profit' && order.pnl !== undefined
                              ? `${order.pnl >= 0 ? '+' : ''}$${order.pnl.toFixed(2)}`
                              : '—'}
                          </td>
                          <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                            {order.type === 'take_profit' && order.holdbackBtc !== undefined
                              ? `+${order.holdbackBtc.toFixed(8)}`
                              : '—'}
                          </td>
                          <td className="text-right py-2 font-mono text-gray-500 text-xs">
                            {order.filledAt ? new Date(order.filledAt).toLocaleTimeString() : '-'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        </>
      ) : (
        /* Not Running State */
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <p className="text-lg">Regime Engine is not running</p>
            <p className="text-sm text-gray-500 mt-2">
              The regime engine uses volatility-driven entries instead of fixed intervals.
              {isDryRun ? (
                <span className="block mt-1 text-purple-400">
                  🧪 Dry-run mode is enabled - trades will be simulated against live data.
                </span>
              ) : (
                ' Start the engine to begin adaptive trading.'
              )}
            </p>
          </div>
          <button
            onClick={handleStart}
            disabled={starting}
            className={`px-6 py-3 ${isDryRun ? 'bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800' : 'bg-green-600 hover:bg-green-700 disabled:bg-green-800'} rounded-lg font-medium transition-colors`}
          >
            {starting ? 'Starting...' : isDryRun ? '🧪 Start Dry-Run Mode' : 'Start Regime Engine'}
          </button>
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
          <div className="grid grid-cols-6 gap-4 text-xs">
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
