import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
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
}

// Macro regime mode colors
const MACRO_COLORS = {
  ACCUMULATION: { bg: 'bg-blue-900/50', border: 'border-blue-500', text: 'text-blue-400', label: 'Accumulation' },
  RANGING: { bg: 'bg-gray-800/50', border: 'border-gray-500', text: 'text-gray-400', label: 'Ranging' },
  MARKUP: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400', label: 'Markup' },
  DECLINE: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400', label: 'Decline' },
}

// Aggressiveness level definitions with exact parameter values from the plan
const AGGRESSIVENESS_LEVELS = [
  {
    id: 'conservative',
    label: 'Conservative',
    color: 'green',
    params: {
      kFactor: 0.8,
      minIntervalMs: 180000,  // 3min
      maxIntervalMs: 7200000, // 2hr
      entryOffsetBps: 25,
      baseSizeUsdc: 25,
      cautionScale: 0.15,
      trendScale: 0,
      maxLadderSteps: 10,
    },
  },
  {
    id: 'moderate',
    label: 'Moderate',
    color: 'blue',
    params: {
      kFactor: 0.65,
      minIntervalMs: 120000,  // 2min
      maxIntervalMs: 3600000, // 1hr
      entryOffsetBps: 18,
      baseSizeUsdc: 50,
      cautionScale: 0.35,
      trendScale: 0.1,
      maxLadderSteps: 15,
    },
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    color: 'yellow',
    params: {
      kFactor: 0.5,
      minIntervalMs: 90000,   // 90s
      maxIntervalMs: 2400000, // 40min
      entryOffsetBps: 12,
      baseSizeUsdc: 100,
      cautionScale: 0.6,
      trendScale: 0.25,
      maxLadderSteps: 25,
    },
  },
  {
    id: 'maximum',
    label: 'Maximum',
    color: 'red',
    params: {
      kFactor: 0.3,
      minIntervalMs: 60000,   // 1min
      maxIntervalMs: 1200000, // 20min
      entryOffsetBps: 5,
      baseSizeUsdc: 200,
      cautionScale: 1.0,
      trendScale: 0.5,
      maxLadderSteps: 50,
    },
  },
]

// Get parameter values for a given level
const computeAggressivenessParams = (levelId) => {
  const level = AGGRESSIVENESS_LEVELS.find(l => l.id === levelId)
  return level ? { ...level.params } : null
}

