import { describeConfigSaveError } from '../../utils/configSaveError.mjs'
import LongTermBiasDetails from './LongTermBiasDetails'
import React, { useState } from 'react'
import { detectAggressivenessLevel, computeAggressivenessParams, AGGRESSIVENESS_LEVEL_META } from './aggressiveness'
import { SUGGESTED_LEVEL_STYLES, CACHE_HEALTH_STYLES } from './regimeStyles'
import { ConfigTooltip, LONG_TERM_BIAS_TOOLTIP } from './RegimeHelp'

export default function LongTermBiasPanel({ bias, config, presets, exchange, pairQuery, onConfigUpdate, addToast }) {
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
        // persisted: saved to disk but not applied live — refetch so the saved level shows.
        addToast?.({
          type: err.persisted === true ? 'warning' : 'error',
          title: err.persisted === true ? 'Suggested level saved, not applied' : 'Could not apply suggested level',
          message: describeConfigSaveError(res.status, err).message,
        })
        if (err.persisted === true) onConfigUpdate()
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Could not apply suggested level', message: describeConfigSaveError(null, err).message })
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
          <span className={`px-1.5 py-0.5 rounded-sm text-[10px] ${healthStyle.bg} ${healthStyle.text}`}>
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
          <span className={`px-1.5 py-0.5 rounded-sm text-[10px] ${healthStyle.bg} ${healthStyle.text}`}>
            {healthStyle.label}
          </span>
          <span className="px-1.5 py-0.5 rounded-sm text-[10px] bg-gray-900 text-gray-400 border border-gray-700">
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
        <div className="h-2 bg-gray-900 rounded-sm overflow-hidden">
          <div
            className={`h-full ${suggestedStyle.bar} transition-all`}
            style={{ width: `${scorePct}%` }}
          />
        </div>
      </div>

      {/* Suggested vs current level */}
      <div className={`p-2 rounded-sm mb-2 ${suggestedStyle.bg} border ${suggestedStyle.border}`}>
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
            className={`mt-2 w-full px-2 py-1 text-[11px] font-medium rounded-sm border transition-all ${suggestedStyle.border} ${suggestedStyle.text} hover:bg-gray-900/60 ${applying ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {applying ? 'Applying…' : `Apply Suggested (${suggestedLabel})`}
          </button>
        )}
      </div>

      <LongTermBiasDetails c={c} bias={bias} coveragePct={coveragePct} />
    </div>
  )
}
