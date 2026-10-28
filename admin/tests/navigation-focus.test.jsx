import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import ExchangeSelector from '../src/components/ExchangeSelector'
import ModalDialog from '../src/components/ModalDialog'
import { BrowserRouter } from '../src/lib/router'

vi.mock('../src/hooks/useTradeEvents', () => ({
  useTradeEvents: () => ({ latestEvent: null }),
  useRealtimeConnection: () => false,
  useRegimeEvents: () => ({ connected: false }),
}))
const lazyRoute = vi.hoisted(() => {
  let resolve
  const ready = new Promise(done => { resolve = done })
  return { ready, resolve }
})
vi.mock('../src/components/NotificationsConfig', async () => {
  await lazyRoute.ready
  return { default: () => <button>Destination settings</button> }
})
const exchanges = [{ name: 'coinbase', pair: 'BTC-USDC', productId: 'BTC-USDC', strategy: 'regime' }]
const response = data => ({ ok: true, json: async () => data })

beforeEach(() => {
  window.history.replaceState({}, '', '/coinbase/BTC-USDC/config')
  vi.stubGlobal('fetch', vi.fn(async url => response(url === '/api/exchanges'
    ? { exchanges }
    : url.includes('/summary') ? { config: { productId: 'BTC-USDC', regime: {} } }
      : url.includes('/regime/status') ? { status: { isRunning: false } } : {})))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close })

function openSelector() {
  const trigger = document.querySelector('.exchange-selector > button')
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

for (const action of ['coinbase BTC-USDC Off', 'Refresh Exchanges', 'Add Fund']) {
  it(`focuses the persistent selector before ${action}'s callback and popup removal`, () => {
    let trigger
    const callback = vi.fn(() => {
      expect(document.activeElement).toBe(trigger)
      expect(trigger.isConnected).toBe(true)
    })
    render(<ExchangeSelector currentExchange="coinbase" currentPair="BTC-USDC" exchanges={exchanges} onChange={callback} onRefresh={callback} onAddFund={callback} />)
    trigger = openSelector()
    const option = screen.getByRole('button', { name: new RegExp(action) })
    option.focus()
    fireEvent.click(option)
    expect(callback).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)
    expect(document.getElementById('exchange-selector-options')).toBeNull()
  })
}

it('captures the selector as the dialog return target before the invoker unmounts', async () => {
  // A jsdom stub checks React handoff order only; Chromium verifies native
  // showModal, Escape, Cancel and stable Funds-page launch separately.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('button').focus() }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
  function Harness() {
    const [open, setOpen] = useState(false)
    return <><ExchangeSelector currentExchange="coinbase" exchanges={exchanges} onChange={() => {}} onAddFund={() => setOpen(true)} />
      {open && <ModalDialog onClose={() => setOpen(false)} labelledBy="title"><h2 id="title">Add Fund</h2><button onClick={() => setOpen(false)}>Cancel</button></ModalDialog>}</>
  }
  render(<Harness />)
  const trigger = openSelector()
  const invoker = screen.getByRole('button', { name: 'Add Fund' })
  invoker.focus()
  fireEvent.click(invoker)
  expect(invoker.isConnected).toBe(false)
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('hands mobile navigation focus to the committed loading landmark once, including same-route activation', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval')
  render(<BrowserRouter><App /></BrowserRouter>)
  const toggle = screen.getByRole('button', { name: 'Toggle menu' })
  fireEvent.click(toggle)
  const mobile = screen.getAllByRole('navigation', { name: 'Sections' }).at(-1)
  const link = within(mobile).getByRole('link', { name: 'Notifications' })
  link.focus()
  fireEvent.click(link)
  expect(window.location.pathname).toBe('/notifications')
  const main = screen.getByRole('main')
  expect(within(main).getByText('Loading...')).toBeTruthy()
  expect(document.activeElement).toBe(main)
  expect(link.isConnected).toBe(false)

  // Focus chosen while the lazy import loads must survive its completion.
  toggle.focus()
  await act(async () => lazyRoute.resolve())
  await screen.findByRole('button', { name: 'Destination settings' })
  expect(document.activeElement).toBe(toggle)

  fireEvent.click(toggle)
  const sameRoute = within(screen.getAllByRole('navigation', { name: 'Sections' }).at(-1)).getByRole('link', { name: 'Notifications' })
  sameRoute.focus()
  fireEvent.click(sameRoute)
  expect(document.activeElement).toBe(main)

  const destination = screen.getByRole('button', { name: 'Destination settings' })
  destination.focus()
  // App's background status poll rerenders the shell without new nav intent.
  const statusPoll = intervals.mock.calls.find(([, delay]) => delay === 5000)[0]
  await act(async () => statusPoll())
  expect(document.activeElement).toBe(destination)
})

it('preserves modified links and does not focus main on ordinary links or browser history', async () => {
  render(<BrowserRouter><App /></BrowserRouter>)
  fireEvent.click(screen.getByRole('button', { name: 'Toggle menu' }))
  const mobile = screen.getAllByRole('navigation', { name: 'Sections' }).at(-1)
  const link = within(mobile).getByRole('link', { name: 'Notifications' })
  link.focus()
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    fireEvent.click(link, { [modifier]: true })
    expect(window.location.pathname).toBe('/coinbase/BTC-USDC/config')
    expect(link.isConnected).toBe(true)
    expect(document.activeElement).toBe(link)
  }
  const desktop = screen.getAllByRole('navigation', { name: 'Sections' })[0]
  const ordinary = within(desktop).getByRole('link', { name: 'Notifications' })
  ordinary.focus()
  fireEvent.click(ordinary)
  await waitFor(() => expect(window.location.pathname).toBe('/notifications'))
  expect(document.activeElement).toBe(ordinary)
  act(() => {
    window.history.replaceState({}, '', '/backups')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(document.activeElement).toBe(ordinary)
})
