import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Dashboard from '../src/components/Dashboard'
import ManualTrades from '../src/components/ManualTrades'
import { ToastProvider } from '../src/components/Toast'

// jsdom does not implement <dialog> modality.
HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('[autofocus]')?.focus() }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const summary = {
  config: { productId: 'BTC-USDC' },
  state: { assetReserves: 0, outstandingOrdersAsset: 0, orders: [{ orderId: 'o1', status: 'pending', createdAt: '2026-09-01T00:00:00Z', buyPrice: 1, sellPrice: 2, sellQuantity: 1 }] },
  stats: { pendingOrders: 1 },
  costBasis: {},
  nextTrade: null,
}
const preview = { merge: false, pending: 2, pendingBaseQty: 0.5, pendingCostBasis: 1000, existingBodies: 0 }

it('renders the DCA Export to Regime confirmation through the shared modal dialog', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('convert-dca') ? preview : url.includes('regime/status') ? { running: false } : {}),
  })))
  render(<ToastProvider><Dashboard summary={summary} exchange="coinbase" /></ToastProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Export to Regime' }))

  const dialog = await screen.findByRole('dialog', { name: 'Export to Regime Engine' })
  expect(dialog.tagName).toBe('DIALOG')
  expect(dialog.className).toContain('overflow-y-auto')
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBe(document.activeElement)
  expect(within(dialog).getByRole('button', { name: 'Confirm Export' })).toBeTruthy()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('gives the unmatched-order Import and Dismiss actions a touch-sized target', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => ({
    ok: true,
    json: async () => url.includes('/manual-trades')
      ? { success: true, trades: [] }
      : { success: true, pending: false, unaccountedOrders: [{ orderId: 'sell-order-1234567890', side: 'sell', totalBtc: 1, avgPrice: 2, totalUsdc: 2, time: '2026-09-01T12:00:00Z' }] },
  })))
  render(<ManualTrades exchange="cryptocom" pair="CRO_USD" />)
  fireEvent.click(screen.getByRole('button', { name: /Manual Trades/ }))
  fireEvent.change(screen.getByLabelText('Start Date for Unaccounted Fills'), { target: { value: '2026-09-01' } })
  fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
  for (const name of ['Import', 'Dismiss']) {
    const button = await screen.findByRole('button', { name })
    expect(button.className).toContain('min-h-11')
    expect(button.className).not.toContain('text-[10px]')
  }
})
