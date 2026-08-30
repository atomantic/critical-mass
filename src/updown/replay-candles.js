// @ts-check
/**
 * Causal candle helpers shared by historical UpDown replay tools.
 * Candle timestamps identify bucket starts; only buckets whose end is at or
 * before the decision time may be visible to a replayed signal.
 */

const { TIMEFRAMES, TIMEFRAME_KEYS } = require('../candle-aggregator')

const TF_MS = Object.fromEntries(
  Object.entries(TIMEFRAMES).map(([tf, config]) => [tf, config.intervalMs]),
)

/** Find the final candle whose start timestamp is <= targetTs. */
const findLastIndex = (candles, targetTs) => {
  let lo = 0
  let hi = candles.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (candles[mid].timestamp <= targetTs) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * Seed an aggregator with completed candles only.
 * @param {{seedCandles: Function}} aggregator
 * @param {Record<string, Array<Object>>} candlesByTimeframe
 * @param {number} decisionTs
 * @param {string[]} [timeframes]
 */
const seedCompletedCandles = (
  aggregator,
  candlesByTimeframe,
  decisionTs,
  timeframes = TIMEFRAME_KEYS,
) => {
  for (const tf of timeframes) {
    const candles = candlesByTimeframe[tf]
    const intervalMs = TF_MS[tf]
    if (!intervalMs || !candles?.length) continue
    const lastIdx = findLastIndex(candles, decisionTs - intervalMs)
    if (lastIdx < 0) continue
    const maxCandles = TIMEFRAMES[tf]?.maxCandles ?? 200
    const firstIdx = Math.max(0, lastIdx + 1 - maxCandles)
    aggregator.seedCandles(tf, candles.slice(firstIdx, lastIdx + 1), decisionTs)
  }
}

module.exports = { TF_MS, findLastIndex, seedCompletedCandles }
