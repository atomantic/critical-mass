import React from 'react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import ConfigEditor from '../src/components/ConfigEditor'
import { BrowserRouter } from '../src/lib/router'

// Keep App, router, fund selector and ConfigEditor real. Socket traffic is the
// only mocked UI boundary: all HTTP below is synthetic and never leaves jsdom.
vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRealtimeConnection: () => true,
  useRegimeEvents: () => ({ connected: true }),
}))

// The shell's status updates arrive as `regime:state` socket events; tests
// drive them through this fake client.
const socket = vi.hoisted(() => {
  const handlers = new Map()
  return {
    handlers,
    subscribe: () => {},
    unsubscribe: () => {},
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    off: (event, handler) => { handlers.set(event, (handlers.get(event) || []).filter(h => h !== handler)) },
    fire: (event, payload) => (handlers.get(event) || []).forEach(h => h(payload)),
    count: (event) => (handlers.get(event) || []).length,
  }
})
vi.mock('../src/lib/realtime', () => ({ getRealtimeClient: () => socket }))

const response = (data, ok = true) => ({ ok, json: async () => data })
const config = (baseSizeUsdc, dryRun = false) => ({ productId: 'BTC-USDC', dryRun, regime: { enabled: true, baseSizeUsdc } })
const status = (isRunning, isDryRun = false, lifecycle = 'active') => ({ status: { isRunning, isDryRun, lifecycle: { lifecycle } } })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let read

// The first fund switch, running-status render and failed-load render in this
// file pay one-time costs (module init, first render) that the first tests
// absorb; under CPU load they exceed findBy*'s 1s budget. Run one throwaway
// pass through each path before any test so those costs land outside it.
beforeAll(async () => {
  window.history.replaceState({}, '', '/coinbase/BTC-USDC/config')
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method && options.method !== 'GET') return Promise.resolve(response({}))
    if (url === '/api/exchanges') return Promise.resolve(response({ exchanges: ['coinbase', 'gemini'].map(name => ({
      name, pair: 'BTC-USDC', productId: 'BTC-USDC', strategy: 'regime', regimeEnabled: true,
    })) }))
    if (url.includes('/gemini/')) return Promise.resolve(response({}, false))
    if (url.includes('/regime/status')) return Promise.resolve(response(status(true, true)))
    return Promise.resolve(response({ config: config(111, true) }))
  }))
  render(<BrowserRouter><App /></BrowserRouter>)
  await screen.findByDisplayValue('111')
  await screen.findByRole('button', { name: 'Stop', exact: true })
  await switchFund('gemini')
  // Also warm the failed-load render path (Retry actions) the failure tests hit.
  await screen.findByRole('button', { name: 'Retry configuration' })
  await screen.findByRole('button', { name: 'Retry engine status' })
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  window.history.replaceState({}, '', '/coinbase/BTC-USDC/config')
  read = vi.fn(url => {
    if (url.includes('/summary')) return response({ config: config(111, true) })
    if (url.includes('/regime/status')) return response(status(true, true))
    return response({})
  })
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method && options.method !== 'GET') return Promise.resolve(response({}))
    if (url === '/api/exchanges') return Promise.resolve(response({ exchanges: ['coinbase', 'gemini'].map(name => ({
      name, pair: 'BTC-USDC', productId: 'BTC-USDC', strategy: 'regime', regimeEnabled: true,
    })) }))
    return Promise.resolve(read(url, options))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

