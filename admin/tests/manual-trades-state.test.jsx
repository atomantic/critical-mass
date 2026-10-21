import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ManualTrades from '../src/components/ManualTrades'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ok = body => ({ ok: true, status: 200, json: async () => body })
const order = { orderId: 'sell-order-1234567890', side: 'sell', totalBtc: 1.5, avgPrice: 2.5, totalUsdc: 3.75, time: '2026-09-01T12:00:00Z' }

it('shows a failed manual-trades read without also claiming no trades are tracked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'Engine unavailable' }) })))
  render(<ManualTrades exchange="coinbase" pair="BTC-USDC" />)

  expect((await screen.findByRole('alert')).textContent).toContain('Engine unavailable')
  expect(screen.queryByText('No manual trades tracked yet.')).toBeNull()
})

it('reports a rejected dismissal and keeps the order listed', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.includes('/manual-trades')) return ok({ success: true, trades: [] })
    if (url.includes('/dismiss-fills')) return { ok: false, status: 503, json: async () => ({ success: false, error: 'Engine not running' }) }
    return ok({ success: true, pending: false, unaccountedOrders: [order] })
  }))
  render(<ManualTrades exchange="coinbase" pair="BTC-USDC" />)
  fireEvent.click(screen.getByRole('button', { name: /Manual Trades/ }))
  fireEvent.change(screen.getByLabelText('Start Date for Unaccounted Fills'), { target: { value: '2026-09-01' } })
  fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))

  expect(await screen.findByText(/Could not dismiss order sell-ord\.\.\.: Engine not running/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
})
