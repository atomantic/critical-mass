// @ts-check
/**
 * Volatility Utilities
 *
 * Technical indicator calculations for regime detection:
 * - ATR (Average True Range)
 * - Realized Volatility
 * - VWAP (Volume-Weighted Average Price)
 * - Swing Range
 * - EMA Baseline
 * - Momentum calculation
 */

/**
 * @typedef {import('./types').Candle} Candle
 * @typedef {import('./types').VolatilityMetrics} VolatilityMetrics
 */

/**
 * Calculate True Range for a single candle
 * @param {Candle} candle - Current candle
 * @param {number} [prevClose] - Previous candle's close price
 * @returns {number} True Range value
 */
const calculateTrueRange = (candle, prevClose) => {
  const highLow = candle.high - candle.low;

  if (prevClose === undefined) {
    return highLow;
  }

  const highPrevClose = Math.abs(candle.high - prevClose);
  const lowPrevClose = Math.abs(candle.low - prevClose);

  return Math.max(highLow, highPrevClose, lowPrevClose);
};

/**
 * Calculate Average True Range (ATR)
 * @param {Candle[]} candles - Array of candles (oldest first)
 * @param {number} period - ATR period (default: 14)
 * @returns {number} ATR value
 */
const calculateATR = (candles, period = 14) => {
  if (!candles || candles.length < 2) {
    return 0;
  }

  // Calculate True Range for each candle
  const trueRanges = [];
  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1].close : undefined;
    trueRanges.push(calculateTrueRange(candles[i], prevClose));
  }

  // Use Wilder's smoothing method (EMA with alpha = 1/period)
  if (trueRanges.length < period) {
    // Not enough data, use simple average
    const sum = trueRanges.reduce((acc, tr) => acc + tr, 0);
    return sum / trueRanges.length;
  }

  // Initial ATR is simple average of first 'period' true ranges
  let atr = trueRanges.slice(0, period).reduce((acc, tr) => acc + tr, 0) / period;

  // Apply Wilder's smoothing for remaining candles
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  return atr;
};

/**
 * Calculate realized volatility from returns
 * Standard deviation of log returns over window, expressed as percentage
 * @param {Candle[]} candles - Array of candles
 * @param {number} window - Rolling window size (default: 30)
 * @returns {number} Realized volatility as percentage (not annualized)
 */
const calculateRealizedVol = (candles, window = 30) => {
  if (!candles || candles.length < 2) {
    return 0;
  }

  // Calculate log returns
  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    const logReturn = Math.log(candles[i].close / candles[i - 1].close);
    returns.push(logReturn);
  }

  // Use last 'window' returns
  const windowReturns = returns.slice(-window);
  if (windowReturns.length < 2) {
    return 0;
  }

  // Calculate standard deviation
  const mean = windowReturns.reduce((acc, r) => acc + r, 0) / windowReturns.length;
  const squaredDiffs = windowReturns.map(r => Math.pow(r - mean, 2));
  const variance = squaredDiffs.reduce((acc, d) => acc + d, 0) / (windowReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Return raw standard deviation as percentage (not annualized)
  // This represents short-term volatility over the window period
  return stdDev * 100;
};

/**
 * Calculate VWAP (Volume-Weighted Average Price)
 * @param {Candle[]} candles - Array of candles
 * @param {number} periodHours - Period in hours (default: 4)
 * @returns {number} VWAP value
 */
const calculateVWAP = (candles, periodHours = 4) => {
  if (!candles || candles.length === 0) {
    return 0;
  }

  const periodMs = periodHours * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = now - periodMs;

  // Filter candles within period
  const periodCandles = candles.filter(c => c.timestamp >= cutoff);

  if (periodCandles.length === 0) {
    // Fall back to all candles if none in period
    return candles[candles.length - 1].close;
  }

  // VWAP = sum(typical_price * volume) / sum(volume)
  let sumPV = 0;
  let sumV = 0;

  for (const candle of periodCandles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume || 1; // Default to 1 if no volume
    sumPV += typicalPrice * volume;
    sumV += volume;
  }

  return sumV > 0 ? sumPV / sumV : periodCandles[periodCandles.length - 1].close;
};

/**
 * Calculate recent swing range (high - low over window)
 * @param {Candle[]} candles - Array of candles
 * @param {number} periods - Number of periods to look back (default: 3)
 * @returns {number} Swing range
 */
const calculateSwingRange = (candles, periods = 3) => {
  if (!candles || candles.length === 0) {
    return 0;
  }

  const recentCandles = candles.slice(-periods);

  let high = -Infinity;
  let low = Infinity;

  for (const candle of recentCandles) {
    if (candle.high > high) high = candle.high;
    if (candle.low < low) low = candle.low;
  }

  return high - low;
};

/**
 * Update EMA baseline with new volatility reading
 * @param {number} currentVol - Current realized volatility
 * @param {number} baseline - Previous EMA baseline
 * @param {number} alpha - EMA smoothing factor (default: 0.1 for ~20 period EMA)
 * @returns {number} Updated baseline
 */
