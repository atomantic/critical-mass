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
  const startIdx = Math.max(kPeriod - 1, candles.length - dPeriod - kPeriod);

  for (let i = startIdx; i < candles.length; i++) {
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

/**
 * Calculate RSI series (full array) using Wilder's smoothing method
 * Same algorithm as calculateRSI but returns the full series
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} [period=14] - RSI period
 * @returns {number[]} Array of RSI values (first `period` values are 0)
 */
const calculateRSISeries = (closes, period = 14) => {
  const result = new Array(closes?.length ?? 0).fill(0);
  if (!closes || closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  return result;
};

/**
 * Calculate On-Balance Volume (OBV)
 * @param {Array<{close: number, volume: number}>} candles - Candle data (oldest first)
 * @param {number} [lookback=14] - Lookback period for slope normalization
 * @returns {{obv: number, slope: number, direction: 'up'|'down'|'neutral'}}
 */
const calculateOBV = (candles, lookback = 14) => {
  if (!candles || candles.length < 2) return { obv: 0, slope: 0, direction: 'neutral' };

  // Compute cumulative OBV
  const obvSeries = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = obvSeries[i - 1];
    if (candles[i].close > candles[i - 1].close) {
      obvSeries.push(prev + (candles[i].volume || 0));
    } else if (candles[i].close < candles[i - 1].close) {
      obvSeries.push(prev - (candles[i].volume || 0));
    } else {
      obvSeries.push(prev);
    }
  }

  const obv = obvSeries[obvSeries.length - 1];

  // Compute normalized slope over lookback period using linear regression
  const slice = obvSeries.slice(-lookback);
  if (slice.length < 3) return { obv, slope: 0, direction: 'neutral' };

  const n = slice.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += slice[i];
    sumXY += i * slice[i];
    sumX2 += i * i;
  }
  const rawSlope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Normalize slope by average absolute OBV to get a -1 to +1 range
  const avgAbsOBV = slice.reduce((s, v) => s + Math.abs(v), 0) / n;
  const slope = avgAbsOBV > 0 ? Math.max(-1, Math.min(1, rawSlope / avgAbsOBV * n)) : 0;

  let direction = 'neutral';
  if (slope > 0.1) direction = 'up';
  else if (slope < -0.1) direction = 'down';

  return { obv, slope, direction };
};

/**
 * Calculate MACD histogram series (full array, same length as closes)
 * Useful for divergence detection where we need the full histogram history.
 * @param {number[]} closes - Array of closing prices (oldest first)
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signalPeriod=9]
 * @returns {number[]} Histogram array (zeros where insufficient data)
 */
