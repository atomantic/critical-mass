import definitions from '../../../shared/interval-definitions.json' with { type: 'json' }

export const INTERVAL_OPTIONS = Object.entries(definitions).map(([value, { label }]) => ({
  value,
  label,
}))

export const getIntervalMs = (intervalType) =>
  (Object.hasOwn(definitions, intervalType) ? definitions[intervalType] : definitions.daily).ms
