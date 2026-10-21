import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TransactionsRegime from '../src/components/TransactionsRegime'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })

it('keeps the Manual Trades panel and its input across a fills filter change', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.includes('/regime/fills')) {
      return ok({
        revision: 'r1',
        fills: [],
        cycleIds: [],
        summary: { totalBuys: 0, totalSells: 0, totalAssetBought: 0, totalBtcSold: 0, totalFees: 0, totalPnL: 0, totalHoldbackBtc: 0, totalHoldbackValue: 0 },
        pageInfo: { page: 0, pageCount: 1, total: 0, start: 0, end: 0, hasPrev: false, hasNext: false },
      })
    }
    if (url.includes('/regime/status')) return ok({ status: { isDryRun: false } })
    if (url.includes('/regime/open-orders')) return ok({ orders: [] })
    if (url.includes('/manual-trades')) return ok({ success: true, trades: [] })
    return ok({ config: { productId: 'BTC-USDC' } })
  }))
  render(<TransactionsRegime exchange="coinbase" pair="BTC-USDC" />)

  fireEvent.click(await screen.findByRole('button', { name: /Manual Trades/ }))
  fireEvent.change(screen.getByLabelText('Start Date for Unaccounted Fills'), { target: { value: '2026-09-01' } })
  const fillsReads = () => fetch.mock.calls.filter(([url]) => url.includes('/regime/fills')).length
  const before = fillsReads()

  fireEvent.click(screen.getByRole('button', { name: 'Buys' }))
  await waitFor(() => expect(fillsReads()).toBeGreaterThan(before))
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(screen.getByLabelText('Start Date for Unaccounted Fills').value).toBe('2026-09-01')
})
