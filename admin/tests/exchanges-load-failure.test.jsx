import React from 'react'
import { afterEach, beforeEach, expect, it as baseIt, vi } from 'vitest'
const it = (name, fn) => baseIt(name, fn, 30000)
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { BrowserRouter } from '../src/lib/router'

vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRegimeEvents: () => ({ connected: false }),
}))

HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('[autofocus]')?.focus() }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

const response = (data, ok = true, status = ok ? 200 : 502) => ({ ok, status, json: async () => data })
const fund = (name) => ({ name, pair: 'BTC-USDC', productId: 'BTC-USDC', strategy: 'regime', regimeEnabled: true })
let exchangesHandler, created

beforeEach(() => {
  window.history.replaceState({}, '', '/coinbase/BTC-USDC/config')
  created = false
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url === '/api/exchanges') return Promise.resolve(exchangesHandler())
    if (options?.method === 'POST' && url === '/api/coinbase/funds') { created = true; return Promise.resolve(response({ success: true })) }
    if (url.includes('/regime/status')) return Promise.resolve(response({ status: { isRunning: false, isDryRun: false, lifecycle: { lifecycle: 'active' } } }))
    return Promise.resolve(response({ config: { productId: 'BTC-USDC', regime: { enabled: true } } }))
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mount = () => render(<BrowserRouter><App /></BrowserRouter>)

it('shows Could not load funds with Retry, no Start/Stop or tabs, and recovers on Retry', async () => {
  let down = true
  exchangesHandler = () => down ? response({}, false, 502) : response({ exchanges: [fund('coinbase')] })
  mount()
  const alert = await screen.findByText(/Could not load funds/)
  expect(alert.textContent).toContain('502')
  for (const name of ['Start', 'Stop', 'Reopen']) expect(screen.queryByRole('button', { name, exact: true })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Config' })).toBeNull()
  expect(document.querySelector('.exchange-selector')).toBeNull()

  down = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(document.querySelector('.exchange-selector')).toBeTruthy())
  expect(screen.queryByText(/Could not load funds/)).toBeNull()
  expect(await screen.findByRole('button', { name: 'Start', exact: true })).toBeTruthy()
})

it('treats a network rejection as a load failure instead of an unhandled rejection', async () => {
  exchangesHandler = () => { throw new Error('socket hang up') }
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    mount()
    expect((await screen.findByText(/Could not load funds/)).textContent).toContain('socket hang up')
  } finally {
    process.off('unhandledRejection', unhandled)
  }
  expect(unhandled).not.toHaveBeenCalled()
})

it('fund created but list refresh fails: success toast, refresh warning, modal closed', async () => {
  let refreshDown = false
  exchangesHandler = () => refreshDown ? response({}, false, 502) : response({ exchanges: [fund('coinbase')] })
  mount()
  await screen.findByRole('button', { name: 'Start', exact: true })
  fireEvent.click(document.querySelector('.exchange-selector > button'))
  fireEvent.click(screen.getByRole('button', { name: /Add Fund/ }))
  fireEvent.change(await screen.findByLabelText(/pair/i), { target: { value: 'ETH-USDC' } })
  fireEvent.change(screen.getByLabelText(/initial capital/i), { target: { value: '100' } })
  refreshDown = true
  fireEvent.click(screen.getByRole('button', { name: 'Create Fund' }))
  expect(await screen.findByText(/Fund created: coinbase\/ETH-USDC/)).toBeTruthy()
  expect(await screen.findByText('Fund list not refreshed')).toBeTruthy()
  expect(created).toBe(true)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Fund' })).toBeNull())
})
