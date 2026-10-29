// @ts-check
// Guard for #1880: selected admin views refresh from pushed realtime events.
// Catch the removed polling hook and unreviewed interval timers; this does not
// cover completion-scheduled timeouts, such as the AI run status poll.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'admin', 'src')

// Exact interval callbacks that drive local UI state only and never touch the network.
// Restrict the callback and count, not merely the file: an allowed file could
// otherwise acquire a second, network-backed interval without failing this guard.
const UI_ONLY_INTERVALS = new Map([
  ['components/Dashboard.jsx', ['updateCountdown']], // next-trade countdown
  ['components/regime/LiveStatusBar.jsx', ['() => setNow(Date.now())']], // elapsed-time clock
  ['components/updown/Dashboard.jsx', ['() => setClock(n => n + 1)']], // stale-price clock
  ['hooks/useChartDataBuffer.js', ['flush']], // batches already-received ticks
  ['hooks/useCandleData.js', ['syncChart']], // renders already-received candles
])

// Named callbacks may invoke helpers, so checking only for fetch in the body
// does not establish that a changed body is UI-only. Pin the reviewed bodies;
// any change requires explicitly reviewing and updating the corresponding pin.
const UI_ONLY_NAMED_BODIES = new Map([
  ['components/Dashboard.jsx', ['updateCountdown', `{
    const now = Date.now()
    const target = new Date(nextTrade.nextTradeTime).getTime()
    const remaining = target - now
    setCountdown(formatCountdown(remaining))
  }`]],
  ['hooks/useChartDataBuffer.js', ['flush', `{
    if (!dirtyRef.current) return
    dirtyRef.current = false
    priceRef.current = trimOldData(priceRef.current)
    atrRef.current = trimOldData(atrRef.current)
    regimeRef.current = trimOldData(regimeRef.current)
    setPriceHistory([...priceRef.current])
    setAtrHistory([...atrRef.current])
    setRegimeHistory([...regimeRef.current])
  }`]],
  ['hooks/useCandleData.js', ['syncChart', `{
    const map = bucketsRef.current
    for (const bucket of map.values()) bucket.signalChange = null
    applySignalAnnotations(map, signalAnnotationsRef.current, bucketMs)
    const displayed = [...map.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-maxBuckets)
    setChartData(labelCacheRef.current.sync(displayed, { exchange, bucketMs }))
  }`]],
])

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  if (entry.isDirectory()) return files(full)
  return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : []
})

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('admin interval timers (#1880)', () => {
  const sources = files(SRC).map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), code: stripComments(fs.readFileSync(file, 'utf8')) }))

  it('does not use a polling hook', () => {
    assert.ok(!fs.existsSync(path.join(SRC, 'hooks', 'usePolling.js')), 'hooks/usePolling.js must stay deleted')
    const offenders = sources.filter(({ code }) => /\busePolling\b/.test(code)).map(({ rel }) => rel)
    assert.deepEqual(offenders, [])
  })

  it('starts interval timers only in the UI-only allowlist', () => {
    for (const { rel, code } of sources) assertAllowedTimers(rel, code)
  })

  it('rejects an extra interval even when it delegates a network read to a helper', () => {
    const code = `
      const updateCountdown = () => {};
      setInterval(updateCountdown, 1000);
      const readFreshData = () => apiGet('/api/status');
      setInterval(() => readFreshData(), 5000);
    `
    assert.throws(() => assertAllowedTimers('components/Dashboard.jsx', code), /unexpected interval callbacks/)
  })

  it('requires review when an approved named callback starts calling a helper', () => {
    const code = `
      const updateCountdown = () => { readFreshData() };
      const readFreshData = () => apiGet('/api/status');
      setInterval(updateCountdown, 1000);
    `
    assert.doesNotThrow(() => assertAllowedTimers('components/Dashboard.jsx', code))
    assert.throws(() => assertNamedCallbackBody('components/Dashboard.jsx', code), /callback body changed/)
  })

  it('only exempts the chart timeframe setter, not a browser timer', () => {
    assert.doesNotThrow(() => assertAllowedTimers('components/charts/BTCPriceChart.jsx', 'setInterval(tfKey)'))
    assert.throws(() => assertAllowedTimers('other.jsx', 'setInterval(tfKey)'), /unexpected interval callbacks/)
    assert.throws(() => assertAllowedTimers('components/charts/BTCPriceChart.jsx', 'window.setInterval(tfKey, 1000)'), /unexpected interval callbacks/)
    assert.throws(() => assertAllowedTimers('other.jsx', "setInterval(() => apiGet('('), 1000)"), /unexpected interval callbacks/)
  })

  it('checks reviewed timer bodies for direct network reads and changes', () => {
    const network = /\b(?:apiGet|apiPost|apiPut|apiRequest|fetch)\b|\bfetch[A-Z]\w*\s*\(/
    for (const rel of UI_ONLY_INTERVALS.keys()) {
      const code = sources.find((source) => source.rel === rel)?.code
      assert.ok(code, `${rel} is allowlisted but missing`)
      if (UI_ONLY_NAMED_BODIES.has(rel)) assertNamedCallbackBody(rel, code)
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

function assertAllowedTimers(rel, code) {
  // BTCPriceChart's locally scoped setInterval updates a timeframe rather
  // than starting a timer. A window.setInterval call is still a timer.
  const timerSource = rel === 'components/charts/BTCPriceChart.jsx'
    ? code.replace(/(?<![\w.])setInterval\s*\(\s*tfKey\s*\)/g, '')
    : code
  const callbacks = intervalCallbacks(timerSource).map(({ text }) => text.replace(/\s+/g, ' ').trim())
  assert.deepEqual(callbacks, UI_ONLY_INTERVALS.get(rel) || [],
    `${rel}: unexpected interval callbacks; refresh from realtime events instead`)
}

function assertNamedCallbackBody(rel, code) {
  const [name, expected] = UI_ONLY_NAMED_BODIES.get(rel)
  const body = definitionBody(code, name)
  assert.ok(body, `${rel}: could not resolve the body of timer callback ${name}`)
  const normalize = text => text.replace(/\s+/g, ' ').trim()
  assert.equal(normalize(body), normalize(expected), `${rel}: ${name} callback body changed; review it before updating the pin`)
}

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
    else found.push({ kind: 'inline', text: first || '<unresolved interval>' })
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
