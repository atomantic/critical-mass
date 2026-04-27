// @ts-check
/**
 * Signal Engine
 *
 * Computes composite buy/sell signals from technical indicators
 * across multiple timeframes. Produces a weighted score from -100 to +100.
 *
 * Features:
 * 1. Trend Filter (EMA 50/200 on 1h candles)
 * 2. Volatility-Scaled Signal Thresholds
 * 3. Volume Surge Multiplier
 * 4. Momentum Acceleration (replaces simple momentum)
 * 5. Divergence Detection (price/RSI)
 * 6. Pivot Points (Support/Resistance dampening)
 * 7. Adaptive Indicator Weights
 * 8. Multi-Candle Horizon Prediction
 */

const { calculateRSI, calculateRSISeries, calculateStochastic, calculateMACD, calculateMACDHistogramSeries, calculateBollingerBands, calculateOBV, calculateADX, calculateWilliamsR, calculateCCI, calculateSMA } = require('./indicators');
const { calculateATR, calculateVWAP, calculateEMA, calculateMomentumAcceleration, calculateTrueRange } = require('../volatility-utils');
const { detectDivergence, detectMACDDivergence } = require('./divergence');
const { calculatePivotPoints, computePivotDampening } = require('./pivot-points');
const { INDICATOR_WEIGHTS } = require('./indicator-config');

const TIMEFRAME_WEIGHTS = {
  '1m': 0.10,
  '3m': 0.15,
  '5m': 0.30,
  '15m': 0.30,
  '1h': 0.15,
};

const ALL_SIGNAL_TFS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'];

// Short timeframes use neutral scoring so they can detect short-term reversals
// even when the higher-timeframe trend is bullish/bearish
const SHORT_TFS = new Set(['1m', '3m', '5m']);

const NO_TRADE_ZONE_MS = 6 * 60 * 60 * 1000;
const WARNING_ZONE_MS = 8 * 60 * 60 * 1000;

/**
 * Score RSI indicator (-100 to +100)
 * @param {number} rsi
 * @returns {number}
 */
const scoreRSI = (rsi, trendBias = 'neutral') => {
  if (rsi == null) return 0;
  if (trendBias === 'bullish') {
    if (rsi > 70) return 30;   // overbought in uptrend = trend confirmation, not reversal
    if (rsi > 65) return 0;
    if (rsi < 30) return 80;
    if (rsi < 35) return 50;
    return 0;
  }
  if (trendBias === 'bearish') {
    if (rsi < 30) return -30;  // oversold in downtrend = trend confirmation, not reversal
    if (rsi < 35) return 0;
    if (rsi > 70) return -80;
    if (rsi > 65) return -50;
    return 0;
  }
  // neutral: extreme zones + gentle mid-range gradient (RSI 35-65 → ±12 max)
  if (rsi < 30) return 80;
  if (rsi < 35) return 50;
  if (rsi > 70) return -80;
  if (rsi > 65) return -50;
  // Gentle gradient: RSI 50 = 0, RSI 35 ≈ +12, RSI 65 ≈ -12
  return Math.round((50 - rsi) * 0.8);
};

/**
 * Score Stochastic indicator (-100 to +100)
 * @param {{k: number, d: number}} stoch
 * @param {{k: number, d: number} | null} prevStoch
 * @returns {number}
 */
const scoreStochastic = (stoch, prevStoch, trendBias = 'neutral') => {
  if (!stoch || (stoch.k === 0 && stoch.d === 0)) return 0;

  const bullishCross = prevStoch && prevStoch.k <= prevStoch.d && stoch.k > stoch.d;
  const bearishCross = prevStoch && prevStoch.k >= prevStoch.d && stoch.k < stoch.d;

  if (trendBias === 'bullish') {
    // Overbought in uptrend is normal — only penalize confirmed bearish cross
    if (stoch.k > 80 && bearishCross) return -40;
    if (stoch.k > 80) return 0;
    if (stoch.k < 20 && bullishCross) return 90;
    if (stoch.k < 20) return 60;
    return 0;
  }
  if (trendBias === 'bearish') {
    // Oversold in downtrend is normal — only reward confirmed bullish cross
    if (stoch.k < 20 && bullishCross) return 40;
    if (stoch.k < 20) return 0;
    if (stoch.k > 80 && bearishCross) return -90;
    if (stoch.k > 80) return -60;
    return 0;
  }
  // neutral: original mean-reversion logic
  if (stoch.k < 20 && bullishCross) return 90;
  if (stoch.k < 20) return 60;
  if (stoch.k > 80 && bearishCross) return -90;
  if (stoch.k > 80) return -60;
  return 0;
};

/**
 * Score MACD indicator (-100 to +100)
 * @param {{macd: number, signal: number, histogram: number}} macd
 * @param {{macd: number, signal: number, histogram: number} | null} prevMacd
 * @returns {number}
 */
