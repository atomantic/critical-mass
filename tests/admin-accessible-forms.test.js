const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const compiled = new Map()
let harnessId = 0

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  for (const component of ['ai/Providers.jsx', 'updown/TradeHistory.jsx']) {
    const bundle = await rolldown({
      input: path.join(__dirname, '..', 'admin', 'src', 'components', component),
      external: () => true,
      transform: { jsx: 'react' },
    })
    try {
      compiled.set(component, (await bundle.generate({ format: 'cjs' })).output[0].code)
    } finally {
      await bundle.close()
    }
  }
})

// Execute real component render/handlers with isolated hook state and mocked IO.
// Nested modal components have their own hook owner, just as they do in React.
function createView(component, extraStubs = {}) {
  const instances = new Map()
  const prefix = `view-${harnessId++}`
  const writes = []
  const executed = []
  const effects = []
  let active
  let index
  const slot = initial => {
    const owner = active
    const key = index++
    if (!(key in owner.values)) owner.values[key] = typeof initial === 'function' ? initial() : initial
    return [owner, key]
  }
  const hooks = {
    ...React,
    useState(initial) {
      const [owner, key] = slot(initial)
      return [owner.values[key], value => {
        owner.values[key] = typeof value === 'function' ? value(owner.values[key]) : value
      }]
    },
    useRef(initial) { const [owner, key] = slot(() => ({ current: initial })); return owner.values[key] },
    useId() { const [owner, key] = slot(() => `${prefix}-${active.name}-${index}`); return owner.values[key] },
    useCallback: fn => fn,
    useEffect(effect) { if (!active.mounted) effects.push(effect) },
  }
  const fetch = async (url, options = {}) => {
    if (options.method) writes.push({ url, method: options.method, body: options.body && JSON.parse(options.body) })
    return { ok: true, json: async () => url === '/api/providers'
      ? { providers: [{ id: 'one', name: 'Test Provider', enabled: true, type: 'cli' }], activeProvider: 'one' }
      : { success: true, runs: [], trades: [], summary: null } }
  }
  const stubs = {
    react: hooks,
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '../Toast': { useToast: () => ({ addToast() {} }) },
    '../../utils/runLifecycle.mjs': { createRunLifecycle: () => ({ execute: value => executed.push(value), dispose() {} }) },
    '../../utils/dashboardAction.mjs': { runDashboardAction: async action => { await action.request(); await action.onSuccess() } },
    ...extraStubs,
  }
  const exports = {}
  const context = vm.createContext({ React, exports, module: { exports }, fetch, require: name => {
    assert.ok(name in stubs, `unexpected import ${name}`)
    return stubs[name]
  } })
  vm.runInContext(compiled.get(component), context, { filename: component })
  const renderComponent = (Component, props = {}, name = 'root') => {
    if (!instances.has(name)) instances.set(name, { name, values: [], mounted: false })
    active = instances.get(name)
    index = 0
    const result = Component(props)
    active.mounted = true
    return result
  }
  const render = () => renderComponent(context.module.exports)
  return { render, writes, executed,
    renderChild: element => renderComponent(element.type, element.props, 'modal'),
    async mount() {
      render()
      for (const effect of effects.splice(0)) effect()
      await new Promise(resolve => setImmediate(resolve))
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
  return React.isValidElement(tree) ? text(tree.props.children) : typeof tree === 'string' ? tree : ''
}
function find(tree, predicate) {
  const node = elements(tree).find(predicate)
  assert.ok(node, 'expected form control to exist')
  return node
}
function labeled(tree, name) {
  const label = find(tree, node => node.type === 'label' && text(node).trim() === name)
  assert.ok(label.props.htmlFor, `${name} needs a label target`)
  return find(tree, node => ['input', 'select', 'textarea'].includes(node.type) && node.props.id === label.props.htmlFor)
}

describe('admin accessible operational forms', () => {
  it('opens the prompt runner and executes the entered prompt with the selected provider', async () => {
    const view = createView('ai/Providers.jsx')
    let tree = await view.mount()
    find(tree, node => node.type === 'button' && text(node) === 'Run Prompt').props.onClick()
    tree = view.render()
    const provider = find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Select Provider')
    const prompt = find(tree, node => node.type === 'textarea' && node.props['aria-label'] === 'Prompt')
    assert.ok(provider.props.id)
    assert.ok(prompt.props.id)
    assert.notEqual(provider.props.id, prompt.props.id)
    prompt.props.onChange({ target: { value: 'Summarize this test fixture' } })
    tree = view.render()
    const execute = find(tree, node => node.type === 'button' && text(node) === 'Execute')
    assert.equal(execute.props.disabled, false)
    execute.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(view.executed)), [{ providerId: 'one', prompt: 'Summarize this test fixture' }])
  })

  it('associates Available Models with the textarea and saves an unblurred model edit', async () => {
    const view = createView('ai/Providers.jsx')
    let tree = await view.mount()
    find(tree, node => node.type === 'button' && text(node) === 'Add Provider').props.onClick()
    const modal = find(view.render(), node => typeof node.type === 'function')
    tree = view.renderChild(modal)
    labeled(tree, 'Available Models').props.onChange({ target: { value: 'fast, capable' } })
    tree = view.renderChild(modal)
    await find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    assert.deepEqual(view.writes[0].body.models, ['fast', 'capable'])
  })

  it('connects trade labels to unique controls and submits entered amount expressions', async () => {
    const { parseTradeAmountExpression } = await import(pathToFileURL(path.join(__dirname, '..', 'admin/src/components/updown/tradeAmountExpression.js')).href)
    const stubs = { './tradeAmountExpression': { parseTradeAmountExpression } }
    const view = createView('updown/TradeHistory.jsx', stubs)
    let tree = await view.mount()
    find(tree, node => node.type === 'button' && text(node).trim() === 'Add Trade').props.onClick()
    tree = view.render()
    const names = ['Date', 'Cost (Open)', 'Return (Close)', 'Note (optional)']
    const ids = names.map(name => labeled(tree, name).props.id)
    assert.equal(new Set(ids).size, names.length)
    for (const [name, value] of [['Date', '2026-09-20'], ['Cost (Open)', '200+300'], ['Return (Close)', '700'], ['Note (optional)', 'Regression fixture']]) {
      labeled(tree, name).props.onChange({ target: { value } })
      tree = view.render()
    }
    assert.deepEqual(names.map(name => labeled(tree, name).props.id), ids)
    await find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    assert.deepEqual(view.writes[0].body, { date: '2026-09-20', cost: 500, returnAmount: 700, note: 'Regression fixture' })
    const other = createView('updown/TradeHistory.jsx', stubs)
    let otherTree = await other.mount()
    find(otherTree, node => node.type === 'button' && text(node).trim() === 'Add Trade').props.onClick()
    otherTree = other.render()
    assert.ok(names.every(name => !ids.includes(labeled(otherTree, name).props.id)), 'separate form instances must not share label targets')
  })
})
