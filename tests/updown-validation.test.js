const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateCandles, aggregateComplete, generateDecisions, evaluatePolicy, walkForward } = require('../src/updown/validation')
const { createSignalEngine } = require('../src/updown/signal-engine')
const { createPerpBook } = require('../src/updown/perp-book')
const candles = (n) => Array.from({ length: n }, (_, i) => ({ timestamp: i * 60000,
  open: 100, high: 110, low: 90, close: 100, volume: 1 }))

test('rejects gaps, duplicates, unsorted, malformed and misaligned market data', () => {
  for (const mutate of [c => c.splice(1, 1), c => c[1] = c[0], c => c.reverse(),
    c => c[1].close = NaN, c => c[1].low = 101, c => c[1].volume = -1, c => c[1].timestamp++]) {
    const c = candles(4); mutate(c)
    assert.throws(() => validateCandles(c), /candle/)
  }
})
test('aggregation excludes partial boundaries', () => {
  assert.deepEqual(aggregateComplete(candles(9).slice(1, 8), 180000).map(c => c.timestamp), [180000])
})
test('invalid close preserves lots, side and accounting for a valid retry', () => {
  for (const price of [NaN, Infinity, 0, -1, undefined]) {
    const book = createPerpBook()
    book.applySignal('BUY', 100000, 1)
    const before = book.serialize()
    assert.equal(book.applySignal('SELL', price, 2).fill, null)
    assert.deepEqual(book.serialize(), before)
    assert.equal(book.applySignal('SELL', 101000, 3).trade.pnl, 10)
  }
})
test('injected clocks are isolated and expired contracts stay in no-trade zone', () => {
  const a = createSignalEngine({ getCandles: () => [] }, { now: () => 1000 })
  const b = createSignalEngine({ getCandles: () => [] }, { now: () => 2000 })
  const clock = Date.now
  assert.equal(a.computeSignals(1000).noTradeZone, true)
  assert.equal(a.computeSignals(999).type, 'NO_TRADE_ZONE')
  assert.equal(b.computeSignals(1000).noTradeZone, true)
  assert.equal(a.computeSignals().noTradeZone, false)
  assert.equal(a.computeSignals().timestamp, 1000)
  assert.equal(b.computeSignals().timestamp, 2000)
  assert.equal(Date.now, clock)
})
test('fills next open, charges both sides, deduplicates buys and marks terminal costs', () => {
  const c = candles(4)
  c[0].close = 90
  c[1].open = 100
  c[2].open = 110
  c[2].close = 110
  const d = c.map((v, i) => ({ timestamp: v.timestamp + 60000, type: i < 2 ? 'BUY' : 'SELL', score: 40 }))
  const result = evaluatePolicy(c, d, 1, 3, { feePerContract: 0.1, slippageBps: 10 })
  // Entry 100.10, terminal exit 109.89, 0.01 BTC, rounded gross 0.10 minus 0.20 fees.
  assert.ok(Math.abs(result.netPnlUsd + 0.1) < 1e-8)
  assert.equal(result.feesUsd, 0.2)
  assert.equal(result.trades, 1)
  assert.equal(result.maxContracts, 1)
  assert.ok(result.maxDrawdownUsd >= 0.1)
  assert.throws(() => evaluatePolicy(c, d, 0, 3, { feePerContract: 0, slippageBps: 0 }))
})
test('future candles cannot change past decisions or training selection', () => {
  const c = candles(36)
  const before = generateDecisions(c)
  const changed = c.map(v => ({ ...v }))
  for (let i = 26; i < changed.length; i++) changed[i] = { ...changed[i], open: 200, close: 200, high: 210, low: 190 }
  assert.deepEqual(generateDecisions(changed).slice(0, 26), before.slice(0, 26))
  const options = { warmup: 6, folds: 2, feePerContract: 0.1, slippageBps: 1 }
  const first = walkForward(c, options), second = walkForward(changed, options)
  assert.deepEqual(first.folds[1].training, second.folds[1].training)
  assert.equal(first.folds[1].selectedMinScore, second.folds[1].selectedMinScore)
  assert.equal(first.folds[0].baseline.trades, 0)
  assert.equal(first.folds[0].baseline.winRate, null)
})

test('direction evaluation uses disjoint windows and matched baseline samples', () => {
  const { scoreDirections } = require('../src/updown/validation')
  const c = candles(7)
  c[2].close = 105; c[4].close = 95
  const d = c.map(v => ({ timestamp: v.timestamp + 60000, type: 'BUY', score: 40 }))
  d[2].type = 'SELL'
  const score = scoreDirections(c, d, 1, 7, 2)
  assert.equal(score.samples, 3)
  assert.equal(score.directional, 2)
  assert.equal(score.ties, 1)
  assert.equal(score.accuracy, 1)
  assert.equal(score.alwaysUpAccuracyOnSameSamples, 0.5)
})


test('legacy baseline reports dollar drawdown and does not evaluate warmup-only data', () => {
  const { runSimulation, computeStats } = require('../scripts/backtest-updown')
  const c = candles(3)
  const result = runSimulation(c, { '1m': c }, { evalStartMs: 999999 })
  assert.equal(result.diagnostics.totalSteps, 0)
  assert.equal(result.trades.length, 0)
  const stats = computeStats([], 0, 12.34)
  assert.equal(stats.maxDrawdownUsd, 12.34)
  assert.equal(stats.maxDrawdownPct, undefined)
})
