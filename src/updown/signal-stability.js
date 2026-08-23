// @ts-check
/**
 * Published-signal stability: persistence + hysteresis so 5s threshold
 * kisses do not print BUY/SELL, while a real clip stays printed through fade.
 *
 * Pure functions. The signal engine holds state across computeSignals calls;
 * Date.now (patched in backtests) is the clock.
 */

const MIN_ENTER_MS = 60_000
const MIN_EXIT_MS = 15_000
const EXIT_BUY_SCORE = 12
const EXIT_SELL_SCORE = -12

const BUY_SIDE = new Set(['BUY', 'STRONG_BUY'])
const SELL_SIDE = new Set(['SELL', 'STRONG_SELL'])

const isBuy = (t) => BUY_SIDE.has(t)
const isSell = (t) => SELL_SIDE.has(t)
const isStrong = (t) => t === 'STRONG_BUY' || t === 'STRONG_SELL'

/**
 * @returns {{publishedType: string, publishedAt: number, pendingType: string|null, pendingSince: number}}
 */
const createStabilityState = () => ({
  publishedType: 'NEUTRAL',
  publishedAt: 0,
  pendingType: null,
  pendingSince: 0,
})

/**
 * Neutral-band edge used by scoreToSignalDynamic (atr-scaled).
 * BUY is strictly greater than this value.
 * @param {number} atrRatio
 * @returns {number}
 */
const neutralThresholdFor = (atrRatio) => {
  let n = 15
  if (atrRatio < 0.7) {
    const t = Math.max(0, (0.7 - atrRatio) / 0.7)
    n = 15 + t * 7
  } else if (atrRatio > 1.5) {
    const t = Math.min(1, (atrRatio - 1.5) / 1.5)
    n = 15 - t * 3
  }
  return n
}

/**
 * Tick-momentum may amplify a published directional type, but must not
 * shove a HOLD score across the BUY/SELL line.
 * @param {string} publishedType
 * @param {number} _rawScore
 * @param {number} boostedScore
 * @param {number} atrRatio
 * @returns {number}
 */
const clampScoreToExistingType = (publishedType, _rawScore, boostedScore, atrRatio) => {
  if (isBuy(publishedType) || isSell(publishedType)) return boostedScore
  const thr = neutralThresholdFor(atrRatio)
  if (boostedScore > thr) return thr
  if (boostedScore < -thr) return -thr
  return boostedScore
}

/**
 * Tick-momentum must not *create* a direction from HOLD, or *cancel* one
 * into HOLD. BUY↔SELL is a real engine decision and is allowed through.
 * @param {string} typeBefore
 * @param {string} typeAfter
 * @returns {string}
 */
/**
 * The 60s scorecard sampler has its own stabilize clock. Two interval
 * ticks can confirm BUY while the live 5s engine never published it.
 * Journal the banner type so UP precision only scores clips the operator saw.
 * @param {{type?: string}|null} scorecardResult
 * @param {string|null|undefined} liveType
 * @returns {{type?: string}|null}
 */
const alignJournalType = (scorecardResult, liveType) => {
  if (!scorecardResult) return scorecardResult
  if (liveType) scorecardResult.type = liveType
  return scorecardResult
}

const preventTickCreatedSignal = (typeBefore, typeAfter) => {
  const beforeDir = isBuy(typeBefore) ? 'buy' : isSell(typeBefore) ? 'sell' : 'none'
  const afterDir = isBuy(typeAfter) ? 'buy' : isSell(typeAfter) ? 'sell' : 'none'
  if (beforeDir === 'none' && afterDir !== 'none') return typeBefore || 'NEUTRAL'
  if (beforeDir !== 'none' && afterDir === 'none') return typeBefore
  return typeAfter
}

/**
 * @param {{rawType: string, score: number, now: number}} input
 * @param {{publishedType: string, publishedAt: number, pendingType: string|null, pendingSince: number}} [prev]
 * @returns {{type: string, state: {publishedType: string, publishedAt: number, pendingType: string|null, pendingSince: number}}}
 */
