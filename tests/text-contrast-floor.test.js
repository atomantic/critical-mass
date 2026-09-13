const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #538: `text-gray-500` (#6b7280) and `text-gray-600` (#4b5563) both
// fall below the WCAG 1.4.3 AA contrast floor of 4.5:1 for normal-size text
// against this admin SPA's dark panel backgrounds (bg-gray-800/900/950), and
// the `bg-green-600` / `bg-yellow-600` / `bg-red-600` solid action-button
// fills fall below 4.5:1 for their `text-white`/`text-gray-100` labels. The
// fix darkens both the caption text color (-> text-gray-400) and the button
// fills (-> green-800, yellow-800, red-700), leaving a few deliberate
// exemptions in place: disabled controls, decorative separators/chevrons,
// icon-only elements (not text nodes under 1.4.3), and a handful of
// already-passing or intentionally out-of-scope translucent status pills.
//
// This repo has no jsdom/React rendering harness (see
// admin-route-code-splitting.test.js, fund-operation-modal-dialogs.test.js,
// config-editor-write-gate.test.js for the established precedent), so —
// matching that convention — this test (a) documents the WCAG contrast math
// itself as a small, unit-tested pure function, and (b) greps the built
// admin/src tree for the failing color classes and asserts every surviving
// hit is on the checked-in allowlist below, so a newly introduced
// low-contrast site fails CI instead of silently blending in.

// ---------------------------------------------------------------------------
// WCAG 2.x relative-luminance / contrast-ratio helper (pure, no deps)
// ---------------------------------------------------------------------------

function srgbChannelToLinear(c8) {
  const c = c8 / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b)
}

// WCAG contrast ratio between two sRGB hex colors, in the range [1, 21].
function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

const AA_NORMAL_TEXT_FLOOR = 4.5

// The exact Tailwind v3 hex values this codebase's ramp uses.
const TW = {
  'gray-100': '#f3f4f6',
  'gray-400': '#9ca3af',
  'gray-500': '#6b7280',
  'gray-600': '#4b5563',
  'gray-800': '#1f2937',
  'gray-900': '#111827',
  'gray-950': '#030712',
  white: '#ffffff',
  'green-600': '#16a34a',
  'green-800': '#166534',
  'yellow-600': '#ca8a04',
  'yellow-800': '#854d0e',
  'red-600': '#dc2626',
  'red-700': '#b91c1c',
}

describe('WCAG contrast helper (issue #538)', () => {
  it('computes the exact ratios the issue measured for the failing caption colors', () => {
    assert.ok(Math.abs(contrastRatio(TW['gray-500'], TW['gray-800']) - 3.04) < 0.02)
    assert.ok(Math.abs(contrastRatio(TW['gray-500'], TW['gray-900']) - 3.67) < 0.02)
    assert.ok(Math.abs(contrastRatio(TW['gray-600'], TW['gray-950']) - 2.66) < 0.02)
  })

  it('confirms the replacement caption color (text-gray-400) clears the 4.5:1 floor everywhere it is used', () => {
    assert.ok(contrastRatio(TW['gray-400'], TW['gray-800']) >= AA_NORMAL_TEXT_FLOOR)
    assert.ok(contrastRatio(TW['gray-400'], TW['gray-900']) >= AA_NORMAL_TEXT_FLOOR)
    assert.ok(contrastRatio(TW['gray-400'], TW['gray-950']) >= AA_NORMAL_TEXT_FLOOR)
  })

  it('confirms the failing button fills measured below the floor', () => {
    assert.ok(contrastRatio(TW.white, TW['green-600']) < AA_NORMAL_TEXT_FLOOR)
    assert.ok(contrastRatio(TW.white, TW['yellow-600']) < AA_NORMAL_TEXT_FLOOR)
    assert.ok(contrastRatio(TW['gray-100'], TW['red-600']) < AA_NORMAL_TEXT_FLOOR)
  })

  it('confirms the darkened button fills clear the floor', () => {
    assert.ok(contrastRatio(TW.white, TW['green-800']) >= AA_NORMAL_TEXT_FLOOR)
    assert.ok(contrastRatio(TW.white, TW['yellow-800']) >= AA_NORMAL_TEXT_FLOOR)
    assert.ok(contrastRatio(TW['gray-100'], TW['red-700']) >= AA_NORMAL_TEXT_FLOOR)
  })
})

// ---------------------------------------------------------------------------
// Source sweep: every surviving text-gray-500/600 and bg-*-600 button site
// must be on this allowlist. Keyed by [relative file path, exact trimmed
// line text] so unrelated edits elsewhere in a file don't require touching
// this list, but a genuinely new site (different line content) will not
// match anything here and will fail the test.
// ---------------------------------------------------------------------------

const ADMIN_SRC = path.join(__dirname, '..', 'admin', 'src')

function listJsxFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listJsxFiles(full))
    else if (entry.name.endsWith('.jsx')) out.push(full)
  }
  return out
}

function findMatches(pattern) {
  const matches = []
  for (const file of listJsxFiles(ADMIN_SRC)) {
    const rel = path.relative(path.join(__dirname, '..'), file)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (pattern.test(line)) matches.push({ file: rel, line: i + 1, text: line.trim() })
      pattern.lastIndex = 0
    })
  }
  return matches
}

// Every remaining `text-gray-500` / `text-gray-600` site: disabled-control
// variants, decorative separators/chevrons, or icon-only elements (not text
// nodes, so 1.4.3 does not apply).
const TEXT_GRAY_ALLOWLIST = new Set([
  // disabled controls (exempt from 1.4.3)
  'admin/src/components/NotificationsConfig.jsx::className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"',
  'admin/src/components/LogViewer.jsx::className="px-2 py-1 text-xs bg-yellow-800 hover:bg-yellow-900 disabled:bg-yellow-950 disabled:text-gray-500 text-yellow-100 rounded transition-colors"',
  'admin/src/components/Backtest.jsx::className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded font-medium"',
  'admin/src/components/sentinel/Dashboard.jsx::className="px-3 py-1.5 bg-green-800 hover:bg-green-900 disabled:bg-gray-700 disabled:text-gray-500 rounded text-sm"',
  // decorative separators / connective punctuation between two real text nodes
  'admin/src/components/ManualTrades.jsx::<span className="text-gray-600">&rarr;</span>',
  'admin/src/components/ManualTrades.jsx::<span className="text-gray-600">=</span>',
  'admin/src/components/Overview.jsx::<span className="text-gray-600 mx-1">/</span>',
  'admin/src/components/charts/BTCPriceChart.jsx::<span className="text-gray-600 text-xs px-1">/</span>',
  // decorative expand/collapse disclosure chevrons (not informational text)
  "admin/src/components/ConfigEditor.jsx::<span className=\"text-gray-500 text-xs\">{isExpanded ? '▼' : '▶'}</span>",
  "admin/src/components/RegimeDashboard.jsx::<span className={`inline-block transition-transform text-xs text-gray-500 ${expandedCycles.has('orphans') ? 'rotate-90' : ''}`}>&#9654;</span>",
  "admin/src/components/RegimeDashboard.jsx::<span className={`inline-block transition-transform text-xs text-gray-500 ${isCycleExpanded ? 'rotate-90' : ''}`}>&#9654;</span>",
  // icon-only elements: color sets an SVG stroke/fill via currentColor, not a text node
  'admin/src/components/ChartsRegime.jsx::<svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">',
  'admin/src/components/Overview.jsx::<ExternalLink className="w-3.5 h-3.5 text-gray-500" />',
  'admin/src/components/charts/RegimePriceChart.jsx::<svg className="w-3.5 h-3.5 text-gray-500 group-hover:text-gray-300 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>',
  'admin/src/components/RegimeDashboard.jsx::<svg className="w-3 h-3 text-gray-600 group-hover:text-gray-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>',
  'admin/src/components/RegimeDashboard.jsx::<svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">',
  'admin/src/components/updown/TimeWarningBanner.jsx::<Clock size={16} className="text-gray-500" />',
  'admin/src/components/updown/TimeframeGrid.jsx::<ChevronsDown size={10} className="text-gray-500 shrink-0" title="Fading" />',
  'admin/src/components/updown/TradeHistory.jsx::<button disabled={busy} onClick={() => handleEdit(t)} className="text-gray-500 hover:text-blue-400 transition-colors" title="Edit">',
  'admin/src/components/updown/TradeHistory.jsx::<button disabled={busy} onClick={() => handleDelete(t.id)} className="text-gray-500 hover:text-red-400 transition-colors" title="Delete">',
])

