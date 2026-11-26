import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import ModalDialog from '../src/components/ModalDialog'
import ConfirmDialog from '../src/components/ui/ConfirmDialog'

// jsdom does not implement <dialog> modality; model open/close/cancel.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})
afterEach(() => { cleanup(); delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close })

function Host({ busy = false, confirmDisabled = false, onConfirm = vi.fn() }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Invoke</button>
      {open && (
        <ConfirmDialog id="demo" title="Demo title" description="Demo description" confirmLabel="Go" busyLabel="Going…"
          busy={busy} confirmDisabled={confirmDisabled} onConfirm={onConfirm} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
const openDialog = () => {
  const invoker = screen.getByRole('button', { name: 'Invoke' })
  invoker.focus()
  fireEvent.click(invoker)
  return { invoker, dialog: screen.getByRole('dialog') }
}

it('opens modally with an accessible name and description and moves focus into the dialog (#434)', () => {
  render(<Host />)
  const { dialog } = openDialog()
  expect(dialog.tagName).toBe('DIALOG')
  expect(dialog.open).toBe(true)
  expect(dialog.getAttribute('aria-labelledby')).toBe('demo-title')
  expect(dialog.getAttribute('aria-describedby')).toBe('demo-description')
  expect(screen.getByRole('dialog', { name: 'Demo title' })).toBe(dialog)
  expect(document.getElementById('demo-description').textContent).toBe('Demo description')
  expect(dialog.contains(document.activeElement)).toBe(true)
})

it('uses a generated id when ConfirmDialog is given none', () => {
  render(<ConfirmDialog title="Auto" description="d" confirmLabel="Go" onConfirm={vi.fn()} onClose={vi.fn()} />)
  expect(screen.getByRole('dialog', { name: 'Auto' }).getAttribute('aria-describedby')).toBeTruthy()
})

it('restores focus to the invoking control when closed via Cancel or Escape (#434)', () => {
  render(<Host />)
  let { invoker, dialog } = openDialog()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(invoker)

  ;({ invoker, dialog } = openDialog())
  act(() => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); dialog.close() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(invoker)
})

it('keeps the original focus target when Strict Mode replays the open effect', () => {
  render(<React.StrictMode><Host /></React.StrictMode>)
  const invoker = screen.getByRole('button', { name: 'Invoke' })
  const focus = invoker.focus.bind(invoker)
  vi.spyOn(invoker, 'focus').mockImplementation(() => {
    // A modal makes its trigger inert during Strict Mode's effect cleanup.
    if (!document.querySelector('dialog[open]')) focus()
  })
  invoker.focus()
  fireEvent.click(invoker)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(document.activeElement).toBe(invoker)
})

it('closes on a backdrop click when dismissible, and ignores clicks inside the card', () => {
  render(<Host />)
  const { dialog } = openDialog()
  fireEvent.click(within(dialog).getByText('Demo title'))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(dialog)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('while busy: Cancel and Confirm are disabled with the busy label, Escape is blocked, backdrop ignored (#434)', () => {
  render(<Host busy />)
  const { dialog } = openDialog()
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  expect(within(dialog).getByRole('button', { name: 'Going…' }).disabled).toBe(true)
  const cancel = new Event('cancel', { cancelable: true })
  act(() => { dialog.dispatchEvent(cancel) })
  expect(cancel.defaultPrevented).toBe(true)
  fireEvent.click(dialog)
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('reopens the dialog when a second Escape closes it despite the busy guard (#1370)', () => {
  render(<Host busy />)
  const { dialog } = openDialog()
  const showModal = vi.spyOn(dialog, 'showModal')
  act(() => { dialog.open = false; dialog.dispatchEvent(new Event('close')) })
  expect(showModal).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).toBe(dialog)
})

it('focuses Cancel first and runs onConfirm only from Confirm; confirmDisabled blocks it', () => {
  const onConfirm = vi.fn()
  const { unmount } = render(<Host onConfirm={onConfirm} />)
  const { dialog } = openDialog()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(onConfirm).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Go' }))
  expect(onConfirm).toHaveBeenCalledTimes(1)
  unmount()

  render(<Host confirmDisabled />)
  const second = openDialog().dialog
  expect(within(second).getByRole('button', { name: 'Go' }).disabled).toBe(true)
})

it('ModalDialog syncs parent state through the close event and calls onClose once', () => {
  const onClose = vi.fn()
  render(<ModalDialog labelledBy="t" onClose={onClose}><h2 id="t">Plain</h2></ModalDialog>)
  const dialog = screen.getByRole('dialog', { name: 'Plain' })
  act(() => { dialog.close() })
  expect(onClose).toHaveBeenCalledTimes(1)
})
