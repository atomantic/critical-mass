import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import { useRegimeEvents } from '../hooks/useTradeEvents'
import { useChartDataBuffer } from '../hooks/useChartDataBuffer'
import RegimePriceChart from './charts/RegimePriceChart'
import VolatilityChart from './charts/VolatilityChart'
import RegimeTimeline from './charts/RegimeTimeline'

const CelestialVisualization = lazy(() => import('./celestial/CelestialVisualization'))

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

// Format timestamp as YYYY-MM-DD HH:MM:SS local time
const formatTimestamp = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
  STOPPED: { bg: 'bg-red-900/30', text: 'text-red-400', icon: '■' },
}

// Macro regime mode colors
const MACRO_COLORS = {
  ACCUMULATION: { bg: 'bg-blue-900/50', border: 'border-blue-500', text: 'text-blue-400', label: 'Accumulation' },
  RANGING: { bg: 'bg-gray-800/50', border: 'border-gray-500', text: 'text-gray-400', label: 'Ranging' },
  MARKUP: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400', label: 'Markup' },
  DECLINE: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400', label: 'Decline' },
}

// Aggressiveness level metadata (colors/labels are static, params come from API)
const AGGRESSIVENESS_LEVEL_META = {
  conservative: { label: 'Conservative', color: 'green' },
  moderate: { label: 'Moderate', color: 'blue' },
  aggressive: { label: 'Aggressive', color: 'yellow' },
  maximum: { label: 'Maximum', color: 'red' },
}

// Build AGGRESSIVENESS_LEVELS array from presets object (from API)
const buildAggressivenessLevels = (presets) =>
  Object.entries(AGGRESSIVENESS_LEVEL_META).map(([id, meta]) => ({
    id,
    ...meta,
    params: presets[id] || {},
  }))

// Get parameter values for a given level from presets
const computeAggressivenessParams = (levelId, presets) => {
  return presets[levelId] ? { ...presets[levelId] } : null
}

// Detect current aggressiveness level from config based on actual parameter values
const detectAggressivenessLevel = (config, presets) => {
  if (!config || !presets) return null

  const levels = buildAggressivenessLevels(presets)
  const firstPreset = levels[0]
  if (!firstPreset?.params) return config.aggressiveness || null

  const presetKeys = Object.keys(firstPreset.params)
  const hasAllKeys = presetKeys.every(key => config[key] !== undefined)
  if (!hasAllKeys) return config.aggressiveness || null

  for (const level of levels) {
    const expected = level.params
    const allMatch = Object.entries(expected).every(([key, value]) => {
      const current = config[key]
      return Math.abs(current - value) < 0.01 || (key.endsWith('Ms') && current === value)
    })
    if (allMatch) return level.id
  }

  return 'custom'
}

