import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import ArbitrageDashboard from '../src/components/arbitrage/Dashboard.jsx'

HTMLDialogElement.prototype.showModal = function () { this.open = true }

const config = {
  enabled: true, pollIntervalMs: 60000, notionalUsd: 1000, alertMinNetBps: 50, minAlertNotionalUsd: 500,
  dislocationAlertBps: 300, confirmPolls: 2, closeAfterPolls: 3,
  venues: { kraken: { enabled: true, takerFeeBps: 40 } },
}
const status = {
  success: true, running: true, enabled: true, pollCount: 3, lastPollAt: new Date().toISOString(), openOpportunities: 1,
  referenceFx: { enabled: false },
  venues: [{ id: 'kraken', label: 'Kraken', enabled: true, takerFeeBps: 40, ok: true, at: new Date().toISOString() }],
  config,
}
const snapshot = {
  success: true,
  venues: {
    kraken: {
      id: 'kraken', label: 'Kraken', ok: true, failedBooks: [],
      analysis: {
        home: 'USD', medianImplied: 96000, notionalUsd: 1000, unconvertible: [],
        pairs: [
          { symbol: 'XXBTZUSD', pair: 'BTC/USD', bid: 95990, ask: 96010, impliedMid: 96000, deviationBps: 0, conversionSource: 'home', conversionPath: [], priceBasis: 'executable', edgeBps: -80, spreadBps: 0 },
          { symbol: 'XXBTZCAD', pair: 'BTC/CAD', bid: 67100, ask: 67200, impliedMid: 47950, deviationBps: -5005, conversionSource: 'venue', conversionPath: ['USD/CAD'], priceBasis: 'executable', edgeBps: 9800, edgeSide: 'buy', spreadBps: 15 },
          { symbol: 'btceur', pair: 'BTC/EUR', bid: 59051, ask: 77600, impliedMid: 75090, deviationBps: 2479, conversionSource: 'external', conversionPath: null, priceBasis: 'indicative', edgeBps: 741, edgeSide: 'sell', spreadBps: 2716 },
        ],
        routes: [{ id: 'a>b', buyPair: 'BTC/CAD', sellPair: 'BTC/USD', grossBps: 9900, atNotional: { netBps: 9800 } }],
      },
    },
  },
}
const opportunity = {
  id: 'opp-1', type: 'opportunity', status: 'open', venue: 'kraken', venueLabel: 'Kraken', pair: 'BTC/CAD',
  openedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), lastSeenAt: new Date().toISOString(), polls: 180,
  current: { buyPair: 'BTC/CAD', sellPair: 'BTC/USD', legs: [{ from: 'USD', to: 'CAD' }, { from: 'CAD', to: 'BTC' }, { from: 'BTC', to: 'USD' }], netBps: 9800, profitUsd: 23000, notionalUsd: 25000, largestProfitableUsd: 50000 },
  peak: { netBps: 9900, profitUsd: 23500 },
}
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/arbitrage/status') return ok(status)
    if (url === '/api/arbitrage/snapshot') return ok(snapshot)
    if (url.startsWith('/api/arbitrage/alerts')) return ok({ success: true, items: [opportunity], alerts: [opportunity] })
    return ok({ success: true })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows the open opportunity, the venue pair table and saves settings changes', async () => {
  render(<ArbitrageDashboard />)
  expect(await screen.findByText('Opportunity')).toBeTruthy()
  expect(screen.getByText('BTC/CAD', { selector: 'td' })).toBeTruthy()
  // The mid-based deviation is no longer a table column; edge is.
  expect(screen.queryByText('-50.05%')).toBeNull()
  expect(screen.getAllByText('+9,800 bps').length).toBeGreaterThan(0)
  expect(screen.getByText(/nothing here places orders/)).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Market buy (ask)' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Market sell (bid)' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Spread' })).toBeTruthy()
  expect(screen.getByText('27.16%')).toBeTruthy()
  // A matching gateway shows no stale-build warning.
  expect(screen.queryByText(/This page is older than the gateway/)).toBeNull()
  // A pair with no on-venue conversion is badged and greyed, its edge uncolored.
  const eurRow = screen.getByText('BTC/EUR', { selector: 'td' }).closest('tr')
  expect(eurRow.className).toContain('opacity-60')
  expect(eurRow.textContent).toContain('no round trip')
  expect(screen.getByText('+741 bps sell').className).toContain('text-gray-400')
  expect(screen.getByText('+9,800 bps buy').className).toContain('text-green-300')

  const input = await screen.findByLabelText('Alert at net edge (bps, after fees)')
  fireEvent.change(input, { target: { value: '75' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
  await waitFor(() => {
    const put = fetch.mock.calls.find(([url, o]) => url === '/api/arbitrage/config' && o?.method === 'PUT')
    expect(put).toBeTruthy()
    expect(JSON.parse(put[1].body)).toEqual({ alertMinNetBps: 75 })
  })
})

it('hides dismissed alerts behind a collapsed toggle', async () => {
  const dismissed = { ...opportunity, id: 'opp-2', pair: 'BTC/EUR', dismissed: true, status: 'closed', closedAt: new Date().toISOString() }
  fetch.mockImplementation(async (url) => {
    if (url === '/api/arbitrage/status') return ok(status)
    if (url === '/api/arbitrage/snapshot') return ok(snapshot)
    if (url.startsWith('/api/arbitrage/alerts')) return ok({ success: true, items: [opportunity, dismissed] })
    return ok({ success: true })
  })
  render(<ArbitrageDashboard />)
  const toggle = await screen.findByRole('button', { name: 'Show 1 dismissed alert' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  // Only the undismissed opportunity card renders until the toggle opens.
  expect(screen.getAllByText('Opportunity')).toHaveLength(1)
  expect(screen.getByText('No closed alerts yet.')).toBeTruthy()
  fireEvent.click(toggle)
  expect(screen.getAllByText('Opportunity')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Hide 1 dismissed alert' })).toBeTruthy()
})

it('warns when the gateway is newer than this admin build', async () => {
  fetch.mockImplementation(async (url) => {
    if (url === '/api/arbitrage/status') return ok({ ...status, dashboardVersion: 99 })
    if (url === '/api/arbitrage/snapshot') return ok(snapshot)
    if (url.startsWith('/api/arbitrage/alerts')) return ok({ success: true, items: [] })
    return ok({ success: true })
  })
  render(<ArbitrageDashboard />)
  expect(await screen.findByText(/This page is older than the gateway/)).toBeTruthy()
})

it('confirms clearing history and serializes the delete while it is pending', async () => {
  let finish
  const closed = { ...opportunity, id: 'closed-1', status: 'closed' }
  let items = [opportunity, closed]
  fetch.mockImplementation(async (url, options) => {
    if (options?.method === 'DELETE') return new Promise(resolve => {
      finish = () => { items = [opportunity]; resolve(ok({ success: true })) }
    })
    if (url === '/api/arbitrage/status') return ok(status)
    if (url === '/api/arbitrage/snapshot') return ok(snapshot)
    return ok({ success: true, items })
  })
  const deletes = () => fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE')
  render(<ArbitrageDashboard />)
  const clear = await screen.findByRole('button', { name: 'Clear history' })
  fireEvent.click(clear)
  const dialog = screen.getByRole('dialog', { name: 'Clear Alert History' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(deletes()).toHaveLength(0)
  fireEvent.click(clear)
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear History' })
  act(() => {
    fireEvent.click(confirm)
    fireEvent.click(confirm)
  })
  expect(deletes()).toHaveLength(1)
  expect(confirm.disabled).toBe(true)
  await act(async () => finish())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText('No closed alerts yet.')).toBeTruthy()
  expect(screen.getByText('Opportunity')).toBeTruthy()
})
