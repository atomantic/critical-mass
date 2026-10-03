const { before, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
const testReact = Object.create(React)
let ExchangeSelector

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'ExchangeSelector.jsx'),
    external: () => true,
    transform: { jsx: 'react' },
  })
  let code
  try { code = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: id => id === 'react' ? testReact : adminRequire(id),
    React: testReact,
    document: {
      addEventListener: (...args) => global.document.addEventListener(...args),
      removeEventListener: (...args) => global.document.removeEventListener(...args),
    },
    console,
  })
  ExchangeSelector = module.exports.default || module.exports
})

it('restores focus on Escape and exposes the trigger-to-options relationship', () => {
  const listeners = new Map()
  global.document = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  }
  const trigger = { focusCalls: 0, focus() { this.focusCalls += 1 } }
  let menuClosed
  const reactWithOpenState = {
    useState: initial => {
      assert.equal(initial, false)
      return [true, value => { menuClosed = value }]
    },
    useRef: () => ({ current: trigger }),
    useEffect: effect => effect(),
  }

  // Invoke the actual component with an open menu and a minimal synthetic DOM
  // event target. React elements let this test inspect the rendered semantics.
  const originalUseState = testReact.useState
  const originalUseRef = testReact.useRef
  const originalUseEffect = testReact.useEffect
  Object.assign(testReact, reactWithOpenState)
  try {
    const tree = ExchangeSelector({
      currentExchange: 'coinbase',
      currentPair: 'BTC-USD',
      exchanges: [{ name: 'coinbase', pair: 'BTC-USD' }],
      onChange() {},
    })
    const triggerElement = tree.props.children[0]
    const options = tree.props.children[1]

    assert.equal(triggerElement.props['aria-expanded'], true)
    assert.equal(triggerElement.props['aria-controls'], 'exchange-selector-options')
    assert.equal(options.props.id, triggerElement.props['aria-controls'])

    let prevented = false
    listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(menuClosed, false)
    assert.equal(trigger.focusCalls, 1)

    menuClosed = null
    listeners.get('click')({ target: { closest: () => null } })
    assert.equal(menuClosed, false)
    assert.equal(trigger.focusCalls, 1, 'outside pointer dismissal must not steal focus')
  } finally {
    Object.assign(testReact, { useState: originalUseState, useRef: originalUseRef, useEffect: originalUseEffect })
    delete global.document
  }
})
