const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const adminRequire = createRequire(path.join(__dirname, '../admin/package.json'))
const React = adminRequire('react')
const compiled = {}
let createRequestOwner

before(async () => {
  ;({ createRequestOwner } = await import('../admin/src/utils/requestOwner.mjs'))
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  for (const name of ['DcaPlacementRecovery', 'Dashboard']) {
    const bundle = await rolldown({
      input: path.join(__dirname, `../admin/src/components/${name}.jsx`),
      external: () => true,
      transform: { jsx: 'react' },
    })
    try { compiled[name] = (await bundle.generate({ format: 'cjs' })).output[0].code }
    finally { await bundle.close() }
  }
})

const intent = {
  id: 'intent-synthetic', clientOrderId: 'client-synthetic', needsAttention: true,
  status: 'unresolved', side: 'buy', action: 'market-buy', reason: 'Status lookup unavailable',
}
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const response = (data, ok = true) => ({ ok, json: async () => data })
const Panel = () => null

// Keep hooks across renders and drive the real component's event handlers.
function view(name, fetchImpl, extra = {}) {
  const values = []
  const effects = []
  let index = 0
  let mounted = false
  const hooks = {
    ...React,
    useState(initial) {
      const key = index++
      if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial
      return [values[key], value => { values[key] = typeof value === 'function' ? value(values[key]) : value }]
    },
    useRef(initial) {
      const key = index++
      if (!(key in values)) values[key] = { current: initial }
      return values[key]
    },
    useCallback: fn => fn,
    useId: () => `id-${index++}`,
    useEffect(effect) { if (!mounted) effects.push(effect) },
  }
  const stubs = {
    react: hooks,
    './ModalDialog': () => null,
    '../utils/api': { pairQuery: pair => `?pair=${encodeURIComponent(pair)}` },
    '../utils/intervals.mjs': { getIntervalMs: () => 86400000 },
    '../utils/requestOwner.mjs': { createRequestOwner: () => createRequestOwner({ fetchImpl }) },
    '../utils/dashboardAction.mjs': {},
    './ActivityFeed': () => null,
    './FailedSellPlacements': () => null,
    './DcaPlacementRecovery': Panel,
    './Toast': { useToast: () => ({ addToast() {} }) },
    './charts/chartUtils': { formatCurrency: String, formatPrice: String, formatAsset: String },
    '../App': { getBaseCurrency: () => 'ETH', getQuoteCurrency: () => 'USDC' },
  }
  const m = { exports: {} }
  vm.runInNewContext(compiled[name], {
    React, module: m, exports: m.exports, fetch: fetchImpl,
    setInterval: () => 1, clearInterval() {}, console, AbortController,
    require: id => { assert.ok(id in stubs, `Unexpected import ${id}`); return stubs[id] },
  })
  let props = { intents: [intent], exchange: 'coinbase', pair: 'ETH-USDC', ...extra }
  const render = (next = {}) => {
    props = { ...props, ...next }
    index = 0
    const tree = (m.exports.default || m.exports)(props)
    mounted = true
    return tree
  }
  return {
    render,
    async mount() { render(); effects.splice(0).forEach(fn => fn()); await settle(); return render() },
  }
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  return React.isValidElement(tree) ? [tree, ...elements(tree.props.children)] : []
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (React.isValidElement(tree)) return text(tree.props.children)
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''
}
const button = (tree, label) => {
  const node = elements(tree).find(n => n.type === 'button' && text(n) === label)
  assert.ok(node, `Expected ${label}`)
  return node
}
const open = (v, label = 'Discard') => { button(v.render(), label).props.onClick(); return v.render() }

