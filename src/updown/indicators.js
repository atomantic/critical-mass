// @ts-check
/**
 * UpDown Dashboard Technical Indicators
 *
 * Pure functions for signal generation:
 * - RSI (Wilder-smoothed)
 * - Stochastic Oscillator (%K, %D)
 * - MACD (EMA-based with signal line and histogram)
 * - Bollinger Bands (with %B and bandwidth)
 */

/**
 * Calculate EMA over a plain number array (internal helper for MACD)
 * @param {number[]} values - Array of numbers (oldest first)
 * @param {number} period - EMA period
 * @returns {number[]} Full EMA series (same length as input, first `period-1` values are 0)
 */
const emaFromValues = (values, period) => {
  const result = new Array(values.length).fill(0);
  if (!values || values.length < period) return result;

  const multiplier = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += values[i];
  }
  ema /= period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result[i] = ema;
  }

  return result;
};

/**
 * Calculate RSI using Wilder's smoothing method
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} [period=14] - RSI period
 * @returns {number} RSI value 0-100 (0 if insufficient data)
 */
const calculateRSI = (closes, period = 14) => {
  if (!closes || closes.length < period + 1) return 0;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss from first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining values
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

/**
 * Calculate Stochastic Oscillator (%K and %D)
 * @param {Array<{high: number, low: number, close: number}>} candles - Candle data (oldest first)
 * @param {number} [kPeriod=14] - %K lookback period
 * @param {number} [dPeriod=3] - %D smoothing period (SMA of %K)
 * @returns {{k: number, d: number}} Both 0-100 (zeros if insufficient data)
 */
const calculateStochastic = (candles, kPeriod = 14, dPeriod = 3) => {
  if (!candles || candles.length < kPeriod) return { k: 0, d: 0 };

  // Calculate raw %K values for enough periods to compute %D
  const kValues = [];
  const neededK = Math.min(candles.length - kPeriod + 1, kPeriod + dPeriod);

  for (let i = candles.length - neededK; i <= candles.length - 1; i++) {
    if (i < kPeriod - 1) continue;
    const window = candles.slice(i - kPeriod + 1, i + 1);
    let highest = -Infinity;
    let lowest = Infinity;
    for (const c of window) {
      if (c.high > highest) highest = c.high;
      if (c.low < lowest) lowest = c.low;
    }
    const range = highest - lowest;
    const k = range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100;
    kValues.push(k);
  }

  if (kValues.length === 0) return { k: 0, d: 0 };

  const currentK = kValues[kValues.length - 1];

  // %D is SMA of last dPeriod %K values
  const dSlice = kValues.slice(-dPeriod);
  const d = dSlice.reduce((sum, v) => sum + v, 0) / dSlice.length;

  return { k: currentK, d };
};

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} [fast=12] - Fast EMA period
 * @param {number} [slow=26] - Slow EMA period
 * @param {number} [signalPeriod=9] - Signal line EMA period
 * @returns {{macd: number, signal: number, histogram: number}} Zeros if insufficient data
 */
const calculateMACD = (closes, fast = 12, slow = 26, signalPeriod = 9) => {
  if (!closes || closes.length < slow + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const fastEMA = emaFromValues(closes, fast);
  const slowEMA = emaFromValues(closes, slow);

  // MACD line = fastEMA - slowEMA (valid from index slow-1 onward)
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  // Signal line = EMA of MACD line
  const signalLine = emaFromValues(macdLine, signalPeriod);

  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];

  return {
    macd,
    signal,
    histogram: macd - signal,
  };
};

/**
 * Calculate Bollinger Bands
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} [period=20] - SMA period
 * @param {number} [mult=2] - Standard deviation multiplier
 * @returns {{upper: number, middle: number, lower: number, percentB: number, bandwidth: number}} Zeros if insufficient data
 */
const calculateBollingerBands = (closes, period = 20, mult = 2) => {
  if (!closes || closes.length < period) {
    return { upper: 0, middle: 0, lower: 0, percentB: 0, bandwidth: 0 };
  }

  // SMA of last `period` closes
  const window = closes.slice(-period);
  const middle = window.reduce((sum, v) => sum + v, 0) / period;

  // Standard deviation
  const squaredDiffs = window.map(v => (v - middle) ** 2);
  const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + mult * stdDev;
  const lower = middle - mult * stdDev;

  const bandWidth = upper - lower;
  const currentPrice = closes[closes.length - 1];
  const percentB = bandWidth === 0 ? 0.5 : (currentPrice - lower) / bandWidth;
  const bandwidth = middle === 0 ? 0 : bandWidth / middle;

  return { upper, middle, lower, percentB, bandwidth };
};

module.exports = {
  calculateRSI,
  calculateStochastic,
  calculateMACD,
  calculateBollingerBands,
  emaFromValues,
};
