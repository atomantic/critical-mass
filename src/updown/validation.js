// @ts-check
// Offline baseline validation. No adapters, credentials, network or state writes.
const { createCandleAggregator } = require('../candle-aggregator')
const { createSignalEngine, ALL_SIGNAL_TFS } = require('./signal-engine')
const { TF_MS, seedCompletedCandles } = require('./replay-candles')
const { createPerpBook } = require('./perp-book')
const { isBuyType } = require('./signal-actions')
const { PERP_CONTRACT_SIZE_BTC: SIZE } = require('./perp-contract')

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) throw new Error('At least two candles required')
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (!c || !Number.isSafeInteger(c.timestamp) || c.timestamp % TF_MS['1m'] !== 0
      || !['open', 'high', 'low', 'close'].every(k => Number.isFinite(c[k]) && c[k] > 0)
      || !Number.isFinite(c.volume) || c.volume < 0
      || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)
      || (i && c.timestamp - candles[i - 1].timestamp !== TF_MS['1m'])) {
      throw new Error(`Invalid, duplicate, unordered or missing 1m candle at index ${i}`)
    }
  }
}

// Discard partial leading/trailing buckets; continuity was checked at input.
function aggregateComplete(candles, interval) {
  const result = []
  let bucket = null
  let count = 0
  for (const c of candles) {
    const timestamp = Math.floor(c.timestamp / interval) * interval
    if (!bucket || timestamp !== bucket.timestamp) {
      if (bucket && count === interval / TF_MS['1m']) result.push(bucket)
      bucket = { ...c, timestamp }
      count = 1
    } else {
      bucket.high = Math.max(bucket.high, c.high)
      bucket.low = Math.min(bucket.low, c.low)
      bucket.close = c.close
      bucket.volume += c.volume
      count++
    }
  }
  if (bucket && count === interval / TF_MS['1m']) result.push(bucket)
  return result
}

function generateDecisions(candles) {
  validateCandles(candles)
  const tf = Object.fromEntries(ALL_SIGNAL_TFS.map(t => [t, aggregateComplete(candles, TF_MS[t])]))
  const aggregator = createCandleAggregator()
  let now = 0
  const engine = createSignalEngine(aggregator, { now: () => now })
  return candles.map(c => {
    now = c.timestamp + TF_MS['1m']
    seedCompletedCandles(aggregator, tf, now, ALL_SIGNAL_TFS)
    const signal = engine.computeSignals()
    return { timestamp: now, type: signal.type, score: signal.score }
  })
}

// Fixed one-contract long/flat policies; same-side signals are deduplicated by
// the production paper book. A signal from candle i fills at candle i+1 OPEN.
function evaluatePolicy(candles, decisions, start, end, options) {
  const { feePerContract, slippageBps, minScore = 0, buyAndHold = false } = options
  if (![feePerContract, slippageBps, minScore].every(n => Number.isFinite(n) && n >= 0)
    || slippageBps >= 10000 || !Number.isInteger(start) || start < 1
    || !Number.isInteger(end) || end > candles.length || end <= start) throw new Error('Invalid evaluation options')
  const book = createPerpBook()
  let costs = 0, peak = 0, drawdown = 0, maxContracts = 0, exposureMinutes = 0
  const netTrades = []
  let entryCosts = 0
  function fill(type, price, timestamp) {
    const execution = price * (1 + (isBuyType(type) ? 1 : -1) * slippageBps / 10000)
    const result = book.applySignal(type, execution, timestamp)
    if (!result.fill) return
    const fee = result.fill.contracts * feePerContract
    costs += fee
    if (result.trade) {
      netTrades.push(result.trade.pnl - entryCosts - fee)
      entryCosts = 0
    } else entryCosts += fee
  }
  function mark(price) {
    const net = book.snapshot(price).totalPnl - costs
    peak = Math.max(peak, net)
    drawdown = Math.max(drawdown, peak - net)
    return net
  }
  for (let i = start; i < end; i++) {
    const c = candles[i], d = decisions[i - 1]
    if (!d || d.timestamp !== c.timestamp || !Number.isFinite(d.score)) throw new Error('Noncausal or invalid decision')
    const type = buyAndHold ? 'BUY' : isBuyType(d.type) && d.score < minScore ? 'NEUTRAL' : d.type
    fill(type, c.open, c.timestamp)
    maxContracts = Math.max(maxContracts, book.contracts())
    if (book.isLong()) exposureMinutes++
    mark(c.close)
  }
  const last = candles[end - 1]
  fill('SELL', last.close, last.timestamp + TF_MS['1m'])
  const netPnlUsd = mark(last.close)
  const gains = netTrades.filter(n => n > 0).reduce((a, b) => a + b, 0)
  const losses = -netTrades.filter(n => n < 0).reduce((a, b) => a + b, 0)
  return { netPnlUsd, feesUsd: costs, maxDrawdownUsd: drawdown, trades: netTrades.length,
    winRate: netTrades.length ? netTrades.filter(n => n > 0).length / netTrades.length : null,
    profitFactor: losses ? gains / losses : null, maxContracts, exposureMinutes,
    contractSizeBtc: SIZE }
}

