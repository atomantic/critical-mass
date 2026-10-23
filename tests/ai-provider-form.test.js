const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { apiClientStub } = require('./api-client-harness')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
let compiled

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '../admin/src/components/ai/Providers.jsx'),
    external: () => true,
    transform: { jsx: 'react' },
  })
  try { compiled = (await bundle.generate({ format: 'cjs' })).output[0].code }
  finally { await bundle.close() }
})

function createView(providers = [], activeProvider = null, runs = [], samples = []) {
  const instances = new Map(), effects = [], requests = []
  let active, index = 0
  const hooks = {
    ...React,
    useState(initial) {
      const owner = active, key = index++
      if (!(key in owner.values)) owner.values[key] = typeof initial === 'function' ? initial() : initial
      return [owner.values[key], value => { owner.values[key] = typeof value === 'function' ? value(owner.values[key]) : value }]
    },
    useRef(initial) {
      const owner = active, key = index++
      if (!(key in owner.values)) owner.values[key] = { current: initial }
      return owner.values[key]
    },
    useId() { return `provider-test-${active.name}-${index++}` },
    useEffect(effect) { if (!active.mounted) effects.push(effect) },
  }
  const fetch = async (url, options = {}) => {
    if (options.method) requests.push({ url, ...options, body: options.body && JSON.parse(options.body) })
    if (url === '/api/providers') return { ok: true, status: 200, json: async () => ({ providers, activeProvider }) }
    if (url === '/api/runs?limit=20') return { ok: true, status: 200, json: async () => ({ runs }) }
    if (url === '/api/providers/samples') return { ok: true, status: 200, json: async () => ({ providers: samples }) }
    if (url.endsWith('/prompt')) return { ok: true, status: 200, text: async () => 'previous prompt' }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }
  const exports = {}
  const context = vm.createContext({ React, exports, module: { exports }, fetch,
    require: name => {
      if (name === 'react') return hooks
      if (name === '../ui/touchTarget') return { TOUCH_TARGET: 'min-h-11' }
      if (name === '../ModalDialog') return { default: ({ children }) => children }
      if (name === '../ui/Button') return 'button'
      if (name === '../Toast') return { useNotify: () => () => {} }
      if (name === '../DestructiveConfirmation') return { default: ({ children }) => children }
      if (name === '../../utils/apiClient') return apiClientStub(fetch)
      if (name === '../../utils/runLifecycle.mjs') return { createRunLifecycle: () => ({ execute() {}, dispose() {} }), RUN_NOTICE: {} }
      throw new Error(`Unexpected import ${name}`)
    },
  })
  vm.runInContext(compiled, context)
  const renderComponent = (Component, props = {}, name = 'root') => {
    if (!instances.has(name)) instances.set(name, { name, values: [], mounted: false })
    active = instances.get(name)
    index = 0
    const result = Component(props)
    active.mounted = true
    return result
  }
  const render = () => renderComponent(context.module.exports)
  return { render, requests,
    renderChild: element => renderComponent(element.type, element.props, 'provider-form'),
    async mount() {
      render()
      effects.splice(0).forEach(effect => effect())
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
  assert.ok(node, 'expected rendered provider control')
  return node
}
function labeled(tree, label) {
  const labelNode = find(tree, node => node.type === 'label' && text(node).trim() === label)
  return find(tree, node => node.props.id === labelNode.props.htmlFor)
}

describe('AI provider form supported types (#1032)', () => {
  it('creates API providers by default without exposing CLI fields or a CLI choice', async () => {
    const view = createView()
    let tree = await view.mount()
    find(tree, node => node.type === 'button' && text(node) === 'Add Provider').props.onClick()
    const modal = find(view.render(), node => typeof node.type === 'function')
    tree = view.renderChild(modal)
    assert.equal(text(find(tree, node => node.type === 'span' && text(node) === 'API')), 'API')
    assert.ok(!elements(tree).some(node => node.type === 'select' && elements(node).some(option => text(option) === 'CLI')))
    assert.ok(!text(tree).includes('Command *'))
    assert.ok(!text(tree).includes('Arguments (space-separated)'))
    labeled(tree, 'Name *').props.onChange({ target: { value: 'Supported provider' } })
    labeled(tree, 'Endpoint *').props.onChange({ target: { value: 'https://api.example.test/v1' } })
    tree = view.renderChild(modal)
    await find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    assert.equal(view.requests[0].body.type, 'api')
    assert.equal(view.requests[0].body.endpoint, 'https://api.example.test/v1')
    assert.equal(Object.hasOwn(view.requests[0].body, 'command'), false)
    assert.equal(Object.hasOwn(view.requests[0].body, 'args'), false)
  })

  it('marks legacy CLI providers unavailable and permits explicit API conversion or deletion', async () => {
    const view = createView([
      { id: 'legacy', name: 'Old CLI', type: 'cli', command: 'claude', args: ['--print'], enabled: true },
      { id: 'api', name: 'Working API', type: 'api', endpoint: 'https://api.example.test/v1', enabled: true },
    ], 'legacy', [{
      id: 'old-run', prompt: 'previous prompt', providerId: 'legacy', providerName: 'Old CLI',
      startTime: '2026-10-10T00:00:00.000Z', endTime: '2026-10-10T00:01:00.000Z', success: true,
    }])
    let tree = await view.mount()
    assert.match(text(tree), /CLI providers are unsupported/)
    const legacyCard = find(tree, node => node.type === 'div'
      && node.props.className?.includes('bg-gray-800 border rounded-xl p-4')
      && text(node).includes('Old CLI'))
    assert.ok(!elements(legacyCard).some(node => node.type === 'button'
      && ['Test', 'Enable', 'Disable', 'Set Default'].includes(text(node))))
    assert.ok(elements(tree).some(node => node.type === 'button' && text(node) === 'Delete'))
    find(tree, node => node.type === 'button' && text(node) === 'Run Prompt').props.onClick()
    tree = view.render()
    const providerSelect = find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Select Provider')
    assert.deepEqual(elements(providerSelect).filter(node => node.type === 'option').map(option => option.props.value), ['', 'api'])
    assert.equal(providerSelect.props.value, '', 'legacy CLI default does not select a runner provider')
    assert.equal(find(tree, node => node.type === 'button' && text(node) === 'Execute').props.disabled, true)
    await find(tree, node => node.type === 'button' && text(node) === 'Rerun').props.onClick()
    tree = view.render()
    assert.equal(find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Select Provider').props.value, '')
    assert.ok(elements(tree).some(node => node.type === 'button' && text(node) === 'Test'), 'API provider retains its Test action')
    await find(tree, node => node.type === 'button' && text(node) === 'Test').props.onClick()
    assert.ok(view.requests.some(request => request.url === '/api/providers/api/test'))

    find(tree, node => node.type === 'button' && text(node) === 'Edit').props.onClick()
    const modal = find(view.render(), node => typeof node.type === 'function')
    let formTree = view.renderChild(modal)
    assert.match(text(formTree), /Enter an API endpoint and save to convert it/)
    assert.ok(!text(formTree).includes('Command *'))
    labeled(formTree, 'Endpoint *').props.onChange({ target: { value: 'https://converted.example.test/v1' } })
    formTree = view.renderChild(modal)
    await find(formTree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    const conversion = view.requests.find(request => request.url === '/api/providers/legacy')
    assert.equal(conversion.method, 'PUT')
    assert.equal(conversion.body.type, 'api')
    assert.equal(conversion.body.endpoint, 'https://converted.example.test/v1')
    assert.equal(Object.hasOwn(conversion.body, 'command'), false)
    assert.equal(Object.hasOwn(conversion.body, 'args'), false)
  })

  it('filters unsupported CLI samples and only submits API sample providers', async () => {
    const view = createView([], null, [], [
      { id: 'legacy-sample', name: 'Legacy CLI sample', type: 'cli', command: 'claude' },
      { id: 'api-sample', name: 'Supported API sample', type: 'api', endpoint: 'https://api.example.test/v1' },
    ])
    let tree = await view.mount()
    await find(tree, node => node.type === 'button' && text(node).includes('Load Samples')).props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    tree = view.render()
    assert.ok(!text(tree).includes('Legacy CLI sample'))
    assert.ok(text(tree).includes('Supported API sample'))
    assert.ok(text(find(tree, node => node.type === 'button' && text(node).startsWith('Add All'))).includes('(1)'))
    await find(tree, node => node.type === 'button' && text(node).startsWith('Add All')).props.onClick()
    assert.equal(view.requests.filter(request => request.method === 'POST').length, 1)
    assert.equal(view.requests.find(request => request.method === 'POST').body.type, 'api')
  })
})
