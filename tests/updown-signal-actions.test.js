// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  isBuyType,
  isSellType,
  isHeldLong,
  resolveAction,
  resolveActionLabel,
  labelHistoryActions,
  BUY_SIDE,
  SELL_SIDE,
} = require('../shared/signal-actions')

describe('signal-actions — unified UpDown action resolution', () => {
  describe('isBuyType', () => {
    it('returns true for BUY and STRONG_BUY', () => {
      assert.equal(isBuyType('BUY'), true)
      assert.equal(isBuyType('STRONG_BUY'), true)
    })

    it('returns false for SELL, STRONG_SELL, NEUTRAL, and undefined', () => {
      assert.equal(isBuyType('SELL'), false)
      assert.equal(isBuyType('STRONG_SELL'), false)
      assert.equal(isBuyType('NEUTRAL'), false)
      assert.equal(isBuyType(null), false)
      assert.equal(isBuyType(undefined), false)
    })
  })

  describe('isSellType', () => {
    it('returns true for SELL and STRONG_SELL', () => {
      assert.equal(isSellType('SELL'), true)
      assert.equal(isSellType('STRONG_SELL'), true)
    })

    it('returns false for BUY, STRONG_BUY, NEUTRAL, and undefined', () => {
      assert.equal(isSellType('BUY'), false)
      assert.equal(isSellType('STRONG_BUY'), false)
      assert.equal(isSellType('NEUTRAL'), false)
      assert.equal(isSellType(null), false)
      assert.equal(isSellType(undefined), false)
    })
  })

  describe('isHeldLong', () => {
    it('returns true for boolean true', () => {
      assert.equal(isHeldLong(true), true)
    })

    it('returns false for boolean false and null/undefined', () => {
      assert.equal(isHeldLong(false), false)
      assert.equal(isHeldLong(null), false)
      assert.equal(isHeldLong(undefined), false)
    })

    it('returns true for objects with contracts > 0 and direction !== down', () => {
      assert.equal(isHeldLong({ contracts: 1, direction: 'up' }), true)
      assert.equal(isHeldLong({ contracts: 1, direction: 'other' }), true)
      assert.equal(isHeldLong({ contracts: 5 }), true)
    })

    it('returns false for objects with contracts <= 0 or direction === down', () => {
      assert.equal(isHeldLong({ contracts: 0, direction: 'up' }), false)
      assert.equal(isHeldLong({ contracts: -1, direction: 'up' }), false)
      assert.equal(isHeldLong({ contracts: 1, direction: 'down' }), false)
    })

    it('returns true for objects with direction === up', () => {
      assert.equal(isHeldLong({ direction: 'up' }), true)
    })

    it('returns false for objects with direction !== up and no contracts', () => {
      assert.equal(isHeldLong({ direction: 'down' }), false)
      assert.equal(isHeldLong({ direction: 'flat' }), false)
    })
  })

  describe('resolveAction', () => {
    it('resolves BUY when flat to OPEN', () => {
      assert.equal(resolveAction('BUY', null), 'OPEN')
      assert.equal(resolveAction('BUY', false), 'OPEN')
    })

    it('resolves BUY when long to ADD', () => {
      assert.equal(resolveAction('BUY', true), 'ADD')
      assert.equal(resolveAction('BUY', { contracts: 1, direction: 'up' }), 'ADD')
    })

    it('resolves STRONG_BUY when flat to OPEN', () => {
      assert.equal(resolveAction('STRONG_BUY', null), 'OPEN')
    })

    it('resolves STRONG_BUY when long to ADD', () => {
      assert.equal(resolveAction('STRONG_BUY', true), 'ADD')
    })

    it('resolves SELL, STRONG_SELL, NEUTRAL when long to CLOSE', () => {
      assert.equal(resolveAction('SELL', true), 'CLOSE')
      assert.equal(resolveAction('STRONG_SELL', true), 'CLOSE')
      assert.equal(resolveAction('NEUTRAL', true), 'CLOSE')
    })

    it('resolves SELL, STRONG_SELL, NEUTRAL when flat to HOLD', () => {
      assert.equal(resolveAction('SELL', null), 'HOLD')
      assert.equal(resolveAction('STRONG_SELL', false), 'HOLD')
      assert.equal(resolveAction('NEUTRAL', null), 'HOLD')
    })

    it('resolves null/undefined when flat to HOLD', () => {
      assert.equal(resolveAction(null, null), 'HOLD')
      assert.equal(resolveAction(undefined, false), 'HOLD')
    })

    it('resolves null/undefined when long to CLOSE', () => {
      assert.equal(resolveAction(null, true), 'CLOSE')
      assert.equal(resolveAction(undefined, true), 'CLOSE')
    })
  })

  describe('resolveActionLabel — null guard and passthrough', () => {
    it('returns CALCULATING... for null and undefined type', () => {
      assert.equal(resolveActionLabel(null), 'CALCULATING...')
      assert.equal(resolveActionLabel(undefined), 'CALCULATING...')
    })

    it('passes through already-resolved action strings', () => {
      assert.equal(resolveActionLabel('OPEN', null), 'OPEN')
      assert.equal(resolveActionLabel('ADD', null), 'ADD')
      assert.equal(resolveActionLabel('HOLD', null), 'HOLD')
      assert.equal(resolveActionLabel('CLOSE', null), 'CLOSE')
    })

    it('passes through already-resolved action strings regardless of held state', () => {
      assert.equal(resolveActionLabel('OPEN', true), 'OPEN')
      assert.equal(resolveActionLabel('ADD', false), 'ADD')
      assert.equal(resolveActionLabel('HOLD', true), 'HOLD')
      assert.equal(resolveActionLabel('CLOSE', { direction: 'up' }), 'CLOSE')
    })

    it('resolves signal types via resolveAction', () => {
      assert.equal(resolveActionLabel('BUY', null), 'OPEN')
      assert.equal(resolveActionLabel('BUY', true), 'ADD')
      assert.equal(resolveActionLabel('SELL', true), 'CLOSE')
      assert.equal(resolveActionLabel('NEUTRAL', false), 'HOLD')
    })
  })

  describe('labelHistoryActions — chronological ordering and state tracking', () => {
    it('returns empty array for empty input', () => {
      assert.deepEqual(labelHistoryActions([]), [])
      assert.deepEqual(labelHistoryActions(null), [])
    })

    it('labels a single BUY as OPEN (starting flat)', () => {
      const result = labelHistoryActions([{ type: 'BUY', timestamp: 1000 }])
      assert.equal(result[0].action, 'OPEN')
    })

    it('sorts entries by timestamp and maintains original index order in output', () => {
      const result = labelHistoryActions([
        { id: 'a', type: 'BUY', timestamp: 3000 },
        { id: 'b', type: 'SELL', timestamp: 1000 },
        { id: 'c', type: 'BUY', timestamp: 2000 },
      ])
      // Processing order (sorted by timestamp): SELL(1000) → BUY(2000) → BUY(3000)
      // result[0] = entry at original index 0 (t=3000, type BUY) → processed third when long → ADD
      // result[1] = entry at original index 1 (t=1000, type SELL) → processed first when flat → HOLD
      // result[2] = entry at original index 2 (t=2000, type BUY) → processed second when flat → OPEN
      assert.equal(result[0].action, 'ADD')
      assert.equal(result[1].action, 'HOLD')
      assert.equal(result[2].action, 'OPEN')
    })

    it('SELL when flat stays HOLD, then BUY becomes OPEN', () => {
      const result = labelHistoryActions([
        { id: 'sell', type: 'SELL', timestamp: 1000 },
        { id: 'buy', type: 'BUY', timestamp: 2000 },
      ])
      assert.equal(result[0].action, 'HOLD') // SELL when flat
      assert.equal(result[1].action, 'OPEN') // BUY when flat
    })

    it('tracks position state: BUY opens, next BUY adds, SELL closes', () => {
      const result = labelHistoryActions([
        { id: 1, type: 'BUY', timestamp: 1000 },
        { id: 2, type: 'BUY', timestamp: 2000 },
        { id: 3, type: 'SELL', timestamp: 3000 },
        { id: 4, type: 'BUY', timestamp: 4000 },
      ])
      assert.equal(result[0].action, 'OPEN') // first BUY
      assert.equal(result[1].action, 'ADD') // second BUY while long
      assert.equal(result[2].action, 'CLOSE') // SELL while long
      assert.equal(result[3].action, 'OPEN') // BUY when flat again
    })

    it('does not mutate original entries', () => {
      const original = { type: 'BUY', timestamp: 1000 }
      const result = labelHistoryActions([original])
      assert.equal(result[0].type, 'BUY')
      assert.equal(result[0].action, 'OPEN')
      assert.equal(original.action, undefined)
    })

    it('infers type from existing action field', () => {
      const result = labelHistoryActions([
        { action: 'OPEN', timestamp: 1000 }, // infers BUY
        { action: 'ADD', timestamp: 2000 }, // infers BUY
        { action: 'CLOSE', timestamp: 3000 }, // infers SELL
        { action: 'HOLD', timestamp: 4000 }, // infers NEUTRAL
      ])
      // After first OPEN (BUY), we're long
      assert.equal(result[0].action, 'OPEN')
      assert.equal(result[1].action, 'ADD')
      // After CLOSE (SELL), we're flat
      assert.equal(result[2].action, 'CLOSE')
      // HOLD (NEUTRAL) when flat stays HOLD
      assert.equal(result[3].action, 'HOLD')
    })

    it('handles missing timestamp by treating as 0 (earliest)', () => {
      const result = labelHistoryActions([
        { id: 'a', type: 'BUY', timestamp: 1000 },
        { id: 'b', type: 'SELL' }, // no timestamp, sorts first
      ])
      // SELL (no ts) processed first when flat → HOLD
      assert.equal(result[1].action, 'HOLD')
      // BUY processed second when flat → OPEN
      assert.equal(result[0].action, 'OPEN')
    })
  })

  describe('constants', () => {
    it('exports BUY_SIDE and SELL_SIDE Sets', () => {
      assert.ok(BUY_SIDE instanceof Set)
      assert.ok(SELL_SIDE instanceof Set)
      assert.equal(BUY_SIDE.has('BUY'), true)
      assert.equal(BUY_SIDE.has('STRONG_BUY'), true)
      assert.equal(SELL_SIDE.has('SELL'), true)
      assert.equal(SELL_SIDE.has('STRONG_SELL'), true)
    })
  })
})
