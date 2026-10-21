import { CONFIG_FIELD_LABELS, describeConfigSaveError } from '../../utils/configSaveError.mjs'
import React, { useState, useMemo } from 'react'
import { buildAggressivenessLevels, detectAggressivenessLevel, computeAggressivenessParams, formatInterval } from './aggressiveness'

export default function AggressivenessControl({ config, exchange, pairQuery, onConfigUpdate, presets, addToast }) {
  const [updating, setUpdating] = useState(false)
  // The level whose parameters are displayed. Selecting is read-only; only the
  // explicit Apply button writes. The applied indicator stays derived from the
  // fetched config (currentLevel), so a failed Apply never falsely moves it.
  const [previewLevel, setPreviewLevel] = useState(null)

  const levels = useMemo(() => buildAggressivenessLevels(presets || {}), [presets])
  const currentLevel = detectAggressivenessLevel(config, presets)

  const handleLevelChange = async (level) => {
    if (level === currentLevel || updating) return
    if (!presets?.[level]) return

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
        if (err.persisted === true) {
          // Saved to disk but not applied live: show the saved level, not the old one.
          addToast?.({ type: 'warning', title: 'Aggressiveness saved, not applied', message: describeConfigSaveError(res.status, err).message })
          onConfigUpdate()
        } else {
          addToast?.({ type: 'error', title: 'Could not update aggressiveness', message: describeConfigSaveError(res.status, err).message })
        }
      }
    } catch (err) {
      addToast?.({ type: 'error', title: 'Could not update aggressiveness', message: describeConfigSaveError(null, err).message })
    } finally {
      setUpdating(false)
    }
  }

  const previewParams = previewLevel
    ? computeAggressivenessParams(previewLevel, presets || {})
    : null
  const previewMeta = levels.find(l => l.id === previewLevel)
  const canApply = !!previewParams && previewLevel !== currentLevel

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
          <span className="px-1.5 py-0.5 bg-purple-900/50 text-purple-400 text-[10px] rounded-sm">
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
              type="button"
              onClick={() => setPreviewLevel(level.id)}
              aria-pressed={previewLevel === level.id}
              disabled={updating}
              className={`min-w-11 min-h-11 w-full px-2 py-1.5 text-xs font-medium rounded border transition-all ${
                isActive ? classes.active : classes.inactive
              } ${previewLevel === level.id && !isActive ? 'underline underline-offset-4 text-white border-gray-300' : ''} ${updating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {level.label}
            </button>
          )
        })}
      </div>

      {/* Preview panel */}
      {previewParams && (
        <div className="bg-gray-900 rounded-sm p-2 text-xs">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1">
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.kFactor}</span>
              <span className={config?.kFactor !== previewParams.kFactor ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.kFactor}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.minIntervalMs}</span>
              <span className={config?.minIntervalMs !== previewParams.minIntervalMs ? 'text-yellow-400' : 'text-gray-300'}>
                {formatInterval(previewParams.minIntervalMs)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.maxIntervalMs}</span>
              <span className={config?.maxIntervalMs !== previewParams.maxIntervalMs ? 'text-yellow-400' : 'text-gray-300'}>
                {formatInterval(previewParams.maxIntervalMs)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.entryOffsetBps}</span>
              <span className={config?.entryOffsetBps !== previewParams.entryOffsetBps ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.entryOffsetBps}bps
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.cautionScale}</span>
              <span className={config?.cautionScale !== previewParams.cautionScale ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.cautionScale}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.trendScale}</span>
              <span className={config?.trendScale !== previewParams.trendScale ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.trendScale}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">{CONFIG_FIELD_LABELS.maxCycleBuys}</span>
              <span className={config?.maxCycleBuys !== previewParams.maxCycleBuys ? 'text-yellow-400' : 'text-gray-300'}>
                {previewParams.maxCycleBuys}
              </span>
            </div>
          </div>
          {canApply && (
            <button
              type="button"
              onClick={() => handleLevelChange(previewLevel)}
              disabled={updating}
              className={`mt-2 min-w-11 min-h-11 w-full px-3 py-1.5 text-xs font-medium rounded-sm border border-blue-400 bg-blue-600 text-white ${updating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-blue-500'}`}
            >
              {updating ? 'Applying...' : `Apply ${previewMeta?.label || previewLevel}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
