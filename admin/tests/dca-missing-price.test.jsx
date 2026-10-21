import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import CostBasisDCA from '../src/components/CostBasisDCA.jsx'
import Dashboard from '../src/components/Dashboard.jsx'

vi.mock('../src/components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))
vi.mock('../src/components/ActivityFeed', () => ({ default: () => null }))
vi.mock('../src/components/FailedSellPlacements', () => ({ default: () => null }))
vi.mock('../src/components/DcaPlacementRecovery', () => ({ default: () => null }))
vi.mock('../src/components/DcaPendingBuyRecovery', () => ({ default: () => null }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })
const costBasis = {
  reservesAsset: 0.1, reservesCostBasis: 5000, reservesAvgCost: 50000,
  pendingAsset: 0.1, pendingCostBasis: 5000, pendingAvgCost: 50000,
  avgCostPerAsset: 50000, orderBreakdown: [],
}
const summary = {
  config: { productId: 'BTC-USDC', totalAllocation: 1000 },
  state: { assetReserves: 0.1, outstandingOrdersAsset: 0.1, usdcFundSize: 100 },
  stats: { totalBuys: 1, totalSells: 1, pendingOrders: 0, realizedProfit: 10, totalFees: 0, totalRebates: 0, netFees: 0, allocationUsed: 0, allocationRemaining: 0 },
  costBasis,
  nextTrade: {},
}

describe('DCA unavailable price', () => {
  it('Cost Basis shows dashes and the API error, then computed values after a good status', async () => {
    let good = false
    vi.stubGlobal('fetch', vi.fn(async () => good
      ? ok({ currentPrice: 60000 })
      : ok({ currentPrice: 0, apiError: 'Exchange down' })))
    render(<CostBasisDCA summary={summary} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Exchange down')
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
    expect(document.body.textContent).not.toContain('-100')
    good = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(document.body.textContent).toContain('+20.00%')
  })

  it('Cost Basis reports a non-ok status read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<CostBasisDCA summary={summary} />)
    expect((await screen.findByRole('alert')).textContent).toContain('500')
    expect(document.body.textContent).not.toContain('-100')
  })

  it('Dashboard shows dashes for Float P&L and the API error, then values after a good status', async () => {
    let good = false
    vi.stubGlobal('fetch', vi.fn(async () => good
      ? ok({ currentPrice: 60000 })
      : ok({ currentPrice: 0, apiError: 'Exchange down' })))
    render(<Dashboard summary={summary} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Exchange down')
    expect(document.body.textContent).not.toContain('-100')
    const label = screen.getByText('Float P&L')
    expect(label.parentElement.textContent).toContain('—')
    good = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('Float P&L').parentElement.textContent).toContain('+20.0%')
  })
})
