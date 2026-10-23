import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('keeps TP edit and roll-up controls touch-sized on desktop and forwards their actions', () => {
    const onEdit = vi.fn()
    const onRollUp = vi.fn()
    const low = { ...sellOrder, orderId: 'tp-low', type: 'body_tp', price: 52000 }
    const high = { ...sellOrder, orderId: 'tp-high', type: 'body_tp', price: 55000 }
    const bodies = [
      { id: 'body-low', tpOrderId: 'tp-low', tpPrice: 52000, costBasis: 450, avgPrice: 50000 },
      { id: 'body-high', tpOrderId: 'tp-high', tpPrice: 55000, costBasis: 470, avgPrice: 51000 },
    ]
    render(<OpenOrdersTable {...baseProps({
      pendingOrdersList: [low, high], celestialBodies: bodies,
      setTpEditModal: onEdit, setRollUpConfirm: onRollUp,
    })} />)

    const edit = screen.getAllByTitle('Edit TP target').find(button => button.closest('tr').textContent.includes('tp-low'))
    expect(edit).toBeTruthy()
    const rollUp = screen.getByTitle(/Roll up into/)
    for (const button of [edit, rollUp]) {
      expect(button.className).toContain('min-h-11')
      expect(button.className).toContain('regime-order-touch-target')
      expect(button.className).not.toContain('md:min-h-0')
    }
    fireEvent.click(edit)
    fireEvent.click(rollUp)
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ bodyId: 'body-low' }))
    expect(onRollUp).toHaveBeenCalledWith(expect.objectContaining({ bodyId: 'body-low' }))
  })
})
