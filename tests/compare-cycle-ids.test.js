const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { compareCycleIds } = require('../admin/src/utils/regimeFillGroups.mjs')

describe('compareCycleIds', () => {
  it('places current first', () => {
    assert.equal(compareCycleIds('current', 'cycle-1'), -1)
    assert.equal(compareCycleIds('cycle-1', 'current'), 1)
    assert.equal(compareCycleIds('current', 'cycle-29'), -1)
    assert.equal(compareCycleIds('cycle-29', 'current'), 1)
  })

  it('places unknown last', () => {
    assert.equal(compareCycleIds('cycle-1', 'unknown'), -1)
    assert.equal(compareCycleIds('unknown', 'cycle-1'), 1)
    assert.equal(compareCycleIds('cycle-29', 'unknown'), -1)
    assert.equal(compareCycleIds('unknown', 'cycle-29'), 1)
  })

  it('sorts numeric cycles in descending order', () => {
    assert.ok(compareCycleIds('cycle-1', 'cycle-2') > 0, 'cycle-2 should come before cycle-1')
    assert.ok(compareCycleIds('cycle-2', 'cycle-1') < 0, 'cycle-1 should come after cycle-2')
    assert.ok(compareCycleIds('cycle-9', 'cycle-29') > 0, 'cycle-29 should come before cycle-9')
    assert.ok(compareCycleIds('cycle-29', 'cycle-9') < 0, 'cycle-9 should come after cycle-29')
  })

  it('handles edge cases correctly', () => {
    // Same cycle
    assert.strictEqual(compareCycleIds('cycle-5', 'cycle-5'), 0)
    assert.strictEqual(compareCycleIds('current', 'current'), 0)
    assert.strictEqual(compareCycleIds('unknown', 'unknown'), 0)
  })

  it('correctly orders all cycles 1-29 in descending order', () => {
    const cycles = ['cycle-1', 'cycle-2', 'cycle-5', 'cycle-9', 'cycle-10', 'cycle-19', 'cycle-29']
    const sorted = [...cycles].sort(compareCycleIds)
    assert.deepEqual(sorted, ['cycle-29', 'cycle-19', 'cycle-10', 'cycle-9', 'cycle-5', 'cycle-2', 'cycle-1'])
  })

  it('correctly orders cycles with current first and unknown last', () => {
    const cycles = ['cycle-9', 'current', 'cycle-1', 'unknown', 'cycle-29']
    const sorted = [...cycles].sort(compareCycleIds)
    assert.deepEqual(sorted, ['current', 'cycle-29', 'cycle-9', 'cycle-1', 'unknown'])
  })
})