const updateEMABaseline = (currentVol, baseline, alpha = 0.1) => {
  if (baseline === 0 || baseline === undefined) {
    return currentVol;
  }
  return (alpha * currentVol) + ((1 - alpha) * baseline);
};

/**
 * Calculate momentum from price series
 * Returns magnitude of momentum (always positive) and direction
 * @param {Candle[]} candles - Array of candles
 * @param {number} shortPeriod - Short lookback (default: 1 for 1m)
 * @param {number} longPeriod - Long lookback (default: 5 for 5m)
 * @returns {{magnitude: number, direction: 'up' | 'down' | 'neutral'}}
 */
const calculateMomentum = (candles, shortPeriod = 1, longPeriod = 5) => {
  if (!candles || candles.length < longPeriod + 1) {
    return { magnitude: 0, direction: 'neutral' };
  }

  const current = candles[candles.length - 1].close;
  const shortAgo = candles[candles.length - 1 - shortPeriod]?.close || current;
  const longAgo = candles[candles.length - 1 - longPeriod]?.close || current;

  const shortReturn = (current - shortAgo) / shortAgo;
  const longReturn = (current - longAgo) / longAgo;

  // Check if both align in direction
  const shortUp = shortReturn > 0;
  const longUp = longReturn > 0;

  if (shortUp !== longUp) {
    // Mixed signals
    return { magnitude: 0, direction: 'neutral' };
  }

  // Both aligned - take magnitude from longer period
  const magnitude = Math.abs(longReturn * current);
  const direction = longUp ? 'up' : 'down';

  return { magnitude, direction };
};

/**
 * Calculate all volatility metrics at once
 * @param {Candle[]} candles1m - 1-minute candles
 * @param {Candle[]} candles5m - 5-minute candles
 * @param {number} prevBaseline - Previous volatility baseline
 * @param {Object} config - Configuration parameters
 * @param {number} [config.atrPeriod] - ATR period
 * @param {number} [config.vwapPeriodHours] - VWAP period in hours
 * @returns {{atr1m: number, atr5m: number, realizedVol: number, volBaseline: number, vwap: number, recentSwing: number, momentum: {magnitude: number, direction: string}}}
 */
const calculateAllMetrics = (candles1m, candles5m, prevBaseline, config = {}) => {
  const atrPeriod = config.atrPeriod || 14;
  const vwapPeriodHours = config.vwapPeriodHours || 4;

  const atr1m = calculateATR(candles1m, atrPeriod);
  const atr5m = calculateATR(candles5m, atrPeriod);
  const realizedVol = calculateRealizedVol(candles1m, 30);
  const volBaseline = updateEMABaseline(realizedVol, prevBaseline);
  const vwap = calculateVWAP(candles5m, vwapPeriodHours);
  const recentSwing = calculateSwingRange(candles5m, 3);
  const momentum = calculateMomentum(candles1m);

  return {
    atr1m,
    atr5m,
    realizedVol,
    volBaseline,
    vwap,
    recentSwing,
    momentum,
  };
};

/**
 * Calculate volatility expansion ratio
 * @param {number} realizedVol - Current realized volatility
 * @param {number} baseline - Volatility baseline
 * @returns {number} Expansion ratio (>1 means expanding)
 */
const calculateVolExpansion = (realizedVol, baseline) => {
  if (baseline <= 0) return 1;
  return realizedVol / baseline;
};

/**
 * Calculate VWAP distance in ATR units
 * @param {number} price - Current price
 * @param {number} vwap - VWAP value
 * @param {number} atr - ATR value
 * @returns {number} Distance in ATR units (can be negative)
 */
const calculateVWAPDistance = (price, vwap, atr) => {
  if (atr <= 0) return 0;
  return (price - vwap) / atr;
};

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
const clamp = (value, min, max) => {
  return Math.max(min, Math.min(max, value));
};

/**
 * Round to BTC precision (8 decimals)
 * @param {number} amount - Amount to round
 * @returns {number} Rounded amount
 */
const roundBTC = (amount) => {
  return Math.round(amount * 1e8) / 1e8;
};

/**
 * Round to USDC precision (2 decimals)
 * @param {number} amount - Amount to round
 * @returns {number} Rounded amount
 */
const roundUSDC = (amount) => {
  return Math.round(amount * 100) / 100;
};

/**
 * Round to price precision
 * @param {number} price - Price to round
 * @param {number} [increment] - Price increment (default: 0.01)
 * @returns {number} Rounded price
 */
const roundPrice = (price, increment = 0.01) => {
  return Math.round(price / increment) * increment;
};

module.exports = {
  calculateTrueRange,
  calculateATR,
  calculateRealizedVol,
  calculateVWAP,
  calculateSwingRange,
  updateEMABaseline,
  calculateMomentum,
  calculateAllMetrics,
  calculateVolExpansion,
  calculateVWAPDistance,
  clamp,
  roundBTC,
  roundUSDC,
  roundPrice,
};
