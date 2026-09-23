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
const EXTRACTED_COMPONENT_NAMES = new Set(['PositionCard', 'LadderPanel', 'CapitalAdjust'])

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

function createDashboard({ apy: apyOverrides = {} } = {}) {
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
      inst = { states: [], stateIndex: 0, idIndex: 0, effects: [], mounted: false }
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
    useRef: initial => ({ current: initial }),
    useId: () => `form-${currentInstance.idIndex++}`,
    lazy: () => () => null,
  }
  const fetch = async (url, options = {}) => {
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
})
