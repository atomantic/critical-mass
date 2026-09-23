import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense, useId } from 'react'
import { useRegimeEvents } from '../hooks/useTradeEvents'
import { useChartDataBuffer } from '../hooks/useChartDataBuffer'
import { useToast } from './Toast'
import { getBaseCurrency, getQuoteCurrency } from '../App'
import { pairQuery as buildPairQuery } from '../utils/api'
import { createRequestOwner } from '../utils/requestOwner.mjs'
import { resolveElapsedDisplay } from '../utils/liveTimerElapsed.mjs'
import { computeCapitalAdjustment } from '../utils/capitalAdjustment.mjs'
import RegimePriceChart from './charts/RegimePriceChart'
import VolatilityChart from './charts/VolatilityChart'
import RegimeTimeline from './charts/RegimeTimeline'
import RegimeActionModals from './regime/RegimeActionModals'
import OpenOrdersTable from './regime/OpenOrdersTable'
import FilledOrdersSection from './regime/FilledOrdersSection'
import { formatDuration, formatTimestamp } from './regime/regimeFormat'
import { formatPriceByMagnitude, formatCurrency } from './charts/chartUtils'

const CelestialVisualization = lazy(() => import('./celestial/CelestialVisualization'))
const EMPTY_BODIES = []

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
  AUTH_DENIED: { bg: 'bg-red-900/50', text: 'text-red-300', icon: '🔑' },
  STOPPED: { bg: 'bg-red-900/30', text: 'text-red-400', icon: '■' },
  ENGINE_DOWN: { bg: 'bg-orange-900/40', text: 'text-orange-400', icon: '⚠' },
}

// Macro regime mode colors
const MACRO_COLORS = {
  ACCUMULATION: { bg: 'bg-blue-900/50', border: 'border-blue-500', text: 'text-blue-400', label: 'Accumulation' },
  RANGING: { bg: 'bg-gray-800/50', border: 'border-gray-500', text: 'text-gray-400', label: 'Ranging' },
  MARKUP: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400', label: 'Markup' },
  DECLINE: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400', label: 'Decline' },
}

// Tooltip descriptions for config parameters
const CONFIG_TOOLTIPS = {
  baseSize: 'Base USDC amount per buy order. When "Auto", dynamically adjusted based on available balance and position sizing rules',
  kFactor: 'ATR multiplier controlling trigger sensitivity. Lower = more frequent trades on smaller moves. Higher = fewer trades, only on larger price swings',
  minInterval: 'Minimum wait time between consecutive buy orders to prevent over-trading during rapid price movement',
  maxInterval: 'Maximum time before placing another buy, even without a strong trigger signal',
  tpRange: 'Take-profit target range. Sell orders are placed within this band above cost basis. "Auto" adjusts based on volatility',
  entryOffset: 'Basis points below mid-price for limit buy entry. Higher values target a deeper discount but may fill less often',
  cautionScale: 'Scales down order size during high-volatility regimes. Lower values = more cautious sizing when markets are volatile',
  trendScale: 'Adjusts buy aggression based on trend strength. Lower values reduce buying into strong downtrends',
  maxCycleBuys: 'Maximum buy orders in a single accumulation cycle before the bot waits for corresponding sells to complete',
}

// Tooltip descriptions for the regime/entry status panels
const REGIME_TOOLTIPS = {
  micro: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Micro Regime</div>
      <div className="mb-1">Short-term market state derived from 1m ATR, realized volatility vs baseline, and VWAP distance.</div>
      <div><span className="text-green-400">HARVEST</span>: calm / mean-reverting → full sizing (1.0x). The <em>most aggressive</em> buy/sell cycling mode — &quot;harvest&quot; refers to harvesting micro cycles, NOT selling out.</div>
      <div><span className="text-yellow-400">CAUTION</span>: volatility expanding → sizing scaled by <code>cautionScale</code>.</div>
      <div><span className="text-red-400">TREND</span>: strong directional move → entries blocked unless <code>trendScale &gt; 0</code>.</div>
    </>
  ),
  macro: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Macro Regime</div>
      <div className="mb-1">Multi-day trend context from 21h/50h/200h hourly EMAs + 20d daily EMA. Lookback maxes at ~200 hours / 20 days — the bot has no concept of multi-month or yearly cycles.</div>
      <div><span className="text-blue-400">ACCUMULATION</span>: price stacked below EMAs → 1.3x size, tighter TP, smaller offset.</div>
      <div><span className="text-gray-400">RANGING</span>: neutral → no modulation (1.0x / 1.0x / 1.0x).</div>
      <div><span className="text-green-400">MARKUP</span>: confirmed uptrend → 0.7x size, wider TP.</div>
      <div><span className="text-red-400">DECLINE</span>: confirmed downtrend → 0.4x size, tighter TP, wider offset.</div>
    </>
  ),
  entryStatus: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Entry Status</div>
      <div>Gates that must pass for the bot to place a buy order:</div>
      <div className="mt-1">• <strong>Health</strong>: Ready / Safe / Paused / Stopped</div>
      <div>• <strong>Regime</strong>: Allowed unless micro regime is TREND</div>
      <div>• <strong>Celestial bodies</strong>: open-position capacity by tier (Sun / Planet / Asteroid)</div>
      <div>• <strong>Macro</strong>: long-term trend indicator (informational unless macro multipliers are non-zero)</div>
    </>
  ),
  entryMode: (
    <>
      <div className="font-semibold text-gray-200 mb-1">Entry Mode</div>
      <div><span className="text-gray-300">REACTIVE</span>: single buy order placed when the ATR trigger fires. Best for low-volatility / mean-reverting conditions.</div>
      <div className="mt-1"><span className="text-indigo-400">LADDER</span>: multiple pre-positioned buy orders descending from current price. Auto-activates when volatility expansion exceeds <code>ladderAutoSwitchVolMult</code> (default 2.0x).</div>
    </>
  ),
}

const TOOLTIP_WIDTH_CLASSES = {
  'w-52': 'sm:w-52',
  'w-72': 'sm:w-72',
  'w-80': 'sm:w-80',
}

// Info icon + hover tooltip for config labels
function ConfigTooltip({ tip, align = 'center', width = 'w-52' }) {
  const alignClass = align === 'left' ? 'sm:left-0' : align === 'right' ? 'sm:right-0' : 'sm:left-1/2 sm:-translate-x-1/2'
  const widthClass = TOOLTIP_WIDTH_CLASSES[width] || TOOLTIP_WIDTH_CLASSES['w-52']
  return (
    <span className="relative group cursor-help ml-1 inline-flex align-middle">
      <svg className="w-3 h-3 text-gray-600 group-hover:text-gray-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <span className={`fixed inset-x-4 bottom-4 w-auto max-h-[calc(100dvh-2rem)] overflow-y-auto sm:absolute sm:inset-x-auto sm:bottom-full sm:mb-2 sm:max-h-none sm:overflow-visible ${alignClass} ${widthClass} px-3 py-2 bg-gray-900 border border-gray-700 text-xs text-gray-300 rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50 space-y-0.5 leading-snug text-left normal-case font-normal`}>
        {tip}
      </span>
    </span>
  )
}

// Aggressiveness level metadata (colors/labels are static, params come from API)
const AGGRESSIVENESS_LEVEL_META = {
  conservative: { label: 'Conservative', color: 'green' },
  moderate: { label: 'Moderate', color: 'blue' },
  aggressive: { label: 'Aggressive', color: 'yellow' },
  maximum: { label: 'Maximum', color: 'red' },
}

// Tailwind classes per suggested aggressiveness level
const SUGGESTED_LEVEL_STYLES = {
  conservative: { bg: 'bg-green-900/40',  border: 'border-green-700/50',  text: 'text-green-400',  bar: 'bg-green-500',  label: 'Conservative' },
  moderate:     { bg: 'bg-blue-900/40',   border: 'border-blue-700/50',   text: 'text-blue-400',   bar: 'bg-blue-500',   label: 'Moderate' },
  aggressive:   { bg: 'bg-yellow-900/40', border: 'border-yellow-700/50', text: 'text-yellow-400', bar: 'bg-yellow-500', label: 'Aggressive' },
  maximum:      { bg: 'bg-red-900/40',    border: 'border-red-700/50',    text: 'text-red-400',    bar: 'bg-red-500',    label: 'Maximum' },
}

// Cache health badge styles
const CACHE_HEALTH_STYLES = {
  full:    { bg: 'bg-green-900/40',  text: 'text-green-400',  label: 'Full cache' },
  partial: { bg: 'bg-yellow-900/40', text: 'text-yellow-400', label: 'Partial cache' },
  sparse:  { bg: 'bg-orange-900/40', text: 'text-orange-400', label: 'Sparse cache' },
  empty:   { bg: 'bg-gray-900',      text: 'text-gray-400',   label: 'Empty cache' },
}

const LONG_TERM_BIAS_TOOLTIP = (
  <>
    <div className="font-semibold text-gray-200 mb-1">Long-Term Bias (Depression Score)</div>
    <div className="mb-1">Composite signal of how cheap an asset is relative to its trailing window. <strong>Phase 2 — advisory.</strong> Sizing is unchanged until you click <em>Apply Suggested</em>.</div>
    <div>• <strong>Percentile of range</strong> (60% weight): position in trailing high/low. 1.0 = at the period low.</div>
    <div>• <strong>Drawdown</strong> (30%): % below trailing high. Maps 80% drawdown → 1.0.</div>
    <div>• <strong>Z-score</strong> (10%): standard deviations below the trailing mean.</div>
    <div className="mt-1">When &quot;Suggested&quot; diverges from &quot;Current&quot;, an <em>Apply Suggested</em> button appears so you can adopt the recommendation with one click. See PLAN.md → Auto-Aggressiveness Roadmap.</div>
  </>
)

