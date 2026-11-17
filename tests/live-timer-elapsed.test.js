// Issue #586: LiveTimer's elapsed variant treated lastEntryTime: 0 as Unix
// epoch (now - 0 ≈ 56 years → "497061h"). Decision logic lives in
// admin/src/utils/liveTimerElapsed.mjs so it can be unit-tested without a
// React/jsdom harness; RegimeDashboard.jsx wires it into LiveTimer.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const modulePath = pathToFileURL(
  path.join(__dirname, '..', 'admin', 'src', 'utils', 'liveTimerElapsed.mjs'),
).href

const formatDuration = (ms) => {
  if (!ms || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

describe('LiveTimer elapsed empty-state (issue #586)', () => {
  it('shows — / No entries yet for elapsed = 0, null, and undefined', async () => {
    const { resolveElapsedDisplay, hasRecordedEntryTime } = await import(modulePath)
    const now = Date.now()

    for (const elapsed of [0, null, undefined]) {
      assert.equal(hasRecordedEntryTime(elapsed), false)
      assert.deepEqual(resolveElapsedDisplay(elapsed, now, formatDuration), {
        empty: true,
        primary: '—',
        secondary: 'No entries yet',
      })
    }
  })

  it('formats a duration for a real past lastEntryTime', async () => {
    const { resolveElapsedDisplay, hasRecordedEntryTime } = await import(modulePath)
    const now = 1_700_000_000_000
    const elapsed = now - (2 * 60 * 60 * 1000 + 15 * 60 * 1000)

    assert.equal(hasRecordedEntryTime(elapsed), true)
    assert.deepEqual(resolveElapsedDisplay(elapsed, now, formatDuration), {
      empty: false,
      primary: '2h 15m',
      secondary: null,
    })
  })

  it('rejects non-positive and non-number timestamps (no epoch fallback)', async () => {
    const { hasRecordedEntryTime } = await import(modulePath)
    assert.equal(hasRecordedEntryTime(-1), false)
    assert.equal(hasRecordedEntryTime(NaN), false)
    assert.equal(hasRecordedEntryTime('1700000000000'), false)
  })
})
