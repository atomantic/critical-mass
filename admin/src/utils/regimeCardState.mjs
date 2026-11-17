// Disclosure state for the collapsible advanced cards on the fund Config page.
// Pure helpers (no React) so the badge / auto-open rules are unit-testable.

// Regime keys each collapsible card owns, by card id.
export const DISCLOSURE_CARD_FIELDS = {
  orderExecution: ['entryOffsetBps', 'entryOffsetUpBps', 'entryOffsetDownBps', 'entryMaxRetries', 'orderStaleMs', 'cancelRateLimitMs', 'maxOpenOrders', 'tpUpdateThresholdPct', 'reconcileIntervalMs'],
  systemHealth: ['staleDataMs', 'staleOrdersMs', 'maxLatencyMs', 'safeRecoveryMs', 'maxRestErrors', 'maxRateLimits'],
  safetyTail: ['maxSpreadBps', 'spreadPauseMs', 'flashMoveMult', 'flashCooldownMs', 'cancelEntriesOnFlash'],
  regimeDetection: ['momentumMult', 'volExpansionMult', 'volContractionMult', 'vwapPeriodHours', 'trendConfirmationPeriods'],
  macro: ['macroEnabled', 'macroUpdateIntervalMs', 'aggressivenessSuggestionHours', 'macroHysteresis', 'macroAccumulationThreshold', 'macroDeclineThreshold', 'macroMarkupThreshold',
    'macroAccumulationSizeMult', 'macroAccumulationTpMult', 'macroAccumulationOffsetMult', 'macroMarkupSizeMult', 'macroMarkupTpMult', 'macroMarkupOffsetMult',
    'macroDeclineSizeMult', 'macroDeclineTpMult', 'macroDeclineOffsetMult'],
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Fields the fund has saved a value for that differs from the server default.
// A field with no saved value shows the default (so it is not "changed"), and a
// field with no known default cannot be compared, so it is not counted.
export function countChangedFromDefault(keys, regimeConfig, defaults) {
  return keys.filter(key => regimeConfig?.[key] !== undefined && defaults?.[key] !== undefined && !same(regimeConfig[key], defaults[key])).length
}

// True when the draft differs from the loaded server copy for any of the keys.
export function hasUnsavedEdit(keys, regimeConfig, baseline) {
  return keys.some(key => !same(regimeConfig?.[key], baseline?.[key]))
}

// Keys named in a rejected save's server messages (`regime.key must be ...`).
export function errorFieldKeys(messages) {
  const text = (Array.isArray(messages) ? messages : [messages]).filter(m => typeof m === 'string').join('\n')
  if (!text) return []
  const all = Object.values(DISCLOSURE_CARD_FIELDS).flat()
  return all.filter(key => new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`).test(text))
}

const storageKey = id => `critical-mass:config-card-open:${id}`

export function readStoredOpen(id) {
  try { return globalThis.localStorage?.getItem(storageKey(id)) === '1' } catch { return false }
}

export function writeStoredOpen(id, open) {
  try { globalThis.localStorage?.setItem(storageKey(id), open ? '1' : '0') } catch { /* storage unavailable: the card just forgets its state */ }
}
