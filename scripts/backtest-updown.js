#!/usr/bin/env node
// @ts-check
/**
 * UpDown Signal Backtest — BTC perpetual longs
 *
 * Replays BTC 1m candle data through the signal engine and paper-trades:
 *   OPEN or ADD → buy one 0.01 BTC perp contract
 *   CLOSE       → flatten the entire book
 *   HOLD        → no fill
 *
 * Usage:
 *   node scripts/backtest-updown.js [--days 30] [--warmup 7] [--no-cache]
 *
 * Options:
 *   --days N      Evaluation period in days (default: 30)
 *   --warmup N    Days of pre-data for indicator warmup (default: 7)
 *   --no-cache    Skip cache, always fetch fresh 1m data
 */

const fs = require('fs')
const path = require('path')
const { getAdapter } = require('../src/adapters')
const { createCandleAggregator } = require('../src/candle-aggregator')
const { createSignalEngine, ALL_SIGNAL_TFS } = require('../src/updown/signal-engine')
const { TF_MS, findLastIndex, seedCompletedCandles } = require('../src/updown/replay-candles')
const { createPerpBook } = require('../src/updown/perp-book')
const { PERP_CONTRACT_SIZE_BTC } = require('../src/updown/perp-contract')
const { getCacheFile } = require('../src/backtest-engine')
const { DATA_DIR } = require('../src/paths')

const coinbase = getAdapter('coinbase')
const COINBASE_DIR = path.join(DATA_DIR, 'coinbase')
const BACKTEST_DIR = path.join(DATA_DIR, 'updown', 'backtest')
const CACHE_FILE = path.join(COINBASE_DIR, 'btc-usdc-price-cache-1min.json')

const seedUpTo = (aggregator, tfCandles, evalTs) =>
  seedCompletedCandles(aggregator, tfCandles, evalTs, ALL_SIGNAL_TFS)

// ─── CLI ─────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def
}
const hasFlag = (name) => args.includes(`--${name}`)

const EVAL_DAYS = parseInt(getArg('days', '30'), 10)
const WARMUP_DAYS = parseInt(getArg('warmup', '7'), 10)
const NO_CACHE = hasFlag('no-cache')

// ─── Data Loading ────────────────────────────────────────

/**
 * Load or fetch 1m candles for the given range.
 * Caches to disk; fetches missing ranges in 300-candle batches.
 */
async function loadOrFetch1mCandles(fromMs, toMs) {
  let cached = []
  if (!NO_CACHE && fs.existsSync(CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    cached = data.candles || []
    console.log(`  Cache: ${cached.length} candles loaded`)
  }

  // Determine ranges we need
  const cachedSet = new Set(cached.map(c => c.timestamp))
  const neededFrom = fromMs
  const neededTo = toMs

  // Find contiguous gaps
  let fetchStart = null
  let fetchEnd = null

  if (cached.length === 0) {
    fetchStart = neededFrom
    fetchEnd = neededTo
  } else {
    const minCached = cached[0].timestamp
    const maxCached = cached[cached.length - 1].timestamp
    if (neededFrom < minCached) {
      fetchStart = neededFrom
      fetchEnd = Math.min(minCached - 60_000, neededTo)
    }
    if (neededTo > maxCached + 60_000) {
      if (fetchStart == null) {
        fetchStart = maxCached + 60_000
        fetchEnd = neededTo
      } else {
        // Need both ends — fetch the full range we're missing
        fetchEnd = neededTo
      }
    }
    // If we have coverage, skip
    if (neededFrom >= minCached && neededTo <= maxCached + 60_000) {
      fetchStart = null
    }
  }

  if (fetchStart != null) {
    console.log(`  Fetching 1m candles: ${new Date(fetchStart).toISOString().slice(0, 16)} → ${new Date(fetchEnd).toISOString().slice(0, 16)}`)
    const newCandles = []
    const batchSize = 300
    const batchMs = batchSize * 60_000

    let cursor = fetchStart
    let batchNum = 0
    const totalBatches = Math.ceil((fetchEnd - fetchStart) / batchMs)

    while (cursor < fetchEnd) {
      const batchEnd = Math.min(cursor + batchMs, fetchEnd)
      const startSec = Math.floor(cursor / 1000)
      const endSec = Math.floor(batchEnd / 1000)

      try {
        const batch = await coinbase.getCandles('BTC-USDC', startSec, endSec, 'ONE_MINUTE')
        newCandles.push(...batch)
      } catch (err) {
        console.error(`  Batch error at ${new Date(cursor).toISOString().slice(0, 16)}: ${err.message}`)
      }

      batchNum++
      if (batchNum % 10 === 0 || batchNum === totalBatches) {
        process.stdout.write(`  Fetched ${batchNum}/${totalBatches} batches (${newCandles.length} candles)\n`)
      }

      cursor = batchEnd
      if (cursor < fetchEnd) await new Promise(r => setTimeout(r, 100))
    }

    // Merge with existing cache
    const merged = [...cached]
    for (const c of newCandles) {
      if (!cachedSet.has(c.timestamp)) {
        merged.push(c)
        cachedSet.add(c.timestamp)
      }
    }
    merged.sort((a, b) => a.timestamp - b.timestamp)
    cached = merged

    // Save cache
    if (!fs.existsSync(COINBASE_DIR)) fs.mkdirSync(COINBASE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      lastFetch: new Date().toISOString(),
      count: cached.length,
      candles: cached,
    }))
    console.log(`  Saved ${cached.length} candles to cache`)
  }

  // Filter to requested range
  return cached.filter(c => c.timestamp >= fromMs && c.timestamp <= toMs)
}

