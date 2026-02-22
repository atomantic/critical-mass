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

const { calculateRSI, calculateRSISeries, calculateStochastic, calculateMACD, calculateBollingerBands } = require('./indicators');
const { calculateATR, calculateVWAP, calculateEMA, calculateMomentumAcceleration } = require('../volatility-utils');
const { detectDivergence } = require('./divergence');
const { calculatePivotPoints, computePivotDampening } = require('./pivot-points');

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

const ALL_SIGNAL_TFS = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d'];

const NO_TRADE_ZONE_MS = 6 * 60 * 60 * 1000;
const WARNING_ZONE_MS = 8 * 60 * 60 * 1000;

/**
 * Score RSI indicator (-100 to +100)
 * @param {number} rsi
 * @returns {number}
 */
const scoreRSI = (rsi) => {
  if (rsi == null) return 0;
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
  if (!stoch || (stoch.k === 0 && stoch.d === 0)) return 0;

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
  if (!macd || (macd.macd === 0 && macd.signal === 0)) return 0;

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
  if (percentB == null) return 0;
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
  if (!atr || atr < 0.001 || !vwap || vwap <= 0) return 0;
  const distance = (price - vwap) / atr;
  if (distance < -2) return 70;
  if (distance > 2) return -70;
  // Linear interpolation between -2 and 2
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
const scoreMomentumAcceleration = (momentum, rsi) => {
  if (!momentum || momentum.direction === 'neutral') return 0;

  let base = momentum.direction === 'up' ? 30 : -30;

  // Acceleration/fading multiplier
  if (momentum.acceleration === 'accelerating') base *= 1.5;
  else if (momentum.acceleration === 'fading') base *= 0.5;

  // RSI context bonus: oversold+up or overbought+down
  if ((rsi < 35 && momentum.direction === 'up') || (rsi > 65 && momentum.direction === 'down')) {
    base *= 1.5;
  }

  return Math.max(-100, Math.min(100, Math.round(base)));
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

  if (spread > 0.001) return { trendBias: 'bullish', ema50, ema200, multiplier: 0.5 };
  if (spread < -0.001) return { trendBias: 'bearish', ema50, ema200, multiplier: 0.5 };
  return { trendBias: 'neutral', ema50, ema200, multiplier: 1 };
};

// --- Feature 2: Volatility-Scaled Signal Thresholds ---

/**
 * Compute volatility context from 5m candles (ATR ratio to baseline)
 * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} candles5m
 * @returns {{atr: number, baseline: number, ratio: number}}
 */
const computeVolatilityContext = (candles5m) => {
  if (!candles5m || candles5m.length < 50) {
    return { atr: 0, baseline: 0, ratio: 1 };
  }

  const atr = calculateATR(candles5m, 14);

  // Compute ATR values over the history for EMA baseline
  const atrValues = [];
  for (let i = 14; i < candles5m.length; i++) {
    const slice = candles5m.slice(0, i + 1);
    atrValues.push(calculateATR(slice, 14));
  }

  if (atrValues.length < 50) {
    return { atr, baseline: atr, ratio: 1 };
  }

  // EMA(50) of ATR values as baseline — compute manually from values array
  const mul = 2 / 51;
  let baseline = atrValues.slice(0, 50).reduce((s, v) => s + v, 0) / 50;
  for (let i = 50; i < atrValues.length; i++) {
    baseline = (atrValues[i] - baseline) * mul + baseline;
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
  let neutralThreshold = 40;
  let strongThreshold = 60;

  if (atrRatio < 0.7) {
    // Low vol: widen zones via linear interpolation
    const t = Math.max(0, (0.7 - atrRatio) / 0.7);
    neutralThreshold = 40 + t * 15; // up to 55
    strongThreshold = 60 + t * 15;  // up to 75
  } else if (atrRatio > 1.5) {
    // High vol: tighten zones via linear interpolation
    const t = Math.min(1, (atrRatio - 1.5) / 1.5);
    neutralThreshold = 40 - t * 10; // down to 30
    strongThreshold = 60 - t * 10;  // down to 50
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
  if (score > 60) return 'STRONG_BUY';
  if (score > 40) return 'BUY';
  if (score < -60) return 'STRONG_SELL';
  if (score < -40) return 'SELL';
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
const computeTimeframeSignals = (candles, prevIndicators, weights) => {
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

  const scores = {
    rsi: scoreRSI(rsi),
    stochastic: scoreStochastic(stoch, prevStoch),
    macd: scoreMACD(macd, prevMacd),
    bollinger: scoreBollinger(bb.percentB),
    vwap: scoreVWAP(currentPrice, vwap, atr),
    momentum: scoreMomentumAcceleration(momentum, rsi),
  };

  let weightedScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    weightedScore += score * (weights[key] || 0);
  }

  // Feature 3: Volume surge multiplier
  const volumeSurge = computeVolumeSurge(candles);
  weightedScore *= volumeSurge.multiplier;

  // Feature 5: Divergence detection
  const rsiSeries = calculateRSISeries(closes);
  const divergence = detectDivergence(closes, rsiSeries);
  if (divergence.type === 'bearish' && weightedScore > 0) {
    weightedScore *= (1 - 0.3 * divergence.strength);
  } else if (divergence.type === 'bullish' && weightedScore < 0) {
    weightedScore *= (1 - 0.3 * divergence.strength);
  }

  const indicators = {
    rsi, stochastic: stoch, macd, bollingerBands: bb, atr, vwap, momentum,
    volumeSurge, divergence,
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
    const timeToExpiry = contractExpiry ? contractExpiry - now : Infinity;
    const noTradeZone = timeToExpiry <= NO_TRADE_ZONE_MS;
    const warningZone = timeToExpiry <= WARNING_ZONE_MS;

    const timeframes = {};
    let compositeScore = 0;

    for (const tf of ALL_SIGNAL_TFS) {
      const candles = candleAggregator.getCandles(tf);
      const result = computeTimeframeSignals(candles, prevIndicators[tf], currentIndicatorWeights);

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

    // Feature 1: Trend filter — dampen counter-trend signals
    const candles1h = candleAggregator.getCandles('1h');
    const trendFilter = computeTrendFilter(candles1h);
    if (trendFilter.trendBias === 'bullish' && compositeScore < 0) {
      compositeScore *= trendFilter.multiplier;
    } else if (trendFilter.trendBias === 'bearish' && compositeScore > 0) {
      compositeScore *= trendFilter.multiplier;
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
        if (currentPrice > 0) {
          pivotPoints = computePivotDampening(currentPrice, cachedPivots);
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

    // Feature 2: Volatility-scaled signal thresholds
    const candles5m = candleAggregator.getCandles('5m');
    const volatility = computeVolatilityContext(candles5m);
    const type = noTradeZone ? 'NO_TRADE_ZONE' : scoreToSignalDynamic(compositeScore, volatility.ratio);
    const confidence = Math.min(1, Math.abs(compositeScore) / 60);

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
      volatility,
      pivotPoints,
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
  computeTrendFilter,
  computeVolatilityContext,
  computeVolumeSurge,
  computeHorizonPrediction,
  INDICATOR_WEIGHTS,
  TIMEFRAME_WEIGHTS,
  ALL_SIGNAL_TFS,
  NO_TRADE_ZONE_MS,
  WARNING_ZONE_MS,
};
