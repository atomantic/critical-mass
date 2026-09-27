#!/usr/bin/env node
// @ts-check
/**
 * Backfill Scorecard — Historical Signal Engine Replay
 *
 * Replays 1 year of BTC candle data through the signal engine,
 * generating prediction + outcome JSONL files for the analysis dashboard.
 *
 * Usage: node scripts/backfill-scorecard.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--step 5] [--apply]
 *
 * --from   Start date (default: 30 days after first candle for warmup)
 * --to     End date (default: last candle)
 * --apply  Explicitly publish results (default: dry run; no writes)
 * --step   Minutes between predictions (default: 5)
 */

const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { acquireScorecardLock, atomicPublish, validateJsonl, lockPath } = require('../src/updown/scorecard-maintenance')
const { createCandleAggregator } = require('../src/candle-aggregator')
const { createSignalEngine, ALL_SIGNAL_TFS } = require('../src/updown/signal-engine')
const { TF_MS, seedCompletedCandles } = require('../src/updown/replay-candles')
const { computeAdaptiveWeights, buildOutcomeRecord, scorecardDirection } = require('../src/updown/scorecard')
const { INDICATORS, INDICATOR_WEIGHTS } = require('../src/updown/indicator-config')
const { DATA_DIR } = require('../src/paths')
const COINBASE_DIR = path.join(DATA_DIR, 'coinbase')
const SCORECARD_DIR = path.join(DATA_DIR, 'updown', 'scorecard')

// No 1m candle file (FILE_MAP is 5m+). Scoring a "1m" window against the next
// 5m close with the 1m noise floor (5 bps) overstates 1m accuracy — drop it
// rather than mislabel. Live scorecard still journals real 1m ticks.
const EVAL_WINDOWS = [
  { label: '5m', candles5m: 1, windowMs: 300_000 },
  { label: '15m', candles5m: 3, windowMs: 900_000 },
  { label: '1h', candles5m: 12, windowMs: 3_600_000 },
]
const ALL_TFS = ALL_SIGNAL_TFS
const BASE_WEIGHTS = INDICATOR_WEIGHTS

