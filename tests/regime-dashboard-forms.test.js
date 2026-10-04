const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
let dashboardCode
let computeCapitalAdjustment
// The only function components this harness actually invokes (see
// `elements()` below) — the three forms #760 pulled out of
// RegimeDashboard.jsx. Every other inline helper component keeps the
// pre-#760 "never invoked, just walk its children prop" behavior.
const EXTRACTED_COMPONENT_NAMES = new Set(['PositionCard', 'LadderPanel', 'CapitalAdjust', 'AggressivenessControl'])

before(async () => {
  // Use the admin build's JSX compiler, with dependencies left external so no
  // sockets, charts, or trading services are started by this render harness.
  // PositionCard/LadderPanel/CapitalAdjust (#760) are bundled IN (not left
  // external) so their JSX actually renders through this harness's fake
  // hooks, instead of resolving to the `() => null` stub every other
  // relative import gets — see the "componentInstances" render loop below.
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'RegimeDashboard.jsx'),
    external: id => !/\/(PositionCard|LadderPanel|CapitalAdjust)(\.jsx)?$/.test(id),
    transform: { jsx: 'react' },
  })
  try {
    const { output } = await bundle.generate({ format: 'cjs' })
    dashboardCode = output[0].code
  } finally {
    await bundle.close()
  }
  // Wire in the REAL pure calculation (issue #701), not a stub, so this
  // integration-level harness exercises the same clamp-detection the
  // component actually ships with — see tests/capital-adjustment.test.js
  // for the pure function's own unit coverage.
  ;({ computeCapitalAdjustment } = await import(
    pathToFileURL(path.join(__dirname, '..', 'admin', 'src', 'utils', 'capitalAdjustment.mjs')).href
  ))
})

