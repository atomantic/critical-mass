// @ts-check
/**
 * Signal Prediction Scorecard
 *
 * Tracks predictions from the UpDown signal engine, evaluates outcomes
 * after configurable time windows, and computes per-indicator/per-timeframe
 * accuracy metrics for real-time monitoring.
 */

const { appendFile, mkdir } = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const { log } = require('../logger')
const { UPDOWN_DATA_DIR } = require('../paths')

const SCORECARD_DIR = path.join(UPDOWN_DATA_DIR, 'scorecard')
const SAMPLE_INTERVAL_MS = 60_000
const EVAL_WINDOWS = [60_000, 300_000, 900_000, 3_600_000]
const WINDOW_LABELS = { 60000: '1m', 300000: '5m', 900000: '15m', 3600000: '1h' }
const DIRECTION_THRESHOLD = 15
const BUFFER_SIZE = 500
const EMIT_THROTTLE_MS = 5_000
const DEDUP_WINDOW_MS = 55_000
const INDICATORS = ['rsi', 'stochastic', 'macd', 'bollinger', 'vwap', 'momentum']
const BASE_WEIGHTS = { rsi: 0.25, stochastic: 0.20, macd: 0.20, bollinger: 0.15, vwap: 0.10, momentum: 0.10 }
const ALL_TFS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d']

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
    if (data?.accuracy != null && data.predictions >= 10) {
      if (data.accuracy > 55) rawWeight = base * 1.3
      else if (data.accuracy < 45) rawWeight = base * 0.7
    }
    rawWeights[ind] = alpha * rawWeight + (1 - alpha) * prev
  }

  // Floor at 0.05
  for (const ind of INDICATORS) {
    if (rawWeights[ind] < 0.05) rawWeights[ind] = 0.05
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
 * Create a scorecard instance
 * @param {Object} opts
 * @param {Object} opts.io - Socket.IO server instance
 * @param {Function} opts.lastPriceFn - Returns current BTC price
 * @returns {{recordPrediction: Function, getMetrics: Function, start: Function, stop: Function}}
 */
const createScorecard = ({ io, lastPriceFn }) => {
  /** @type {Array<Object>} Ring buffer of evaluated outcomes */
  const outcomeBuffer = []

  /** @type {Set<NodeJS.Timeout>} Pending evaluation timeouts */
  const pendingTimeouts = new Set()

  /** @type {NodeJS.Timeout | null} */
  let sampleInterval = null

  /** @type {Function | null} */
  let computeSignalsFn = null

  let lastSampleTs = 0
  let lastEmitTs = 0
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
    const compositeCorrect = evaluateDirection(prediction.compositeDirection, priceChangeBps)

    // Per-timeframe evaluation
    const tfResults = {}
    for (const tf of ALL_TFS) {
      const tfData = prediction.timeframes[tf]
      if (!tfData) continue
      const direction = getDirection(tfData.score)
      tfResults[tf] = {
        direction,
        correct: evaluateDirection(direction, priceChangeBps),
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
        if (evaluateDirection(direction, priceChangeBps)) correct++
      }
      indicatorResults[ind] = {
        predictions,
        correct,
        accuracy: predictions > 0 ? correct / predictions : null,
      }
    }

    const outcome = {
      type: 'outcome',
      predictionId: prediction.id,
      ts: new Date().toISOString(),
      window: WINDOW_LABELS[windowMs],
      entryPrice: prediction.price,
      exitPrice,
      priceChangeBps: Math.round(priceChangeBps * 100) / 100,
      compositeDirection: prediction.compositeDirection,
      compositeCorrect,
      tfResults,
      indicatorResults,
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
   * Evaluate if a directional prediction was correct
   * @param {'up' | 'down' | 'neutral'} direction
   * @param {number} priceChangeBps
   * @returns {boolean | null} null if neutral (skipped)
   */
  const evaluateDirection = (direction, priceChangeBps) => {
    if (direction === 'neutral') return null
    if (direction === 'up') return priceChangeBps > 0
    return priceChangeBps < 0
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

    // By indicator
    const byIndicator = {}
    for (const ind of INDICATORS) {
      let indTotal = 0
      let indCorrect = 0
      for (const o of outcomeBuffer) {
        const indResult = o.indicatorResults?.[ind]
        if (!indResult || indResult.predictions === 0) continue
        indTotal += indResult.predictions
        indCorrect += indResult.correct
      }
      byIndicator[ind] = {
        accuracy: indTotal > 0 ? Math.round(indCorrect / indTotal * 10000) / 100 : null,
        predictions: indTotal,
      }
    }

    // Recompute adaptive weights
    adaptiveWeights = computeAdaptiveWeights(byIndicator, BASE_WEIGHTS, adaptiveWeights)

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
   * Start auto-sampling predictions at the configured interval
   * @param {Function} computeSignals - Function that returns signal engine output
   */
  const start = (computeSignals) => {
    computeSignalsFn = computeSignals
    sampleInterval = setInterval(() => {
      if (!computeSignalsFn) return
      const now = Date.now()
      // De-dup: if a signal_change was recorded within DEDUP_WINDOW_MS, skip this sample
      if (now - lastSampleTs < DEDUP_WINDOW_MS) return
      lastSampleTs = now
      const result = computeSignalsFn()
      recordPrediction(result, 'interval')
    }, SAMPLE_INTERVAL_MS)
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
    for (const t of pendingTimeouts) {
      clearTimeout(t)
    }
    pendingTimeouts.clear()
    computeSignalsFn = null
    log('INFO', `📊 Scorecard stopped predictions=${totalPredictions} evaluated=${outcomeBuffer.length}`)
  }

  return { recordPrediction, getMetrics, start, stop }
}

module.exports = { createScorecard, computeAdaptiveWeights }