// Non-overlapping 15-minute targets avoid counting every minute of the same
// price move as independent evidence. Scores are heuristic, not probabilities.
function scoreDirections(candles, decisions, start, end, horizon = 15) {
  let samples = 0, directional = 0, correct = 0, alwaysUpCorrect = 0, ties = 0
  for (let i = start; i + horizon <= end; i += horizon) {
    const change = candles[i + horizon - 1].close - candles[i].open
    samples++
    if (change === 0) { ties++; continue }
    const type = decisions[i - 1].type
    const predicted = isBuyType(type) ? 1 : ['SELL', 'STRONG_SELL'].includes(type) ? -1 : 0
    if (!predicted) continue
    directional++
    if (change > 0) alwaysUpCorrect++
    if (Math.sign(change) === predicted) correct++
  }
  return { horizonMinutes: horizon, samples, directional, ties,
    coverage: samples ? directional / samples : null,
    accuracy: directional ? correct / directional : null,
    alwaysUpAccuracyOnSameSamples: directional ? alwaysUpCorrect / directional : null }
}

function walkForward(candles, { warmup = 7 * 1440, folds = 3, feePerContract, slippageBps } = {}) {
  validateCandles(candles)
  if (!Number.isInteger(warmup) || warmup < 1 || !Number.isInteger(folds) || folds < 1
    || candles.length - warmup < (folds + 1) * 2) throw new Error('Insufficient candles or invalid folds/warmup')
  const decisions = generateDecisions(candles)
  const width = Math.floor((candles.length - warmup) / (folds + 1))
  const candidates = [0, 20, 30]
  const costs = { feePerContract, slippageBps }
  const results = []
  for (let fold = 0; fold < folds; fold++) {
    const start = warmup + width * (fold + 1)
    const end = fold === folds - 1 ? candles.length : start + width
    const training = candidates.map(minScore => ({ minScore,
      ...evaluatePolicy(candles, decisions, warmup, start, { ...costs, minScore }) }))
    // Stable ties prefer the unmodified baseline. Test outcomes never select a candidate.
    training.sort((a, b) => b.netPnlUsd - a.netPnlUsd || a.minScore - b.minScore)
    const selectedMinScore = training[0].minScore
    results.push({ start: candles[start].timestamp, end: candles[end - 1].timestamp + TF_MS['1m'],
      selectedMinScore, training,
      direction: scoreDirections(candles, decisions, start, end),
      selected: evaluatePolicy(candles, decisions, start, end, { ...costs, minScore: selectedMinScore }),
      baseline: evaluatePolicy(candles, decisions, start, end, { ...costs, minScore: 0 }),
      buyAndHold: evaluatePolicy(candles, decisions, start, end, { ...costs, buyAndHold: true }),
      cash: { netPnlUsd: 0, maxDrawdownUsd: 0 } })
  }
  return { schemaVersion: 1, assumptions: { ...costs, warmup, folds, candidates,
    execution: 'next-minute open, adverse slippage; terminal close with costs',
    limitations: 'Spot proxy; excludes funding, margin/liquidation, live adaptive weights and tick momentum. Minute-close drawdown. No automatic promotion.' }, folds: results }
}
module.exports = { validateCandles, aggregateComplete, generateDecisions, evaluatePolicy, scoreDirections, walkForward }
