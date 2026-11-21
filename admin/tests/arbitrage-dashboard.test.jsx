import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithToasts as render } from './renderWithToasts'
import ArbitrageDashboard from '../src/components/arbitrage/Dashboard.jsx'

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
          { symbol: 'XXBTZUSD', pair: 'BTC/USD', bid: 95990, ask: 96010, impliedMid: 96000, deviationBps: 0, conversionSource: 'home', conversionPath: [] },
          { symbol: 'XXBTZCAD', pair: 'BTC/CAD', bid: 67100, ask: 67200, impliedMid: 47950, deviationBps: -5005, conversionSource: 'venue', conversionPath: ['USD/CAD'] },
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
  expect(screen.getByText('-50.05%')).toBeTruthy()
  expect(screen.getAllByText('+9,800 bps').length).toBeGreaterThan(0)
  expect(screen.getByText(/nothing here places orders/)).toBeTruthy()

  const input = await screen.findByLabelText('Alert at net edge (bps, after fees)')
  fireEvent.change(input, { target: { value: '75' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
  await waitFor(() => {
    const put = fetch.mock.calls.find(([url, o]) => url === '/api/arbitrage/config' && o?.method === 'PUT')
    expect(put).toBeTruthy()
    expect(JSON.parse(put[1].body)).toEqual({ alertMinNetBps: 75 })
  })
})
