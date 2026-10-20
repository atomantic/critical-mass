import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Overview from '../src/components/Overview'

const fixture = vi.hoisted(() => ({ statuses: {} }))
vi.mock('../src/lib/router', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock('../src/hooks/useTradeEvents', () => ({ useMultiRegimeStatuses: () => ({ statuses: fixture.statuses, connected: false }) }))
vi.mock('../src/App', () => ({ getBaseCurrency: () => 'BTC', getQuoteCurrency: () => 'USDC' }))
vi.mock('../src/components/AddFundModal', () => ({ default: () => null }))
vi.mock('../src/components/ClosedFundCard', () => ({ default: () => null }))
vi.mock('../src/components/icons', () => ({ ExternalLink: () => null }))

const exchangeList = [
  { name: 'coinbase', pair: 'BTC-USDC' },
  { name: 'gemini', pair: 'ETH-USDC' },
]

function status(totalCostBasis, realizedPnL) {
  return {
    isRunning: true,
    position: { totalAsset: 1, totalCostBasis, realizedPnL },
    market: { lastPrice: 10 },
    apy: { deployedInPosition: totalCostBasis, estimatedApy: 12, availableCapital: 5 },
    health: { mode: 'ACTIVE' },
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('Overview read failures', () => {
  it('shows an exchange error instead of the empty state and retries successfully', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ exchanges: [] }) })

    render(<Overview />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/Unable to load exchanges/)).toBeTruthy()
    expect(screen.queryByText(/No exchanges configured/)).toBeNull()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText(/No exchanges configured/)).toBeTruthy()
  })

  it('marks a failed fund unavailable, excludes it from totals, and retries the status read', async () => {
    fetch.mockImplementation(async (url) => {
      if (url === '/api/exchanges') return { ok: true, json: async () => ({ exchanges: exchangeList }) }
      if (url.includes('/coinbase/')) return { ok: true, json: async () => ({ status: status(100, 7) }) }
      if (url.includes('/gemini/')) return fetch.geminiFails
        ? { ok: false, status: 504 }
        : { ok: true, json: async () => ({ status: status(900, 90) }) }
      return { ok: true, json: async () => ({}) }
    })
    fetch.geminiFails = true

    render(<Overview />)
    expect(await screen.findByText('Status unavailable')).toBeTruthy()
    expect(screen.getByText('1 fund unavailable; excluded from totals.')).toBeTruthy()
    expect(screen.queryByText('Stopped')).toBeNull()
    const unavailableCard = screen.getByText('Status unavailable').closest('.bg-gray-800')
    expect(within(unavailableCard).queryByText('$0.00 USD')).toBeNull()
    const capital = screen.getByText('Capital').parentElement
    expect(within(capital).getByText('$100.00')).toBeTruthy()
    expect(within(capital).queryByText('$1,000.00')).toBeNull()

    fetch.geminiFails = false
    fireEvent.click(within(unavailableCard).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Status unavailable')).toBeNull())
    expect(screen.queryByText(/fund unavailable/)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(6)
  })
})
