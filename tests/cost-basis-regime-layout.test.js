const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Issue #499: CostBasisRegime is a presentation-only React component and this
// repo does not carry a browser/React rendering harness. Keep the regression
// checks source-level, matching the existing admin component tests, so the
// responsive contracts cannot silently regress while the accounting formulas
// and displayed fixture fields remain unchanged.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'src', 'components', 'CostBasisRegime.jsx'),
  'utf8',
)

describe('CostBasisRegime responsive layout (issue #499)', () => {
  it('stacks the price groups on phones and lets long values wrap', () => {
    assert.match(source, /flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between/)
    assert.match(source, /<div className="min-w-0 flex-1">\s*<span className="block text-gray-400 break-words">Current/)
    assert.match(source, /<span className="block text-3xl font-bold break-words">\{formatPrice\(currentPrice\)\}<\/span>/)
    assert.match(source, /<span className="block text-2xl font-semibold break-words">\{formatPrice\(avgCost\)\}<\/span>/)
    assert.doesNotMatch(source, /ml-4/)
  })

  it('uses one, two, and four summary columns with shrinkable card content', () => {
    assert.match(source, /grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4/)
    assert.ok((source.match(/className="min-w-0 bg-gray-800 rounded-lg p-4"/g) || []).length >= 5)
    assert.ok((source.match(/flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1/g) || []).length >= 10)
    assert.match(source, /min-w-0 max-w-full break-words text-right font-mono/)
  })

  it('wraps cycle metrics and keeps current-cycle table overflow local', () => {
    assert.match(source, /grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm/)
    assert.ok((source.match(/<div className="min-w-0">\s*<span className="block text-gray-500">/g) || []).length >= 3)
    assert.match(source, /<div className="overflow-x-auto">\s*<table className="w-full text-xs">/)
    assert.doesNotMatch(source, /grid grid-cols-4 gap-4 text-sm/)
  })

  it('preserves the numeric states used by positive, negative, current, and completed fixtures', () => {
    assert.match(source, /const unrealizedPnL = currentValue - totalCostBasis/)
    assert.match(source, /const realizedPnL = position\.realizedPnL \|\| 0/)
    assert.match(source, /const isComplete = cycle\.cycleId !== 'current' && cycle\.totalSold > 0/)
    assert.match(source, /cycle\.cycleId === 'current' && cycle\.entries\.length > 0/)
    assert.match(source, /isDryRun && \(/)
    assert.match(source, /Dry-Run Mode/)
    assert.match(source, /\.sort\(\(a, b\) => a\.timestamp - b\.timestamp\)/)
  })
})
