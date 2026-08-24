// @ts-check
/**
 * Signal Prediction Scorecard
 *
 * Tracks predictions from the UpDown signal engine, evaluates outcomes
 * after configurable time windows, and computes per-indicator/per-timeframe
 * accuracy metrics for real-time monitoring.
 */

const { appendFile, mkdir, readFile, readdir } = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const { log } = require('../logger')
const { UPDOWN_DATA_DIR } = require('../paths')
const { INDICATORS, INDICATOR_WEIGHTS } = require('./indicator-config')
const { createPerpBook } = require('./perp-book')

const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard')
const SAMPLE_INTERVAL_MS = 60_000
const EVAL_WINDOWS = [60_000, 300_000, 900_000, 3_600_000]
const WINDOW_LABELS = { 60000: '1m', 300000: '5m', 900000: '15m', 3600000: '1h' }
const WINDOW_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
/** Tick-to-tick products (CDC Up options, Coinbase perp flips) live on 1m/5m. */
const PRIMARY_WINDOWS = ['1m', '5m']
const DIRECTION_THRESHOLD = 15 // aligned with signal-engine's neutralThreshold for BUY signals
const BUFFER_SIZE = 2000
const EMIT_THROTTLE_MS = 5_000
const DEDUP_WINDOW_MS = 55_000
const WEIGHT_LOG_THROTTLE_MS = 300_000
// Prevents 1-tick noise from inflating short-window accuracy stats.
const EVAL_NOISE_FLOORS_BPS = {
  60000: 5,      // 1m: 5 bps (~$4 on $80k BTC) — noise filter
  300000: 10,    // 5m: 10 bps
  900000: 20,    // 15m: 20 bps
  3600000: 40,   // 1h: 40 bps
}

const BASE_WEIGHTS = INDICATOR_WEIGHTS
const ALL_TFS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']

/**
 * Compute adaptive indicator weights based on recent accuracy
 * @param {Record<string, {accuracy: number|null, predictions: number}>} byIndicator
 * @param {Record<string, number>} baseWeights - Original indicator weights
 * @param {Record<string, number>} prevWeights - Previous adaptive weights
 * @param {number} [alpha=0.15] - Exponential smoothing factor
 * @returns {Record<string, number>} Normalized adaptive weights summing to 1.0
 */