// Detect current aggressiveness level from config based on actual parameter values
const detectAggressivenessLevel = (config) => {
  if (!config) return null

  // When config is partial (e.g. initial load), fall back to stored aggressiveness field
  const firstPreset = AGGRESSIVENESS_LEVELS[0]
  const presetKeys = Object.keys(firstPreset.params)
  const hasAllKeys = presetKeys.every(key => config[key] !== undefined)
  if (!hasAllKeys) return config.aggressiveness || null

  // Detect based on actual parameter values (not the stored aggressiveness field)
  // This ensures the UI reflects reality even if the field is out of sync
  for (const level of AGGRESSIVENESS_LEVELS) {
    const expected = level.params
    const allMatch = Object.entries(expected).every(([key, value]) => {
      const current = config[key]
      // Allow small tolerance for floating point
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
function AggressivenessControl({ config, exchange, onConfigUpdate }) {
  const [updating, setUpdating] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewLevel, setPreviewLevel] = useState(null)

  const currentLevel = detectAggressivenessLevel(config)

  const handleLevelChange = async (level) => {
    if (level === currentLevel || updating) return

    setUpdating(true)
    const params = computeAggressivenessParams(level)
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
    ? computeAggressivenessParams(previewLevel)
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
        {AGGRESSIVENESS_LEVELS.map((level) => {
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
  const prevPriceRef = useRef(null)

  const { status: socketStatus } = useRegimeEvents(exchange)

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
    // Find the most recent cycleId by parsing the timestamp embedded in the cycleId
    const currentCycleId = liveFills.reduce((latest, f) => {
      if (!f.cycleId) return latest
      if (!latest) return f.cycleId
      const latestTime = parseInt(latest.split('-')[1]) || 0
      const fillTime = parseInt(f.cycleId.split('-')[1]) || 0
      return fillTime > latestTime ? f.cycleId : latest
    }, null)
    return liveFills.filter(f => f.cycleId === currentCycleId)
  }, [liveFills, showAllCycles])

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

  // Initial load only - no polling needed, socket provides live updates
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([fetchStatus(), fetchConfig(), fetchFills(), fetchCachedChartData()])
      setLoading(false)
    }
    load()
  }, [exchange, fetchStatus, fetchConfig, fetchFills, fetchCachedChartData])

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

      {isRunning ? (
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
                        <span className="text-gray-400">Steps:</span>{' '}
                        <span className="text-white font-mono">{sizeOptimizer.currentConfig?.maxLadderSteps}</span>
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
                />
              </Suspense>
            )}

            {/* Position */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Position</h3>
                <div className="flex items-center gap-2">
                  {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
                  <span className="text-xs text-gray-500">Buys {position.cycleBuys || position.ladderStep || 0}/{config?.maxLadderSteps || 10}</span>
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

              {/* Celestial Bodies Status */}
              {status?.celestial?.enabled && (
                <div className="mt-2 pt-2 border-t border-gray-700 text-xs">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-gray-500">Celestial Bodies</span>
                    <span className="text-cyan-400 font-mono">{status.celestial.bodiesActive || 0} active / {status.celestial.bodiesCompleted || 0} completed</span>
                  </div>
                  {(status.celestial.bodiesRealizedPnL || 0) !== 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">Bodies P&L</span>
                      <span className={`font-mono ${status.celestial.bodiesRealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${status.celestial.bodiesRealizedPnL?.toFixed(2) || '0'}
                        {(status.celestial.bodiesRealizedBtcPnL || 0) > 0 && <span className="text-orange-400 ml-1">+{status.celestial.bodiesRealizedBtcPnL?.toFixed(8)} BTC</span>}
                      </span>
                    </div>
                  )}
                  {(status.celestial.bodies || []).length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {status.celestial.bodies.map((body, i) => (
                        <div key={body.id || i} className="group">
                          <div className="flex items-center justify-between text-[10px] bg-gray-900/50 rounded px-1.5 py-0.5 cursor-default">
                            <span className="text-gray-400">
                              <span title={body.tier}>{body.emoji}</span> {body.btcQty?.toFixed(6)} BTC @ ${body.avgPrice?.toFixed(0)}
                              {body.mergeCount > 0 && <span className="text-gray-600 ml-1">×{body.mergeCount + 1}</span>}
                              {(body.buyOrders || []).length > 0 && <span className="text-gray-600 ml-1" title="Constituent buy orders">({body.buyOrders.length} buys)</span>}
                            </span>
                            <span className={body.tpOrderId ? 'text-purple-400' : 'text-red-400'}>
                              {body.tpOrderId ? `TP $${body.tpPrice?.toFixed(0)} (${body.tpPercent}%)` : 'NO TP'}
                            </span>
                          </div>
                          {(body.buyOrders || []).length > 0 && (
                            <div className="hidden group-hover:block ml-4 mt-0.5 space-y-px">
                              {body.buyOrders.slice(-5).map((bo, j) => (
                                <div key={bo.orderId || j} className="text-[9px] text-gray-600 flex justify-between px-1">
                                  <span>{bo.orderId?.slice(0, 8)} {bo.btcQty?.toFixed(6)} BTC @ ${bo.price?.toFixed(0)}</span>
                                  <span className={body.tpOrderId ? 'text-gray-600' : 'text-red-700'}>→ {body.tpOrderId ? body.tpOrderId.slice(0, 8) : 'none'}</span>
                                </div>
                              ))}
                              {body.buyOrders.length > 5 && <div className="text-[9px] text-gray-700 px-1">...and {body.buyOrders.length - 5} more</div>}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
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

                  const ordersWithCalcs = openOrders.map(order => {
                    const age = Date.now() - order.placedAt
                    const isTpOrder = order.type === 'take_profit' || order.type === 'satellite_tp' || order.type === 'body_tp'
                    // Use body's own avg cost: from backend enrichment, or fallback to celestial state
                    const bodyData = (order.type === 'body_tp' || order.type === 'satellite_tp') ? bodyLookup.get(order.orderId) : null
                    const orderAvgCost = order.satelliteAvgCost || bodyData?.avgPrice || (isTpOrder ? avgCost : 0)
                    // Estimate sell-side fees (~0.06% net for maker orders on Coinbase)
                    const sellValue = order.size * order.price
                    const estSellFee = sellValue * 0.0006 // 0.06% estimated maker fee
                    // For bodies, use prorated cost basis (includes buy fees) instead of raw avgPrice * size
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

                    // Compute TP% for bodies that don't have it from backend
                    const tpPercent = order.tpPercent
                      || ((order.type === 'satellite_tp' || order.type === 'body_tp') && orderAvgCost > 0
                        ? ((order.price - orderAvgCost) / orderAvgCost * 100).toFixed(2)
                        : null)

                    return { ...order, age, estPnl, estSellFee, estHoldback, estHoldbackValue, tpPercent }
                  })

                  return (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-400 text-xs border-b border-gray-700">
                          <th className="text-left py-2 pr-2">Order ID</th>
                          <th className="text-left py-2 pr-2">Type</th>
                          <th className="text-right py-2 pr-2">TP%</th>
                          <th className="text-left py-2 pr-2">Side</th>
                          <th className="text-right py-2 pr-2">Size (BTC)</th>
                          <th className="text-right py-2 pr-2">Value</th>
                          <th className="text-right py-2 pr-2">Price</th>
                          <th className="text-right py-2 pr-2">Est. P&L</th>
                          <th className="text-right py-2 pr-2">Holdback</th>
                          <th className="text-right py-2">Age</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersWithCalcs.map((order) => (
                          <tr key={order.orderId} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                            <td className="py-2 pr-2 font-mono text-gray-500 text-xs">
                              {order.orderId}
                            </td>
                            <td className="py-2 pr-2">
                              {(() => {
                                const bodyInfo = (order.type === 'body_tp' || order.type === 'satellite_tp') ? bodyLookup.get(order.orderId) : null;
                                const tier = bodyInfo?.tier || (order.type === 'satellite_tp' ? 'satellite' : null);
                                const tierStyles = {
                                  satellite:  { bg: 'bg-gray-700/60',    text: 'text-gray-300',    tooltip: 'Satellite — individual order, 1–3× base' },
                                  moon:       { bg: 'bg-slate-600/50',   text: 'text-slate-300',   tooltip: 'Moon — small cluster, 3–10× base' },
                                  planet:     { bg: 'bg-blue-900/50',    text: 'text-blue-400',    tooltip: 'Planet — substantial mass, 10–100× base' },
                                  sun:        { bg: 'bg-amber-900/50',   text: 'text-amber-400',   tooltip: 'Sun — large mass, 100–500× base' },
                                  hypergiant: { bg: 'bg-purple-900/50',  text: 'text-purple-400',  tooltip: 'Hypergiant — massive mass, 500–1000× base' },
                                  black_hole: { bg: 'bg-red-900/50',     text: 'text-red-400',     tooltip: 'Black Hole — critical mass, 1000×+ base' },
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
                            <td className={`py-2 pr-2 ${order.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
                              {order.side?.toUpperCase()}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-white">
                              {order.size?.toFixed(8)}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-yellow-400">
                              ${((order.size || 0) * (order.price || 0)).toFixed(2)}
                            </td>
                            <td className="text-right py-2 pr-2 font-mono text-white">
                              ${order.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className={`text-right py-2 pr-2 font-mono text-xs ${order.estPnl !== null ? (order.estPnl >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}`} title={order.estSellFee ? `After est. sell fee: $${order.estSellFee.toFixed(4)}` : undefined}>
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
                {((isDryRun && dryRunState?.filledOrders?.length > 0) || (!isDryRun && filteredFills.length > 0)) && (
                  <span className="text-xs text-gray-500">
                    {isDryRun
                      ? dryRunState.filledOrders.length
                      : filteredFills.length
                    } fills
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

                  // Calculate sell totals
                  let totalSellSize = 0
                  let totalSellPnl = 0
                  let totalSellHoldback = 0
                  sellOrders.forEach(order => {
                    totalSellSize += order.size || 0
                    if (order.pnl !== undefined) totalSellPnl += order.pnl
                    if (order.holdbackBtc !== undefined) totalSellHoldback += order.holdbackBtc
                  })

                  return (
                    <>
                      {/* Buys Table */}
                      <div>
                        <div className="text-xs text-green-400 mb-1 font-medium">Buys ({buyOrders.length})</div>
                        <div className="overflow-x-auto max-h-64 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                <th className="text-left py-1.5 pr-2">Order ID</th>
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">Value</th>
                                <th className="text-right py-1.5 pr-2">Fill Time</th>
                                <th className="text-right py-1.5">Filled</th>
                              </tr>
                            </thead>
                            <tbody>
                              {buyOrders.length > 1 && (
                                <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                  <td className="py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {totalBuySize.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 text-gray-400 text-xs">
                                    avg ${totalBuySize > 0 ? (totalBuyValue / totalBuySize).toFixed(2) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${totalBuyValue.toFixed(2)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 text-gray-400 text-xs">Totals</td>
                                </tr>
                              )}
                              {buyOrders.map((order, idx) => {
                                const fillTimeMs = order.filledAt && order.placedAt ? order.filledAt - order.placedAt : null
                                return (
                                <tr key={`buy-${order.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  <td className="py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {order.orderId}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {order.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${order.fillPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-400 text-xs">
                                    ${((order.size || 0) * (order.fillPrice || 0)).toFixed(2)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {fillTimeMs !== null ? formatDuration(fillTimeMs) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {formatTimestamp(order.filledAt)}
                                  </td>
                                </tr>
                              )})}
                              {buyOrders.length === 0 && (
                                <tr><td colSpan={6} className="text-center py-2 text-gray-500 text-xs">No buys yet</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Sells Table */}
                      <div>
                        <div className="text-xs text-red-400 mb-1 font-medium">Sells ({sellOrders.length})</div>
                        <div className="overflow-x-auto max-h-64 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                <th className="text-left py-1.5 pr-2">Order ID</th>
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">P&L</th>
                                <th className="text-right py-1.5 pr-2">Holdback</th>
                                <th className="text-right py-1.5 pr-2">Fill Time</th>
                                <th className="text-right py-1.5">Filled</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sellOrders.length > 1 && (
                                <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                  <td className="py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {totalSellSize.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${totalSellPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {totalSellPnl !== 0 ? `${totalSellPnl >= 0 ? '+' : ''}$${totalSellPnl.toFixed(2)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-xs text-cyan-400">
                                    {totalSellHoldback > 0 ? `+${totalSellHoldback.toFixed(8)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 text-gray-400 text-xs">Totals</td>
                                </tr>
                              )}
                              {sellOrders.map((order, idx) => {
                                const fillTimeMs = order.filledAt && order.placedAt ? order.filledAt - order.placedAt : null
                                return (
                                <tr key={`sell-${order.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  <td className="py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {order.orderId}
                                  </td>
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
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {fillTimeMs !== null ? formatDuration(fillTimeMs) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {formatTimestamp(order.filledAt)}
                                  </td>
                                </tr>
                              )})}
                              {sellOrders.length === 0 && (
                                <tr><td colSpan={7} className="text-center py-2 text-gray-500 text-xs">No sells yet</td></tr>
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
                  // Group fills by cycleId to calculate per-cycle holdback
                  const cycleMap = new Map()
                  filteredFills.forEach(fill => {
                    const cycleId = fill.cycleId || 'unknown'
                    if (!cycleMap.has(cycleId)) {
                      cycleMap.set(cycleId, { buys: [], sells: [], totalBought: 0, totalSold: 0 })
                    }
                    const cycle = cycleMap.get(cycleId)
                    if (fill.side === 'buy') {
                      cycle.buys.push(fill)
                      cycle.totalBought += fill.size
                    } else {
                      cycle.sells.push(fill)
                      cycle.totalSold += fill.size
                    }
                  })

                  // Calculate P&L and per-cycle holdback for sells
                  const sortedFills = [...filteredFills].sort((a, b) => a.timestamp - b.timestamp)
                  let runningBtc = 0
                  let runningCost = 0
                  const fillsWithPnl = sortedFills.map(fill => {
                    if (fill.side === 'buy') {
                      // Skip satellite buys from core running average (they have independent TP)
                      if (!fill.isSatellite) {
                        runningBtc += fill.size
                        runningCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || fill.fee || 0)
                      }
                      return { ...fill, pnl: null, holdback: null }
                    } else if (fill.isSatellite) {
                      // Satellite TP: use the satellite's own cost basis and holdback
                      const pnl = fill.satellitePnl != null
                        ? fill.satellitePnl
                        : (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0) - (fill.satelliteCostBasis || 0)
                      const holdback = fill.satelliteHoldbackBtc || 0
                      // Do NOT update running totals — satellite buys were never merged into core
                      return { ...fill, pnl, holdback, avgCost: fill.satelliteAvgPrice || fill.price, isSatellite: true }
                    } else {
                      const avgCost = runningBtc > 0 ? runningCost / runningBtc : 0
                      const proceeds = (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0)
                      const costBasis = avgCost * fill.size
                      const pnl = proceeds - costBasis
                      // Calculate per-cycle holdback: buys - sells for this cycle
                      const cycleData = cycleMap.get(fill.cycleId || 'unknown')
                      const cycleHoldback = cycleData ? Math.max(0, cycleData.totalBought - cycleData.totalSold) : 0
                      // Update running totals for next iteration
                      const remaining = runningBtc - fill.size
                      runningBtc = remaining > 0 ? remaining : 0
                      runningCost = remaining > 0 ? avgCost * remaining : 0
                      return { ...fill, pnl, holdback: cycleHoldback, avgCost }
                    }
                  })

                  // Aggregate partial fills by orderId for display
                  const aggregateByOrderId = (fills) => {
                    const orderMap = new Map()
                    fills.forEach(fill => {
                      const existing = orderMap.get(fill.orderId)
                      if (existing) {
                        existing.size += fill.size
                        existing.quoteAmount = (existing.quoteAmount || 0) + (fill.quoteAmount || 0)
                        existing.pnl = (existing.pnl || 0) + (fill.pnl || 0)
                        existing.netFee = (existing.netFee || 0) + (fill.netFee || 0)
                        // Holdback is per-cycle, so keep the same value (don't sum partials)
                        existing.partialCount = (existing.partialCount || 1) + 1
                      } else {
                        orderMap.set(fill.orderId, { ...fill, partialCount: 1 })
                      }
                    })
                    return Array.from(orderMap.values())
                  }

                  const allFills = fillsWithPnl.sort((a, b) => b.timestamp - a.timestamp)
                  // Aggregate buys and sells separately by orderId
                  const buyFillsRaw = allFills.filter(f => f.side === 'buy')
                  const sellFillsRaw = allFills.filter(f => f.side === 'sell')
                  const allBuyFills = aggregateByOrderId(buyFillsRaw)
                  const allSellFills = aggregateByOrderId(sellFillsRaw)
                  // Show all fills (table has scrolling)
                  const buyFills = allBuyFills
                  const sellFills = allSellFills

                  // Calculate buy totals from ALL fills, not just displayed ones
                  let totalBuySize = 0
                  let totalBuyValue = 0
                  let totalBuyFees = 0
                  allBuyFills.forEach(fill => {
                    totalBuySize += fill.size || 0
                    totalBuyValue += fill.quoteAmount || 0
                    totalBuyFees += fill.netFee || 0
                  })

                  // Calculate sell totals from ALL fills - sum holdback from each cycle (not running total)
                  let totalSellSize = 0
                  let totalSellPnl = 0
                  let totalHoldback = 0
                  let totalSellFees = 0
                  // Track unique cycles to avoid double-counting holdback
                  const countedCycles = new Set()
                  allSellFills.forEach(fill => {
                    totalSellSize += fill.size || 0
                    if (fill.pnl !== null) totalSellPnl += fill.pnl
                    totalSellFees += fill.netFee || 0
                    if (fill.isSatellite) {
                      // Satellite holdback is per-fill (each satellite has its own)
                      totalHoldback += fill.holdback || 0
                    } else if (fill.cycleId && !countedCycles.has(fill.cycleId)) {
                      // Core holdback is per-cycle (avoid double-counting)
                      totalHoldback += fill.holdback || 0
                      countedCycles.add(fill.cycleId)
                    }
                  })

                  return (
                    <>
                      {/* Buys Table */}
                      <div>
                        <div className="text-xs text-green-400 mb-1 font-medium">Buys ({allBuyFills.length})</div>
                        <div className="overflow-x-auto max-h-64 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                {showAllCycles && <th className="text-left py-1.5 pr-2">Cycle</th>}
                                <th className="text-left py-1.5 pr-2">Order ID</th>
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">Value</th>
                                <th className="text-right py-1.5 pr-2">Net Fee</th>
                                <th className="text-right py-1.5 pr-2">Fill Time</th>
                                <th className="text-right py-1.5">Filled</th>
                              </tr>
                            </thead>
                            <tbody>
                              {buyFills.length > 1 && (
                                <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                  {showAllCycles && <td className="py-1.5 pr-2"></td>}
                                  <td className="py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {totalBuySize.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 text-gray-400 text-xs">
                                    avg ${totalBuySize > 0 ? (totalBuyValue / totalBuySize).toFixed(2) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${totalBuyValue.toFixed(2)}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${totalBuyFees < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                                    {totalBuyFees < 0 ? `-$${Math.abs(totalBuyFees).toFixed(4)}` : `$${totalBuyFees.toFixed(4)}`}
                                  </td>
                                  <td className="text-right py-1.5 pr-2"></td>
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
                                  <td className="py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {fill.orderId}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {fill.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${fill.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-400 text-xs">
                                    ${fill.quoteAmount?.toFixed(2)}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${fill.netFee < 0 ? 'text-green-400' : 'text-gray-500'}`} title={fill.rebate > 0 ? `Fee: $${fill.fee?.toFixed(4)} | Rebate: $${fill.rebate?.toFixed(4)}` : undefined}>
                                    {fill.netFee !== undefined ? (fill.netFee < 0 ? `-$${Math.abs(fill.netFee).toFixed(4)}` : `$${fill.netFee.toFixed(4)}`) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {fill.fillTimeMs ? formatDuration(fill.fillTimeMs) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {formatTimestamp(fill.timestamp)}
                                  </td>
                                </tr>
                              ))}
                              {buyFills.length === 0 && (
                                <tr><td colSpan={showAllCycles ? 8 : 7} className="text-center py-2 text-gray-500 text-xs">No buys yet</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Sells Table */}
                      <div>
                        <div className="text-xs text-red-400 mb-1 font-medium">Sells ({allSellFills.length})</div>
                        <div className="overflow-x-auto max-h-64 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-gray-800">
                              <tr className="text-gray-400 text-xs border-b border-gray-700">
                                {showAllCycles && <th className="text-left py-1.5 pr-2">Cycle</th>}
                                <th className="text-left py-1.5 pr-2">Order ID</th>
                                <th className="text-right py-1.5 pr-2">Size (BTC)</th>
                                <th className="text-right py-1.5 pr-2">Price</th>
                                <th className="text-right py-1.5 pr-2">P&L</th>
                                <th className="text-right py-1.5 pr-2">Holdback</th>
                                <th className="text-right py-1.5 pr-2">Net Fee</th>
                                <th className="text-right py-1.5 pr-2">Fill Time</th>
                                <th className="text-right py-1.5">Filled</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sellFills.length > 1 && (
                                <tr className="border-b border-gray-600 bg-gray-700/30 font-medium">
                                  {showAllCycles && <td className="py-1.5 pr-2"></td>}
                                  <td className="py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {totalSellSize.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${totalSellPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {totalSellPnl !== 0 ? `${totalSellPnl >= 0 ? '+' : ''}$${totalSellPnl.toFixed(2)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-xs text-cyan-400">
                                    {totalHoldback > 0 ? `+${totalHoldback.toFixed(8)}` : '—'}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${totalSellFees < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                                    {totalSellFees < 0 ? `-$${Math.abs(totalSellFees).toFixed(4)}` : `$${totalSellFees.toFixed(4)}`}
                                  </td>
                                  <td className="text-right py-1.5 pr-2"></td>
                                  <td className="text-right py-1.5 text-gray-400 text-xs">Totals</td>
                                </tr>
                              )}
                              {sellFills.map((fill, idx) => (
                                <tr key={`sell-${fill.orderId}-${idx}`} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                  {showAllCycles && (
                                    <td className="py-1.5 pr-2 text-xs text-gray-500">
                                      {fill.cycleId ? fill.cycleId.replace('cycle-', '#') : 'current'}
                                    </td>
                                  )}
                                  <td className="py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {fill.isSatellite && <span className="text-purple-400 mr-1" title={`${fill.bodyTier || 'Satellite'} TP (entry: $${fill.satelliteAvgPrice?.toFixed(2) || '?'})`}>{fill.bodyTier ? (fill.bodyTier === 'satellite' ? '🛰️' : fill.bodyTier === 'moon' ? '🌙' : fill.bodyTier === 'planet' ? '🪐' : fill.bodyTier === 'sun' ? '☀️' : fill.bodyTier === 'hypergiant' ? '💫' : fill.bodyTier === 'black_hole' ? '🕳️' : 'S') : 'S'}</span>}
                                    {fill.orderId}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    {fill.size?.toFixed(8)}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-white text-xs">
                                    ${fill.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${
                                    fill.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                                  }`} title={fill.isSatellite ? `Entry: $${fill.satelliteAvgPrice?.toFixed(2)}` : fill.avgCost ? `Avg cost: $${fill.avgCost.toFixed(2)}` : undefined}>
                                    {fill.pnl !== null ? `${fill.pnl >= 0 ? '+' : ''}$${fill.pnl.toFixed(2)}` : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-xs text-cyan-400">
                                    {fill.holdback > 0 ? `+${fill.holdback.toFixed(8)}` : '—'}
                                  </td>
                                  <td className={`text-right py-1.5 pr-2 font-mono text-xs ${fill.netFee < 0 ? 'text-green-400' : 'text-gray-500'}`} title={fill.rebate > 0 ? `Fee: $${fill.fee?.toFixed(4)} | Rebate: $${fill.rebate?.toFixed(4)}` : undefined}>
                                    {fill.netFee !== undefined ? (fill.netFee < 0 ? `-$${Math.abs(fill.netFee).toFixed(4)}` : `$${fill.netFee.toFixed(4)}`) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 pr-2 font-mono text-gray-500 text-xs">
                                    {fill.fillTimeMs ? formatDuration(fill.fillTimeMs) : '—'}
                                  </td>
                                  <td className="text-right py-1.5 font-mono text-gray-500 text-xs">
                                    {formatTimestamp(fill.timestamp)}
                                  </td>
                                </tr>
                              ))}
                              {sellFills.length === 0 && (
                                <tr><td colSpan={showAllCycles ? 9 : 8} className="text-center py-2 text-gray-500 text-xs">No sells yet</td></tr>
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
    </div>
  )
}

export default RegimeDashboard
