import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import CostBasisDCA from '../src/components/CostBasisDCA'
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

it('shows paired USD even for sells with no buys in their cycle and discloses older fills', async () => {
  serve({
    position: { activeCycleId: 'cycle-2' },
    cycles: [
      { cycleId: 'cycle-2', totalBought: 1, totalCost: 100, totalSold: 0.5, totalProceeds: 60, totalPnl: 8, entryCount: 1, exitCount: 1 },
      { cycleId: 'cycle-1', totalBought: 0, totalCost: 0, totalSold: 1, totalProceeds: 110, totalPnl: 7, entryCount: 0, exitCount: 1 },
    ],
    detailFills: [
      { cycleId: 'cycle-2', side: 'sell', timestamp: 2000, size: 0.5, price: 120, quoteAmount: 60 },
      { cycleId: 'cycle-2', side: 'buy', timestamp: 1000, size: 1, price: 100, quoteAmount: 100 },
      { cycleId: 'cycle-1', side: 'sell', timestamp: 900, size: 1, price: 110, quoteAmount: 110 },
    ],
  })
  render(<CostBasisRegime exchange="coinbase" pair="BTC-USDC" />)
  await screen.findByText('Current Cycle (cycle-2)')
  expect(screen.getByText('Realized USD: +$8.00')).toBeTruthy()
  expect(screen.getByText('Realized USD: +$7.00')).toBeTruthy()
  const [active, previous] = screen.getAllByText('Fill details').map(summary => summary.parentElement)
  expect(active.open).toBe(true)
  expect(previous.open).toBe(false)
  expect(previous.querySelector('table')).toBeNull()
  fireEvent.click(within(previous).getByText('Fill details'))
  expect(previous.open).toBe(true)
  expect(await within(previous).findByText('SELL')).toBeTruthy()
  const table = within(active).getByRole('table')
  expect(table.parentElement.className).toContain('overflow-x-auto')
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
  expect(within(table).getAllByRole('row').slice(1).map(r => r.cells[1].textContent)).toEqual(['BUY', 'SELL'])
})

it('prices only the held part of a DCA order after a partial cancelled sale', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ currentPrice: 120 }) })))
  const order = { date: '2026-11-01', status: 'sell_failed', assetBought: 1, executedSellQuantity: 0.4,
    costBasis: 100, buyPrice: 100, costPerAsset: 100, holdback: 0.1, sellQuantity: 0.5, sellPrice: 130, netFees: 0 }
  render(<CostBasisDCA summary={{ config: { productId: 'BTC-USDC' }, costBasis: {
    totalAssetBought: 1, totalCostBasis: 100, avgCostPerAsset: 100, pendingAsset: 0, pendingCostBasis: 0,
    reservesAsset: 0.1, reservesCostBasis: 10, reservesAvgCost: 100, orderBreakdown: [order],
  } }} />)
  expect(await screen.findByText('+$12.00 (20.0%)')).toBeTruthy()
})