const mount = () => render(<BrowserRouter><App /></BrowserRouter>)
async function switchFund(exchange) {
  fireEvent.click(document.querySelector('.exchange-selector > button'))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${exchange} BTC-USDC`) }))
  await waitFor(() => expect(window.location.pathname).toBe(`/${exchange}/BTC-USDC/config`))
}
const saveButton = () => screen.getByRole('button', { name: 'Save Configuration' })
function expectUnknownStatus() {
  for (const label of ['Running', 'Stopped', 'DRY-RUN', 'DRAINING', 'CLOSED']) expect(screen.queryByText(label, { exact: true })).toBeNull()
  for (const label of ['Start', 'Stop', 'Close Fund', 'Reopen', 'Reset', 'Restart Engine']) expect(screen.queryByRole('button', { name: label, exact: true })).toBeNull()
}

it('never renders or writes A config while B loads, then saves only B values without comparing A engine mode', async () => {
  const summaryB = deferred(), statusB = deferred()
  mount()
  await screen.findByDisplayValue('111')
  expect(await screen.findByRole('button', { name: 'Stop', exact: true })).toBeTruthy()
  read.mockImplementation(url => {
    if (url.includes('/gemini/summary')) return summaryB.promise
    if (url.includes('/gemini/regime/status')) return statusB.promise
    return response({})
  })
  await switchFund('gemini')
  expect(screen.queryByDisplayValue('111')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('Loading configuration...')).toBeTruthy()
  expectUnknownStatus()
  fireEvent.click(saveButton())
  expect(fetch.mock.calls.some(([, options]) => options?.method && options.method !== 'GET')).toBe(false)

  await act(async () => summaryB.resolve(response({ config: config(222) })))
  const input = await screen.findByLabelText('Base Size (USDC)')
  expect(input.value).toBe('222')
  expect(saveButton().disabled).toBe(false)
  expectUnknownStatus()
  fireEvent.change(input, { target: { value: '333' } })
  fireEvent.click(saveButton())
  await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true))
  const [url, options] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')
  expect(url).toBe('/api/gemini/config?pair=BTC-USDC')
  // Save sends only the edit made on B's draft (#1395).
  expect(JSON.parse(options.body)).toEqual({ regime: { baseSizeUsdc: 333 } })
  await act(async () => statusB.resolve(response(status(false, false, 'closed'))))
  expect(await screen.findByRole('button', { name: 'Reopen', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Restart Engine' })).toBeNull()
})

it('keeps fund-view navigation reachable beside the populated running dry-run controls', async () => {
  read.mockImplementation(url => {
    if (url.includes('/summary')) return response({ config: config(111, true) })
    if (url.includes('/regime/status')) return response(status(true, true, 'active'))
    return response({})
  })
  mount()
  const tabs = await screen.findByRole('navigation', { name: 'Fund views' })
  for (const label of ['Dashboard', 'Cost Basis', 'Transactions', 'Charts', 'Config', 'API Keys', 'Logs']) {
    expect(screen.getByRole('link', { name: label })).toBeTruthy()
  }
  expect(screen.getByText('DRY-RUN')).toBeTruthy()
  expect(screen.getByText('Running')).toBeTruthy()
  expect(screen.getByText('Live')).toBeTruthy()
  for (const label of ['Reset', 'Close Fund', 'Stop']) {
    expect(screen.getByRole('button', { name: label, exact: true })).toBeTruthy()
  }
  expect(tabs.querySelectorAll('a')).toHaveLength(7)

  for (const [label, route] of [['Config', 'config'], ['Charts', 'charts'], ['Logs', 'logs']]) {
    fireEvent.click(screen.getByRole('link', { name: label }))
    await waitFor(() => expect(window.location.pathname).toBe(`/coinbase/BTC-USDC/${route}`))
    expect(screen.getByRole('navigation', { name: 'Fund views' })).toBeTruthy()
  }
})

for (const failure of ['http', 'network']) it(`shows B ${failure} failures with independent Retry actions and no prior configuration/status`, async () => {
  mount()
  await screen.findByDisplayValue('111')
  await screen.findByRole('button', { name: 'Stop', exact: true })
  read.mockImplementation(url => {
    if (url.includes('/gemini/')) return failure === 'http' ? response({}, false) : Promise.reject(new Error('offline'))
    return response({})
  })
  await switchFund('gemini')
  await screen.findByRole('button', { name: 'Retry configuration' })
  await screen.findByRole('button', { name: 'Retry engine status' })
  expect(screen.getByText(/Failed to load configuration/)).toBeTruthy()
  expect(screen.queryByDisplayValue('111')).toBeNull()
  expect(saveButton().disabled).toBe(true)
  expectUnknownStatus()

  const summaryB = deferred(), statusB = deferred()
  read.mockImplementation(url => url.includes('/summary') ? summaryB.promise : statusB.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Retry configuration' }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry engine status' }))
  expect(screen.getByText('Loading configuration...')).toBeTruthy()
  expect(saveButton().disabled).toBe(true)
  await act(async () => summaryB.resolve(response({ config: config(222) })))
  expect((await screen.findByLabelText('Base Size (USDC)')).value).toBe('222')
  expectUnknownStatus()
  await act(async () => statusB.resolve(response(status(false))))
  expect(await screen.findByRole('button', { name: 'Start', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry engine status' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry configuration' })).toBeNull()
})

it('rejects late A JSON responses after navigating A → B → A, even when fetch ignores abort', async () => {
  const oldSummary = deferred(), oldStatus = deferred()
  let summaryReads = 0, statusReads = 0
  read.mockImplementation(url => {
    if (url.includes('/coinbase/summary')) return ++summaryReads === 1
      ? { ok: true, json: () => oldSummary.promise } : response({ config: config(333) })
    if (url.includes('/coinbase/regime/status')) return ++statusReads === 1
      ? { ok: true, json: () => oldStatus.promise } : response(status(false))
    if (url.includes('/gemini/summary')) return response({ config: config(222) })
    if (url.includes('/gemini/regime/status')) return response(status(false))
    return response({})
  })
  mount()
  await screen.findByText('Loading configuration...')
  await switchFund('gemini')
  await screen.findByDisplayValue('222')
  await switchFund('coinbase')
  await screen.findByDisplayValue('333')
  expect(await screen.findByRole('button', { name: 'Start', exact: true })).toBeTruthy()
  await act(async () => {
    oldSummary.resolve({ config: config(111, true) })
    oldStatus.resolve(status(true, true, 'draining'))
  })
  expect(screen.queryByDisplayValue('111')).toBeNull()
  expect(screen.getByDisplayValue('333')).toBeTruthy()
  expect(screen.queryByText('DRY-RUN', { exact: true })).toBeNull()
  expect(screen.queryByText('DRAINING', { exact: true })).toBeNull()
  expect(screen.getByRole('button', { name: 'Start', exact: true })).toBeTruthy()
})

it('discards a dirty editor draft while configuration is unavailable and adopts the retried baseline', async () => {
  const props = { exchange: 'gemini', pair: 'BTC-USDC', strategy: 'regime' }
  const page = render(<ConfigEditor {...props} config={config(111)} />)
  fireEvent.change(screen.getByLabelText('Base Size (USDC)'), { target: { value: '999' } })
  page.rerender(<ConfigEditor {...props} config={undefined} loadError="offline" />)
  expect(saveButton().disabled).toBe(true)
  expect(screen.queryByDisplayValue('999')).toBeNull()
  page.rerender(<ConfigEditor {...props} config={config(222)} />)
  await screen.findByDisplayValue('222')
  expect(screen.queryByDisplayValue('999')).toBeNull()
})

for (const lifecycle of ['draining', 'closed']) it(`clears the previous fund's ${lifecycle} badge and lifecycle actions while B status is pending`, async () => {
  read.mockImplementation(url => url.includes('/summary')
    ? response({ config: config(111, true) })
    : response(status(lifecycle === 'draining', true, lifecycle)))
  mount()
  await screen.findByDisplayValue('111')
  await screen.findByText(lifecycle.toUpperCase(), { exact: true })
  const pending = deferred()
  read.mockImplementation(url => url.includes('/summary') ? response({ config: config(222) }) : pending.promise)
  await switchFund('gemini')
  await screen.findByDisplayValue('222')
  expectUnknownStatus()
})

