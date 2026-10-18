export const REGIME_COLORS = {
  HARVEST: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400', label: 'Harvest' },
  CAUTION: { bg: 'bg-yellow-900/50', border: 'border-yellow-500', text: 'text-yellow-400', label: 'Caution' },
  TREND: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400', label: 'Trend' },
}

// Health mode colors
export const HEALTH_COLORS = {
  ACTIVE: { bg: 'bg-green-900/50', text: 'text-green-400', icon: '●' },
  SAFE: { bg: 'bg-yellow-900/50', text: 'text-yellow-400', icon: '◐' },
  PAUSED: { bg: 'bg-gray-700', text: 'text-gray-400', icon: '○' },
  AUTH_DENIED: { bg: 'bg-red-900/50', text: 'text-red-300', icon: '🔑' },
  STOPPED: { bg: 'bg-red-900/30', text: 'text-red-400', icon: '■' },
  ENGINE_DOWN: { bg: 'bg-orange-900/40', text: 'text-orange-400', icon: '⚠' },
}

// Macro regime mode colors
export const MACRO_COLORS = {
  ACCUMULATION: { bg: 'bg-blue-900/50', border: 'border-blue-500', text: 'text-blue-400', label: 'Accumulation' },
  RANGING: { bg: 'bg-gray-800/50', border: 'border-gray-500', text: 'text-gray-400', label: 'Ranging' },
  MARKUP: { bg: 'bg-green-900/50', border: 'border-green-500', text: 'text-green-400', label: 'Markup' },
  DECLINE: { bg: 'bg-red-900/50', border: 'border-red-500', text: 'text-red-400', label: 'Decline' },
}

export const SUGGESTED_LEVEL_STYLES = {
  conservative: { bg: 'bg-green-900/40',  border: 'border-green-700/50',  text: 'text-green-400',  bar: 'bg-green-500',  label: 'Conservative' },
  moderate:     { bg: 'bg-blue-900/40',   border: 'border-blue-700/50',   text: 'text-blue-400',   bar: 'bg-blue-500',   label: 'Moderate' },
  aggressive:   { bg: 'bg-yellow-900/40', border: 'border-yellow-700/50', text: 'text-yellow-400', bar: 'bg-yellow-500', label: 'Aggressive' },
  maximum:      { bg: 'bg-red-900/40',    border: 'border-red-700/50',    text: 'text-red-400',    bar: 'bg-red-500',    label: 'Maximum' },
}

// Cache health badge styles
export const CACHE_HEALTH_STYLES = {
  full:    { bg: 'bg-green-900/40',  text: 'text-green-400',  label: 'Full cache' },
  partial: { bg: 'bg-yellow-900/40', text: 'text-yellow-400', label: 'Partial cache' },
  sparse:  { bg: 'bg-orange-900/40', text: 'text-orange-400', label: 'Sparse cache' },
  empty:   { bg: 'bg-gray-900',      text: 'text-gray-400',   label: 'Empty cache' },
}
