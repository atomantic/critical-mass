const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const adminRequire = createRequire(path.join(__dirname, '..', 'admin', 'package.json'))
const React = adminRequire('react')
let componentCode

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  const bundle = await rolldown({
    input: path.join(__dirname, '..', 'admin', 'src', 'components', 'CostBasisRegime.jsx'),
    external: () => true,
    transform: { jsx: 'react' },
  })
  try { componentCode = (await bundle.generate({ format: 'cjs' })).output[0].code } finally { await bundle.close() }
})

// A small inert host surface for the real React DOM renderer. No browser APIs,
// sockets or trading services are started; React itself owns hooks and effects.
function createDocument() {
  class Element {
    constructor(name, type = 1) {
      this.nodeType = type
      this.nodeName = name.toUpperCase()
      this.tagName = this.nodeName
      this.ownerDocument = doc
      this.parentNode = null
      this.childNodes = []
      this.attributes = {}
      this.style = {}
      this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.childNodes.push(child)
      return child
    }
    insertBefore(child, next) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.childNodes.splice(this.childNodes.indexOf(next), 0, child)
      return child
    }
    removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child }
    setAttribute(name, value) { this.attributes[name] = String(value) }
    removeAttribute(name) { delete this.attributes[name] }
    addEventListener() {}
    removeEventListener() {}
    get firstChild() { return this.childNodes[0] || null }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join('') }
    set textContent(value) {
      this.childNodes.forEach(child => { child.parentNode = null })
      this.childNodes = []
      if (this.nodeType === 3) this.nodeValue = String(value)
      else if (value !== '') this.appendChild(doc.createTextNode(String(value)))
    }
  }
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {} }
  doc.createElement = name => new Element(name)
  doc.createTextNode = text => { const node = new Element('#text', 3); node.nodeValue = String(text); return node }
  doc.documentElement = doc.createElement('html')
  doc.body = doc.createElement('body')
  doc.activeElement = doc.body
  doc.defaultView = { document: doc, HTMLElement: Element, HTMLIFrameElement: class {} }
  return doc
}

function createView(props = {}) {
  const doc = createDocument()
  const previousWindow = global.window
  const previousDocument = global.document
  const previousNavigator = Object.getOwnPropertyDescriptor(global, 'navigator')
  global.window = doc.defaultView
  global.document = doc
  // Node 20 has no global navigator; newer Node versions expose a getter.
  Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent: 'node-test' } })
  const { createRoot } = adminRequire('react-dom/client')
  const { flushSync } = adminRequire('react-dom')
  const container = doc.createElement('div')
  const root = createRoot(container)
  const timers = new Map()
  const requests = []
  let nextTimer = 0
  let now = 0
  const stubs = {
    react: React,
    './charts/chartUtils': { formatCurrency: value => `$${value}`, formatPrice: value => `$${value}`, formatAsset: String },
    '../App': { getBaseCurrency: productId => productId?.split('-')[0] || 'BTC' },
    '../utils/api': { pairQuery: pair => pair ? `?pair=${encodeURIComponent(pair)}` : '' },
    '../utils/regimeFillGroups.mjs': { compareCycleIds: (a, b) => a.localeCompare(b) },
  }
  const mod = { exports: {} }
  vm.runInNewContext(componentCode, {
    module: mod, exports: mod.exports, React, AbortController,
    require: name => { assert.ok(stubs[name], `unexpected import ${name}`); return stubs[name] },
    fetch: (url, options) => new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject, settled: false }) }),
    setInterval: (callback, ms) => { assert.equal(ms, 10000); const id = ++nextTimer; timers.set(id, { callback, next: now + ms, ms }); return id },
    clearInterval: id => timers.delete(id),
  })
  let currentProps = { exchange: 'coinbase', pair: 'BTC-USD', ...props }
  function render(nextProps = {}) {
    currentProps = { ...currentProps, ...nextProps }
    flushSync(() => root.render(React.createElement(mod.exports.default || mod.exports, currentProps)))
  }
  async function drain() {
    // Flush transport, JSON parsing, and React's scheduled state commits.
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    flushSync(() => {})
  }
  async function respond({ fills = [], price = 100, failure, productId = currentProps.pair } = {}) {
    const pending = requests.filter(request => !request.settled)
    for (const request of pending) {
      request.settled = true
      const endpoint = request.url.includes('/regime/status') ? 'status' : request.url.includes('/regime/fills') ? 'fills' : 'config'
      if (failure?.endpoint === endpoint && failure.kind === 'transport') request.reject(new Error('Offline'))
      else request.resolve({
        ok: !(failure?.endpoint === endpoint && failure.kind === 'http'), status: 503,
        json: async () => {
          if (failure?.endpoint === endpoint && failure.kind === 'parse') throw new Error('Invalid JSON')
          // Newly parsed object identities reproduce the original feedback loop.
          return endpoint === 'status' ? { status: { market: { lastPrice: price }, position: {} } }
            : endpoint === 'fills' ? { fills: structuredClone(fills) } : { config: { productId } }
        },
      })
    }
    await drain()
  }
  function click(label) {
    const walk = node => [node, ...node.childNodes.flatMap(walk)]
    const button = walk(container).find(node => node.tagName === 'BUTTON' && node.textContent.trim() === label)
    assert.ok(button, `missing ${label} button`)
    const key = Object.keys(button).find(key => key.startsWith('__reactProps$'))
    flushSync(() => button[key].onClick())
  }
  function advance(ms) {
    const end = now + ms
    while (timers.size && Math.min(...Array.from(timers.values(), timer => timer.next)) <= end) {
      now = Math.min(...Array.from(timers.values(), timer => timer.next))
      for (const timer of timers.values()) {
        if (timer.next === now) { timer.next += timer.ms; timer.callback() }
      }
    }
    now = end
  }
  function unmount() { flushSync(() => root.unmount()) }
  function cleanup() {
    unmount()
    global.window = previousWindow
    global.document = previousDocument
    if (previousNavigator) Object.defineProperty(global, 'navigator', previousNavigator)
    else delete global.navigator
  }
  render()
  return { requests, timers, render, drain, respond, click, unmount, cleanup, text: () => container.textContent, advance, tick: () => advance(10000) }
}