const scoreMACD = (macd, prevMacd, trendBias = 'neutral') => {
  if (!macd || (macd.macd === 0 && macd.signal === 0)) return 0;

  const bullishCross = prevMacd && prevMacd.macd <= prevMacd.signal && macd.macd > macd.signal;
  const bearishCross = prevMacd && prevMacd.macd >= prevMacd.signal && macd.macd < macd.signal;

  // Crossover takes precedence, but counter-trend crossovers carry less conviction
  if (bullishCross) return trendBias === 'bearish' ? 50 : 90;
  if (bearishCross) return trendBias === 'bullish' ? -50 : -90;

  // Continuous score from histogram magnitude (normalized by signal line)
  const denominator = Math.max(Math.abs(macd.signal), Math.abs(macd.macd) * 0.1, 1e-8);
  const histRatio = macd.histogram / denominator;
  let score = Math.max(-60, Math.min(60, histRatio * 60));

  // Histogram inflection bonus: sign flip without full crossover
  if (prevMacd) {
    if (prevMacd.histogram < 0 && macd.histogram > 0) score = Math.max(score, 20);
    else if (prevMacd.histogram > 0 && macd.histogram < 0) score = Math.min(score, -20);
  }

  // Trend-continuation bonus: histogram positive+growing in bullish trend → floor at +50
  if (prevMacd && trendBias === 'bullish' && macd.histogram > 0 && macd.histogram > prevMacd.histogram) {
    score = Math.max(score, 50);
  } else if (prevMacd && trendBias === 'bearish' && macd.histogram < 0 && macd.histogram < prevMacd.histogram) {
    score = Math.min(score, -50);
  }

  return Math.max(-100, Math.min(100, Math.round(score)));
};

/**
 * Score Bollinger %B indicator (-100 to +100)
 * @param {number} percentB
 * @returns {number}
 */
const scoreBollinger = (percentB, trendBias = 'neutral') => {
  if (percentB == null) return 0;
  if (trendBias === 'bullish') {
    // Band-walking above upper band is normal in uptrends
    if (percentB > 1) return 0;
    if (percentB > 0.8) return 0;
    if (percentB < 0) return 80;
    if (percentB < 0.2) return 50;
    return 0;
  }
  if (trendBias === 'bearish') {
    // Band-walking below lower band is normal in downtrends
    if (percentB < 0) return 0;
    if (percentB < 0.2) return 0;
    if (percentB > 1) return -80;
    if (percentB > 0.8) return -50;
    return 0;
  }
  // neutral: original mean-reversion logic
  if (percentB < 0) return 80;
  if (percentB < 0.2) return 50;
  if (percentB > 1) return -80;
  if (percentB > 0.8) return -50;
  return 0;
};

/**
 * Score VWAP distance in ATR units (-100 to +100)
 * @param {number} price - Current price
 * @param {number} vwap - VWAP value
 * @param {number} atr - ATR value
 * @returns {number}
 */
const scoreVWAP = (price, vwap, atr, trendBias = 'neutral') => {
  if (!atr || atr < 0.001 || !vwap || vwap <= 0) return 0;
  const distance = (price - vwap) / atr;
  if (trendBias === 'bullish') {
    // Price above VWAP is normal in uptrends — reduce penalty slope and cap
    if (distance > 2) return -20;
    if (distance < -2) return 70;
    return Math.round(-10 * distance);
  }
  if (trendBias === 'bearish') {
    // Price below VWAP is normal in downtrends — reduce reward slope and cap
    if (distance < -2) return 20;
    if (distance > 2) return -70;
    return Math.round(-10 * distance);
  }
  // neutral: original mean-reversion logic
  if (distance < -2) return 70;
  if (distance > 2) return -70;
  return Math.round(-35 * distance);
};

/**
 * Score momentum (-100 to +100) — legacy, kept for reference
 * @param {{magnitude: number, direction: string}} momentum
 * @param {number} rsi - RSI value for context (oversold condition)
 * @returns {number}
 */
const scoreMomentum = (momentum, rsi) => {
  if (!momentum || momentum.magnitude === 0) return 0;
  if (momentum.direction === 'up' && rsi < 35) return 60;
  if (momentum.direction === 'up') return 30;
  if (momentum.direction === 'down') return -60;
  return 0;
};

// --- Feature 4: Momentum Acceleration scoring (replaces scoreMomentum) ---

/**
 * Score momentum acceleration (-100 to +100)
 * @param {{roc3: number, roc10: number, acceleration: string, magnitude: number, direction: string}} momentum
 * @param {number} rsi - RSI value for context
 * @returns {number}
 */