// Every remaining `bg-green-600` / `bg-yellow-600` / `bg-red-600` site: a
// status dot/toggle-knob with no text, a badge/status map already passing
// 4.5:1 (dark text, or explicit text-white on red-600 which measures 4.83:1),
// a translucent `/NN` opacity pill using its own lighter `-400` text token
// (a distinct, deliberate design pattern, not a solid action-button fill),
// or a read-only table-cell status indicator (not an action button).
const BG_600_ALLOWLIST = new Set([
  // status badge color maps — not action buttons, not on an audited screen
  "admin/src/components/ExchangeSelector.jsx::color: 'bg-yellow-600',",
  "admin/src/components/ExchangeSelector.jsx::color: isDry ? 'bg-purple-600' : 'bg-green-600',",
  "admin/src/components/Overview.jsx::: { label: 'Running', color: 'bg-green-600', textColor: 'text-green-100', pulse: true }",
  // translucent status pills: bg-*-600/NN + text-*-400, a distinct pattern from solid buttons
  "admin/src/components/ManualTrades.jsx::buy_pending: 'bg-yellow-600/30 text-yellow-400 border-yellow-500/30',",
  "admin/src/components/ManualTrades.jsx::completed: 'bg-green-600/30 text-green-400 border-green-500/30',",
  'admin/src/components/ManualTrades.jsx::className="px-2 py-0.5 rounded text-[10px] bg-yellow-600/30 text-yellow-400 hover:bg-yellow-600/50 border border-yellow-500/30"',
  'admin/src/components/updown/PositionTracker.jsx::className="py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 rounded text-sm text-red-400 transition-colors flex items-center gap-1"',
  // read-only table-cell status indicators, not action buttons
  "admin/src/components/updown/TradeHistory.jsx::? d === 'up' ? 'bg-green-600 text-white' : d === 'down' ? 'bg-red-600 text-white' : 'bg-gray-600 text-white'",
  // already passes 4.5:1 (explicit text-white on red-600 = 4.83:1; dark text-black on yellow-600 = 7.15:1)
  "admin/src/components/sentinel/Dashboard.jsx::critical: 'bg-red-600 text-white',",
  "admin/src/components/sentinel/Dashboard.jsx::warning: 'bg-yellow-600 text-black',",
  // icon-only / no-text controls (toggle knob, restart icon button — no visible label)
  "admin/src/components/sentinel/Dashboard.jsx::className={`w-8 h-5 rounded-full relative transition-colors ${feed.enabled ? 'bg-green-600' : 'bg-gray-600'}`}",
  "admin/src/components/updown/Dashboard.jsx::className={`p-1.5 rounded transition-colors ${restarting ? 'bg-yellow-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}",
])

describe('admin/src text-gray-500/600 sweep (issue #538)', () => {
  it('every remaining text-gray-500/text-gray-600 site is a checked-in, deliberate exemption', () => {
    const matches = findMatches(/text-gray-(500|600)/g)
    const unexpected = matches.filter((m) => !TEXT_GRAY_ALLOWLIST.has(`${m.file}::${m.text}`))
    assert.deepEqual(
      unexpected,
      [],
      `Found text-gray-500/600 site(s) not on the allowlist (raise to text-gray-400 or add a justified exemption to tests/text-contrast-floor.test.js): ${JSON.stringify(unexpected, null, 2)}`,
    )
  })

  it('no readable body text uses placeholder-gray-500/600 (should be placeholder-gray-400 or lighter)', () => {
    const matches = findMatches(/placeholder-gray-(500|600)/g)
    assert.deepEqual(matches, [])
  })
})

describe('admin/src bg-green/yellow/red-600 button-fill sweep (issue #538)', () => {
  it('every remaining bg-green-600/bg-yellow-600/bg-red-600 site is a checked-in, deliberate exemption', () => {
    const matches = findMatches(/bg-(green|yellow|red)-600/g)
    const unexpected = matches.filter((m) => !BG_600_ALLOWLIST.has(`${m.file}::${m.text}`))
    assert.deepEqual(
      unexpected,
      [],
      `Found bg-green/yellow/red-600 site(s) not on the allowlist (darken the fill or add a justified exemption to tests/text-contrast-floor.test.js): ${JSON.stringify(unexpected, null, 2)}`,
    )
  })

  it('the named action buttons from the issue now clear 4.5:1 in their resting fill', () => {
    const backtest = fs.readFileSync(path.join(ADMIN_SRC, 'components', 'Backtest.jsx'), 'utf8')
    const backupRestore = fs.readFileSync(path.join(ADMIN_SRC, 'components', 'BackupRestore.jsx'), 'utf8')
    const sentinelDashboard = fs.readFileSync(path.join(ADMIN_SRC, 'components', 'sentinel', 'Dashboard.jsx'), 'utf8')

    assert.match(backtest, /bg-green-800 hover:bg-green-900 disabled:bg-green-950 rounded font-medium/) // Run Backtest
    assert.match(sentinelDashboard, /bg-green-800 hover:bg-green-900 rounded text-sm/) // Start
    assert.match(sentinelDashboard, /bg-green-800 hover:bg-green-900 disabled:bg-gray-700 disabled:text-gray-500 rounded text-sm/) // Add Feed
    assert.match(backupRestore, /bg-yellow-800 hover:bg-yellow-900 disabled:bg-yellow-950 disabled:cursor-not-allowed rounded-lg font-medium/) // Confirm Restore
    assert.match(backupRestore, /bg-yellow-800 hover:bg-yellow-900 disabled:bg-yellow-950 disabled:cursor-not-allowed rounded text-xs font-medium/) // Restore
    assert.match(backupRestore, /bg-red-700 hover:bg-red-800 disabled:bg-red-900 disabled:cursor-not-allowed rounded text-xs font-medium/) // Delete
  })
})