function createDashboard({ apy: apyOverrides = {}, intercept } = {}) {
  const writes = []
  const toasts = []
  // Per-component-type hook state, so extracted children (PositionCard,
  // LadderPanel, CapitalAdjust — #760) get their own persistent
  // useState/useId sequence instead of sharing the root's. Each of these
  // components is rendered exactly once in the tree, so keying by the
  // function reference itself is a stable, order-independent identity —
  // no path-based reconciliation needed.
  const componentInstances = new Map()
  let currentInstance = null
  function getInstance(type) {
    let inst = componentInstances.get(type)
    if (!inst) {
      // `name` qualifies the useId mock below so two different component
      // TYPES (e.g. CapitalAdjust and LadderPanel) never both mint "form-0"
      // — real DOM ids need to stay unique across component instances, not
      // just within one.
      inst = { name: type.name || 'component', states: [], refs: [], refIndex: 0, stateIndex: 0, idIndex: 0, effects: [], mounted: false }
      componentInstances.set(type, inst)
    }
    return inst
  }
  // Invoke a function component with its own instance active, mirroring a
  // real renderer's per-fiber hook dispatch (the SAME `hooks` object below
  // is shared by every bundled component; only `currentInstance` changes).
  function invoke(type, props) {
    const inst = getInstance(type)
    inst.stateIndex = 0
    inst.refIndex = 0
    inst.idIndex = 0
    const prev = currentInstance
    currentInstance = inst
    try {
      return type(props)
    } finally {
      currentInstance = prev
      inst.mounted = true
    }
  }
  const config = {
    productId: 'BTC-USD', entryMode: 'ladder', maxCycleBuys: 10,
    baseSizeUsdc: 10, kFactor: 0.6, minIntervalMs: 1000, maxIntervalMs: 60000,
    tpMinPercent: 1, tpMaxPercent: 5, cautionScale: 0.5, trendScale: 0,
    maxUsdcDeployed: 1000,
  }
  const status = {
    isRunning: true, config, market: { lastPrice: 100 },
    position: { cycleBuys: 1, lastEntryTime: 1, cyclesCompleted: 0, totalAsset: 0 },
    health: { mode: 'ACTIVE' },
    apy: { engineStartTime: 1, availableCapital: 500, depositedCapital: 1000, maxUsdcDeployed: 1000, ...apyOverrides },
  }
  const hooks = {
    ...React,
    useState(initial) {
      const inst = currentInstance
      const index = inst.stateIndex++
      if (!(index in inst.states)) inst.states[index] = typeof initial === 'function' ? initial() : initial
      return [inst.states[index], value => {
        inst.states[index] = typeof value === 'function' ? value(inst.states[index]) : value
      }]
    },
    useEffect(effect) { const inst = currentInstance; if (!inst.mounted) inst.effects.push(effect) },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef(initial) {
      const inst = currentInstance
      const index = inst.refIndex++
      if (!(index in inst.refs)) inst.refs[index] = { current: initial }
      return inst.refs[index]
    },
    useId: () => `form-${currentInstance.name}-${currentInstance.idIndex++}`,
    lazy: () => () => null,
  }
  const fetch = async (url, options = {}) => {
    const intercepted = intercept && await intercept(url, options)
    if (intercepted) return intercepted
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body)
      writes.push({ url, body })
      // Mirror the real PUT /regime/config handler's merge-and-echo-back
      // behavior (buildClientConfig) so a toast built from data.config
      // reflects what was actually persisted, not stale mock state.
      Object.assign(config, body)
    }
    const data = url.includes('/preview-ladder')
      ? { success: true, preview: { levels: [{ price: 90, sizeUsdc: 10, assetQty: 0.1 }], levelCount: 1 } }
      : { success: true, status, config, fills: [], presets: {} }
    return { ok: true, status: 200, json: async () => data }
  }
  const stubs = {
    react: hooks,
    '../hooks/useTradeEvents': { useRegimeEvents: () => ({ status, setStatus() {} }) },
    '../hooks/useChartDataBuffer': {
      useChartDataBuffer: () => ({ priceHistory: [], atrHistory: [], regimeHistory: [], initializeFromCache() {} }),
    },
    './Toast': { useToast: () => ({ addToast: toast => toasts.push(toast) }) },
    '../App': { getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USD' },
    '../utils/api': { pairQuery: pair => `?pair=${encodeURIComponent(pair)}` },
    '../utils/requestOwner.mjs': { createRequestOwner: () => ({ read: async () => ({ owned: true, data: { fills: [] } }), invalidate() {} }) },
    '../utils/liveTimerElapsed.mjs': {},
    '../utils/capitalAdjustment.mjs': { computeCapitalAdjustment },
    // CapitalAdjust.jsx (admin/src/components/regime/CapitalAdjust.jsx) is
    // one directory deeper than RegimeDashboard.jsx, so its own relative
    // specifier for the same external module differs from the one above —
    // rolldown keeps each bundled file's original external specifier text
    // as-is, so both spellings need a stub.
    '../../utils/capitalAdjustment.mjs': { computeCapitalAdjustment },
    './charts/chartUtils': {
      getPriceDecimals: () => 2, formatPriceByMagnitude: value => String(value ?? 0),
      formatCurrency: value => `$${value ?? 0}`,
    },
    // Same "deeper directory, different relative spelling" case as above,
    // for LadderPanel.jsx / PositionCard.jsx importing chartUtils.
    '../charts/chartUtils': {
      getPriceDecimals: () => 2, formatPriceByMagnitude: value => String(value ?? 0),
      formatCurrency: value => `$${value ?? 0}`,
    },
  }
  const exports = {}
  const context = vm.createContext({
    exports, module: { exports }, fetch, AbortController, setTimeout, clearTimeout,
    require: name => stubs[name] || (() => null),
  })
  vm.runInContext(dashboardCode, context, { filename: 'RegimeDashboard.jsx' })
  const Dashboard = context.module.exports
  const render = () => invoke(Dashboard, { exchange: 'coinbase', pair: 'BTC-USD' })
  return {
    render, writes, toasts,
    async mount() {
      render()
      for (const effect of getInstance(Dashboard).effects) effect()
      await new Promise(resolve => setImmediate(resolve))
      return render()
    },
    // Recursively flatten a rendered tree into its constituent elements,
    // actually INVOKING any bundled function component it encounters
    // (PositionCard/LadderPanel/CapitalAdjust) so their own JSX output —
    // not just the parent's `<PositionCard .../>` placeholder element — is
    // visible to the label/control assertions below. Every other function
    // component (OpenOrdersTable, RegimeActionModals, the chart components,
    // …) stays an external `() => null` stub per the `external` filter
    // above, so this never renders sockets/services — only the three forms
    // extraction actually moved (#760).
    elements(tree) {
      if (Array.isArray(tree)) return tree.flatMap(node => this.elements(node))
      if (!React.isValidElement(tree)) return []
      // Only actually invoke the three components #760 extracted — every
      // other function component still inline in RegimeDashboard.jsx
      // (LiveTimer, ConfigTooltip, LongTermBiasPanel, …) is out of scope
      // for this harness, exactly as before this change: walking its
      // `props.children` (rather than calling it) is what the pre-#760
      // harness did for every function component, since none were ever
      // invoked.
      if (typeof tree.type === 'function' && EXTRACTED_COMPONENT_NAMES.has(tree.type.name)) {
        return [tree, ...this.elements(invoke(tree.type, tree.props))]
      }
      return [tree, ...this.elements(tree.props.children)]
    },
  }
}

