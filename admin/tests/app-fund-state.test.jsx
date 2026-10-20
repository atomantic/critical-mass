import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import ConfigEditor from '../src/components/ConfigEditor'
import { BrowserRouter } from '../src/lib/router'

// Keep App, router, fund selector and ConfigEditor real. Socket traffic is the
// only mocked UI boundary: all HTTP below is synthetic and never leaves jsdom.
vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRegimeEvents: () => ({ connected: false }),
}))

const response = (data, ok = true) => ({ ok, json: async () => data })
const config = (baseSizeUsdc, dryRun = false) => ({ productId: 'BTC-USDC', dryRun, regime: { enabled: true, baseSizeUsdc } })
const status = (isRunning, isDryRun = false, lifecycle = 'active') => ({ status: { isRunning, isDryRun, lifecycle: { lifecycle } } })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let read

beforeEach(() => {
  window.history.replaceState({}, '', '/coinbase/BTC-USDC/config')
  read = vi.fn(url => {
    if (url.includes('/summary')) return response({ config: config(111, true) })
    if (url.includes('/regime/status')) return response(status(true, true))
    return response({})
  })
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (options?.method) return Promise.resolve(response({}))
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
  expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false)

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
  expect(JSON.parse(options.body)).toEqual(config(333))
  await act(async () => statusB.resolve(response(status(false, false, 'closed'))))
  expect(await screen.findByRole('button', { name: 'Reopen', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Restart Engine' })).toBeNull()
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

it('invalidates known status on a failed poll for the same fund and recovers through Retry', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval')
  try {
    mount()
    await screen.findByDisplayValue('111')
    await screen.findByRole('button', { name: 'Stop', exact: true })
    read.mockImplementation(url => url.includes('/regime/status') ? response({}, false) : response({}))
    const poll = intervals.mock.calls.find(([, delay]) => delay === 5000)[0]
    await act(async () => poll())
    await screen.findByRole('button', { name: 'Retry engine status' })
    expectUnknownStatus()
    read.mockImplementation(() => response(status(false)))
    fireEvent.click(screen.getByRole('button', { name: 'Retry engine status' }))
    await screen.findByRole('button', { name: 'Start', exact: true })
  } finally {
    intervals.mockRestore()
  }
})
