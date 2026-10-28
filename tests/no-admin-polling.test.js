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

  it('keeps allowlisted timer callbacks free of network reads', () => {
    const network = /\b(?:apiGet|apiPost|apiPut|apiRequest|fetch)\b|\bfetch[A-Z]\w*\s*\(/
    for (const rel of UI_ONLY_INTERVALS.keys()) {
      const code = sources.find((source) => source.rel === rel)?.code
      assert.ok(code, `${rel} is allowlisted but missing`)
      const callbacks = intervalCallbacks(code)
      assert.ok(callbacks.length > 0, `${rel} no longer starts an interval; drop it from the allowlist`)
      for (const callback of callbacks) {
        const body = callback.kind === 'name' ? definitionBody(code, callback.text) : callback.text
        assert.ok(body, `${rel}: could not resolve the body of timer callback ${callback.text}`)
        assert.doesNotMatch(body, network, `${rel}: timer callback ${callback.kind === 'name' ? callback.text : 'inline'} reads the network`)
      }
    }
  })
})

// Text of the matching bracket group that opens at `open`.
function balanced(code, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' }
  const stack = []
  for (let i = open; i < code.length; i++) {
    const char = code[i]
    if (pairs[char]) stack.push(pairs[char])
    else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return code.slice(open, i + 1)
    }
  }
  return ''
}

// The first argument of every setInterval(...) call, as a name or inline source.
function intervalCallbacks(code) {
  const found = []
  for (const match of code.matchAll(/\b(?:window\.)?setInterval\s*\(/g)) {
    const open = match.index + match[0].length - 1
    const args = balanced(code, open).slice(1, -1)
    let depth = 0
    let end = args.length
    for (let i = 0; i < args.length; i++) {
      if ('({['.includes(args[i])) depth++
      else if (')}]'.includes(args[i])) depth--
      else if (args[i] === ',' && depth === 0) { end = i; break }
    }
    const first = args.slice(0, end).trim()
    if (/^[A-Za-z_$][\w$]*$/.test(first)) found.push({ kind: 'name', text: first })
    else if (first) found.push({ kind: 'inline', text: first })
  }
  return found
}

// Body of `const name = ...` / `function name(...)`, from its first brace.
function definitionBody(code, name) {
  const definition = new RegExp(`(?:const|let|function)\\s+${name}\\b`).exec(code)
  if (!definition) return ''
  const brace = code.indexOf('{', code.indexOf('=>', definition.index) >= 0 && (code.indexOf('=>', definition.index) < code.indexOf('{', definition.index) || code.indexOf('{', definition.index) < 0)
    ? code.indexOf('=>', definition.index) : definition.index)
  return brace < 0 ? '' : balanced(code, brace)
}
