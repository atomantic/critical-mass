import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CollapseAllConfirmation, RollUpConfirmation } from '../src/components/regime/RegimeActionConfirmations'
import DcaConvertDialog from '../src/components/regime/DcaConvertDialog'
import PlacementIntentsPanel from '../src/components/regime/PlacementIntentsPanel'

HTMLDialogElement.prototype.showModal = function () { this.open = true }
HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
afterEach(cleanup)

it('does not put a bare Cancel beside text about cancelling take-profit orders', () => {
  const onDismissCollapseAll = vi.fn()
  const { unmount } = render(<CollapseAllConfirmation open bodyCount={3} onClose={onDismissCollapseAll} onConfirm={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep bodies' }))
  expect(onDismissCollapseAll).toHaveBeenCalledTimes(1)
  unmount()

  const onDismissRollUp = vi.fn()
  render(<RollUpConfirmation rollUp={{ bodyId: 'b1', bodyLabel: 'one', targetLabel: 'two' }} onClose={onDismissRollUp} onConfirm={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep separate' }))
  expect(onDismissRollUp).toHaveBeenCalledTimes(1)
})

it.each([
  [true, 'Importing…', '1 body, '],
  [false, 'Upgrading…', undefined],
])('names the busy DCA conversion with the verb the operator accepted (merge=%s)', (merge, busy, bodies) => {
  const convertPreview = { merge, productId: 'ETH-USDC', existingBodies: 1, existingAsset: 0.5, pending: 2, filled: 1, pendingBaseQty: 1, pendingCostBasis: 2000, totalBaseQty: 2, totalCostBasis: 4000 }
  render(<DcaConvertDialog preview={convertPreview} busy onClose={vi.fn()} onConfirm={vi.fn()} />)
  expect(screen.getByRole('button', { name: busy })).toBeTruthy()
  if (bodies) expect(document.body.textContent).toContain(`(${bodies}`)
})

it('shows the client order as a labelled value, not the raw field name', () => {
  const intent = { id: 'i1', action: 'place', side: 'buy', clientOrderId: 'coid-123' }
  render(<PlacementIntentsPanel placementIntents={[intent]} asset="ETH" exchange="coinbase" pairQuery="" addToast={vi.fn()} fetchStatus={vi.fn()} fetchFills={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Adopt' }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('client order coid-123')
  expect(dialog.textContent).not.toContain('client_order_id')
})
