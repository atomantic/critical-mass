// @ts-check
/**
 * Manual Trades recovery row (issue #1034): a sell-first trade whose recovery
 * buy was cancelled must be visible after a cold load and continuable from its
 * own row. Renders the real ManualTrades component with isolated hook state
 * and synthetic API responses (same harness as admin-accessible-forms.test.js).
 */
const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
let compiled

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'ManualTrades.jsx'),
    external: () => true,
    transform: { jsx: 'react' },
  })
  try {
    compiled = (await bundle.generate({ format: 'cjs' })).output[0].code
  } finally {
    await bundle.close()
  }
})

const cancelledTrade = (overrides = {}) => ({
  id: 'trade-1',
  tradeType: 'sell_first',
  status: 'buy_cancelled',
  sellOrderId: 'sell-order-1',
  sellPrice: 100000,
  sellSize: 0.003,
  buyOrderId: 'buy-order-1',
  buyPrice: 95000,
  buySize: 0.001,
  recoveryAttempts: [{ orderId: 'buy-order-1', outcome: 'cancelled', filledSize: 0.001 }],
  lastCheck: { at: 1, error: null, message: 'Recovery buy buy-order-1 was CANCELLED after executing 0.001; 0.002 still to recover' },
  note: '',
  ...overrides,
})