const calculateMACDHistogramSeries = (closes, fast = 12, slow = 26, signalPeriod = 9) => {
  const result = new Array(closes?.length ?? 0).fill(0);
  if (!closes || closes.length < slow + signalPeriod) return result;

  const fastEMA = emaFromValues(closes, fast);
  const slowEMA = emaFromValues(closes, slow);

  // MACD line valid from index slow-1 onward
  const macdLine = [];
  const offset = slow - 1;
  for (let i = offset; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  const signalLine = emaFromValues(macdLine, signalPeriod);

  // signalLine[0..signalPeriod-2] are 0 (signal not yet warmed up).
  // Zero those bars to avoid spurious divergence from raw MACD values.
  for (let i = 0; i < macdLine.length; i++) {
    result[offset + i] = i < signalPeriod - 1 ? 0 : macdLine[i] - signalLine[i];
  }

  return result;
};

/**
 * Calculate Average Directional Index (ADX) using Wilder's method
 * @param {Array<{high: number, low: number, close: number}>} candles - Candle data (oldest first)
 * @param {number} [period=14] - ADX smoothing period
 * @returns {{adx: number, plusDI: number, minusDI: number, trending: boolean}}
 */
const calculateADX = (candles, period = 14) => {
  if (!candles || candles.length < period * 2 + 1) {
    return { adx: 0, plusDI: 0, minusDI: 0, trending: false };
  }

  // Compute True Range, +DM, -DM
  const trList = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    // True Range
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trList.push(tr);

    // Directional Movement
    const upMove = high - candles[i - 1].high;
    const downMove = candles[i - 1].low - low;

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }

  // Wilder's smoothing for TR, +DM, -DM (first value = sum of first `period`)
  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trList[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  // Compute DI values and DX for Wilder's smoothing of ADX
  const dxValues = [];

  for (let i = period; i < trList.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trList[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    }

    const pDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = pDI + mDI;
    const dx = diSum > 0 ? (Math.abs(pDI - mDI) / diSum) * 100 : 0;
    dxValues.push({ dx, pDI, mDI });
  }

  if (dxValues.length < period) {
    return { adx: 0, plusDI: 0, minusDI: 0, trending: false };
  }

  // First ADX = average of first `period` DX values
  let adx = 0;
  for (let i = 0; i < period; i++) {
    adx += dxValues[i].dx;
  }
  adx /= period;

  // Wilder's smoothing for ADX
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i].dx) / period;
  }

  const last = dxValues[dxValues.length - 1];

  return {
    adx: Math.round(adx * 100) / 100,
    plusDI: Math.round(last.pDI * 100) / 100,
    minusDI: Math.round(last.mDI * 100) / 100,
    trending: adx > 25,
  };
};

/**
 * Calculate Williams %R
 * Measures overbought/oversold levels, complementary to Stochastic
 * @param {Array<{high: number, low: number, close: number}>} candles - Candle data (oldest first)
 * @param {number} [period=14] - Lookback period
 * @returns {number|null} Williams %R value (-100 to 0), null if insufficient data
 */
const calculateWilliamsR = (candles, period = 14) => {
  if (!candles || candles.length < period) return null;

  const window = candles.slice(-period);
  let highest = -Infinity;
  let lowest = Infinity;
  for (const c of window) {
    if (c.high > highest) highest = c.high;
    if (c.low < lowest) lowest = c.low;
  }

  const range = highest - lowest;
  if (range === 0) return -50;

  return ((highest - candles[candles.length - 1].close) / range) * -100;
};

/**
 * Calculate Commodity Channel Index (CCI)
 * Measures deviation from the statistical mean, useful for mean-reversion timing
 * @param {Array<{high: number, low: number, close: number}>} candles - Candle data (oldest first)
 * @param {number} [period=20] - Lookback period
 * @returns {number|null} CCI value (unbounded, typically -200 to +200), null if insufficient data
 */
const calculateCCI = (candles, period = 20) => {
  if (!candles || candles.length < period) return null;

  const window = candles.slice(-period);
  const typicalPrices = window.map(c => (c.high + c.low + c.close) / 3);
  const mean = typicalPrices.reduce((s, v) => s + v, 0) / period;
  const meanDeviation = typicalPrices.reduce((s, v) => s + Math.abs(v - mean), 0) / period;

  if (meanDeviation === 0) return 0;

  const currentTP = typicalPrices[typicalPrices.length - 1];
  return (currentTP - mean) / (0.015 * meanDeviation);
};

/**
 * Calculate Simple Moving Average from candle closes
 * @param {Array<{close: number}>} candles - Candle data (oldest first)
 * @param {number} period - SMA period
 * @returns {number} SMA value (0 if insufficient data)
 */
const calculateSMA = (candles, period) => {
  if (!candles || candles.length < period) return 0;

  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += candles[i].close;
  }
  return sum / period;
};

module.exports = {
  calculateRSI,
  calculateRSISeries,
  calculateStochastic,
  calculateMACD,
  calculateMACDHistogramSeries,
  calculateBollingerBands,
  calculateOBV,
  calculateADX,
  calculateWilliamsR,
  calculateCCI,
  calculateSMA,
  emaFromValues,
};