const scoreMomentumAcceleration = (momentum, rsi, trendBias = 'neutral') => {
  if (!momentum || momentum.direction === 'neutral') return 0;

  let base = momentum.direction === 'up' ? 30 : -30;

  // Acceleration/fading multiplier
  if (momentum.acceleration === 'accelerating') base *= 1.5;
  else if (momentum.acceleration === 'fading') base *= 0.5;

  if (trendBias === 'neutral') {
    // Original RSI context bonus: oversold+up or overbought+down (contrarian)
    if ((rsi < 35 && momentum.direction === 'up') || (rsi > 65 && momentum.direction === 'down')) {
      base *= 1.5;
    }
  } else {
    // Trend-aware: boost trend-aligned accelerating momentum, halve counter-trend
    const trendAligned = (trendBias === 'bullish' && momentum.direction === 'up') ||
                         (trendBias === 'bearish' && momentum.direction === 'down');
    if (trendAligned && momentum.acceleration === 'accelerating') {
      base *= 1.5;
    } else if (!trendAligned) {
      base *= 0.5;
    }
  }

  return Math.max(-100, Math.min(100, Math.round(base)));
};

/**
 * Score OBV indicator (-100 to +100)
 * Confirms or contradicts price trend via volume direction
 * @param {{obv: number, slope: number, direction: string}} obv
 * @param {string} priceDirection - 'up' | 'down' | 'neutral' from price movement
 * @param {string} trendBias - 'bullish' | 'bearish' | 'neutral'
 * @returns {number}
 */
const scoreOBV = (obv, priceDirection, trendBias = 'neutral') => {
  if (!obv || obv.direction === 'neutral') return 0;

  // Volume confirms price direction
  const confirms = obv.direction === priceDirection;
  const slopeStrength = Math.abs(obv.slope);

  let score = 0;
  if (confirms) {
    // Confirmation: OBV and price agree
    score = obv.direction === 'up' ? 50 : -50;
    score *= Math.min(1, slopeStrength * 2); // scale by slope strength
  } else {
    // Divergence: OBV and price disagree — warning signal
    score = obv.direction === 'up' ? 30 : -30;
    score *= Math.min(1, slopeStrength * 2);
  }

  // Trend alignment bonus
  if (trendBias === 'bullish' && obv.direction === 'up') score *= 1.3;
  else if (trendBias === 'bearish' && obv.direction === 'down') score *= 1.3;

  return Math.max(-100, Math.min(100, Math.round(score)));
};

/**
 * Score Williams %R indicator (-100 to +100)
 * Complementary to Stochastic — measures overbought/oversold from the high
 * @param {number|null} wr - Williams %R value (-100 to 0)
 * @param {string} trendBias
 * @returns {number}
 */
const scoreWilliamsR = (wr, trendBias = 'neutral') => {
  if (wr == null) return 0;
  if (trendBias === 'bullish') {
    if (wr < -80) return 80;   // oversold in uptrend = buy opportunity
    if (wr < -70) return 40;
    if (wr > -20) return 0;    // overbought in uptrend = normal
    return 0;
  }
  if (trendBias === 'bearish') {
    if (wr > -20) return -80;  // overbought in downtrend = sell
    if (wr > -30) return -40;
    if (wr < -80) return 0;    // oversold in downtrend = normal
    return 0;
  }
  // neutral: standard mean-reversion
  if (wr < -80) return 80;
  if (wr < -70) return 40;
  if (wr > -20) return -80;
  if (wr > -30) return -40;
  return 0;
};

/**
 * Score Commodity Channel Index (-100 to +100)
 * Measures deviation from statistical mean — good for ranging market timing
 * @param {number|null} cci - CCI value
 * @param {string} trendBias
 * @returns {number}
 */
const scoreCCI = (cci, trendBias = 'neutral') => {
  if (cci == null) return 0;
  if (trendBias === 'bullish') {
    if (cci < -200) return 80;  // extreme oversold in uptrend = buy
    if (cci < -100) return 50;
    if (cci > 200) return 0;    // extreme overbought in uptrend = normal
    return 0;
  }
  if (trendBias === 'bearish') {
    if (cci > 200) return -80;  // extreme overbought in downtrend = sell
    if (cci > 100) return -50;
    if (cci < -200) return 0;   // extreme oversold in downtrend = normal
    return 0;
  }
  // neutral: standard mean-reversion with gentle mid-range gradient
  if (cci > 200) return -80;
  if (cci > 100) return -40;
  if (cci < -200) return 80;
  if (cci < -100) return 40;
  // Gentle gradient in normal range: CCI 0 = 0, CCI ±100 = ∓20
  return Math.max(-30, Math.min(30, Math.round(-cci * 0.2)));
};

// --- Feature 1: Trend Filter ---

/**
 * Compute trend bias from EMA(50)/EMA(200) on 1h candles
 * @param {Array<{close: number}>} candles1h
 * @returns {{trendBias: 'bullish'|'bearish'|'neutral', ema50: number, ema200: number, multiplier: number}}
 */
