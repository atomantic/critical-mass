// @ts-check
/**
 * Signal Engine
 *
 * Computes composite buy/sell signals from technical indicators
 * across multiple timeframes. Produces a weighted score from -100 to +100.
 */

const { calculateRSI, calculateStochastic, calculateMACD, calculateBollingerBands } = require('./indicators');
const { calculateATR, calculateVWAP, calculateMomentum } = require('../volatility-utils');

const INDICATOR_WEIGHTS = {
  rsi: 0.25,
  stochastic: 0.20,
  macd: 0.20,
  bollinger: 0.15,
  vwap: 0.10,
  momentum: 0.10,
};

const TIMEFRAME_WEIGHTS = {
  '1m': 0.10,
  '3m': 0.15,
  '5m': 0.30,
  '15m': 0.30,
  '1h': 0.15,
};

const NO_TRADE_ZONE_MS = 6 * 60 * 60 * 1000;
const WARNING_ZONE_MS = 8 * 60 * 60 * 1000;

/**
 * Score RSI indicator (-100 to +100)
 * @param {number} rsi
 * @returns {number}
 */
const scoreRSI = (rsi) => {
  if (rsi === 0) return 0;
  if (rsi < 30) return 80;
  if (rsi < 35) return 50;
  if (rsi > 70) return -80;
  if (rsi > 65) return -50;
  return 0;
};

/**
 * Score Stochastic indicator (-100 to +100)
 * @param {{k: number, d: number}} stoch
 * @param {{k: number, d: number} | null} prevStoch
 * @returns {number}
 */
const scoreStochastic = (stoch, prevStoch) => {
  if (stoch.k === 0 && stoch.d === 0) return 0;

  const bullishCross = prevStoch && prevStoch.k <= prevStoch.d && stoch.k > stoch.d;
  const bearishCross = prevStoch && prevStoch.k >= prevStoch.d && stoch.k < stoch.d;

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
const scoreMACD = (macd, prevMacd) => {
  if (macd.macd === 0 && macd.signal === 0) return 0;

  const bullishCross = prevMacd && prevMacd.macd <= prevMacd.signal && macd.macd > macd.signal;
  const bearishCross = prevMacd && prevMacd.macd >= prevMacd.signal && macd.macd < macd.signal;

  if (bullishCross) return 90;
  if (bearishCross) return -90;

  // Histogram turning positive/negative
  if (prevMacd && prevMacd.histogram < 0 && macd.histogram > 0) return 40;
  if (prevMacd && prevMacd.histogram > 0 && macd.histogram < 0) return -40;

  return 0;
};

/**
 * Score Bollinger %B indicator (-100 to +100)
 * @param {number} percentB
 * @returns {number}
 */
const scoreBollinger = (percentB) => {
  if (percentB === 0) return 0;
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
const scoreVWAP = (price, vwap, atr) => {
  if (atr <= 0 || vwap <= 0) return 0;
  const distance = (price - vwap) / atr;
  if (distance < -2) return 70;
  if (distance > 2) return -70;
  // Linear interpolation between -2 and 2
  return Math.round(-35 * distance);
};

/**
 * Score momentum (-100 to +100)
 * @param {{magnitude: number, direction: string}} momentum
 * @param {number} rsi - RSI value for context (oversold condition)
 * @returns {number}
 */
const scoreMomentum = (momentum, rsi) => {
  if (momentum.magnitude === 0) return 0;
  if (momentum.direction === 'up' && rsi < 35) return 60;
  if (momentum.direction === 'up') return 30;
  if (momentum.direction === 'down') return -60;
  return 0;
};

/**
 * Compute all indicator scores for a given candle set
 * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} candles
 * @param {Record<string, any> | null} prevIndicators - Previous indicator values for crossover detection
 * @returns {{scores: Record<string, number>, indicators: Record<string, any>, weightedScore: number}}
 */
const computeTimeframeSignals = (candles, prevIndicators) => {
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
  const momentum = calculateMomentum(candles);

  const prevStoch = prevIndicators?.stochastic ?? null;
  const prevMacd = prevIndicators?.macd ?? null;

  const scores = {
    rsi: scoreRSI(rsi),
    stochastic: scoreStochastic(stoch, prevStoch),
    macd: scoreMACD(macd, prevMacd),
    bollinger: scoreBollinger(bb.percentB),
    vwap: scoreVWAP(currentPrice, vwap, atr),
    momentum: scoreMomentum(momentum, rsi),
  };

  let weightedScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    weightedScore += score * (INDICATOR_WEIGHTS[key] || 0);
  }

  const indicators = { rsi, stochastic: stoch, macd, bollingerBands: bb, atr, vwap, momentum };

  return { scores, indicators, weightedScore };
};

/**
 * Map composite score to signal label
 * @param {number} score
 * @returns {'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL'}
 */
const scoreToSignal = (score) => {
  if (score > 60) return 'STRONG_BUY';
  if (score > 40) return 'BUY';
  if (score < -60) return 'STRONG_SELL';
  if (score < -40) return 'SELL';
  return 'NEUTRAL';
};

/**
 * Create a signal engine instance
 * @param {ReturnType<import('./candle-aggregator').createCandleAggregator>} candleAggregator
 * @returns {{computeSignals: (contractExpiry?: number | null) => {signal: string, score: number, timeframes: Record<string, any>, noTradeZone: boolean, warningZone: boolean, timestamp: number}}}
 */
const createSignalEngine = (candleAggregator) => {
  /** @type {Record<string, Record<string, any> | null>} */
  const prevIndicators = { '1m': null, '3m': null, '5m': null, '15m': null, '1h': null };

  /**
   * Compute composite signals across all timeframes
   * @param {number | null} [contractExpiry] - Contract expiry timestamp (ms)
   */
  const computeSignals = (contractExpiry = null) => {
    const now = Date.now();
    const timeToExpiry = contractExpiry ? contractExpiry - now : Infinity;
    const noTradeZone = timeToExpiry <= NO_TRADE_ZONE_MS;
    const warningZone = timeToExpiry <= WARNING_ZONE_MS;

    const timeframes = {};
    let compositeScore = 0;

    for (const [tf, weight] of Object.entries(TIMEFRAME_WEIGHTS)) {
      const candles = candleAggregator.getCandles(tf);
      const result = computeTimeframeSignals(candles, prevIndicators[tf]);

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

      compositeScore += result.weightedScore * weight;
    }

    const signal = noTradeZone ? 'NO_TRADE_ZONE' : scoreToSignal(compositeScore);

    return {
      signal,
      score: Math.round(compositeScore * 100) / 100,
      timeframes,
      noTradeZone,
      warningZone,
      timestamp: now,
    };
  };

  return { computeSignals };
};

module.exports = {
  createSignalEngine,
  scoreToSignal,
  scoreRSI,
  scoreStochastic,
  scoreMACD,
  scoreBollinger,
  scoreVWAP,
  scoreMomentum,
  INDICATOR_WEIGHTS,
  TIMEFRAME_WEIGHTS,
};
