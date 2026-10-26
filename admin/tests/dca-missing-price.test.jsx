import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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


// Public Dashboard characterization: cost basis and price are independent.
const holdingCases = [100, null].flatMap(price =>
  [true, false].flatMap(hasCostBasis =>
    [10, -20, undefined].flatMap(realizedProfit =>
      [0, 0.1].map(reserves => ({ price, hasCostBasis, realizedProfit, reserves })))))

describe('DCA Dashboard holdings availability matrix', () => {
  it.each(holdingCases)('price=$price basis=$hasCostBasis realized=$realizedProfit reserves=$reserves', async ({ price, hasCostBasis, realizedProfit, reserves }) => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ currentPrice: price, apiError: price ? null : 'Price unavailable' })))
    render(<Dashboard summary={{
      ...summary,
      state: { ...summary.state, assetReserves: reserves },
      stats: { ...summary.stats, realizedProfit },
      costBasis: hasCostBasis ? { ...costBasis, reservesCostBasis: 4, pendingCostBasis: 6 } : null,
    }} />)
    if (price) await waitFor(() => expect(screen.getByText('BTC Value').previousElementSibling.textContent).not.toBe('—'))
    else await screen.findByRole('alert')

    const assets = screen.getByText('Fund Assets').parentElement
    const holding = label => within(assets).getByText(label).parentElement
    expect(holding('Pending Sale').textContent).toContain('0.1 BTC')
    expect(holding('Pending Sale').textContent).toContain(hasCostBasis ? 'Cost: $6.00' : 'Cost: —')
    expect(holding('Reserves').textContent).toContain(hasCostBasis ? 'Cost: $4.00' : 'Cost: —')
    expect(holding('Reserves').textContent).toContain(price ? `Val: $${(reserves * price).toFixed(2)}` : 'Val: —')
    const quantity = reserves + 0.1
    expect(holding('Total BTC').textContent).toContain(hasCostBasis ? `Avg: $${(10 / quantity).toFixed(2)}/BTC` : 'Avg: —/BTC')
    expect(within(assets).getByText('BTC Value').previousElementSibling.textContent).toBe(price ? `$${(quantity * price).toFixed(2)}` : '—')
    expect(within(assets).getByText('Total').previousElementSibling.textContent).toBe(price ? `$${(100 + quantity * price).toFixed(2)}` : '—')

    const floatCard = screen.getByText('Float P&L').parentElement
    if (!hasCostBasis || !price) {
      expect(floatCard.textContent).toContain('—')
      expect(floatCard.textContent).toContain(hasCostBasis ? 'Price unavailable' : 'Unavailable for Fibonacci DCA')
      expect(floatCard.className).toContain('border-blue-700')
    } else {
      const profit = quantity * price - 10
      expect(floatCard.textContent).toContain(`+$${profit.toFixed(2)}`)
      expect(floatCard.textContent).toContain(`+${(profit / 10 * 100).toFixed(1)}%`)
      expect(floatCard.className).toContain('border-green-700')
    }

    const realized = screen.getByText('Realized').parentElement
    if (realizedProfit === undefined) {
      expect(realized.textContent).toContain('—Unavailable for Simple DCA')
      expect(realized.className).toContain('border-blue-700')
    } else {
      // Missing price keeps USD realized profit visible; reserves preserve the
      // existing zero-price valuation until a market price becomes available.
      const total = realizedProfit + reserves * (price || 0)
      expect(realized.children[1].textContent).toBe(`${total >= 0 ? '+' : ''}$${total.toFixed(2)}`)
      expect(realized.className).toContain(total >= 0 ? 'border-green-700' : 'border-red-700')
      if (reserves) {
        expect(realized.textContent).toContain(`$${realizedProfit.toFixed(2)} USD`)
        expect(realized.textContent).toContain('+0.10000000 BTC')
      } else expect(realized.children).toHaveLength(2)
    }
  })
})