describe('Cost Basis rendered polling and recovery (#853, #933)', () => {
  for (const count of [0, 30000]) {
    it(`keeps successful ${count}-fill responses on the ten-second cadence`, async () => {
      const view = createView()
      try {
        const fills = Array.from({ length: count }, (_, i) => ({ side: 'buy', size: 0.001, price: 100, cycleId: 'cycle-1', timestamp: i }))
        assert.equal(view.requests.length, 3)
        await view.respond({ fills })
        assert.equal(view.requests.length, 3, 'successful initial response must not trigger another batch')
        assert.equal(view.timers.size, 1)
        view.advance(1000)
        assert.equal(view.requests.length, 3, 'only the initial batch is sent in the first second')
        for (let tick = 1; tick <= 3; tick++) {
          view.advance(tick === 1 ? 9000 : 10000)
          assert.equal(view.requests.length, 3 + tick * 2, 'config is loaded only once per fund')
          await view.respond({ fills, price: 100 + tick })
          assert.equal(view.requests.length, 3 + tick * 2)
          assert.equal(view.timers.size, 1)
          assert.match(view.text(), new RegExp(`\\$${100 + tick}`))
        }
      } finally { view.cleanup() }
    })
  }

  it('skips automatic ticks while a batch or failed batch remainder is in flight', async () => {
    const view = createView()
    try {
      view.tick(); view.tick()
      assert.equal(view.requests.length, 3)
      view.requests[0].settled = true
      view.requests[0].reject(new Error('Offline'))
      await view.drain()
      view.tick()
      assert.equal(view.requests.length, 3, 'a failed endpoint must not release the other pending reads')
      await view.respond()
      assert.match(view.text(), /Error: Offline/)
      view.tick()
      assert.equal(view.requests.length, 6)
      await view.respond()
      assert.doesNotMatch(view.text(), /Error:|Data is stale/)
    } finally { view.cleanup() }
  })

  for (const kind of ['transport', 'http', 'parse']) {
    for (const endpoint of ['status', 'fills', 'config']) {
      it(`shows retry for initial ${endpoint} ${kind} failure and recovers`, async () => {
        const view = createView()
        try {
          await view.respond({ failure: { endpoint, kind } })
          assert.match(view.text(), /Error:/)
          assert.doesNotMatch(view.text(), /Position|Data is stale/)
          view.click('Retry')
          assert.equal(view.requests.length, 6)
          await view.respond()
          assert.match(view.text(), /BTC Position/)
          assert.doesNotMatch(view.text(), /Error:|Data is stale/)
        } finally { view.cleanup() }
      })
    }
  }

  it('retains a valid empty snapshot on stale refresh failure and explicitly recovers', async () => {
    const view = createView()
    try {
      await view.respond({ price: 123 })
      view.tick()
      await view.respond({ failure: { endpoint: 'fills', kind: 'parse' }, price: 999 })
      assert.match(view.text(), /Data is stale/)
      assert.match(view.text(), /\$123/)
      assert.doesNotMatch(view.text(), /\$999|Error:/)
      view.click('Refresh Now')
      view.click('Refresh Now')
      assert.equal(view.requests.length, 7, 'explicit requests also coalesce while in flight')
      await view.respond({ price: 456 })
      assert.match(view.text(), /\$456/)
      assert.doesNotMatch(view.text(), /Data is stale/)
    } finally { view.cleanup() }
  })

  it('invalidates old fund responses, resets prior snapshots and cleans up on unmount', async () => {
    const view = createView()
    try {
      await view.respond({ price: 111 })
      view.tick()
      const oldRequests = view.requests.filter(request => !request.settled)
      view.render({ pair: 'ETH-USD' })
      await view.drain()
      assert.equal(view.timers.size, 1)
      assert.match(view.text(), /Loading/)
      for (const request of oldRequests) {
        assert.equal(request.options.signal.aborted, true)
        request.settled = true
        request.resolve({ ok: true, json: async () => ({ status: { market: { lastPrice: 999 } }, fills: [] }) })
      }
      await view.drain()
      assert.match(view.text(), /Loading/)
      await view.respond({ price: 222 })
      assert.match(view.text(), /ETH Position/)
      assert.doesNotMatch(view.text(), /\$111|\$999/)
      view.tick()
      const pending = view.requests.filter(request => !request.settled)
      view.unmount()
      assert.equal(view.timers.size, 0)
      assert.ok(pending.every(request => request.options.signal.aborted))
      await view.respond({ price: 333 })
      assert.equal(view.text(), '')
    } finally { view.cleanup() }
  })
})
