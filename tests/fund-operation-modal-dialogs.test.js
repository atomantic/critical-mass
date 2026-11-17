const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #434: the eight fund-operation confirmation overlays (Close/Reopen
// Fund in App.jsx, plus the six regime dialogs, then in RegimeActionModals.jsx) were plain
// `<div>` overlays with no dialog role, no focus containment, and no focus
// restoration to the invoking control. This repo has no jsdom/React
// rendering harness (see admin-route-code-splitting.test.js), so — matching
// that existing convention — these tests assert against the component
// source text: the shared native `<dialog>` wrapper exists with the
// required behaviors, and every call site actually uses it with a labelled
// heading/description and the expected initial-focus/dismissal wiring.

const modalDialogSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'ModalDialog.jsx'),
  'utf8',
)

const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'App.jsx'),
  'utf8',
)

// The fund lifecycle dialogs live in the shell components; the executors live
// in the fund controller hook and the Reset button in the fund sub-nav.
const lifecycleDialogsSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'shell', 'FundLifecycleDialogs.jsx'),
  'utf8',
)

const fundSubNavSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'shell', 'FundSubNav.jsx'),
  'utf8',
)

const fundControllerSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'hooks', 'useFundController.js'),
  'utf8',
)

const readRegime = (file) => fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'regime', file),
  'utf8',
)

// RegimeActionModals.jsx was dissolved (issue #1989): the confirmations now sit
// beside the hooks/panels that own their actions, on the shared ConfirmDialog.
const confirmationsSource = readRegime('RegimeActionConfirmations.jsx')
const tpEditSource = readRegime('TpEditDialog.jsx')
const dcaConvertSource = readRegime('DcaConvertDialog.jsx')
const placementIntentsSource = readRegime('PlacementIntentsPanel.jsx')
const regimeActionModalsSource = [confirmationsSource, tpEditSource, dcaConvertSource, placementIntentsSource].join('\n')

const confirmDialogSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'ui', 'ConfirmDialog.jsx'),
  'utf8',
)

const regimeDashboardSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'RegimeDashboard.jsx'),
  'utf8',
)

describe('ModalDialog shared wrapper (issue #434)', () => {
  it('is a native <dialog> that opens modally and restores invoker focus on close', () => {
    assert.match(modalDialogSource, /<dialog[\s\S]*ref={dialogRef}/)
    assert.match(modalDialogSource, /dialog\.showModal\(\)/)
    assert.match(modalDialogSource, /previouslyFocusedRef\.current = document\.activeElement/)
    assert.match(modalDialogSource, /previouslyFocusedRef\.current\?\.focus\?\.\(\)/)
  })

  it('exposes an accessible name and description via aria-labelledby/aria-describedby', () => {
    assert.match(modalDialogSource, /aria-labelledby={labelledBy}/)
    assert.match(modalDialogSource, /aria-describedby={describedBy}/)
  })

  it('blocks Escape/native cancel while a pending-action guard is active', () => {
    assert.match(modalDialogSource, /addEventListener\('cancel', handleCancel\)/)
    assert.match(modalDialogSource, /if \(!dismissibleRef\.current\) event\.preventDefault\(\)/)
  })

  it('reopens the dialog when a second Escape closes it despite the busy guard (issue #1370)', () => {
    assert.match(modalDialogSource, /if \(!dismissibleRef\.current\) \{\s*dialog\.showModal\(\)\s*return\s*\}/)
  })

  it('dismisses on backdrop click only when dismissible, and syncs parent state via the close event', () => {
    assert.match(modalDialogSource, /event\.target === dialogRef\.current && dismissibleRef\.current/)
    assert.match(modalDialogSource, /addEventListener\('close', handleClose\)/)
    assert.match(modalDialogSource, /onCloseRef\.current\?\.\(\)/)
  })

  it('keeps the dialog content viewport-bounded and scrollable', () => {
    assert.match(modalDialogSource, /max-h-\[calc\(100dvh-2rem\)\]/)
    assert.match(modalDialogSource, /overflow-y-auto/)
  })
})

