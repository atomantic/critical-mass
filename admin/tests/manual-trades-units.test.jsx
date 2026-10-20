import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ManualTrades from '../src/components/ManualTrades'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sellOrder = { orderId: 'sell-order-1234567890', side: 'sell', totalBtc: 1.5, avgPrice: 2.5, totalUsdc: 3.75, time: '2026-09-01T12:00:00Z' }
const buyOrder = { ...sellOrder, orderId: 'buy-order-0987654321', side: 'buy', avgPrice: 2.4 }

async function openImportFor(pair, unaccountedOrders) {
  vi.stubGlobal('fetch', vi.fn(async url => ({
    ok: true,
    json: async () => url.includes('/manual-trades')
      ? { success: true, trades: [] }
      : { success: true, pending: false, unaccountedOrders },
  })))
  render(<ManualTrades exchange="cryptocom" pair={pair} />)
  fireEvent.click(screen.getByRole('button', { name: /Manual Trades/ }))
  fireEvent.change(screen.getByLabelText('Start Date for Unaccounted Fills'), { target: { value: '2026-09-01' } })
  fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
  fireEvent.click((await screen.findAllByRole('button', { name: 'Import' }))[0])
}

it('labels sizes and the recovery buy with the fund asset instead of BTC and USD', async () => {
  await openImportFor('CRO_USD', [sellOrder])

  expect(screen.getByText('Size (CRO)')).toBeTruthy()
  expect(screen.getByText('1.50000000 CRO')).toBeTruthy()
  expect(screen.getByLabelText('Recovery Buy Limit Price (USD)')).toBeTruthy()
  expect(screen.getByText('Will place a good-till-cancelled limit buy for 1.50000000 CRO')).toBeTruthy()
  expect(document.body.textContent).not.toContain('BTC')
})

it('uses the quote currency of a USDC-quoted fund in the recovery buy price', async () => {
  await openImportFor('ETH-USDC', [sellOrder])

  expect(screen.getByLabelText('Recovery Buy Limit Price (USDC)')).toBeTruthy()
  expect(screen.getByText('1.50000000 ETH')).toBeTruthy()
})

it('says "1 unaccounted order" for a single order', async () => {
  await openImportFor('ETH-USDC', [buyOrder])

  expect(screen.getByText('1 unaccounted order')).toBeTruthy()
})
