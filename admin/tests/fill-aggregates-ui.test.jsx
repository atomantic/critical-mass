import React from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import FilledOrdersSection from '../src/components/regime/FilledOrdersSection'

afterEach(cleanup)

it('shows exact cycle and grand totals when a fragmented sell has no display rows', () => {
  render(<FilledOrdersSection
    liveFills={[]}
    fillAggregates={{
      fillCount: 515, cycleCount: 1, sellOrderCount: 1, latestCycleId: 'cycle-1',
      totalPnl: 90, totalHoldback: 0.1, detailsTruncated: true,
      cycles: [{ cycleId: 'cycle-1', entryCount: 510, exitCount: 5 }],
      fillCycleGroups: [{ cycleId: 'cycle-1', sellCount: 1, buyCount: 1,
        totalSize: 5, totalPnl: 90, totalHoldback: 0.1, minTs: 1, maxTs: 2 }],
      fillCycleCount: 1,
    }}
    isDryRun={false} dryRunFilled={[]} pendingOrdersList={[]}
    market={{ lastPrice: 100 }} asset="BTC"
  />)
  expect(screen.getByText(/Recent order details shown/)).toBeTruthy()
  expect(document.body.textContent).toContain('515 fills')
  expect(screen.getByText(/1 sell across 1 cycle/)).toBeTruthy()
  expect(screen.queryByText('No filled sells yet')).toBeNull()
  expect(screen.getByRole('button', { name: 'Details for cycle #1' })).toBeTruthy()
})

it('does not present a capped orphan sample as the full open-buy quantity', () => {
  render(<FilledOrdersSection
    liveFills={[{ tradeId: 'open-1', orderId: 'open-tp-buy', side: 'buy', cycleId: 'cycle-1',
      timestamp: 1, size: 1, price: 100, quoteAmount: 100 }]}
    fillAggregates={{ fillCount: 120, cycleCount: 1, latestCycleId: 'cycle-1',
      totalPnl: 0, totalHoldback: 0, detailsTruncated: true, openFillsTruncated: true,
      cycles: [{ cycleId: 'cycle-1', entryCount: 120, exitCount: 0 }],
      fillCycleGroups: [], fillCycleCount: 0 }}
    isDryRun={false} dryRunFilled={[]} pendingOrdersList={[]}
    market={{ lastPrice: 100 }} asset="BTC"
  />)
  expect(screen.getByText(/Unpaired buy details exceed the display limit/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Orphaned buy details' })).toBeNull()
})