const computeAdaptiveWeights = (byIndicator, baseWeights, prevWeights, alpha = 0.15) => {
  // Find max prediction count across all indicators for activity ratio
  let maxPredictions = 0
  for (const ind of INDICATORS) {
    const count = byIndicator[ind]?.predictions ?? 0
    if (count > maxPredictions) maxPredictions = count
  }

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

    // Activity ratio penalty: penalize indicators that rarely produce non-neutral scores
    if (maxPredictions > 0) {
      const activityRatio = (data?.predictions ?? 0) / maxPredictions
      if (activityRatio < 0.05) {
        rawWeight *= 0.2 // nearly dead → 20% of base
      } else if (activityRatio < 0.20) {
        // Linear ramp from 0.2 to 0.7 between 5% and 20% activity
        const t = (activityRatio - 0.05) / 0.15
        rawWeight *= 0.2 + t * 0.5
      }
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

let predictionCounter = 0

/**
 * Classify a score into a directional prediction
 * @param {number} score
 * @returns {'up' | 'down' | 'neutral'}
 */
const getDirection = (score) => {
  if (score > DIRECTION_THRESHOLD) return 'up'
  if (score < -DIRECTION_THRESHOLD) return 'down'
  return 'neutral'
}

/**
 * Direction the scorecard journals. A raw +score that never printed BUY is a
 * skip, not an UP call — otherwise GATE CLOSED / HOLD / NO_TRADE_ZONE ticks
 * inflate UP precision with longs we never published. High-vol BUY uses a
 * lowered threshold (12), so the published type is the source of truth, not
 * getDirection's fixed 15.
 * @param {{score?: number, type?: string, trendGate?: {open?: boolean}}|null} result
 * @returns {'up' | 'down' | 'neutral'}
 */
const scorecardDirection = (result) => {
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
const appendRecord = async (record) => {
  if (!existsSync(SCORECARD_DIR)) {
    await mkdir(SCORECARD_DIR, { recursive: true })
  }
  const line = JSON.stringify(record) + '\n'
  await appendFile(getJournalPath(), line)
}

/**
 * Evaluate if a directional prediction was correct.
 *
 * Two products, two treatments of "didn't move":
 *  - `options` (default): no-move is a miss. A Crypto.com Up option that expires
 *    unchanged is out of the money.
 *  - `perp`: no-move is a scratch (null). A Coinbase perp flip that never reaches
 *    the noise floor is not a win or a loss — just not a trade.
 *
 * Pure/module-level so it can back both live evaluation and restart backfill (issue #212E).
 * @param {'up' | 'down' | 'neutral'} direction
 * @param {number} priceChangeBps
 * @param {number} [windowMs=300000] - Evaluation window in ms (determines noise floor)
 * @param {'options' | 'perp'} [mode='options']
 * @returns {boolean | null} null if skipped (neutral, or perp scratch)
 */
const evaluateDirection = (direction, priceChangeBps, windowMs = 300000, mode = 'options') => {
  if (direction === 'neutral') return null
  const noiseBps = EVAL_NOISE_FLOORS_BPS[windowMs] ?? 10
  if (mode === 'perp' && Math.abs(priceChangeBps) <= noiseBps) return null
  if (direction === 'up') return priceChangeBps > noiseBps
  return priceChangeBps < -noiseBps
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
  const compositeCorrect = evaluateDirection(prediction.compositeDirection, priceChangeBps, windowMs, 'options')
  const perpCorrect = evaluateDirection(prediction.compositeDirection, priceChangeBps, windowMs, 'perp')

  // Per-timeframe / per-indicator use perp mode so adaptive weights skip chops
  // instead of treating every no-move as "every indicator was wrong."
  const tfResults = {}
  for (const tf of ALL_TFS) {
    const tfData = prediction.timeframes?.[tf]
    if (!tfData) continue
    const direction = getDirection(tfData.score)
    tfResults[tf] = {
      direction,
      correct: evaluateDirection(direction, priceChangeBps, windowMs, 'perp'),
    }
  }

  const indicatorResults = {}
  for (const ind of INDICATORS) {
    let predictions = 0
    let correct = 0
    for (const tf of ALL_TFS) {
      const tfData = prediction.timeframes?.[tf]
      const indScore = tfData?.scores?.[ind]
      if (indScore == null) continue
      const direction = getDirection(indScore)
      if (direction === 'neutral') continue
      const hit = evaluateDirection(direction, priceChangeBps, windowMs, 'perp')
      if (hit == null) continue
      predictions++
      if (hit) correct++
    }
    indicatorResults[ind] = {
      predictions,
      correct,
      accuracy: predictions > 0 ? correct / predictions : null,
    }
  }

  // Contract outcome evaluation — only on the LONGEST window (1h), which best
  // represents the contract horizon. evaluateOutcome runs once per window
  // (1m/5m/15m/1h), so emitting contractOutcome on every window made
  // getMetrics count one prediction's contract result up to 4× (and it could
  // score win at 5m yet loss at 1h for the same contract) (issue #108).
  // Use Math.max (not [length-1]) so this stays correct if EVAL_WINDOWS is
  // ever reordered — the longest window is the contract horizon regardless.
  const isLongestWindow = windowMs === Math.max(...EVAL_WINDOWS)
  const contractOutcome = (prediction.contract && isLongestWindow)
    ? evaluateContractOutcome(prediction.contract, exitPrice)
    : null

  return {
    type: 'outcome',
    predictionId: prediction.id,
    ts: opts.ts ?? new Date().toISOString(),
    // predictionTs (issue #212D): byHour must bucket by the hour the PREDICTION was
    // made, not the settlement/evaluation hour (`ts` above, up to 1h later) — the
    // time-of-day multiplier in signal-engine.js applies byHour[predictionHour].
    predictionTs: prediction.ts,
    window: WINDOW_LABELS[windowMs],
    entryPrice: prediction.price,
    exitPrice,
    priceChangeBps: Math.round(priceChangeBps * 100) / 100,
    compositeScore: prediction.compositeScore ?? 0,
    compositeDirection: prediction.compositeDirection,
    compositeCorrect,
    perpCorrect,
    tfResults,
    indicatorResults,
    contractOutcome,
  }
}

/**
 * Evaluate whether a contract's target or stop was hit
 * @param {{target: number, stop: number, direction: string}} contractSnapshot
 * @param {number} exitPrice
 * @returns {'win' | 'loss' | null}
 */
const evaluateContractOutcome = (contractSnapshot, exitPrice) => {
  if (!contractSnapshot?.target || !contractSnapshot?.stop || !exitPrice) return null
  if (contractSnapshot.direction === 'up') {
    if (exitPrice >= contractSnapshot.target) return 'win'
    if (exitPrice <= contractSnapshot.stop) return 'loss'
  } else if (contractSnapshot.direction === 'down') {
    if (exitPrice <= contractSnapshot.target) return 'win'
    if (exitPrice >= contractSnapshot.stop) return 'loss'
  }
  return null
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
    if (record.type === 'outcome' && record.compositeCorrect != null && record.compositeDirection !== 'down') {
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
 *    `price` and outcomes' `exitPrice` in the same record set), falling back to the
 *    latest known price if the outage extended past every later record. If no price
 *    data exists at all, `exitPrice` is null and the caller should skip it (unsettleable).
 *
 * @param {Array<Object|null>} records - parsed JSONL records (predictions + outcomes), any order
 * @param {number} now - current time (ms), injected for testability
 * @returns {{
 *   pending: Array<{prediction: Object, windowMs: number, remainingMs: number}>,
 *   elapsed: Array<{prediction: Object, windowMs: number, targetTs: number, exitPrice: number|null}>
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
      // Only UP calls are unsettled (the ones we actually schedule live).
      if (record.price) priceTimeline.push({ ts, price: record.price })
      if (record.compositeDirection === 'up') {
        predictions.push({ ...record, _ts: ts })
      }
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
      for (const p of priceTimeline) {
        if (p.ts >= targetTs) { exitPrice = p.price; break }
      }
      if (exitPrice == null && priceTimeline.length > 0) {
        exitPrice = priceTimeline[priceTimeline.length - 1].price
      }
      elapsed.push({ prediction, windowMs, targetTs, exitPrice })
    }
  }

  return { pending, elapsed }
}

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
 * @param {Object} opts.io - Socket.IO server instance
 * @param {Function} opts.lastPriceFn - Returns current BTC price
 * @param {Function} [opts.contractFn] - Returns current contract config
 * @param {Function} [opts.journalWriter] - Testable persistence boundary
 * @param {{snapshot: Function, hydrate: Function, isLong: Function, serialize: Function}|null} [opts.perpBook] - Shared 1-BTC paper book
 * @returns {{recordPrediction: Function, recordPerpFill: Function, getMetrics: Function, start: Function, stop: Function}}
 */
const createScorecard = ({ io, lastPriceFn, contractFn, journalWriter = appendRecord, perpBook = null }) => {
  /** @type {Array<Object>} Ring buffer of evaluated outcomes */
  const outcomeBuffer = []

  /** @type {Set<NodeJS.Timeout>} Pending evaluation timeouts */
  const pendingTimeouts = new Set()

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
  const journal = {
    healthy: true,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
  }

  const persistRecord = (record) => Promise.resolve()
    .then(() => journalWriter(record))
    .then(() => {
      journal.lastSuccessAt = new Date().toISOString()
    })
    .catch((err) => {
      journal.healthy = false
      journal.lastError = err?.message || String(err)
      journal.lastErrorAt = new Date().toISOString()
      log('ERROR', `📊 Scorecard journal write failed type=${record?.type || 'unknown'} err=${journal.lastError}`)
    })

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
      log('WARN', `📊 Scorecard eval skipped — no price available predId=${prediction.id} window=${WINDOW_LABELS[windowMs]}`)
      return
    }

    const outcome = buildOutcomeRecord(prediction, windowMs, exitPrice)

    // Persist to JSONL
    persistRecord(outcome)

    // Push to ring buffer
    outcomeBuffer.push(outcome)
    if (outcomeBuffer.length > BUFFER_SIZE) {
      outcomeBuffer.splice(0, outcomeBuffer.length - BUFFER_SIZE)
    }

    // Throttled emit
    const now = Date.now()
    if (now - lastEmitTs >= EMIT_THROTTLE_MS) {
      lastEmitTs = now
      io.to('updown').emit('updown:scorecard', getMetrics())
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
      // DOWN and NEUTRAL are not longs we score. Still journal them.
      persistRecord(prediction)
      return
    }

    totalPredictions++

    // Persist prediction to JSONL
    persistRecord(prediction)

    log('INFO', `📊 Scorecard prediction=${prediction.id} price=$${prediction.price} dir=${prediction.compositeDirection} trigger=${trigger}`)

    // Schedule evaluations for each window
    for (const windowMs of EVAL_WINDOWS) {
      const timeout = setTimeout(() => {
        pendingTimeouts.delete(timeout)
        // evaluateOutcome is synchronous; a throw here would crash the
        // process from the timer callback.
        try {
          evaluateOutcome(prediction, windowMs)
        } catch (err) {
          log('WARN', `📊 Scorecard eval failed predId=${prediction.id} err=${err.message}`)
        }
      }, windowMs)
      pendingTimeouts.add(timeout)
    }
  }

  /**
   * Compute aggregate metrics from the outcome buffer
   * @returns {Object}
   */
  /**
   * Perp correctness: explicit field on new outcomes, derived from noise floor
   * for JSONL rows persisted before perpCorrect existed.
   * @param {Object} o
   * @returns {boolean | null}
   */
  const resolvePerpCorrect = (o) => {
    if (o.perpCorrect !== undefined) return o.perpCorrect
    if (o.compositeCorrect == null) return null
    const floor = EVAL_NOISE_FLOORS_BPS[WINDOW_MS[o.window]] ?? 10
    if (Math.abs(o.priceChangeBps ?? 0) <= floor) return null
    return o.compositeCorrect
  }

  const getMetrics = () => {
    const scored = outcomeBuffer.filter(o => o.compositeDirection !== 'down')
    const evaluated = scored.filter(o => o.compositeCorrect != null)
    const correct = evaluated.filter(o => o.compositeCorrect === true)
    const incorrect = evaluated.filter(o => o.compositeCorrect === false)
    const perpEvaluated = scored.filter(o => resolvePerpCorrect(o) != null)
    const perpCorrectHits = perpEvaluated.filter(o => resolvePerpCorrect(o) === true)

    // Streak (consecutive correct/incorrect from most recent)
    let streak = 0
    for (let i = evaluated.length - 1; i >= 0; i--) {
      if (i === evaluated.length - 1) {
        streak = evaluated[i].compositeCorrect ? 1 : -1
      } else {
        const prev = evaluated[i].compositeCorrect
        if ((streak > 0 && prev) || (streak < 0 && !prev)) {
          streak += streak > 0 ? 1 : -1
        } else {
          break
        }
      }
    }

    // Average BPS for correct/incorrect
    const avgCorrectBps = correct.length > 0
      ? Math.round(correct.reduce((s, o) => s + Math.abs(o.priceChangeBps), 0) / correct.length * 100) / 100
      : 0
    const avgIncorrectBps = incorrect.length > 0
      ? Math.round(incorrect.reduce((s, o) => s + Math.abs(o.priceChangeBps), 0) / incorrect.length * 100) / 100
      : 0

    // By window
    const byWindow = {}
    for (const label of Object.values(WINDOW_LABELS)) {
      const windowOutcomes = scored.filter(o => o.window === label && o.compositeCorrect != null)
      const wCorrect = windowOutcomes.filter(o => o.compositeCorrect === true).length
      const perpWindow = scored.filter(o => o.window === label && resolvePerpCorrect(o) != null)
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

    // By timeframe
    const byTimeframe = {}
    for (const tf of ALL_TFS) {
      let tfTotal = 0
      let tfCorrect = 0
      for (const o of scored) {
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

    // By indicator — weighted by composite signal strength so strong signals influence
    // adaptive weights more than marginal ones (score 30 = 1x, score 60+ = 2x, score ~0 = ~0x)
    const byIndicator = {}
    for (const ind of INDICATORS) {
      let indTotal = 0
      let indCorrect = 0
      let rawCount = 0
      for (const o of scored) {
        const indResult = o.indicatorResults?.[ind]
        if (!indResult || indResult.predictions === 0) continue
        // Weight by signal strength; records without compositeScore default to 1x (backward compat)
        const strengthWeight = o.compositeScore != null
          ? Math.min(2, Math.abs(o.compositeScore) / 30)
          : 1.0
        indTotal += indResult.predictions * strengthWeight
        indCorrect += indResult.correct * strengthWeight
        rawCount += indResult.predictions
      }
      byIndicator[ind] = {
        accuracy: indTotal > 0 ? Math.round(indCorrect / indTotal * 10000) / 100 : null,
        predictions: rawCount, // unweighted count for activity ratio in adaptive weights
      }
    }

    // Time-of-day multiplier in signal-engine assumes 50% = coin-flip. Options
    // mode (flat = miss) sits well below 50% on 1m/5m, so every hour would
    // clamp to the 0.90 floor. Perp correctness (flat = scratch) restores that
    // 50% baseline — same switch already applied to byIndicator.
    const byHour = computeByHour(scored.map(o => ({
      ...o,
      compositeCorrect: resolvePerpCorrect(o),
    })))

    // Contract-aware accuracy
    const contractOutcomes = scored.filter(o => o.contractOutcome != null)
    const contractWins = contractOutcomes.filter(o => o.contractOutcome === 'win').length
    const contractLosses = contractOutcomes.filter(o => o.contractOutcome === 'loss').length
    const contractAware = contractOutcomes.length > 0 ? {
      accuracy: Math.round(contractWins / contractOutcomes.length * 10000) / 100,
      wins: contractWins,
      losses: contractLosses,
      total: contractOutcomes.length,
    } : null

    // Recompute adaptive weights
    adaptiveWeights = computeAdaptiveWeights(byIndicator, BASE_WEIGHTS, adaptiveWeights)

    // Throttled weight logging to JSONL
    const weightNow = Date.now()
    if (weightNow - lastWeightLogTs >= WEIGHT_LOG_THROTTLE_MS) {
      lastWeightLogTs = weightNow
      persistRecord({
        type: 'weights',
        ts: new Date().toISOString(),
        weights: { ...adaptiveWeights },
        byIndicator: { ...byIndicator },
      })
    }

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
  const loadHistory = async () => {
    if (!existsSync(SCORECARD_DIR)) return

    const files = await readdir(SCORECARD_DIR)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort()
    // Load last 7 days of data (matches BUFFER_SIZE of ~2000 outcomes)
    const recentFiles = jsonlFiles.slice(-7)

    // Neutrals are skips, not predictions — tallyHistory excludes them from
    // totalPredictions so reload mirrors live counting (issue #158).
    let loaded = 0
    let predictions = 0
    let skipped = 0
    /** @type {Array<Object|null>} All records across loaded files, for issue #212E backfill */
    const allRecords = []
    for (const file of recentFiles) {
      const content = await readFile(path.join(SCORECARD_DIR, file), 'utf8').catch(() => '')
      const records = content.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      allRecords.push(...records)
      const tally = tallyHistory(records)
      for (const outcome of tally.outcomes) outcomeBuffer.push(outcome)
      loaded += tally.outcomes.length
      predictions += tally.totalPredictions
      skipped += tally.skipCount
    }

    // Issue #212E: predictions in flight at shutdown are otherwise never settled —
    // their evaluation lived only in a setTimeout that stop() cleared. Backfill
    // windows that already elapsed against the best available recorded price, and
    // reschedule real timers for windows still open so live evaluation picks them
    // up normally.
    const now = Date.now()
    const { pending, elapsed } = findUnsettledPredictions(allRecords, now)

    let backfilled = 0
    for (const { prediction, windowMs, exitPrice } of elapsed) {
      if (exitPrice == null) continue // no price data available at all — unsettleable
      const outcome = buildOutcomeRecord(prediction, windowMs, exitPrice)
      outcome.backfilled = true
      persistRecord(outcome)
      outcomeBuffer.push(outcome)
      backfilled++
    }

    for (const { prediction, windowMs, remainingMs } of pending) {
      const timeout = setTimeout(() => {
        pendingTimeouts.delete(timeout)
        try {
          evaluateOutcome(prediction, windowMs)
        } catch (err) {
          log('WARN', `📊 Scorecard backfill eval failed predId=${prediction.id} err=${err.message}`)
        }
      }, remainingMs)
      pendingTimeouts.add(timeout)
    }

    if (backfilled > 0 || pending.length > 0) {
      log('INFO', `📊 Scorecard restart recovery: backfilled=${backfilled} elapsed outcomes, rescheduled=${pending.length} pending windows`)
    }

    // Trim to buffer size
    if (outcomeBuffer.length > BUFFER_SIZE) {
      outcomeBuffer.splice(0, outcomeBuffer.length - BUFFER_SIZE)
    }

    totalPredictions = predictions
    totalSkipped = skipped

    // Rebuild the paper book from journaled fills only when the live snapshot
    // is empty (fresh process with no updown-state.json perpBook).
    if (perpBook && !perpBook.isLong() && perpBook.snapshot().rounds === 0 && perpBook.snapshot().realizedPnl === 0) {
      const fillRecords = allRecords
        .filter(r => r?.type === 'perp_fill')
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      if (fillRecords.length > 0) {
        const replay = createPerpBook()
        for (const rec of fillRecords) {
          const action = rec.action
            || (rec.side === 'sell' ? 'CLOSE' : rec.side === 'buy' ? (replay.isLong() ? 'ADD' : 'OPEN') : 'HOLD')
          replay.applyFill(action, rec.price, Date.parse(rec.ts) || rec.ts)
        }
        perpBook.hydrate(replay.serialize())
        log('INFO', `📊 Scorecard rebuilt perp book from journal fills=${fillRecords.length} contracts=${perpBook.snapshot().contracts}`)
      }
    }

    log('INFO', `📊 Scorecard loaded history outcomes=${loaded} predictions=${predictions} skipped=${skipped} files=${recentFiles.length}`)
  }

  /**
   * Start auto-sampling predictions at the configured interval
   * @param {Function} computeSignals - Function that returns signal engine output
   */
  /**
   * Prune scorecard JSONL files older than retentionDays
   * @param {number} [retentionDays=30] - Number of days to keep
   */
  const pruneHistory = async (retentionDays = 30) => {
    if (!existsSync(SCORECARD_DIR)) return
    const files = await readdir(SCORECARD_DIR)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort()
    if (jsonlFiles.length <= retentionDays) return

    const toDelete = jsonlFiles.slice(0, jsonlFiles.length - retentionDays)
    let deleted = 0
    for (const file of toDelete) {
      await require('fs/promises').unlink(path.join(SCORECARD_DIR, file)).catch(() => {})
      deleted++
    }
    if (deleted > 0) {
      log('INFO', `📊 Scorecard pruned ${deleted} files older than ${retentionDays} days`)
    }
  }

  const start = async (computeSignals) => {
    computeSignalsFn = computeSignals

    // Prune old scorecard data on startup (keep 30 days)
    await pruneHistory(30).catch(err => log('WARN', `📊 Scorecard prune failed err=${err.message}`))

    // Hydrate from disk and emit initial metrics
    await loadHistory().catch(err => log('WARN', `📊 Scorecard history load failed err=${err.message}`))
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
        recordPrediction(computeSignalsFn(), 'interval')
      } catch (err) {
        log('WARN', `📊 Scorecard sample failed err=${err.message}`)
      }
    }, SAMPLE_INTERVAL_MS)

    // Daily prune of old scorecard files (every 24h)
    pruneTimer = setInterval(() => pruneHistory(30).catch(err => log('WARN', `📊 Scorecard prune failed err=${err.message}`)), 24 * 60 * 60 * 1000)

    log('INFO', '📊 Scorecard started interval=60s windows=[1m,5m,15m,1h] primary=[1m,5m] upOnly=true')
  }

  /**
   * Stop the scorecard, clearing all pending timeouts
   */
  const stop = () => {
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
    computeSignalsFn = null
    log('INFO', `📊 Scorecard stopped predictions=${totalPredictions} evaluated=${outcomeBuffer.length}`)
  }

  return { recordPrediction, recordPerpFill, getMetrics, start, stop }
}

module.exports = {
  createScorecard,
  computeAdaptiveWeights,
  evaluateContractOutcome,
  tallyHistory,
  evaluateDirection,
  buildOutcomeRecord,
  findUnsettledPredictions,
  computeByHour,
  PRIMARY_WINDOWS,
  scorecardDirection,
}