const dialogUsages = (source) => [...source.matchAll(/<ModalDialog\b/g)]

describe('ConfirmDialog shared confirmation (issue #1989)', () => {
  it('is built on ModalDialog and gates dismissal on the busy flag', () => {
    assert.match(confirmDialogSource, /import ModalDialog from '\.\.\/ModalDialog'/)
    assert.match(confirmDialogSource, /<ModalDialog labelledBy={titleId} describedBy={descriptionId} dismissible={!busy} onClose={onClose}>/)
  })

  it('labels the title and description and focuses Cancel first, disabled while busy', () => {
    assert.match(confirmDialogSource, /<Title id={titleId}/)
    assert.match(confirmDialogSource, /<p id={descriptionId}/)
    assert.match(confirmDialogSource, /onClick={onClose} disabled={busy} autoFocus>/)
  })

  it('disables Confirm while busy or when the caller says so', () => {
    assert.match(confirmDialogSource, /onClick={onConfirm} disabled={busy \|\| confirmDisabled}/)
  })
})

describe('FundLifecycleDialogs.jsx fund lifecycle dialogs use ConfirmDialog (issue #434, #1989)', () => {
  it('imports the shared ConfirmDialog', () => {
    assert.match(lifecycleDialogsSource, /import ConfirmDialog from '\.\.\/ui\/ConfirmDialog'/)
  })

  it('no longer renders the fund dialogs as bare overlay divs', () => {
    assert.doesNotMatch(lifecycleDialogsSource, /fixed inset-0/)
  })

  const lifecycle = [
    { name: 'Close Fund', open: 'closeFundDialogOpen', id: 'close-fund', busy: 'closing', close: 'setCloseFundDialogOpen(false)', confirm: 'submitCloseFund' },
    { name: 'Reopen Fund', open: 'reopenFundDialogOpen', id: 'reopen-fund', busy: 'reopening', close: 'setReopenFundDialogOpen(false)', confirm: 'submitReopenFund' },
    { name: 'Reset Dry-Run', open: 'resetDryRunConfirm', id: 'reset-dry-run', busy: 'resetting', close: 'setResetDryRunConfirm(false)', confirm: 'handleExecuteResetDryRun' },
  ]
  for (const { name, open, id, busy, close, confirm } of lifecycle) {
    it(`renders ${name} as a labelled, pending-aware ConfirmDialog`, () => {
      const escaped = (v) => v.replace(/[()]/g, '\\$&')
      assert.match(
        lifecycleDialogsSource,
        new RegExp(`${open} && \\(\\s*<ConfirmDialog\\s+id="${id}"[\\s\\S]*?busy={${busy}}\\s+onConfirm={${confirm}}\\s+onClose={\\(\\) => ${escaped(close)}}`),
      )
    })
  }

  it('keeps the Close Fund reason input labelled', () => {
    assert.match(lifecycleDialogsSource, /<label htmlFor="close-fund-reason"/)
    assert.match(lifecycleDialogsSource, /id="close-fund-reason"/)
  })

  it('renders exactly three ConfirmDialog usages in FundLifecycleDialogs.jsx', () => {
    assert.equal([...lifecycleDialogsSource.matchAll(/<ConfirmDialog\b/g)].length, 3)
  })
})

