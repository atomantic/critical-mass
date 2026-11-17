import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  CancelLadderConfirmation, CollapseAllConfirmation, ResetCycleConfirmation, ResumeDrawdownConfirmation, RollUpConfirmation,
} from '../src/components/regime/RegimeActionConfirmations'
import TpEditDialog from '../src/components/regime/TpEditDialog'
import DcaConvertDialog from '../src/components/regime/DcaConvertDialog'
import PlacementIntentsPanel from '../src/components/regime/PlacementIntentsPanel'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})
afterEach(() => { cleanup(); delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close })

const preview = { merge: false, productId: 'ETH-USDC', existingBodies: 0, pending: 2, filled: 1, pendingBaseQty: 1, pendingCostBasis: 2000, totalBaseQty: 2, totalCostBasis: 4000 }
const rollUp = { bodyId: 'b1', bodyLabel: 'one', targetLabel: 'two' }

// [name, dialog title, render(busy, handlers), confirm label, busy label]
const confirmations = [
  ['Cancel Ladder', 'Cancel ladder orders?', (h, busy) => <CancelLadderConfirmation open busy={busy} orderCount={3} {...h} />, 'Cancel ladder orders', 'Cancelling orders…', 'Keep ladder'],
  ['Collapse All', 'Collapse All Bodies', (h, busy) => <CollapseAllConfirmation open busy={busy} bodyCount={2} {...h} />, 'Collapse All', 'Collapsing…', 'Keep bodies'],
  ['Reset Cycle', 'Reset Cycle & Resume Buying', (h, busy) => <ResetCycleConfirmation open busy={busy} cycleBuys={1} maxCycleBuys={5} {...h} />, 'Reset cycle & resume buying', 'Resetting…', 'Cancel'],
  ['Roll Up', 'Roll Up Body', (h, busy) => <RollUpConfirmation rollUp={rollUp} busy={busy} {...h} />, 'Roll Up', 'Merging...', 'Keep separate'],
  ['DCA conversion', 'Upgrade DCA Orders', (h, busy) => <DcaConvertDialog preview={preview} busy={busy} {...h} />, 'Confirm Upgrade', 'Upgrading…', 'Cancel'],
]

for (const [name, title, ui, confirm, busyLabel, dismiss] of confirmations) {
  it(`${name}: labelled dialog; Confirm and dismiss call only their own handlers (#434)`, () => {
    const h = { onClose: vi.fn(), onConfirm: vi.fn() }
    render(ui(h, false))
    const dialog = screen.getByRole('dialog', { name: title })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: dismiss }))
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.onConfirm).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: confirm }))
    expect(h.onConfirm).toHaveBeenCalledTimes(1)
  })

  it(`${name}: pending flag disables both buttons and blocks Escape (#434)`, () => {
    render(ui({ onClose: vi.fn(), onConfirm: vi.fn() }, true))
    const dialog = screen.getByRole('dialog', { name: title })
    expect(within(dialog).getByRole('button', { name: dismiss }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: busyLabel }).disabled).toBe(true)
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
  })
}

it('confirmations render nothing while closed', () => {
  const { container } = render(<><CancelLadderConfirmation open={false} /><RollUpConfirmation rollUp={null} /><DcaConvertDialog preview={null} /></>)
  expect(container.querySelector('dialog')).toBeNull()
})

it('Roll Up confirms with the body id', () => {
  const onConfirm = vi.fn()
  render(<RollUpConfirmation rollUp={rollUp} onClose={vi.fn()} onConfirm={onConfirm} />)
  fireEvent.click(screen.getByRole('button', { name: 'Roll Up' }))
  expect(onConfirm).toHaveBeenCalledWith('b1')
})

it('drawdown-resume stays labelled and always dismissible (no in-flight guard)', () => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(<ResumeDrawdownConfirmation open onClose={onClose} onConfirm={onConfirm} />)
  const dialog = screen.getByRole('dialog', { name: 'Resume from Drawdown Pause' })
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(false)
  const cancel = new Event('cancel', { cancelable: true })
  dialog.dispatchEvent(cancel)
  expect(cancel.defaultPrevented).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resume Trading' }))
  expect(onConfirm).toHaveBeenCalledTimes(1)
  fireEvent.click(dialog)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('Cancel Ladder uses operator wording and distinct dismiss/confirm labels (#1218)', () => {
  render(<CancelLadderConfirmation open orderCount={3} onClose={vi.fn()} onConfirm={vi.fn()} />)
  const dialog = screen.getByRole('dialog', { name: 'Cancel ladder orders?' })
  expect(dialog.textContent).toContain('Entry mode from LADDER to REACTIVE')
  expect(dialog.textContent).toContain('3 resting ladder buy orders')
  expect(dialog.textContent).not.toContain('entryMode')
  expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: 'Keep ladder' })).toBeTruthy()
})

function TpHarness({ initial, busy = false, onSubmit = vi.fn() }) {
  const [tp, setTp] = useState(initial)
  return <TpEditDialog tp={tp} setTp={setTp} busy={busy} onSubmit={onSubmit} />
}
const tpState = (mode) => ({ bodyLabel: 'abcd', mode, inputValue: '2', priceValue: '102', avgPrice: 100 })

it.each([['pct', 'Take-profit % above avg cost'], ['price', 'Limit sell price (USD)']])('TP editor (%s mode) labels its input (#434)', (mode, label) => {
  render(<TpHarness initial={tpState(mode)} />)
  const dialog = screen.getByRole('dialog', { name: 'Set TP Target' })
  // Initial focus on the active input is not asserted: jsdom/React do not emit the
  // `autofocus` attribute showModal() honours; the autoFocus wiring is kept in
  // tests/admin-no-window-confirm.test.js.
  expect(within(dialog).getByLabelText(label).tagName).toBe('INPUT')
})

it('TP editor switches modes, submits with Enter and the confirm button, and gates on busy', () => {
  const onSubmit = vi.fn()
  const { rerender } = render(<TpHarness initial={tpState('pct')} onSubmit={onSubmit} />)
  fireEvent.keyDown(screen.getByLabelText('Take-profit % above avg cost'), { key: 'Enter' })
  expect(onSubmit).toHaveBeenLastCalledWith('pct')
  fireEvent.click(screen.getByRole('button', { name: 'Limit Price' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set Price' }))
  expect(onSubmit).toHaveBeenLastCalledWith('price')
  rerender(<TpHarness initial={tpState('pct')} busy onSubmit={onSubmit} />)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  expect(within(dialog).getByRole('button', { name: /Placing/ }).disabled).toBe(true)
})

it('TP editor Cancel closes the dialog by clearing its state', () => {
  render(<TpHarness initial={tpState('pct')} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('placement-intent reconcile confirmation is labelled per action and closes on Cancel', () => {
  const intents = [{ id: 'i1', action: 'place', side: 'buy', clientOrderId: 'coid-1' }]
  render(<PlacementIntentsPanel placementIntents={intents} asset="ETH" exchange="coinbase" pairQuery="" addToast={vi.fn()} fetchStatus={vi.fn()} fetchFills={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Adopt' }))
  expect(screen.getByRole('dialog', { name: 'Adopt the exchange order' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect(screen.getByRole('dialog', { name: 'Discard the placement intent' })).toBeTruthy()
})
