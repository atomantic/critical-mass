/**
 * Pure functions for computing full-series technical indicators from OHLC candle arrays.
 * All functions return arrays aligned by index with the input candle array.
 * Entries with insufficient lookback data are null.
 */

/**
 * Donchian midline: average of highest-high and lowest-low over `period` candles.
 * @param {Array<{high: number, low: number}>} candles
 * @param {number} period
 * @returns {Array<number|null>}
 */
export const donchian = (candles, period) => {
  const result = new Array(candles.length).fill(null)
  for (let i = period - 1; i < candles.length; i++) {
    let highest = -Infinity
    let lowest = Infinity
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high
      if (candles[j].low < lowest) lowest = candles[j].low
    }
    result[i] = (highest + lowest) / 2
  }
  return result
}

/**
 * Compute Atomoku (custom Ichimoku) indicator series.
 * @param {Array<{open: number, high: number, low: number, close: number}>} candles
 * @param {{ convPeriod?: number, basePeriod?: number, leadPeriod?: number, displacement?: number }} [config]
 * @returns {{ conversionLine: Array<number|null>, baseLine: Array<number|null>, leadLine1: Array<number|null>, leadLine2: Array<number|null>, laggingSpan: Array<number|null>, displacement: number }}
 */
export const computeAtomoku = (candles, config = {}) => {
  const convPeriod = config.convPeriod || 20
  const basePeriod = config.basePeriod || 60
  const leadPeriod = config.leadPeriod || 120
  const displacement = config.displacement || 30

  const conversionLine = donchian(candles, convPeriod)
  const baseLine = donchian(candles, basePeriod)

  // Lead lines are displaced forward by `displacement` periods
  // leadLine1[i] = avg(conversion[i - displacement], base[i - displacement])
  // leadLine2[i] = donchian(leadPeriod) at candle [i - displacement]
  const rawLead2 = donchian(candles, leadPeriod)

  const totalLen = candles.length + displacement
  const leadLine1 = new Array(totalLen).fill(null)
  const leadLine2 = new Array(totalLen).fill(null)

  for (let i = 0; i < candles.length; i++) {
    const conv = conversionLine[i]
    const base = baseLine[i]
    if (conv != null && base != null) {
      leadLine1[i + displacement] = (conv + base) / 2
    }
    if (rawLead2[i] != null) {
      leadLine2[i + displacement] = rawLead2[i]
    }
  }

  // Lagging span: close at candle i plotted at position i - displacement
  const laggingSpan = new Array(candles.length).fill(null)
  for (let i = displacement; i < candles.length; i++) {
    laggingSpan[i - displacement] = candles[i].close
  }

  return { conversionLine, baseLine, leadLine1, leadLine2, laggingSpan, displacement }
}

/**
 * Compute Bollinger Bands series.
 * @param {Array<{close: number}>} candles
 * @param {number} [period=20]
 * @param {number} [mult=2]
 * @returns {Array<{upper: number, middle: number, lower: number}|null>}
 */
export const computeBollingerSeries = (candles, period = 20, mult = 2) => {
  const result = new Array(candles.length).fill(null)
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
    const mean = sum / period
    let sqSum = 0
    for (let j = i - period + 1; j <= i; j++) sqSum += (candles[j].close - mean) ** 2
    const std = Math.sqrt(sqSum / period)
    result[i] = { upper: mean + mult * std, middle: mean, lower: mean - mult * std }
  }
  return result
}

/**
 * Compute VWAP series (cumulative from start of candle array).
 * @param {Array<{high: number, low: number, close: number, volume: number}>} candles
 * @returns {Array<number|null>}
 */
export const computeVWAPSeries = (candles) => {
  const result = new Array(candles.length).fill(null)
  let cumPV = 0
  let cumVol = 0
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3
    const vol = candles[i].volume || 0
    cumPV += tp * vol
    cumVol += vol
    result[i] = cumVol > 0 ? cumPV / cumVol : null
  }
  return result
}

/**
 * Compute RSI series using Wilder's smoothing.
 * @param {Array<{close: number}>} candles
 * @param {number} [period=14]
 * @returns {Array<number|null>}
 */
export const computeRSISeries = (candles, period = 14) => {
  const result = new Array(candles.length).fill(null)
  if (candles.length < period + 1) return result

  // Initial average gain/loss over first `period` changes
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const delta = candles[i].close - candles[i - 1].close
    if (delta > 0) avgGain += delta
    else avgLoss -= delta
  }
  avgGain /= period
  avgLoss /= period

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  // Wilder's smoothing for remaining
  for (let i = period + 1; i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close
    const gain = delta > 0 ? delta : 0
    const loss = delta < 0 ? -delta : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }

  return result
}

/**
 * Compute Stochastic Oscillator series.
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} [kPeriod=14]
 * @param {number} [dPeriod=3]
 * @returns {Array<{k: number, d: number}|null>}
 */
export const computeStochasticSeries = (candles, kPeriod = 14, dPeriod = 3) => {
  const result = new Array(candles.length).fill(null)
  const kValues = new Array(candles.length).fill(null)

  for (let i = kPeriod - 1; i < candles.length; i++) {
    let highest = -Infinity
    let lowest = Infinity
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high
      if (candles[j].low < lowest) lowest = candles[j].low
    }
    const range = highest - lowest
    kValues[i] = range > 0 ? ((candles[i].close - lowest) / range) * 100 : 50
  }

  // %D = SMA of %K over dPeriod
  for (let i = kPeriod - 1 + dPeriod - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - dPeriod + 1; j <= i; j++) sum += kValues[j]
    result[i] = { k: kValues[i], d: sum / dPeriod }
  }

  return result
}

/**
 * Compute EMA (Exponential Moving Average) from an array of values.
 * @param {Array<number|null>} values
 * @param {number} period
 * @returns {Array<number|null>}
 */
const ema = (values, period) => {
  const result = new Array(values.length).fill(null)
  const k = 2 / (period + 1)

  // Find first non-null to seed SMA
  let firstIdx = -1
  let sum = 0
  let count = 0
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) {
      if (firstIdx === -1) firstIdx = i
      sum += values[i]
      count++
      if (count === period) {
        result[i] = sum / period
        // EMA from here
        for (let j = i + 1; j < values.length; j++) {
          if (values[j] != null) {
            result[j] = values[j] * k + result[j - 1] * (1 - k)
          }
        }
        break
      }
    }
  }

  return result
}

/**
 * Compute MACD series.
 * @param {Array<{close: number}>} candles
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signalPeriod=9]
 * @returns {Array<{macd: number, signal: number, histogram: number}|null>}
 */
export const computeMACDSeries = (candles, fast = 12, slow = 26, signalPeriod = 9) => {
  const closes = candles.map(c => c.close)
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)

  const macdLine = new Array(candles.length).fill(null)
  for (let i = 0; i < candles.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) {
      macdLine[i] = emaFast[i] - emaSlow[i]
    }
  }

  const signalLine = ema(macdLine, signalPeriod)

  const result = new Array(candles.length).fill(null)
  for (let i = 0; i < candles.length; i++) {
    if (macdLine[i] != null && signalLine[i] != null) {
      result[i] = { macd: macdLine[i], signal: signalLine[i], histogram: macdLine[i] - signalLine[i] }
    }
  }

  return result
}
