const { before, describe, it } = require('node:test')
const { apiClientStub } = require('./api-client-harness')
const { asHookModule } = require('./use-polling-harness')
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
  const requests = []
  let nextTimer = 0
  const fetchImpl = (url, options) => new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject, settled: false }) })
  // Stand-in for useRealtimeRefresh: each mounted consumer registers a callback that
  // `tick()` invokes, as if the gateway had pushed a change for this fund.
  const registrations = new Map()
  const useRealtimeRefresh = ({ onRefresh }) => {
    const latest = React.useRef(onRefresh)
    latest.current = onRefresh
    React.useEffect(() => {
      const id = ++nextTimer
      registrations.set(id, { callback: () => latest.current() })
      return () => registrations.delete(id)
    }, [])
  }
  const stubs = {
    react: React,
    './ui/Button': ({ children, ...props }) => React.createElement('button', props, children),
    '../hooks/useRealtimeRefresh': asHookModule(useRealtimeRefresh),
    '../hooks/useTradeEvents': { useRegimeEvents: () => ({ status: null }) },
    '../utils/apiClient': apiClientStub(fetchImpl),
    './charts/chartUtils': { formatCurrency: value => `$${value}`, formatPrice: value => `$${value}`, formatAsset: String },
    '../App': {
      getBaseCurrency: productId => productId?.split('-')[0] || 'BTC',
      getQuoteCurrency: productId => productId?.split('-')[1] || 'USDC',
    },
    '../utils/api': { pairQuery: pair => pair ? `?pair=${encodeURIComponent(pair)}` : '' },
    '../utils/plural.mjs': { plural: (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}` },
    '../utils/pnlFormat.mjs': { pnlColorClass: n => (n >= 0 ? 'text-green-400' : 'text-red-400'), signedPrefix: n => (n >= 0 ? '+' : '') },
    '../utils/regimeFillGroups.mjs': { compareCycleIds: (a, b) => a.localeCompare(b) },
  }
  const mod = { exports: {} }
  vm.runInNewContext(componentCode, {
    module: mod, exports: mod.exports, React, AbortController,
    require: name => { assert.ok(stubs[name], `unexpected import ${name}`); return stubs[name] },
    fetch: fetchImpl,
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
  async function respond({ fills = [], aggregate, price = 100, failure, productId = currentProps.pair } = {}) {
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
            : endpoint === 'fills' ? aggregate || { fillCount: fills.length, cycles: fills.length ? [{
              cycleId: 'cycle-1', entryCount: fills.length, exitCount: 0,
              totalBought: fills.length * 0.001, totalSold: 0,
              totalCost: fills.length * 0.1, totalProceeds: 0,
            }] : [], detailFills: [] } : { config: { productId } }
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
  function tick() { for (const registration of [...registrations.values()]) registration.callback() }
  function unmount() { flushSync(() => root.unmount()) }
  function cleanup() {
    unmount()
    global.window = previousWindow
    global.document = previousDocument
    if (previousNavigator) Object.defineProperty(global, 'navigator', previousNavigator)
    else delete global.navigator
  }
  render()
  return { requests, timers: registrations, render, drain, respond, click, unmount, cleanup, text: () => container.textContent, tick }
}

describe('Cost Basis rendered refresh and recovery (#853, #933, #1880)', () => {
  for (const count of [0, 30000]) {
    it(`re-reads successful ${count}-fill responses once per pushed change`, async () => {
      const view = createView()
      try {
        const fills = Array.from({ length: count }, (_, i) => ({ side: 'buy', size: 0.001, price: 100, cycleId: 'cycle-1', timestamp: i }))
        assert.equal(view.requests.length, 3)
        await view.respond({ fills })
        assert.equal(view.requests.length, 3, 'successful initial response must not trigger another batch')
        assert.equal(view.timers.size, 1)
        for (let tick = 1; tick <= 3; tick++) {
          view.tick()
          assert.equal(view.requests.length, 3 + tick * 2, 'config is loaded only once per fund')
          await view.respond({ fills, price: 100 + tick })
          assert.equal(view.requests.length, 3 + tick * 2)
          assert.equal(view.timers.size, 1)
          assert.match(view.text(), new RegExp(`\\$${100 + tick}`))
        }
      } finally { view.cleanup() }
    })
  }

  it('conditionally re-reads 30,000 fills on pushed changes, refreshes prices, and recovers changed/restarted ledgers', async (t) => {
    const { createTransactionsReadView } = require('../src/transactions-regime-query')
    let fills = Array.from({ length: 30000 }, (_, i) => ({
      tradeId: `trade-${i}`, orderId: `order-${i}`, side: i % 2 ? 'sell' : 'buy',
      cycleId: `cycle-${Math.floor(i / 2)}`, timestamp: 1000 + i,
      size: 0.01, price: 100, quoteAmount: 1, netFee: 0.01,
      ...(i % 2 ? { bodyPnl: 0.1, bodyHoldbackAsset: 0.001 } : { sellOrderId: `order-${i + 1}` }),
    }))
    let revision = '11111111-1111-4111-8111-111111111111:0'
    const ledger = createTransactionsReadView(() => fills, () => revision)
    const view = createView()
    const pendingFill = () => view.requests.find(request => !request.settled && request.url.includes('/regime/fills'))
    const aggregateRead = () => ledger.aggregates({ revision: new URL(pendingFill().url, 'http://fixture').searchParams.get('revision') || undefined })
    try {
      assert.equal(new URL(pendingFill().url, 'http://fixture').searchParams.has('revision'), false)
      const full = aggregateRead()
      await view.respond({ aggregate: full })
      const initialText = view.text()
      for (let tick = 1; tick <= 2; tick++) {
        view.tick()
        assert.equal(new URL(pendingFill().url, 'http://fixture').searchParams.get('revision'), revision)
        const unchanged = aggregateRead()
        assert.deepEqual(unchanged, { unchanged: true, revision })
        assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < 100)
        await view.respond({ aggregate: unchanged, price: 100 + tick })
        assert.match(view.text(), new RegExp(`\\$${100 + tick}`))
        assert.match(view.text(), /latest 250 of 15000 cycles/)
      }
      t.diagnostic(`30,000-fill decoded HTTP aggregate bytes: full=${Buffer.byteLength(JSON.stringify({ success: true, exchange: 'coinbase', pair: 'BTC-USD', running: true, ...full }))}, unchanged=${Buffer.byteLength(JSON.stringify({ success: true, exchange: 'coinbase', pair: 'BTC-USD', running: true, ...ledger.aggregates({ revision }) }))}`)
      // A new aggregate received in a failed batch must not replace the last
      // complete snapshot or its revision; the explicit retry asks again.
      fills = [...fills, { tradeId: 'added', orderId: 'added', side: 'buy', cycleId: 'cycle-15000', timestamp: 40000, size: 1, price: 100, quoteAmount: 100 }]
      revision = '11111111-1111-4111-8111-111111111111:1'
      view.tick()
      await view.respond({ aggregate: aggregateRead(), failure: { endpoint: 'status', kind: 'transport' } })
      assert.match(view.text(), /Data is stale/)
      assert.match(view.text(), /latest 250 of 15000 cycles/)
      view.click('Refresh Now')
      assert.equal(new URL(pendingFill().url, 'http://fixture').searchParams.get('revision'), '11111111-1111-4111-8111-111111111111:0')
      await view.respond({ aggregate: aggregateRead(), price: 200 })
      assert.match(view.text(), /latest 250 of 15001 cycles/)
      assert.doesNotMatch(view.text(), /Data is stale/)
      revision = '22222222-2222-4222-8222-222222222222:0'
      view.tick()
      const restarted = aggregateRead()
      assert.equal(restarted.unchanged, undefined)
      await view.respond({ aggregate: restarted, price: 201 })
      view.render({ pair: 'ETH-USD' })
      await view.drain()
      assert.equal(new URL(pendingFill().url, 'http://fixture').searchParams.has('revision'), false)
      assert.notEqual(view.text(), initialText)
    } finally { view.cleanup() }
  })

  it('rejects an unchanged response without an owned snapshot and retries a full read', async () => {
    const view = createView()
    try {
      await view.respond({ aggregate: { unchanged: true, revision: 'unknown' } })
      assert.match(view.text(), /Error: Fill cycles returned an invalid unchanged revision/)
      view.click('Retry')
      assert.ok(view.requests.filter(request => !request.settled).every(request => !request.url.includes('revision=')))
      await view.respond()
      assert.match(view.text(), /BTC Position/)
    } finally { view.cleanup() }
  })

  it('queues one more read for changes during a batch or failed batch remainder, without releasing its reads', async () => {
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
      assert.equal(view.requests.length, 6, 'the changes that arrived mid-batch trigger exactly one more batch')
      await view.respond()
      assert.doesNotMatch(view.text(), /Error:|Data is stale/)
      assert.equal(view.requests.length, 6)
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
