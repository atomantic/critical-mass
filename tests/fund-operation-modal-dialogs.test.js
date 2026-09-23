const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #434: the eight fund-operation confirmation overlays (Close/Reopen
// Fund in App.jsx, plus the six RegimeActionModals.jsx dialogs) were plain
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

const regimeActionModalsSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'regime', 'RegimeActionModals.jsx'),
  'utf8',
)

const regimeDashboardSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'RegimeDashboard.jsx'),
  'utf8',
)

const backupRestoreSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'BackupRestore.jsx'),
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

describe('App.jsx fund lifecycle dialogs use ModalDialog (issue #434)', () => {
  it('imports the shared ModalDialog wrapper', () => {
    assert.match(appSource, /import ModalDialog from '\.\/components\/ModalDialog'/)
  })

  it('no longer renders the fund dialogs as bare overlay divs', () => {
    assert.doesNotMatch(appSource, /Close Fund confirmation dialog[\s\S]{0,80}<div\s+className="fixed inset-0/)
    assert.doesNotMatch(appSource, /Reopen Fund confirmation dialog[\s\S]{0,80}<div\s+className="fixed inset-0/)
  })

  it('renders Close Fund as a labelled, pending-aware ModalDialog with Cancel focused first', () => {
    assert.match(
      appSource,
      /closeFundDialogOpen && \(\s*<ModalDialog\s+onClose={\(\) => setCloseFundDialogOpen\(false\)}\s+dismissible={!closing}\s+labelledBy="close-fund-title"\s+describedBy="close-fund-description"/,
    )
    assert.match(appSource, /<h3 id="close-fund-title"/)
    assert.match(appSource, /<p id="close-fund-description"/)
    assert.match(appSource, /<label htmlFor="close-fund-reason"/)
    assert.match(appSource, /id="close-fund-reason"/)
    // Cancel (not the reason input) gets initial focus per the acceptance criteria.
    assert.match(
      appSource,
      /onClick={\(\) => setCloseFundDialogOpen\(false\)}\s+disabled={closing}\s+autoFocus/,
    )
  })

  it('renders Reopen Fund as a labelled, pending-aware ModalDialog with Cancel focused first', () => {
    assert.match(
      appSource,
      /reopenFundDialogOpen && \(\s*<ModalDialog\s+onClose={\(\) => setReopenFundDialogOpen\(false\)}\s+dismissible={!reopening}\s+labelledBy="reopen-fund-title"\s+describedBy="reopen-fund-description"/,
    )
    assert.match(appSource, /<h3 id="reopen-fund-title"/)
    assert.match(appSource, /<p id="reopen-fund-description"/)
    assert.match(
      appSource,
      /onClick={\(\) => setReopenFundDialogOpen\(false\)}\s+disabled={reopening}\s+autoFocus/,
    )
  })

  it('renders Reset Dry-Run as a labelled, pending-aware ModalDialog with Cancel focused first', () => {
    assert.match(
      appSource,
      /resetDryRunConfirm && \(\s*<ModalDialog\s+onClose={\(\) => setResetDryRunConfirm\(false\)}\s+dismissible={!resetting}\s+labelledBy="reset-dry-run-title"\s+describedBy="reset-dry-run-description"/,
    )
    assert.match(appSource, /<h3 id="reset-dry-run-title"/)
    assert.match(appSource, /<p id="reset-dry-run-description"/)
    assert.match(
      appSource,
      /onClick={\(\) => setResetDryRunConfirm\(false\)}\s+disabled={resetting}\s+autoFocus/,
    )
  })

  it('renders exactly three ModalDialog usages in App.jsx', () => {
    assert.equal(dialogUsages(appSource).length, 3)
  })
})

describe('RegimeActionModals.jsx body/regime dialogs use ModalDialog (issue #434)', () => {
  it('imports the shared ModalDialog wrapper', () => {
    assert.match(regimeActionModalsSource, /import ModalDialog from '\.\.\/ModalDialog'/)
  })

  it('no longer renders any of its dialogs as bare overlay divs', () => {
    assert.doesNotMatch(regimeActionModalsSource, /bg-black\/60/)
    assert.doesNotMatch(regimeActionModalsSource, /fixed inset-0/)
  })

  it('renders exactly eight ModalDialog usages', () => {
    assert.equal(dialogUsages(regimeActionModalsSource).length, 8)
  })

  const confirmations = [
    { name: 'Cancel Ladder', titleId: 'cancel-ladder-title', descId: 'cancel-ladder-description', dismissible: '!cancellingLadder', cancelDisabled: 'cancellingLadder' },
    { name: 'Collapse All', titleId: 'collapse-all-title', descId: 'collapse-all-description', dismissible: '!collapsingAll', cancelDisabled: 'collapsingAll' },
    { name: 'Reset Cycle', titleId: 'reset-cycle-title', descId: 'reset-cycle-description', dismissible: '!resettingCycle', cancelDisabled: 'resettingCycle' },
    { name: 'Roll Up', titleId: 'roll-up-title', descId: 'roll-up-description', dismissible: '!rollingUp', cancelDisabled: 'rollingUp' },
    { name: 'DCA conversion', titleId: 'convert-dca-title', descId: 'convert-dca-description', dismissible: '!converting', cancelDisabled: 'converting' },
    { name: 'placement-intent reconcile', titleId: 'reconcile-intent-title', descId: 'reconcile-intent-description', dismissible: '!reconcilingIntent', cancelDisabled: 'reconcilingIntent' },
  ]

  for (const { name, titleId, descId, dismissible, cancelDisabled } of confirmations) {
    it(`labels the ${name} dialog and focuses Cancel first, gated on its pending flag`, () => {
      assert.match(regimeActionModalsSource, new RegExp(`dismissible={${dismissible.replace('!', '!')}}`))
      assert.match(regimeActionModalsSource, new RegExp(`<h3 id="${titleId}"`))
      assert.match(regimeActionModalsSource, new RegExp(`<p id="${descId}"`))
      assert.match(
        regimeActionModalsSource,
        new RegExp(`disabled={${cancelDisabled}}\\s*\\n\\s*autoFocus\\s*\\n\\s*>\\s*\\n\\s*Cancel`),
      )
    })
  }

  it('lets the drawdown-resume dialog stay always-dismissible (no in-flight guard) but still labelled and Cancel-focused', () => {
    assert.match(regimeActionModalsSource, /<h3 id="drawdown-resume-title"/)
    assert.match(regimeActionModalsSource, /<p id="drawdown-resume-description"/)
    assert.match(
      regimeActionModalsSource,
      /onClick={\(\) => onDismissResumeDrawdown\(\)}\s*\n\s*autoFocus/,
    )
  })

  it('labels both TP edit inputs and focuses the active mode input, not Cancel', () => {
    assert.match(regimeActionModalsSource, /maxWidthClassName="max-w-sm"/)
    assert.match(regimeActionModalsSource, /<h3 id="tp-edit-title"/)
    assert.match(regimeActionModalsSource, /<label htmlFor="tp-edit-pct-input"/)
    assert.match(regimeActionModalsSource, /id="tp-edit-pct-input"/)
    assert.match(regimeActionModalsSource, /<label htmlFor="tp-edit-price-input"/)
    assert.match(regimeActionModalsSource, /id="tp-edit-price-input"/)
    // Both mode inputs carry autoFocus (only one is ever mounted at a time,
    // per the pct/price mode branch), while Cancel in this dialog does not.
    assert.equal((regimeActionModalsSource.match(/onKeyDown={\(e\) => e\.key === 'Enter' && onExecuteSetTp\('(pct|price)'\)}\s*\n\s*autoFocus/g) || []).length, 2)
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

  it('handleExecuteResetDryRun (App.jsx) is defined once and invoked only as the Reset Dry-Run dialog confirm action', () => {
    assert.equal(countOccurrences(appSource, 'handleExecuteResetDryRun'), 2)
    assert.match(
      appSource,
      /resetDryRunConfirm && \([\s\S]*?onClick={handleExecuteResetDryRun}[\s\S]*?<\/ModalDialog>/,
    )
  })

  it('the Reset button in App.jsx only opens the confirm dialog (calls handleResetDryRun, not the executor)', () => {
    assert.match(appSource, /onClick={handleResetDryRun}/)
    assert.doesNotMatch(appSource, /onClick={handleResetDryRun}[\s\S]{0,400}handleExecuteResetDryRun\(\)/)
  })

  it("handleExecuteCancelLadder (RegimeDashboard.jsx) is defined once and passed only to the Cancel Ladder dialog's confirm prop", () => {
    assert.equal(countOccurrences(regimeDashboardSource, 'handleExecuteCancelLadder'), 2)
    assert.match(regimeDashboardSource, /onExecuteCancelLadder={handleExecuteCancelLadder}/)
  })

  it('RegimeActionModals.jsx invokes onExecuteCancelLadder only as the Cancel Ladder dialog confirm action', () => {
    assert.equal(countOccurrences(regimeActionModalsSource, 'onExecuteCancelLadder'), 2)
    assert.match(
      regimeActionModalsSource,
      /cancelLadderConfirm && \([\s\S]*?onClick={onExecuteCancelLadder}[\s\S]*?<\/ModalDialog>/,
    )
  })

  it('the Cancel Ladder button in RegimeDashboard.jsx only opens the confirm dialog (calls handleCancelLadder, not the executor)', () => {
    assert.match(regimeDashboardSource, /onClick={handleCancelLadder}/)
    assert.doesNotMatch(regimeDashboardSource, /onClick={handleCancelLadder}[\s\S]{0,400}handleExecuteCancelLadder\(\)/)
  })

  it('handleExecuteDelete (BackupRestore.jsx) is defined once and invoked only as the Delete Backup dialog confirm action', () => {
    assert.equal(countOccurrences(backupRestoreSource, 'handleExecuteDelete'), 2)
    assert.match(
      backupRestoreSource,
      /deleteConfirm && \([\s\S]*?onClick={handleExecuteDelete}[\s\S]*?<\/ModalDialog>/,
    )
  })

  it('the Delete button in BackupRestore.jsx only opens the confirm dialog (calls handleDelete, not the executor)', () => {
    assert.match(backupRestoreSource, /onClick={\(\) => handleDelete\(backup\.filename\)}/)
    assert.doesNotMatch(backupRestoreSource, /onClick={\(\) => handleDelete\(backup\.filename\)}[\s\S]{0,400}handleExecuteDelete\(\)/)
  })

  it("handleExecuteFundStateRestore (BackupRestore.jsx) is defined once and invoked only from the fund-state restore dialog's Restore/Retry and Force buttons", () => {
    assert.equal(countOccurrences(backupRestoreSource, 'handleExecuteFundStateRestore'), 3)
    assert.match(
      backupRestoreSource,
      /fundStateRestoreConfirm && \([\s\S]*?onClick={\(\) => handleExecuteFundStateRestore\(\)}[\s\S]*?onClick={\(\) => handleExecuteFundStateRestore\({ force: true }\)}[\s\S]*?<\/ModalDialog>/,
    )
  })

  it('the Restore Fund State button in BackupRestore.jsx only opens the confirm dialog (calls handleRestoreFundState, not the executor)', () => {
    assert.match(
      backupRestoreSource,
      /onClick={\(\) => handleRestoreFundState\(snapshot\.snapshotId, fund\.exchange, fund\.pair\)}/,
    )
    assert.doesNotMatch(
      backupRestoreSource,
      /onClick={\(\) => handleRestoreFundState\(snapshot\.snapshotId, fund\.exchange, fund\.pair\)}[\s\S]{0,400}handleExecuteFundStateRestore\(/,
    )
  })

  it("BackupRestore.jsx's fund-state restore handles the 409 writers-not-quiesced response with the same blockedBy/Retry/Force UI as the full restore", () => {
    assert.match(backupRestoreSource, /res\.status === 409 && data\.code === 'writers-not-quiesced'/)
    assert.match(backupRestoreSource, /setFundStateBlockedBy\(blocked\)/)
    assert.match(backupRestoreSource, /fundStateBlockedBy \? 'Retry Restore' : 'Restore Fund State'/)
    assert.match(backupRestoreSource, /Force Restore Anyway/)
    assert.match(backupRestoreSource, /body: JSON\.stringify\({ force }\)/)
  })
})
