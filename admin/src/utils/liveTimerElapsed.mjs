// Pure elapsed-tile decision for LiveTimer (issue #586).
// lastEntryTime is initialised to 0 (not undefined); treating 0 as a timestamp
// yields epoch-relative durations (~56 years). Keep the tile mounted and show
// an empty state instead.

export function hasRecordedEntryTime(elapsed) {
  return typeof elapsed === 'number' && elapsed > 0
}

export function resolveElapsedDisplay(elapsed, now, formatDuration) {
  if (!hasRecordedEntryTime(elapsed)) {
    return { empty: true, primary: '—', secondary: 'No entries yet' }
  }
  return { empty: false, primary: formatDuration(now - elapsed), secondary: null }
}