const computeTrendFilter = (candles1h) => {
  if (!candles1h || candles1h.length < 200) {
    return { trendBias: 'neutral', ema50: 0, ema200: 0, multiplier: 1 };
  }

  const ema50 = calculateEMA(candles1h, 50);
  const ema200 = calculateEMA(candles1h, 200);

  if (!ema50 || !ema200 || ema200 === 0) {
    return { trendBias: 'neutral', ema50, ema200, multiplier: 1 };
  }

  const spread = (ema50 - ema200) / ema200;

  if (spread > 0.001) return { trendBias: 'bullish', ema50, ema200, multiplier: 0.80 };
  if (spread < -0.001) return { trendBias: 'bearish', ema50, ema200, multiplier: 0.80 };
  return { trendBias: 'neutral', ema50, ema200, multiplier: 1 };
};

/**
 * Compute weekly macro trend filter from 1w candles using EMA(4)/EMA(8)
 * @param {Array<{close: number}>} candles1w
 * @returns {{weeklyBias: 'bullish'|'bearish'|'neutral', ema4: number, ema8: number, multiplier: number}}
 */
const computeWeeklyTrendFilter = (candles1w) => {
  if (!candles1w || candles1w.length < 8) {
    return { weeklyBias: 'neutral', ema4: 0, ema8: 0, multiplier: 1 };
  }

  const ema4 = calculateEMA(candles1w, 4);
  const ema8 = calculateEMA(candles1w, 8);

  if (!ema4 || !ema8 || ema8 === 0) {
    return { weeklyBias: 'neutral', ema4, ema8, multiplier: 1 };
  }

  const spread = (ema4 - ema8) / ema8;

  if (spread > 0.005) return { weeklyBias: 'bullish', ema4, ema8, multiplier: 0.85 };
  if (spread < -0.005) return { weeklyBias: 'bearish', ema4, ema8, multiplier: 0.85 };
  return { weeklyBias: 'neutral', ema4, ema8, multiplier: 1 };
};

/**
 * Compute ADX regime classification for composite modulation
 * @param {{adx: number, plusDI: number, minusDI: number, trending: boolean}} adxData
 * @returns {{regime: 'trending'|'ranging'|'neutral', adx: number, multiplier: number}}
 */
const computeADXRegime = (adxData) => {
  if (!adxData || adxData.adx === 0) {
    return { regime: 'neutral', adx: 0, multiplier: 1 };
  }

  if (adxData.adx > 25) {
    return { regime: 'trending', adx: adxData.adx, multiplier: 1.15 };
  }
  if (adxData.adx < 20) {
    return { regime: 'ranging', adx: adxData.adx, multiplier: 1.0 };
  }
  return { regime: 'neutral', adx: adxData.adx, multiplier: 1 };
};

/**
 * Compute daily SMA trend context from daily candles
 * Provides macro trend classification using SMA(50), SMA(100), SMA(200)
 * @param {Array<{close: number, timestamp?: number}>} candles1d - Daily candles
 * @returns {{sma50: number, sma100: number, sma200: number, trend: 'bullish'|'bearish'|'neutral', goldenCross: boolean, deathCross: boolean, priceVsSMA200: number}}
 */
const EMPTY_DAILY_SMA = { sma50: 0, sma100: 0, sma200: 0, trend: 'neutral', goldenCross: false, deathCross: false, priceVsSMA200: 0 };
let dailySMACache = { key: null, value: EMPTY_DAILY_SMA };

const computeDailySMAContext = (candles1d) => {
  if (!candles1d || candles1d.length < 50) return EMPTY_DAILY_SMA;

  // Daily SMAs only change when the latest daily candle changes — memoize
  // on length + last close + last timestamp so the 5s signal tick doesn't
  // walk 350 closes per call.
  const last = candles1d[candles1d.length - 1];
  const key = `${candles1d.length}:${last.timestamp ?? ''}:${last.close}`;
  if (dailySMACache.key === key) return dailySMACache.value;

  const sma50 = calculateSMA(candles1d, 50);
  const sma100 = calculateSMA(candles1d, 100);
  const sma200 = calculateSMA(candles1d, 200);
  const has200 = sma200 > 0;
  const has100 = sma100 > 0;
  const price = last.close;

  let trend = 'neutral';
  if (has200) {
    if (price > sma200 && sma50 > sma100) trend = 'bullish';
    else if (price < sma200 && sma50 < sma100) trend = 'bearish';
    else if (sma50 > sma100) trend = 'bullish';
    else if (sma50 < sma100) trend = 'bearish';
  } else if (has100) {
    if (sma50 > sma100) trend = 'bullish';
    else if (sma50 < sma100) trend = 'bearish';
  }

  const value = {
    sma50, sma100, sma200, trend,
    goldenCross: has200 && sma50 > sma200,
    deathCross: has200 && sma50 < sma200,
    priceVsSMA200: has200 ? ((price - sma200) / sma200) * 100 : 0,
  };
  dailySMACache = { key, value };
  return value;
};

// --- Feature 2: Volatility-Scaled Signal Thresholds ---