// Format interval in human readable form
const formatInterval = (ms) => {
  if (ms >= 3600000) return `${ms / 3600000}hr`
  if (ms >= 60000) return `${ms / 60000}min`
  return `${ms / 1000}s`
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

// Aggressiveness control component
function AggressivenessControl({ config, exchange, onConfigUpdate, presets }) {
  const [updating, setUpdating] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewLevel, setPreviewLevel] = useState(null)

  const levels = useMemo(() => buildAggressivenessLevels(presets || {}), [presets])
  const currentLevel = detectAggressivenessLevel(config, presets)

  const handleLevelChange = async (level) => {
    if (level === currentLevel || updating) return

    setUpdating(true)
    const params = computeAggressivenessParams(level, presets)
    const updates = { aggressiveness: level, ...params }

    const res = await fetch(`/api/${exchange}/regime/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })

    if (res.ok) {
      onConfigUpdate()
    }
    setUpdating(false)
  }

  const handlePreview = (level) => {
    setPreviewLevel(level)
    setShowPreview(true)
  }

  const previewParams = previewLevel
    ? computeAggressivenessParams(previewLevel, presets)
    : null

  const colorClasses = {
    green: {
      active: 'bg-green-600 text-white border-green-400 ring-2 ring-green-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-green-400 hover:border-green-600/50',
    },
    blue: {
      active: 'bg-blue-600 text-white border-blue-400 ring-2 ring-blue-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-blue-400 hover:border-blue-600/50',
    },
    yellow: {
      active: 'bg-yellow-600 text-white border-yellow-400 ring-2 ring-yellow-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-yellow-400 hover:border-yellow-600/50',
    },
    red: {
      active: 'bg-red-600 text-white border-red-400 ring-2 ring-red-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-red-400 hover:border-red-600/50',
    },
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400">Aggressiveness Level</span>
        {currentLevel === 'custom' && (
          <span className="px-1.5 py-0.5 bg-purple-900/50 text-purple-400 text-[10px] rounded">
            Custom
          </span>
        )}
      </div>

      {/* Level buttons */}
      <div className="flex gap-1 mb-2">
        {levels.map((level) => {
          const isActive = currentLevel === level.id
          const classes = colorClasses[level.color]
          return (
            <button
              key={level.id}
              onClick={() => handleLevelChange(level.id)}
              onMouseEnter={() => handlePreview(level.id)}
              onMouseLeave={() => setShowPreview(false)}
              disabled={updating}
              className={`flex-1 px-2 py-1.5 text-xs font-medium rounded border transition-all ${
                isActive ? classes.active : classes.inactive
              } ${updating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {level.label}
            </button>
          )
        })}
      </div>

      {/* Preview panel */}
      {showPreview && previewParams && (
        <div className="bg-gray-900 rounded p-2 text-xs">
          <div className="grid grid-cols-4 gap-x-3 gap-y-1">
            <div className="flex justify-between">
              <span className="text-gray-500">kFactor</span>
              <span className={config?.kFactor !== previewParams.kFactor ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.kFactor}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">minInterval</span>
              <span className={config?.minIntervalMs !== previewParams.minIntervalMs ? 'text-yellow-400' : 'text-gray-300'}>
                {formatInterval(previewParams.minIntervalMs)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">maxInterval</span>
              <span className={config?.maxIntervalMs !== previewParams.maxIntervalMs ? 'text-yellow-400' : 'text-gray-300'}>
                {formatInterval(previewParams.maxIntervalMs)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">entryOffset</span>
              <span className={config?.entryOffsetBps !== previewParams.entryOffsetBps ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.entryOffsetBps}bps
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">baseSize</span>
              <span className={config?.baseSizeUsdc !== previewParams.baseSizeUsdc ? 'text-yellow-400' : 'text-gray-300'}>
                ${previewParams.baseSizeUsdc}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">cautionScale</span>
              <span className={config?.cautionScale !== previewParams.cautionScale ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.cautionScale}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">trendScale</span>
              <span className={config?.trendScale !== previewParams.trendScale ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.trendScale}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">maxCycleBuys</span>
              <span className={config?.maxCycleBuys !== previewParams.maxCycleBuys ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.maxCycleBuys}
              </span>
            </div>
          </div>
          {config?.sizeAutoManaged && (
            <div className="mt-1 text-[10px] text-purple-400">
              Note: baseSizeUsdc may be overridden by auto-sizer
            </div>
          )}
        </div>
      )}
    </div>
  )
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

function RegimeDashboard({ exchange = 'coinbase' }) {
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [liveFills, setLiveFills] = useState([])
  const [showAllCycles, setShowAllCycles] = useState(false)
  const [recalculating, setRecalculating] = useState(false)
  const [recalcPreview, setRecalcPreview] = useState(null)
  const [expandedOrders, setExpandedOrders] = useState(new Set())
  const [expandedFills, setExpandedFills] = useState(new Set())
  const [expandedCycles, setExpandedCycles] = useState(new Set())
  const [presets, setPresets] = useState(null)
  const [rollUpConfirm, setRollUpConfirm] = useState(null)
  const [rollingUp, setRollingUp] = useState(false)
  const prevPriceRef = useRef(null)

  const { status: socketStatus, setStatus: setSocketStatus } = useRegimeEvents(exchange)

  // Use socket status when available, fall back to local status (for initial load / when engine stopped)
  const status = socketStatus || localStatus

  // Chart data buffering with cache support
  const { priceHistory, atrHistory, regimeHistory, initializeFromCache } = useChartDataBuffer(status)

  // Sync config from status updates (hot-reload without refresh)
  useEffect(() => {
    if (status?.config) {
      setConfig(prev => prev ? { ...prev, ...status.config } : status.config)
    }
  }, [status?.config])

  // Compute filtered fills for display based on cycle toggle
  const filteredFills = useMemo(() => {
    if (!liveFills || liveFills.length === 0) {
      return []
    }
    if (showAllCycles) {
      return liveFills
    }
    // Find the most recent cycleId by comparing cycle numbers
    const currentCycleId = liveFills.reduce((latest, f) => {
      if (!f.cycleId) return latest
      if (!latest) return f.cycleId
      const latestNum = parseInt(latest.replace('cycle-', '')) || 0
      const fillNum = parseInt(f.cycleId.replace('cycle-', '')) || 0
      return fillNum > latestNum ? f.cycleId : latest
    }, null)
    return liveFills.filter(f => f.cycleId === currentCycleId)
  }, [liveFills, showAllCycles])

  // Derive the most recent cycle ID from filtered fills
  const mostRecentCycleId = useMemo(() => {
    if (!filteredFills || filteredFills.length === 0) return null
    return filteredFills.reduce((latest, f) => {
      if (!f.cycleId) return latest
      if (!latest) return f.cycleId
      const latestNum = parseInt(latest.replace('cycle-', '')) || 0
      const fillNum = parseInt(f.cycleId.replace('cycle-', '')) || 0
      return fillNum > latestNum ? f.cycleId : latest
    }, null)
  }, [filteredFills])

  // Auto-expand most recent cycle on mount / when cycle list changes
  const cycleInitRef = useRef(false)
  useEffect(() => {
    if (mostRecentCycleId && !cycleInitRef.current) {
      setExpandedCycles(new Set([mostRecentCycleId]))
      cycleInitRef.current = true
    }
  }, [mostRecentCycleId])

  // Track previous price for animation
  useEffect(() => {
    if (status?.market?.lastPrice) {
      prevPriceRef.current = status.market.lastPrice
    }
  }, [status?.market?.lastPrice])


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

  // Fetch cached chart data from server
  const fetchCachedChartData = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/chart-data`)
    if (res.ok) {
      const data = await res.json()
      if (data.data) {
        initializeFromCache(data.data)
      }
    }
  }, [exchange, initializeFromCache])

  // Fetch aggressiveness presets
  const fetchPresets = useCallback(async () => {
    const res = await fetch('/api/presets/aggressiveness')
    if (res.ok) {
      const data = await res.json()
      setPresets(data.presets)
    }
  }, [])

  // Initial load only - no polling needed, socket provides live updates
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([fetchStatus(), fetchConfig(), fetchFills(), fetchCachedChartData(), fetchPresets()])
      setLoading(false)
    }
    load()
  }, [exchange, fetchStatus, fetchConfig, fetchFills, fetchCachedChartData, fetchPresets])

  // Resume from drawdown pause
  const handleResumeDrawdown = async () => {
    if (!confirm('Resume trading from drawdown pause? This will reset the peak equity to current levels.')) return
    const res = await fetch(`/api/${exchange}/regime/resume-drawdown`, { method: 'POST' })
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

  // Manual body roll-up merge
  const handleRollUp = async (bodyId) => {
    setRollingUp(true)
    const res = await fetch(`/api/${exchange}/regime/rollup-body`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bodyId }),
    })
    const data = await res.json()
    setRollingUp(false)
    setRollUpConfirm(null)
    if (data.success && data.status) {
      // Directly update socket status from API response for immediate visual refresh
      // (avoids race where socketStatus overrides stale localStatus from fetchStatus)
      setSocketStatus(data.status)
    }
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
  const sizeOptimizer = status?.sizeOptimizer || {}

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-200 text-sm">
          {error}
        </div>
      )}

      {/* Stopped banner when engine is not running but we have data */}
      {!isRunning && (market.lastPrice > 0 || position.totalBTC > 0) && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-4 py-2 flex items-center gap-3">
          <span className="text-red-400 text-lg">■</span>
          <div>
            <span className="text-red-300 font-medium text-sm">Engine Stopped</span>
            <span className="text-gray-500 text-xs ml-2">Live market data streaming &middot; no trading</span>
          </div>
        </div>
      )}

      {(!isRunning && !market.lastPrice && !position.totalBTC) ? (
        /* No data at all - show placeholder */
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
      ) : (
        <>
          {/* Live Status Bar */}
          <div className="bg-gray-800 rounded-lg p-2 sm:p-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 sm:gap-3">
              {/* Live Price */}
              <div className="col-span-1">
                <span className="text-[10px] text-gray-500">BTC Price</span>
                <LivePriceTicker
                  price={market.lastPrice}
                  prevPrice={prevPriceRef.current}
                />
                <div className="text-[10px] text-gray-500">
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
                        {regime.mode === 'TREND' ? 'Blocked' : 'Allowed'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${status?.celestial?.enabled ? 'bg-purple-400' : 'bg-gray-600'}`} />
                      <span className="text-xs text-gray-400">
                        {status?.celestial?.enabled ? (status.celestial.tierSummary || `${status.celestial.bodiesActive || 0}/${config?.maxCelestialBodies || 10}`) : 'Off'}
                      </span>
                    </div>
                    {config?.macroEnabled && status?.macro && (
                      <div className="flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          status.macro.mode === 'ACCUMULATION' ? 'bg-blue-400' :
                          status.macro.mode === 'MARKUP' ? 'bg-green-400' :
                          status.macro.mode === 'DECLINE' ? 'bg-red-400' : 'bg-gray-500'
                        }`} />
                        <span className="text-xs text-gray-400">
                          Macro {status.macro.mode?.slice(0, 3)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Compact Current Regime */}
              <div className={`col-span-1 ${regimeStyle.bg} border ${regimeStyle.border} rounded p-1.5`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-400">Regime</span>
                  <span className={`${healthStyle.bg} ${healthStyle.text} px-1 py-0.5 rounded text-[10px]`}>
                    {health.mode || 'ACTIVE'}
                  </span>
                </div>
                <div className={`text-xl font-bold ${regimeStyle.text}`}>
                  {regime.mode || 'HARVEST'}
                </div>
                {config?.macroEnabled && status?.macro ? (() => {
                  const macroStyle = MACRO_COLORS[status.macro.mode] || MACRO_COLORS.RANGING
                  return (
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`px-1 py-0.5 rounded text-[10px] ${macroStyle.bg} border ${macroStyle.border} ${macroStyle.text}`}>
                        {macroStyle.label}
                      </span>
                      <span className="text-[10px] text-gray-500">{status.macro.score?.toFixed(0)}</span>
                    </div>
                  )
                })() : (
                  <div className="text-[10px] text-gray-500">
                    Since {regime.since ? new Date(regime.since).toLocaleTimeString() : '-'}
                  </div>
                )}
              </div>

              {/* Entry Mode */}
              <div className={`col-span-1 ${status?.entryMode === 'ladder' ? 'bg-indigo-900/30 border-indigo-700/50' : 'bg-gray-800 border-gray-700'} border rounded p-1.5`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-400">Entry</span>
                  {config?.ladderAutoSwitch && (
                    <span className="px-1 py-0.5 bg-purple-900/50 text-purple-400 text-[10px] rounded">Auto</span>
                  )}
                </div>
                <div className={`text-xl font-bold ${status?.entryMode === 'ladder' ? 'text-indigo-400' : 'text-gray-300'}`}>
                  {status?.entryMode === 'ladder' ? 'LADDER' : 'REACTIVE'}
                </div>
                <div className="text-[10px] text-gray-500">
                  {status?.ladder?.active
                    ? `${status.ladder.pendingOrders} orders pending`
                    : status?.entryMode === 'ladder' ? 'Waiting for trigger' : 'Single order mode'}
                </div>
                {status?.autoSwitch && (
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    Vol: <span className={status.autoSwitch.volExpansion >= status.autoSwitch.threshold ? 'text-purple-400' : 'text-gray-400'}>{status.autoSwitch.volExpansion}x</span>
                    <span className="text-gray-600"> / {status.autoSwitch.threshold}x</span>
                  </div>
                )}
              </div>

            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Left Column: Volatility, Risk & Timeline */}
          <div className="space-y-4">
            {/* Volatility Metrics - Compact */}
            <div className="bg-gray-800 rounded-lg p-3">
              <h3 className="text-xs font-medium text-gray-400 mb-2">Volatility</h3>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">ATR 1m</span>
                  <span className="text-white font-mono">${market.atr1m?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">ATR 5m</span>
                  <span className="text-white font-mono">${market.atr5m?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">VWAP</span>
                  <span className="text-white font-mono">${market.vwap?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">VWAP Dist</span>
                  <span className={`font-mono ${Math.abs(market.vwapDistance || 0) > 1 ? 'text-yellow-400' : 'text-white'}`}>
                    {market.vwapDistance?.toFixed(2) || '-'} ATR
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">RVol</span>
                  <span className="text-white font-mono">{market.realizedVol?.toFixed(2) || '-'}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Expansion</span>
                  <span className={`font-mono ${(market.realizedVol / market.volBaseline) > 1.5 ? 'text-yellow-400' : 'text-white'}`}>
                    {market.volBaseline ? (market.realizedVol / market.volBaseline).toFixed(2) : '-'}x
                  </span>
                </div>
              </div>
            </div>

            {/* Volatility Chart */}
            <VolatilityChart
              atrData={atrHistory}
              regimeData={regimeHistory}
              height={200}
            />

            {/* TP Auto-Management Panel */}
            {tpOptimizer.enabled && (
              <div className="bg-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-400">TP Auto-Management</h3>
                  <span className="px-1.5 py-0.5 bg-green-900/50 text-green-400 text-[10px] rounded">
                    Active
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  {/* Current Config */}
                  <div className="p-2 bg-gray-900/50 rounded">
                    <div className="text-gray-500 text-[10px] mb-1">Current TP Settings</div>
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
                        <span className="text-gray-400">Holdback:</span>{' '}
                        <span className="text-white font-mono">{tpOptimizer.currentConfig?.holdbackRatio?.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Observed Percentiles */}
                  {tpOptimizer.sampleCount >= 3 && (
                    <div className="p-2 bg-cyan-900/20 border border-cyan-700/30 rounded">
                      <div className="text-cyan-400/70 text-[10px] mb-1">Observed Percentiles ({tpOptimizer.sampleCount} samples)</div>
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
                  <div className="flex justify-between text-gray-500 text-[10px]">
                    <span>Cycles since eval: {tpOptimizer.cyclesSinceEval || 0}</span>
                    <span>Samples: {tpOptimizer.sampleCount || 0}</span>
                  </div>

                  {/* Recent Adjustments */}
                  {tpOptimizer.adjustmentHistory?.length > 0 && (
                    <div className="pt-2 border-t border-gray-700">
                      <div className="text-gray-500 text-[10px] mb-1">Recent Adjustments</div>
                      <div className="space-y-0.5 max-h-16 overflow-y-auto">
                        {tpOptimizer.adjustmentHistory.slice(-3).reverse().map((adj, idx) => (
                          <div key={idx} className="text-[10px] text-gray-400 flex justify-between">
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

            {/* Size Auto-Management Panel */}
            {sizeOptimizer.enabled && (
              <div className="bg-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-400">Size Auto-Management</h3>
                  <span className="px-1.5 py-0.5 bg-green-900/50 text-green-400 text-[10px] rounded">
                    Active
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  {/* Current Sizing Config */}
                  <div className="p-2 bg-gray-900/50 rounded">
                    <div className="text-gray-500 text-[10px] mb-1">Current Size Settings</div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <span className="text-gray-400">Base:</span>{' '}
                        <span className="text-white font-mono">${sizeOptimizer.currentConfig?.baseSizeUsdc}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Cap:</span>{' '}
                        <span className="text-white font-mono">${sizeOptimizer.currentConfig?.maxUsdcDeployed?.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Max Buys:</span>{' '}
                        <span className="text-white font-mono">{sizeOptimizer.currentConfig?.maxCycleBuys}</span>
                      </div>
                    </div>
                  </div>

                  {/* Cycle Stats */}
                  {sizeOptimizer.totalCycleCount >= 3 && (
                    <div className="p-2 bg-purple-900/20 border border-purple-700/30 rounded">
                      <div className="text-purple-400/70 text-[10px] mb-1">Step Usage ({sizeOptimizer.totalCycleCount} cycles)</div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <span className="text-gray-400">Avg:</span>{' '}
                          <span className="text-purple-400 font-mono">{sizeOptimizer.stats?.avgStepsUsed?.toFixed(1)}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">P90:</span>{' '}
                          <span className="text-purple-400 font-mono">{sizeOptimizer.stats?.p90StepsUsed}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">Balance:</span>{' '}
                          <span className="text-white font-mono">${sizeOptimizer.lastKnownBalance?.toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Evaluation Status */}
                  <div className="flex justify-between text-gray-500 text-[10px]">
                    <span>Cycles since eval: {sizeOptimizer.cyclesSinceEval || 0}</span>
                    <span>Samples: {sizeOptimizer.recentCycleCount || 0}</span>
                  </div>

                  {/* Recent Adjustments */}
                  {sizeOptimizer.adjustmentHistory?.length > 0 && (
                    <div className="pt-2 border-t border-gray-700">
                      <div className="text-gray-500 text-[10px] mb-1">Recent Adjustments</div>
                      <div className="space-y-0.5 max-h-16 overflow-y-auto">
                        {sizeOptimizer.adjustmentHistory.slice(-3).reverse().map((adj, idx) => (
                          <div key={idx} className="text-[10px] text-gray-400 flex justify-between">
                            <span>{new Date(adj.timestamp).toLocaleTimeString()}</span>
                            <span className="text-purple-400">{adj.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Fill Time Stats */}
            {status?.fillTimeStats?.count > 0 && (
              <div className="bg-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-400">Fill Time Stats (7d)</h3>
                  <span className="text-[10px] text-gray-500">
                    {status.fillTimeStats.count} fills
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-gray-400">Avg:</span>{' '}
                      <span className="text-white font-mono">{(status.fillTimeStats.avgMs / 1000).toFixed(1)}s</span>
                    </div>
                    <div>
                      <span className="text-gray-400">P50:</span>{' '}
                      <span className="text-white font-mono">{(status.fillTimeStats.p50Ms / 1000).toFixed(1)}s</span>
                    </div>
                    <div>
                      <span className="text-gray-400">P90:</span>{' '}
                      <span className="text-yellow-400 font-mono">{(status.fillTimeStats.p90Ms / 1000).toFixed(1)}s</span>
                    </div>
                  </div>

                  <div className="flex justify-between text-[10px]">
                    <span className="text-gray-500">
                      Range: {(status.fillTimeStats.minMs / 1000).toFixed(1)}s - {(status.fillTimeStats.maxMs / 1000).toFixed(1)}s
                    </span>
                    <span className={status.fillTimeStats.staleRate > 10 ? 'text-red-400' : 'text-gray-500'}>
                      Stale: {status.fillTimeStats.staleRate}%
                    </span>
                  </div>

                  {status.effectiveStaleMs && (
                    <div className="text-[10px] text-gray-500 pt-1 border-t border-gray-700">
                      Timeout: {(status.effectiveStaleMs / 1000).toFixed(1)}s
                      {status.effectiveStaleMs !== config?.orderStaleMs && (
                        <span className="text-purple-400 ml-1">(regime-adjusted)</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Optimal TP Analytics (dry-run) */}
            {isDryRun && dryRunState?.optimalTpAnalytics && (
              <div className="bg-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-gray-400">Optimal TP Analysis</h3>
                  <span className="text-[10px] text-purple-400">
                    {dryRunState.optimalTpAnalytics.cycleCount} cycles
                  </span>
                </div>

                {/* Current Cycle (if in position) */}
                {dryRunState.optimalTpAnalytics.currentCycle && (
                  <div className="mb-2 p-2 bg-blue-900/30 border border-blue-700/50 rounded">
                    <div className="text-[10px] text-blue-400 mb-1">Current Position</div>
                    <div className="grid grid-cols-2 gap-1 text-[10px]">
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
                    <div className="space-y-1 text-[10px]">
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
                      <div className="mt-2 pt-2 border-t border-gray-700">
                        <div className="text-[10px] text-gray-400 mb-1">Recommended TP Range</div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-700 rounded-full relative overflow-hidden">
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
                        <div className="flex justify-between text-[10px] mt-1">
                          <span className="text-gray-500">0%</span>
                          <span className="text-cyan-400">
                            {dryRunState.optimalTpAnalytics.recommendedTpRange.min?.toFixed(1)}% - {dryRunState.optimalTpAnalytics.recommendedTpRange.max?.toFixed(1)}%
                          </span>
                          <span className="text-gray-500">5%</span>
                        </div>
                        <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
                          <span>Config: {config?.tpMinPercent}%-{config?.tpMaxPercent}%</span>
                          <span className="text-blue-400">|</span>
                          <span>Observed</span>
                          <span className="text-cyan-400">|</span>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-gray-500 text-[10px] text-center py-2">
                    Complete at least one cycle to see analytics
                  </div>
                )}
              </div>
            )}

            {/* Risk Limits */}
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-medium text-gray-400">Risk Limits</h3>
                {risk.isDrawdownPaused && (
                  <button onClick={handleResumeDrawdown} className="px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white text-[10px] rounded flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"></span>
                    Resume
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center">
                  <div className="text-[10px] text-gray-500 mb-1">BTC</div>
                  <div className="text-xs text-white font-mono">{position.totalBTC?.toFixed(4) || 0}</div>
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
                    <div className="h-full bg-orange-500 transition-all" style={{ width: `${Math.min(100, ((position.totalBTC || 0) / (config?.maxBtcExposure || 0.5)) * 100)}%` }} />
                  </div>
                  <div className="text-[9px] text-gray-600">/ {config?.maxBtcExposure || 0.5}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-gray-500 mb-1">USDC</div>
                  <div className="text-xs text-white font-mono">${position.totalCostBasis?.toFixed(0) || 0}</div>
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
                    <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.min(100, ((position.totalCostBasis || 0) / (config?.maxUsdcDeployed || 10000)) * 100)}%` }} />
                  </div>
                  <div className="text-[9px] text-gray-600">/ ${config?.maxUsdcDeployed || 10000}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-gray-500 mb-1">Drawdown</div>
                  <div className={`text-xs font-mono ${position.maxDrawdownSeen > config?.maxDrawdownPercent * 0.8 ? 'text-yellow-400' : 'text-white'}`}>
                    {position.maxDrawdownSeen?.toFixed(1) || 0}%
                  </div>
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
                    <div className="h-full bg-red-500 transition-all" style={{ width: `${Math.min(100, ((position.maxDrawdownSeen || 0) / (config?.maxDrawdownPercent || 20)) * 100)}%` }} />
                  </div>
                  <div className="text-[9px] text-gray-600">/ {config?.maxDrawdownPercent || 20}%</div>
                </div>
              </div>
            </div>
          </div>

          {/* Middle Column: Position & Risk */}
          <div className="space-y-4">
            {/* 3D Celestial Visualization */}
            {status?.celestial?.enabled && (
              <Suspense fallback={<div className="bg-gray-800 rounded-lg p-4 text-xs text-gray-500">Loading celestial system...</div>}>
                <CelestialVisualization
                  celestial={status.celestial}
                  pendingOrders={pendingOrdersList}
                  currentPrice={market.lastPrice}
                  maxUsdcDeployed={config?.maxUsdcDeployed}
                />
              </Suspense>
            )}

            {/* Position */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Position</h3>
                <div className="flex items-center gap-2">
                  {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
                  <span className="text-xs text-gray-500">Buys {position.cycleBuys || position.ladderStep || 0}/{config?.maxCycleBuys || 10}</span>
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
                  <div className="text-gray-500">Realized P&L {apy.totalLiquidValuePercent ? `(${apy.totalLiquidValuePercent.toFixed(2)}%)` : ''}</div>
                  <div className={`font-mono text-base ${position.realizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${position.realizedPnL?.toFixed(2) || '0'}
                    {(position.realizedBtcPnL || 0) > 0 && <span className="text-orange-400 text-xs ml-1">+{position.realizedBtcPnL?.toFixed(8)} BTC</span>}
                    {apy.totalLiquidValue !== undefined && (
                      <span className="text-white text-xs ml-1">= <span className="text-cyan-400">${apy.totalLiquidValue?.toFixed(2)}</span></span>
                    )}
                  </div>
                </div>
              </div>

              {/* Celestial Bodies Summary */}
              {status?.celestial?.enabled && (
                <div className="mt-2 pt-2 border-t border-gray-700 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Celestial Bodies</span>
                    <span className="text-cyan-400 font-mono">{status.celestial.bodiesActive || 0} active / {status.celestial.bodiesCompleted || 0} completed</span>
                  </div>
                </div>
              )}

              {/* Recalculate Button */}
              {!recalcPreview && (
                <button
                  onClick={handleRecalculatePreview}
                  disabled={recalculating}
                  className="mt-2 w-full text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-50 transition-colors"
                >
                  {recalculating ? 'Calculating...' : 'Recalculate from Fills'}
                </button>
              )}

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

                    <div className="text-gray-300">Cycle Buys</div>
                    <div className="text-gray-500">{recalcPreview.changes?.cycleBuys?.before ?? recalcPreview.changes?.ladderStep?.before}</div>
                    <div className={(recalcPreview.changes?.cycleBuys?.before ?? recalcPreview.changes?.ladderStep?.before) !== (recalcPreview.changes?.cycleBuys?.after ?? recalcPreview.changes?.ladderStep?.after) ? 'text-yellow-400' : 'text-gray-500'}>
                      {recalcPreview.changes?.cycleBuys?.after ?? recalcPreview.changes?.ladderStep?.after}
                    </div>
                  </div>

                  {recalcPreview.cycleDetails?.length > 0 && (
                    <div className="mb-3">
                      <div className="text-xs text-gray-400 mb-1">Completed Cycles:</div>
                      {recalcPreview.cycleDetails.map((cycle, i) => (
                        <div key={i} className="text-xs text-gray-500 pl-2">
                          {cycle.cycleId?.replace('cycle-', '#')} - {cycle.buys} buys, P&L: ${cycle.pnl?.toFixed(2)}, holdback: {cycle.holdbackBtc?.toFixed(8)} BTC
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
                    <span>Deposited: ${(apy.depositedCapital || apy.originalCapital || apy.initialCapital)?.toLocaleString()}</span>
                    <span className="text-green-400">Max: ${(apy.maxUsdcDeployed || apy.currentCapital)?.toLocaleString()}</span>
                    <span className="text-cyan-400">Available: ${apy.availableCapital?.toLocaleString()}</span>
                    <span>Running: {apy.elapsedDays?.toFixed(1)}d</span>
                    <span>{apy.cyclesPerDay?.toFixed(1)} cycles/day</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-green-900/20 border border-green-700/30 rounded p-1.5">
                      <div className="text-green-400/70 text-[10px]">Daily ({(apy.dailyReturnPercent || 0).toFixed(2)}%)</div>
                      <div className="flex flex-col font-mono text-xs">
                        <span className="text-green-400">${(apy.estimatedDailyUsdc || 0).toFixed(2)} + <span className="text-orange-400">{(apy.estimatedDailyBtc || 0).toFixed(8)}</span></span>
                        <span className="text-green-400">= ${((apy.estimatedDailyUsdc || 0) + (apy.estimatedDailyBtc || 0) * (market.lastPrice || 0)).toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="bg-cyan-900/20 border border-cyan-700/30 rounded p-1.5">
                      <div className="text-cyan-400/70 text-[10px]">Annual ({(apy.estimatedApy || 0) > 9999 ? '>9999' : (apy.estimatedApy || 0).toFixed(0)}% APY)</div>
                      <div className="flex flex-col font-mono text-xs">
                        <span className="text-green-400">${((apy.estimatedDailyUsdc || 0) * 365).toFixed(2)} + <span className="text-orange-400">{((apy.estimatedDailyBtc || 0) * 365).toFixed(6)} BTC</span></span>
                        <span className="text-cyan-400">= ${(((apy.estimatedDailyUsdc || 0) + (apy.estimatedDailyBtc || 0) * (market.lastPrice || 0)) * 365).toFixed(2)}</span>
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

          </div>

          {/* Right Column: Timeline & Price Chart */}
          <div className="space-y-4">
            {/* Macro Regime Panel */}
            {config?.macroEnabled && status?.macro && (() => {
              const m = status.macro
              const macroStyle = MACRO_COLORS[m.mode] || MACRO_COLORS.RANGING
              const mults = (() => {
                switch (m.mode) {
                  case 'ACCUMULATION': return { size: config.macroAccumulationSizeMult || 1.3, tp: config.macroAccumulationTpMult || 0.85, offset: config.macroAccumulationOffsetMult || 0.8 }
                  case 'MARKUP': return { size: config.macroMarkupSizeMult || 0.7, tp: config.macroMarkupTpMult || 1.3, offset: config.macroMarkupOffsetMult || 1.2 }
                  case 'DECLINE': return { size: config.macroDeclineSizeMult || 0.4, tp: config.macroDeclineTpMult || 0.7, offset: config.macroDeclineOffsetMult || 1.5 }
                  default: return { size: 1.0, tp: 1.0, offset: 1.0 }
                }
              })()
              return (
                <div className={`bg-gray-800 rounded-lg p-3 border ${macroStyle.border}`}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-medium text-gray-400">Macro Regime</h3>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${macroStyle.bg} ${macroStyle.text}`}>
                      {macroStyle.label} ({m.score?.toFixed(0)})
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-500">21h EMA</span>
                      <span className="text-white font-mono">${m.emas?.h21?.toFixed(0) || '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">50h EMA</span>
                      <span className="text-white font-mono">${m.emas?.h50?.toFixed(0) || '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">200h EMA</span>
                      <span className="text-white font-mono">${m.emas?.h200?.toFixed(0) || '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">20d EMA</span>
                      <span className="text-white font-mono">${m.emas?.d20?.toFixed(0) || '-'}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-gray-700">
                    <div className="text-center">
                      <div className="text-[10px] text-gray-500">Size</div>
                      <div className={`text-xs font-mono ${mults.size !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.size}x</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-500">TP</div>
                      <div className={`text-xs font-mono ${mults.tp !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.tp}x</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-500">Offset</div>
                      <div className={`text-xs font-mono ${mults.offset !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.offset}x</div>
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">
                    Updated {m.lastUpdate ? new Date(m.lastUpdate).toLocaleTimeString() : 'never'} | {m.candles?.hourly || 0}h/{m.candles?.daily || 0}d candles
                  </div>
                </div>
              )
            })()}

            {/* Regime Timeline */}
            <RegimeTimeline data={regimeHistory} currentRegime={regime} height={60} />

            <RegimePriceChart
              priceData={priceHistory}
              regimeData={regimeHistory}
              currentPrice={market.lastPrice}
              anchorPrice={position.anchorPrice}
              atr={market.atr1m}
              kFactor={config?.kFactor || 0.6}
              height={280}
            />

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

                {/* Aggressiveness Control */}
                <AggressivenessControl
                  config={config}
                  exchange={exchange}
                  onConfigUpdate={fetchConfig}
                  presets={presets}
                />

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
                  <div>
                    <span className="text-gray-500">Mode</span>
                    <div className={config.dryRun ? 'text-purple-400' : 'text-green-400'}>
                      {config.dryRun ? 'Dry-Run' : 'Live'}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-500">Base Size</span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">${config.baseSizeUsdc}</span>
                      {config.sizeAutoManaged && (
                        <span className="px-1 py-0.5 bg-purple-900/50 text-purple-400 text-xs rounded">Auto</span>
                      )}
                    </div>
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
        </div>

        {/* Orders Section - Stacked vertically */}
        <div className="space-y-4">
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

                  // Build body lookup from status.celestial.bodies for fallback
                  const celestialBodies = status?.celestial?.bodies || []
                  const bodyLookup = new Map(celestialBodies.map(b => [b.tpOrderId, b]))

                  // Build buy orders for each open TP
                  // For body/satellite TPs: use body.buyOrders (filter migration artifacts)
                  // For core TPs: use unconsumed buys from current position
                  const getRelatedBuys = (order) => {
                    const bodyData = (order.type === 'body_tp' || order.type === 'satellite_tp' || order.type === 'take_profit') ? bodyLookup.get(order.orderId) : null
                    if (bodyData?.buyOrders?.length > 0) {
                      const bodyBuys = bodyData.buyOrders.filter(bo => bo.btcQty > 0 && bo.orderId && bo.orderId !== 'core-migration')
                      if (bodyBuys.length > 0) return bodyBuys
                    }

                    // sellOrderId-based lookup from fill ledger (works for all TP types)
                    if (!isDryRun && (order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp')) {
                      const linkedBuys = filteredFills
                        .filter(f => f.side === 'buy' && f.sellOrderId === order.orderId)
                      // Aggregate partial fills by orderId
                      const byOrderId = new Map()
                      linkedBuys.forEach(f => {
                        const ex = byOrderId.get(f.orderId)
                        if (ex) { ex.btcQty += f.size; ex.sizeUsdc += (f.quoteAmount || f.size * f.price) }
                        else byOrderId.set(f.orderId, { orderId: f.orderId, price: f.price, btcQty: f.size, sizeUsdc: f.quoteAmount || f.size * f.price, filledAt: f.timestamp })
                      })
                      if (byOrderId.size > 0) return Array.from(byOrderId.values())
                    }

                    if (order.type === 'take_profit' || order.type === 'body_tp' || order.type === 'satellite_tp') {
                      // Fallback: chronological walk for buys without sellOrderId
                      if (isDryRun) {
                        const sorted = [...(dryRunState?.filledOrders || [])].sort((a, b) => (a.filledAt || a.placedAt || 0) - (b.filledAt || b.placedAt || 0))
                        let pending = []
                        sorted.forEach(o => {
                          if (o.side === 'buy') pending.push({ orderId: o.orderId, price: o.fillPrice || o.price, btcQty: o.size, sizeUsdc: (o.size || 0) * (o.fillPrice || o.price || 0), filledAt: o.filledAt })
                          else if (o.type === 'take_profit') pending = []
                        })
                        return pending
                      }
                      const sorted = [...filteredFills].sort((a, b) => a.timestamp - b.timestamp)
                      const pendingMap = new Map()
                      sorted.forEach(f => {
                        if (f.side === 'buy' && !f.isSatellite) {
                          const ex = pendingMap.get(f.orderId)
                          if (ex) { ex.btcQty += f.size; ex.sizeUsdc += (f.quoteAmount || f.size * f.price) }
                          else pendingMap.set(f.orderId, { orderId: f.orderId, price: f.price, btcQty: f.size, sizeUsdc: f.quoteAmount || f.size * f.price, filledAt: f.timestamp })
                        } else if (f.side === 'sell' && !f.isSatellite) {
                          pendingMap.clear()
                        }
                      })
                      return Array.from(pendingMap.values())
                    }
                    return []
                  }

                  const toggleOrder = (orderId) => {
                    setExpandedOrders(prev => {
                      const next = new Set(prev)
                      if (next.has(orderId)) next.delete(orderId)
                      else next.add(orderId)
                      return next
                    })
                  }

                  // Find highest body TP price for roll-up button visibility
                  const bodyTpOrders = openOrders.filter(o => o.type === 'body_tp' || o.type === 'satellite_tp')
                  const highestBodyTpPrice = bodyTpOrders.reduce((max, o) => Math.max(max, o.price || 0), 0)

                  const ordersWithCalcs = openOrders.map(order => {
                    const age = Date.now() - order.placedAt
                    const isTpOrder = order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp'
                    const bodyData = (order.type === 'body_tp' || order.type === 'satellite_tp' || order.type === 'take_profit') ? bodyLookup.get(order.orderId) : null
                    const orderAvgCost = order.satelliteAvgCost || bodyData?.avgPrice || (isTpOrder ? avgCost : 0)
                    const sellValue = order.size * order.price
                    const estSellFee = sellValue * 0.0006
                    const satCostBasis = order.satelliteCostBasis || bodyData?.costBasis
                    const satBtcQty = order.satelliteBtcQty || bodyData?.btcQty
                    const proratedCost = satCostBasis && satBtcQty
                      ? (satCostBasis / satBtcQty) * order.size
                      : null
                    const estPnl = isTpOrder && orderAvgCost > 0
                      ? (sellValue - estSellFee) - (proratedCost || orderAvgCost * order.size)
                      : null
                    const profitPerBTC = order.price - orderAvgCost
                    const denominator = order.price * (1 - holdbackRatio) + orderAvgCost * holdbackRatio
                    const estHoldback = isTpOrder && profitPerBTC > 0 && denominator > 0
                      ? order.size * profitPerBTC * holdbackRatio / denominator
                      : null
                    const estHoldbackValue = estHoldback ? estHoldback * order.price : null
                    const tpPercent = order.tpPercent
                      || (((order.type === 'satellite_tp' || order.type === 'body_tp' || (order.type === 'take_profit' && bodyData)) && orderAvgCost > 0)
                        ? ((order.price - orderAvgCost) / orderAvgCost * 100).toFixed(2)
                        : null)
                    const relatedBuys = isTpOrder ? getRelatedBuys(order) : []

                    return { ...order, age, estPnl, estSellFee, estHoldback, estHoldbackValue, tpPercent, relatedBuys }
                  }).sort((a, b) => (b.price || 0) - (a.price || 0))

                  return (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-400 text-xs border-b border-gray-700">
                          <th className="text-left py-2 pr-1 w-6"></th>
                          <th className="text-left py-2 pr-2">Order ID</th>
                          <th className="text-left py-2 pr-2">Type</th>
                          <th className="text-right py-2 pr-2">TP%</th>
                          <th className="text-right py-2 pr-2">Size (BTC)</th>
                          <th className="text-right py-2 pr-2">Price</th>
                          <th className="text-right py-2 pr-2">Value</th>
                          <th className="text-right py-2 pr-2">Est. P&L</th>
                          <th className="text-right py-2 pr-2">Holdback</th>
                          <th className="text-right py-2 pr-2">Age</th>
                          <th className="py-2 w-6"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersWithCalcs.map((order) => {
                          const isExpanded = expandedOrders.has(order.orderId)
                          const isTp = order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp'
                          const hasBuys = order.relatedBuys.length > 0

                          return (
                            <React.Fragment key={order.orderId}>
                              <tr
                                className={`border-b border-gray-700/50 ${isTp && hasBuys ? 'cursor-pointer' : ''} hover:bg-gray-700/30`}
                                onClick={isTp && hasBuys ? () => toggleOrder(order.orderId) : undefined}
                              >
                                <td className="py-2 pr-1 text-gray-500 text-xs">
                                  {isTp && hasBuys ? (
                                    <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-2 font-mono text-gray-500 text-xs">
                                  {order.orderId}
                                  {hasBuys && <span className="text-gray-600 ml-1">({order.relatedBuys.length} {order.relatedBuys.length === 1 ? 'buy' : 'buys'})</span>}
                                </td>
                                <td className="py-2 pr-2">
                                  {(() => {
                                    const bodyInfo = (order.type === 'body_tp' || order.type === 'satellite_tp' || order.type === 'take_profit') ? bodyLookup.get(order.orderId) : null;
                                    const tier = bodyInfo?.tier || (order.type === 'satellite_tp' ? 'satellite' : null);
                                    const tierStyles = {
                                      satellite:  { bg: 'bg-gray-700/60',    text: 'text-gray-300',    tooltip: 'Satellite — individual order, 1–3× base' },
                                      moon:       { bg: 'bg-slate-600/50',   text: 'text-slate-300',   tooltip: 'Moon — small cluster, 3–10× base' },
                                      planet:     { bg: 'bg-blue-900/50',    text: 'text-blue-400',    tooltip: 'Planet — substantial mass, 10–100× base' },
                                      sun:        { bg: 'bg-amber-900/50',   text: 'text-amber-400',   tooltip: 'Sun — large mass, 100–500× base' },
                                      hypergiant: { bg: 'bg-purple-900/50',  text: 'text-purple-400',  tooltip: 'Hypergiant — massive mass, 500–1000× base' },
                                      galaxy:     { bg: 'bg-pink-900/50',    text: 'text-pink-400',    tooltip: 'Galaxy — galactic mass, 1000–5000× base' },
                                      black_hole: { bg: 'bg-red-900/50',     text: 'text-red-400',     tooltip: 'Black Hole — critical mass, 5000×+ base' },
                                    };
                                    if (order.type === 'entry') {
                                      return <span className="px-1.5 py-0.5 rounded text-xs bg-emerald-900/50 text-emerald-400" title="Limit buy entry order">Entry</span>;
                                    }
                                    if (tier && tierStyles[tier]) {
                                      const s = tierStyles[tier];
                                      const emoji = order.tierEmoji || bodyInfo?.emoji || '🛰️';
                                      return <span className={`px-1.5 py-0.5 rounded text-xs ${s.bg} ${s.text}`} title={s.tooltip}>{emoji}</span>;
                                    }
                                    return <span className="px-1.5 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-400" title="Take-profit sell order">TP</span>;
                                  })()}
                                </td>
                                <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                                  {order.tpPercent ? `${order.tpPercent}%` : '—'}
                                </td>
                                <td className="text-right py-2 pr-2 font-mono text-white">
                                  {order.size?.toFixed(8)}
                                </td>
                                <td className="text-right py-2 pr-2 font-mono text-white">
                                  ${order.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td className="text-right py-2 pr-2 font-mono text-gray-300 text-xs">
                                  ${(order.size * order.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td className={`text-right py-2 pr-2 font-mono text-xs ${order.estPnl !== null ? (order.estPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`} title={order.estSellFee ? `After est. sell fee: $${order.estSellFee.toFixed(4)}` : undefined}>
                                  {order.estPnl !== null ? `${order.estPnl >= 0 ? '+' : ''}$${order.estPnl.toFixed(2)}` : '—'}
                                </td>
                                <td className="text-right py-2 pr-2 font-mono text-xs text-cyan-400">
                                  {order.estHoldback !== null ? (
                                    <span title={`≈$${order.estHoldbackValue?.toFixed(2)}`}>+{order.estHoldback.toFixed(8)}</span>
                                  ) : '—'}
                                </td>
                                <td className="text-right py-2 pr-2 font-mono text-gray-500 text-xs">
                                  {formatDuration(order.age)}
                                </td>
                                <td className="py-2 text-center">
                                  {(() => {
                                    const isBodyTp = order.type === 'body_tp' || order.type === 'satellite_tp'
                                    const canRollUp = isBodyTp && isRunning && celestialBodies.length >= 2 && order.price < highestBodyTpPrice
                                    if (!canRollUp) return null
                                    const bodyData = bodyLookup.get(order.orderId)
                                    if (!bodyData) return null
                                    // Find the next-highest body to show in confirmation
                                    const targetBody = celestialBodies
                                      .filter(b => b.tpPrice > (bodyData.tpPrice || order.price))
                                      .sort((a, b) => a.tpPrice - b.tpPrice)[0]
                                    if (!targetBody) return null
                                    const srcLabel = `${bodyData.id?.slice(-8)} ($${bodyData.costBasis?.toFixed(0)})`
                                    const tgtLabel = `${targetBody.id?.slice(-8)} ($${targetBody.costBasis?.toFixed(0)})`
                                    return (
                                      <button
                                        title={`Roll up into ${tgtLabel}`}
                                        className="px-1 py-0.5 text-xs text-yellow-400 hover:text-yellow-300 hover:bg-yellow-900/30 rounded transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setRollUpConfirm({ bodyId: bodyData.id, bodyLabel: srcLabel, targetLabel: tgtLabel })
                                        }}
                                      >
                                        ↑
                                      </button>
                                    )
                                  })()}
                                </td>
                              </tr>
                              {/* Buy sub-rows */}
                              {isExpanded && order.relatedBuys.map((buy, idx) => (
                                <tr key={`${order.orderId}-buy-${buy.orderId}-${idx}`} className="border-b border-gray-700/30 bg-gray-750/20">
                                  <td className="py-1 pr-1"></td>
                                  <td className="py-1 pr-2 font-mono text-xs text-gray-500 pl-4">
                                    <span className="text-green-400/70 mr-1">BUY</span>
                                    {buy.orderId}
                                  </td>
                                  <td className="py-1 pr-2"></td>
                                  <td className="py-1 pr-2"></td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                    {buy.btcQty?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                    ${buy.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="text-right py-1 pr-2 font-mono text-xs text-gray-500">
                                    ${buy.sizeUsdc?.toFixed(2)}
                                  </td>
                                  <td className="py-1 pr-2"></td>
                                  <td className="text-right py-1 font-mono text-xs text-gray-500">
                                    {formatTimestamp(buy.filledAt)}
                                  </td>
                                  <td className="py-1"></td>
                                </tr>
                              ))}
                            </React.Fragment>
                          )
                        })}
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
                    onClick={() => { setShowAllCycles(!showAllCycles); setExpandedCycles(new Set()); cycleInitRef.current = false }}
                    className={`text-xs px-2 py-1 rounded transition-colors ${
                      showAllCycles
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {showAllCycles ? 'All Cycles' : 'Current Cycle'}
                  </button>
                )}
                {((isDryRun && dryRunState?.filledOrders?.length > 0) || (!isDryRun && filteredFills.length > 0)) && (
                  <span className="text-xs text-gray-500">
                    {isDryRun
                      ? dryRunState.filledOrders.length
                      : filteredFills.length
                    } fills
                    {!isDryRun && (() => {
                      const cc = new Set(filteredFills.map(f => f.cycleId).filter(Boolean)).size
                      return cc > 0 ? ` (${cc} ${cc === 1 ? 'cycle' : 'cycles'})` : ''
                    })()}
                  </span>
                )}
              </div>
            </div>
            {(isDryRun
              ? (dryRunState?.filledOrders?.length || 0)
              : filteredFills.length
            ) === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">
                {!isDryRun && liveFills?.length > 0 && !showAllCycles
                  ? 'No fills in current cycle (toggle to see all cycles)'
                  : 'No filled orders yet'
                }
              </div>
            ) : (
              /* Filled Sells with expandable buy sub-rows */
              <div>
                {(() => {
                  const toggleFill = (key) => {
                    setExpandedFills(prev => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }

                  // Build sell groups: each = { sell, buys[], key }
                  let sellGroups = []
                  let orphanedBuys = []

                  if (isDryRun) {
                    // Walk chronologically: buys accumulate until a core sell consumes them
                    // Satellite sells don't consume from the buy pool
                    const sorted = [...(dryRunState?.filledOrders || [])].sort((a, b) => (a.filledAt || a.placedAt || 0) - (b.filledAt || b.placedAt || 0))
                    let pendingBuys = []
                    sorted.forEach(order => {
                      if (order.side === 'buy') {
                        pendingBuys.push(order)
                      } else if (order.isSatellite || order.type === 'satellite_tp' || order.type === 'body_tp') {
                        // Satellite/body sell: doesn't consume core buys, show with empty buys
                        sellGroups.push({ sell: order, buys: [], key: `fill-${order.orderId}` })
                      } else {
                        // Core sell: consumes accumulated buys
                        sellGroups.push({ sell: order, buys: [...pendingBuys], key: `fill-${order.orderId}` })
                        pendingBuys = []
                      }
                    })
                    sellGroups.reverse()
                  } else {
                    // Live: sellOrderId-based grouping with chronological fallback
                    // First aggregate partial fills by orderId
                    const aggregateByOrderId = (fills) => {
                      const m = new Map()
                      fills.forEach(f => {
                        const ex = m.get(f.orderId)
                        if (ex) {
                          ex.size += f.size; ex.quoteAmount = (ex.quoteAmount || 0) + (f.quoteAmount || 0)
                          ex.netFee = (ex.netFee || 0) + (f.netFee || 0); ex.partialCount = (ex.partialCount || 1) + 1
                          // Preserve sellOrderId from any partial fill that has it
                          if (f.sellOrderId && !ex.sellOrderId) ex.sellOrderId = f.sellOrderId
                        } else m.set(f.orderId, { ...f, partialCount: 1 })
                      })
                      return Array.from(m.values())
                    }

                    // P&L calculation on raw fills
                    const sortedAll = [...filteredFills].sort((a, b) => a.timestamp - b.timestamp)
                    let runBtc = 0, runCost = 0
                    const pnlMap = new Map()
                    sortedAll.forEach(fill => {
                      if (fill.side === 'buy') {
                        if (!fill.isSatellite) { runBtc += fill.size; runCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || fill.fee || 0) }
                      } else if (fill.isSatellite) {
                        const pnl = fill.satellitePnl != null ? fill.satellitePnl : (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0) - (fill.satelliteCostBasis || 0)
                        const prev = pnlMap.get(fill.orderId)
                        if (prev) { prev.pnl += pnl; prev.holdback += (fill.satelliteHoldbackBtc || 0) }
                        else pnlMap.set(fill.orderId, { pnl, holdback: fill.satelliteHoldbackBtc || 0 })
                      } else {
                        const avgCost = runBtc > 0 ? runCost / runBtc : 0
                        const proceeds = (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0)
                        const pnl = proceeds - avgCost * fill.size
                        const prev = pnlMap.get(fill.orderId)
                        if (prev) { prev.pnl += pnl }
                        else pnlMap.set(fill.orderId, { pnl, holdback: 0 })
                        const rem = runBtc - fill.size
                        runBtc = rem > 0 ? rem : 0
                        runCost = rem > 0 ? avgCost * rem : 0
                      }
                    })

                    // Aggregate fills by orderId
                    const aggBuysAll = aggregateByOrderId(filteredFills.filter(f => f.side === 'buy'))
                    const aggSellsAll = aggregateByOrderId(filteredFills.filter(f => f.side === 'sell'))

                    // Group all buys by sellOrderId for direct lookup
                    const buysBySellOrderId = new Map()
                    aggBuysAll.forEach(buy => {
                      const sid = buy.sellOrderId
                      if (!sid) return
                      if (!buysBySellOrderId.has(sid)) buysBySellOrderId.set(sid, [])
                      buysBySellOrderId.get(sid).push(buy)
                    })

                    // Redirect orphaned buys (sellOrderId points to non-existent sell) to real sell via bodyId
                    // This handles TP re-placement: buys linked to old TP orderId get redirected to the actual fill
                    const knownSellIds = new Set(aggSellsAll.map(s => s.orderId))
                    const sellIdByBodyId = new Map()
                    aggSellsAll.forEach(s => { if (s.bodyId) sellIdByBodyId.set(s.bodyId, s.orderId) })
                    // Learn bodyId from any annotated buy sharing an orphaned sellOrderId
                    const bodyIdByOrphanSellId = new Map()
                    aggBuysAll.forEach(buy => {
                      if (buy.sellOrderId && !knownSellIds.has(buy.sellOrderId) && buy.bodyId) {
                        bodyIdByOrphanSellId.set(buy.sellOrderId, buy.bodyId)
                      }
                    })
                    // Redirect orphaned buys to real sell
                    aggBuysAll.forEach(buy => {
                      const sid = buy.sellOrderId
                      if (!sid || knownSellIds.has(sid)) return
                      const bodyId = buy.bodyId || bodyIdByOrphanSellId.get(sid)
                      if (!bodyId) return
                      const realSellId = sellIdByBodyId.get(bodyId)
                      if (!realSellId) return
                      if (!buysBySellOrderId.has(realSellId)) buysBySellOrderId.set(realSellId, [])
                      // Avoid duplicates (buy may already be in list from bodyId annotation)
                      const existing = buysBySellOrderId.get(realSellId)
                      if (!existing.some(b => b.orderId === buy.orderId)) existing.push(buy)
                    })

                    // Fallback: group buys by bodyId for sells with no sellOrderId linkage
                    const buysByBodyId = new Map()
                    aggBuysAll.forEach(buy => {
                      if (!buy.bodyId) return
                      if (!buysByBodyId.has(buy.bodyId)) buysByBodyId.set(buy.bodyId, [])
                      buysByBodyId.get(buy.bodyId).push(buy)
                    })

                    // Build sell groups: sellOrderId first, bodyId fallback, uniform for all sell types
                    aggSellsAll.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                    aggSellsAll.forEach(order => {
                      const pnlData = pnlMap.get(order.orderId)
                      const sell = { ...order, pnl: pnlData?.pnl ?? null, holdback: pnlData?.holdback ?? null }
                      const linkedBuys = buysBySellOrderId.get(order.orderId)
                      const bodyBuys = (!linkedBuys || linkedBuys.length === 0) && order.bodyId
                        ? buysByBodyId.get(order.bodyId) || []
                        : null
                      const buys = linkedBuys || bodyBuys || []
                      if (buys.length > 0) {
                        const buyTotal = buys.reduce((s, b) => s + (b.size || 0), 0)
                        sell.holdback = Math.max(0, buyTotal - (sell.size || 0))
                      }
                      sellGroups.push({ sell, buys, key: `fill-${order.orderId}` })
                    })
                    sellGroups.reverse()

                    // Recompute P&L from linked buys (more accurate than chronological running average)
                    sellGroups.forEach(group => {
                      if (group.buys.length === 0) return
                      const buyCost = group.buys.reduce((s, b) => s + (b.quoteAmount || b.size * b.price) + (b.netFee || b.fee || 0), 0)
                      const sellProceeds = (group.sell.quoteAmount || group.sell.size * group.sell.price) - (group.sell.netFee || group.sell.fee || 0)
                      group.sell.pnl = sellProceeds - buyCost
                    })

                    // Find orphaned buys: not linked to any filled sell and not waiting on an open TP
                    const claimedBuyIds = new Set()
                    sellGroups.forEach(g => g.buys.forEach(b => claimedBuyIds.add(b.orderId)))
                    orphanedBuys = aggBuysAll
                      .filter(b => !claimedBuyIds.has(b.orderId) && !b.sellOrderId && !b.bodyId)
                      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                  }

                  if (sellGroups.length === 0) {
                    return <div className="text-gray-500 text-sm text-center py-4">No filled sells yet</div>
                  }

                  // Totals (holdback computed after cycleMap for live mode)
                  const totalPnl = sellGroups.reduce((s, g) => s + (g.sell.pnl || 0), 0)
                  let totalHoldback = isDryRun ? sellGroups.reduce((s, g) => s + (g.sell.holdbackBtc || 0), 0) : 0

                  // Shared sell + buy row renderer
                  const renderSellRow = (group) => {
                    const isExpanded = expandedFills.has(group.key)
                    const sell = group.sell
                    const buys = group.buys
                    const sellPrice = sell.fillPrice || sell.price
                    const sellValue = sell.quoteAmount || ((sell.size || 0) * (sellPrice || 0))
                    const sellPnl = sell.pnl ?? sell.satellitePnl ?? null
                    const sellHoldback = isDryRun ? sell.holdbackBtc : sell.holdback
                    const sellTime = sell.filledAt || sell.timestamp

                    return (
                      <React.Fragment key={group.key}>
                        <tr
                          className="border-b border-gray-700 cursor-pointer hover:bg-gray-700/40 transition-colors"
                          onClick={() => toggleFill(group.key)}
                        >
                          <td className="py-1.5 pr-1 text-gray-500 text-xs">
                            <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-xs text-gray-400">
                            {sell.orderId}
                            {buys.length > 0 && <span className="text-gray-600 ml-1">({buys.length} {buys.length === 1 ? 'buy' : 'buys'})</span>}
                            {buys.length === 0 && sell.duplicateTpNote && <span className="text-yellow-600/70 ml-1" title={sell.duplicateTpNote}>(dup TP)</span>}
                            {buys.length === 0 && sell.untrackedSell && !sell.duplicateTpNote && <span className="text-yellow-600/70 ml-1">(orphan)</span>}
                          </td>
                          <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                            {sell.size?.toFixed(8)}
                          </td>
                          <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                            ${sellPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="text-right py-1.5 pr-2 font-mono text-gray-400 text-xs">
                            ${sellValue.toFixed(2)}
                          </td>
                          <td className={`text-right py-1.5 pr-2 font-mono text-xs ${
                            sellPnl !== null ? (sellPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'
                          }`}>
                            {sellPnl !== null ? `${sellPnl >= 0 ? '+' : ''}$${sellPnl.toFixed(2)}` : '—'}
                            {sellHoldback > 0 && <span className="ml-1 text-cyan-400" title="Holdback BTC">+{sellHoldback.toFixed(8)}</span>}
                          </td>
                          <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                            {formatTimestamp(sellTime)}
                          </td>
                        </tr>
                        {isExpanded && buys.length === 0 && (sell.duplicateTpNote || sell.untrackedSell) && (
                          <tr className="border-b border-gray-700/30 bg-gray-750/20">
                            <td className="py-1 pr-1"></td>
                            <td colSpan={6} className="py-1.5 pl-5 text-xs text-yellow-600/70 italic">
                              {sell.duplicateTpNote || 'Untracked sell — buy orders linked to original TP'}
                              {sell.satelliteCostBasis > 0 && <span className="ml-2 text-gray-500">Cost basis: ${sell.satelliteCostBasis.toFixed(2)}</span>}
                            </td>
                          </tr>
                        )}
                        {isExpanded && buys.map((buy, idx) => {
                          const buyPrice = buy.fillPrice || buy.price
                          const buyValue = buy.quoteAmount || ((buy.size || 0) * (buyPrice || 0))
                          const buyTime = buy.filledAt || buy.timestamp
                          const fillTimeMs = isDryRun
                            ? (buy.filledAt && buy.placedAt ? buy.filledAt - buy.placedAt : null)
                            : buy.fillTimeMs
                          return (
                            <tr key={`${group.key}-buy-${buy.orderId || buy.tradeId}-${idx}`}
                              className="border-b border-gray-700/30 bg-gray-750/20"
                            >
                              <td className="py-1 pr-1"></td>
                              <td className="py-1 pr-2 font-mono text-xs text-gray-500 pl-5">
                                <span className="text-green-400/70 mr-1">BUY</span>
                                {buy.orderId}
                              </td>
                              <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                {buy.size?.toFixed(8)}
                              </td>
                              <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                ${buyPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="text-right py-1 pr-2 font-mono text-xs text-gray-500">
                                ${buyValue.toFixed(2)}
                              </td>
                              <td className="text-right py-1 pr-2 font-mono text-xs text-gray-600">
                                {fillTimeMs !== null ? formatDuration(fillTimeMs) : ''}
                              </td>
                              <td className="text-right py-1 font-mono text-xs text-gray-500">
                                {formatTimestamp(buyTime)}
                              </td>
                            </tr>
                          )
                        })}
                      </React.Fragment>
                    )
                  }

                  const tableHeader = (
                    <tr className="text-gray-400 text-xs border-b border-gray-700">
                      <th className="text-left py-1.5 pr-1 w-6"></th>
                      <th className="text-left py-1.5 pr-2">Order ID</th>
                      <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                      <th className="text-right py-1.5 pr-2">Price</th>
                      <th className="text-right py-1.5 pr-2">Value</th>
                      <th className="text-right py-1.5 pr-2">P&L</th>
                      <th className="text-right py-1.5">Filled</th>
                    </tr>
                  )

                  // --- DryRun: flat table (no cycle grouping) ---
                  if (isDryRun) {
                    return (
                      <div className="overflow-x-auto max-h-96 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-gray-800 z-10">
                            {tableHeader}
                          </thead>
                          <tbody>
                            {sellGroups.length > 1 && (
                              <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                <td className="py-1.5 pr-1"></td>
                                <td className="py-1.5 pr-2 text-gray-400 text-xs" colSpan={4}>Totals ({sellGroups.length} sells)</td>
                                <td className={`text-right py-1.5 pr-2 font-mono text-xs ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                  {totalPnl !== 0 ? `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` : '—'}
                                  {totalHoldback > 0 && <span className="ml-1 text-cyan-400" title="Total holdback">+{totalHoldback.toFixed(8)}</span>}
                                </td>
                                <td className="text-right py-1.5"></td>
                              </tr>
                            )}
                            {sellGroups.map(renderSellRow)}
                          </tbody>
                        </table>
                      </div>
                    )
                  }

                  // --- Live: cycle-grouped layout ---
                  const cycleMap = new Map()
                  sellGroups.forEach(group => {
                    const cid = group.sell.cycleId || 'unknown'
                    if (!cycleMap.has(cid)) cycleMap.set(cid, { cycleId: cid, sells: [], totalSize: 0, totalPnl: 0, totalHoldback: 0, buyCount: 0, minTs: Infinity, maxTs: 0 })
                    const entry = cycleMap.get(cid)
                    entry.sells.push(group)
                    entry.totalSize += group.sell.size || 0
                    entry.totalPnl += group.sell.pnl || 0
                    if (isDryRun) {
                      entry.totalHoldback += group.sell.holdbackBtc || 0
                    }
                    entry.buyCount += group.buys.length
                    const sellTs = group.sell.timestamp || group.sell.filledAt || 0
                    if (sellTs > 0) { entry.minTs = Math.min(entry.minTs, sellTs); entry.maxTs = Math.max(entry.maxTs, sellTs) }
                    group.buys.forEach(b => {
                      const buyTs = b.timestamp || b.filledAt || 0
                      if (buyTs > 0) { entry.minTs = Math.min(entry.minTs, buyTs); entry.maxTs = Math.max(entry.maxTs, buyTs) }
                    })
                  })
                  // For live mode, compute holdback per cycle from raw fills (total bought - total sold)
                  if (!isDryRun) {
                    const cycleBuySizes = new Map()
                    const cycleSellSizes = new Map()
                    filteredFills.forEach(f => {
                      const cid = f.cycleId || 'unknown'
                      if (f.side === 'buy') cycleBuySizes.set(cid, (cycleBuySizes.get(cid) || 0) + f.size)
                      else if (f.side === 'sell') cycleSellSizes.set(cid, (cycleSellSizes.get(cid) || 0) + f.size)
                    })
                    cycleMap.forEach(entry => {
                      const buySize = cycleBuySizes.get(entry.cycleId) || 0
                      const sellSize = cycleSellSizes.get(entry.cycleId) || 0
                      entry.totalHoldback += Math.max(0, buySize - sellSize)
                    })
                    cycleMap.forEach(entry => { totalHoldback += entry.totalHoldback })
                  }
                  const cycleGroups = Array.from(cycleMap.values()).sort((a, b) => {
                    if (a.cycleId === 'unknown') return 1
                    if (b.cycleId === 'unknown') return -1
                    const numA = parseInt(a.cycleId.replace('cycle-', '')) || 0
                    const numB = parseInt(b.cycleId.replace('cycle-', '')) || 0
                    return numB - numA
                  })

                  return (
                    <div className="overflow-x-auto max-h-96 overflow-y-auto space-y-2">
                      {/* Grand totals bar */}
                      {cycleGroups.length > 0 && (
                        <div className="flex items-center justify-between px-2 py-1.5 bg-gray-700/30 rounded text-xs">
                          <span className="text-gray-400">{sellGroups.length} sells across {cycleGroups.length} {cycleGroups.length === 1 ? 'cycle' : 'cycles'}</span>
                          <span className={`font-mono ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {totalPnl !== 0 ? `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` : '—'}
                            {totalHoldback > 0 && <span className="ml-1 text-cyan-400">+{totalHoldback.toFixed(8)}</span>}
                          </span>
                        </div>
                      )}
                      {/* Orphaned buys (not linked to any sell) */}
                      {!isDryRun && orphanedBuys && orphanedBuys.length > 0 && (
                        <div className="border border-yellow-700/40 rounded-lg overflow-hidden">
                          <div
                            className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-700/40 transition-colors"
                            onClick={() => {
                              setExpandedCycles(prev => {
                                const next = new Set(prev)
                                if (next.has('orphans')) next.delete('orphans')
                                else next.add('orphans')
                                return next
                              })
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`inline-block transition-transform text-xs text-gray-500 ${expandedCycles.has('orphans') ? 'rotate-90' : ''}`}>&#9654;</span>
                              <span className="px-2 py-0.5 rounded text-xs bg-yellow-900/50 text-yellow-400">Orphaned</span>
                              <span className="text-xs text-gray-500">{orphanedBuys.length} buys not linked to any sell</span>
                            </div>
                            <span className="font-mono text-xs text-yellow-400">{orphanedBuys.reduce((s, b) => s + (b.size || 0), 0).toFixed(8)} BTC</span>
                          </div>
                          {expandedCycles.has('orphans') && (
                            <div className="border-t border-gray-700">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-gray-400 text-xs border-b border-gray-700">
                                    <th className="text-left py-1.5 pr-1 w-6"></th>
                                    <th className="text-left py-1.5 pr-2">Order ID</th>
                                    <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                    <th className="text-right py-1.5 pr-2">Price</th>
                                    <th className="text-right py-1.5 pr-2">Value</th>
                                    <th className="text-right py-1.5 pr-2">Cycle</th>
                                    <th className="text-right py-1.5">Filled</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {orphanedBuys.map((buy, idx) => {
                                    const buyPrice = buy.fillPrice || buy.price
                                    const buyValue = buy.quoteAmount || ((buy.size || 0) * (buyPrice || 0))
                                    return (
                                      <tr key={`orphan-${buy.orderId}-${idx}`} className="border-b border-gray-700/30">
                                        <td className="py-1 pr-1"></td>
                                        <td className="py-1 pr-2 font-mono text-xs text-yellow-400/70">
                                          {buy.orderId}
                                        </td>
                                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                          {buy.size?.toFixed(8)}
                                        </td>
                                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-300">
                                          ${buyPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </td>
                                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-500">
                                          ${buyValue.toFixed(2)}
                                        </td>
                                        <td className="text-right py-1 pr-2 font-mono text-xs text-gray-600">
                                          {buy.cycleId?.replace('cycle-', '#') || '—'}
                                        </td>
                                        <td className="text-right py-1 font-mono text-xs text-gray-500">
                                          {formatTimestamp(buy.timestamp || buy.filledAt)}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                      {cycleGroups.map(cycle => {
                        const isCurrentCycle = cycle.cycleId === mostRecentCycleId
                        const isCycleExpanded = expandedCycles.has(cycle.cycleId)
                        const cycleLabel = cycle.cycleId === 'unknown' ? 'Unassigned' : cycle.cycleId.replace('cycle-', '#')

                        return (
                          <div key={cycle.cycleId} className="border border-gray-700 rounded-lg overflow-hidden">
                            <div
                              className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-700/40 transition-colors"
                              onClick={() => {
                                setExpandedCycles(prev => {
                                  const next = new Set(prev)
                                  if (next.has(cycle.cycleId)) next.delete(cycle.cycleId)
                                  else next.add(cycle.cycleId)
                                  return next
                                })
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`inline-block transition-transform text-xs text-gray-500 ${isCycleExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                                <span className={`px-2 py-0.5 rounded text-xs ${
                                  cycle.cycleId === 'unknown'
                                    ? 'bg-gray-700 text-gray-400'
                                    : isCurrentCycle
                                      ? 'bg-blue-900/50 text-blue-400'
                                      : 'bg-green-900/50 text-green-400'
                                }`}>
                                  {cycleLabel}
                                </span>
                                <span className="text-xs text-gray-500">
                                  {cycle.sells.length} {cycle.sells.length === 1 ? 'sell' : 'sells'}, {cycle.buyCount} {cycle.buyCount === 1 ? 'buy' : 'buys'}
                                </span>
                                {cycle.minTs < Infinity && (
                                  <span className="text-[10px] text-gray-600 font-mono">
                                    {new Date(cycle.minTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                    {cycle.maxTs > cycle.minTs && ` – ${new Date(cycle.maxTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                                  </span>
                                )}
                              </div>
                              <span className={`font-mono text-xs ${cycle.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {cycle.totalPnl !== 0 ? `${cycle.totalPnl >= 0 ? '+' : ''}$${cycle.totalPnl.toFixed(2)}` : '—'}
                                {cycle.totalHoldback > 0 && <span className="ml-1 text-cyan-400">+{cycle.totalHoldback.toFixed(8)}</span>}
                              </span>
                            </div>
                            {isCycleExpanded && (
                              <div className="border-t border-gray-700">
                                <table className="w-full text-sm">
                                  <thead>
                                    {tableHeader}
                                  </thead>
                                  <tbody>
                                    {cycle.sells.map(renderSellRow)}
                                    {cycle.sells.length > 1 && (
                                      <tr className="border-t border-gray-600 bg-gray-700/20">
                                        <td className="py-1.5 pr-1"></td>
                                        <td className="py-1.5 pr-2 text-gray-500 text-xs">Subtotal ({cycle.sells.length} sells)</td>
                                        <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">{cycle.totalSize.toFixed(8)}</td>
                                        <td className="text-right py-1.5 pr-2"></td>
                                        <td className="text-right py-1.5 pr-2"></td>
                                        <td className={`text-right py-1.5 pr-2 font-mono text-xs ${cycle.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                          {cycle.totalPnl !== 0 ? `${cycle.totalPnl >= 0 ? '+' : ''}$${cycle.totalPnl.toFixed(2)}` : '—'}
                                          {cycle.totalHoldback > 0 && <span className="ml-1 text-cyan-400">+{cycle.totalHoldback.toFixed(8)}</span>}
                                        </td>
                                        <td className="text-right py-1.5"></td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        </div>
        </>
      )}

      {/* Roll-up confirmation dialog */}
      {rollUpConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !rollingUp && setRollUpConfirm(null)}>
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white text-lg font-medium mb-3">Roll Up Body</h3>
            <p className="text-gray-300 text-sm mb-4">
              Merge body <span className="font-mono text-yellow-400">{rollUpConfirm.bodyLabel}</span> into <span className="font-mono text-green-400">{rollUpConfirm.targetLabel}</span>?
            </p>
            <p className="text-gray-500 text-xs mb-4">
              Both TP orders will be cancelled, buys combined, and a new TP placed for the merged body.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                onClick={() => setRollUpConfirm(null)}
                disabled={rollingUp}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm text-white bg-yellow-600 hover:bg-yellow-500 rounded transition-colors disabled:opacity-50"
                onClick={() => handleRollUp(rollUpConfirm.bodyId)}
                disabled={rollingUp}
              >
                {rollingUp ? 'Merging...' : 'Roll Up'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default RegimeDashboard