describe('DCA placement recovery', () => {
  it('shows a stranded buy on cold load without any failed sells, and retains it on reload', () => {
    for (let reload = 0; reload < 2; reload++) {
      const tree = view('DcaPlacementRecovery', async () => {}).render()
      assert.match(text(tree), /Automation is blocked/)
      assert.match(text(tree), /intent-synthetic/)
      assert.match(text(tree), /client-synthetic/)
      assert.equal(button(tree, 'Discard').props.disabled, false)
    }
  })

  it('keeps rejected discards visible and retryable without clearing the block', async () => {
    const calls = []
    const v = view('DcaPlacementRecovery', async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return response({ success: false, error: 'Intent could not be persisted; block retained' }, false)
    })
    let tree = open(v)
    await button(tree, 'Discard intent').props.onClick()
    tree = v.render()
    assert.deepEqual(calls, [{
      url: '/api/coinbase/reconcile-placement-intent?pair=ETH-USDC',
      body: { intentId: intent.id, action: 'discard' },
    }])
    assert.match(text(tree), /Intent could not be persisted; block retained/)
    assert.equal(button(tree, 'Discard intent').props.disabled, false)
    assert.match(text(tree), /Automation is blocked/)
  })

  it('requires explicit discard confirmation and serializes repeated clicks', async () => {
    const gate = deferred()
    let calls = 0
    let resolved
    const v = view('DcaPlacementRecovery', async (_url, options) => {
      calls++
      assert.equal(JSON.parse(options.body).action, 'discard')
      return gate.promise
    }, { onResolved: data => { resolved = data } })
    let tree = open(v, 'Discard')
    assert.equal(calls, 0, 'opening the confirmation must not mutate the server')
    assert.match(text(tree), /confirming this placement has no live order/)
    const execute = button(tree, 'Discard intent').props.onClick
    const first = execute()
    await execute()
    assert.equal(calls, 1)
    assert.equal(button(v.render(), 'Working…').props.disabled, true)
    gate.resolve(response({ success: true, placementIntents: [], message: 'Discarded; placements resume' }))
    await first
    tree = v.render({ intents: [] })
    assert.equal(resolved.success, true)
    assert.match(text(tree), /Discarded; placements resume/)
    assert.equal(elements(tree).some(n => n.props.labelledBy === 'dca-reconcile-title'), false)
  })

  it('preserves a successful discard when the follow-up read fails', async () => {
    const v = view('DcaPlacementRecovery', async () => response({
      success: true, placementIntents: [], message: 'Intent discarded; placements resume.',
    }), { onResolved: async () => { throw new Error('offline') } })
    await button(open(v), 'Discard intent').props.onClick()
    const tree = v.render({ intents: [] })
    assert.match(text(tree), /Intent discarded; placements resume/)
    assert.doesNotMatch(text(tree), /Transactions → Import/)
    assert.match(text(tree), /Placement reconciled, but the dashboard could not refresh/)
    assert.doesNotMatch(text(tree), /reconciliation failed/i)
  })

  it('retains the row and confirmation after a lost response', async () => {
    const v = view('DcaPlacementRecovery', async () => { throw new Error('Network interrupted') })
    await button(open(v), 'Discard intent').props.onClick()
    assert.match(text(v.render()), /Network interrupted/)
    button(v.render(), 'Cancel')
    button(v.render(), 'Discard intent')
  })

  it('shows manual verification details without a client id and offers only file repair for corruption', () => {
    const v = view('DcaPlacementRecovery', async () => {})
    let tree = v.render({ intents: [{ ...intent, clientOrderId: null }] })
    assert.equal(button(tree, 'Discard').props.disabled, false)
    assert.match(text(tree), /No client order id was recorded/)
    assert.match(text(tree), /Cancel any live order/)
    assert.match(text(tree), /ETH-USDC/)
    tree = v.render({ intents: [{ ...intent, id: 'unreadable-intent-file', recoveryHint: 'Repair placement-intents.json' }] })
    assert.match(text(tree), /Repair placement-intents.json/)
    assert.equal(elements(tree).some(n => n.type === 'button'), false)
  })

  it('renders nothing for an empty or still in-flight intent list', () => {
    const v = view('DcaPlacementRecovery', async () => {})
    assert.equal(v.render({ intents: [] }), null)
    assert.equal(v.render({ intents: [{ ...intent, needsAttention: false }] }), null)
  })

  it('wires authoritative status into the dashboard above its controls and fences pre-reconcile reads', async () => {
    const stale = deferred()
    let reads = 0
    const v = view('Dashboard', async url => {
      if (url.includes('/regime/status')) return response({ running: false })
      if (++reads === 2) return stale.promise
      return response({ placementIntents: reads === 1 ? [intent] : [], failedSells: [] })
    }, { summary: { config: {}, state: {}, stats: {}, nextTrade: {} } })
    let tree = await v.mount()
    let panel = elements(tree).find(n => n.type === Panel)
    assert.equal(panel.props.intents[0].id, intent.id)
    assert.ok(elements(tree).indexOf(panel) < elements(tree).findIndex(n => n.props.label === 'Automation'))
    // Two post-action reads overlap; the stale one must not resurrect the block.
    const older = panel.props.onResolved({ placementIntents: [] }).catch(() => {})
    await settle()
    const newer = panel.props.onResolved({ placementIntents: [] })
    await newer
    stale.resolve(response({ placementIntents: [intent] }))
    await older
    tree = v.render()
    panel = elements(tree).find(n => n.type === Panel)
    assert.deepEqual(panel.props.intents, [])
  })
})
