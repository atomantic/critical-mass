import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import OpenOrdersTable from '../src/components/regime/OpenOrdersTable'

afterEach(() => cleanup())

const baseProps = (overrides = {}) => ({
  pendingOrdersList: [],
  liveFills: [],
  openFillsTruncated: false,
  dryRunFilled: [],
  isDryRun: false,
  celestialBodies: [],
  position: { avgCostBasis: 50000 },
  config: { holdbackRatio: 0.5, feeRate: 0.001 },
  market: { lastPrice: 51000 },
  asset: 'BTC',
  isRunning: true,
  openSearchId: '',
  setTpEditModal: () => {},
  setRollUpConfirm: () => {},
  ...overrides,
})

const now = Date.now()
const sellOrder = { orderId: 'tp-sell-1', type: 'take_profit', status: 'open', size: 0.01, price: 52000, placedAt: now - 60_000 }
const entryOrder = { orderId: 'entry-buy-1', type: 'entry', status: 'open', size: 0.02, price: 49000, placedAt: now - 120_000 }
const ladderOrder = { orderId: 'ladder-buy-1', type: 'ladder_entry', status: 'open', size: 0.03, price: 48000, placedAt: now - 30_000 }

describe('OpenOrdersTable', () => {
  it('shows the empty state when there are no pending orders', () => {
    render(<OpenOrdersTable {...baseProps()} />)
    expect(screen.getByText('No open orders')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders sell and entry rows in separate tables with counts', () => {
    render(<OpenOrdersTable {...baseProps({ pendingOrdersList: [sellOrder, entryOrder, ladderOrder] })} />)
    expect(screen.getByText('1 sell order')).toBeTruthy()
    expect(screen.getByText('2 entry orders')).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(2)
    expect(screen.getByText('tp-sell-1')).toBeTruthy()
    expect(screen.getByText('entry-buy-1')).toBeTruthy()
    expect(screen.getByText('ladder-buy-1')).toBeTruthy()
    // Sell row: 0.01 BTC @ 52,000 = $520.00 value
    expect(screen.getAllByText('$520.00').length).toBeGreaterThan(0)
    expect(screen.getByText('Totals')).toBeTruthy()
  })

  it('omits the sell table when only entry orders are open', () => {
    render(<OpenOrdersTable {...baseProps({ pendingOrdersList: [entryOrder] })} />)
    expect(screen.queryByText(/sell order/)).toBeNull()
    expect(screen.getByText('1 entry order')).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('ignores orders that are not open', () => {
    render(<OpenOrdersTable {...baseProps({ pendingOrdersList: [{ ...sellOrder, status: 'cancelled' }] })} />)
    expect(screen.queryByText('tp-sell-1')).toBeNull()
  })

  it('filters rows by the open-order search id', () => {
    render(<OpenOrdersTable {...baseProps({ pendingOrdersList: [entryOrder, ladderOrder], openSearchId: 'LADDER' })} />)
    expect(screen.queryByText('entry-buy-1')).toBeNull()
    expect(screen.getByText('ladder-buy-1')).toBeTruthy()
  })

  it('wraps the Entry Orders table in its own overflow-x-auto container so wide rows scroll', () => {
    render(<OpenOrdersTable {...baseProps({ pendingOrdersList: [sellOrder, entryOrder] })} />)
    const entryTable = screen.getAllByRole('table').find(t => t.textContent.includes('entry-buy-1'))
    expect(entryTable.parentElement.className).toContain('overflow-x-auto')
  })
})