/** Render ManualTrades with hook state kept between renders and IO mocked. */
function createView(respond) {
  const values = []
  const effects = []
  const writes = []
  let mounted = false
  let index = 0
  const hooks = {
    ...React,
    useState(initial) {
      const key = index++
      if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial
      return [values[key], (value) => { values[key] = typeof value === 'function' ? value(values[key]) : value }]
    },
    useRef(initial) {
      const key = index++
      if (!(key in values)) values[key] = { current: initial }
      return values[key]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(effect) { if (!mounted) effects.push(effect) },
  }
  const fetch = async (url, options = {}) => {
    if (options.method) writes.push({ url, body: options.body ? JSON.parse(options.body) : null })
    return { ok: true, json: async () => respond(url, options) }
  }
  const stubs = {
    react: hooks,
    './charts/chartUtils': { formatCurrency: String, formatPrice: String, formatDateTime: String },
    '../utils/api': { pairQuery: () => '?pair=BTC-USDC' },
    '../utils/plural.mjs': { plural: (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}` },
    '../App': { getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' },
    '../utils/unaccountedFillsScan.mjs': { runUnaccountedFillsScan: async () => ({ status: 'cancelled' }), describeScanProgress: () => '' },
  }
  const exports = {}
  const context = vm.createContext({ React, exports, module: { exports }, fetch, require: (name) => {
    assert.ok(name in stubs, `unexpected import ${name}`)
    return stubs[name]
  } })
  vm.runInContext(compiled, context, { filename: 'ManualTrades.jsx' })
  const render = () => {
    index = 0
    const tree = context.module.exports({ exchange: 'coinbase', pair: 'BTC-USDC' })
    mounted = true
    return tree
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  return {
    render,
    writes,
    settle,
    async mount() {
      render()
      for (const effect of effects.splice(0)) effect()
      await settle()
      return render()
    },
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
  const node = elements(tree).find((n) => n.type === 'button' && text(n).trim() === label)
  assert.ok(node, `expected a "${label}" button`)
  return node
}
const labeled = (tree, label) => {
  const lab = elements(tree).find((n) => n.type === 'label' && text(n).trim() === label)
  assert.ok(lab?.props.htmlFor, `expected a "${label}" label with a target`)
  const input = elements(tree).find((n) => n.type === 'input' && n.props.id === lab.props.htmlFor)
  assert.ok(input, `expected the "${label}" input`)
  return input
}

describe('Manual Trades recovery row (#1034)', () => {
  it('loads on mount and expands to show a cancelled recovery with its controls and last check', async () => {
    const view = createView(() => ({ success: true, trades: [cancelledTrade()] }))
    const tree = await view.mount()

    const content = elements(tree).find((n) => n.props?.id === 'manual-trades-content')
    assert.ok(content, 'section auto-expands for an outstanding recovery')
    assert.match(text(tree), /Recovery Cancelled/)
    assert.match(text(tree), /Recovered 0\.00100000 of 0\.00300000/)
    assert.match(text(tree), /0\.002 still to recover/)
    button(tree, 'Retry recovery')
    button(tree, 'Link replacement')
    assert.equal(elements(tree).some((n) => n.type === 'button' && text(n).trim() === 'Check Status'), false)
  })

  it('stays collapsed when nothing is outstanding', async () => {
    const view = createView(() => ({ success: true, trades: [cancelledTrade({ status: 'completed', lastCheck: null })] }))
    const tree = await view.mount()
    assert.equal(elements(tree).some((n) => n.props?.id === 'manual-trades-content'), false)
  })

  it('submits Retry recovery for the existing trade and reports a refusal without losing the row', async () => {
    let refuse = true
    const view = createView((url) => {
      if (url.includes('/retry')) {
        return refuse
          ? { success: false, error: 'Failed to place recovery buy: INSUFFICIENT_FUNDS' }
          : { success: true, placed: true, trade: cancelledTrade({ status: 'buy_pending', buyOrderId: 'buy-order-2' }) }
      }
      return { success: true, trades: [cancelledTrade()] }
    })
    let tree = await view.mount()
    button(tree, 'Retry recovery').props.onClick()
    tree = view.render()
    labeled(tree, 'Recovery Buy Limit Price (USDC)').props.onChange({ target: { value: '94000' } })
    tree = view.render()
    await button(tree, 'Place Recovery Buy').props.onClick()
    tree = view.render()

    assert.deepEqual(view.writes.at(-1), {
      url: '/api/coinbase/regime/manual-trade/trade-1/retry?pair=BTC-USDC',
      body: { recoveryBuyPrice: 94000 },
    })
    const alert = elements(tree).find((n) => n.props?.role === 'alert')
    assert.match(text(alert), /INSUFFICIENT_FUNDS/)
    // The form, its value and the row's controls survive the failure.
    assert.equal(labeled(tree, 'Recovery Buy Limit Price (USDC)').props.value, '94000')
    button(tree, 'Link replacement')

    refuse = false
    await button(tree, 'Place Recovery Buy').props.onClick()
    tree = view.render()
    assert.match(text(elements(tree).find((n) => n.props?.role === 'status')), /Placed recovery buy buy-order-2/)
    assert.equal(elements(tree).some((n) => n.type === 'label' && /Recovery Buy Limit Price/.test(text(n))), false)
  })

  it('links a replacement order id through the same row action', async () => {
    const view = createView((url) => (url.includes('/retry')
      ? { success: true, linked: true, trade: cancelledTrade({ status: 'buy_pending', buyOrderId: 'manual-buy-9' }) }
      : { success: true, trades: [cancelledTrade()] }))
    let tree = await view.mount()
    button(tree, 'Link replacement').props.onClick()
    tree = view.render()
    labeled(tree, 'Replacement Buy Order ID').props.onChange({ target: { value: ' manual-buy-9 ' } })
    tree = view.render()
    await button(tree, 'Link Buy').props.onClick()

    assert.deepEqual(view.writes.at(-1).body, { existingBuyOrderId: 'manual-buy-9' })
  })

  it('shows a failed status check on a pending row and keeps Check Status available', async () => {
    const view = createView((url) => (url.includes('/check')
      ? { success: false, error: 'Failed to check buy order: 503 upstream' }
      : { success: true, trades: [cancelledTrade({ status: 'buy_pending', lastCheck: null, recoveryAttempts: [{ orderId: 'buy-order-1', outcome: null }] })] }))
    let tree = await view.mount()
    await button(tree, 'Check Status').props.onClick()
    await view.settle()
    tree = view.render()

    assert.match(text(elements(tree).find((n) => n.props?.role === 'alert')), /503 upstream/)
    button(tree, 'Check Status')
    assert.equal(elements(tree).some((n) => n.type === 'button' && text(n).trim() === 'Retry recovery'), false)
  })
})

const pendingImport = (overrides = {}) => ({
  id: 'import-1', tradeType: 'buy_first', status: 'buy_recorded',
  buyOrderId: 'imported-buy-1', buyPrice: 50000, buySize: 0.002,
  bodyIntent: { phase: 'pending', bodyId: 'imported-body-1' },
  ...overrides,
})
const completedImport = () => pendingImport({
  status: 'tp_pending', bodyId: 'imported-body-1',
  bodyIntent: { phase: 'committed', bodyId: 'imported-body-1' },
})

describe('interrupted manual body import recovery', () => {
  it('expands a cold-loaded pending import with its full identities and resume action', async () => {
    const view = createView(() => ({ success: true, trades: [pendingImport()] }))
    const tree = await view.mount()
    assert.ok(elements(tree).some(n => n.props?.id === 'manual-trades-content'))
    assert.match(text(tree), /Import unfinished/)
    assert.match(text(tree), /Buy imported-buy-1.*body imported-body-1/)
    assert.match(text(tree), /may place its take-profit sell/)
    button(tree, 'Resume import')
  })

  it('does not treat an intentional ledger-only buy as an interrupted import', async () => {
    const view = createView(() => ({ success: true, trades: [pendingImport({ bodyIntent: null })] }))
    const tree = await view.mount()
    assert.equal(elements(tree).some(n => n.props?.id === 'manual-trades-content'), false)
  })

  it('keeps failed recovery visible after a reload and retries the same trade', async () => {
    let trade = pendingImport()
    let refuse = true
    const respond = (url) => {
      if (url.includes('/resume')) {
        if (refuse) return { success: false, error: 'Body publication unavailable' }
        trade = completedImport()
        return { success: true, trade }
      }
      return { success: true, trades: [trade] }
    }
    const first = createView(respond)
    await button(await first.mount(), 'Resume import').props.onClick()
    assert.match(text(first.render()), /Body publication unavailable/)
    button(first.render(), 'Resume import')

    const reloaded = createView(respond)
    const tree = await reloaded.mount()
    refuse = false
    await button(tree, 'Resume import').props.onClick()
    assert.deepEqual(reloaded.writes, [{
      url: '/api/coinbase/regime/manual-trade/import-1/resume?pair=BTC-USDC', body: null,
    }])
    assert.match(text(reloaded.render()), /Import completed/)
    assert.equal(elements(reloaded.render()).some(n => n.type === 'button' && text(n) === 'Resume import'), false)
  })

  it('prevents duplicate submissions while the server is finishing the import', async () => {
    let finish
    let trade = pendingImport()
    const pending = new Promise(resolve => { finish = resolve })
    const view = createView(url => url.includes('/resume') ? pending : { success: true, trades: [trade] })
    const action = button(await view.mount(), 'Resume import').props.onClick
    const request = action()
    await action()
    assert.equal(view.writes.length, 1)
    assert.equal(button(view.render(), 'Resuming import...').props.disabled, true)
    trade = completedImport()
    finish({ success: true, trade })
    await request
  })

  it('preserves successful completion when the follow-up read fails', async () => {
    let resumed = false
    const view = createView(url => {
      if (url.includes('/resume')) {
        resumed = true
        return { success: true, trade: completedImport() }
      }
      if (resumed) throw new Error('Status unavailable')
      return { success: true, trades: [pendingImport()] }
    })
    await button(await view.mount(), 'Resume import').props.onClick()
    const tree = view.render()
    assert.match(text(tree), /Import completed, but status could not refresh/)
    assert.doesNotMatch(text(tree), /Import recovery failed/)
    assert.equal(elements(tree).some(n => n.type === 'button' && text(n) === 'Resume import'), false)
  })

  it('cannot resurrect a pending intent from a read started before resume', async () => {
    let reads = 0
    let finishOldRead
    let trade = pendingImport()
    const oldRead = new Promise(resolve => { finishOldRead = resolve })
    const view = createView(url => {
      if (url.includes('/resume')) {
        trade = completedImport()
        return { success: true, trade }
      }
      reads += 1
      return reads === 2 ? oldRead : { success: true, trades: [trade] }
    })
    const tree = await view.mount()
    const reading = button(tree, 'Refresh').props.onClick()
    await view.settle()
    await button(tree, 'Resume import').props.onClick()
    finishOldRead({ success: true, trades: [pendingImport()] })
    await reading
    assert.doesNotMatch(text(view.render()), /Import unfinished/)
    assert.match(text(view.render()), /TP Pending/)
  })

  it('makes an unavailable cold-load status visible with a refresh exit', async () => {
    const view = createView(() => ({ success: false, error: 'Engine disconnected' }))
    const tree = await view.mount()
    assert.match(text(tree), /Engine disconnected/)
    button(tree, 'Refresh')
  })
})
