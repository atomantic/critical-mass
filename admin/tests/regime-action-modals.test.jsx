import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import RegimeActionModals from '../src/components/regime/RegimeActionModals'

HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
afterEach(cleanup)

const baseProps = {
  status: { celestial: { bodies: [{}, {}, {}] }, position: { pendingLadderOrders: [] } },
  position: { cycleBuys: 3 },
  config: { maxCycleBuys: 10 },
  getBaseCurrency: () => 'ETH',
  getQuoteCurrency: () => 'USDC',
}

it('does not put a bare Cancel beside text about cancelling take-profit orders', () => {
  const onDismissCollapseAll = vi.fn()
  const { unmount } = render(<RegimeActionModals {...baseProps} collapseAllConfirm onDismissCollapseAll={onDismissCollapseAll} />)
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep bodies' }))
  expect(onDismissCollapseAll).toHaveBeenCalledTimes(1)
  unmount()

  const onDismissRollUp = vi.fn()
  render(<RegimeActionModals {...baseProps} rollUpConfirm={{ bodyId: 'b1', bodyLabel: 'one', targetLabel: 'two' }} onDismissRollUp={onDismissRollUp} />)
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep separate' }))
  expect(onDismissRollUp).toHaveBeenCalledTimes(1)
})

it.each([
  [true, 'Importing…', '1 body, '],
  [false, 'Upgrading…', undefined],
])('names the busy DCA conversion with the verb the operator accepted (merge=%s)', (merge, busy, bodies) => {
  const convertPreview = { merge, productId: 'ETH-USDC', existingBodies: 1, existingAsset: 0.5, pending: 2, filled: 1, pendingBaseQty: 1, pendingCostBasis: 2000, totalBaseQty: 2, totalCostBasis: 4000 }
  render(<RegimeActionModals {...baseProps} showConvertConfirm converting convertPreview={convertPreview} onDismissConvert={vi.fn()} onExecuteConvert={vi.fn()} />)
  expect(screen.getByRole('button', { name: busy })).toBeTruthy()
  if (bodies) expect(document.body.textContent).toContain(`(${bodies}`)
})

it('shows the client order as a labelled value, not the raw field name', () => {
  const intent = { id: 'i1', action: 'place', side: 'buy', clientOrderId: 'coid-123' }
  render(<RegimeActionModals {...baseProps} intentConfirm={{ intent, action: 'adopt' }} onDismissIntent={vi.fn()} onExecuteIntent={vi.fn()} />)
  expect(document.body.textContent).toContain('client order coid-123')
  expect(document.body.textContent).not.toContain('client_order_id')
})