// Long-term bias / depression score panel (Phase 2: advisory)
function LongTermBiasPanel({ bias, config, presets, exchange, pairQuery, onConfigUpdate, addToast }) {
  const [applying, setApplying] = useState(false)
  if (!bias) return null

  const currentLevel = detectAggressivenessLevel(config, presets)
  const suggested = bias.suggestedLevel || 'conservative'
  const suggestedStyle = SUGGESTED_LEVEL_STYLES[suggested] || SUGGESTED_LEVEL_STYLES.conservative
  const divergent = currentLevel && currentLevel !== 'custom' && suggested !== currentLevel
  const canApply = !!(exchange && presets?.[suggested] && onConfigUpdate)
  const suggestedLabel = SUGGESTED_LEVEL_STYLES[suggested]?.label || suggested
  const currentLabel = currentLevel === 'custom'
    ? 'Custom'
    : (AGGRESSIVENESS_LEVEL_META[currentLevel]?.label || currentLevel)

  const handleApplySuggested = async () => {
    if (applying || !canApply) return
    setApplying(true)
    try {
      const params = computeAggressivenessParams(suggested, presets)
      const updates = { aggressiveness: suggested, ...params }
      const res = await fetch(`/api/${exchange}/regime/config${pairQuery || ''}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (res.ok) {
        addToast?.({
          type: 'success',
          title: 'Aggressiveness applied',
          message: `${currentLabel} → ${suggestedLabel} (suggested by long-term bias)`,
        })
        onConfigUpdate()
      } else {
        const err = await res.json().catch(() => ({}))
        addToast?.({
          type: 'error',
          title: 'Could not apply suggested level',
          message: (err.errors && err.errors[0]) || err.error || `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Could not apply suggested level', message: err.message || 'Network error' })
    } finally {
      setApplying(false)
    }
  }

  const cacheHealth = bias.cache?.health || 'empty'
  const healthStyle = CACHE_HEALTH_STYLES[cacheHealth] || CACHE_HEALTH_STYLES.empty
  const coveragePct = bias.cache?.coveragePct || 0

  if (!bias.ready) {
    return (
      <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-gray-400">
            Long-Term Bias<ConfigTooltip tip={LONG_TERM_BIAS_TOOLTIP} align="left" width="w-80" />
          </h3>
          <span className={`px-1.5 py-0.5 rounded text-[10px] ${healthStyle.bg} ${healthStyle.text}`}>
            {healthStyle.label}
          </span>
        </div>
        <div className="text-[10px] text-gray-400">
          Need ≥30 daily candles. Currently have {bias.sampleSize || 0}.
          {bias.cache?.lastRefresh ? ` Last refresh ${new Date(bias.cache.lastRefresh).toLocaleTimeString()}.` : ' Refreshing...'}
        </div>
      </div>
    )
  }

  const c = bias.components || {}
  const scorePct = (bias.score * 100).toFixed(0)

  return (
    <div className={`bg-gray-800 rounded-lg p-3 border ${suggestedStyle.border}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-gray-400">
          Long-Term Bias<ConfigTooltip tip={LONG_TERM_BIAS_TOOLTIP} align="left" width="w-80" />
        </h3>
        <div className="flex items-center gap-1">
          <span className={`px-1.5 py-0.5 rounded text-[10px] ${healthStyle.bg} ${healthStyle.text}`}>
            {healthStyle.label}
          </span>
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-900 text-gray-400 border border-gray-700">
            Advisory
          </span>
        </div>
      </div>

      {/* Score bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-[10px] text-gray-400 mb-0.5">
          <span>Depression Score</span>
          <span className={`font-mono ${suggestedStyle.text}`}>{scorePct}/100</span>
        </div>
        <div className="h-2 bg-gray-900 rounded overflow-hidden">
          <div
            className={`h-full ${suggestedStyle.bar} transition-all`}
            style={{ width: `${scorePct}%` }}
          />
        </div>
      </div>

      {/* Suggested vs current level */}
      <div className={`p-2 rounded mb-2 ${suggestedStyle.bg} border ${suggestedStyle.border}`}>
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">Suggested</span>
          <span className={`font-semibold ${suggestedStyle.text}`}>{suggestedStyle.label}</span>
        </div>
        {currentLevel && (
          <div className="flex items-center justify-between text-[10px] text-gray-400 mt-0.5">
            <span>Current</span>
            <span>
              {currentLabel}
              {divergent && <span className="ml-1 text-yellow-400">⚠ diverges</span>}
            </span>
          </div>
        )}
        {divergent && canApply && (
          <button
            type="button"
            onClick={handleApplySuggested}
            disabled={applying}
            title={`Apply ${suggestedLabel} preset to ${exchange}`}
            className={`mt-2 w-full px-2 py-1 text-[11px] font-medium rounded border transition-all ${suggestedStyle.border} ${suggestedStyle.text} hover:bg-gray-900/60 ${applying ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {applying ? 'Applying…' : `Apply Suggested (${suggestedLabel})`}
          </button>
        )}
      </div>

      {/* Component breakdown */}
      <div className="space-y-1 text-[10px]">
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Percentile of range ({(c.percentile?.weight * 100 || 0).toFixed(0)}%)</span>
          <span className="font-mono text-gray-300">{((c.percentile?.score || 0) * 100).toFixed(0)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Drawdown from high ({(c.drawdown?.weight * 100 || 0).toFixed(0)}%)</span>
          <span className="font-mono text-gray-300">
            {((c.drawdown?.score || 0) * 100).toFixed(0)}
            <span className="text-gray-400 ml-1">(-{(c.drawdown?.drawdownPct || 0).toFixed(1)}%)</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Z-score vs mean ({(c.zscore?.weight * 100 || 0).toFixed(0)}%)</span>
          <span className="font-mono text-gray-300">
            {((c.zscore?.score || 0) * 100).toFixed(0)}
            <span className="text-gray-400 ml-1">(σ {(c.zscore?.zscore || 0).toFixed(2)})</span>
          </span>
        </div>
      </div>

      <div className="text-[10px] text-gray-400 mt-2 pt-2 border-t border-gray-700 flex items-center justify-between">
        <span>
          {bias.sampleSize || 0} / {bias.cache?.lookbackDays || 0}d
          <span className="text-gray-400 ml-1">({coveragePct.toFixed(0)}%)</span>
        </span>
        {bias.cache?.lastRefresh && (
          <span>refreshed {new Date(bias.cache.lastRefresh).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  )
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
        ${formatPriceByMagnitude(price)}
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
        <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
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

  if (variant === 'elapsed') {
    const display = resolveElapsedDisplay(elapsed, now, formatDuration)
    return (
      <div className="bg-gray-900 rounded p-1.5">
        <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
        <span className="text-sm font-mono text-gray-300">{display.primary}</span>
        {display.secondary && (
          <div className="text-[10px] text-gray-400">{display.secondary}</div>
        )}
      </div>
    )
  }

  return null
}

// Aggressiveness control component
function AggressivenessControl({ config, exchange, pairQuery, onConfigUpdate, presets, addToast }) {
  const [updating, setUpdating] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewLevel, setPreviewLevel] = useState(null)

  const levels = useMemo(() => buildAggressivenessLevels(presets || {}), [presets])
  const currentLevel = detectAggressivenessLevel(config, presets)

  const handleLevelChange = async (level) => {
    if (level === currentLevel || updating) return

    setUpdating(true)
    try {
      const params = computeAggressivenessParams(level, presets)
      const updates = { aggressiveness: level, ...params }

      const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })

      if (res.ok) {
        onConfigUpdate()
      } else {
        const err = await res.json().catch(() => ({}))
        addToast?.({ type: 'error', title: 'Could not update aggressiveness', message: (err.errors && err.errors[0]) || err.error || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Could not update aggressiveness', message: err.message || 'Network error' })
    } finally {
      setUpdating(false)
    }
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
      active: 'bg-green-800 text-white border-green-400 ring-2 ring-green-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-green-400 hover:border-green-600/50',
    },
    blue: {
      active: 'bg-blue-600 text-white border-blue-400 ring-2 ring-blue-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-blue-400 hover:border-blue-600/50',
    },
    yellow: {
      active: 'bg-yellow-800 text-white border-yellow-400 ring-2 ring-yellow-400 ring-offset-1 ring-offset-gray-800',
      inactive: 'bg-gray-800 text-gray-400 border-gray-600 hover:text-yellow-400 hover:border-yellow-600/50',
    },
    red: {
      active: 'bg-red-700 text-white border-red-400 ring-2 ring-red-400 ring-offset-1 ring-offset-gray-800',
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
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 mb-2">
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
              className={`min-w-0 min-h-11 xl:min-h-0 w-full px-2 py-1.5 text-xs font-medium rounded border transition-all ${
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1">
            <div className="flex justify-between">
              <span className="text-gray-400">kFactor</span>
              <span className={config?.kFactor !== previewParams.kFactor ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.kFactor}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">minInterval</span>
              <span className={config?.minIntervalMs !== previewParams.minIntervalMs ? 'text-yellow-400' : 'text-gray-300'}>
                {formatInterval(previewParams.minIntervalMs)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">maxInterval</span>
              <span className={config?.maxIntervalMs !== previewParams.maxIntervalMs ? 'text-yellow-400' : 'text-gray-300'}>
                {formatInterval(previewParams.maxIntervalMs)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">entryOffset</span>
              <span className={config?.entryOffsetBps !== previewParams.entryOffsetBps ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.entryOffsetBps}bps
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">cautionScale</span>
              <span className={config?.cautionScale !== previewParams.cautionScale ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.cautionScale}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">trendScale</span>
              <span className={config?.trendScale !== previewParams.trendScale ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.trendScale}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">maxCycleBuys</span>
              <span className={config?.maxCycleBuys !== previewParams.maxCycleBuys ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.maxCycleBuys}
              </span>
            </div>
          </div>
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
      <div className="text-[10px] text-gray-400 mb-0.5">ATR Trigger Distance</div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">
          ${formatPriceByMagnitude(distanceToTrigger)} to go
        </span>
        <span className="text-[10px] text-gray-400">
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
      <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
        <span>Anchor: ${formatPriceByMagnitude(anchorPrice)}</span>
        <span>Target: ±${formatPriceByMagnitude(triggerDistance)}</span>
      </div>
    </div>
  )
}

function RegimeDashboard({ exchange = 'coinbase', pair }) {
  const capitalAdjustInputId = useId()
  const athDropId = useId()
  const spacingModeId = useId()
  const sizeModeId = useId()
  const minSpacingId = useId()
  const pairQuery = buildPairQuery(pair)
  const [localStatus, setLocalStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [liveFills, setLiveFills] = useState([])
  const [recalculating, setRecalculating] = useState(false)
  const [recalcPreview, setRecalcPreview] = useState(null)
  const [presets, setPresets] = useState(null)
  const [rollUpConfirm, setRollUpConfirm] = useState(null)
  const [rollingUp, setRollingUp] = useState(false)
  const [collapseAllConfirm, setCollapseAllConfirm] = useState(false)
  const [drawdownResumeConfirm, setDrawdownResumeConfirm] = useState(false)
  const [resumingAuth, setResumingAuth] = useState(false)
  const [collapsingAll, setCollapsingAll] = useState(false)
  const [resetCycleConfirm, setResetCycleConfirm] = useState(false)
  const [resettingCycle, setResettingCycle] = useState(false)
  // { intent, action: 'adopt'|'discard' } — operator reconcile of an unresolved placement intent
  const [intentConfirm, setIntentConfirm] = useState(null)
  const [reconcilingIntent, setReconcilingIntent] = useState(false)
  const [tpEditModal, setTpEditModal] = useState(null) // { bodyId, currentTpPct, currentPrice, avgPrice, bodyLabel, inputValue, priceValue, mode: 'pct'|'price' }
  const [settingTp, setSettingTp] = useState(false)
  const [openSearchId, setOpenSearchId] = useState('')
  const [dcaState, setDcaState] = useState(null)
  const [convertPreview, setConvertPreview] = useState(null)
  const [converting, setConverting] = useState(false)
  const [showConvertConfirm, setShowConvertConfirm] = useState(false)
  const [showLadderPanel, setShowLadderPanel] = useState(false)
  const [ladderPreview, setLadderPreview] = useState(null)
  const [ladderEdits, setLadderEdits] = useState(null)
  // Raw in-progress text for the numeric ladder inputs, so clearing the field to
  // retype doesn't commit/persist 0 (mirrors ConfigEditor's FormInput draft pattern).
  const [ladderNumberDraft, setLadderNumberDraft] = useState({})
  const [placingLadder, setPlacingLadder] = useState(false)
  const [cancellingLadder, setCancellingLadder] = useState(false)
  const [cancelLadderConfirm, setCancelLadderConfirm] = useState(false)
  const [capitalAdjustMode, setCapitalAdjustMode] = useState(false)
  const [capitalAdjustValue, setCapitalAdjustValue] = useState('')
  const [capitalAdjusting, setCapitalAdjusting] = useState(false)
  const prevPriceRef = useRef(null)
  // Per-mount ownership fence for fills reads (#508). Initial load, the live
  // fill marker refresh and action handlers all refetch fills concurrently; only
  // the newest read may commit, so a slow older response cannot resurrect a
  // pre-fill snapshot over a newer one.
  const [fillsOwner] = useState(createRequestOwner)
  useEffect(() => () => fillsOwner.invalidate(), [fillsOwner])
  const { addToast } = useToast()

  const { status: socketStatus, setStatus: setSocketStatus } = useRegimeEvents(exchange, pair)

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

  // Track previous price for animation
  useEffect(() => {
    if (status?.market?.lastPrice) {
      prevPriceRef.current = status.market.lastPrice
    }
  }, [status?.market?.lastPrice])


  // Fetch status (only used for initial load and when engine is stopped)
  const fetchStatus = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/status${pairQuery}`)
    if (res.ok) {
      const data = await res.json()
      setLocalStatus(data.status)
      setError(null)
    }
  }, [exchange])

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`)
    if (res.ok) {
      const data = await res.json()
      setConfig(data.config)
    }
  }, [exchange])

  // Fetch live fills from fill ledger. Reads go through the per-mount request
  // owner so overlapping refreshes always commit in request order (#508).
  const fetchFills = useCallback(async () => {
    const { owned, data } = await fillsOwner.read(`/api/${exchange}/regime/fills${pairQuery}`)
    if (owned && data) setLiveFills(data.fills || [])
  }, [exchange, pairQuery, fillsOwner])

  // Refresh the Filled Orders table when a fill lands. fetchFills otherwise ran
  // only on mount + manual actions, so the realized-P&L bar and cycle groupings
  // went stale while the engine traded live — visibly disagreeing with the
  // socket-driven Position card. Key on the position markers that change on a
  // buy or sell fill; debounce so a burst of partial-fill status emits triggers
  // a single refetch (#111). Declared AFTER fetchFills to avoid a TDZ
  // ReferenceError on the dep array at render (#111 review).
  const fillMarker = `${status?.position?.cyclesCompleted ?? ''}:${status?.position?.cycleBuys ?? ''}:${status?.position?.realizedPnL ?? ''}:${status?.position?.realizedAssetPnL ?? ''}`
  const fillRefreshRef = useRef(null)
  useEffect(() => {
    // Skip the very first run (mount already fetched fills).
    if (fillRefreshRef.current === null) { fillRefreshRef.current = fillMarker; return }
    if (fillRefreshRef.current === fillMarker) return
    fillRefreshRef.current = fillMarker
    const t = setTimeout(() => { fetchFills() }, 1500)
    return () => clearTimeout(t)
  }, [fillMarker, fetchFills])

  // Fetch cached chart data from server
  const fetchCachedChartData = useCallback(async () => {
    const res = await fetch(`/api/${exchange}/regime/chart-data${pairQuery}`)
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

  // Fetch DCA state when engine is not running (for upgrade button)
  const isRunning = status?.isRunning
  useEffect(() => {
    if (!isRunning) {
      const controller = new AbortController()
      fetch(`/api/${exchange}/state${pairQuery}`, { signal: controller.signal }).then(r => r.json()).then(setDcaState).catch(() => {})
      return () => controller.abort()
    } else {
      setDcaState(null)
    }
  }, [exchange, isRunning, pairQuery])

  // DCA conversion handlers
  const handlePreviewConvert = useCallback(async () => {
    try {
      const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: true, merge: true }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        addToast({ type: 'error', title: 'Preview Failed', message: err.error || 'Could not preview conversion' })
        return
      }
      const data = await res.json()
      setConvertPreview(data)
      setShowConvertConfirm(true)
    } catch (err) {
      addToast({ type: 'error', title: 'Preview Failed', message: err.message || 'Network error' })
    }
  }, [exchange, addToast])

  const handleExecuteConvert = useCallback(async () => {
    setConverting(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/convert-dca${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: false, merge: convertPreview?.merge }),
      })
      setShowConvertConfirm(false)
      setConvertPreview(null)

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        addToast({ type: 'error', title: 'Conversion Failed', message: err.error || 'Could not convert DCA orders' })
        return
      }

      const data = await res.json()
      addToast({
        type: 'success',
        title: data.summary?.totalBodies ? 'DCA Orders Merged' : 'DCA Orders Converted',
        message: `${data.summary?.pendingOrders || 0} positions imported. ${data.summary?.totalBodies ? `Total bodies: ${data.summary.totalBodies}.` : ''} Before starting the regime engine, cancel any remaining DCA sell orders on the exchange and confirm that they are no longer open.`,
      })
      // Refresh status and fills
      fetchStatus()
      fetchFills()
      setDcaState(null)
    } catch (err) {
      setShowConvertConfirm(false)
      setConvertPreview(null)
      addToast({ type: 'error', title: 'Conversion Failed', message: err.message || 'Network error' })
    } finally {
      setConverting(false)
    }
  }, [exchange, addToast, fetchStatus, fetchFills, convertPreview?.merge])

  // Initial load only - no polling needed, socket provides live updates
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        await Promise.all([fetchStatus(), fetchConfig(), fetchFills(), fetchCachedChartData(), fetchPresets()])
      } catch {
        // Leave whatever state the individual fetches already set — loading
        // below still clears so the page never gets stuck on "Loading…".
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [exchange, fetchStatus, fetchConfig, fetchFills, fetchCachedChartData, fetchPresets])

  // Resume from drawdown pause (confirmed via modal — project forbids window.confirm)
  const handleResumeDrawdown = async () => {
    setDrawdownResumeConfirm(false)
    try {
      const res = await fetch(`/api/${exchange}/regime/resume-drawdown${pairQuery}`, { method: 'POST' })
      if (res.ok) await fetchStatus()
      else addToast({ type: 'error', title: 'Resume failed', message: `HTTP ${res.status}` })
    } catch (err) {
      addToast({ type: 'error', title: 'Resume failed', message: err.message || 'Network error' })
    }
  }

  // Resume after an API-key/IP-allowlist denial. The engine also auto-resumes
  // once an authenticated call succeeds, but this lets the operator retry
  // immediately after fixing the allowlist.
  const handleResumeFromAuthDenied = async () => {
    setResumingAuth(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/resume${pairQuery}`, { method: 'POST' })
      if (res.ok) {
        await fetchStatus()
        addToast({ type: 'success', title: 'Resumed', message: 'Engine resumed — retrying API access' })
      } else {
        addToast({ type: 'error', title: 'Resume failed', message: `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Resume failed', message: err.message || 'Network error' })
    } finally {
      setResumingAuth(false)
    }
  }

  // Preview recalculate
  const handleRecalculatePreview = async () => {
    setRecalculating(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/recalculate${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply: false }),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (res.ok && data.success) {
        setRecalcPreview(data)
      } else {
        addToast({ type: 'error', title: 'Recalculate failed', message: data.error || data.message || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Recalculate failed', message: err.message })
    } finally {
      setRecalculating(false)
    }
  }

  // Apply recalculate
  const handleRecalculateApply = async () => {
    setRecalculating(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/recalculate${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply: true }),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (res.ok && data.success) {
        setRecalcPreview(null)
        await fetchStatus()
      } else {
        addToast({ type: 'error', title: 'Recalculate failed', message: data.error || data.message || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Recalculate failed', message: err.message })
    } finally {
      setRecalculating(false)
    }
  }

  // Manual body roll-up merge
  const handleRollUp = async (bodyId) => {
    setRollingUp(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/rollup-body${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bodyId }),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (res.ok && data.success && data.status) {
        // Directly update socket status from API response for immediate visual refresh
        // (avoids race where socketStatus overrides stale localStatus from fetchStatus)
        setSocketStatus(data.status)
        // Re-fetch fills so buy order annotations (bodyId, sellOrderId) reflect the merge
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Roll-up failed', message: data.error || data.message || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Roll-up failed', message: err.message })
    } finally {
      setRollingUp(false)
      setRollUpConfirm(null)
    }
  }

  // Collapse every celestial body into one (cancels all TPs, places one combined TP)
  const handleCollapseAll = async () => {
    setCollapsingAll(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/rollup-all${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        addToast({ type: 'success', title: 'Collapse complete', message: data.message || 'Bodies merged' })
        if (data.status) setSocketStatus(data.status)
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Collapse failed', message: data.message || data.error || 'Unknown error' })
        if (data.status) setSocketStatus(data.status)
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Collapse failed', message: err.message })
    } finally {
      setCollapsingAll(false)
      setCollapseAllConfirm(false)
    }
  }

  // Operator: reset the accumulation cycle to resume buying after the cycle
  // buy-limit paused new entries. Open positions and their TPs are preserved.
  const handleResetCycle = async () => {
    setResettingCycle(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/reset-cycle${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        addToast({ type: 'success', title: 'Cycle reset', message: data.message || 'Buying re-enabled' })
        if (data.status) setSocketStatus(data.status)
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Reset failed', message: data.message || data.error || 'Unknown error' })
        if (data.status) setSocketStatus(data.status)
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Reset failed', message: err.message })
    } finally {
      setResettingCycle(false)
      setResetCycleConfirm(false)
    }
  }

  // Operator: reconcile an unresolved placement intent. Until one is resolved
  // the fund refuses every new placement (and keeps refusing across restarts),
  // because an order we never got an answer for may be resting live.
  const handleReconcileIntent = async () => {
    if (!intentConfirm) return
    const { intent, action } = intentConfirm
    setReconcilingIntent(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/reconcile-placement-intent${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: intent.id, action }),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (data.success) {
        addToast({
          type: 'success',
          title: action === 'adopt' ? 'Order adopted' : 'Intent discarded',
          message: data.message || 'Placements resume for this fund',
        })
        if (data.status) setSocketStatus(data.status)
        fetchStatus()
        fetchFills()
      } else {
        addToast({ type: 'error', title: 'Reconcile failed', message: data.error || data.message || 'Unknown error' })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Reconcile failed', message: err.message })
    } finally {
      setReconcilingIntent(false)
      setIntentConfirm(null)
    }
  }

  // Manually set TP target (by % or limit price) for a celestial body
  const handleSetTp = async (mode) => {
    if (settingTp) return // re-entry guard: Enter key bypasses the disabled button state
    const value = parseFloat(mode === 'pct' ? tpEditModal.inputValue : tpEditModal.priceValue)
    if (isNaN(value) || value <= 0) return
    if (mode === 'price' && value <= (tpEditModal.avgPrice || 0)) {
      // Mirror the "Set Price" button's disabled guard: never allow a TP at or below avg cost.
      addToast({ type: 'error', title: 'Set TP failed', message: 'Limit price must be above average cost' })
      return
    }
    const endpoint = mode === 'pct' ? 'set-body-tp' : 'set-body-tp-price'
    const payload = mode === 'pct' ? { bodyId: tpEditModal.bodyId, tpPct: value } : { bodyId: tpEditModal.bodyId, limitPrice: value }
    setSettingTp(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/${endpoint}${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({ success: false, error: 'Bad response' }))
      if (res.ok && data.success && data.status) {
        setSocketStatus(data.status)
        fetchFills()
        setTpEditModal(null)
      } else {
        // Keep the modal open on failure so the operator can retry — the old TP
        // is still resting on the exchange, so silently closing misled them.
        addToast({ type: 'error', title: 'Set TP failed', message: data.error || data.message || `HTTP ${res.status}` })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Set TP failed', message: err.message })
    } finally {
      setSettingTp(false)
    }
  }

  // Fetch ladder preview
  const fetchLadderPreview = useCallback(async () => {
    try {
      const res = await fetch(`/api/${exchange}/regime/preview-ladder${pairQuery}`)
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        setLadderPreview(data.preview)
      } else {
        setLadderPreview(null)
        addToast({ type: 'error', title: 'Preview Failed', message: data.message || 'Could not preview ladder' })
      }
    } catch (err) {
      setLadderPreview(null)
      addToast({ type: 'error', title: 'Preview Failed', message: err.message })
    }
  }, [exchange, addToast])

  // Save ladder config edits
  const saveLadderEdits = useCallback(async (edits) => {
    try {
      const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
      if (res.ok) {
        await fetchConfig()
        await fetchLadderPreview()
      } else {
        addToast({ type: 'error', title: 'Save Failed', message: `Could not save ladder settings (HTTP ${res.status})` })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Save Failed', message: err.message })
    }
  }, [exchange, fetchConfig, fetchLadderPreview, addToast])

  // Place ladder orders
  const handlePlaceLadder = async () => {
    setPlacingLadder(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/rebuild-ladder${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        addToast({ type: 'success', title: 'Ladder Placed', message: data.message })
        if (data.status) setSocketStatus(data.status)
        setShowLadderPanel(false)
        setLadderPreview(null)
      } else {
        addToast({ type: 'error', title: 'Ladder Failed', message: data.message || 'Could not place ladder orders' })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Ladder Failed', message: err.message })
    } finally {
      setPlacingLadder(false)
    }
  }

  const handleCancelLadder = () => {
    setCancelLadderConfirm(true)
  }

  const handleExecuteCancelLadder = async () => {
    setCancellingLadder(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/cancel-ladder${pairQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({ success: false, message: 'Bad response' }))
      if (data.success) {
        addToast({ type: 'success', title: 'Ladder Cancelled', message: data.message })
        if (data.status) setSocketStatus(data.status)
        fetchConfig()
      } else {
        addToast({ type: 'error', title: 'Cancel Failed', message: data.message })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Cancel Failed', message: err.message })
    } finally {
      setCancellingLadder(false)
      setCancelLadderConfirm(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading regime engine status...</div>
      </div>
    )
  }

  const isDryRun = status?.isDryRun || config?.dryRun
  const asset = getBaseCurrency(config?.productId)
  const market = status?.market || {}
  const position = status?.position || {}
  const regime = status?.regime || {}
  const health = status?.health || {}
  const risk = status?.risk || {}
  const dryRunState = status?.dryRun || {}
  // Use pendingOrders from dryRunState for dry-run, from status for live
  const pendingOrdersList = isDryRun ? (dryRunState?.pendingOrders || []) : (status?.pendingOrders || [])
  // Only intents that actually need an operator: an in-flight dispatch is
  // reported by the engine but resolves itself within moments.
  const placementIntents = isDryRun ? [] : (status?.placementIntents || []).filter(i => i?.needsAttention)

  // New buys pause when the cycle buy-limit is reached; existing TPs stay active.
  const buysPaused = position?.cycleBuys != null && config?.maxCycleBuys != null && position.cycleBuys >= config.maxCycleBuys
  // A draining/closed fund's next cycle boundary is its close trigger — the
  // "resume buying" reset-cycle action is not applicable then (the engine
  // rejects it server-side too), so hide the button rather than showing an
  // action that would just fail with a confusing error.
  const fundLifecycle = status?.lifecycle?.lifecycle
  const isDrainingOrClosed = fundLifecycle === 'draining' || fundLifecycle === 'closed'

  const regimeStyle = REGIME_COLORS[regime.mode] || REGIME_COLORS.HARVEST
  const healthStyle = HEALTH_COLORS[health.mode] || HEALTH_COLORS.ACTIVE
  const apy = status?.apy || {}
  const tpOptimizer = status?.tpOptimizer || {}
  const sizeOptimizer = status?.sizeOptimizer || {}

  const handleCapitalAdjust = async () => {
    const newAvailable = parseFloat(capitalAdjustValue)
    const adjustment = computeCapitalAdjustment(apy, newAvailable)
    if (!adjustment.ok) {
      addToast({ type: 'error', title: 'Invalid Amount', message: adjustment.error })
      return
    }
    if (adjustment.noop) {
      setCapitalAdjustMode(false)
      return
    }
    const { delta, updates } = adjustment
    setCapitalAdjusting(true)
    try {
      const res = await fetch(`/api/${exchange}/regime/config${pairQuery}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const data = await res.json()
      if (data.success) {
        // Report the values the server actually applied (data.config), not
        // just what we sent — the source of truth after persistence (#701).
        const appliedDeposited = data.config?.depositedCapital ?? updates.depositedCapital
        const appliedMax = data.config?.maxUsdcDeployed ?? updates.maxUsdcDeployed
        addToast({
          type: 'success',
          title: 'Capital Adjusted',
          message: `${delta >= 0 ? '+' : ''}$${delta.toLocaleString()} applied — deposited: $${appliedDeposited.toLocaleString()}, max: $${appliedMax.toLocaleString()}`,
        })
        await Promise.all([fetchConfig(), fetchStatus()])
      } else {
        addToast({ type: 'error', title: 'Adjust Failed', message: data.errors?.join(', ') || 'Unknown error' })
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Adjust Failed', message: err.message })
    }
    setCapitalAdjusting(false)
    setCapitalAdjustMode(false)
  }

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-200 text-sm">
          {error}
        </div>
      )}

      {/* Stopped banner when engine is not running but we have data */}
      {!isRunning && (market.lastPrice > 0 || position.totalAsset > 0) && (
        status?.engineDown ? (
          <div className="bg-orange-900/30 border border-orange-700/50 rounded-lg px-4 py-2 flex items-center gap-3">
            <span className="text-orange-400 text-lg">⚠</span>
            <div>
              <span className="text-orange-300 font-medium text-sm">Engine Unreachable</span>
              <span className="text-gray-400 text-xs ml-2">
                Showing last known state from disk{market.stale ? ' · prices may be stale' : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-4 py-2 flex items-center gap-3">
            <span className="text-red-400 text-lg">■</span>
            <div>
              <span className="text-red-300 font-medium text-sm">Engine Stopped</span>
              <span className="text-gray-400 text-xs ml-2">Live market data streaming &middot; no trading</span>
            </div>
          </div>
        )
      )}

      {/* API-key-denied banner: the exchange rejected the key (commonly the
          server IP is not on the key's allowlist). New orders are halted until
          access is restored; live orders are left untouched. */}
      {health.mode === 'AUTH_DENIED' && (
        <div className="bg-red-900/40 border border-red-600/60 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-red-400 text-xl">🔑</span>
            <div>
              <div className="text-red-300 font-medium text-sm">
                API key denied — trading paused
              </div>
              <div className="text-gray-400 text-xs mt-0.5">
                The exchange rejected the API key (commonly the server IP is not on the key's allowlist). New orders are halted; existing orders are left untouched. Allowlist the IP, then resume — the engine also auto-resumes once an API call succeeds again.
              </div>
              {health.reason && (
                <div className="text-red-400/80 text-[11px] mt-1 font-mono break-all">{health.reason}</div>
              )}
            </div>
          </div>
          <button
            onClick={handleResumeFromAuthDenied}
            disabled={resumingAuth}
            className="shrink-0 px-3 py-1.5 bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
          >
            {resumingAuth ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      )}

      {/* Buys-paused banner: cycle buy-limit reached, new entries paused */}
      {buysPaused && (
        <div className="bg-yellow-900/40 border border-yellow-600/60 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-yellow-400 text-xl">⚠</span>
            <div>
              <div className="text-yellow-300 font-medium text-sm">
                New buys paused — cycle buy-limit reached ({position.cycleBuys}/{config.maxCycleBuys})
              </div>
              <div className="text-gray-400 text-xs mt-0.5">
                The bot will not open new buys until a take-profit closes the cycle. Existing take-profit orders remain active.
              </div>
            </div>
          </div>
          {isRunning && !isDrainingOrClosed && (
            <button
              onClick={() => setResetCycleConfirm(true)}
              disabled={resettingCycle}
              className="shrink-0 px-3 py-1.5 bg-yellow-800 hover:bg-yellow-900 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
            >
              {resettingCycle ? 'Resetting…' : 'Reset cycle & resume buying'}
            </button>
          )}
        </div>
      )}

      {(!isRunning && !market.lastPrice && !position.totalAsset) ? (
        /* No data at all - show placeholder */
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <div className="text-gray-400">
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <p className="text-lg">Regime Engine is not running</p>
            <p className="text-sm text-gray-400 mt-2">
              The regime engine uses volatility-driven entries instead of fixed intervals.
              {isDryRun ? (
                <span className="block mt-1 text-purple-400">
                  Dry-run mode is enabled - trades will be simulated against live data.
                </span>
              ) : (
                ' Click Start in the header to begin adaptive trading.'
              )}
            </p>
            {dcaState?.orders?.some(o => o.status === 'pending') && (
              <button
                className="mt-4 px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                onClick={handlePreviewConvert}
              >
                Upgrade DCA Orders to Regime Engine
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Live Status Bar */}
          <div className="bg-gray-800 rounded-lg p-2 sm:p-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 sm:gap-3">
              {/* Live Price */}
              <div className="col-span-1">
                <span className="text-[10px] text-gray-400">{asset} Price</span>
                <LivePriceTicker
                  price={market.lastPrice}
                  prevPrice={prevPriceRef.current}
                />
                <div className="text-[10px] text-gray-400">
                  Spread: ${formatPriceByMagnitude(market.spread)} ({market.spread && market.lastPrice ? ((market.spread / market.lastPrice) * 10000).toFixed(1) : '-'} bps)
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
                  <div className="text-[10px] text-gray-400 mb-0.5">
                    Entry Status<ConfigTooltip tip={REGIME_TOOLTIPS.entryStatus} align="left" width="w-72" />
                  </div>
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
                  <span className="text-[10px] text-gray-400">
                    Regime<ConfigTooltip tip={REGIME_TOOLTIPS.micro} align="left" width="w-80" />
                  </span>
                  <span className={`${healthStyle.bg} ${healthStyle.text} px-1 py-0.5 rounded text-[10px]`}>
                    {health.mode || 'ACTIVE'}
                  </span>
                </div>
                <div className={`text-xl font-bold ${regimeStyle.text}`}>
                  {regime.mode || 'HARVEST'}
                </div>
                {config?.macroEnabled && status?.macro ? (() => {
                  const macroStyle = MACRO_COLORS[status.macro.mode] || MACRO_COLORS.RANGING
                  const lt = status.macro.longTermBias
                  const ltStyle = lt?.ready ? SUGGESTED_LEVEL_STYLES[lt.suggestedLevel] : null
                  return (
                    <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                      <span className={`px-1 py-0.5 rounded text-[10px] ${macroStyle.bg} border ${macroStyle.border} ${macroStyle.text}`}>
                        {macroStyle.label}
                      </span>
                      <span className="text-[10px] text-gray-400">{status.macro.score?.toFixed(0)}</span>
                      {ltStyle && (
                        <span
                          className={`px-1 py-0.5 rounded text-[10px] ${ltStyle.bg} border ${ltStyle.border} ${ltStyle.text}`}
                          title={`Long-term bias: ${(lt.score * 100).toFixed(0)}/100 — suggests ${ltStyle.label}`}
                        >
                          🤖 {ltStyle.label}
                        </span>
                      )}
                    </div>
                  )
                })() : (
                  <div className="text-[10px] text-gray-400">
                    Since {regime.since ? new Date(regime.since).toLocaleTimeString() : '-'}
                  </div>
                )}
              </div>

              {/* Entry Mode */}
              <div className={`col-span-1 ${status?.entryMode === 'ladder' ? 'bg-indigo-900/30 border-indigo-700/50' : 'bg-gray-800 border-gray-700'} border rounded p-1.5`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-400">
                    Entry<ConfigTooltip tip={REGIME_TOOLTIPS.entryMode} align="right" width="w-72" />
                  </span>
                  {config?.ladderAutoSwitch && (
                    <span className="px-1 py-0.5 bg-purple-900/50 text-purple-400 text-[10px] rounded">Auto</span>
                  )}
                </div>
                <div className={`text-xl font-bold ${status?.entryMode === 'ladder' ? 'text-indigo-400' : 'text-gray-300'}`}>
                  {status?.entryMode === 'ladder' ? 'LADDER' : 'REACTIVE'}
                </div>
                <div className="text-[10px] text-gray-400">
                  {status?.ladder?.active
                    ? `${status.ladder.pendingOrders} orders ($${status.ladder.committedUsdc?.toFixed(0) || 0})`
                    : status?.entryMode === 'ladder' ? 'Waiting for trigger' : 'Single order mode'}
                </div>
                {status?.autoSwitch && (
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    Vol: <span className={status.autoSwitch.volExpansion >= status.autoSwitch.threshold ? 'text-purple-400' : 'text-gray-400'}>{status.autoSwitch.volExpansion}x</span>
                    <span className="text-gray-400"> / {status.autoSwitch.threshold}x</span>
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
                  <span className="text-gray-400">ATR 1m</span>
                  <span className="text-white font-mono">${formatPriceByMagnitude(market.atr1m)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">ATR 5m</span>
                  <span className="text-white font-mono">${formatPriceByMagnitude(market.atr5m)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">VWAP</span>
                  <span className="text-white font-mono">${formatPriceByMagnitude(market.vwap)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">VWAP Dist</span>
                  <span className={`font-mono ${Math.abs(market.vwapDistance || 0) > 1 ? 'text-yellow-400' : 'text-white'}`}>
                    {market.vwapDistance?.toFixed(2) || '-'} ATR
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">RVol</span>
                  <span className="text-white font-mono">{market.realizedVol?.toFixed(2) || '-'}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Expansion</span>
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
                    <div className="text-gray-400 text-[10px] mb-1">Current TP Settings</div>
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
                  {(tpOptimizer.totalCombinedSamples || tpOptimizer.sampleCount || 0) >= 3 && (
                    <div className="p-2 bg-cyan-900/20 border border-cyan-700/30 rounded">
                      <div className="text-cyan-400/70 text-[10px] mb-1">Observed Percentiles ({tpOptimizer.sampleCount || 0} cycles + {tpOptimizer.volSampleCount || 0} vol)</div>
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
                  <div className="flex justify-between text-gray-400 text-[10px]">
                    <span>Last eval: {tpOptimizer.lastVolEvaluationTime
                      ? `${Math.round((Date.now() - Math.max(tpOptimizer.lastEvaluationTime || 0, tpOptimizer.lastVolEvaluationTime || 0)) / 60000)}m ago`
                      : `${tpOptimizer.cyclesSinceEval || 0} cycles ago`}</span>
                    <span>{tpOptimizer.sampleCount || 0} cycles + {tpOptimizer.volSampleCount || 0} vol</span>
                  </div>

                  {/* Recent Adjustments */}
                  {tpOptimizer.adjustmentHistory?.length > 0 && (
                    <div className="pt-2 border-t border-gray-700">
                      <div className="text-gray-400 text-[10px] mb-1">Recent Adjustments</div>
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
                    <div className="text-gray-400 text-[10px] mb-1">Current Size Settings</div>
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
                  <div className="flex justify-between text-gray-400 text-[10px]">
                    <span>Cycles since eval: {sizeOptimizer.cyclesSinceEval || 0}</span>
                    <span>Samples: {sizeOptimizer.recentCycleCount || 0}</span>
                  </div>

                  {/* Recent Adjustments */}
                  {sizeOptimizer.adjustmentHistory?.length > 0 && (
                    <div className="pt-2 border-t border-gray-700">
                      <div className="text-gray-400 text-[10px] mb-1">Recent Adjustments</div>
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
                  <span className="text-[10px] text-gray-400">
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
                    <span className="text-gray-400">
                      Range: {(status.fillTimeStats.minMs / 1000).toFixed(1)}s - {(status.fillTimeStats.maxMs / 1000).toFixed(1)}s
                    </span>
                    <span className={status.fillTimeStats.staleRate > 10 ? 'text-red-400' : 'text-gray-400'}>
                      Stale: {status.fillTimeStats.staleRate}%
                    </span>
                  </div>

                  {status.effectiveStaleMs && (
                    <div className="text-[10px] text-gray-400 pt-1 border-t border-gray-700">
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
                        <span className="text-gray-400">Entry:</span>{' '}
                        <span className="text-white font-mono">${formatPriceByMagnitude(dryRunState.optimalTpAnalytics.currentCycle.entryPrice)}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Max seen:</span>{' '}
                        <span className="text-green-400 font-mono">${formatPriceByMagnitude(dryRunState.optimalTpAnalytics.currentCycle.currentMaxPrice)}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Min seen:</span>{' '}
                        <span className="text-red-400 font-mono">${formatPriceByMagnitude(dryRunState.optimalTpAnalytics.currentCycle.currentMinPrice)}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Optimal TP:</span>{' '}
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
                          <span className="text-gray-400">0%</span>
                          <span className="text-cyan-400">
                            {dryRunState.optimalTpAnalytics.recommendedTpRange.min?.toFixed(1)}% - {dryRunState.optimalTpAnalytics.recommendedTpRange.max?.toFixed(1)}%
                          </span>
                          <span className="text-gray-400">5%</span>
                        </div>
                        <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
                          <span>Config: {config?.tpMinPercent?.toFixed(4)}%-{config?.tpMaxPercent?.toFixed(4)}%</span>
                          <span className="text-blue-400">|</span>
                          <span>Observed</span>
                          <span className="text-cyan-400">|</span>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-gray-400 text-[10px] text-center py-2">
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
                  <button onClick={() => setDrawdownResumeConfirm(true)} className="px-2 py-0.5 bg-green-800 hover:bg-green-900 text-white text-[10px] rounded flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"></span>
                    Resume
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center">
                  <div className="text-[10px] text-gray-400 mb-1">{asset}</div>
                  <div className="text-xs text-white font-mono">{position.totalAsset?.toFixed(4) || 0}</div>
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
                    <div className="h-full bg-orange-500 transition-all" style={{ width: config?.maxAssetExposure ? `${Math.min(100, ((position.totalAsset || 0) / config.maxAssetExposure) * 100)}%` : '0%' }} />
                  </div>
                  <div className="text-[9px] text-gray-400">{config?.maxAssetExposure ? `/ ${config.maxAssetExposure}` : 'uncapped'}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-gray-400 mb-1">USDC</div>
                  {(() => {
                    const filled = position.totalCostBasis || 0
                    const committed = status?.ladder?.committedUsdc || 0
                    const total = filled + committed
                    const max = config?.maxUsdcDeployed || 10000
                    return <>
                      <div className="text-xs text-white font-mono">${total.toFixed(0)}{committed > 0 && <span className="text-indigo-400 text-[9px]"> ({filled.toFixed(0)} + {committed.toFixed(0)} pending)</span>}</div>
                      <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1 flex">
                        <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.min(100, (filled / max) * 100)}%` }} />
                        {committed > 0 && <div className="h-full bg-indigo-500 transition-all" style={{ width: `${Math.min(100 - (filled / max) * 100, (committed / max) * 100)}%` }} />}
                      </div>
                      <div className="text-[9px] text-gray-400">/ ${max}</div>
                    </>
                  })()}
                </div>
                {(() => {
                  // Live fund drawdown from peak (risk manager); the persisted
                  // worst-seen value is shown as a secondary label.
                  const dd = risk.currentDrawdownPercent || 0
                  const maxSeen = position.maxDrawdownSeen || 0
                  const limit = config?.maxDrawdownPercent || 20
                  return (
                    <div className="text-center">
                      <div className="text-[10px] text-gray-400 mb-1">Drawdown</div>
                      <div className={`text-xs font-mono ${dd > limit * 0.8 ? 'text-yellow-400' : 'text-white'}`}>
                        {dd.toFixed(1)}%
                      </div>
                      <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
                        <div className="h-full bg-red-500 transition-all" style={{ width: `${Math.min(100, (dd / limit) * 100)}%` }} />
                      </div>
                      <div className="text-[9px] text-gray-400">/ {limit}%{maxSeen > 0 ? ` · max ${maxSeen.toFixed(1)}%` : ''}</div>
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>

          {/* Middle Column: Position & Risk */}
          <div className="space-y-4">
            {/* 3D Celestial Visualization */}
            {status?.celestial?.enabled && (
              <Suspense fallback={<div className="bg-gray-800 rounded-lg p-4 text-xs text-gray-400">Loading celestial system...</div>}>
                <CelestialVisualization
                  celestial={status.celestial}
                  pendingOrders={pendingOrdersList}
                  currentPrice={market.lastPrice}
                  maxUsdcDeployed={config?.maxUsdcDeployed}
                  baseCurrency={asset}
                />
              </Suspense>
            )}

            {/* Position */}
            <div className="bg-gray-800 rounded-lg p-4 overflow-hidden">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Position</h3>
                <div className="flex items-center gap-2">
                  {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
                  <span className="text-xs text-gray-400">Buys {position.cycleBuys || position.ladderStep || 0}/{config?.maxCycleBuys || 10}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div className="min-w-0">
                  <div className="text-gray-400">{asset} Held</div>
                  <div className="text-orange-400 font-mono truncate">{position.totalAsset?.toFixed(8) || '0'}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-gray-400">On Order</div>
                  <div className="text-yellow-400 font-mono truncate">{(isDryRun && dryRunState?.pnl?.assetOnOrder ? dryRunState.pnl.assetOnOrder : position.assetOnOrder || 0).toFixed(8)}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-gray-400">Reserves</div>
                  <div className="text-cyan-400 font-mono truncate">{(position.realizedAssetPnL || 0).toFixed(8)}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-gray-400">Cost Basis</div>
                  <div className="text-white font-mono truncate">${position.totalCostBasis?.toFixed(2) || '0'}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-gray-400">Avg Cost</div>
                  <div className="text-white font-mono truncate">${formatPriceByMagnitude(position.avgCostBasis)}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-gray-400">Cycle</div>
                  <div className="text-white font-mono">{(position.cyclesCompleted || 0) + 1}</div>
                </div>
              </div>
              <div className="mt-2 pt-2 border-t border-gray-700 grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-900/50 rounded p-2 min-w-0">
                  <div className="text-gray-400">Unrealized P&L</div>
                  <div className={`font-mono text-base ${position.unrealizedPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {formatCurrency(position.unrealizedPnL || 0)}
                  </div>
                </div>
                <div className="bg-gray-900/50 rounded p-2 min-w-0">
                  {(() => {
                    const usdPnL = position.realizedPnL || 0
                    const assetPnL = position.realizedAssetPnL || 0
                    const assetUsd = assetPnL * (market.lastPrice || 0)
                    // Percent should match the displayed USD figure: realized USD over what was actually deposited.
                    // Don't conflate with held-asset value at current price (volatile, grows with BTC price).
                    const denom = apy.depositedCapital || apy.originalCapital || apy.initialCapital || 0
                    const pct = denom > 0 ? (usdPnL / denom) * 100 : 0
                    return <>
                      <div className="text-gray-400 truncate">Realized P&L {pct ? `(${pct.toFixed(2)}%)` : ''}</div>
                      <div className={`font-mono text-base ${usdPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {formatCurrency(usdPnL)}
                      </div>
                      {assetPnL > 0 && (
                        <div className="text-orange-400 text-xs font-mono">
                          <div className="truncate">Holdback: +{assetPnL.toFixed(8)} {asset}</div>
                          {assetUsd > 0 && <div className="truncate">{formatCurrency(assetUsd)}</div>}
                        </div>
                      )}
                    </>
                  })()}
                </div>
              </div>

              {/* Celestial Bodies Summary */}
              {status?.celestial?.enabled && (
                <div className="mt-2 pt-2 border-t border-gray-700 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Celestial Bodies</span>
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
                    <div className="text-gray-400">{recalcPreview.changes?.cyclesCompleted?.before}</div>
                    <div className={recalcPreview.changes?.cyclesCompleted?.before !== recalcPreview.changes?.cyclesCompleted?.after ? 'text-yellow-400' : 'text-gray-400'}>
                      {recalcPreview.changes?.cyclesCompleted?.after}
                    </div>

                    <div className="text-gray-300">P&L</div>
                    <div className="text-gray-400">{formatCurrency(recalcPreview.changes?.realizedPnL?.before)}</div>
                    <div className={recalcPreview.changes?.realizedPnL?.before !== recalcPreview.changes?.realizedPnL?.after ? 'text-yellow-400' : 'text-gray-400'}>
                      {formatCurrency(recalcPreview.changes?.realizedPnL?.after)}
                    </div>

                    <div className="text-gray-300">{asset} Reserves</div>
                    <div className="text-gray-400">{recalcPreview.changes?.realizedAssetPnL?.before?.toFixed(8)}</div>
                    <div className={recalcPreview.changes?.realizedAssetPnL?.before !== recalcPreview.changes?.realizedAssetPnL?.after ? 'text-cyan-400' : 'text-gray-400'}>
                      {recalcPreview.changes?.realizedAssetPnL?.after?.toFixed(8)}
                    </div>

                    <div className="text-gray-300">Cycle Buys</div>
                    <div className="text-gray-400">{recalcPreview.changes?.cycleBuys?.before ?? recalcPreview.changes?.ladderStep?.before}</div>
                    <div className={(recalcPreview.changes?.cycleBuys?.before ?? recalcPreview.changes?.ladderStep?.before) !== (recalcPreview.changes?.cycleBuys?.after ?? recalcPreview.changes?.ladderStep?.after) ? 'text-yellow-400' : 'text-gray-400'}>
                      {recalcPreview.changes?.cycleBuys?.after ?? recalcPreview.changes?.ladderStep?.after}
                    </div>
                  </div>

                  {recalcPreview.cycleDetails?.length > 0 && (
                    <div className="mb-3">
                      <div className="text-xs text-gray-400 mb-1">Completed Cycles:</div>
                      {recalcPreview.cycleDetails.map((cycle, i) => (
                        <div key={i} className="text-xs text-gray-400 pl-2">
                          {cycle.cycleId?.replace('cycle-', '#')} - {cycle.buys} buys, P&L: ${cycle.pnl?.toFixed(2)}, holdback: {cycle.holdbackAsset?.toFixed(8)} {asset}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={handleRecalculateApply}
                      disabled={recalculating}
                      className="flex-1 text-xs px-3 py-1.5 rounded bg-yellow-800 hover:bg-yellow-900 text-white disabled:opacity-50"
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
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-400 mb-2">
                    <span>Deposited: ${(apy.depositedCapital || apy.originalCapital || apy.initialCapital)?.toLocaleString()}</span>
                    <span className="text-green-400">Max: ${(apy.maxUsdcDeployed || apy.currentCapital)?.toLocaleString()}</span>
                    {capitalAdjustMode ? (
                      <span className="inline-flex items-center gap-1">
                        <label htmlFor={capitalAdjustInputId} className="text-cyan-400">Available: $</label>
                        <input
                          id={capitalAdjustInputId}
                          type="number"
                          className="w-24 bg-gray-700 border border-cyan-500 rounded px-1 py-0.5 text-cyan-400 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500"
                          value={capitalAdjustValue}
                          onChange={(e) => setCapitalAdjustValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCapitalAdjust()
                            if (e.key === 'Escape') setCapitalAdjustMode(false)
                          }}
                          autoFocus
                          disabled={capitalAdjusting}
                        />
                        <button
                          onClick={handleCapitalAdjust}
                          disabled={capitalAdjusting}
                          className="text-green-400 hover:text-green-300 disabled:opacity-50"
                          title="Apply"
                        >
                          {capitalAdjusting ? '...' : '\u2713'}
                        </button>
                        <button
                          onClick={() => setCapitalAdjustMode(false)}
                          className="text-gray-400 hover:text-gray-300"
                          title="Cancel"
                        >
                          {'\u2717'}
                        </button>
                      </span>
                    ) : (
                      <span
                        className="text-cyan-400 cursor-pointer hover:underline"
                        onClick={() => {
                          setCapitalAdjustValue(String(Math.round(apy.availableCapital || 0)))
                          setCapitalAdjustMode(true)
                        }}
                        title="Click to adjust available capital (updates deposited & max)"
                      >
                        Available: ${apy.availableCapital?.toLocaleString()}
                      </span>
                    )}
                    <span>Running: {apy.elapsedDays?.toFixed(1)}d</span>
                    <span>{apy.cyclesPerDay?.toFixed(1)} cycles/day</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-green-900/20 border border-green-700/30 rounded p-1.5 min-w-0">
                      <div className="text-green-400/70 text-[10px]">Daily ({(apy.dailyReturnPercent || 0).toFixed(2)}%)</div>
                      <div className="flex flex-col font-mono text-xs min-w-0">
                        <span className="text-green-400">{formatCurrency(apy.estimatedDailyUsdc || 0)} + <span className="text-orange-400">{(apy.estimatedDailyAsset || 0).toFixed(8)}</span></span>
                        <span className="text-green-400">= {formatCurrency((apy.estimatedDailyUsdc || 0) + (apy.estimatedDailyAsset || 0) * (market.lastPrice || 0))}</span>
                      </div>
                    </div>
                    <div className="bg-cyan-900/20 border border-cyan-700/30 rounded p-1.5 min-w-0">
                      <div className="text-cyan-400/70 text-[10px]">Annual ({(apy.estimatedApy || 0) > 9999 ? '>9999' : (apy.estimatedApy || 0).toFixed(0)}% APY)</div>
                      <div className="flex flex-col font-mono text-xs min-w-0">
                        <span className="text-green-400">{formatCurrency((apy.estimatedDailyUsdc || 0) * 365)} + <span className="text-orange-400">{((apy.estimatedDailyAsset || 0) * 365).toFixed(6)} {asset}</span></span>
                        <span className="text-cyan-400">= {formatCurrency(((apy.estimatedDailyUsdc || 0) + (apy.estimatedDailyAsset || 0) * (market.lastPrice || 0)) * 365)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {isDryRun && dryRunState?.pnl && (
                <div className="mt-3 pt-3 border-t border-gray-700 text-xs">
                  <div className="text-purple-400 mb-1">Dry-Run Stats</div>
                  <div className="grid grid-cols-2 gap-2 text-gray-400">
                    <div className="min-w-0 truncate">Simulated Buys: {dryRunState.pnl.totalBought?.toFixed(8) || 0} {asset}</div>
                    <div className="min-w-0 truncate">Simulated Sells: {dryRunState.pnl.totalSold?.toFixed(8) || 0} {asset}</div>
                    <div className="min-w-0 truncate">{asset} on Order: <span className="text-yellow-400">{dryRunState.pnl.assetOnOrder?.toFixed(8) || 0}</span></div>
                    <div className="min-w-0 truncate">{asset} Reserves: <span className="text-cyan-400">{position.realizedAssetPnL?.toFixed(8) || 0}</span></div>
                    <div>Filled Orders: {dryRunState.pnl.filledOrderCount || 0}</div>
                    <div>Avg Entry: ${formatPriceByMagnitude(dryRunState.pnl.avgEntryPrice)}</div>
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
                    <h3 className="text-xs font-medium text-gray-400">
                      Macro Regime<ConfigTooltip tip={REGIME_TOOLTIPS.macro} align="left" width="w-80" />
                    </h3>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${macroStyle.bg} ${macroStyle.text}`}>
                      {macroStyle.label} ({m.score?.toFixed(0)})
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-400">21h EMA</span>
                      <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.h21)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">50h EMA</span>
                      <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.h50)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">200h EMA</span>
                      <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.h200)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">20d EMA</span>
                      <span className="text-white font-mono">${formatPriceByMagnitude(m.emas?.d20)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-gray-700">
                    <div className="text-center">
                      <div className="text-[10px] text-gray-400">Size</div>
                      <div className={`text-xs font-mono ${mults.size !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.size}x</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-400">TP</div>
                      <div className={`text-xs font-mono ${mults.tp !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.tp}x</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-400">Offset</div>
                      <div className={`text-xs font-mono ${mults.offset !== 1.0 ? macroStyle.text : 'text-gray-400'}`}>{mults.offset}x</div>
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-400 mt-1">
                    Updated {m.lastUpdate ? new Date(m.lastUpdate).toLocaleTimeString() : 'never'} | {m.candles?.hourly || 0}h/{m.candles?.daily || 0}d candles
                  </div>
                </div>
              )
            })()}

            {/* Long-Term Bias Panel (Phase 2: advisory depression score + one-click apply) */}
            {status?.macro?.longTermBias && (
              <LongTermBiasPanel
                bias={status.macro.longTermBias}
                config={config}
                presets={presets}
                exchange={exchange}
                pairQuery={pairQuery}
                onConfigUpdate={fetchConfig}
                addToast={addToast}
              />
            )}

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
                  pairQuery={pairQuery}
                  onConfigUpdate={fetchConfig}
                  presets={presets}
                  addToast={addToast}
                />

                <div className="grid grid-cols-3 gap-4 text-xs">
                  <div>
                    <span className="text-gray-400">Base Size<ConfigTooltip tip={CONFIG_TOOLTIPS.baseSize} align="left" /></span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">${config.baseSizeUsdc}</span>
                      {config.sizeAutoManaged && (
                        <span className="px-1 py-0.5 bg-purple-900/50 text-purple-400 text-xs rounded">Auto</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-400">k Factor<ConfigTooltip tip={CONFIG_TOOLTIPS.kFactor} /></span>
                    <div className="text-white">{config.kFactor}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Entry Offset<ConfigTooltip tip={CONFIG_TOOLTIPS.entryOffset} align="right" /></span>
                    <div className="text-white">{config.entryOffsetBps}bps</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Min Interval<ConfigTooltip tip={CONFIG_TOOLTIPS.minInterval} align="left" /></span>
                    <div className="text-white">{config.minIntervalMs / 1000}s</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Max Interval<ConfigTooltip tip={CONFIG_TOOLTIPS.maxInterval} /></span>
                    <div className="text-white">{config.maxIntervalMs / 60000}m</div>
                  </div>
                  <div>
                    <span className="text-gray-400">TP Range<ConfigTooltip tip={CONFIG_TOOLTIPS.tpRange} align="right" /></span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">{config.tpMinPercent?.toFixed(4)}% - {config.tpMaxPercent?.toFixed(4)}%</span>
                      {config.tpAutoManaged && (
                        <span className="px-1 py-0.5 bg-cyan-900/50 text-cyan-400 text-xs rounded">Auto</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-400">Caution Scale<ConfigTooltip tip={CONFIG_TOOLTIPS.cautionScale} align="left" /></span>
                    <div className="text-white">{config.cautionScale}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Trend Scale<ConfigTooltip tip={CONFIG_TOOLTIPS.trendScale} /></span>
                    <div className="text-white">{config.trendScale}</div>
                  </div>
                  <div>
                    <span className="text-gray-400">Max Cycle Buys<ConfigTooltip tip={CONFIG_TOOLTIPS.maxCycleBuys} align="right" /></span>
                    <div className="text-white">{config.maxCycleBuys}</div>
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
              <div className="flex items-center gap-2">
                {isDryRun && <span className="text-xs text-purple-400">(Simulated)</span>}
                {status?.config?.entryMode === 'ladder' && status?.isRunning && (
                  <button
                    onClick={() => {
                      const opening = !showLadderPanel
                      setShowLadderPanel(opening)
                      if (opening) {
                        setLadderEdits({
                          ladderMaxAthDropPct: config?.ladderMaxAthDropPct ?? status?.config?.ladderMaxAthDropPct ?? 80,
                          ladderSpacingMode: config?.ladderSpacingMode ?? status?.config?.ladderSpacingMode ?? 'sqrt',
                          ladderSizeMode: config?.ladderSizeMode ?? status?.config?.ladderSizeMode ?? 'fibonacci',
                          ladderMinSpacingPct: config?.ladderMinSpacingPct ?? status?.config?.ladderMinSpacingPct ?? 0.5,
                        })
                        setLadderNumberDraft({})
                        fetchLadderPreview()
                      }
                    }}
                    className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
                  >
                    {showLadderPanel ? 'Close' : 'Rebuild Ladder'}
                  </button>
                )}
                {status?.position?.ladderActive && status?.isRunning && (
                  <button
                    onClick={handleCancelLadder}
                    disabled={cancellingLadder}
                    className="px-2 py-1 text-xs bg-red-700 hover:bg-red-800 text-white rounded transition-colors disabled:opacity-50"
                  >
                    {cancellingLadder ? 'Cancelling…' : 'Cancel Ladder → Reactive'}
                  </button>
                )}
                {status?.isRunning && (status?.celestial?.bodies?.length || 0) >= 2 && (
                  <button
                    onClick={() => setCollapseAllConfirm(true)}
                    disabled={collapsingAll}
                    title="Cancel all body TP orders, combine into one body, place a single TP"
                    className="px-2 py-1 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50"
                  >
                    {collapsingAll ? 'Collapsing…' : `Collapse All (${status.celestial.bodies.length})`}
                  </button>
                )}
                {pendingOrdersList.length > 0 && (
                  <input
                    aria-label="Filter open orders by ID"
                    type="text"
                    value={openSearchId}
                    onChange={e => setOpenSearchId(e.target.value)}
                    placeholder="Filter by ID…"
                    className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 placeholder-gray-400 w-36"
                  />
                )}
              </div>
            </div>
            {/* Ladder Settings/Preview Panel */}
            {showLadderPanel && ladderEdits && (
              <div className="mb-4 p-3 bg-indigo-900/20 border border-indigo-700/50 rounded-lg space-y-3">
                <div className="text-xs font-medium text-indigo-300">Ladder Settings</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label htmlFor={athDropId} className="text-[10px] text-gray-400 block mb-1">ATH Drop %</label>
                    <input
                      id={athDropId}
                      type="text"
                      inputMode="decimal"
                      value={ladderNumberDraft.ladderMaxAthDropPct ?? ladderEdits.ladderMaxAthDropPct}
                      onChange={e => {
                        const raw = e.target.value
                        setLadderNumberDraft(prev => ({ ...prev, ladderMaxAthDropPct: raw }))
                        if (raw.trim() === '') return // don't commit 0 on clear
                        const n = parseFloat(raw)
                        if (Number.isFinite(n)) setLadderEdits(prev => ({ ...prev, ladderMaxAthDropPct: n }))
                      }}
                      onBlur={() => {
                        setLadderNumberDraft(prev => ({ ...prev, ladderMaxAthDropPct: undefined }))
                        saveLadderEdits({ ladderMaxAthDropPct: ladderEdits.ladderMaxAthDropPct })
                      }}
                      className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
                    />
                  </div>
                  <div>
                    <label htmlFor={spacingModeId} className="text-[10px] text-gray-400 block mb-1">Spacing Mode</label>
                    <select
                      id={spacingModeId}
                      value={ladderEdits.ladderSpacingMode}
                      onChange={e => {
                        const val = e.target.value
                        setLadderEdits(prev => ({ ...prev, ladderSpacingMode: val }))
                        saveLadderEdits({ ladderSpacingMode: val })
                      }}
                      className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
                    >
                      <option value="linear">Linear</option>
                      <option value="sqrt">Sqrt</option>
                      <option value="exponential">Exponential</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={sizeModeId} className="text-[10px] text-gray-400 block mb-1">Size Mode</label>
                    <select
                      id={sizeModeId}
                      value={ladderEdits.ladderSizeMode}
                      onChange={e => {
                        const val = e.target.value
                        setLadderEdits(prev => ({ ...prev, ladderSizeMode: val }))
                        saveLadderEdits({ ladderSizeMode: val })
                      }}
                      className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
                    >
                      <option value="flat">Flat</option>
                      <option value="linear">Linear</option>
                      <option value="sqrt">Sqrt</option>
                      <option value="fibonacci">Fibonacci</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={minSpacingId} className="text-[10px] text-gray-400 block mb-1">Min Spacing %</label>
                    <input
                      id={minSpacingId}
                      type="text"
                      inputMode="decimal"
                      value={ladderNumberDraft.ladderMinSpacingPct ?? ladderEdits.ladderMinSpacingPct}
                      onChange={e => {
                        const raw = e.target.value
                        setLadderNumberDraft(prev => ({ ...prev, ladderMinSpacingPct: raw }))
                        if (raw.trim() === '') return // don't commit 0 on clear
                        const n = parseFloat(raw)
                        if (Number.isFinite(n)) setLadderEdits(prev => ({ ...prev, ladderMinSpacingPct: n }))
                      }}
                      onBlur={() => {
                        setLadderNumberDraft(prev => ({ ...prev, ladderMinSpacingPct: undefined }))
                        saveLadderEdits({ ladderMinSpacingPct: ladderEdits.ladderMinSpacingPct })
                      }}
                      className="w-full bg-gray-700 text-white text-xs rounded px-2 py-1"
                    />
                  </div>
                </div>
                {/* Preview */}
                {ladderPreview ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-4 text-xs text-gray-300">
                      <span>{ladderPreview.levelCount} levels</span>
                      <span>{formatPriceByMagnitude(ladderPreview.levels[0]?.price)} — {formatPriceByMagnitude(ladderPreview.levels[ladderPreview.levels.length - 1]?.price)}</span>
                      <span title={`Max: ${formatCurrency(ladderPreview.maxUsdcDeployed)} − Allocated: ${formatCurrency(ladderPreview.allocatedCapital)}`}>Budget: {formatCurrency(ladderPreview.totalBudget)}</span>
                      <span>Range: {ladderPreview.lowerBoundPct?.toFixed(1)}%</span>
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-400 border-b border-gray-700">
                            <th className="text-left py-1 pr-2">#</th>
                            <th className="text-right py-1 pr-2">Price</th>
                            <th className="text-right py-1 pr-2">Size (USDC)</th>
                            <th className="text-right py-1 pr-2">Qty</th>
                            <th className="text-right py-1">Distance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ladderPreview.levels.map((level, i) => (
                            <tr key={i} className="border-b border-gray-700/30 text-gray-300">
                              <td className="py-1 pr-2 text-gray-400">{i + 1}</td>
                              <td className="text-right py-1 pr-2 font-mono">{formatPriceByMagnitude(level.price)}</td>
                              <td className="text-right py-1 pr-2 font-mono">${level.sizeUsdc?.toFixed(2)}</td>
                              <td className="text-right py-1 pr-2 font-mono">{level.assetQty?.toFixed(8)}</td>
                              <td className="text-right py-1 font-mono text-gray-400">{level.distancePct?.toFixed(2)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button
                      onClick={handlePlaceLadder}
                      disabled={placingLadder}
                      className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded transition-colors"
                    >
                      {placingLadder ? 'Placing...' : `Place ${ladderPreview.levelCount} Orders`}
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">Loading preview...</div>
                )}
              </div>
            )}
            <OpenOrdersTable
              pendingOrdersList={pendingOrdersList}
              liveFills={liveFills}
              dryRunFilled={dryRunState?.filledOrders}
              isDryRun={isDryRun}
              celestialBodies={status?.celestial?.bodies || EMPTY_BODIES}
              position={position}
              config={config}
              market={market}
              asset={asset}
              isRunning={isRunning}
              openSearchId={openSearchId}
              setTpEditModal={setTpEditModal}
              setRollUpConfirm={setRollUpConfirm}
            />
          </div>

          {/* Unresolved placement intents — while any exist the fund refuses new placements */}
          {placementIntents.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-amber-600/60">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-amber-400">
                  Unresolved Placements ({placementIntents.length})
                </h3>
                <span className="text-xs text-gray-400">New orders are blocked until these are reconciled</span>
              </div>
              <div className="space-y-2">
                {placementIntents.map(intent => (
                  <div key={intent.id} className="rounded bg-gray-900/60 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-mono text-gray-200">
                        <span className={intent.needsAttention ? 'text-amber-400' : 'text-gray-400'}>
                          {intent.status === 'unresolved' ? 'UNRESOLVED' : 'DISPATCHING'}
                        </span>
                        {' · '}{intent.action || 'order'}{' · '}{intent.side || '?'}
                        {intent.size ? ` ${intent.size} ${asset}` : ''}
                        {intent.price ? ` @ ${formatPriceByMagnitude(intent.price)}` : ''}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setIntentConfirm({ intent, action: 'adopt' })}
                          disabled={reconcilingIntent || !intent.clientOrderId}
                          title={intent.clientOrderId ? 'Look the order up on the exchange and adopt it into tracking' : 'No client order id was recorded — check the exchange manually, then discard'}
                          className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
                        >
                          Adopt
                        </button>
                        <button
                          type="button"
                          onClick={() => setIntentConfirm({ intent, action: 'discard' })}
                          disabled={reconcilingIntent}
                          className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50"
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 text-gray-400">{intent.recoveryHint}</div>
                    <div className="mt-1 text-gray-400 font-mono">
                      {intent.clientOrderId ? `client_order_id ${intent.clientOrderId} · ` : ''}
                      {formatTimestamp(intent.createdAt)}
                      {intent.reason ? ` · ${intent.reason}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <FilledOrdersSection
            liveFills={liveFills}
            isDryRun={isDryRun}
            dryRunFilled={dryRunState?.filledOrders}
            pendingOrdersList={pendingOrdersList}
            market={market}
            asset={asset}
          />
        </div>
        </>
      )}

      {/* Operational confirmation modals */}
      <RegimeActionModals
        cancelLadderConfirm={cancelLadderConfirm}
        cancellingLadder={cancellingLadder}
        onDismissCancelLadder={() => setCancelLadderConfirm(false)}
        onExecuteCancelLadder={handleExecuteCancelLadder}
        collapseAllConfirm={collapseAllConfirm}
        collapsingAll={collapsingAll}
        onDismissCollapseAll={() => setCollapseAllConfirm(false)}
        onExecuteCollapseAll={handleCollapseAll}
        resetCycleConfirm={resetCycleConfirm}
        resettingCycle={resettingCycle}
        onDismissResetCycle={() => setResetCycleConfirm(false)}
        onExecuteResetCycle={handleResetCycle}
        intentConfirm={intentConfirm}
        reconcilingIntent={reconcilingIntent}
        onDismissIntent={() => setIntentConfirm(null)}
        onExecuteIntent={handleReconcileIntent}
        drawdownResumeConfirm={drawdownResumeConfirm}
        onDismissResumeDrawdown={() => setDrawdownResumeConfirm(false)}
        onExecuteResumeDrawdown={handleResumeDrawdown}
        rollUpConfirm={rollUpConfirm}
        rollingUp={rollingUp}
        onDismissRollUp={() => setRollUpConfirm(null)}
        onExecuteRollUp={handleRollUp}
        tpEditModal={tpEditModal}
        settingTp={settingTp}
        onDismissSetTp={() => setTpEditModal(null)}
        onExecuteSetTp={handleSetTp}
        onSetTpMode={(mode) => setTpEditModal(prev => ({ ...prev, mode }))}
        onSetTpInputValue={(inputValue, priceValue) => setTpEditModal(prev => ({ ...prev, inputValue, priceValue }))}
        onSetTpPriceValue={(priceValue, inputValue) => setTpEditModal(prev => ({ ...prev, priceValue, inputValue }))}
        showConvertConfirm={showConvertConfirm}
        converting={converting}
        convertPreview={convertPreview}
        onDismissConvert={() => setShowConvertConfirm(false)}
        onExecuteConvert={handleExecuteConvert}
        status={status}
        position={position}
        config={config}
        getBaseCurrency={getBaseCurrency}
        getQuoteCurrency={getQuoteCurrency}
      />
    </div>
  )
}

export default RegimeDashboard
