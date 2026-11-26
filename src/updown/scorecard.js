const { trackPendingWrite } = require('../pending-writes');
// @ts-check
/**
 * Signal Prediction Scorecard
 *
 * Tracks predictions from the UpDown signal engine, evaluates outcomes
 * after configurable time windows, and computes per-indicator/per-timeframe
 * accuracy metrics for real-time monitoring.
 */

const { readFile, readdir, unlink } = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const { createContextLogger } = require('../logger')
const { UPDOWN_DATA_DIR } = require('../paths')
const { appendScorecardRecord, withScorecardLock } = require('./scorecard-maintenance')
const { INDICATORS, INDICATOR_WEIGHTS } = require('./indicator-config')
const { ALL_SIGNAL_TFS: ALL_TFS } = require('./signal-engine')
const { buyCost, settlementProceeds } = require('./app-order-history')
const {
  getDirection,
  evaluateDirection,
  resolvePerpCorrect,
  dedupeScorecardRecords,
  WINDOW_MS,
} = require('./scorecard-analytics')

/**
 * The scorecard scores the UpDown paper book, which has no exchange or pair of
 * its own, so `module` is the only stable context; prediction/window detail is
 * carried per call.
 */
const scorecardLogger = createContextLogger({ module: 'updown-scorecard' })

const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard')
// Pending-write label of a journal append, which writes only under SCORECARD_DIR.
const JOURNAL_WRITE_LABEL = 'updown-scorecard-journal'
const SAMPLE_INTERVAL_MS = 60_000
const EVAL_WINDOWS = [60_000, 300_000, 900_000, 3_600_000]
const WINDOW_LABELS = { 60000: '1m', 300000: '5m', 900000: '15m', 3600000: '1h' }
/** Tick-to-tick products (CDC Up options, Coinbase perp flips) live on 1m/5m. */
const PRIMARY_WINDOWS = ['1m', '5m']
const BUFFER_SIZE = 2000
/** Live retention: newest N daily journals kept. The backfill script clamps to the same window. */
const SCORECARD_RETENTION_DAYS = 30
const EMIT_THROTTLE_MS = 5_000
const DEDUP_WINDOW_MS = 55_000
const WEIGHT_LOG_THROTTLE_MS = 300_000
const EVAL_RETRY_MS = 5_000
// Retention is housekeeping: skip a busy lock (the daily timer retries) rather
// than hold scorecard startup behind a replay or a stale lock.
const PRUNE_LOCK_WAIT_MS = 5_000
// Hydration reads every recent day file; let an active replay finish publishing
// first, but never wait unboundedly on a lock a killed process left behind.
const HISTORY_LOCK_WAIT_MS = 120_000
const MAX_EVAL_LAG_MS = 60_000

const BASE_WEIGHTS = INDICATOR_WEIGHTS

/**
 * Compute adaptive indicator weights based on recent accuracy
 * @param {Record<string, {accuracy: number|null, predictions: number}>} byIndicator
 * @param {Record<string, number>} baseWeights - Original indicator weights
 * @param {Record<string, number>} prevWeights - Previous adaptive weights
 * @param {number} [alpha=0.15] - Exponential smoothing factor
 * @returns {Record<string, number>} Normalized adaptive weights summing to 1.0
 */
const computeAdaptiveWeights = (byIndicator, baseWeights, prevWeights, alpha = 0.15) => {
  const rawWeights = {}
  for (const ind of INDICATORS) {
    const base = baseWeights[ind] ?? 0.1
    const prev = prevWeights[ind] ?? base
    const data = byIndicator[ind]
    let rawWeight = base

    // Accuracy-based adjustment
    if (data?.accuracy != null && data.predictions >= 10) {
      if (data.accuracy > 55) rawWeight = base * 1.3
      else if (data.accuracy < 45) rawWeight = base * 0.7
    }

    rawWeights[ind] = alpha * rawWeight + (1 - alpha) * prev
  }

  // Floor at 0.03
  for (const ind of INDICATORS) {
    if (rawWeights[ind] < 0.03) rawWeights[ind] = 0.03
  }

  // Normalize to sum to 1.0
  const total = Object.values(rawWeights).reduce((s, v) => s + v, 0)
  const result = {}
  for (const ind of INDICATORS) {
    result[ind] = Math.round((rawWeights[ind] / total) * 10000) / 10000
  }
  return result
}

/** Use only timeframe/window matches, including in older multi-timeframe journal rows. */
const computeTrainingMetrics = (outcomes) => {
  const counts = Object.fromEntries(INDICATORS.map(ind => [ind, { correct: 0, predictions: 0 }]))
  for (const outcome of outcomes) {
    if (!WINDOW_MS[outcome.window]) continue
    for (const ind of INDICATORS) {
      const hit = outcome.indicatorTfResults?.[ind]?.[outcome.window]?.correct
      if (hit == null) continue
      counts[ind].predictions++
      if (hit) counts[ind].correct++
    }
  }
  return Object.fromEntries(INDICATORS.map(ind => {
    const { correct, predictions } = counts[ind]
    return [ind, { predictions, accuracy: predictions ? Math.round(correct / predictions * 10000) / 100 : null }]
  }))
}

let predictionCounter = 0

/**
 * Direction the scorecard journals. A raw +score that never printed BUY is a
 * skip, not an UP call — otherwise GATE CLOSED / HOLD / NO_TRADE_ZONE ticks
 * inflate UP precision with longs we never published. High-vol BUY uses a
 * lowered threshold (12), so the published type is the source of truth, not
 * getDirection's fixed 15.
 * @param {{score?: number, type?: string, source?: string, trendGate?: {open?: boolean}}|null} result
 * @returns {'up' | 'down' | 'neutral'}
 */
const scorecardDirection = (result) => {
  // Flush reversals deliberately publish BUY through a closed composite gate.
  if (result?.source === 'flush-setup' && result.type === 'BUY') return 'up'
  if (result?.trendGate?.open === false) {
    return getDirection(result?.score) === 'down' ? 'down' : 'neutral'
  }
  // Vol-lowered BUY (score 12–15) still printed OPEN/ADD on the banner.
  if (result?.type === 'BUY' || result?.type === 'STRONG_BUY') return 'up'
  if (result?.type) {
    // Any other published type (SELL, NEUTRAL, NO_TRADE_ZONE) is not an UP call.
    const raw = getDirection(result?.score)
    return raw === 'up' ? 'neutral' : raw
  }
  return getDirection(result?.score)
}

/**
 * Get today's JSONL file path
 * @returns {string}
 */
const getJournalPath = () => {
  const dateStr = new Date().toISOString().slice(0, 10)
  return path.join(SCORECARD_DIR, `${dateStr}.jsonl`)
}

/**
 * Append a JSONL record (fire-and-forget)
 * @param {Object} record
 */
const appendRecord = async (record, options) => {
  await appendScorecardRecord(SCORECARD_DIR, getJournalPath(), record, options)
}

