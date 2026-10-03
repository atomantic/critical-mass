const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const adminRequire = createRequire(path.join(__dirname, '../admin/package.json'))
const React = adminRequire('react')
const { renderToStaticMarkup } = adminRequire('react-dom/server')
const components = {}
let active

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  for (const name of ['OpenOrdersTable', 'FilledOrdersSection']) {
    const bundle = await rolldown({ input: path.join(__dirname, `../admin/src/components/regime/${name}.jsx`), external: ['react'], transform: { jsx: 'react' } })
    const code = (await bundle.generate({ format: 'cjs' })).output[0].code
    await bundle.close()
    const hooks = {
      ...React,
      useId: () => 'test-disclosure',
      useMemo: f => f(),
      useEffect: () => {},
      useRef: initial => ({ current: initial }),
      useState: initial => {
        const i = active.index++
        if (!(i in active.state)) active.state[i] = initial
        return [active.state[i], update => { active.state[i] = typeof update === 'function' ? update(active.state[i]) : update }]
      },
    }
    const m = { exports: {} }
    vm.runInNewContext(code, { module: m, exports: m.exports, require: name => name === 'react' ? hooks : adminRequire(name), console })
    components[name] = m.exports.default || m.exports
  }
})
function harness(name, props) {
  const context = { index: 0, state: [] }
  return () => { active = context; active.index = 0; return components[name](props) }
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
const buttons = tree => nodes(tree, n => n.type === 'button' && n.props['aria-controls'])
function assertDisclosure(tree, button) {
  assert.equal(button.props.type, 'button') // Browser provides Tab, Enter and Space activation.
  assert.ok(button.props['aria-label'])
  assert.match(button.props.className, /focus-visible:outline/)
  const region = nodes(tree, n => n.props?.id === button.props['aria-controls'])
  assert.equal(region.length, 1)
  assert.equal(region[0].props.hidden, !button.props['aria-expanded'])
}
const buy = { orderId: 'buy-one', side: 'buy', size: 1, price: 100, timestamp: 1000, cycleId: 'cycle-1', sellOrderId: 'sell-one' }
const sell = { orderId: 'sell-one', side: 'sell', size: .9, price: 120, timestamp: 2000, cycleId: 'cycle-1', bodyPnl: 18 }
const baseFilled = { liveFills: [buy, sell, { ...buy, orderId: 'orphan', sellOrderId: undefined, cycleId: 'cycle-2' }], isDryRun: false, dryRunFilled: [], pendingOrdersList: [], market: { lastPrice: 120 }, asset: 'BTC' }

test('live cycles, sell buys and orphan groups expose independent persistent disclosures', () => {
  const render = harness('FilledOrdersSection', baseFilled)
  let tree = render()
  const cycle = buttons(tree).find(b => b.props['aria-label'] === 'Details for cycle #1')
  const orphan = buttons(tree).find(b => b.props['aria-label'] === 'Orphaned buy details')
  assert.ok(cycle); assert.ok(orphan)
  buttons(tree).forEach(b => assertDisclosure(tree, b))
  cycle.props.onClick()
  tree = render()
  const fill = buttons(tree).find(b => b.props['aria-label'].startsWith('Buy details for filled sell'))
  assert.ok(fill)
  fill.props.onClick()
  tree = render()
  assert.match(renderToStaticMarkup(tree), /BUY/)
  buttons(tree).forEach(b => assertDisclosure(tree, b))
  const sameFill = buttons(tree).find(b => b.props['aria-controls'] === fill.props['aria-controls'])
  sameFill.props.onClick()
  tree = render()
  assert.equal(buttons(tree).find(b => b.props['aria-controls'] === fill.props['aria-controls']).props['aria-expanded'], false)
  orphan.props.onClick()
  tree = render()
  assert.match(renderToStaticMarkup(tree), /orphan/)
  buttons(tree).forEach(b => assertDisclosure(tree, b))
  assert.doesNotMatch(renderToStaticMarkup(tree), /<tbody[^>]*>\s*<tbody/)
})

test('cycle toggle keeps focus on its initiating control and search stays mounted', () => {
  const render = harness('FilledOrdersSection', baseFilled)
  let tree = render(); let focused = false
  nodes(tree, n => n.type === 'button' && n.props.children === 'All Cycles')[0].props.onClick({ currentTarget: { focus: () => { focused = true } } })
  tree = render()
  assert.equal(focused, true)
  assert.ok(nodes(tree, n => n.type === 'button' && n.props.children === 'Current Cycle').length)
  const input = nodes(tree, n => n.type === 'input')[0]
  input.props.onChange({ target: { value: 'nonexistent' } })
  tree = render()
  assert.equal(nodes(tree, n => n.type === 'input')[0].props.value, 'nonexistent')
  assert.match(renderToStaticMarkup(tree), /No matching orders/)
})

test('dry-run filled sells expose buy details and empty views have no disclosures', () => {
  const render = harness('FilledOrdersSection', { ...baseFilled, isDryRun: true, dryRunFilled: [{ ...buy, filledAt: 1000, cycleId: 'cycle-1' }, { ...sell, filledAt: 2000, cycleId: 'cycle-1' }] })
  let tree = render(); const disclosure = buttons(tree)[0]
  assert.ok(disclosure); assertDisclosure(tree, disclosure)
  disclosure.props.onClick(); tree = render()
  assertDisclosure(tree, buttons(tree)[0]); assert.match(renderToStaticMarkup(tree), /BUY/)
  assert.equal(buttons(harness('FilledOrdersSection', { ...baseFilled, liveFills: [] })()).length, 0)
})

test('open-order buy disclosure preserves table sections and does not invoke trade actions', () => {
  let actions = 0
  const render = harness('OpenOrdersTable', { pendingOrdersList: [{ orderId: 'sell-one', status: 'open', type: 'body_tp', price: 120, size: .9 }], liveFills: [buy], dryRunFilled: [], isDryRun: false, celestialBodies: [{ id: 'body-one', tpOrderId: 'sell-one', buyOrderIds: ['buy-one'], avgPrice: 100 }], position: {}, config: {}, market: { lastPrice: 120 }, asset: 'BTC', isRunning: true, openSearchId: '', setTpEditModal: () => actions++, setRollUpConfirm: () => actions++ })
  let tree = render(); const disclosure = buttons(tree)[0]
  assert.ok(disclosure); assertDisclosure(tree, disclosure)
  disclosure.props.onClick(); tree = render()
  assertDisclosure(tree, buttons(tree)[0]); assert.match(renderToStaticMarkup(tree), /BUY/)
  assert.equal(actions, 0)
  assert.doesNotMatch(renderToStaticMarkup(tree), /<tbody[^>]*>\s*<tbody/)
  nodes(tree, n => n.type === 'button' && n.props.title === 'Edit TP target')[0].props.onClick({ stopPropagation() {} })
  assert.equal(actions, 1)
  assert.equal(buttons(render())[0].props['aria-expanded'], true)
})
