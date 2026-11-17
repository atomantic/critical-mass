import React from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FilledOrdersSection from '../src/components/regime/FilledOrdersSection'

// Issue #968: expanded cycle and orphan tables stay horizontally scrollable
// inside narrow cards, are keyboard reachable, and are named regions.
afterEach(cleanup)

const fills = [
  { tradeId: 'b1', orderId: 'buy-1', side: 'buy', cycleId: 'cycle-1', timestamp: 1000, size: 1, price: 100, quoteAmount: 100, sellOrderId: 'sell-1' },
  { tradeId: 's1', orderId: 'sell-1', side: 'sell', cycleId: 'cycle-1', timestamp: 2000, size: 1, price: 110, quoteAmount: 110, bodyPnl: 10 },
  { tradeId: 'o1', orderId: 'orphan-1', side: 'buy', cycleId: 'cycle-2', timestamp: 3000, size: 2, price: 90, quoteAmount: 180 },
]

const mount = () => render(<FilledOrdersSection
  liveFills={fills} fillAggregates={null} isDryRun={false} dryRunFilled={[]}
  pendingOrdersList={[]} priceDecimals={2} asset="BTC"
/>)

it('renders the cycle table in a focusable named region that scrolls with ArrowLeft/ArrowRight', () => {
  mount()
  // The most recent cycle auto-expands; cycle-1 is expanded on demand.
  fireEvent.click(screen.getByRole('button', { name: 'Details for cycle #1' }))
  const region = screen.getByRole('region', { name: 'Cycle #1 scrollable table' })
  expect(region.tabIndex).toBe(0)
  expect(region.className).toContain('overflow-x-auto')
  expect(region.querySelector('table')).toBeTruthy()

  region.scrollLeft = 100
  const right = fireEvent.keyDown(region, { key: 'ArrowRight' })
  expect(right).toBe(false) // default prevented
  expect(region.scrollLeft).toBe(140)
  fireEvent.keyDown(region, { key: 'ArrowLeft' })
  expect(region.scrollLeft).toBe(100)
  // Other keys are left alone.
  expect(fireEvent.keyDown(region, { key: 'Tab' })).toBe(true)
  expect(region.scrollLeft).toBe(100)
})

it('shows the same column headers in the cycle table and the orphan table, and keeps the orphan region scrollable', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Orphaned buy details' }))
  const orphans = screen.getByRole('region', { name: 'Orphaned buys scrollable table' })
  expect(orphans.tabIndex).toBe(0)
  expect(orphans.className).toContain('overflow-x-auto')
  const headers = (root) => [...root.querySelectorAll('th')].map(th => th.textContent)
  expect(headers(orphans)).toEqual(expect.arrayContaining(['Order ID', 'Size (BTC)', 'Price', 'Value']))

  fireEvent.click(screen.getByRole('button', { name: 'Details for cycle #1' }))
  const cycle = screen.getByRole('region', { name: 'Cycle #1 scrollable table' })
  expect(headers(cycle)).toEqual(expect.arrayContaining(['Order ID', 'Size (BTC)', 'Price', 'Value']))

  orphans.scrollLeft = 10
  fireEvent.keyDown(orphans, { key: 'ArrowRight' })
  expect(orphans.scrollLeft).toBe(50)
})