/**
 * Build an outcome record for a prediction resolved against an exit price.
 * Pure — no side effects (no persistence, no ring-buffer push, no emit). Shared by
 * live evaluation (exitPrice from the live price feed) and restart backfill
 * (exitPrice from historical JSONL records) so both paths score identically (issue #212E).
 * @param {Object} prediction - Prediction record (live object or JSONL-hydrated)
 * @param {number} windowMs
 * @param {number} exitPrice
 * @param {{ts?: string}} [opts] - Historical backfill must pass the settlement
 *   candle's ISO timestamp. Default `new Date()` is wall-clock now, which
 *   collapses accuracyOverTime into the hour the script ran.
 * @returns {Object} Outcome record
 */
const buildOutcomeRecord = (prediction, windowMs, exitPrice, opts = {}) => {
  const priceChangeBps = ((exitPrice - prediction.price) / prediction.price) * 10000
  // compositeCorrect = options (flat = miss). perpCorrect = scratch on no-move.
  const trainingOnly = prediction.compositeDirection !== 'up'
  const compositeCorrect = trainingOnly ? null : evaluateDirection('up', priceChangeBps, windowMs, 'options')
  const perpCorrect = trainingOnly ? null : evaluateDirection('up', priceChangeBps, windowMs, 'perp')

  // Per-timeframe / per-indicator use perp mode so adaptive weights skip chops
  // instead of treating every no-move as "every indicator was wrong."
  const window = WINDOW_LABELS[windowMs]
  const tfData = prediction.timeframes?.[window]
  const tfResults = {}
  if (tfData) {
    const direction = getDirection(tfData.score)
    tfResults[window] = {
      direction,
      correct: evaluateDirection(direction, priceChangeBps, windowMs, 'perp'),
    }
  }

  const indicatorResults = {}
  const indicatorTfResults = {}
  for (const ind of INDICATORS) {
    const direction = getDirection(tfData?.scores?.[ind])
    const hit = evaluateDirection(direction, priceChangeBps, windowMs, 'perp')
    indicatorTfResults[ind] = direction === 'neutral' ? {} : { [window]: { direction, correct: hit } }
    indicatorResults[ind] = {
      predictions: hit == null ? 0 : 1,
      correct: hit === true ? 1 : 0,
      accuracy: hit == null ? null : Number(hit),
    }
  }

  return {
    type: 'outcome',
    predictionId: prediction.id,
    ts: opts.ts ?? new Date().toISOString(),
    // predictionTs (issue #212D): byHour must bucket by the hour the PREDICTION was
    // made, not the settlement/evaluation hour (`ts` above, up to 1h later) — the
    // time-of-day multiplier in signal-engine.js applies byHour[predictionHour].
    predictionTs: prediction.ts,
    window,
    alignedIndicators: true,
    ...(trainingOnly ? { trainingOnly } : {}),
    entryPrice: prediction.price,
    exitPrice,
    priceChangeBps: Math.round(priceChangeBps * 100) / 100,
    compositeScore: prediction.compositeScore ?? 0,
    compositeDirection: prediction.compositeDirection,
    compositeCorrect,
    perpCorrect,
    tfResults,
    indicatorResults,
    indicatorTfResults,
    // Contract settlement has its own expiry-time record. A fixed 1h outcome
    // is not a valid proxy for a contract that may expire minutes or days later.
    contractOutcome: null,
  }
}

/**
 * Build the single outcome for a bound touch or expiry.
 * @param {Object} prediction
 * @param {number} exitPrice
 * @param {{ts?: string, knockout?: 'target'|'stop'}} [opts]
 * @returns {Object|null}
 */
const buildContractOutcomeRecord = (prediction, exitPrice, opts = {}) => {
  const expiry = Number(prediction.contract?.expiry)
  const predictionTs = Date.parse(prediction.ts)
  const settlementTs = Date.parse(opts.ts ?? new Date().toISOString())
  if (!Number.isFinite(expiry) || !Number.isFinite(predictionTs) ||
      expiry <= predictionTs || !Number.isFinite(settlementTs) ||
      (opts.knockout ? settlementTs <= predictionTs || settlementTs >= expiry
        || contractTouch(prediction.contract, exitPrice) !== opts.knockout
        : settlementTs < expiry)) {
    return null
  }
  const contractOutcome = evaluateContractOutcome(prediction.contract, exitPrice, prediction.price)
  if (contractOutcome == null) return null
  return {
    type: 'outcome',
    predictionId: prediction.id,
    ts: opts.ts ?? new Date().toISOString(),
    predictionTs: prediction.ts,
    window: 'contract',
    entryPrice: prediction.price,
    exitPrice,
    compositeScore: prediction.compositeScore ?? 0,
    compositeDirection: prediction.compositeDirection,
    compositeCorrect: null,
    perpCorrect: null,
    tfResults: {},
    indicatorResults: {},
    indicatorTfResults: {},
    contractExpiry: expiry,
    contractRange: prediction.contract?.range ?? null,
    contractExitReason: opts.knockout ?? 'expiry',
    contractOutcome,
  }
}

/**
 * Evaluate the net payout at the first knockout mark or at expiry.
 * @param {{target: number, stop: number, direction: string}} contractSnapshot
 * @param {number} exitPrice
 * @param {number} entryPrice
 * @returns {'win' | 'loss' | null}
 */
const evaluateContractOutcome = (contractSnapshot, exitPrice, entryPrice) => {
  if (!validContractEntry(contractSnapshot, entryPrice) ||
      !Number.isFinite(exitPrice) || exitPrice <= 0) return null
  const { target, stop, direction } = contractSnapshot
  const floor = Math.min(target, stop)
  const ceiling = Math.max(target, stop)
  const priceForPayout = (price) => direction === 'up' ? price : floor + ceiling - price
  const terms = { floor, ceiling }
  const cost = buyCost(priceForPayout(entryPrice), terms)
  const proceeds = settlementProceeds(priceForPayout(exitPrice), terms)
  return proceeds > cost ? 'win' : 'loss'
}

const validContractEntry = (contract, price) => {
  const { target, stop, direction } = contract ?? {}
  if (![target, stop, price].every(p => Number.isFinite(p) && p > 0)) return false
  return direction === 'up' ? stop < price && price < target
    : direction === 'down' && target < price && price < stop
}

/** @returns {'target'|'stop'|null} */
const contractTouch = ({ target, stop, direction }, price) => {
  if (direction === 'up') return price <= stop ? 'stop' : price >= target ? 'target' : null
  if (direction === 'down') return price >= stop ? 'stop' : price <= target ? 'target' : null
  return null
}

const contractKey = ({ target, stop, direction, expiry }) => `${direction}:${target}:${stop}:${expiry}`

