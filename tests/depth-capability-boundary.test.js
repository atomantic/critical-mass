const { before, describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const adminRequire = createRequire(path.join(__dirname, '../admin/package.json'))
const React = adminRequire('react')
const compiled = new Map()
const response = data => ({ ok: true, json: async () => data })
const flush = () => new Promise(resolve => setImmediate(resolve))

before(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  for (const name of ['ConfigEditor', 'NotificationsConfig']) {
    const bundle = await rolldown({ input: path.join(__dirname, `../admin/src/components/${name}.jsx`),
      external: id => id === 'react' || id === '../App', transform: { jsx: 'react' } })
    try { compiled.set(name, (await bundle.generate({ format: 'cjs' })).output[0].code) }
    finally { await bundle.close() }
  }
})

function view(name, props = {}, notificationConfig = {}) {
  const state = [], effects = [], requests = []
  let index = 0, mounted = false
  const slot = initial => {
    const key = index++
    if (!(key in state)) state[key] = typeof initial === 'function' ? initial() : initial
    return key
  }
  const hooks = { ...React,
    useState(initial) { const key = slot(initial); return [state[key], value => { state[key] = typeof value === 'function' ? value(state[key]) : value }] },
    useRef(initial) { return state[slot(() => ({ current: initial }))] },
    useEffect(effect) { if (!mounted) effects.push(effect) },
    useCallback(fn) { return fn },
  }
  const exports = {}
  const context = vm.createContext({ exports, module: { exports }, React: hooks,
    setInterval: () => 1, clearInterval() {},
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) })
      return response(url === '/api/notifications/config' ? notificationConfig : {})
    },
    require: id => {
      if (id === 'react') return hooks
      if (id === '../App') return { getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }
      throw new Error(`Unexpected fixture import: ${id}`)
    },
  })
  vm.runInContext(compiled.get(name), context)
  const component = context.module.exports.default || context.module.exports
  const render = () => { index = 0; const tree = component(props); mounted = true; return tree }
  return { render, requests, async mount() { render(); effects.forEach(effect => effect()); await flush(); return render() } }
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : React.isValidElement(tree) ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : React.isValidElement(tree) ? text(tree.props.children) : typeof tree === 'string' ? tree : ''
const button = (tree, label) => {
  const found = nodes(tree).find(node => node.type === 'button' && text(node) === label)
  assert.ok(found, `expected button ${label}`)
  return found
}

for (const entryMode of ['reactive', 'ladder']) describe(`depth capability boundary: ${entryMode}`, () => {
  it('explains the unavailable guard and saves spread/flash edits without depth keys', async () => {
    const config = { productId: 'BTC-USDC', regime: { enabled: true, entryMode, minDepthUsdc: 4321, depthPauseMs: 12345,
      maxSpreadBps: 40, spreadPauseMs: 7000, flashMoveMult: 2, flashCooldownMs: 8000, cancelEntriesOnFlash: false } }
    const page = view('ConfigEditor', { config, strategy: 'regime', pair: 'BTC-USDC' })
    const tree = await page.mount()
    assert.match(text(tree), /Depth-based entry protection is unavailable in this build/)
    assert.ok(!nodes(tree).some(node => ['Min Depth (USDC)', 'Depth Pause (ms)'].includes(node.props.label)))
    if (entryMode === 'reactive') {
      const spread = nodes(tree).find(node => node.props.label === 'Max Spread (bps)')
      const flash = nodes(tree).find(node => node.props.label === 'Flash Move Mult')
      assert.ok(spread && flash, 'working safety controls remain editable')
      spread.props.onChange(35)
      flash.props.onChange(4)
    } else assert.match(text(tree), /Ladder mode bypasses tail event checks/)
    await button(page.render(), 'Save Configuration').props.onClick()
    const saved = page.requests.find(request => request.method === 'PUT').body.regime
    assert.ok(!('minDepthUsdc' in saved) && !('depthPauseMs' in saved))
    assert.equal(saved.maxSpreadBps, entryMode === 'reactive' ? 35 : 40)
    assert.equal(saved.flashMoveMult, entryMode === 'reactive' ? 4 : 2)
    assert.equal(saved.spreadPauseMs, 7000)
    assert.equal(saved.flashCooldownMs, 8000)
    assert.equal(saved.cancelEntriesOnFlash, false)
    assert.equal(config.regime.minDepthUsdc, 4321, 'legacy readback remains unmodified')
  })
})

