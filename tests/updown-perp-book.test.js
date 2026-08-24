// @ts-check
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createPerpBook } = require('../src/updown/perp-book')
const { resolveAction, signalSide, isHeldLong } = require('../src/updown/signal-actions')

describe('resolveAction (Open / Add / Hold / Close)', () => {
  it('maps BUY while flat to OPEN and BUY while long to ADD', () => {
    assert.equal(resolveAction('BUY'), 'OPEN')
    assert.equal(resolveAction('STRONG_BUY', null), 'OPEN')
    assert.equal(resolveAction('BUY', { direction: 'up' }), 'ADD')
    assert.equal(resolveAction('STRONG_BUY', { contracts: 2, direction: 'up' }), 'ADD')
    assert.equal(resolveAction('BUY', true), 'ADD')
  })

  it('maps SELL while long to CLOSE and SELL while flat to HOLD (never short)', () => {
    assert.equal(resolveAction('SELL', { direction: 'up' }), 'CLOSE')
    assert.equal(resolveAction('STRONG_SELL', { contracts: 1 }), 'CLOSE')
    assert.equal(resolveAction('SELL', null), 'HOLD')
    assert.equal(resolveAction('STRONG_SELL'), 'HOLD')
    assert.equal(resolveAction('SELL', { direction: 'down' }), 'HOLD')
  })

  it('maps NEUTRAL / NO_TRADE_ZONE to HOLD whether flat or long', () => {
    assert.equal(resolveAction('NEUTRAL'), 'HOLD')
    assert.equal(resolveAction('NO_TRADE_ZONE', { direction: 'up', contracts: 1 }), 'HOLD')
    assert.equal(resolveAction(null), 'HOLD')
  })

  it('treats contracts>0 as held long unless direction is down', () => {
    assert.equal(isHeldLong({ contracts: 1 }), true)
    assert.equal(isHeldLong({ contracts: 0 }), false)
    assert.equal(isHeldLong({ contracts: 1, direction: 'down' }), false)
  })

  it('collapses BUY/STRONG_BUY and SELL/STRONG_SELL to one fill side', () => {
    assert.equal(signalSide('BUY'), 'BUY')
    assert.equal(signalSide('STRONG_BUY'), 'BUY')
    assert.equal(signalSide('SELL'), 'SELL')
    assert.equal(signalSide('NEUTRAL'), 'HOLD')
    assert.equal(signalSide('NO_TRADE_ZONE'), 'HOLD')
  })
})

describe('perp book paper-trades 1 BTC per Open/Add and flattens on Close', () => {
  it('opens 1 BTC on the first BUY, does not pyramid while BUY stays printed', () => {
    const book = createPerpBook()
    const open = book.applySignal('BUY', 100_000, 1)
    assert.equal(open.action, 'OPEN')
    assert.equal(open.fill.contracts, 1)
    assert.equal(book.contracts(), 1)

    const still = book.applySignal('BUY', 101_000, 2)
    assert.equal(still.action, 'ADD')
    assert.equal(still.fill, null, 'continuous BUY does not add another contract')
    assert.equal(book.contracts(), 1)

    const strong = book.applySignal('STRONG_BUY', 102_000, 3)
    assert.equal(strong.fill, null, 'BUY→STRONG_BUY is the same side')
    assert.equal(book.contracts(), 1)
  })

  it('adds 1 BTC when BUY returns after HOLD while still long', () => {
    const book = createPerpBook()
    book.applySignal('BUY', 100_000, 1)
    const hold = book.applySignal('NEUTRAL', 99_000, 2)
    assert.equal(hold.action, 'HOLD')
    assert.equal(hold.fill, null)
    assert.equal(book.contracts(), 1)

    const add = book.applySignal('BUY', 98_000, 3)
    assert.equal(add.action, 'ADD')
    assert.equal(add.fill.contracts, 1)
    assert.equal(book.contracts(), 2)
    assert.equal(book.snapshot().avgEntry, 99_000)
  })

  it('closes the entire book on SELL and records round P&L as Σ(exit − entry)', () => {
    const book = createPerpBook()
    book.applySignal('BUY', 100_000, 1)
    book.applySignal('NEUTRAL', 100_000, 2)
    book.applySignal('BUY', 110_000, 3)

    const close = book.applySignal('SELL', 120_000, 4)
    assert.equal(close.action, 'CLOSE')
    assert.equal(close.fill.contracts, 2)
    // (120k−100k) + (120k−110k) = 30k
    assert.equal(close.trade.pnl, 30_000)
    assert.equal(close.trade.adds, 1)
    assert.equal(book.contracts(), 0)
    assert.equal(book.snapshot().realizedPnl, 30_000)
    assert.equal(book.snapshot().wins, 1)
    assert.equal(book.snapshot().winRate, 100)
  })

  it('does not short: SELL while flat is HOLD with no fill', () => {
    const book = createPerpBook()
    const out = book.applySignal('SELL', 100_000, 1)
    assert.equal(out.action, 'HOLD')
    assert.equal(out.fill, null)
    assert.equal(book.contracts(), 0)
  })

  it('marks open lots to market without realizing', () => {
    const book = createPerpBook()
    book.applySignal('BUY', 100_000, 1)
    const snap = book.snapshot(101_000)
    assert.equal(snap.unrealizedPnl, 1_000)
    assert.equal(snap.realizedPnl, 0)
    assert.equal(snap.totalPnl, 1_000)
    assert.equal(book.contracts(), 1)
  })

  it('counts a losing close as a loss and the next BUY as a fresh OPEN', () => {
    const book = createPerpBook()
    book.applySignal('BUY', 100_000, 1)
    const close = book.applySignal('SELL', 90_000, 2)
    assert.equal(close.trade.pnl, -10_000)
    assert.equal(book.snapshot().losses, 1)
    assert.equal(book.snapshot().winRate, 0)

    const reopen = book.applySignal('BUY', 90_000, 3)
    assert.equal(reopen.action, 'OPEN')
    assert.equal(book.contracts(), 1)
  })

  it('hydrates lots so a restart does not re-open a live long as a new OPEN', () => {
    const book = createPerpBook()
    book.applySignal('BUY', 100_000, 1)
    const saved = book.serialize()

    const restored = createPerpBook(saved)
    assert.equal(restored.contracts(), 1)
    const add = restored.applySignal('NEUTRAL', 100_000, 2)
    assert.equal(add.fill, null)
    const again = restored.applySignal('BUY', 101_000, 3)
    assert.equal(again.action, 'ADD')
    assert.equal(restored.contracts(), 2)
  })

  it('replays journaled OPEN then ADD without an intervening HOLD', () => {
    const book = createPerpBook()
    book.applyFill('OPEN', 100_000, 1)
    book.applyFill('ADD', 110_000, 2)
    assert.equal(book.contracts(), 2)
    assert.equal(book.snapshot().avgEntry, 105_000)
    const close = book.applyFill('CLOSE', 120_000, 3)
    assert.equal(close.trade.pnl, 30_000)
  })

  it('ignores a fill when price is missing so a dead tick cannot open a $0 lot', () => {
    const book = createPerpBook()
    const out = book.applySignal('BUY', NaN, 1)
    assert.equal(out.action, 'OPEN')
    assert.equal(out.fill, null)
    assert.equal(book.contracts(), 0)
    const retry = book.applySignal('BUY', 100_000, 2)
    assert.equal(retry.action, 'OPEN')
    assert.equal(retry.fill.contracts, 1)
  })
})
