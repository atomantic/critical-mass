// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { verdictOf, summarize, replaySignals, priceAt } = require('../src/updown/pnl-monitor')

describe('pnl-monitor verdict', () => {
  it('is NO_FILLS when the book never opened', () => {
    assert.equal(verdictOf({ contracts: 0, rounds: 0, totalPnl: 0 }), 'NO_FILLS')
    assert.equal(verdictOf(null), 'NO_FILLS')
  })

  it('is PROFITABLE / UNDERWATER / FLAT from totalPnl once a cycle exists', () => {
    assert.equal(verdictOf({ contracts: 1, rounds: 0, totalPnl: 12 }), 'PROFITABLE')
    assert.equal(verdictOf({ contracts: 0, rounds: 1, totalPnl: -5 }), 'UNDERWATER')
    assert.equal(verdictOf({ contracts: 1, rounds: 0, totalPnl: 0 }), 'FLAT')
  })
})

describe('replaySignals paper-trades Open/Add then marks to market', () => {
  it('closes on a faded BUY, reopens, and reports PROFITABLE at a higher mark', () => {
    const { book, fills } = replaySignals([
      { type: 'BUY', timestamp: 100, price: 100_000 },
      { type: 'NEUTRAL', timestamp: 200, price: 101_000 },
      { type: 'BUY', timestamp: 300, price: 102_000 },
    ])
    assert.deepEqual(fills.map(f => f.action), ['OPEN', 'CLOSE', 'OPEN'])
    assert.equal(book.contracts(), 1)
    const snap = summarize(book.snapshot(110_000), { mark: 110_000, lastAction: 'OPEN' })
    assert.equal(snap.verdict, 'PROFITABLE')
    assert.equal(snap.realizedPnl, 10)
    assert.equal(snap.unrealizedPnl, 80)
    assert.equal(snap.contracts, 1)
  })

  it('looks up missing prices from a sorted index', () => {
    const index = [{ t: 100, p: 100_000 }, { t: 400, p: 80_000 }]
    const { book, fills } = replaySignals(
      [
        { type: 'BUY', timestamp: 100 },
        { type: 'SELL', timestamp: 400 },
      ],
      (ts) => priceAt(index, ts),
    )
    assert.equal(fills[0].action, 'OPEN')
    assert.equal(fills[0].price, 100_000)
    assert.equal(fills[1].action, 'CLOSE')
    assert.equal(book.snapshot().realizedPnl, -200)
    assert.equal(verdictOf(book.snapshot()), 'UNDERWATER')
  })
})