/**
 * Compute volatility context from 5m candles (ATR ratio to baseline)
 * Uses incremental Wilder's-smoothed ATR computation (O(n)) instead of
 * recomputing ATR from scratch for each bar (which was O(n²)).
 * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} candles5m
 * @returns {{atr: number, baseline: number, ratio: number}}
 */
const computeVolatilityContext = (candles5m) => {
  if (!candles5m || candles5m.length < 50) {
    return { atr: 0, baseline: 0, ratio: 1 };
  }

  const period = 14;
  const n = candles5m.length;

  // Compute true ranges for all candles in a single O(n) pass
  const trueRanges = [];
  for (let i = 0; i < n; i++) {
    trueRanges.push(calculateTrueRange(candles5m[i], i > 0 ? candles5m[i - 1].close : undefined));
  }

  // Seed ATR with SMA of first `period` true ranges, then apply Wilder's smoothing (O(n))
  let atrVal = 0;
  for (let i = 0; i < period; i++) atrVal += trueRanges[i];
  atrVal /= period;
  const atrSeries = [atrVal];
  for (let i = period; i < n; i++) {
    atrVal = ((atrVal * (period - 1)) + trueRanges[i]) / period;
    atrSeries.push(atrVal);
  }

  const atr = atrSeries[atrSeries.length - 1];

  if (atrSeries.length < 50) {
    return { atr, baseline: atr, ratio: 1 };
  }

  // EMA(50) of the ATR series as the baseline
  const mul = 2 / 51;
  let baseline = 0;
  for (let i = 0; i < 50; i++) baseline += atrSeries[i];
  baseline /= 50;
  for (let i = 50; i < atrSeries.length; i++) {
    baseline = (atrSeries[i] - baseline) * mul + baseline;
  }

  const ratio = baseline > 0 ? atr / baseline : 1;
  return { atr, baseline, ratio };
};

/**
 * Map composite score to signal label with dynamic thresholds
 * @param {number} score
 * @param {number} atrRatio - Volatility ratio (ATR / baseline)
 * @returns {'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL'}
 */
const scoreToSignalDynamic = (score, atrRatio) => {
  let neutralThreshold = 15;
  let strongThreshold = 30;

  if (atrRatio < 0.7) {
    // Low vol: widen zones via linear interpolation
    const t = Math.max(0, (0.7 - atrRatio) / 0.7);
    neutralThreshold = 15 + t * 7; // up to 22
    strongThreshold = 30 + t * 8;  // up to 38
  } else if (atrRatio > 1.5) {
    // High vol: tighten zones via linear interpolation
    const t = Math.min(1, (atrRatio - 1.5) / 1.5);
    neutralThreshold = 15 - t * 3; // down to 12
    strongThreshold = 30 - t * 5;  // down to 25
  }

  if (score > strongThreshold) return 'STRONG_BUY';
  if (score > neutralThreshold) return 'BUY';
  if (score < -strongThreshold) return 'STRONG_SELL';
  if (score < -neutralThreshold) return 'SELL';
  return 'NEUTRAL';
};

/**
 * Map composite score to signal label (original fixed thresholds)
 * @param {number} score
 * @returns {'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL'}
 */
const scoreToSignal = (score) => {
  if (score > 30) return 'STRONG_BUY';
  if (score > 15) return 'BUY';
  if (score < -30) return 'STRONG_SELL';
  if (score < -15) return 'SELL';
  return 'NEUTRAL';
};

// --- Feature 3: Volume Surge Multiplier ---

/**
 * Compute volume surge multiplier
 * @param {Array<{volume: number}>} candles
 * @param {number} [lookback=20]
 * @returns {{multiplier: number, surgeRatio: number, currentVolume: number, avgVolume: number}}
 */
const computeVolumeSurge = (candles, lookback = 20) => {
  if (!candles || candles.length < lookback + 1) {
    return { multiplier: 1, surgeRatio: 1, currentVolume: 0, avgVolume: 0 };
  }

  const currentVolume = candles[candles.length - 1].volume || 0;
  const prevCandles = candles.slice(-lookback - 1, -1);
  const avgVolume = prevCandles.reduce((s, c) => s + (c.volume || 0), 0) / prevCandles.length;

  if (avgVolume <= 0) return { multiplier: 1, surgeRatio: 1, currentVolume, avgVolume };

  const surgeRatio = currentVolume / avgVolume;
  let multiplier = 1;

  if (surgeRatio > 2.0) {
    multiplier = 1.3;
  } else if (surgeRatio > 1.5) {
    // Linear ramp 1.0 to 1.3 between 1.5 and 2.0
    multiplier = 1 + (surgeRatio - 1.5) / 0.5 * 0.3;
  } else if (surgeRatio < 0.5) {
    multiplier = 0.7;
  } else if (surgeRatio < 0.75) {
    // Linear ramp 1.0 to 0.7 between 0.75 and 0.5
    multiplier = 1 - (0.75 - surgeRatio) / 0.25 * 0.3;
  }

  return { multiplier, surgeRatio, currentVolume, avgVolume };
};

