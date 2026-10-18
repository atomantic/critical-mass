export const AGGRESSIVENESS_LEVEL_META = {
  conservative: { label: 'Conservative', color: 'green' },
  moderate: { label: 'Moderate', color: 'blue' },
  aggressive: { label: 'Aggressive', color: 'yellow' },
  maximum: { label: 'Maximum', color: 'red' },
}
export const buildAggressivenessLevels = (presets) =>
  Object.entries(AGGRESSIVENESS_LEVEL_META).map(([id, meta]) => ({
    id,
    ...meta,
    params: presets[id] || {},
  }))

// Get parameter values for a given level from presets
export const computeAggressivenessParams = (levelId, presets) => {
  return presets[levelId] ? { ...presets[levelId] } : null
}

// Detect current aggressiveness level from config based on actual parameter values
export const detectAggressivenessLevel = (config, presets) => {
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
export const formatInterval = (ms) => {
  if (ms >= 3600000) return `${ms / 3600000}hr`
  if (ms >= 60000) return `${ms / 60000}min`
  return `${ms / 1000}s`
}
