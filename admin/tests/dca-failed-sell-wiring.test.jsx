import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dashboard from '../src/components/Dashboard'
import { ToastProvider } from '../src/components/Toast'

// Replaces the 'Dashboard wiring (issue #1035)' source-text block of
// tests/admin-failed-sell-placements.test.js with a rendered DCA Dashboard.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const summary = {
  config: { productId: 'BTC-USDC' },
  state: { assetReserves: 0, outstandingOrdersAsset: 0, orders: [{ orderId: 'o1', status: 'pending', createdAt: '2026-09-01T00:00:00Z', buyPrice: 1, sellPrice: 2, sellQuantity: 1 }] },
  stats: { pendingOrders: 1 },
  costBasis: {},
  nextTrade: null,
}
const failedSell = { buyOrderId: 'buy-77', buyQuantity: 0.01, buyPrice: 50000, sellFailedReason: 'insufficient funds' }

it('feeds failed sells from the live status read, above Pending Orders, and retry posts the buy id then re-reads status', async () => {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body })
    const body = url.includes('/retry-failed-sell') ? { message: 'Sell placed' }
      : url.includes('/regime/status') ? { running: false }
      : url.endsWith('/status') ? { failedSells: [failedSell], placementIntents: [] }
      : {}
    return { ok: true, status: 200, json: async () => body }
  }))
  render(<ToastProvider><Dashboard summary={summary} exchange="coinbase" /></ToastProvider>)

  const section = await screen.findByTestId('failed-sell-placements')
  expect(section.textContent).toContain('buy-77')
  const pending = screen.getByRole('heading', { name: /Pending Sell Orders/ })
  expect(section.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  const statusReads = () => calls.filter(c => c.url.endsWith('/status') && !c.url.includes('regime')).length
  const before = statusReads()
  fireEvent.click(screen.getByRole('button', { name: 'Retry sell' }))
  await waitFor(() => expect(calls.some(c => c.url.includes('retry-failed-sell'))).toBe(true))
  const retry = calls.find(c => c.url.includes('retry-failed-sell'))
  expect(retry.method).toBe('POST')
  expect(retry.url).toContain('/api/coinbase/retry-failed-sell')
  expect(JSON.parse(retry.body)).toEqual({ buyOrderId: 'buy-77' })
  await waitFor(() => expect(statusReads()).toBeGreaterThan(before))
})
