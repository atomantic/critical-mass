#!/usr/bin/env node
// @ts-check
/**
 * Backfill Scorecard — Historical Signal Engine Replay
 *
 * Replays 1 year of BTC candle data through the signal engine,
 * generating prediction + outcome JSONL files for the analysis dashboard.
 *
 * Usage: node scripts/backfill-scorecard.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--step 5]
 *
 * --from   Start date (default: 30 days after first candle for warmup)
 * --to     End date (default: last candle)
 * --step   Minutes between predictions (default: 5)
 */

const fs = require('fs')
const path = require('path')
const { createCandleAggregator } = require('../src/candle-aggregator')
const { createSignalEngine } = require('../src/updown/signal-engine')
const { computeAdaptiveWeights } = require('../src/updown/scorecard')
const { DATA_DIR } = require('../src/paths')
const COINBASE_DIR = path.join(DATA_DIR, 'coinbase')
const SCORECARD_DIR = path.join(DATA_DIR, 'updown', 'scorecard')

const DIRECTION_THRESHOLD = 10
const EVAL_WINDOWS = [
  { label: '1m', candles5m: 1 },   // ~5m forward
  { label: '5m', candles5m: 1 },   // same (5m resolution)
  { label: '15m', candles5m: 3 },
  { label: '1h', candles5m: 12 },
]
const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum']
const ALL_TFS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d']
const BASE_WEIGHTS = { rsi: 0.25, stochastic: 0.20, macd: 0.20, bollinger: 0.15, vwap: 0.10, momentum: 0.10 }

// File name mapping
const FILE_MAP = {
  '5m': 'btc-price-cache-5min.json',
  '10m': 'btc-price-cache-10min.json',
  '30m': 'btc-price-cache-30min.json',
  '1h': 'btc-price-cache-1hour.json',
  '4h': 'btc-price-cache-4hour.json',
  '1d': 'btc-price-cache-daily.json',
}

// TF interval in ms
const TF_INTERVAL = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '10m': 600_000,
  '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
  '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
}

const getDirection = (score) => {
  if (score > DIRECTION_THRESHOLD) return 'up'
  if (score < -DIRECTION_THRESHOLD) return 'down'
  return 'neutral'
}

const evaluateDirection = (direction, priceChangeBps) => {
  if (direction === 'neutral') return null
  if (direction === 'up') return priceChangeBps > 0
  return priceChangeBps < 0
}

/**
 * Load candle data from a cache file
 * @returns {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>}
 */
const loadCandles = (filename) => {
  const filepath = path.join(COINBASE_DIR, filename)
  if (!fs.existsSync(filepath)) return []
  const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'))
  return (data.prices || []).map(p => ({
    open: p.open,
    high: p.high || p.highOfDay || p.open,
    low: p.low || p.lowOfDay || p.open,
    close: p.close,
    volume: p.volume || 0,
    timestamp: p.timestamp,
  }))
}

/**
 * Binary search: find index of first candle with timestamp >= target
 */
const findCandleIndex = (candles, targetTs) => {
  let lo = 0, hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (candles[mid].timestamp < targetTs) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Parse CLI args
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def
}