describe('Regime confirmations use ConfirmDialog; the TP editor stays on ModalDialog (issue #434, #1989)', () => {
  it('RegimeActionModals.jsx is gone', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'admin', 'src', 'components', 'regime', 'RegimeActionModals.jsx')), false)
  })

  it('no longer renders any of its dialogs as bare overlay divs', () => {
    assert.doesNotMatch(regimeActionModalsSource, /bg-black\/60/)
    assert.doesNotMatch(regimeActionModalsSource, /fixed inset-0/)
  })

  it('uses ConfirmDialog for seven regime confirmations and ModalDialog only for the TP editor', () => {
    const count = (source, re) => [...source.matchAll(re)].length
    assert.equal(count(confirmationsSource, /<ConfirmDialog\b/g), 5)
    assert.equal(count(dcaConvertSource, /<ConfirmDialog\b/g), 1)
    assert.equal(count(placementIntentsSource, /<ConfirmDialog\b/g), 1)
    assert.equal(count(tpEditSource, /<ModalDialog\b/g), 1)
  })

  const confirmations = [
    { name: 'Cancel Ladder', source: confirmationsSource, id: 'cancel-ladder', busy: 'busy={busy}', dismissLabel: 'Keep ladder' },
    { name: 'Collapse All', source: confirmationsSource, id: 'collapse-all', busy: 'busy={busy}', dismissLabel: 'Keep bodies' },
    { name: 'Reset Cycle', source: confirmationsSource, id: 'reset-cycle', busy: 'busy={busy}' },
    { name: 'Roll Up', source: confirmationsSource, id: 'roll-up', busy: 'busy={busy}', dismissLabel: 'Keep separate' },
    { name: 'DCA conversion', source: dcaConvertSource, id: 'convert-dca', busy: 'busy={busy}' },
    { name: 'placement-intent reconcile', source: placementIntentsSource, id: 'reconcile-intent', busy: 'busy={reconcilingIntent}' },
  ]

  for (const { name, source, id, busy, dismissLabel } of confirmations) {
    it(`labels the ${name} dialog and gates it on its pending flag (Cancel focus and dismissal come from ConfirmDialog)`, () => {
      assert.match(source, new RegExp(`<ConfirmDialog\\s+id="${id}"`))
      assert.ok(source.includes(busy))
      if (dismissLabel) assert.match(source, new RegExp(`cancelLabel="${dismissLabel}"`))
    })
  }

  it('lets the drawdown-resume dialog stay always-dismissible (no in-flight guard) but still labelled and Cancel-focused', () => {
    assert.match(confirmationsSource, /<ConfirmDialog\s+id="drawdown-resume"/)
    const dialog = confirmationsSource.slice(confirmationsSource.indexOf('id="drawdown-resume"'), confirmationsSource.indexOf('RollUpConfirmation'))
    assert.doesNotMatch(dialog, /busy=/)
  })

  it('labels both TP edit inputs and focuses the active mode input, not Cancel', () => {
    assert.match(tpEditSource, /maxWidthClassName="max-w-sm"/)
    assert.match(tpEditSource, /<h3 id="tp-edit-title"/)
    assert.match(tpEditSource, /<label htmlFor="tp-edit-pct-input"/)
    assert.match(tpEditSource, /id="tp-edit-pct-input"/)
    assert.match(tpEditSource, /<label htmlFor="tp-edit-price-input"/)
    assert.match(tpEditSource, /id="tp-edit-price-input"/)
    // Both mode inputs carry autoFocus (only one is ever mounted at a time,
    // per the pct/price mode branch), while Cancel in this dialog does not.
    assert.equal((tpEditSource.match(/onKeyDown={\(e\) => e\.key === 'Enter' && onSubmit\('(pct|price)'\)}\s*\n\s*autoFocus/g) || []).length, 2)
  })
})

describe('No window.confirm in admin/src (issue #699)', () => {
  const fs = require('node:fs')
  const path = require('node:path')

  it('admin/src contains no window.confirm calls', () => {
    const adminSrcDir = path.join(__dirname, '..', 'admin', 'src')
    const getAllJsxFiles = (dir) => {
      let files = []
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          files = files.concat(getAllJsxFiles(fullPath))
        } else if (entry.isFile() && (entry.name.endsWith('.jsx') || entry.name.endsWith('.js'))) {
          files.push(fullPath)
        }
      }
      return files
    }

    const jsxFiles = getAllJsxFiles(adminSrcDir)
    for (const file of jsxFiles) {
      const content = fs.readFileSync(file, 'utf8')
      assert.doesNotMatch(
        content,
        /window\.confirm\s*\(/,
        `Found window.confirm in ${path.relative(adminSrcDir, file)} — use ModalDialog confirmation dialogs instead (issue #699)`,
      )
    }
  })
})