const firstPriceIndexAt = (prices, ts) => {
  let lo = 0
  let hi = prices.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (prices[mid].ts < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Tally hydrated JSONL records into outcomes + prediction counts.
 *
 * Mirrors the live `recordPrediction` counting so a restart that hydrates from
 * disk matches the running totals. Only UP calls are longs we score: NEUTRAL
 * and DOWN are skips (issue #158, UP-only). Counting every prediction record
 * (neutrals/downs included) double-categorizes them into both totals.
 *
 * @param {Array<Object|null>} records - parsed JSONL records
 * @returns {{outcomes: Object[], predCount: number, skipCount: number, totalPredictions: number}}
 */
const tallyHistory = (records) => {
  const outcomes = []
  let predCount = 0
  let skipCount = 0
  for (const record of records) {
    if (!record) continue
    if (record.type === 'outcome' && (record.trainingOnly || (record.compositeDirection !== 'down' &&
        (record.compositeCorrect != null || (record.window === 'contract' && record.contractOutcome != null))))) {
      outcomes.push(record)
    } else if (record.type === 'prediction') {
      predCount++
      // UP-only: DOWN is not a trade we score — same skip bucket as NEUTRAL.
      if (record.compositeDirection !== 'up') skipCount++
    }
  }
  return { outcomes, predCount, skipCount, totalPredictions: predCount - skipCount }
}

/**
 * Find directional predictions from hydrated JSONL history that never received an
 * outcome for one or more of EVAL_WINDOWS — orphaned by a process restart/crash
 * (issue #212E). Predictions in flight at shutdown live only as `setTimeout` handles,
 * which `stop()` clears; without this, they inflate `totalPredictions` forever while
 * never contributing to `totalEvaluated`.
 *
 * Pure — no timers, no I/O. For each missing (prediction, window) pair:
 *  - if the window's target time is still in the future, it's `pending` — the caller
 *    should schedule a real timeout for the remaining time so live evaluation runs it
 *    normally once reached;
 *  - if the target time has already elapsed, it's `elapsed` — resolved here using the
 *    earliest recorded price at/after the target time (built from other predictions'
 *    `price` and outcomes' `exitPrice` in the same record set). If no later price
 *    exists, `exitPrice` is null: a pre-target mark must never be relabeled as a
 *    future settlement.
 *
 * @param {Array<Object|null>} records - parsed JSONL records (predictions + outcomes), any order
 * @param {number} now - current time (ms), injected for testability
 * @returns {{
 *   pending: Array<{prediction: Object, windowMs: number, remainingMs: number}>,
 *   elapsed: Array<{prediction: Object, windowMs: number, targetTs: number, settlementTs: number|null, exitPrice: number|null}>
 * }}
 */
const findUnsettledPredictions = (records, now) => {
  const predictions = []
  const priceTimeline = [] // {ts, price}, will be sorted ascending
  const settledKeys = new Set() // `${predictionId}:${windowLabel}`

  for (const record of records) {
    if (!record) continue
    if (record.type === 'prediction') {
      const ts = Date.parse(record.ts)
      if (Number.isNaN(ts)) continue
      // Every sample's price feeds backfill, including DOWN/NEUTRAL journals.
      if (record.price) priceTimeline.push({ ts, price: record.price })
      if (record.compositeDirection === 'up' || record.trainIndicators === true) {
        predictions.push({ ...record, _ts: ts })
      }
    } else if (record.type === 'expired') {
      if (record.predictionId && record.window) settledKeys.add(`${record.predictionId}:${record.window}`)
    } else if (record.type === 'outcome') {
      if (record.predictionId && record.window) settledKeys.add(`${record.predictionId}:${record.window}`)
      const ts = Date.parse(record.ts)
      if (!Number.isNaN(ts) && record.exitPrice) priceTimeline.push({ ts, price: record.exitPrice })
    }
  }

  priceTimeline.sort((a, b) => a.ts - b.ts)

  const pending = []
  const elapsed = []

  for (const prediction of predictions) {
    for (const windowMs of EVAL_WINDOWS) {
      const label = WINDOW_LABELS[windowMs]
      if (settledKeys.has(`${prediction.id}:${label}`)) continue

      const targetTs = prediction._ts + windowMs
      if (targetTs > now) {
        pending.push({ prediction, windowMs, remainingMs: targetTs - now })
        continue
      }

      let exitPrice = null
      let settlementTs = null
      for (const p of priceTimeline) {
        if (p.ts >= targetTs) {
          if (p.ts - targetTs <= MAX_EVAL_LAG_MS) {
            exitPrice = p.price
            settlementTs = p.ts
          }
          break
        }
      }
      // Same lag limit live evaluation applies: no price within it means the window
      // is unrecoverable, so the caller journals an `expired` marker (never settled late).
      const expired = exitPrice == null && now - targetTs > MAX_EVAL_LAG_MS
      elapsed.push({ prediction, windowMs, targetTs, settlementTs, exitPrice, expired })
    }
  }

  return { pending, elapsed }
}

/**
 * Journal marker for a window that missed MAX_EVAL_LAG_MS with no usable price.
 * Counted as settled by the recovery planners so a later restart never scores it
 * against a price recorded hours afterwards.
 */
const buildExpiredRecord = (prediction, window) => ({
  type: 'expired',
  ts: new Date().toISOString(),
  predictionId: prediction.id,
  window,
})

/**
 * Find UP predictions whose valid snapshotted contract has not been settled.
 * Recover the first observed touch between prediction and expiry, or use the
 * first observed expiry mark if no earlier touch was captured.
 * @param {Array<Object|null>} records
 * @param {number} now
 * @param {Array<{price: number, timestamp: number}>} [recentTicks]
 */
const findUnsettledContractPredictions = (records, now, recentTicks = []) => {
  const predictions = []
  const prices = recentTicks
    .filter(tick => Number.isFinite(tick.timestamp) && Number.isFinite(tick.price) && tick.price > 0)
    .map(tick => ({ ts: tick.timestamp, price: tick.price }))
  const settled = new Set()
  const knockouts = new Map()
  for (const record of records) {
    if (!record) continue
    const ts = Date.parse(record.ts)
    if (record.type === 'prediction') {
      if (Number.isFinite(ts) && Number.isFinite(record.price) && record.price > 0) {
        prices.push({ ts, price: record.price })
      }
      const expiry = Number(record.contract?.expiry)
      if (record.compositeDirection === 'up' && Number.isFinite(ts) &&
          Number.isFinite(expiry) && expiry > ts) {
        predictions.push(record)
      }
    } else if (record.type === 'contract_knockout') {
      const { contract, price } = record
      if (!contract || !Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)
          || !Number.isFinite(contract.expiry) || ts > now || ts >= contract.expiry) continue
      const knockout = contractTouch(contract, price)
      if (!knockout) continue
      prices.push({ ts, price })
      const key = contractKey(contract)
      if (!knockouts.has(key) || ts < knockouts.get(key).ts) {
        knockouts.set(key, { contract, ts, price, knockout, recorded: true })
      }
    } else if (record.type === 'expired') {
      if (record.window === 'contract' && record.predictionId) settled.add(record.predictionId)
    } else if (record.type === 'outcome') {
      if (record.window === 'contract' && record.predictionId) settled.add(record.predictionId)
      if (Number.isFinite(ts) && Number.isFinite(record.exitPrice) && record.exitPrice > 0) {
        prices.push({ ts, price: record.exitPrice })
      }
    }
  }
  prices.sort((a, b) => a.ts - b.ts)
  // Look for the first sampled touch for each listing from its earliest known
  // entry, including entries whose outcome was already written by an old build.
  const firstEntries = new Map()
  for (const { contract, price, ts } of predictions) {
    if (!validContractEntry(contract, price)) continue
    const key = contractKey(contract)
    const entryTs = Date.parse(ts)
    if (!firstEntries.has(key) || entryTs < firstEntries.get(key).ts) {
      firstEntries.set(key, { contract, ts: entryTs })
    }
  }
  for (const [key, { contract, ts }] of firstEntries) {
    const limit = Math.min(now, contract.expiry - 1, (knockouts.get(key)?.ts ?? Infinity) - 1)
    for (let i = firstPriceIndexAt(prices, ts + 1); i < prices.length && prices[i].ts <= limit; i++) {
      const mark = prices[i]
      const knockout = contractTouch(contract, mark.price)
      if (!knockout) continue
      knockouts.set(key, { contract, ...mark, knockout, recorded: false })
      break
    }
  }

  const pending = []
  const elapsed = []
  for (const prediction of predictions) {
    if (settled.has(prediction.id)) continue
    const { contract } = prediction
    const targetTs = Number(contract.expiry)
    if (validContractEntry(contract, prediction.price)) {
      const touch = knockouts.get(contractKey(contract))
      if (touch) {
        if (Date.parse(prediction.ts) < touch.ts) {
          elapsed.push({ prediction, targetTs, settlementTs: touch.ts, exitPrice: touch.price, knockout: touch.knockout })
        }
        continue
      }
    }
    if (targetTs > now) {
      pending.push({ prediction, targetTs, remainingMs: targetTs - now })
      continue
    }
    const found = prices[firstPriceIndexAt(prices, targetTs)]
    const mark = found && found.ts <= now && found.ts - targetTs <= MAX_EVAL_LAG_MS ? found : null
    elapsed.push({
      prediction,
      targetTs,
      settlementTs: mark?.ts ?? null,
      exitPrice: mark?.price ?? null,
      expired: mark == null && now - targetTs > MAX_EVAL_LAG_MS,
    })
  }
  return { pending, elapsed, knockouts }
}

const knockoutRecord = (contract, ts, price) => ({
  type: 'contract_knockout',
  ts: new Date(ts).toISOString(),
  contract,
  price,
})

/**
 * Compute per-UTC-hour accuracy (minimum 5 samples) from evaluated outcomes.
 *
 * Bucketed by PREDICTION hour, not settlement/evaluation hour (issue #212D) — Feature
 * 11 in signal-engine.js applies `byHour[predictionHour]` as a time-of-day multiplier,
 * so bucketing by the later settlement timestamp attributed every 1h-window outcome
 * (and ~25% of 15m-window outcomes) to the wrong hour. Falls back to `o.ts` for outcome
 * records persisted before `predictionTs` existed (backward compat with old JSONL).
 *
 * @param {Array<Object>} outcomes - Evaluated outcome records (ring buffer or hydrated JSONL)
 * @returns {Record<number, {correct: number, total: number, accuracy: number|null}>}
 */
const computeByHour = (outcomes) => {
  const byHour = {}
  for (const o of outcomes) {
    const bucketTs = o.predictionTs ?? o.ts
    if (o.compositeCorrect == null || !bucketTs) continue
    const hour = new Date(bucketTs).getUTCHours()
    if (!byHour[hour]) byHour[hour] = { correct: 0, total: 0 }
    byHour[hour].total++
    if (o.compositeCorrect) byHour[hour].correct++
  }
  for (const h of Object.keys(byHour)) {
    const d = byHour[h]
    byHour[h].accuracy = d.total >= 5 ? Math.round(d.correct / d.total * 10000) / 100 : null
  }
  return byHour
}

/**
 * Create a scorecard instance
 * @param {Object} opts
 * @param {Object} opts.io - realtime bus (src/realtime-bus.js)
 * @param {Function} opts.lastPriceFn - Returns current BTC price
 * @param {Function} [opts.contractFn] - Returns current contract config
 * @param {() => Array<{price: number, timestamp: number}>} [opts.recentTicksFn] - Ticks received during hydration
 * @param {Function} [opts.journalWriter] - Testable persistence boundary; receives (record, {signal})
 * @param {string} [opts.scorecardDir] - Testable history source directory
 * @param {(file: string) => Promise<void>} [opts.unlinkFile] - Testable history deletion boundary
 * @param {typeof scorecardLogger} [opts.retentionLogger] - Testable retention logging boundary
 * @param {number} [opts.pruneLockWaitMs] - How long retention waits for the maintenance lock before skipping
 * @param {number} [opts.historyLockWaitMs] - How long hydration waits for a replay before reading unlocked
 * @param {{snapshot: Function, hydrate: Function, isLong: Function, serialize: Function}|null} [opts.perpBook] - Shared 0.01-BTC-per-contract paper book
 * @returns {{recordPrediction: Function, recordPerpFill: Function, observePrice: (price: number, ts: number) => void, getMetrics: Function, start: Function, stop: Function}}
 */
const createScorecard = ({ io, lastPriceFn, contractFn, recentTicksFn = () => [], journalWriter = appendRecord, scorecardDir = SCORECARD_DIR, unlinkFile = unlink, retentionLogger = scorecardLogger, perpBook = null, pruneLockWaitMs = PRUNE_LOCK_WAIT_MS, historyLockWaitMs = HISTORY_LOCK_WAIT_MS }) => {
  /** @type {Array<Object>} Ring buffer of evaluated outcomes */
  const outcomeBuffer = []

  /** @type {Set<NodeJS.Timeout>} Pending evaluation timeouts */
  const pendingTimeouts = new Set()
  // One live subscription and expiry timer per set of contract terms.
  const pendingContracts = new Map()
  const knockedOutContracts = new Map()

  /** @type {NodeJS.Timeout | null} */
  let sampleInterval = null
  let pruneTimer = null

  /** @type {Function | null} */
  let computeSignalsFn = null

  let lastSampleTs = 0
  let lastEmitTs = 0
  let lastWeightLogTs = 0
  let totalPredictions = 0
  let totalSkipped = 0
  let adaptiveWeights = { ...BASE_WEIGHTS }
  let running = false
  // Aborted by stop() so lock waits never outlive the writer (backup drain).
  let lockWaits = new AbortController()
  let lifecycleGeneration = 0
  const journal = {
    healthy: true,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
  }

  const persistRecord = (record) => {
    // Bind now: a stop()+start() before the deferred write runs swaps lockWaits.
    const { signal } = lockWaits
    return trackPendingWrite(JOURNAL_WRITE_LABEL, () => journalWriter(record, { signal }))
      .then(() => {
        journal.healthy = true
        journal.lastError = null
        journal.lastErrorAt = null
        journal.lastSuccessAt = new Date().toISOString()
      })
      .catch((err) => {
        journal.healthy = false
        journal.lastError = err?.message || String(err)
        journal.lastErrorAt = new Date().toISOString()
        const recordType = (Array.isArray(record) ? record[0]?.type : record?.type) || 'unknown'
        scorecardLogger.error(`❌ 📊 Scorecard journal write failed type=${recordType} err=${journal.lastError}`, {
          action: 'journal-write',
          recordType,
          error: journal.lastError,
        })
      })
  }

  const persistBatch = (records) => {
    if (journalWriter === appendRecord) persistRecord(records)
    else for (const record of records) persistRecord(record)
  }

  /**
   * Build a prediction record from signal engine output
   * @param {Object} result - Output from signalEngine.computeSignals()
   * @param {'interval' | 'signal_change'} trigger
   * @returns {Object | null} Prediction record, or null if neutral
   */
  const buildPrediction = (result, trigger) => {
    const price = lastPriceFn()
    if (!price) return null

    const compositeDirection = scorecardDirection(result)
    const id = `pred_${Date.now()}_${++predictionCounter}`

    const timeframes = {}
    for (const tf of ALL_TFS) {
      const tfData = result.timeframes?.[tf]
      if (!tfData) continue
      timeframes[tf] = {
        score: tfData.score ?? 0,
        scores: tfData.scores ?? {},
      }
    }

    // Regime context from signal engine result
    const regime = {
      trendBias: result.trendFilter?.trendBias ?? null,
      volatilityRatio: result.volatility?.ratio ?? null,
      volumeSurge: result.timeframes?.['5m']?.indicators?.volumeSurge?.surgeRatio ?? null,
    }

    // Contract snapshot
    const contractSnapshot = contractFn?.() ?? null
    const contract = contractSnapshot ? {
      target: contractSnapshot.target ?? null,
      stop: contractSnapshot.stop ?? null,
      range: contractSnapshot.range ?? null,
      direction: contractSnapshot.direction ?? null,
      expiry: contractSnapshot.expiry ?? null,
    } : null

    return {
      type: 'prediction',
      id,
      ts: new Date().toISOString(),
      price,
      compositeScore: result.score,
      compositeDirection,
      signalType: result.type,
      confidence: result.confidence,
      trigger,
      trainIndicators: true,
      timeframes,
      regime,
      contract,
    }
  }

  /**
   * Evaluate a single prediction outcome for a given window
   * @param {Object} prediction
   * @param {number} windowMs
   */
  const evaluateOutcome = (prediction, windowMs) => {
    const exitPrice = lastPriceFn()
    if (!exitPrice) {
      return false
    }

    const outcome = buildOutcomeRecord(prediction, windowMs, exitPrice)

    // Persist to JSONL
    persistRecord(outcome)

    // Push to ring buffer
    outcomeBuffer.push(outcome)
    if (outcomeBuffer.length > BUFFER_SIZE) {
      outcomeBuffer.splice(0, outcomeBuffer.length - BUFFER_SIZE)
    }

    updateAdaptiveWeights()

    // Throttled emit
    const now = Date.now()
    if (now - lastEmitTs >= EMIT_THROTTLE_MS) {
      lastEmitTs = now
      io.to('updown').emit('updown:scorecard', getMetrics())
    }
    return true
  }

  const settleContracts = (predictions, exitPrice, opts, marker) => {
    const outcomes = predictions.map(prediction => buildContractOutcomeRecord(prediction, exitPrice, opts)).filter(Boolean)
    if (outcomes.length === 0) return
    persistBatch(marker ? [marker, ...outcomes] : outcomes)
    outcomeBuffer.push(...outcomes)
    if (outcomeBuffer.length > BUFFER_SIZE) {
      outcomeBuffer.splice(0, outcomeBuffer.length - BUFFER_SIZE)
    }
    const now = Date.now()
    if (now - lastEmitTs >= EMIT_THROTTLE_MS) {
      lastEmitTs = now
      io.to('updown').emit('updown:scorecard', getMetrics())
    }
  }

  /**
   * Schedule a target-time evaluation. If the live mark is temporarily stale,
   * retry briefly instead of scoring an old price or silently losing the window.
   */
  const scheduleEvaluation = (prediction, targetTs, evaluate, label) => {
    let timeout
    const arm = () => {
      if (!running) return
      const now = Date.now()
      const delay = now < targetTs ? targetTs - now : EVAL_RETRY_MS
      timeout = setTimeout(() => {
        pendingTimeouts.delete(timeout)
        if (!running) return
        try {
          if (Date.now() < targetTs) {
            arm()
            return
          }
          if (evaluate()) return
          if (Date.now() - targetTs <= MAX_EVAL_LAG_MS) {
            arm()
          } else {
            persistRecord(buildExpiredRecord(prediction, label))
            scorecardLogger.warn(`⚠️ 📊 Scorecard eval unavailable — fresh price missing predId=${prediction.id} window=${label}`, {
              action: 'evaluate',
              predictionId: prediction.id,
              window: label,
              reason: 'stale-price',
            })
          }
        } catch (err) {
          scorecardLogger.warn(`⚠️ 📊 Scorecard eval failed predId=${prediction.id} window=${label} err=${err.message}`, {
            action: 'evaluate',
            predictionId: prediction.id,
            window: label,
            error: err.message,
          })
        }
      }, Math.min(delay, 2_147_000_000))
      pendingTimeouts.add(timeout)
    }
    arm()
    return () => {
      clearTimeout(timeout)
      pendingTimeouts.delete(timeout)
    }
  }

  const registerContract = (prediction) => {
    const { contract } = prediction
    if (!validContractEntry(contract, prediction.price)) return
    const { expiry } = contract
    const key = contractKey(contract)
    const now = Date.now()
    for (const [closedKey, expiresAt] of knockedOutContracts) {
      if (expiresAt <= now) knockedOutContracts.delete(closedKey)
    }
    if (knockedOutContracts.has(key)) return
    let pending = pendingContracts.get(key)
    if (!pending) {
      const predictions = []
      const cancel = scheduleEvaluation(prediction, expiry + MAX_EVAL_LAG_MS + 1, () => {
        pendingContracts.delete(key)
        persistBatch(predictions.map(p => buildExpiredRecord(p, 'contract')))
        return true
      }, 'contract')
      pending = { contract, predictions, cancel }
      pendingContracts.set(key, pending)
    }
    pending.predictions.push(prediction)
  }

  const observePrice = (price, ts) => {
    for (const [key, { contract, predictions, cancel }] of pendingContracts) {
      const { expiry } = contract
      if (ts > expiry + MAX_EVAL_LAG_MS) continue
      const knockout = ts < expiry ? contractTouch(contract, price) : null
      if (ts < expiry && !knockout) continue
      const eligible = predictions.filter(p => Date.parse(p.ts) < ts)
      if (eligible.length === 0) continue
      if (knockout) knockedOutContracts.set(key, expiry)
      cancel()
      pendingContracts.delete(key)
      settleContracts(eligible, price, { ts: new Date(ts).toISOString(), knockout },
        knockout ? knockoutRecord(contract, ts, price) : null)
    }
  }

  /**
   * Record a prediction and schedule evaluations
   * @param {Object} result - Signal engine output
   * @param {'interval' | 'signal_change'} trigger
   */
  const recordPrediction = (result, trigger) => {
    const prediction = buildPrediction(result, trigger)
    if (!prediction) return

    // Track de-duplication: a recorded signal_change must push lastSampleTs
    // forward UNCONDITIONALLY so the interval sampler (which skips when
    // now - lastSampleTs < DEDUP_WINDOW_MS) suppresses the next tick. The old
    // code only refreshed when ALREADY within the window — so a signal_change
    // landing 56s+ after the last sample didn't suppress the interval tick
    // seconds later, recording two near-duplicate predictions that
    // double-count in accuracy/byWindow/byIndicator and the adaptive-weight
    // loop (issue #108).
    if (trigger === 'signal_change') {
      lastSampleTs = Date.now()
    }

    if (prediction.compositeDirection !== 'up') {
      totalSkipped++
    } else {
      totalPredictions++
      scorecardLogger.info(`ℹ️ 📊 Scorecard prediction=${prediction.id} price=$${prediction.price} dir=${prediction.compositeDirection} trigger=${trigger}`, {
        action: 'record-prediction',
        predictionId: prediction.id,
        price: prediction.price,
        direction: prediction.compositeDirection,
        trigger,
      })
    }

    // Persist prediction to JSONL
    persistRecord(prediction)

    // Schedule evaluations for each window
    const predictionTs = Date.parse(prediction.ts)
    for (const windowMs of EVAL_WINDOWS) {
      scheduleEvaluation(
        prediction,
        predictionTs + windowMs,
        () => evaluateOutcome(prediction, windowMs),
        WINDOW_LABELS[windowMs],
      )
    }

    const expiry = Number(prediction.contract?.expiry)
    if (prediction.compositeDirection === 'up' && Number.isFinite(expiry) && expiry > predictionTs) {
      registerContract(prediction)
    }
  }

  const computeIndicatorMetrics = (scored) => {
    const byIndicator = {}
    for (const ind of INDICATORS) {
      let indTotal = 0
      let indCorrect = 0
      let rawCount = 0
      for (const o of scored) {
        const indResult = o.indicatorResults?.[ind]
        if (!indResult || indResult.predictions === 0) continue
        const strengthWeight = o.compositeScore != null
          ? Math.min(2, Math.abs(o.compositeScore) / 30)
          : 1.0
        indTotal += indResult.predictions * strengthWeight
        indCorrect += indResult.correct * strengthWeight
        rawCount += indResult.predictions
      }
      byIndicator[ind] = {
        accuracy: indTotal > 0 ? Math.round(indCorrect / indTotal * 10000) / 100 : null,
        predictions: rawCount,
      }
    }
    return byIndicator
  }

  /** Advance the adaptive model exactly once for a changed training set. */
  const updateAdaptiveWeights = (alpha = 0.15, persist = true) => {
    const byIndicator = computeTrainingMetrics(outcomeBuffer)
    adaptiveWeights = computeAdaptiveWeights(byIndicator, BASE_WEIGHTS, adaptiveWeights, alpha)

    const weightNow = Date.now()
    if (persist && weightNow - lastWeightLogTs >= WEIGHT_LOG_THROTTLE_MS) {
      lastWeightLogTs = weightNow
      persistRecord({
        type: 'weights',
        ts: new Date().toISOString(),
        weights: { ...adaptiveWeights },
        byIndicator: { ...byIndicator },
      })
    }
  }

  const computeOutcomeStreak = (evaluatedOutcomes) => {
    let streak = 0
    for (let i = evaluatedOutcomes.length - 1; i >= 0; i--) {
      if (i === evaluatedOutcomes.length - 1) {
        streak = evaluatedOutcomes[i].compositeCorrect ? 1 : -1
      } else {
        const prev = evaluatedOutcomes[i].compositeCorrect
        if ((streak > 0 && prev) || (streak < 0 && !prev)) {
          streak += streak > 0 ? 1 : -1
        } else {
          break
        }
      }
    }
    return streak
  }

  const computeWindowMetrics = (scoredOutcomes) => {
    const byWindow = {}
    for (const label of Object.values(WINDOW_LABELS)) {
      const windowOutcomes = scoredOutcomes.filter(o => o.window === label && o.compositeCorrect != null)
      const wCorrect = windowOutcomes.filter(o => o.compositeCorrect === true).length
      const perpWindow = scoredOutcomes.filter(o => o.window === label && resolvePerpCorrect(o) != null)
      const perpHits = perpWindow.filter(o => resolvePerpCorrect(o) === true).length
      byWindow[label] = {
        accuracy: windowOutcomes.length > 0 ? Math.round(wCorrect / windowOutcomes.length * 10000) / 100 : null,
        correct: wCorrect,
        incorrect: windowOutcomes.length - wCorrect,
        total: windowOutcomes.length,
        perpAccuracy: perpWindow.length > 0 ? Math.round(perpHits / perpWindow.length * 10000) / 100 : null,
        perpCorrect: perpHits,
        perpTotal: perpWindow.length,
        primary: PRIMARY_WINDOWS.includes(label),
      }
    }
    return byWindow
  }

  const computeTimeframeMetrics = (scoredOutcomes) => {
    const byTimeframe = {}
    for (const tf of ALL_TFS) {
      let tfTotal = 0
      let tfCorrect = 0
      for (const o of scoredOutcomes) {
        const tfResult = o.tfResults?.[tf]
        if (tfResult?.correct == null) continue
        tfTotal++
        if (tfResult.correct) tfCorrect++
      }
      byTimeframe[tf] = {
        accuracy: tfTotal > 0 ? Math.round(tfCorrect / tfTotal * 10000) / 100 : null,
        predictions: tfTotal,
      }
    }
    return byTimeframe
  }

  const computeContractMetrics = (scoredOutcomes) => {
    const contractOutcomes = scoredOutcomes.filter(o => o.window === 'contract' &&
      (o.contractOutcome === 'win' || o.contractOutcome === 'loss'))
    if (contractOutcomes.length === 0) return null
    const contractWins = contractOutcomes.filter(o => o.contractOutcome === 'win').length
    const contractLosses = contractOutcomes.filter(o => o.contractOutcome === 'loss').length
    return {
      accuracy: Math.round(contractWins / contractOutcomes.length * 10000) / 100,
      wins: contractWins,
      losses: contractLosses,
      total: contractOutcomes.length,
    }
  }

  const getMetrics = () => {
    const scored = outcomeBuffer.filter(o => !o.trainingOnly && o.compositeDirection !== 'down')
    const evaluated = scored.filter(o => o.compositeCorrect != null)
    const correct = evaluated.filter(o => o.compositeCorrect === true)
    const incorrect = evaluated.filter(o => o.compositeCorrect === false)
    const perpEvaluated = scored.filter(o => resolvePerpCorrect(o) != null)
    const perpCorrectHits = perpEvaluated.filter(o => resolvePerpCorrect(o) === true)

    // Streak (consecutive correct/incorrect from most recent)
    const streak = computeOutcomeStreak(evaluated)

    // Average BPS for correct/incorrect
    const avgCorrectBps = correct.length > 0
      ? Math.round(correct.reduce((s, o) => s + Math.abs(o.priceChangeBps), 0) / correct.length * 100) / 100
      : 0
    const avgIncorrectBps = incorrect.length > 0
      ? Math.round(incorrect.reduce((s, o) => s + Math.abs(o.priceChangeBps), 0) / incorrect.length * 100) / 100
      : 0

    // By window
    const byWindow = computeWindowMetrics(scored)

    // By timeframe
    const byTimeframe = computeTimeframeMetrics(scored)

    // Published-call diagnostics retain the composite strength weighting.
    const byIndicator = computeIndicatorMetrics(scored)

    // Time-of-day multiplier in signal-engine assumes 50% = coin-flip. Options
    // mode (flat = miss) sits well below 50% on 1m/5m, so every hour would
    // clamp to the 0.90 floor. Perp correctness (flat = scratch) restores that
    // 50% baseline — same switch already applied to byIndicator.
    const byHour = computeByHour(scored.map(o => ({
      ...o,
      compositeCorrect: resolvePerpCorrect(o),
    })))

    // Contract-aware accuracy
    const contractAware = computeContractMetrics(scored)

    // Last prediction info
    const lastPred = scored.length > 0 ? scored[scored.length - 1] : null

    const perp = perpBook ? perpBook.snapshot(lastPriceFn()) : null

    return {
      totalPredictions,
      totalEvaluated: evaluated.length,
      totalSkipped,
      overall: {
        accuracy: evaluated.length > 0 ? Math.round(correct.length / evaluated.length * 10000) / 100 : null,
        correct: correct.length,
        incorrect: incorrect.length,
        streak,
        avgCorrectBps,
        avgIncorrectBps,
      },
      overallPerp: {
        accuracy: perpEvaluated.length > 0 ? Math.round(perpCorrectHits.length / perpEvaluated.length * 10000) / 100 : null,
        correct: perpCorrectHits.length,
        incorrect: perpEvaluated.length - perpCorrectHits.length,
        total: perpEvaluated.length,
      },
      primaryWindows: PRIMARY_WINDOWS,
      byWindow,
      byTimeframe,
      byIndicator,
      byHour,
      contractAware,
      adaptiveWeights,
      journal: { ...journal },
      lastPrediction: lastPred ? {
        ts: lastPred.ts,
        price: lastPred.entryPrice,
        direction: lastPred.compositeDirection,
        signalType: lastPred.compositeDirection,
      } : null,
      perp,
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Persist a paper-trade fill (Open/Add/Close) to the JSONL journal.
   * @param {Object} record
   */
  const recordPerpFill = (record) => {
    persistRecord({
      type: 'perp_fill',
      ts: new Date((record.ts || Date.now())).toISOString(),
      ...record,
    })
  }

  /**
   * Load recent outcomes from JSONL files into the outcome buffer
   * Loads from the most recent files (up to 3 days) to hydrate metrics on restart
   */
  const loadHistory = async (generation) => {
    if (!existsSync(scorecardDir)) {
      if (running && generation === lifecycleGeneration) {
        outcomeBuffer.length = 0
        totalPredictions = 0
        totalSkipped = 0
        adaptiveWeights = { ...BASE_WEIGHTS }
      }
      return
    }

    const files = await readdir(scorecardDir)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort()
    // Load last 7 days of data (matches BUFFER_SIZE of ~2000 outcomes)
    const recentFiles = jsonlFiles.slice(-7)

    // Neutrals are skips, not predictions — tallyHistory excludes them from
    // totalPredictions so reload mirrors live counting (issue #158).
    /** @type {Array<Object|null>} All records across loaded files, for issue #212E backfill */
    let allRecords = []
    for (const file of recentFiles) {
      const content = await readFile(path.join(scorecardDir, file), 'utf8').catch(() => '')
      const records = content.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      allRecords.push(...records)
    }

    if (!running || generation !== lifecycleGeneration) return
    allRecords = dedupeScorecardRecords(allRecords)
    const tally = tallyHistory(allRecords)
    const loaded = tally.outcomes.length
    const predictions = tally.totalPredictions
    const skipped = tally.skipCount
    outcomeBuffer.length = 0
    outcomeBuffer.push(...tally.outcomes)

    // Issue #212E: predictions in flight at shutdown are otherwise never settled —
    // their evaluation lived only in a setTimeout that stop() cleared. Backfill
    // windows that already elapsed against the best available recorded price, and
    // reschedule real timers for windows still open so live evaluation picks them
    // up normally.
    const now = Date.now()
    const { pending, elapsed } = findUnsettledPredictions(allRecords, now)
    const contractRecovery = findUnsettledContractPredictions(allRecords, now, recentTicksFn())
    for (const [key, touch] of contractRecovery.knockouts) {
      if (touch.contract.expiry > now) {
        knockedOutContracts.set(key, touch.contract.expiry)
        if (!touch.recorded) persistRecord(knockoutRecord(touch.contract, touch.ts, touch.price))
      }
    }

    let backfilled = 0
    // Fell due during the downtime with no recorded mark, but still inside the
    // lag allowance: live evaluation settles it against a fresh price or expires it.
    const lateWindows = []
    for (const { prediction, windowMs, targetTs, settlementTs, exitPrice, expired } of elapsed) {
      if (expired) persistRecord(buildExpiredRecord(prediction, WINDOW_LABELS[windowMs]))
      if (exitPrice == null && !expired) {
        lateWindows.push({ prediction, targetTs, evaluate: () => evaluateOutcome(prediction, windowMs), label: WINDOW_LABELS[windowMs] })
        continue
      }
      if (exitPrice == null || settlementTs == null) continue
      const outcome = buildOutcomeRecord(prediction, windowMs, exitPrice, {
        ts: new Date(settlementTs).toISOString(),
      })
      outcome.backfilled = true
      persistRecord(outcome)
      outcomeBuffer.push(outcome)
      backfilled++
    }

    for (const { prediction, windowMs } of pending) {
      const targetTs = Date.parse(prediction.ts) + windowMs
      scheduleEvaluation(
        prediction,
        targetTs,
        () => evaluateOutcome(prediction, windowMs),
        WINDOW_LABELS[windowMs],
      )
    }

    for (const { prediction, settlementTs, exitPrice, expired, knockout } of contractRecovery.elapsed) {
      if (expired) persistRecord(buildExpiredRecord(prediction, 'contract'))
      if (exitPrice == null && !expired) {
        registerContract(prediction)
        continue
      }
      if (exitPrice == null || settlementTs == null) continue
      const outcome = buildContractOutcomeRecord(prediction, exitPrice, {
        ts: new Date(settlementTs).toISOString(),
        knockout,
      })
      if (!outcome) continue
      outcome.backfilled = true
      persistRecord(outcome)
      outcomeBuffer.push(outcome)
      backfilled++
    }

    for (const { prediction } of contractRecovery.pending) {
      registerContract(prediction)
    }

    for (const { prediction, targetTs, evaluate, label } of lateWindows) {
      scheduleEvaluation(prediction, targetTs, evaluate, label)
    }

    const pendingCount = pending.length + contractRecovery.pending.length + lateWindows.length
    if (backfilled > 0 || pendingCount > 0) {
      scorecardLogger.info(`ℹ️ 📊 Scorecard restart recovery: backfilled=${backfilled} elapsed outcomes, rescheduled=${pendingCount} pending windows`, {
        action: 'restart-recovery',
        backfilled,
        rescheduled: pendingCount,
      })
    }

    // Trim to buffer size
    if (outcomeBuffer.length > BUFFER_SIZE) {
      outcomeBuffer.splice(0, outcomeBuffer.length - BUFFER_SIZE)
    }

    totalPredictions = predictions
    totalSkipped = skipped
    adaptiveWeights = { ...BASE_WEIGHTS }
    if (outcomeBuffer.some(o => o.window !== 'contract')) {
      // Rebuild one deterministic snapshot from the retained training window.
      // Metric-read frequency must never affect the deployed weights.
      updateAdaptiveWeights(1, false)
    }

    // Paper book lives in updown-state.json. Do not rebuild it from the
    // scorecard journal — a 0-lot reset would otherwise come back as a
    // historical position.

    scorecardLogger.info(`ℹ️ 📊 Scorecard loaded history outcomes=${loaded} predictions=${predictions} skipped=${skipped} files=${recentFiles.length}`, {
      action: 'load-history',
      outcomes: loaded,
      predictions,
      skipped,
      files: recentFiles.length,
    })
  }

  /**
   * Start auto-sampling predictions at the configured interval
   * @param {Function} computeSignals - Function that returns signal engine output
   */
  /**
   * Prune scorecard JSONL files older than retentionDays
   * @param {number} [retentionDays=SCORECARD_RETENTION_DAYS] - Number of days to keep
   */
  const pruneHistory = async (retentionDays = SCORECARD_RETENTION_DAYS) => {
    if (!existsSync(scorecardDir)) return
    return withScorecardLock(scorecardDir, async () => {
      const files = await readdir(scorecardDir)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort()
      if (jsonlFiles.length <= retentionDays) return

      const toDelete = jsonlFiles.slice(0, jsonlFiles.length - retentionDays)
      let deleted = 0
      const failures = []
      for (const file of toDelete) {
        try {
          await unlinkFile(path.join(scorecardDir, file))
          deleted++
        } catch (err) {
          failures.push(`${file}: ${err.message}`)
        }
      }
      retentionLogger.info(`ℹ️ 📊 Scorecard prune completed deleted=${deleted} failed=${failures.length} retentionDays=${retentionDays}`, {
        action: 'prune',
        deleted,
        failed: failures.length,
        retentionDays,
      })
      if (failures.length > 0) {
        throw new Error(`failed to delete ${failures.length} scorecard file(s): ${failures.join('; ')}`)
      }
    }, { timeoutMs: pruneLockWaitMs, signal: lockWaits.signal })
  }

  const start = async (computeSignals) => {
    if (running) {
      computeSignalsFn = computeSignals
      return
    }
    running = true
    if (lockWaits.signal.aborted) lockWaits = new AbortController()
    const generation = ++lifecycleGeneration
    computeSignalsFn = computeSignals

    // Prune old scorecard data on startup
    await pruneHistory().catch(err => retentionLogger.warn(`⚠️ 📊 Scorecard prune failed err=${err.message}`, { action: 'prune', error: err.message }))
    if (!running || generation !== lifecycleGeneration) return

    // Hydrate from disk and emit initial metrics
    const hydrate = existsSync(scorecardDir)
      ? withScorecardLock(scorecardDir, () => loadHistory(generation), { timeoutMs: historyLockWaitMs, signal: lockWaits.signal })
        .catch(err => {
          if (err?.code === 'SCORECARD_LOCK_CANCELLED') return
          if (err?.code !== 'SCORECARD_LOCK_BUSY') throw err
          retentionLogger.warn(`⚠️ 📊 Scorecard history loading without the lock err=${err.message}`, { action: 'load-history', error: err.message })
          return loadHistory(generation)
        })
      : loadHistory(generation)
    await hydrate.catch(err => scorecardLogger.warn(`⚠️ 📊 Scorecard history load failed err=${err.message}`, {
      action: 'load-history',
      error: err.message,
    }))
    if (!running || generation !== lifecycleGeneration) return
    if (outcomeBuffer.length > 0) {
      io.to('updown').emit('updown:scorecard', getMetrics())
    }

    sampleInterval = setInterval(() => {
      if (!computeSignalsFn) return
      const now = Date.now()
      // De-dup: if a signal_change was recorded within DEDUP_WINDOW_MS, skip this sample
      if (now - lastSampleTs < DEDUP_WINDOW_MS) return
      lastSampleTs = now
      // computeSignalsFn/recordPrediction are synchronous; a throw here would
      // crash the process from the interval callback.
      try {
        // null: the caller has no trustworthy signal yet (e.g. candles still seeding).
        const sampled = computeSignalsFn()
        if (sampled) recordPrediction(sampled, 'interval')
      } catch (err) {
        scorecardLogger.warn(`⚠️ 📊 Scorecard sample failed err=${err.message}`, {
          action: 'sample',
          error: err.message,
        })
      }
    }, SAMPLE_INTERVAL_MS)

    // Daily prune of old scorecard files (every 24h)
    pruneTimer = setInterval(() => pruneHistory(30).catch(err => retentionLogger.warn(`⚠️ 📊 Scorecard prune failed err=${err.message}`, { action: 'prune', error: err.message })), 24 * 60 * 60 * 1000)

    scorecardLogger.info('ℹ️ 📊 Scorecard started interval=60s windows=[1m,5m,15m,1h] primary=[1m,5m] upOnly=true', {
      action: 'start',
      intervalMs: SAMPLE_INTERVAL_MS,
    })
  }

  /**
   * Stop the scorecard, clearing all pending timeouts
   */
  const stop = () => {
    running = false
    lifecycleGeneration++
    lockWaits.abort()
    if (sampleInterval) {
      clearInterval(sampleInterval)
      sampleInterval = null
    }
    if (pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = null
    }
    for (const t of pendingTimeouts) {
      clearTimeout(t)
    }
    pendingTimeouts.clear()
    pendingContracts.clear()
    knockedOutContracts.clear()
    computeSignalsFn = null
    scorecardLogger.info(`ℹ️ 📊 Scorecard stopped predictions=${totalPredictions} evaluated=${outcomeBuffer.length}`, {
      action: 'stop',
      predictions: totalPredictions,
      evaluated: outcomeBuffer.length,
    })
  }

  return { recordPrediction, recordPerpFill, observePrice, getMetrics, start, stop }
}

module.exports = {
  createScorecard,
  computeAdaptiveWeights,
  computeTrainingMetrics,
  evaluateContractOutcome,
  buildContractOutcomeRecord,
  tallyHistory,
  dedupeScorecardRecords,
  evaluateDirection,
  getDirection,
  buildOutcomeRecord,
  findUnsettledPredictions,
  findUnsettledContractPredictions,
  computeByHour,
  PRIMARY_WINDOWS,
  WINDOW_MS,
  ALL_TFS,
  scorecardDirection,
  SCORECARD_RETENTION_DAYS,
  JOURNAL_WRITE_LABEL,
}