it('invalidates known status on a failed reconnect read for the same fund and recovers through Retry', async () => {
  mount()
  await screen.findByDisplayValue('111')
  await screen.findByRole('button', { name: 'Stop', exact: true })
  read.mockImplementation(url => url.includes('/regime/status') ? response({}, false) : response({}))
  await act(async () => socket.fire('connect'))
  await screen.findByRole('button', { name: 'Retry engine status' })
  expectUnknownStatus()
  read.mockImplementation(() => response(status(false)))
  fireEvent.click(screen.getByRole('button', { name: 'Retry engine status' }))
  await screen.findByRole('button', { name: 'Start', exact: true })
})

it('follows pushed regime:state events for the current fund without polling status', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval')
  try {
    mount()
    await screen.findByDisplayValue('111')
    await screen.findByRole('button', { name: 'Stop', exact: true })
    const statusReads = () => read.mock.calls.filter(([url]) => url.includes('/regime/status')).length
    const before = statusReads()
    expect(intervals.mock.calls.some(([, delay]) => delay === 5000)).toBe(false)
    await act(async () => socket.fire('regime:state', { exchange: 'gemini', pair: 'BTC-USDC', isRunning: false, isDryRun: false, lifecycle: 'active' }))
    expect(screen.getByRole('button', { name: 'Stop', exact: true })).toBeTruthy()
    await act(async () => socket.fire('regime:state', { exchange: 'coinbase', pair: 'BTC-USDC', isRunning: false, isDryRun: false, lifecycle: 'draining' }))
    await screen.findByRole('button', { name: 'Start', exact: true })
    await screen.findByText('DRAINING', { exact: true })
    expect(statusReads()).toBe(before)
  } finally {
    intervals.mockRestore()
  }
})