const main = () => {
  console.log('📊 Backfill Scorecard — Loading candle data...')

  // Load all timeframe data
  const allCandles = {}
  for (const [tf, file] of Object.entries(FILE_MAP)) {
    allCandles[tf] = loadCandles(file)
    console.log(`  ${tf}: ${allCandles[tf].length} candles`)
  }

  // We don't have raw 1m/3m/15m/2h files — derive from 5m by processTick
  const candles5m = allCandles['5m']
  if (!candles5m.length) {
    console.error('No 5m candle data found')
    process.exit(1)
  }

  const firstTs = candles5m[0].timestamp
  const lastTs = candles5m[candles5m.length - 1].timestamp

  // Warmup: 30 days to ensure enough data for EMA(200) on 1h (~200h = 8.3 days, +margin)
  const warmupMs = 30 * 86_400_000
  const defaultFromTs = firstTs + warmupMs

  const fromArg = getArg('from', null)
  const toArg = getArg('to', null)
  const stepMin = parseInt(getArg('step', '5'), 10)
  const stepMs = stepMin * 60_000

  const fromTs = fromArg ? new Date(fromArg + 'T00:00:00Z').getTime() : defaultFromTs
  const toTs = toArg ? new Date(toArg + 'T23:59:59Z').getTime() : lastTs

  const fromDate = new Date(fromTs).toISOString().slice(0, 10)
  const toDate = new Date(toTs).toISOString().slice(0, 10)
  console.log(`  Range: ${fromDate} to ${toDate} (step=${stepMin}m)`)

  // Create aggregator and signal engine
  const aggregator = createCandleAggregator()
  const engine = createSignalEngine(aggregator)

  // Tracking for adaptive weights
  let adaptiveWeights = { ...BASE_WEIGHTS }
  const outcomeBuffer = []
  const WEIGHT_INTERVAL = 50 // recompute weights every N predictions
  let predCounter = 0

  // Output buffers per day
  const dayBuffers = {} // { 'YYYY-MM-DD': [lines] }
  const appendLine = (dateStr, record) => {
    if (!dayBuffers[dateStr]) dayBuffers[dateStr] = []
    dayBuffers[dateStr].push(JSON.stringify(record))
  }

  /**
   * Seed the aggregator with candles up to a given timestamp.
   * For each TF, find all candles with timestamp <= evalTs and take the last N.
   */
  const seedUpTo = (evalTs) => {
    for (const [tf, file] of Object.entries(FILE_MAP)) {
      const candles = allCandles[tf]
      const idx = findCandleIndex(candles, evalTs + 1) // first candle > evalTs
      const window = candles.slice(Math.max(0, idx - 200), idx)
      aggregator.seedCandles(tf, window)
    }

    // Derive missing TFs from existing ones
    // 1m: approximate from 5m (split each 5m into 5 equal 1m candles)
    const candles5 = aggregator.getCandles('5m')
    const synthetic1m = []
    for (const c of candles5) {
      for (let i = 0; i < 5; i++) {
        const frac = i / 5
        const price = c.open + (c.close - c.open) * (frac + 0.2)
        synthetic1m.push({
          open: i === 0 ? c.open : c.open + (c.close - c.open) * frac,
          high: c.open + (c.high - c.open) * Math.min(1, (frac + 0.2) * 1.2),
          low: c.open + (c.low - c.open) * Math.min(1, (frac + 0.2) * 1.2),
          close: price,
          volume: (c.volume || 0) / 5,
          timestamp: c.timestamp + i * 60_000,
        })
      }
    }
    aggregator.seedCandles('1m', synthetic1m.slice(-180))

    // 3m: synthesize from 5m
    const synthetic3m = []
    for (let i = 0; i < candles5.length - 1; i++) {
      const c = candles5[i]
      const ts3m = Math.floor(c.timestamp / 180_000) * 180_000
      if (synthetic3m.length && synthetic3m[synthetic3m.length - 1].timestamp === ts3m) {
        const last = synthetic3m[synthetic3m.length - 1]
        if (c.high > last.high) last.high = c.high
        if (c.low < last.low) last.low = c.low
        last.close = c.close
        last.volume += c.volume || 0
      } else {
        synthetic3m.push({ ...c, timestamp: ts3m })
      }
    }
    aggregator.seedCandles('3m', synthetic3m.slice(-160))

    // 15m: derive from 5m
    const synthetic15m = []
    for (const c of candles5) {
      const ts15m = Math.floor(c.timestamp / 900_000) * 900_000
      if (synthetic15m.length && synthetic15m[synthetic15m.length - 1].timestamp === ts15m) {
        const last = synthetic15m[synthetic15m.length - 1]
        if (c.high > last.high) last.high = c.high
        if (c.low < last.low) last.low = c.low
        last.close = c.close
        last.volume += c.volume || 0
      } else {
        synthetic15m.push({ ...c, timestamp: ts15m })
      }
    }
    aggregator.seedCandles('15m', synthetic15m.slice(-180))

    // 2h: derive from 1h
    const candles1h = aggregator.getCandles('1h')
    const synthetic2h = []
    for (const c of candles1h) {
      const ts2h = Math.floor(c.timestamp / 7_200_000) * 7_200_000
      if (synthetic2h.length && synthetic2h[synthetic2h.length - 1].timestamp === ts2h) {
        const last = synthetic2h[synthetic2h.length - 1]
        if (c.high > last.high) last.high = c.high
        if (c.low < last.low) last.low = c.low
        last.close = c.close
        last.volume += c.volume || 0
      } else {
        synthetic2h.push({ ...c, timestamp: ts2h })
      }
    }
    aggregator.seedCandles('2h', synthetic2h.slice(-100))
  }

  // Find the 5m candle indices for our evaluation range
  const startIdx = findCandleIndex(candles5m, fromTs)
  const endIdx = findCandleIndex(candles5m, toTs + 1)

  // Calculate step in 5m candle indices
  const stepCandles = Math.max(1, Math.round(stepMs / 300_000))

  const totalSteps = Math.floor((endIdx - startIdx) / stepCandles)
  console.log(`  Evaluating ${totalSteps} prediction points...`)
  let processed = 0
  let directional = 0
  let lastPct = 0

  for (let i = startIdx; i < endIdx; i += stepCandles) {
    const candle = candles5m[i]
    const evalTs = candle.timestamp
    const price = candle.close
    const dateStr = new Date(evalTs).toISOString().slice(0, 10)
    const ts = new Date(evalTs).toISOString()

    // Seed aggregator with data up to this point
    seedUpTo(evalTs)

    // Compute signal
    const result = engine.computeSignals(null, null)
    const compositeDirection = getDirection(result.score)
    predCounter++

    const predId = `backfill_${evalTs}_${predCounter}`

    // Build timeframe data
    const timeframes = {}
    for (const tf of ALL_TFS) {
      const tfData = result.timeframes?.[tf]
      if (!tfData) continue
      timeframes[tf] = {
        score: tfData.score ?? 0,
        scores: tfData.scores ?? {},
      }
    }

    // Write prediction
    const prediction = {
      type: 'prediction',
      id: predId,
      ts,
      price,
      compositeScore: result.score,
      compositeDirection,
      signalType: result.type,
      confidence: result.confidence,
      trigger: 'backfill',
      timeframes,
    }
    appendLine(dateStr, prediction)

    // Skip outcome evaluation for neutral predictions
    if (compositeDirection === 'neutral') {
      processed++
      continue
    }

    directional++

    // Evaluate outcomes at each window by looking at future candles
    for (const w of EVAL_WINDOWS) {
      const futureIdx = i + w.candles5m
      if (futureIdx >= candles5m.length) continue

      const exitPrice = candles5m[futureIdx].close
      const priceChangeBps = ((exitPrice - price) / price) * 10000
      const compositeCorrect = evaluateDirection(compositeDirection, priceChangeBps)

      // Per-timeframe evaluation
      const tfResults = {}
      for (const tf of ALL_TFS) {
        const tfData = timeframes[tf]
        if (!tfData) continue
        const direction = getDirection(tfData.score)
        tfResults[tf] = {
          direction,
          correct: evaluateDirection(direction, priceChangeBps),
        }
      }

      // Per-indicator evaluation
      const indicatorResults = {}
      for (const ind of INDICATORS) {
        let preds = 0, correct = 0
        for (const tf of ALL_TFS) {
          const indScore = timeframes[tf]?.scores?.[ind]
          if (indScore == null) continue
          const direction = getDirection(indScore)
          if (direction === 'neutral') continue
          preds++
          if (evaluateDirection(direction, priceChangeBps)) correct++
        }
        indicatorResults[ind] = {
          predictions: preds,
          correct,
          accuracy: preds > 0 ? correct / preds : null,
        }
      }

      // Determine outcome date for file placement
      const outcomeTs = new Date(candles5m[futureIdx].timestamp).toISOString()
      const outcomeDateStr = outcomeTs.slice(0, 10)

      const outcome = {
        type: 'outcome',
        predictionId: predId,
        ts: outcomeTs,
        window: w.label,
        entryPrice: price,
        exitPrice,
        priceChangeBps: Math.round(priceChangeBps * 100) / 100,
        compositeDirection,
        compositeCorrect,
        tfResults,
        indicatorResults,
      }
      appendLine(dateStr, outcome)

      // Track for adaptive weights
      if (compositeCorrect != null) {
        outcomeBuffer.push(outcome)
        if (outcomeBuffer.length > 500) {
          outcomeBuffer.splice(0, outcomeBuffer.length - 500)
        }
      }
    }

    // Periodically compute and log adaptive weights
    if (directional % WEIGHT_INTERVAL === 0 && outcomeBuffer.length > 50) {
      const byIndicator = {}
      for (const ind of INDICATORS) {
        let total = 0, correct = 0
        for (const o of outcomeBuffer) {
          const r = o.indicatorResults?.[ind]
          if (!r || r.predictions === 0) continue
          total += r.predictions
          correct += r.correct
        }
        byIndicator[ind] = {
          accuracy: total > 0 ? Math.round(correct / total * 10000) / 100 : null,
          predictions: total,
        }
      }
      adaptiveWeights = computeAdaptiveWeights(byIndicator, BASE_WEIGHTS, adaptiveWeights)
      engine.setIndicatorWeights(adaptiveWeights)

      appendLine(dateStr, {
        type: 'weights',
        ts,
        weights: { ...adaptiveWeights },
        byIndicator: { ...byIndicator },
      })
    }

    processed++
    const pct = Math.floor(processed / totalSteps * 100)
    if (pct > lastPct && pct % 5 === 0) {
      lastPct = pct
      process.stdout.write(`  ${pct}%`)
      if (pct % 25 === 0) process.stdout.write('\n')
    }
  }
  console.log('')

  // Write output files
  if (!fs.existsSync(SCORECARD_DIR)) {
    fs.mkdirSync(SCORECARD_DIR, { recursive: true })
  }

  let totalLines = 0
  const days = Object.keys(dayBuffers).sort()
  for (const day of days) {
    const filePath = path.join(SCORECARD_DIR, `${day}.jsonl`)
    // Prepend to existing file (backfill data comes before live data)
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const backfillContent = dayBuffers[day].join('\n') + '\n'
    fs.writeFileSync(filePath, backfillContent + existing)
    totalLines += dayBuffers[day].length
  }

  console.log(`\n✅ Backfill complete:`)
  console.log(`   ${processed} predictions (${directional} directional, ${processed - directional} neutral)`)
  console.log(`   ${totalLines} total JSONL records across ${days.length} days`)
  console.log(`   ${days[0]} to ${days[days.length - 1]}`)
  console.log(`   Output: ${SCORECARD_DIR}/`)
}

main()
