import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import Dashboard from '../src/components/Dashboard'
import AuthDeniedBanner from '../src/components/regime/AuthDeniedBanner'
import { ToastProvider } from '../src/components/Toast'
import { TOUCH_TARGET } from '../src/components/ui/touchTarget'

HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const TOUCH_CLASSES = ['min-h-11', 'min-w-11', 'md:pointer-fine:min-h-0', 'md:pointer-fine:min-w-0']
const expectTouchSized = (el) => TOUCH_CLASSES.forEach(c => expect(el.className).toContain(c))

it('shared TOUCH_TARGET constant carries the Button.jsx touch idiom', () => {
  TOUCH_CLASSES.forEach(c => expect(TOUCH_TARGET).toContain(c))
})

it('gives the AuthDeniedBanner Resume button a touch-sized target', () => {
  render(<AuthDeniedBanner health={{ mode: 'AUTH_DENIED' }} handleResumeFromAuthDenied={() => {}} resumingAuth={false} />)
  expectTouchSized(screen.getByRole('button', { name: 'Resume' }))
})

it('gives the DCA export dialog confirm/cancel buttons a touch-sized target', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('convert-dca') ? { merge: false, pending: 2, pendingBaseQty: 0.5, pendingCostBasis: 1000, existingBodies: 0 } : url.includes('regime/status') ? { running: false } : {}),
  })))
  const summary = {
    config: { productId: 'BTC-USDC' },
    state: { assetReserves: 0, outstandingOrdersAsset: 0, orders: [{ orderId: 'o1', status: 'pending', createdAt: '2026-09-01T00:00:00Z', buyPrice: 1, sellPrice: 2, sellQuantity: 1 }] },
    stats: { pendingOrders: 1 },
    costBasis: {},
    nextTrade: null,
  }
  render(<ToastProvider><Dashboard summary={summary} exchange="coinbase" /></ToastProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Export to Regime' }))
  const dialog = await screen.findByRole('dialog', { name: 'Export to Regime Engine' })
  expectTouchSized(within(dialog).getByRole('button', { name: 'Cancel' }))
  expectTouchSized(within(dialog).getByRole('button', { name: 'Confirm Export' }))
})

// Fully migrated files take their touch target (and colours/radius) from the
// shared Button, so a raw <button> reappearing there would drift again.
it.each([
  ['src/components/regime/RegimeActionModals.jsx'],
  ['src/components/ActivityFeed.jsx'],
  ['src/components/ManualTrades.jsx', 1],
  ['src/components/sentinel/Dashboard.jsx', 1],
  ['src/components/updown/Dashboard.jsx'],
  ['src/components/ai/Providers.jsx'],
  ['src/components/BackupRestore.jsx'],
  ['src/components/Optimizer.jsx'],
  ['src/components/ConfigEditor.jsx', 1],
])('%s: buttons come from the shared Button', (file, rawButtons = 0) => {
  const src = readFileSync(resolve(process.cwd(), file), 'utf8')
  expect(src).toContain("import Button from")
  expect(src.split('<button').length - 1).toBe(rawButtons)
})
