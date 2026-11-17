// Millisecond fields are stored as ms; the operator may type seconds or minutes.
export const DURATION_UNITS = [
  { value: 's', label: 's', ms: 1000 },
  { value: 'min', label: 'min', ms: 60000 },
]

const unitMs = unit => DURATION_UNITS.find(u => u.value === unit).ms

// Minutes only when the value is a whole number of minutes; everything else
// (including 0) is shown in seconds so no precision is hidden.
export function pickDurationUnit(ms) {
  return Number.isFinite(ms) && ms > 0 && ms % 60000 === 0 ? 'min' : 's'
}

export function msToDisplay(ms, unit) {
  return Number.isFinite(ms) ? ms / unitMs(unit) : ''
}

// Math.round so 0.1 * 1000-style float noise never leaks into the saved value.
export function displayToMs(n, unit) {
  return Math.round(n * unitMs(unit))
}