it('hides fund controls while the engine is unreachable and restores them on recovery', async () => {
  mount()
  await screen.findByRole('button', { name: 'Stop', exact: true })
  await act(async () => socket.fire('regime:state', {
    exchange: 'coinbase', pair: 'BTC-USDC', isRunning: false, isDryRun: false,
    lifecycle: 'active', engineDown: true,
  }))
  await screen.findByText('Engine unreachable')
  expectUnknownStatus()
  read.mockImplementation(url => url.includes('/regime/status')
    ? response({ ...status(false), engineDown: true })
    : response({ config: config(111, true) }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry engine status' })) })
  await waitFor(() => expect(screen.getByText('Engine unreachable')).toBeTruthy())
  expectUnknownStatus()
  await act(async () => socket.fire('regime:state', {
    exchange: 'coinbase', pair: 'BTC-USDC', isRunning: false, isDryRun: false, lifecycle: 'active',
  }))
  await screen.findByRole('button', { name: 'Start', exact: true })
  expect(screen.queryByText('Engine unreachable')).toBeNull()
})

it('treats an offline status payload as unreachable on the initial read', async () => {
  read.mockImplementation(url => url.includes('/regime/status')
    ? response({ status: { isRunning: false, engineDown: true } })
    : response({ config: config(111, true) }))
  mount()
  await screen.findByText('Engine unreachable')
  expectUnknownStatus()
})

it('reconciles status when the tab becomes visible and detaches its listeners on unmount', async () => {
  const page = mount()
  await screen.findByDisplayValue('111')
  await screen.findByRole('button', { name: 'Stop', exact: true })
  // The header state hook and the summary refresh each listen.
  expect(socket.count('regime:state')).toBe(2)
  read.mockImplementation(url => url.includes('/regime/status') ? response(status(false)) : response({ config: config(111, true) }))
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await screen.findByRole('button', { name: 'Start', exact: true })
  page.unmount()
  expect(socket.count('regime:state')).toBe(0)
  expect(socket.count('connect')).toBe(0)
})
