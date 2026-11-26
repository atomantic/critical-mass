// @vitest-environment node
import { beforeAll, describe, it } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { asHookModule } from './fixtures/hook-module-harness.js'
const adminRequire = createRequire(import.meta.url)
import React from 'react'
const compiled = new Map()
const response = data => ({ ok: true, json: async () => data })
const flush = () => new Promise(resolve => setImmediate(resolve))

beforeAll(async () => {
  const { rolldown } = await import(pathToFileURL(adminRequire.resolve('rolldown')).href)
  for (const name of ['ConfigEditor', 'NotificationsConfig']) {
    const bundle = await rolldown({ input: path.join(import.meta.dirname, `../src/components/${name}.jsx`),
      external: id => id === 'react' || id === '../utils/productId.mjs' || id === './useToast' || id === './ui/Button' || id === '../hooks/useRealtimeRefresh' || id === '../lib/routerContext', transform: { jsx: 'react' } })
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
      if (id === '../utils/productId.mjs') return { getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }
      if (id === './ui/Button') return 'button'
      if (id === '../hooks/useRealtimeRefresh') return asHookModule(() => {})
      if (id === '../lib/routerContext') return { useUnsavedChanges() {} }
      if (id === './useToast') return { useNotify: () => () => null, useToast: () => ({ addToast: () => null, removeToast() {} }) }
      throw new Error(`Unexpected fixture import: ${id}`)
    },
  })
  vm.runInContext(compiled.get(name), context)
  const component = context.module.exports.default || context.module.exports
  const render = () => { index = 0; const tree = component(props); mounted = true; return tree }
  return { render, requests, async mount() { render(); effects.forEach(effect => effect()); await flush(); return render() } }
}
// Cards contain no hooks; expand their component boundary while preserving the
// FormInput nodes whose public change callbacks this fixture exercises.
const children = tree => typeof tree.type === 'function' && /Card$/.test(tree.type.name) && tree.type.name !== 'SectionCard' ? tree.type(tree.props) : tree.props.children
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : React.isValidElement(tree) ? [tree, ...nodes(children(tree))] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : React.isValidElement(tree) ? text(children(tree)) : typeof tree === 'string' ? tree : ''
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
    } else {
      assert.match(text(tree), /Ladder mode bypasses tail event checks/)
      const save = button(page.render(), 'Save Configuration')
      assert.equal(save.props.disabled, true)
      await save.props.onClick()
      assert.equal(page.requests.some(request => request.method === 'PUT'), false)
      return
    }
    await button(page.render(), 'Save Configuration').props.onClick()
    // Only edited keys are sent (#1395); depth keys never are.
    const body = page.requests.find(request => request.method === 'PUT').body
    assert.deepEqual(body, { regime: { maxSpreadBps: 35, flashMoveMult: 4 } })
    assert.equal(config.regime.minDepthUsdc, 4321, 'legacy readback remains unmodified')
  })
})

describe('Config save sends only the operator edits (#1395)', () => {
  const field = (tree, prefix) => {
    const found = nodes(tree).find(node => typeof node.props.label === 'string' && node.props.label.startsWith(prefix))
    assert.ok(found, `expected field ${prefix}`)
    return found
  }
  const saveBody = async (edit) => {
    const config = { productId: 'BTC-USDC', dryRun: false, regime: { enabled: true, entryMode: 'reactive', baseSizeUsdc: 50, maxUsdcDeployed: 1000 } }
    const page = view('ConfigEditor', { config, strategy: 'regime', pair: 'BTC-USDC' })
    edit(await page.mount())
    await button(page.render(), 'Save Configuration').props.onClick()
    return page.requests.find(request => request.method === 'PUT').body
  }

  it('omits untouched engine-owned values such as maxUsdcDeployed', async () => {
    const body = await saveBody(tree => field(tree, 'Base Size').props.onChange(75))
    assert.deepEqual(body, { regime: { baseSizeUsdc: 75 } })
  })

  it('still sends maxUsdcDeployed when the operator edits it', async () => {
    const body = await saveBody(tree => field(tree, 'Max Deployed').props.onChange(1500))
    assert.deepEqual(body, { regime: { maxUsdcDeployed: 1500 } })
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