// Issue #699: Cancel Ladder, Backup Delete, Reset dry-run and the fund-state
// restore all fire an irreversible/destructive request. Each one is split
// into an "open" handler (sets confirm state, wired to the visible button)
// and an "execute" handler (does the fetch, wired only inside the resulting
// ModalDialog). These tests assert that split holds: the execute handler's
// identifier appears in its source file only at its own definition plus its
// dialog-confirm-button usage(s) — never at the originating button — and that
// the originating button calls the open handler, not the executor.
describe('Destructive executors are reachable only from a dialog confirm action (issue #699)', () => {
  const countOccurrences = (source, identifier) =>
    (source.match(new RegExp(`\\b${identifier}\\b`, 'g')) || []).length

  it('handleExecuteResetDryRun (useFundController) is defined once and invoked only as the Reset Dry-Run dialog confirm action', () => {
    assert.equal((fundControllerSource.match(/const handleExecuteResetDryRun = /g) || []).length, 1)
    assert.doesNotMatch(fundControllerSource, /handleExecuteResetDryRun\(/)
    // App only forwards it to the dialogs component (destructure + prop name + prop value).
    assert.equal(countOccurrences(appSource, 'handleExecuteResetDryRun'), 3)
    assert.doesNotMatch(appSource, /handleExecuteResetDryRun\(/)
    assert.equal(countOccurrences(lifecycleDialogsSource, 'handleExecuteResetDryRun'), 2)
    assert.match(
      lifecycleDialogsSource,
      /resetDryRunConfirm && \([\s\S]*?onConfirm={handleExecuteResetDryRun}[\s\S]*?<\/ConfirmDialog>/,
    )
  })

  it('the Reset button in FundSubNav.jsx only opens the confirm dialog (calls onResetDryRun, wired to handleResetDryRun, not the executor)', () => {
    assert.match(fundSubNavSource, /onClick={onResetDryRun}/)
    assert.doesNotMatch(fundSubNavSource, /handleExecuteResetDryRun/)
    assert.match(appSource, /onResetDryRun={handleResetDryRun}/)
    assert.doesNotMatch(appSource, /onResetDryRun={handleExecuteResetDryRun}/)
  })

  it("handleExecuteCancelLadder (RegimeDashboard.jsx) is defined once and passed only to the Cancel Ladder dialog's confirm prop", () => {
    assert.equal(countOccurrences(regimeDashboardSource, 'handleExecuteCancelLadder'), 2)
    assert.match(regimeDashboardSource, /onConfirm={handleExecuteCancelLadder}/)
  })

  it('CancelLadderConfirmation wires its confirm handler only to the Cancel Ladder dialog confirm action', () => {
    const cancelLadder = confirmationsSource.slice(
      confirmationsSource.indexOf('export function CancelLadderConfirmation'),
      confirmationsSource.indexOf('export function CollapseAllConfirmation'),
    )
    // destructured param + prop name + prop value
    assert.equal(countOccurrences(cancelLadder, 'onConfirm'), 3)
    assert.match(cancelLadder, /<ConfirmDialog[\s\S]*?onConfirm={onConfirm}[\s\S]*?<\/ConfirmDialog>/)
  })

  it('the Cancel Ladder button in RegimeDashboard.jsx only opens the confirm dialog (calls handleCancelLadder, not the executor)', () => {
    assert.match(regimeDashboardSource, /onClick={handleCancelLadder}/)
    assert.doesNotMatch(regimeDashboardSource, /onClick={handleCancelLadder}[\s\S]{0,400}handleExecuteCancelLadder\(\)/)
  })
})

describe('Cancel Ladder dialog copy (issue #1218)', () => {
  it('uses distinct dismiss/confirm labels and operator wording instead of the entryMode key', () => {
    assert.match(regimeActionModalsSource, /title="Cancel ladder orders\?"/)
    assert.match(regimeActionModalsSource, /confirmLabel="Cancel ladder orders"/)
    assert.match(regimeActionModalsSource, /busyLabel="Cancelling orders…"/)
    assert.match(regimeActionModalsSource, /Entry mode from LADDER to REACTIVE/)
    assert.doesNotMatch(regimeActionModalsSource, /<span className="font-mono">entryMode<\/span>/)
  })
})
