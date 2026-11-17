const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #455: ConfigEditor.jsx had two independent write paths for the same
// configuration — a full-form Save (PUT) and per-toggle autosaves (PATCH for
// Enabled/Dry Run) — with no shared operation boundary. A slow Save response
// unconditionally adopted the server's echoed config and cleared isDirty,
// silently discarding any edit made while the request was in flight, and a
// toggle autosave could leave an unconfirmed optimistic value in the form
// while Save stayed clickable, letting a full save submit it.
//
// This repo has no jsdom/React rendering harness (see
// admin-route-code-splitting.test.js and fund-operation-modal-dialogs.test.js
// for the established precedent), so — matching that convention — these tests
// assert against the ConfigEditor.jsx source text: the shared pendingWriteRef
// gate exists and is checked synchronously by every write-initiating handler,
// the disabled render state (`locked`) derived from it reaches every
// fund-config control via native <fieldset disabled> plus explicit props on
// the toggles/Save/Reset, and global preset editing is left outside that
// gate.

const configEditorSource = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'ConfigEditor.jsx'),
  'utf8',
)

describe('ConfigEditor shared write gate (issue #455)', () => {
  it('declares one pendingWriteRef shared by saves and toggle autosaves', () => {
    assert.match(configEditorSource, /const pendingWriteRef = useRef\(0\)/)
    // The old toggle-only ref name must be fully retired, not left dangling
    // alongside the new one.
    assert.doesNotMatch(configEditorSource, /togglePendingRef/)
  })

  it('handleSave synchronously refuses to start while any write is pending, and claims the gate for its own duration', () => {
    assert.match(
      configEditorSource,
      /const handleSave = async \(\) => \{\s*if \(pendingWriteRef\.current > 0\) return[^\n]*\n\s*pendingWriteRef\.current \+= 1\s*\n\s*setSaving\(true\)/,
    )
    assert.match(
      configEditorSource,
      /\} finally \{\s*pendingWriteRef\.current -= 1\s*\n\s*setSaving\(false\)\s*\n\s*\}\s*\n\s*\}/,
    )
  })

  it('handleToggleDryRun and handleToggleEnabled both refuse to start while any write is pending', () => {
    const guardCount = (configEditorSource.match(/if \(pendingWriteRef\.current > 0\) return/g) || []).length
    // handleSave + handleToggleDryRun + handleToggleEnabled: three independent
    // entry points plus restart, one shared gate.
    assert.equal(guardCount, 4)
    assert.match(
      configEditorSource,
      /const handleToggleDryRun = \(\) => \{\s*if \(pendingWriteRef\.current > 0\) return/,
    )
    assert.match(
      configEditorSource,
      /const handleToggleEnabled = \(\) => \{\s*if \(pendingWriteRef\.current > 0\) return/,
    )
  })

  it('persistToggle claims and releases the same gate around its request', () => {
    assert.match(
      configEditorSource,
      /const persistToggle = async \([^)]*\) => \{\s*pendingWriteRef\.current \+= 1\s*\n\s*setToggleBusy\(true\)/,
    )
    assert.match(
      configEditorSource,
      /\} finally \{\s*pendingWriteRef\.current -= 1\s*\n\s*setToggleBusy\(false\)\s*\n\s*\}\s*\n\s*\}/,
    )
  })

  it('the background config-refresh effect still skips syncing while the shared gate is held', () => {
    assert.match(
      configEditorSource,
      /if \(initialConfig && !isDirty && pendingWriteRef\.current === 0\) \{/,
    )
  })

  it('derives one render-state boolean from both write flags', () => {
    assert.match(configEditorSource, /const locked = saving \|\| toggleBusy/)
  })

  it('gates both top-level toggles, Save, and Reset with the shared render state', () => {
    const toggleDisabled = [...configEditorSource.matchAll(/<ToggleSwitch\b[\s\S]{0,220}?disabled={locked}/g)]
    assert.ok(toggleDisabled.length >= 2, 'expected both Enabled and Dry Run ToggleSwitch usages to gate on `locked`')
    assert.match(
      configEditorSource,
      /onClick={handleSave}\s*\n\s*disabled={locked}/,
    )
    assert.match(
      configEditorSource,
      /onClick={handleReset}\s*\n\s*disabled={locked}/,
    )
  })

  it('wraps the DCA fund-config fields in a disabled fieldset keyed to `locked`', () => {
    assert.match(
      configEditorSource,
      /\{!isRegime && \(\s*\n[\s\S]{0,400}?<fieldset disabled={locked} className="contents">/,
    )
  })

  it('wraps the regime fund-config cards (but not the presets editor) in a disabled fieldset keyed to `locked`', () => {
    const regimeBlockMatch = configEditorSource.match(
      /\{isRegime && \(\s*\n\s*<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">[\s\S]*?\{\/\* Aggressiveness Presets Editor/,
    )
    assert.ok(regimeBlockMatch, 'expected to find the regime settings block')
    const regimeBlock = regimeBlockMatch[0]

    const fieldsetOpenIndex = regimeBlock.indexOf('<fieldset disabled={locked} className="contents">')
    const fieldsetCloseIndex = regimeBlock.indexOf('</fieldset>')
    const presetsIndex = regimeBlock.indexOf('Aggressiveness Presets Editor')

    assert.ok(fieldsetOpenIndex !== -1, 'expected a locked fieldset to open inside the regime grid')
    assert.ok(fieldsetCloseIndex !== -1, 'expected the locked fieldset to close inside the regime grid')
    assert.ok(fieldsetOpenIndex < fieldsetCloseIndex, 'fieldset must open before it closes')
    // The Aggressiveness Presets editor must sit AFTER the fieldset closes —
    // i.e. outside the save/toggle gate — so global preset saving
    // (savingPresets) remains independent, per the acceptance criteria.
    assert.ok(
      fieldsetCloseIndex < presetsIndex,
      'Aggressiveness Presets editor must be outside the locked fieldset',
    )
  })

  it('never gates global preset saving on the shared write-in-flight state', () => {
    assert.doesNotMatch(configEditorSource, /savingPresets \|\| locked/)
    assert.doesNotMatch(configEditorSource, /locked \|\| savingPresets/)
    assert.match(configEditorSource, /disabled={savingPresets \|\| !presetsDirty}/)
  })

  it('preserves the distinct success/warning/error messages and persisted-but-not-applied handling for both write paths', () => {
    assert.match(configEditorSource, /notify\('success', 'Configuration saved!'\)/)
    assert.match(
      configEditorSource,
      /warnRestartNeeded\('Configuration saved, but the live engine is still using the previous settings\. Restart the engine to apply it\.'\)/,
    )
    assert.match(configEditorSource, /restartWarningRef\.current = notify\('warning', message, \{ sticky: true \}\)/, 'the sticky warning id is kept so it can be dismissed')
    assert.ok((configEditorSource.match(/dismissRestartWarning\(\)/g) || []).length >= 4, 'restart success and clean saves dismiss the stale warning')
    assert.equal((configEditorSource.match(/notify\('error', describeWriteFailure\(res\)\)/g) || []).length, 2, 'both save paths use the shared humanized error description')
    assert.match(configEditorSource, /notify\('success', `\$\{label\} saved`\)/)
    assert.match(
      configEditorSource,
      /warnRestartNeeded\(`\$\{label\} saved, but the live engine is still using the previous setting\. Restart the engine to apply it\.`\)/,
    )
  })
})

let helper
let savePayload
before(async () => {
  helper = await import('../admin/src/utils/regimeFieldValue.mjs')
  savePayload = await import('../admin/src/utils/configSavePayload.mjs')
})
const regimeCardsSource = fs.readFileSync(path.join(__dirname, '..', 'admin/src/components/config/RegimeConfigCards.jsx'), 'utf8')
const formControlsSource = fs.readFileSync(path.join(__dirname, '..', 'admin/src/components/config/ConfigFormControls.jsx'), 'utf8')

describe('ConfigEditor zero-valued fields (issues #868, #1983)', () => {
  it('reads every field through the one fieldValue helper, with no inline fallback literals', () => {
    // The server is the only source of defaults (summary.regimeDefaults).
    assert.match(regimeCardsSource, /import \{ fieldValue \} from '..\/..\/utils\/regimeFieldValue\.mjs'/)
    assert.doesNotMatch(regimeCardsSource, /\|\|\s*(-?\d|'|false|true)/, 'no `|| literal` fallback')
    assert.doesNotMatch(regimeCardsSource, /\?\?\s*(-?\d|'|false|true)/, 'no `?? literal` fallback')
    assert.doesNotMatch(regimeCardsSource, /!== false/, 'no implicit default-true reads')
  })

  it('fieldValue shows a saved 0 or false as saved and an absent field as the server default', () => {
    const { fieldValue } = helper
    const defaults = { harvestScale: 1, trendScale: 0.5, celestialEnabled: true, kFactor: 0.65 }
    assert.equal(fieldValue({ harvestScale: 0 }, defaults, 'harvestScale'), 0)
    assert.equal(fieldValue({ celestialEnabled: false }, defaults, 'celestialEnabled'), false)
    assert.equal(fieldValue({}, defaults, 'kFactor'), 0.65)
    assert.equal(fieldValue(undefined, defaults, 'trendScale'), 0.5)
    assert.equal(fieldValue({ kFactor: null }, defaults, 'kFactor'), 0.65)
    assert.equal(fieldValue({}, undefined, 'kFactor'), undefined)
  })

  it('every regime field the form reads exists in the server REGIME_DEFAULTS', () => {
    const { REGIME_DEFAULTS } = require('../src/config-utils')
    const keys = [...regimeCardsSource.matchAll(/fv\('(\w+)'\)/g)].map(m => m[1])
    assert.ok(keys.length > 70)
    const missing = [...new Set(keys)].filter(k => !(k in REGIME_DEFAULTS))
    assert.deepEqual(missing, [])
  })

  it('an untouched form diffs to an empty save payload, with defaults shown for absent fields', () => {
    const { buildSavePayload } = savePayload
    const { REGIME_DEFAULTS } = require('../src/config-utils')
    const baseline = { productId: 'BTC-USDC', dryRun: true, regime: { baseSizeUsdc: 0, harvestScale: 0 } }
    const draft = structuredClone(baseline)
    // Displayed values never enter the draft, so nothing is sent.
    assert.deepEqual(buildSavePayload(draft, baseline), {})
    assert.equal(helper.fieldValue(draft.regime, REGIME_DEFAULTS, 'harvestScale'), 0)
    assert.equal(helper.fieldValue(draft.regime, REGIME_DEFAULTS, 'kFactor'), REGIME_DEFAULTS.kFactor)
  })

  it('never conflates zero values with missing/uninitialized fields in saved requests', () => {
    // The FormInput component handles draft state correctly to preserve zeros
    // even when the field is cleared and re-entered. Verify that the
    // handleNumberChange doesn't commit 0 on clear (line 34) but does on
    // valid parse, preserving the semantics.
    assert.match(formControlsSource, /if \(raw\.trim\(\) === ''\) return/)
    assert.match(formControlsSource, /if \(Number\.isFinite\(n\)\) onChange\(n\)/)
  })
})
