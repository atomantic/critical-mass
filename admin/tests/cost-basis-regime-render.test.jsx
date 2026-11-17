import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import CostBasisRegime from '../src/components/CostBasisRegime'

// Issue #499: the numeric states the Cost Basis page derives (unrealized,
// realized, total return, completed vs current cycles, dry-run badge) and the
// local table overflow wrapper, rendered rather than read from source text.
vi.mock('../src/lib/realtime', () => ({
  getRealtimeClient: () => ({ on() {}, off() {}, subscribe() {}, unsubscribe() {} }),
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const serve = ({ position, isDryRun = false, cycles = [], detailFills = [] }) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    url = String(url)
    const data = url.includes('/regime/status')
      ? { status: { isDryRun, position, market: { lastPrice: 120 } } }
      : url.includes('/regime/fills/cycles')
        ? { cycles, detailFills, revision: 'r1' }
        : { config: { productId: 'BTC-USDC' } }
    return { ok: true, status: 200, json: async () => data }
  }))
}
const row = (label) => screen.getAllByText(label)[0].parentElement

it('derives unrealized, realized and total-return figures and shows the dry-run badge', async () => {
  serve({
    isDryRun: true,
    position: { totalAsset: 2, totalCostBasis: 200, avgCostBasis: 100, realizedPnL: 30, realizedAssetPnL: 0.5, cyclesCompleted: 3 },
  })
  render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  await screen.findByText('Dry-Run Mode')
  // 2 BTC x 120 = 240 value; 240 - 200 = +40 (20%); reserves 0.5 x 120 = 60.
  expect(row('Unrealized P&L:').textContent).toContain('+$40.00')
  expect(row('Unrealized P&L:').textContent).toContain('(+20.00%)')
  expect(row('USDC Profit:').textContent).toContain('+$30.00')
  expect(row('Cycles Completed:').textContent).toContain('3')
  expect(row('Combined Value:').textContent).toContain('$300.00')
  expect(row('Total Return:').textContent).toContain('+$130.00')
})

it('omits the dry-run badge for live funds and shows negative unrealized P&L without a plus sign', async () => {
  serve({ position: { totalAsset: 1, totalCostBasis: 150, avgCostBasis: 150 } })
  render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  await screen.findByText('Unrealized P&L:')
  expect(screen.queryByText('Dry-Run Mode')).toBeNull()
  const text = row('Unrealized P&L:').textContent
  expect(text).not.toContain('+')
  expect(text).toContain('(')
})

it('shows P&L only for completed cycles and lists current-cycle fills oldest first in a locally scrollable table', async () => {
  serve({
    position: {},
    cycles: [
      { cycleId: 'current', totalBought: 1, totalCost: 100, totalSold: 0, totalProceeds: 0, entryCount: 1, exitCount: 1 },
      { cycleId: 'cycle-1', totalBought: 1, totalCost: 100, totalSold: 1, totalProceeds: 110, entryCount: 1, exitCount: 1 },
    ],
    detailFills: [
      { cycleId: 'current', side: 'sell', timestamp: 2000, size: 0.5, price: 120, quoteAmount: 60 },
      { cycleId: 'current', side: 'buy', timestamp: 1000, size: 1, price: 100, quoteAmount: 100 },
    ],
  })
  render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  await screen.findByText('Current Cycle')
  expect(screen.getAllByText(/^P&L:/)).toHaveLength(1)
  expect(screen.getByText(/^P&L:/).textContent).toContain('+$10.00')
  expect(screen.getByText('cycle-1')).toBeTruthy()

  const table = screen.getByRole('table')
  expect(table.parentElement.className).toContain('overflow-x-auto')
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
  const sides = within(table).getAllByRole('row').slice(1).map(r => r.cells[1].textContent)
  expect(sides).toEqual(['BUY', 'SELL'])
})
