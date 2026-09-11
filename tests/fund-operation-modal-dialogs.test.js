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

  it('renders exactly two ModalDialog usages in App.jsx', () => {
    assert.equal(dialogUsages(appSource).length, 2)
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

  it('renders exactly seven ModalDialog usages', () => {
    assert.equal(dialogUsages(regimeActionModalsSource).length, 7)
  })

  const confirmations = [
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