// --- Feature 8: Multi-Candle Horizon Prediction ---

/**
 * Compute per-horizon confidence and find best horizon
 * @param {Record<string, {accuracy: number|null, total: number}>} byWindow
 * @param {number} compositeScore
 * @returns {{bestHorizon: string|null, horizonConfidence: Record<string,number>, bestAccuracy: number}}
 */
const computeHorizonPrediction = (byWindow, compositeScore) => {
  const horizonConfidence = {};
  let bestHorizon = null;
  let bestAccuracy = 0;

  for (const [label, data] of Object.entries(byWindow ?? {})) {
    const accuracy = data?.accuracy ?? 0;
    const confidence = (accuracy / 100) * Math.min(1, Math.abs(compositeScore) / 60);
    horizonConfidence[label] = Math.round(confidence * 1000) / 1000;

    if (accuracy > bestAccuracy && data?.total >= 5) {
      bestAccuracy = accuracy;
      bestHorizon = label;
    }
  }

  return { bestHorizon, horizonConfidence, bestAccuracy };
};

/**
 * Compute all indicator scores for a given candle set
 * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} candles
 * @param {Record<string, any> | null} prevIndicators - Previous indicator values for crossover detection
 * @param {Record<string, number>} weights - Indicator weights to use
 * @returns {{scores: Record<string, number>, indicators: Record<string, any>, weightedScore: number}}
 */
const computeTimeframeSignals = (candles, prevIndicators, weights, trendBias = 'neutral') => {
  if (!candles || candles.length < 2) {
    return { scores: {}, indicators: {}, weightedScore: 0 };
  }

  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  const rsi = calculateRSI(closes);
  const stoch = calculateStochastic(candles);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes);
  const atr = calculateATR(candles);
  const vwap = calculateVWAP(candles);

  // Feature 4: Use momentum acceleration instead of simple momentum
  const momentum = calculateMomentumAcceleration(candles);

  const prevStoch = prevIndicators?.stochastic ?? null;
  const prevMacd = prevIndicators?.macd ?? null;

  const obv = calculateOBV(candles);
  const adx = calculateADX(candles);
  const williamsR = calculateWilliamsR(candles);
  const cci = calculateCCI(candles);

  // Determine price direction from recent closes for OBV scoring
  const priceDir = closes.length >= 3
    ? (closes[closes.length - 1] > closes[closes.length - 3] ? 'up' : closes[closes.length - 1] < closes[closes.length - 3] ? 'down' : 'neutral')
    : 'neutral';

  const scores = {
    rsi: scoreRSI(rsi, trendBias),
    stochastic: scoreStochastic(stoch, prevStoch, trendBias),
    macd: scoreMACD(macd, prevMacd, trendBias),
    bollinger: scoreBollinger(bb.percentB, trendBias),
    vwap: scoreVWAP(currentPrice, vwap, atr, trendBias),
    momentum: scoreMomentumAcceleration(momentum, rsi, trendBias),
    obv: scoreOBV(obv, priceDir, trendBias),
    williamsR: scoreWilliamsR(williamsR, trendBias),
    cci: scoreCCI(cci, trendBias),
  };

  let weightedScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    weightedScore += score * (weights[key] || 0);
  }

  // Feature 3: Volume surge multiplier
  const volumeSurge = computeVolumeSurge(candles);
  weightedScore *= volumeSurge.multiplier;

  // Feature 5: Divergence detection (RSI + MACD histogram)
  const rsiSeries = calculateRSISeries(closes);
  const divergence = detectDivergence(closes, rsiSeries);
  const macdHistSeries = calculateMACDHistogramSeries(closes);
  const macdDivergence = detectMACDDivergence(closes, macdHistSeries);

  // Apply the strongest applicable divergence signal
  const bearishStrength = Math.max(
    divergence.type === 'bearish' ? divergence.strength : 0,
    macdDivergence.type === 'bearish' ? macdDivergence.strength : 0
  );
  const bullishStrength = Math.max(
    divergence.type === 'bullish' ? divergence.strength : 0,
    macdDivergence.type === 'bullish' ? macdDivergence.strength : 0
  );

  if (bearishStrength > 0 && weightedScore > 0) {
    weightedScore *= (1 - 0.3 * bearishStrength);
  } else if (bullishStrength > 0 && weightedScore < 0) {
    weightedScore *= (1 - 0.3 * bullishStrength);
  }

  const indicators = {
    rsi, stochastic: stoch, macd, bollingerBands: bb, atr, vwap, momentum,
    volumeSurge, divergence, macdDivergence, obv, adx, williamsR, cci,
  };

  return { scores, indicators, weightedScore };
};