/** Return discontinuities in a sorted candle series. */
function findCandleGaps(candles, intervalMs = TF_MS['1m']) {
  const gaps = []
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].timestamp - candles[i - 1].timestamp
    if (delta > intervalMs) {
      gaps.push({ after: candles[i - 1].timestamp, before: candles[i].timestamp, missing: Math.round(delta / intervalMs) - 1 })
    }
  }
  return gaps
}

/**
 * Load candle data from an existing cache file (for daily/weekly).
 */
function loadCandlesFromFile(filepath) {
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
 * Aggregate 1m candles to a higher timeframe.
 * Floors each 1m candle timestamp to the TF boundary, merges OHLCV.
 */
function aggregateToHigherTF(candles1m, intervalMs) {
  const map = new Map()
  for (const c of candles1m) {
    const bucket = Math.floor(c.timestamp / intervalMs) * intervalMs
    const existing = map.get(bucket)
    if (existing) {
      if (c.high > existing.high) existing.high = c.high
      if (c.low < existing.low) existing.low = c.low
      existing.close = c.close
      existing.volume += c.volume || 0
    } else {
      map.set(bucket, {
        timestamp: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Pre-aggregate 1m candles into all 11 timeframes.
 * For 1d: load from daily cache if available, else derive from 1m.
 * For 1w: derive from daily candles.
 */
function preAggregateAll(candles1m) {
  const result = { '1m': candles1m }

  // Derive intermediate TFs from 1m
  const derivedTFs = ['3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h']
  for (const tf of derivedTFs) {
    result[tf] = aggregateToHigherTF(candles1m, TF_MS[tf])
  }

  // Daily: try cache first, fall back to derivation.
  // Use the same path helper that backtest-engine uses to WRITE the cache
  // (btc-usdc-price-cache-daily.json) — a hardcoded 'btc-price-cache-daily.json'
  // here previously never matched, silently disabling daily-SMA features.
  // Accept the cache ONLY when it both has enough history (>30 rows) AND covers
  // the backtest window — i.e. its last daily candle reaches within one day of
  // the 1m data's end. A stale cache (last candle well before the 1m range end)
  // would otherwise freeze 1d/1w signals for the whole run; in that case derive
  // from the freshly-loaded 1m data, which always covers the window.
  const dailyCache = loadCandlesFromFile(getCacheFile('daily', 'coinbase', 'BTC-USDC'))
  const lastTickTs = candles1m.length > 0 ? candles1m[candles1m.length - 1].timestamp : 0
  const cacheLastTs = dailyCache.length > 0 ? dailyCache[dailyCache.length - 1].timestamp : 0
  const cacheCoversWindow = cacheLastTs >= lastTickTs - TF_MS['1d']
  if (dailyCache.length > 30 && cacheCoversWindow) {
    result['1d'] = dailyCache
  } else {
    if (dailyCache.length > 30 && !cacheCoversWindow) {
      console.log(`⚠️  Daily cache is stale (last ${new Date(cacheLastTs).toISOString().slice(0, 10)} vs window end ${new Date(lastTickTs).toISOString().slice(0, 10)}) — deriving daily candles from 1m data instead`)
    }
    result['1d'] = aggregateToHigherTF(candles1m, TF_MS['1d'])
  }

  // Weekly: derive from daily
  const dailyCandles = result['1d']
  const weeklyMap = new Map()
  for (const c of dailyCandles) {
    const bucket = Math.floor(c.timestamp / TF_MS['1w']) * TF_MS['1w']
    const existing = weeklyMap.get(bucket)
    if (existing) {
      if (c.high > existing.high) existing.high = c.high
      if (c.low < existing.low) existing.low = c.low
      existing.close = c.close
      existing.volume += c.volume || 0
    } else {
      weeklyMap.set(bucket, { ...c, timestamp: bucket })
    }
  }
  result['1w'] = Array.from(weeklyMap.values()).sort((a, b) => a.timestamp - b.timestamp)

  return result
}

// ─── Simulation ──────────────────────────────────────────

/**
 * Run the trading simulation stepping through each 1m candle.
 */
function runSimulation(candles1m, tfCandles, config) {
  const { evalStartMs } = config

  // Find the evaluation start index in 1m candles
  let evalStartIdx = candles1m.length
  for (let i = 0; i < candles1m.length; i++) {
    if (candles1m[i].timestamp >= evalStartMs) {
      evalStartIdx = i
      break
    }
  }

  const trades = []
  let equity = 0
  let peakEquity = 0
  let maxDrawdown = 0
  const equityCurve = []
  let lastCurveTs = 0
  const actionCounts = { OPEN: 0, ADD: 0, HOLD: 0, CLOSE: 0 }

  const book = createPerpBook()
  const aggregator = createCandleAggregator()
  const engine = createSignalEngine(aggregator)

  const totalSteps = candles1m.length - evalStartIdx
  let lastPct = 0

  // Score distribution tracking
  const scoreHist = {}  // bucket -> count
  const signalCounts = {}
  let allScores = []
  let positiveScores = 0
  let negativeScores = 0
  const dampenerStats = { trend: 0, weekly: 0, adx: 0, confluence: 0, pivot: 0, tod: 0 }
  let sampledDampeners = 0

  // Patch Date.now for signal engine correctness
  const originalDateNow = Date.now
  const restoreDateNow = () => { Date.now = originalDateNow }

  try {
    for (let i = evalStartIdx; i < candles1m.length; i++) {
      const candle = candles1m[i]
      const ts = candle.timestamp
      const price = candle.close

      // Decision time = the 1m candle's END. In live trading the signal fires
      // on the tick that completes this candle, so its close is known and the
      // candle itself is in the completed buffer — but nothing newer is.
      const decisionTs = ts + TF_MS['1m']

      // Patch Date.now to the decision timestamp
      Date.now = () => decisionTs

      // Seed aggregator with completed candles only (no in-progress buckets)
      seedUpTo(aggregator, tfCandles, decisionTs)

      // Compute signal
      const result = engine.computeSignals(null, null)
      const signal = result.type
      const score = result.score

      // Track score distribution
      const bucket = Math.round(score / 5) * 5
      scoreHist[bucket] = (scoreHist[bucket] || 0) + 1
      signalCounts[signal] = (signalCounts[signal] || 0) + 1
      if (score > 0) positiveScores++
      if (score < 0) negativeScores++

      // Sample every 10 min for detailed stats
      if (i % 10 === 0) {
        allScores.push(score)
        if (result.trendFilter) {
          if (result.trendFilter.trendBias !== 'neutral') dampenerStats.trend++
          if (result.weeklyTrend?.weeklyBias !== 'neutral') dampenerStats.weekly++
          if (result.adxRegime?.regime !== 'neutral') dampenerStats.adx++
          if (result.confluence?.quality !== 'selective') dampenerStats.confluence++
          if (result.pivotPoints?.nearLevel) dampenerStats.pivot++
          if (result.todMultiplier !== 1.0) dampenerStats.tod++
          sampledDampeners++
        }
      }

      const fill = book.applySignal(signal, price, decisionTs)
      if (fill.fill) actionCounts[fill.action] = (actionCounts[fill.action] || 0) + 1
      if (fill.trade) {
        const t = fill.trade
        const bps = t.avgEntry > 0 ? ((t.exitPrice - t.avgEntry) / t.avgEntry) * 10000 : 0
        trades.push({
          entryTs: t.openedAt,
          exitTs: t.closedAt,
          entryPrice: t.avgEntry,
          exitPrice: t.exitPrice,
          entrySignal: 'OPEN',
          exitSignal: 'CLOSE',
          contracts: t.contracts,
          adds: t.adds,
          bps: Math.round(bps * 100) / 100,
          pnl: t.pnl,
          equity: book.snapshot(price).totalPnl,
          holdMs: t.closedAt - t.openedAt,
        })
      }

      const snap = book.snapshot(price)
      equity = snap.totalPnl
      if (equity > peakEquity) peakEquity = equity
      const dd = peakEquity - equity
      if (dd > maxDrawdown) maxDrawdown = dd

      // Sample equity curve every 15 minutes
      if (ts - lastCurveTs >= 900_000) {
        equityCurve.push({ ts, equity: Math.round(equity * 100) / 100, price, contracts: snap.contracts })
        lastCurveTs = ts
      }

      // Progress
      const step = i - evalStartIdx
      const pct = Math.floor(step / totalSteps * 100)
      if (pct > lastPct && pct % 5 === 0) {
        lastPct = pct
        process.stdout.write(`  ${pct}%`)
        if (pct % 25 === 0) process.stdout.write('\n')
      }
    }
  } finally {
    restoreDateNow()
  }

  // Force-close open lots at end of data
  if (book.isLong() && candles1m.length > 0) {
    const lastCandle = candles1m[candles1m.length - 1]
    const force = book.applySignal('SELL', lastCandle.close, lastCandle.timestamp + TF_MS['1m'])
    if (force.trade) {
      const t = force.trade
      const bps = t.avgEntry > 0 ? ((t.exitPrice - t.avgEntry) / t.avgEntry) * 10000 : 0
      trades.push({
        entryTs: t.openedAt,
        exitTs: t.closedAt,
        entryPrice: t.avgEntry,
        exitPrice: t.exitPrice,
        entrySignal: 'OPEN',
        exitSignal: 'FORCE_CLOSE',
        contracts: t.contracts,
        adds: t.adds,
        bps: Math.round(bps * 100) / 100,
        pnl: t.pnl,
        equity: book.snapshot(lastCandle.close).totalPnl,
        holdMs: t.closedAt - t.openedAt,
      })
      equity = book.snapshot(lastCandle.close).totalPnl
      if (equity > peakEquity) peakEquity = equity
      const dd = peakEquity - equity
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  console.log('')
  return {
    trades, equity, peakEquity, maxDrawdown, equityCurve, actionCounts,
    diagnostics: { scoreHist, signalCounts, allScores, positiveScores, negativeScores, dampenerStats, sampledDampeners, totalSteps }
  }
}

// ─── Stats ───────────────────────────────────────────────

function computeStats(trades, finalEquity, maxDrawdown) {
  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)

  const avgWinBps = wins.length > 0
    ? wins.reduce((s, t) => s + t.bps, 0) / wins.length : 0
  const avgLossBps = losses.length > 0
    ? losses.reduce((s, t) => s + t.bps, 0) / losses.length : 0
  const avgWinPnl = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avgLossPnl = losses.length > 0
    ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0

  const totalWin = wins.reduce((s, t) => s + t.pnl, 0)
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0

  const holdTimes = trades.map(t => t.holdMs)
  const avgHold = holdTimes.length > 0 ? holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length : 0
  const minHold = holdTimes.length > 0 ? Math.min(...holdTimes) : 0
  const maxHold = holdTimes.length > 0 ? Math.max(...holdTimes) : 0
  const contracts = trades.reduce((s, t) => s + (t.contracts || 1), 0)

  return {
    totalTrades: trades.length,
    contracts,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgWinBps: Math.round(avgWinBps * 10) / 10,
    avgLossBps: Math.round(avgLossBps * 10) / 10,
    avgWinPnl: Math.round(avgWinPnl * 100) / 100,
    avgLossPnl: Math.round(avgLossPnl * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxDrawdownUsd: Math.round(maxDrawdown * 100) / 100,
    totalPnl: Math.round(finalEquity * 100) / 100,
    avgHoldMs: Math.round(avgHold),
    minHoldMs: minHold,
    maxHoldMs: maxHold,
  }
}

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${(ms / 3_600_000).toFixed(1)} hrs`
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  const now = Date.now()
  const evalEndMs = now
  const evalStartMs = now - EVAL_DAYS * 86_400_000
  const fetchFromMs = evalStartMs - WARMUP_DAYS * 86_400_000

  console.log('=== UpDown Perp Long Backtest ===')
  console.log(`  Period: ${new Date(evalStartMs).toISOString().slice(0, 10)} to ${new Date(evalEndMs).toISOString().slice(0, 10)} (${EVAL_DAYS} days)`)
  console.log(`  Warmup: ${WARMUP_DAYS} days | Size: ${PERP_CONTRACT_SIZE_BTC} BTC per contract`)
  console.log('')

  // 1. Fetch 1m candles
  console.log('Step 1: Loading 1m candle data...')
  const candles1m = await loadOrFetch1mCandles(fetchFromMs, evalEndMs)
  console.log(`  Total 1m candles: ${candles1m.length}`)

  if (candles1m.length < 1000) {
    console.error('Not enough 1m candle data for backtest. Need at least 1000 candles.')
    process.exit(1)
  }
  const gaps = findCandleGaps(candles1m)
  if (gaps.length > 0) {
    const first = gaps[0]
    throw new Error(`1m candle history is discontinuous: ${gaps.length} gaps; first gap after ${new Date(first.after).toISOString()} (${first.missing} candles missing)`)
  }

  // 2. Pre-aggregate to all timeframes
  console.log('\nStep 2: Aggregating to all timeframes...')
  const tfCandles = preAggregateAll(candles1m)
  for (const tf of ALL_SIGNAL_TFS) {
    const count = tfCandles[tf]?.length || 0
    if (count > 0) console.log(`  ${tf}: ${count} candles`)
  }

  // 3. Run simulation
  console.log('\nStep 3: Running simulation...')
  const { trades, equity, maxDrawdown, equityCurve, diagnostics, actionCounts } = runSimulation(
    candles1m, tfCandles, { evalStartMs }
  )

  // 4. Compute stats
  const stats = computeStats(trades, equity, maxDrawdown)

  // 5. Output results
  const evalCandleCount = candles1m.filter(c => c.timestamp >= evalStartMs).length
  console.log('\n=== UpDown Perp Long Backtest Results ===')
  console.log(`  NOTE: ${PERP_CONTRACT_SIZE_BTC} BTC per Open/Add contract, flatten on Close. Zero fees/funding/spread.`)
  console.log('  BASELINE ONLY: excludes live adaptive-weight training and tick-momentum adjustments.')
  console.log(`  Period: ${new Date(evalStartMs).toISOString().slice(0, 10)} to ${new Date(evalEndMs).toISOString().slice(0, 10)} (${EVAL_DAYS} days)`)
  console.log(`  Warmup: ${WARMUP_DAYS} days | Candles: ${evalCandleCount.toLocaleString()}`)
  console.log('')
  console.log('Actions:')
  console.log(`  Open=${actionCounts.OPEN || 0} Add=${actionCounts.ADD || 0} Close=${actionCounts.CLOSE || 0} Hold=${actionCounts.HOLD || 0}`)
  console.log('')
  console.log('Trade Summary:')
  console.log(`  Closed rounds: ${stats.totalTrades} | Contracts filled: ${stats.contracts}`)
  console.log(`  Win rate: ${stats.winRate.toFixed(1)}% (${stats.wins}W / ${stats.losses}L)`)
  console.log(`  Avg win: ${stats.avgWinPnl >= 0 ? '+' : ''}$${stats.avgWinPnl.toFixed(0)} (+${stats.avgWinBps} bps) | Avg loss: $${stats.avgLossPnl.toFixed(0)} (${stats.avgLossBps} bps)`)
  console.log(`  Profit factor: ${stats.profitFactor}`)
  console.log(`  Max drawdown: -$${stats.maxDrawdownUsd}`)
  console.log('')
  console.log('P&L:')
  console.log(`  Realized: $${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}`)
  console.log('')
  console.log('Timing:')
  console.log(`  Avg hold: ${formatDuration(stats.avgHoldMs)} | Longest: ${formatDuration(stats.maxHoldMs)} | Shortest: ${formatDuration(stats.minHoldMs)}`)

  // Diagnostics
  const d = diagnostics
  const sorted = d.allScores.slice().sort((a, b) => a - b)
  const p5 = sorted[Math.floor(sorted.length * 0.05)]
  const p25 = sorted[Math.floor(sorted.length * 0.25)]
  const p50 = sorted[Math.floor(sorted.length * 0.50)]
  const p75 = sorted[Math.floor(sorted.length * 0.75)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  const maxScore = sorted[sorted.length - 1]
  const minScore = sorted[0]
  console.log('')
  console.log('Signal Diagnostics:')
  console.log(`  Signal counts: ${Object.entries(d.signalCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  console.log(`  Score positive: ${d.positiveScores} (${(d.positiveScores / d.totalSteps * 100).toFixed(1)}%) | negative: ${d.negativeScores} (${(d.negativeScores / d.totalSteps * 100).toFixed(1)}%)`)
  console.log(`  Score distribution: min=${minScore.toFixed(1)} p5=${p5.toFixed(1)} p25=${p25.toFixed(1)} median=${p50.toFixed(1)} p75=${p75.toFixed(1)} p95=${p95.toFixed(1)} max=${maxScore.toFixed(1)}`)
  console.log(`  Score histogram (5-pt buckets):`)
  const buckets = Object.keys(d.scoreHist).map(Number).sort((a, b) => a - b)
  const maxCount = Math.max(...Object.values(d.scoreHist))
  for (const b of buckets) {
    const count = d.scoreHist[b]
    const pct = (count / d.totalSteps * 100).toFixed(1)
    const bar = '#'.repeat(Math.round(count / maxCount * 40))
    if (count > d.totalSteps * 0.005) { // only show buckets > 0.5%
      console.log(`    ${String(b).padStart(4)}: ${bar} ${pct}%`)
    }
  }
  if (d.sampledDampeners > 0) {
    console.log(`  Dampener activity (% of samples):`)
    for (const [name, count] of Object.entries(d.dampenerStats)) {
      console.log(`    ${name}: ${(count / d.sampledDampeners * 100).toFixed(1)}%`)
    }
  }

  // 6. Write output files
  if (!fs.existsSync(BACKTEST_DIR)) fs.mkdirSync(BACKTEST_DIR, { recursive: true })

  const dateStr = new Date().toISOString().slice(0, 10)

  // Trade log (JSONL)
  const tradeLogPath = path.join(BACKTEST_DIR, `backtest-${dateStr}.jsonl`)
  const tradeLines = trades.map(t => JSON.stringify({
    ...t,
    entryTime: new Date(t.entryTs).toISOString(),
    exitTime: new Date(t.exitTs).toISOString(),
    holdTime: formatDuration(t.holdMs),
  }))
  fs.writeFileSync(tradeLogPath, tradeLines.join('\n') + '\n')

  // Summary JSON
  const summaryPath = path.join(BACKTEST_DIR, `backtest-summary-${dateStr}.json`)
  fs.writeFileSync(summaryPath, JSON.stringify({
    note: `${PERP_CONTRACT_SIZE_BTC} BTC per Open/Add contract, flatten on Close. Zero fees/funding/spread. Baseline replay only: excludes live adaptive-weight training and tick-momentum adjustments.`,
    strategyMode: 'static-baseline',
    config: {
      evalDays: EVAL_DAYS,
      warmupDays: WARMUP_DAYS,
      contractSizeBtc: PERP_CONTRACT_SIZE_BTC,
      evalStart: new Date(evalStartMs).toISOString(),
      evalEnd: new Date(evalEndMs).toISOString(),
      candleCount: evalCandleCount,
    },
    actionCounts,
    stats,
    equityCurve,
  }, null, 2))

  console.log('')
  console.log(`Output: ${tradeLogPath}`)
  console.log(`Summary: ${summaryPath}`)
}

if (require.main === module) {
  main().catch(err => {
    console.error('Backtest failed:', err.message)
    process.exit(1)
  })
}

module.exports = { seedUpTo, findLastIndex, findCandleGaps, TF_MS, runSimulation, computeStats }
