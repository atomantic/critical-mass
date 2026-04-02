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

const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard')
const SAMPLE_INTERVAL_MS = 60_000
const EVAL_WINDOWS = [60_000, 300_000, 900_000, 3_600_000]
const WINDOW_LABELS = { 60000: '1m', 300000: '5m', 900000: '15m', 3600000: '1h' }
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

const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum', 'obv']
const BASE_WEIGHTS = { rsi: 0.12, stochastic: 0.10, macd: 0.24, bollinger: 0.08, vwap: 0.09, momentum: 0.17, obv: 0.20 }
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
 * Create a scorecard instance
 * @param {Object} opts
 * @param {Object} opts.io - Socket.IO server instance
 * @param {Function} opts.lastPriceFn - Returns current BTC price
 * @param {Function} [opts.contractFn] - Returns current contract config
 * @returns {{recordPrediction: Function, getMetrics: Function, start: Function, stop: Function}}
 */
const createScorecard = ({ io, lastPriceFn, contractFn }) => {
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

  /**
   * Build a prediction record from signal engine output
   * @param {Object} result - Output from signalEngine.computeSignals()
   * @param {'interval' | 'signal_change'} trigger
   * @returns {Object | null} Prediction record, or null if neutral
   */
  const buildPrediction = (result, trigger) => {
    const price = lastPriceFn()
    if (!price) return null

    const compositeDirection = getDirection(result.score)
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

    const priceChangeBps = ((exitPrice - prediction.price) / prediction.price) * 10000
    const compositeCorrect = evaluateDirection(prediction.compositeDirection, priceChangeBps, windowMs)

    // Per-timeframe evaluation
    const tfResults = {}
    for (const tf of ALL_TFS) {
      const tfData = prediction.timeframes[tf]
      if (!tfData) continue
      const direction = getDirection(tfData.score)
      tfResults[tf] = {
        direction,
        correct: evaluateDirection(direction, priceChangeBps, windowMs),
      }
    }

    // Per-indicator evaluation (across all timeframes)
    const indicatorResults = {}
    for (const ind of INDICATORS) {
      let predictions = 0
      let correct = 0
      for (const tf of ALL_TFS) {
        const tfData = prediction.timeframes[tf]
        const indScore = tfData?.scores?.[ind]
        if (indScore == null) continue
        const direction = getDirection(indScore)
        if (direction === 'neutral') continue
        predictions++
        if (evaluateDirection(direction, priceChangeBps, windowMs)) correct++
      }
      indicatorResults[ind] = {
        predictions,
        correct,
        accuracy: predictions > 0 ? correct / predictions : null,
      }
    }

    // Contract outcome evaluation
    const contractOutcome = prediction.contract
      ? evaluateContractOutcome(prediction.contract, exitPrice)
      : null

    const outcome = {
      type: 'outcome',
      predictionId: prediction.id,
      ts: new Date().toISOString(),
      window: WINDOW_LABELS[windowMs],
      entryPrice: prediction.price,
      exitPrice,
      priceChangeBps: Math.round(priceChangeBps * 100) / 100,
      compositeScore: prediction.compositeScore ?? 0,
      compositeDirection: prediction.compositeDirection,
      compositeCorrect,
      tfResults,
      indicatorResults,
      contractOutcome,
    }

    // Persist to JSONL
    appendRecord(outcome).catch(() => {})

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
   * Evaluate if a directional prediction was correct.
   * Requires a minimum price move (noise floor) to avoid counting 1-tick fluctuations.
   * @param {'up' | 'down' | 'neutral'} direction
   * @param {number} priceChangeBps
   * @param {number} [windowMs=300000] - Evaluation window in ms (determines noise floor)
   * @returns {boolean | null} null if neutral (skipped)
   */
  const evaluateDirection = (direction, priceChangeBps, windowMs = 300000) => {
    if (direction === 'neutral') return null
    const noiseBps = EVAL_NOISE_FLOORS_BPS[windowMs] ?? 10
    if (direction === 'up') return priceChangeBps > noiseBps
    return priceChangeBps < -noiseBps
  }

  /**
   * Record a prediction and schedule evaluations
   * @param {Object} result - Signal engine output
   * @param {'interval' | 'signal_change'} trigger
   */
  const recordPrediction = (result, trigger) => {
    const prediction = buildPrediction(result, trigger)
    if (!prediction) return

    // Track de-duplication: signal_change within 55s of last sample skips next interval
    if (trigger === 'signal_change') {
      const now = Date.now()
      if (now - lastSampleTs < DEDUP_WINDOW_MS) {
        // This signal_change is close to a sample — skip next interval
        lastSampleTs = now
      }
    }

    if (prediction.compositeDirection === 'neutral') {
      totalSkipped++
      // Still log to JSONL for analysis, but don't schedule evaluations
      appendRecord(prediction).catch(() => {})
      return
    }

    totalPredictions++

    // Persist prediction to JSONL
    appendRecord(prediction).catch(() => {})

    log('INFO', `📊 Scorecard prediction=${prediction.id} price=$${prediction.price} dir=${prediction.compositeDirection} trigger=${trigger}`)

    // Schedule evaluations for each window
    for (const windowMs of EVAL_WINDOWS) {
      const timeout = setTimeout(() => {
        pendingTimeouts.delete(timeout)
        evaluateOutcome(prediction, windowMs)
      }, windowMs)
      pendingTimeouts.add(timeout)
    }
  }

  /**
   * Compute aggregate metrics from the outcome buffer
   * @returns {Object}
   */
  const getMetrics = () => {
    const evaluated = outcomeBuffer.filter(o => o.compositeCorrect != null)
    const correct = evaluated.filter(o => o.compositeCorrect === true)
    const incorrect = evaluated.filter(o => o.compositeCorrect === false)

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
      const windowOutcomes = outcomeBuffer.filter(o => o.window === label && o.compositeCorrect != null)
      const wCorrect = windowOutcomes.filter(o => o.compositeCorrect === true).length
      byWindow[label] = {
        accuracy: windowOutcomes.length > 0 ? Math.round(wCorrect / windowOutcomes.length * 10000) / 100 : null,
        correct: wCorrect,
        incorrect: windowOutcomes.length - wCorrect,
        total: windowOutcomes.length,
      }
    }

    // By timeframe
    const byTimeframe = {}
    for (const tf of ALL_TFS) {
      let tfTotal = 0
      let tfCorrect = 0
      for (const o of outcomeBuffer) {
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
      for (const o of outcomeBuffer) {
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

    // By UTC hour accuracy (minimum 5 samples)
    const byHour = {}
    for (const o of outcomeBuffer) {
      if (o.compositeCorrect == null || !o.ts) continue
      const hour = new Date(o.ts).getUTCHours()
      if (!byHour[hour]) byHour[hour] = { correct: 0, total: 0 }
      byHour[hour].total++
      if (o.compositeCorrect) byHour[hour].correct++
    }
    for (const h of Object.keys(byHour)) {
      const d = byHour[h]
      byHour[h].accuracy = d.total >= 5 ? Math.round(d.correct / d.total * 10000) / 100 : null
    }

    // Contract-aware accuracy
    const contractOutcomes = outcomeBuffer.filter(o => o.contractOutcome != null)
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
      appendRecord({
        type: 'weights',
        ts: new Date().toISOString(),
        weights: { ...adaptiveWeights },
        byIndicator: { ...byIndicator },
      }).catch(() => {})
    }

    // Last prediction info
    const lastPred = outcomeBuffer.length > 0 ? outcomeBuffer[outcomeBuffer.length - 1] : null

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
      byWindow,
      byTimeframe,
      byIndicator,
      byHour,
      contractAware,
      adaptiveWeights,
      lastPrediction: lastPred ? {
        ts: lastPred.ts,
        price: lastPred.entryPrice,
        direction: lastPred.compositeDirection,
        signalType: lastPred.compositeDirection,
      } : null,
      timestamp: new Date().toISOString(),
    }
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

    let loaded = 0
    let predCount = 0
    let skipCount = 0
    for (const file of recentFiles) {
      const content = await readFile(path.join(SCORECARD_DIR, file), 'utf8').catch(() => '')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (!record) continue
        if (record.type === 'outcome' && record.compositeCorrect != null) {
          outcomeBuffer.push(record)
          loaded++
        } else if (record.type === 'prediction') {
          predCount++
          if (record.compositeDirection === 'neutral') skipCount++
        }
      }
    }

    // Trim to buffer size
    if (outcomeBuffer.length > BUFFER_SIZE) {
      outcomeBuffer.splice(0, outcomeBuffer.length - BUFFER_SIZE)
    }

    totalPredictions = predCount
    totalSkipped = skipCount
    log('INFO', `📊 Scorecard loaded history outcomes=${loaded} predictions=${predCount} skipped=${skipCount} files=${recentFiles.length}`)
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
      const result = computeSignalsFn()
      recordPrediction(result, 'interval')
    }, SAMPLE_INTERVAL_MS)

    // Daily prune of old scorecard files (every 24h)
    pruneTimer = setInterval(() => pruneHistory(30).catch(() => {}), 24 * 60 * 60 * 1000)

    log('INFO', '📊 Scorecard started interval=60s windows=[1m,5m,15m,1h]')
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

  return { recordPrediction, getMetrics, start, stop }
}

module.exports = { createScorecard, computeAdaptiveWeights, evaluateContractOutcome }