/**
 * Create a signal engine instance
 * @param {{getCandles: (tf: string) => Array}} candleAggregator
 * @returns {{computeSignals: Function, setIndicatorWeights: Function}}
 */
const createSignalEngine = (candleAggregator) => {
  /** @type {Record<string, Record<string, any> | null>} */
  const prevIndicators = {};
  for (const tf of ALL_SIGNAL_TFS) prevIndicators[tf] = null;

  // Feature 7: Adaptive weights — start with defaults, can be overridden
  let currentIndicatorWeights = { ...INDICATOR_WEIGHTS };

  // Feature 6: Pivot points cache
  let cachedPivots = null;
  let lastPivotDayTs = 0;

  /**
   * Update indicator weights (called from updown-service after scorecard computes adaptive weights)
   * @param {Record<string, number>} weights
   */
  const setIndicatorWeights = (weights) => {
    currentIndicatorWeights = { ...weights };
  };

  /**
   * Compute composite signals across all timeframes
   * @param {number | null} [contractExpiry] - Contract expiry timestamp (ms)
   * @param {Object} [scorecardMetrics] - Metrics from scorecard for horizon prediction
   */
  const computeSignals = (contractExpiry = null, scorecardMetrics = null) => {
    const now = Date.now();
    const timeToExpiry = (contractExpiry && contractExpiry > now) ? contractExpiry - now : Infinity;
    const noTradeZone = timeToExpiry <= NO_TRADE_ZONE_MS;
    const warningZone = timeToExpiry <= WARNING_ZONE_MS;

    // Feature 1: Compute trend filter BEFORE timeframe loop so trendBias is available to indicator scoring
    const candles1h = candleAggregator.getCandles('1h');
    const trendFilter = computeTrendFilter(candles1h);

    // Weekly macro trend filter from 1w candles
    const candles1w = candleAggregator.getCandles('1w');
    const weeklyTrend = computeWeeklyTrendFilter(candles1w);

    const dailySMA = computeDailySMAContext(candleAggregator.getCandles('1d'));

    const timeframes = {};
    let compositeScore = 0;

    for (const tf of ALL_SIGNAL_TFS) {
      const candles = candleAggregator.getCandles(tf);
      const tfTrendBias = SHORT_TFS.has(tf) ? 'neutral' : trendFilter.trendBias;
      const result = computeTimeframeSignals(candles, prevIndicators[tf], currentIndicatorWeights, tfTrendBias);

      // Store indicators for next round's crossover detection
      if (result.indicators && Object.keys(result.indicators).length > 0) {
        prevIndicators[tf] = result.indicators;
      }

      timeframes[tf] = {
        score: result.weightedScore,
        scores: result.scores,
        indicators: result.indicators,
        candleCount: candles.length,
      };

      // Only the original 5 TFs contribute to composite
      const weight = TIMEFRAME_WEIGHTS[tf];
      if (weight) {
        compositeScore += result.weightedScore * weight;
      }
    }

    // Feature 9: Confluence filter — overcrowded signals perform worse than random
    const compositeDir = compositeScore > 0 ? 1 : compositeScore < 0 ? -1 : 0;
    let agreeing = 0;
    let totalDirectional = 0;
    for (const tf of ALL_SIGNAL_TFS) {
      const tfScore = timeframes[tf]?.score ?? 0;
      if (Math.abs(tfScore) > 15) {
        totalDirectional++;
        if ((tfScore > 0 ? 1 : -1) === compositeDir) agreeing++;
      }
    }
    const confluenceQuality = agreeing >= 8 ? 'overcrowded' : agreeing >= 7 ? 'moderate' : 'selective';
    if (confluenceQuality === 'overcrowded') {
      compositeScore *= 0.85;
    } else if (confluenceQuality === 'moderate') {
      compositeScore *= 0.95;
    }
    const confluence = { agreeing, totalDirectional, quality: confluenceQuality };

    // Feature 1: Trend filter + weekly macro — apply only the stronger dampener, not both
    // Stacking both multiplicatively (0.80 × 0.85 = 0.68x) crushes signals during
    // prolonged bearish trends, making BUY signals nearly unreachable.
    const trendCounterSignal = (trendFilter.trendBias === 'bullish' && compositeScore < 0) ||
                               (trendFilter.trendBias === 'bearish' && compositeScore > 0);
    const weeklyCounterSignal = (weeklyTrend.weeklyBias === 'bullish' && compositeScore < 0) ||
                                (weeklyTrend.weeklyBias === 'bearish' && compositeScore > 0);

    if (trendCounterSignal && weeklyCounterSignal) {
      // Both disagree — apply the stronger (lower) multiplier only
      compositeScore *= Math.min(trendFilter.multiplier, weeklyTrend.multiplier);
    } else if (trendCounterSignal) {
      compositeScore *= trendFilter.multiplier;
    } else if (weeklyCounterSignal) {
      compositeScore *= weeklyTrend.multiplier;
    }

    // Feature 6: Pivot point dampening
    const candles1d = candleAggregator.getCandles('1d');
    let pivotPoints = null;
    if (candles1d?.length > 0) {
      const latestDaily = candles1d[candles1d.length - 1];
      const dayTs = latestDaily.timestamp;
      if (dayTs !== lastPivotDayTs) {
        cachedPivots = calculatePivotPoints(latestDaily);
        lastPivotDayTs = dayTs;
      }
      if (cachedPivots) {
        const closes5m = candleAggregator.getCandles('5m');
        const currentPrice = closes5m?.length > 0 ? closes5m[closes5m.length - 1].close : 0;
        const prevPrice5m = closes5m?.length > 1 ? closes5m[closes5m.length - 2].close : null;
        if (currentPrice > 0) {
          pivotPoints = computePivotDampening(currentPrice, cachedPivots, 0.001, prevPrice5m);
          // Dampen positive scores near resistance, negative scores near support
          if (pivotPoints.nearLevel) {
            const isResistance = pivotPoints.nearLevel.startsWith('R');
            if (isResistance && compositeScore > 0) {
              compositeScore *= pivotPoints.dampMultiplier;
            } else if (!isResistance && compositeScore < 0) {
              compositeScore *= pivotPoints.dampMultiplier;
            }
          }
        }
      }
    }

    // ADX regime modulation — boost trending, dampen ranging
    const adx1h = timeframes['1h']?.indicators?.adx;
    const adxRegime = computeADXRegime(adx1h);
    compositeScore *= adxRegime.multiplier;

    // Feature 10: Score cap — soft ceiling instead of hard cap
    // Previous hard cap at ±35 made BUY (threshold 40) mathematically impossible.
    // Now: linear compression above ±35 — scores can reach ±70 but with diminishing returns.
    if (Math.abs(compositeScore) > 50) {
      const sign = compositeScore > 0 ? 1 : -1;
      const excess = Math.abs(compositeScore) - 50;
      compositeScore = sign * (50 + excess * 0.5); // 50% compression above 50
    }

    // Feature 11: Data-driven time-of-day weighting from scorecard per-hour accuracy
    const utcHour = new Date(now).getUTCHours();
    let todMultiplier = 1.0;
    const hourData = scorecardMetrics?.byHour?.[utcHour];
    if (hourData?.accuracy != null && hourData.total >= 10) {
      // Multiplier = 1.0 + (accuracy - 50) / 100, clamped to [0.80, 1.20]
      todMultiplier = Math.max(0.90, Math.min(1.10, 1.0 + (hourData.accuracy - 50) / 100));
    }
    compositeScore *= todMultiplier;

    // Feature 2: Volatility-scaled signal thresholds
    const candles5m = candleAggregator.getCandles('5m');
    const volatility = computeVolatilityContext(candles5m);
    const type = noTradeZone ? 'NO_TRADE_ZONE' : scoreToSignalDynamic(compositeScore, volatility.ratio);

    // Multi-factor confidence: score magnitude (0-0.5) + TF agreement (0-0.3) + ADX regime (0-0.2)
    const scoreFactor = Math.min(0.5, Math.abs(compositeScore) / 100);
    const agreementFactor = confluence.totalDirectional > 0
      ? 0.3 * (confluence.agreeing / confluence.totalDirectional)
      : 0;
    const adxFactor = adxRegime.regime === 'trending' ? 0.2 : 0.1;
    const confidence = Math.min(1, Math.round((scoreFactor + agreementFactor + adxFactor) * 100) / 100);

    // Feature 8: Horizon prediction
    const horizonPrediction = scorecardMetrics?.byWindow
      ? computeHorizonPrediction(scorecardMetrics.byWindow, compositeScore)
      : null;

    return {
      type,
      score: Math.round(compositeScore * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      timeframes,
      noTradeZone,
      warningZone,
      timestamp: now,
      trendFilter,
      weeklyTrend,
      dailySMA,
      adxRegime,
      volatility,
      pivotPoints,
      confluence,
      todMultiplier,
      horizonPrediction,
    };
  };

  return { computeSignals, setIndicatorWeights };
};

module.exports = {
  createSignalEngine,
  scoreToSignal,
  scoreToSignalDynamic,
  scoreRSI,
  scoreStochastic,
  scoreMACD,
  scoreBollinger,
  scoreVWAP,
  scoreMomentum,
  scoreMomentumAcceleration,
  scoreOBV,
  scoreWilliamsR,
  scoreCCI,
  computeTrendFilter,
  computeWeeklyTrendFilter,
  computeDailySMAContext,
  computeADXRegime,
  computeVolatilityContext,
  computeVolumeSurge,
  computeHorizonPrediction,
  INDICATOR_WEIGHTS,
  TIMEFRAME_WEIGHTS,
  ALL_SIGNAL_TFS,
  NO_TRADE_ZONE_MS,
  WARNING_ZONE_MS,
};
