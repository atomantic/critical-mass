// @ts-check
// Guard for #1880: the admin refreshes data from pushed realtime events
// (hooks/useRealtimeRefresh), not on timers. This fails if a polling hook or an
// interval timer comes back outside the UI-only allowlist below.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'admin', 'src')

// Interval timers that drive local UI state only and never touch the network.
const UI_ONLY_INTERVALS = new Map([
  ['components/Dashboard.jsx', 'next-trade countdown'],
  ['components/regime/LiveStatusBar.jsx', 'elapsed-time clock'],
  ['components/updown/Dashboard.jsx', 're-render so a stalled price feed shows as stale'],
  ['hooks/useChartDataBuffer.js', 'batches already-received ticks into chart state'],
  ['hooks/useCandleData.js', 'renders already-received candles at most every 5 s'],
])

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  if (entry.isDirectory()) return files(full)
  return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : []
})

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('admin has no polling (#1880)', () => {
  const sources = files(SRC).map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), code: stripComments(fs.readFileSync(file, 'utf8')) }))

  it('does not use a polling hook', () => {
    assert.ok(!fs.existsSync(path.join(SRC, 'hooks', 'usePolling.js')), 'hooks/usePolling.js must stay deleted')
    const offenders = sources.filter(({ code }) => /\busePolling\b/.test(code)).map(({ rel }) => rel)
    assert.deepEqual(offenders, [])
  })

  it('starts interval timers only in the UI-only allowlist', () => {
    const offenders = sources
      .filter(({ rel, code }) => /\b(?:window\.)?setInterval\s*\(/.test(code.replace(/setInterval\s*\(\s*tfKey\s*\)/g, '')) && !UI_ONLY_INTERVALS.has(rel))
      .map(({ rel }) => rel)
    assert.deepEqual(offenders, [], 'refresh from a realtime event with useRealtimeRefresh instead of an interval')
  })

  it('keeps allowlisted interval files free of network reads inside the timer callback', () => {
    for (const rel of UI_ONLY_INTERVALS.keys()) {
      const code = sources.find((source) => source.rel === rel)?.code
      assert.ok(code, `${rel} is allowlisted but missing`)
      const callbacks = [...code.matchAll(/\b(?:window\.)?setInterval\s*\(\s*([A-Za-z_$][\w$]*|\(\s*\)\s*=>[^,]*)/g)].map((match) => match[1])
      assert.ok(callbacks.length > 0, `${rel} no longer starts an interval; drop it from the allowlist`)
      for (const callback of callbacks) {
        assert.doesNotMatch(callback, /apiGet|apiPost|apiRequest|fetch/, `${rel} interval callback reads the network`)
      }
    }
  })
})
