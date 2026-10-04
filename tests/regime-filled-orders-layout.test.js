const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// Issue #968: FilledOrdersSection expanded cycle and orphan tables must remain
// scrollable within narrow cards. The outer border/rounded container clips the
// viewport, but the expanded table content region must have local overflow-x-auto,
// not overflow-hidden. Header buttons remain visible outside the scroll region.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'regime', 'FilledOrdersSection.jsx'),
  'utf8',
)

describe('FilledOrdersSection horizontal scroll layout (issue #968)', () => {
  it('orphan group header clipping border remains rounded, but inner table content scrolls locally', () => {
    // Outer container has border and rounded but NOT overflow-hidden
    assert.match(source, /border border-yellow-700\/40 rounded-lg">/)
    assert.doesNotMatch(source, /border border-yellow-700\/40 rounded-lg overflow-hidden/)

    // The expanded table container has overflow-x-auto
    assert.match(source, /id=\{`\$\{disclosureId\}-orphans`\}[\s\S]*?className="overflow-x-auto"/)
  })

  it('cycle group header clipping border remains rounded, but inner table content scrolls locally', () => {
    // Outer container has border and rounded but NOT overflow-hidden
    assert.match(source, /border border-gray-700 rounded-lg">/)
    assert.doesNotMatch(source, /border border-gray-700 rounded-lg overflow-hidden/)

    // The expanded table container has overflow-x-auto
    assert.match(source, /id=\{`\$\{disclosureId\}-cycle-\$\{encodeURIComponent\(cycle\.cycleId\)\}`\}[\s\S]*?className="overflow-x-auto"/)
  })

  it('tables maintain w-full width to enable horizontal scrolling within local container', () => {
    // Table widths are w-full to enable local scroll
    const tableMatches = source.match(/<table className="w-full text-sm">/g) || []
    assert.ok(tableMatches.length > 0, 'should have w-full tables')
  })

  it('orphan table columns match live cycle table header', () => {
    // Both have matching table headers
    assert.match(source, /<th className="text-left py-1.5 pr-2">Order ID<\/th>/)
    assert.match(source, /<th className="text-right py-1.5 pr-2">Size \(\{asset\}\)<\/th>/)
    assert.match(source, /<th className="text-right py-1.5 pr-2">Price<\/th>/)
    assert.match(source, /<th className="text-right py-1.5 pr-2">Value<\/th>/)
  })

  it('scrollable table containers support keyboard navigation', () => {
    // Both expanded containers have tabIndex and keyboard handler
    assert.match(source, /tabIndex=\{0\} onKeyDown=\{handleTableScrollKeydown\}/)
    // Check that handler is defined
    assert.match(source, /const handleTableScrollKeydown = \(e\) => \{/)
    assert.match(source, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/)
  })

  it('scrollable containers have accessibility labels', () => {
    // Orphans container has aria-label
    assert.match(source, /aria-label="Orphaned buys scrollable table"/)
    // Cycle containers have aria-label
    assert.match(source, /aria-label=\{`Cycle \$\{cycle\.cycleId\.replace/)
  })

  it('scrollable containers are marked as regions', () => {
    // Both have role="region" for screen readers
    assert.match(source, /role="region"/)
  })
})