function findElement(dashboard, tree, predicate) {
  const match = dashboard.elements(tree).find(predicate)
  assert.ok(match, 'expected dashboard control to be rendered')
  return match
}

function labeledControl(dashboard, tree, text) {
  const label = findElement(dashboard, tree, node => node.type === 'label' && node.props.children === text)
  assert.ok(label.props.htmlFor, `${text} needs a nonempty label target`)
  const control = findElement(dashboard, tree, node => node.props.id === label.props.htmlFor)
  assert.ok(['input', 'select'].includes(control.type))
  return control
}

describe('RegimeDashboard expanded operational forms', () => {
  it('opens the Available capital form with an associated label and submits the entered value', async () => {
    const dashboard = createDashboard()
    let tree = await dashboard.mount()
    findElement(dashboard, tree, node => node.props.title === 'Click to adjust available capital (updates deposited & max)').props.onClick()
    tree = dashboard.render()
    const input = labeledControl(dashboard, tree, 'Available: $')
    input.props.onChange({ target: { value: '750' } })
    tree = dashboard.render()
    assert.equal(labeledControl(dashboard, tree, 'Available: $').props.id, input.props.id)
    await findElement(dashboard, tree, node => node.type === 'button' && node.props.title === 'Apply').props.onClick()
    assert.equal(dashboard.writes.length, 1)
    assert.equal(dashboard.writes[0].url, '/api/coinbase/regime/config?pair=BTC-USD')
    assert.deepEqual(dashboard.writes[0].body, { depositedCapital: 1250, maxUsdcDeployed: 1250 })
  })

  it('blocks — rather than silently clamps — a capital adjust that would drop max deployed below $1000 (#701)', async () => {
    // maxUsdcDeployed would go 1200 -> 900 (below the $1000 floor). The OLD
    // code silently floored it to 1000 and toasted the full delta anyway.
    const dashboard = createDashboard({ apy: { availableCapital: 1200, depositedCapital: 5000, maxUsdcDeployed: 1200 } })
    let tree = await dashboard.mount()
    findElement(dashboard, tree, node => node.props.title === 'Click to adjust available capital (updates deposited & max)').props.onClick()
    tree = dashboard.render()
    const input = labeledControl(dashboard, tree, 'Available: $')
    input.props.onChange({ target: { value: '900' } })
    tree = dashboard.render()
    await findElement(dashboard, tree, node => node.type === 'button' && node.props.title === 'Apply').props.onClick()

    assert.equal(dashboard.writes.length, 0, 'must not send the clamped write to the server')
    assert.equal(dashboard.toasts.length, 1)
    assert.equal(dashboard.toasts[0].type, 'error')
    assert.match(dashboard.toasts[0].message, /\$1000/)
  })

  it('blocks — rather than silently zeros — a capital adjust that would land deposited capital between $0 and $100 (#701)', async () => {
    // depositedCapital would go 1000 -> 50 (below the $100 floor but not 0).
    // The OLD code silently wrote 0 (auto-derive) and toasted the full delta.
    const dashboard = createDashboard({ apy: { availableCapital: 1000, depositedCapital: 1000, maxUsdcDeployed: 1000 } })
    let tree = await dashboard.mount()
    findElement(dashboard, tree, node => node.props.title === 'Click to adjust available capital (updates deposited & max)').props.onClick()
    tree = dashboard.render()
    const input = labeledControl(dashboard, tree, 'Available: $')
    input.props.onChange({ target: { value: '50' } })
    tree = dashboard.render()
    await findElement(dashboard, tree, node => node.type === 'button' && node.props.title === 'Apply').props.onClick()

    assert.equal(dashboard.writes.length, 0, 'must not send the clamped write to the server')
    assert.equal(dashboard.toasts.length, 1)
    assert.equal(dashboard.toasts[0].type, 'error')
    assert.match(dashboard.toasts[0].message, /\$100/)
  })

  it('reports the server-applied deposited/max values in the success toast (#701)', async () => {
    const dashboard = createDashboard()
    let tree = await dashboard.mount()
    findElement(dashboard, tree, node => node.props.title === 'Click to adjust available capital (updates deposited & max)').props.onClick()
    tree = dashboard.render()
    const input = labeledControl(dashboard, tree, 'Available: $')
    input.props.onChange({ target: { value: '750' } })
    tree = dashboard.render()
    await findElement(dashboard, tree, node => node.type === 'button' && node.props.title === 'Apply').props.onClick()

    assert.equal(dashboard.toasts.length, 1)
    assert.equal(dashboard.toasts[0].type, 'success')
    assert.match(dashboard.toasts[0].message, /deposited: \$1,250, max: \$1,250/)
  })

  it('opens Rebuild Ladder with distinct label targets and saves a spacing selection', async () => {
    const dashboard = createDashboard()
    let tree = await dashboard.mount()
    findElement(dashboard, tree, node => node.type === 'button' && node.props.children === 'Rebuild Ladder').props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    tree = dashboard.render()
    const controls = ['ATH Drop %', 'Spacing Mode', 'Size Mode', 'Min Spacing %'].map(text => labeledControl(dashboard, tree, text))
    assert.equal(new Set(controls.map(control => control.props.id)).size, 4)
    controls[1].props.onChange({ target: { value: 'linear' } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(dashboard.writes.length, 1)
    assert.equal(dashboard.writes[0].url, '/api/coinbase/regime/config?pair=BTC-USD')
    assert.deepEqual(dashboard.writes[0].body, { ladderSpacingMode: 'linear' })
    assert.equal(labeledControl(dashboard, dashboard.render(), 'Spacing Mode').props.value, 'linear')
  })

  describe('Rebuild Ladder settings/preview/placement gate (#851)', () => {
    const tick = () => new Promise(resolve => setImmediate(resolve))
    const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body })
    const deferred = () => {
      let resolve
      const promise = new Promise(r => { resolve = r })
      return { promise, resolve }
    }
    const preview = levelCount => ({ success: true, preview: { levels: [{ price: 90, sizeUsdc: 10, assetQty: 0.1 }], levelCount } })

    // Scripted network: PUT/preview/rebuild each pull from a queue of
    // deferred responses (or an immediate default), recording every call.
    async function openPanel() {
      const net = { puts: [], previews: [], rebuilds: [], putQ: [], previewQ: [], rebuildQ: [] }
      const intercept = async (url, options = {}) => {
        const kind = options.method === 'PUT' ? 'puts' : options.method === 'POST' ? 'rebuilds' : url.includes('/preview-ladder') ? 'previews' : null
        if (!kind) return null
        net[kind].push(url)
        const q = net[kind.replace(/s$/, '') + 'Q'].shift()
        if (q) return q.promise
        if (kind === 'puts') return reply({ success: true, persisted: true, applied: true })
        if (kind === 'rebuilds') return reply({ success: true, message: 'placed' })
        return reply(preview(1))
      }
      const dashboard = createDashboard({ intercept })
      let tree = await dashboard.mount()
      findElement(dashboard, tree, node => node.type === 'button' && node.props.children === 'Rebuild Ladder').props.onClick()
      await tick()
      const ui = {
        net, dashboard,
        control: text => labeledControl(dashboard, dashboard.render(), text),
        place: () => dashboard.elements(dashboard.render()).find(n => n.type === 'button' && typeof n.props.children === 'string' && /^Place \d+ Orders$|^Placing/.test(n.props.children)),
        button: text => dashboard.elements(dashboard.render()).find(n => n.type === 'button' && n.props.children === text),
      }
      return ui
    }

    it('revokes the preview on edit, blocks Place during save/preview, and restores it once applied', async () => {
      const ui = await openPanel()
      assert.equal(ui.place().props.disabled, false)
      const save = deferred()
      ui.net.putQ.push(save)
      ui.control('Size Mode').props.onChange({ target: { value: 'linear' } })
      assert.equal(ui.place(), undefined, 'old preview must lose authority immediately')
      assert.equal(ui.control('Size Mode').props.value, 'linear')
      await tick()
      assert.equal(ui.net.rebuilds.length, 0)
      const pv = deferred()
      ui.net.previewQ.push(pv)
      save.resolve(reply({ success: true, persisted: true, applied: true }))
      await tick()
      assert.equal(ui.place(), undefined, 'still no Place while the matching preview loads')
      pv.resolve(reply(preview(7)))
      await tick()
      assert.equal(ui.place().props.disabled, false)
      assert.equal(ui.place().props.children, 'Place 7 Orders')
    })

    it('serializes saves and ignores an out-of-order preview from an earlier edit', async () => {
      const ui = await openPanel()
      const save1 = deferred(), save2 = deferred(), pv1 = deferred(), pv2 = deferred()
      ui.net.putQ.push(save1, save2)
      ui.net.previewQ.push(pv1, pv2)
      const before = ui.net.previews.length
      ui.control('Size Mode').props.onChange({ target: { value: 'linear' } })
      ui.control('Spacing Mode').props.onChange({ target: { value: 'linear' } })
      await tick()
      assert.equal(ui.net.puts.length, 1, 'second save waits for the first')
      save1.resolve(reply({ success: true, persisted: true, applied: true }))
      await tick()
      assert.equal(ui.net.puts.length, 2)
      assert.equal(ui.net.previews.length, before, 'superseded save does not request a preview')
      save2.resolve(reply({ success: true, persisted: true, applied: true }))
      await tick()
      pv1.resolve(reply(preview(99)))
      await tick()
      assert.equal(ui.place().props.children, 'Place 99 Orders')
    })

    it('discards a stale preview response when a newer edit supersedes it', async () => {
      const ui = await openPanel()
      const stale = deferred()
      ui.net.previewQ.push(stale)
      ui.control('Size Mode').props.onChange({ target: { value: 'linear' } })
      await tick() // save resolves, stale preview now pending
      const save2 = deferred()
      ui.net.putQ.push(save2)
      ui.control('Spacing Mode').props.onChange({ target: { value: 'exponential' } })
      stale.resolve(reply(preview(42)))
      await tick()
      assert.equal(ui.place(), undefined, 'stale preview must not re-enable placement')
      save2.resolve(reply({ success: true, persisted: true, applied: true }))
      await tick()
      assert.equal(ui.place().props.children, 'Place 1 Orders')
    })

    it('never posts a rebuild while a save is pending, even on rapid repeated invocations', async () => {
      const ui = await openPanel()
      const stalePlace = ui.place().props.onClick
      const save = deferred()
      ui.net.putQ.push(save)
      ui.control('Size Mode').props.onChange({ target: { value: 'linear' } })
      await stalePlace()
      await stalePlace()
      assert.equal(ui.net.rebuilds.length, 0)
    })

    it('blocks placement after a rejected save and recovers via Revert or Retry', async () => {
      const ui = await openPanel()
      ui.net.putQ.push({ promise: Promise.resolve(reply({ success: false, errors: ['bad'] }, { ok: false, status: 400 })) })
      ui.control('Size Mode').props.onChange({ target: { value: 'linear' } })
      await tick()
      assert.equal(ui.place(), undefined)
      assert.equal(ui.dashboard.toasts.at(-1).title, 'Save Failed')
      assert.ok(ui.button('Retry') && ui.button('Revert'))
      ui.button('Revert').props.onClick()
      await tick()
      assert.equal(ui.control('Size Mode').props.value, 'fibonacci')
      assert.equal(ui.place().props.disabled, false)

      ui.net.putQ.push({ promise: Promise.resolve(reply({ success: false }, { ok: false, status: 400 })) })
      ui.control('Size Mode').props.onChange({ target: { value: 'flat' } })
      await tick()
      assert.equal(ui.place(), undefined)
      ui.button('Retry').props.onClick()
      await tick()
      assert.equal(ui.net.puts.length, 3, 'Retry re-sends the draft')
      assert.equal(ui.place().props.disabled, false)
    })

    it('keeps placement blocked when settings persisted but were not applied live', async () => {
      const ui = await openPanel()
      ui.net.putQ.push({ promise: Promise.resolve(reply({ success: false, persisted: true, applied: false, error: 'engine down' }, { ok: false, status: 503 })) })
      ui.control('Size Mode').props.onChange({ target: { value: 'linear' } })
      await tick()
      assert.equal(ui.place(), undefined)
      assert.equal(ui.dashboard.toasts.at(-1).title, 'Not Applied')
      assert.equal(ui.button('Revert'), undefined, 'persisted values cannot be reverted locally')
      ui.button('Retry').props.onClick()
      await tick()
      assert.equal(ui.place().props.disabled, false)
    })

    it('revokes the preview while a numeric field is edited but not yet saved', async () => {
      const ui = await openPanel()
      ui.control('Min Spacing %').props.onChange({ target: { value: '2' } })
      assert.equal(ui.place(), undefined)
      assert.equal(ui.net.rebuilds.length, 0)
      ui.control('Min Spacing %').props.onBlur()
      await tick()
      assert.equal(ui.net.puts.length, 1)
      assert.equal(ui.place().props.disabled, false)
    })

    it('posts the rebuild once the latest settings and preview are confirmed', async () => {
      const ui = await openPanel()
      const rebuild = deferred()
      ui.net.rebuildQ.push(rebuild)
      const click = ui.place().props.onClick
      const first = click()
      await click() // second click while placing is a no-op
      assert.equal(ui.net.rebuilds.length, 1)
      rebuild.resolve(reply({ success: true, message: 'placed' }))
      await first
      assert.equal(ui.dashboard.toasts.at(-1).title, 'Ladder Placed')
    })
  })
  describe('Aggressiveness preview/apply (#951)', () => {
    const tick = () => new Promise(resolve => setImmediate(resolve))
    const presets = {
      conservative: { kFactor: 0.9, minIntervalMs: 2000, maxIntervalMs: 90000, entryOffsetBps: 20, cautionScale: 0.4, trendScale: 0, maxCycleBuys: 6 },
      moderate: { kFactor: 0.6, minIntervalMs: 1000, maxIntervalMs: 60000, entryOffsetBps: 10, cautionScale: 0.5, trendScale: 0, maxCycleBuys: 10 },
    }
    async function open(extra = {}) {
      const puts = []
      const intercept = async (url, options = {}) => {
        if (url === '/api/presets/aggressiveness') return { ok: true, status: 200, json: async () => ({ presets }) }
        if (options.method === 'PUT') {
          puts.push(JSON.parse(options.body))
          if (extra.putResult) return extra.putResult()
        }
        return null
      }
      const dashboard = createDashboard({ intercept })
      await dashboard.mount()
      await tick()
      const tree = () => dashboard.render()
      const level = label => findElement(dashboard, tree(), n => n.type === 'button' && n.props.children === label)
      const apply = label => dashboard.elements(tree()).find(n => n.type === 'button' && n.props.children === `Apply ${label}`)
      return { dashboard, puts, level, apply, tree }
    }

    it('selecting a preset previews its parameters without any write', async () => {
      const ui = await open()
      assert.equal(ui.apply('Conservative'), undefined)
      ui.level('Conservative').props.onClick()
      assert.equal(ui.puts.length, 0)
      assert.ok(ui.apply('Conservative'))
      assert.ok(ui.dashboard.elements(ui.tree()).some(n => n.props.children === 'kFactor'))
      assert.equal(ui.level('Conservative').props['aria-pressed'], true)
      assert.equal(ui.level('Conservative').props.onMouseEnter, undefined)
      assert.match(ui.level('Conservative').props.className, /min-h-11/)
    })

    it('Apply sends the selected preset payload once and blocks duplicates while pending', async () => {
      let release
      const ui = await open({ putResult: () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => ({ success: true }) }) }) })
      ui.level('Conservative').props.onClick()
      const click = ui.apply('Conservative').props.onClick
      const first = click()
      const pending = ui.dashboard.elements(ui.tree()).find(n => n.type === 'button' && n.props.children === 'Applying...')
      assert.equal(pending.props.disabled, true, 'Apply is disabled while pending')
      assert.equal(ui.level('Conservative').props.disabled, true)
      assert.equal(ui.puts.length, 1)
      assert.deepEqual(ui.puts[0], { aggressiveness: 'conservative', ...presets.conservative })
      release()
      await first
    })

    it('keeps the preview and applied indicator after a failed Apply', async () => {
      const ui = await open({ putResult: () => ({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) }) })
      ui.level('Conservative').props.onClick()
      await ui.apply('Conservative').props.onClick()
      assert.equal(ui.puts.length, 1)
      assert.equal(ui.dashboard.toasts.at(-1).type, 'error')
      assert.ok(ui.apply('Conservative'), 'preview retained so the operator can retry')
      assert.equal(ui.level('Conservative').props['aria-pressed'], true)
    })
  })
})
