const TEST_DIR = require('node:path').resolve(__dirname, '../..');
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #539: the rest of the reduced-motion behaviour (OS preference hook,
// persisted pause toggle, canvas name, demand frameloop, auto-rotate, static
// starfield) is covered by admin/tests/celestial-reduced-motion.test.jsx and
// celestial-scene-motion.test.jsx. A CSS media query cannot be exercised by
// jsdom, so this one source-level assertion is intentionally retained.
const indexCssSource = fs.readFileSync(
  path.join(TEST_DIR, '..', 'admin', 'src', 'index.css'),
  'utf8',
)

describe('prefers-reduced-motion CSS gate (issue #539)', () => {
  it('collapses animation/transition durations under prefers-reduced-motion: reduce', () => {
    assert.match(indexCssSource, /@media \(prefers-reduced-motion: reduce\)/)
    assert.match(indexCssSource, /animation-duration: 0\.01ms !important/)
    assert.match(indexCssSource, /animation-iteration-count: 1 !important/)
    assert.match(indexCssSource, /transition-duration: 0\.01ms !important/)
  })
})