// File name mapping
const FILE_MAP = {
  '5m': 'btc-price-cache-5min.json',
  '10m': 'btc-price-cache-10min.json',
  '30m': 'btc-price-cache-30min.json',
  '1h': 'btc-price-cache-1hour.json',
  '4h': 'btc-price-cache-4hour.json',
  '1d': 'btc-price-cache-daily.json',
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

const withHistoricalClock = (timestamp, fn) => {
  const originalDateNow = Date.now
  try {
    Date.now = () => timestamp
    return fn()
  } finally {
    Date.now = originalDateNow
  }
}

const scorecardRecordKey = (record) => {
  if (record?.type === 'prediction') {
    return record.trigger === 'backfill'
      ? `prediction:backfill:${record.ts}`
      : (record.id ? `prediction:${record.id}` : null)
  }
  if (record?.type === 'outcome' && record.predictionId && record.window) {
    const match = String(record.predictionId).match(/^backfill_(\d+)/)
    return match
      ? `outcome:backfill:${match[1]}:${record.window}`
      : `outcome:${record.predictionId}:${record.window}`
  }
  if (record?.type === 'weights' && record.ts) return `weights:${record.ts}`
  return null
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

  // Weekly context is part of the live engine. Derive it from daily history
  // once, then expose only completed weekly buckets at each decision time.
  const weekly = new Map()
  for (const candle of allCandles['1d'] || []) {
    const bucket = Math.floor(candle.timestamp / TF_MS['1w']) * TF_MS['1w']
    const existing = weekly.get(bucket)
    if (existing) {
      existing.high = Math.max(existing.high, candle.high)
      existing.low = Math.min(existing.low, candle.low)
      existing.close = candle.close
      existing.volume += candle.volume || 0
    } else {
      weekly.set(bucket, { ...candle, timestamp: bucket })
    }
  }
  allCandles['1w'] = [...weekly.values()].sort((a, b) => a.timestamp - b.timestamp)

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

  // Output buffers per day
  const dayBuffers = {} // { 'YYYY-MM-DD': [lines] }
  const appendLine = (dateStr, record) => {
    if (!dayBuffers[dateStr]) dayBuffers[dateStr] = []
    dayBuffers[dateStr].push(JSON.stringify(record))
  }

  const computeSignalsAt = (decisionTs) => {
    return withHistoricalClock(decisionTs, () => engine.computeSignals(null, null))
  }

  /**
   * Seed the aggregator with candles up to a given timestamp.
   * A candle timestamp is its bucket start. Only candles whose bucket END is
   * at or before evalTs are visible, matching the live aggregator.
   */
  const seedUpTo = (evalTs) => {
    seedCompletedCandles(aggregator, allCandles, evalTs, [...Object.keys(FILE_MAP), '1w'])

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
    const evalTs = candle.timestamp + TF_MS['5m']
    const price = candle.close
    const dateStr = new Date(evalTs).toISOString().slice(0, 10)
    const ts = new Date(evalTs).toISOString()

    // Seed aggregator with data up to this point
    seedUpTo(evalTs)

    // Compute signal
    const result = computeSignalsAt(evalTs)
    const compositeDirection = scorecardDirection(result)
    const predId = `backfill_${evalTs}`

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

    // UP-only: skip outcome evaluation for NEUTRAL and DOWN
    if (compositeDirection !== 'up') {
      processed++
      continue
    }

    directional++

    // Evaluate outcomes at each window by looking at future candles
    for (const w of EVAL_WINDOWS) {
      const futureIdx = i + w.candles5m
      if (futureIdx >= candles5m.length) continue

      const exitPrice = candles5m[futureIdx].close
      const outcome = buildOutcomeRecord(prediction, w.windowMs, exitPrice, {
        ts: new Date(candles5m[futureIdx].timestamp + TF_MS['5m']).toISOString(),
      })
      outcome.backfilled = true
      appendLine(dateStr, outcome)

      if (outcome.compositeCorrect != null) {
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

  const { totalLines, days, manifestPath } = publishBackfill(dayBuffers, {
    apply: args.includes('--apply'),
  })
  console.log(`   Mode: ${args.includes('--apply') ? 'apply' : 'dry run (no writes)'}`)
  console.log(`   Lock: ${lockPath(SCORECARD_DIR)}`)
  console.log(`   Resume manifest: ${manifestPath}`)

  console.log(`\n✅ Backfill complete:`)
  console.log(`   ${processed} predictions (${directional} directional, ${processed - directional} neutral)`)
  console.log(`   ${totalLines} total JSONL records across ${days.length} days`)
  console.log(`   ${days[0]} to ${days[days.length - 1]}`)
  console.log(`   Output: ${SCORECARD_DIR}/`)
}

/** Publish only under the same exclusive lock used by live appends. */
const publishBackfill = (dayBuffers, { directory = SCORECARD_DIR, apply = false } = {}) => {
  const days = Object.keys(dayBuffers).sort()
  if (days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day))) throw new Error('Invalid scorecard day')
  const fingerprint = createHash('sha256').update(JSON.stringify(days.map(day => [day, dayBuffers[day]]))).digest('hex')
  const manifestPath = path.join(directory, `.backfill-${fingerprint}.manifest.json`)
  const release = apply ? acquireScorecardLock(directory) : null
  if (apply && !release) throw new Error(`Scorecard maintenance lock is busy: ${lockPath(directory)}`)
  try {
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : { version: 1, fingerprint, completedDays: [] }
    if (manifest.version !== 1 || manifest.fingerprint !== fingerprint || !Array.isArray(manifest.completedDays)
      || manifest.completedDays.some(day => !days.includes(day))) throw new Error('Invalid backfill manifest')
    let totalLines = 0
    for (const day of days) {
      const file = path.join(directory, `${day}.jsonl`)
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      validateJsonl(existing)
      const existingKeys = new Set(existing.split('\n').filter(line => line.trim()).map(line => scorecardRecordKey(JSON.parse(line))).filter(Boolean))
      const fresh = []
      for (const line of dayBuffers[day]) {
        validateJsonl(line)
        const key = scorecardRecordKey(JSON.parse(line))
        if (!key) throw new Error('Backfill record has no deduplication key')
        if (existingKeys.has(key)) continue
        existingKeys.add(key)
        fresh.push(line)
      }
      if (manifest.completedDays.includes(day)) {
        if (fresh.length) throw new Error(`Completed backfill day is missing records: ${day}`)
        continue
      }
      totalLines += fresh.length
      if (!apply) continue
      if (fresh.length) {
        const backup = path.join(directory, `.backfill-${fingerprint}-${day}.backup`)
        if (!fs.existsSync(backup)) atomicPublish(backup, existing, validateJsonl)
        const content = fresh.join('\n') + '\n' + existing
        atomicPublish(file, content.endsWith('\n') ? content : content + '\n', validateJsonl)
      }
      manifest.completedDays.push(day)
      atomicPublish(manifestPath, JSON.stringify(manifest, null, 2) + '\n', JSON.parse)
    }
    return { totalLines, days, manifestPath }
  } finally {
    release?.()
  }
}

if (require.main === module) main()

module.exports = { findCandleIndex, scorecardRecordKey, withHistoricalClock, publishBackfill }