it('hides the unreachable notification toggle and excludes it from ordinary saves', async () => {
  const config = { enabled: true, telegram: { botToken: 'masked', chatId: 'fixture' }, quietHours: { enabled: false },
    events: { depth_pause: false, spread_pause: true, flash_move: false } }
  const page = view('NotificationsConfig', {}, config)
  const tree = await page.mount()
  assert.doesNotMatch(text(tree), /Depth Pause/)
  assert.match(text(tree), /Spread Pause/)
  assert.match(text(tree), /Flash Moves/)
  await button(tree, 'Save').props.onClick()
  const events = page.requests.find(request => request.method === 'PUT').body.events
  assert.ok(!('depth_pause' in events))
  assert.equal(events.spread_pause, true)
  assert.equal(events.flash_move, false)
  assert.equal(config.events.depth_pause, false)
})

// Exercise real persistence with a disposable data path. The checkout base is
// read-only; no exchange connection or live configuration is changed.
const paths = require('../src/paths')
const configUtils = require('../src/config-utils')
const { prepareConfigUpdate, persistConfigUpdate } = require('../src/routes/config-update')
const originalDataDir = paths.DATA_DIR
let tempRoot

afterEach(() => {
  paths.DATA_DIR = originalDataDir
  configUtils._resetConfigCacheForTests()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = undefined
})

it('full UI saves retain stored depth values while explicit legacy API edits still work', async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-capability-'))
  paths.DATA_DIR = tempRoot
  configUtils._resetConfigCacheForTests()
  configUtils.updateFundConfig('coinbase', 'BTC-USDC', { productId: 'BTC-USDC',
    regime: { minDepthUsdc: 4321, depthPauseMs: 12345, maxSpreadBps: 40, flashMoveMult: 2 } })
  configUtils.updateFundConfig('coinbase', 'LTC-USDC', { productId: 'LTC-USDC', regime: { maxSpreadBps: 40 } })
  configUtils.updateFundConfig('coinbase', 'LTC-USDC', { regime: { maxSpreadBps: 35 } })
  const withoutDepth = configUtils.getFundConfig('coinbase', 'LTC-USDC').regime
  assert.ok(!('minDepthUsdc' in withoutDepth) && !('depthPauseMs' in withoutDepth), 'absent legacy keys are not invented')
  configUtils.updateNotificationConfig({ events: { depth_pause: false, spread_pause: true } })
  const prepared = prepareConfigUpdate({ exchange: 'coinbase', pair: 'BTC-USDC', fullConfig: true,
    updates: { productId: 'BTC-USDC' }, rawRegime: { maxSpreadBps: 35, flashMoveMult: 4 } })
  assert.equal(prepared.valid, true)
  assert.ok(!('minDepthUsdc' in prepared.engineUpdates))
  await persistConfigUpdate('coinbase', 'BTC-USDC', prepared, { request: async () => ({ success: true }) })
  configUtils._resetConfigCacheForTests()
  let saved = configUtils.getRegimeConfig('coinbase', 'BTC-USDC')
  assert.equal(saved.minDepthUsdc, 4321)
  assert.equal(saved.depthPauseMs, 12345)
  assert.equal(saved.maxSpreadBps, 35)
  assert.equal(saved.flashMoveMult, 4)
  configUtils.updateNotificationConfig({ events: { spread_pause: false } })
  assert.equal(configUtils.getNotificationConfig().events.depth_pause, false)
  const explicit = prepareConfigUpdate({ exchange: 'coinbase', pair: 'BTC-USDC', fullConfig: true,
    updates: {}, rawRegime: { minDepthUsdc: 9876, depthPauseMs: 0 } })
  assert.equal(explicit.valid, true)
  await persistConfigUpdate('coinbase', 'BTC-USDC', explicit, { request: async () => ({ success: true }) })
  saved = configUtils.getRegimeConfig('coinbase', 'BTC-USDC')
  assert.equal(saved.minDepthUsdc, 9876)
  assert.equal(saved.depthPauseMs, 0)
})