const stabilizeSignal = (input, prev) => {
  const rawType = input?.rawType || 'NEUTRAL'
  const score = Number.isFinite(input?.score) ? input.score : 0
  const now = Number.isFinite(input?.now) ? input.now : 0
  const state = prev || createStabilityState()
  const published = state.publishedType || 'NEUTRAL'

  const publish = (type) => ({
    type,
    state: { publishedType: type, publishedAt: now, pendingType: null, pendingSince: 0 },
  })

  if (rawType === 'NO_TRADE_ZONE') return publish('NO_TRADE_ZONE')
  if (isStrong(rawType)) return publish(rawType)

  if (isBuy(published)) {
    // A raw SELL is an EXIT path — do not dump to HOLD just because score is red.
    if (isSell(rawType)) {
      const pendingSince = state.pendingType === 'SELL' ? state.pendingSince : now
      if (now - pendingSince >= MIN_EXIT_MS) return publish('SELL')
      return {
        type: published,
        state: { publishedType: published, publishedAt: state.publishedAt, pendingType: 'SELL', pendingSince },
      }
    }
    if (score < EXIT_BUY_SCORE && !isBuy(rawType)) return publish('NEUTRAL')
    if (!isBuy(rawType)) {
      const pendingSince = state.pendingType === 'NEUTRAL' ? state.pendingSince : now
      if (now - pendingSince >= MIN_ENTER_MS) return publish('NEUTRAL')
      return {
        type: published,
        state: { publishedType: published, publishedAt: state.publishedAt, pendingType: 'NEUTRAL', pendingSince },
      }
    }
    const next = rawType === 'STRONG_BUY' ? 'STRONG_BUY' : 'BUY'
    return {
      type: next,
      state: { publishedType: next, publishedAt: state.publishedAt, pendingType: null, pendingSince: 0 },
    }
  }

  if (isSell(published)) {
    if (score > EXIT_SELL_SCORE && !isSell(rawType)) return publish('NEUTRAL')
    if (isBuy(rawType)) {
      const pendingSince = state.pendingType === 'BUY' ? state.pendingSince : now
      if (now - pendingSince >= MIN_ENTER_MS) return publish('BUY')
      return {
        type: published,
        state: { publishedType: published, publishedAt: state.publishedAt, pendingType: 'BUY', pendingSince },
      }
    }
    if (!isSell(rawType)) {
      const pendingSince = state.pendingType === 'NEUTRAL' ? state.pendingSince : now
      if (now - pendingSince >= MIN_EXIT_MS) return publish('NEUTRAL')
      return {
        type: published,
        state: { publishedType: published, publishedAt: state.publishedAt, pendingType: 'NEUTRAL', pendingSince },
      }
    }
    const next = rawType === 'STRONG_SELL' ? 'STRONG_SELL' : 'SELL'
    return {
      type: next,
      state: { publishedType: next, publishedAt: state.publishedAt, pendingType: null, pendingSince: 0 },
    }
  }

  // HOLD / NEUTRAL / unknown
  if (isBuy(rawType)) {
    const pendingSince = state.pendingType === 'BUY' ? state.pendingSince : now
    if (now - pendingSince >= MIN_ENTER_MS) return publish('BUY')
    return {
      type: 'NEUTRAL',
      state: { publishedType: 'NEUTRAL', publishedAt: state.publishedAt, pendingType: 'BUY', pendingSince },
    }
  }
  if (isSell(rawType)) {
    const pendingSince = state.pendingType === 'SELL' ? state.pendingSince : now
    if (now - pendingSince >= MIN_EXIT_MS) return publish('SELL')
    return {
      type: 'NEUTRAL',
      state: { publishedType: 'NEUTRAL', publishedAt: state.publishedAt, pendingType: 'SELL', pendingSince },
    }
  }

  return {
    type: 'NEUTRAL',
    state: { publishedType: 'NEUTRAL', publishedAt: state.publishedAt, pendingType: null, pendingSince: 0 },
  }
}

module.exports = {
  createStabilityState,
  stabilizeSignal,
  preventTickCreatedSignal,
  alignJournalType,
  clampScoreToExistingType,
  neutralThresholdFor,
  MIN_ENTER_MS,
  MIN_EXIT_MS,
  EXIT_BUY_SCORE,
  EXIT_SELL_SCORE,
}
