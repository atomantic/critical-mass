import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import FundLifecycleDialogs from '../src/components/shell/FundLifecycleDialogs'
import FundSubNav from '../src/components/shell/FundSubNav'
import { BrowserRouter } from '../src/lib/router'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
    // Model the browser's default focus on the first enabled control.
    this.querySelector('input:not(:disabled), button:not(:disabled)')?.focus()
  }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})
afterEach(() => { cleanup(); delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close })

const props = (over = {}) => ({
  currentExchange: 'coinbase', currentPair: 'BTC-USDC', exchanges: [], navigate: vi.fn(), addToast: vi.fn(), fetchExchanges: vi.fn(),
  closeFundDialogOpen: false, setCloseFundDialogOpen: vi.fn(), closeFundReason: '', setCloseFundReason: vi.fn(), closing: false, submitCloseFund: vi.fn(),
  addFundDialogOpen: false, setAddFundDialogOpen: vi.fn(),
  reopenFundDialogOpen: false, setReopenFundDialogOpen: vi.fn(), reopening: false, submitReopenFund: vi.fn(),
  resetDryRunConfirm: false, setResetDryRunConfirm: vi.fn(), resetting: false, handleExecuteResetDryRun: vi.fn(),
  ...over,
})
const cases = [
  { name: 'Close Fund', flag: 'closeFundDialogOpen', busy: 'closing', setter: 'setCloseFundDialogOpen', exec: 'submitCloseFund', title: /Close\s*coinbase\/BTC-USDC\?/, confirm: 'Close Fund', busyLabel: 'Closing...', others: ['submitReopenFund', 'handleExecuteResetDryRun'] },
  { name: 'Reopen Fund', flag: 'reopenFundDialogOpen', busy: 'reopening', setter: 'setReopenFundDialogOpen', exec: 'submitReopenFund', title: /Reopen\s*coinbase\/BTC-USDC\?/, confirm: 'Reopen Fund', busyLabel: 'Reopening...', others: ['submitCloseFund', 'handleExecuteResetDryRun'] },
  { name: 'Reset Dry-Run', flag: 'resetDryRunConfirm', busy: 'resetting', setter: 'setResetDryRunConfirm', exec: 'handleExecuteResetDryRun', title: 'Reset Dry-Run State', confirm: 'Reset Dry-Run', busyLabel: 'Resetting…', others: ['submitCloseFund', 'submitReopenFund'] },
]

it('renders no dialog while every lifecycle flag is closed', () => {
  render(<FundLifecycleDialogs {...props()} />)
  expect(screen.queryByRole('dialog', { name: /Close|Reopen|Reset/ })).toBeNull()
})

for (const c of cases) {
  it(`${c.name}: labelled dialog; Confirm runs only its executor, Cancel closes via its setter (#434, #699)`, () => {
    const p = props({ [c.flag]: true })
    render(<FundLifecycleDialogs {...p} />)
    const dialog = screen.getByRole('dialog', { name: c.title })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(p[c.setter]).toHaveBeenCalledWith(false)
    expect(p[c.exec]).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: c.confirm }))
    expect(p[c.exec]).toHaveBeenCalledTimes(1)
    for (const other of c.others) expect(p[other]).not.toHaveBeenCalled()
  })

  it(`${c.name}: is pending-aware (disabled buttons, busy label, Escape blocked)`, () => {
    render(<FundLifecycleDialogs {...props({ [c.flag]: true, [c.busy]: true })} />)
    const dialog = screen.getByRole('dialog', { name: c.title })
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: c.busyLabel }).disabled).toBe(true)
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
  })
}

it('Close Fund keeps the reason input labelled, forwards edits and disables it while closing', () => {
  const p = props({ closeFundDialogOpen: true })
  const { rerender } = render(<FundLifecycleDialogs {...p} />)
  const input = screen.getByLabelText('Reason (optional)')
  fireEvent.change(input, { target: { value: 'tax season' } })
  expect(p.setCloseFundReason).toHaveBeenCalledWith('tax season')
  rerender(<FundLifecycleDialogs {...p} closing />)
  expect(screen.getByLabelText('Reason (optional)').disabled).toBe(true)
})

it('the Reset button in FundSubNav only calls onResetDryRun (opens the confirm), never an executor (#699)', () => {
  const onResetDryRun = vi.fn()
  render(
    <BrowserRouter>
      <FundSubNav tabs={[]} buildPath={(t) => t} isActiveTab={() => false} currentExchange="coinbase" currentPair="BTC-USDC" exchanges={[]} onExchangeChange={vi.fn()} onAddFund={vi.fn()}
        currentStrategy="regime" regimeRunning regimeDryRun regimeLifecycle="active" wsConnected
        resetting={false} closing={false} stopping={false} reopening={false} starting={false}
        onResetDryRun={onResetDryRun} onOpenCloseFund={vi.fn()} onStop={vi.fn()} onOpenReopenFund={vi.fn()} onStart={vi.fn()} />
    </BrowserRouter>,
  )
  fireEvent.click(screen.getByTitle('Reset dry-run state'))
  expect(onResetDryRun).toHaveBeenCalledTimes(1)
})
