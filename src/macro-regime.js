// @ts-check
/**
 * Macro Regime Detection
 *
 * Multi-timeframe trend analysis using hourly and daily EMAs.
 * Classifies market into 4 macro modes (ACCUMULATION/RANGING/MARKUP/DECLINE)
 * that modulate the micro-regime sizing, TP, and entry offset.
 *
 * Scoring system (-100 to +100):
 * - EMA alignment (±30): Bullish/bearish stacking of 21h/50h/200h
 * - Price vs 200h EMA (±25): Distance from long-term trend
 * - Daily trend (±25): Price vs 20d EMA + slope direction
 * - EMA convergence (±20): 21h/50h spread widening vs narrowing
 */

const { calculateEMA, clamp } = require('./volatility-utils');
const { createLongTermCandleStore } = require('./long-term-candle-store');
const { computeDepressionScore } = require('./depression-score');

/**
 * @typedef {import('./types').MacroRegimeMode} MacroRegimeMode
 * @typedef {import('./types').MacroRegimeState} MacroRegimeState
 * @typedef {import('./types').MacroMultipliers} MacroMultipliers
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 * @typedef {import('./types').RegimeStrategyConfig} RegimeStrategyConfig
 */

/**
 * Score EMA alignment (±30)
 * Bullish: 21h > 50h > 200h → +30
 * Bearish: 21h < 50h < 200h → -30
 * Mixed: proportional score
 * @param {number} ema21 - 21-hour EMA
 * @param {number} ema50 - 50-hour EMA
 * @param {number} ema200 - 200-hour EMA
 * @returns {number} Score -30 to +30
 */
const scoreEMAAlignment = (ema21, ema50, ema200) => {
  if (ema21 <= 0 || ema50 <= 0 || ema200 <= 0) return 0;

  let score = 0;
  // Each pair contributes ±10
  if (ema21 > ema50) score += 10;
  else if (ema21 < ema50) score -= 10;

  if (ema50 > ema200) score += 10;
  else if (ema50 < ema200) score -= 10;

  if (ema21 > ema200) score += 10;
  else if (ema21 < ema200) score -= 10;

  return score;
};

/**
 * Score price vs 200h EMA (±25)
 * Positive when price is above, negative when below
 * Capped at ±25 based on % distance
 * @param {number} price - Current price
 * @param {number} ema200 - 200-hour EMA
 * @returns {number} Score -25 to +25
 */
const scorePriceVsLongEMA = (price, ema200) => {
  if (price <= 0 || ema200 <= 0) return 0;

  const pctDistance = ((price - ema200) / ema200) * 100;
  // Scale: ±5% distance maps to ±25 score
  return clamp(pctDistance * 5, -25, 25);
};

/**
 * Score daily trend (±25)
 * Based on price vs 20d EMA and whether the EMA is rising or falling
 * @param {number} price - Current price
 * @param {number} ema20d - Current 20-day EMA
 * @param {number} prevEma20d - Previous day's 20d EMA (for slope)
 * @returns {number} Score -25 to +25
 */
const scoreDailyTrend = (price, ema20d, prevEma20d) => {
  if (price <= 0 || ema20d <= 0) return 0;

  let score = 0;

  // Price vs 20d EMA (±15)
  const pctAbove = ((price - ema20d) / ema20d) * 100;
  score += clamp(pctAbove * 3, -15, 15);

  // EMA slope direction (±10)
  if (prevEma20d > 0) {
    const slopePct = ((ema20d - prevEma20d) / prevEma20d) * 100;
    score += clamp(slopePct * 20, -10, 10);
  }

  return clamp(score, -25, 25);
};

/**
 * Score EMA convergence (±20)
 * Widening 21h/50h spread → trending (positive if bullish, negative if bearish)
 * Narrowing spread → ranging (towards 0)
 * @param {number} ema21 - 21-hour EMA
 * @param {number} ema50 - 50-hour EMA
 * @returns {number} Score -20 to +20
 */
const scoreEMAConvergence = (ema21, ema50) => {
  if (ema21 <= 0 || ema50 <= 0) return 0;

  const spreadPct = ((ema21 - ema50) / ema50) * 100;
  // Wider spread = stronger trend signal
  // Scale: ±2% spread maps to ±20 score
  return clamp(spreadPct * 10, -20, 20);
};

/**
 * Classify macro mode from score with hysteresis
 * @param {number} score - Composite score (-100 to +100)
 * @param {MacroRegimeMode} currentMode - Current mode
 * @param {number} hysteresis - Hysteresis band width
 * @param {Object} thresholds - Score thresholds
 * @param {number} thresholds.decline - Below this → DECLINE
 * @param {number} thresholds.accumulation - Below this → ACCUMULATION
 * @param {number} thresholds.markup - Above this → MARKUP
 * @returns {MacroRegimeMode}
 */
const classifyMacroMode = (score, currentMode, hysteresis, thresholds) => {
  const { decline, accumulation, markup } = thresholds;

  // Apply hysteresis: require crossing boundary + hysteresis to transition out
  switch (currentMode) {
    case 'DECLINE':
      if (score > decline + hysteresis) {
        return score > markup ? 'MARKUP' : (score > accumulation ? 'RANGING' : 'ACCUMULATION');
      }
      return 'DECLINE';

    case 'ACCUMULATION':
      if (score < decline - hysteresis) return 'DECLINE';
      if (score > accumulation + hysteresis) {
        return score > markup ? 'MARKUP' : 'RANGING';
      }
      return 'ACCUMULATION';

    case 'RANGING':
      if (score < decline - hysteresis) return 'DECLINE';
      if (score < accumulation - hysteresis) return 'ACCUMULATION';
      if (score > markup + hysteresis) return 'MARKUP';
      return 'RANGING';

    case 'MARKUP':
      if (score < markup - hysteresis) {
        if (score < decline) return 'DECLINE';
        if (score < accumulation) return 'ACCUMULATION';
        return 'RANGING';
      }
      return 'MARKUP';

    default:
      // Initial classification (no hysteresis)
      if (score < decline) return 'DECLINE';
      if (score < accumulation) return 'ACCUMULATION';
      if (score > markup) return 'MARKUP';
      return 'RANGING';
  }
};

/**
 * Create macro regime instance
 * @param {string} exchange - Exchange name
 * @param {RegimeStrategyConfig} config - Regime config (mutable reference, updated by engine)
 * @param {ExchangeAdapter} adapter - Exchange adapter for fetching candles
 * @param {string} productId - Trading pair ID (e.g., 'BTC-USDC')
 * @returns {Object} Macro regime instance
 */
const createMacroRegime = (exchange, config, adapter, productId) => {

  /** @type {MacroRegimeMode} */
  let mode = 'RANGING';
  let score = 0;
  let emas = { h21: 0, h50: 0, h200: 0, d20: 0 };
  let lastUpdate = 0;
  let candleCounts = { hourly: 0, daily: 0 };
  let updateTimer = null;

  // Long-term bias / depression score (Phase 1 of auto-aggressiveness)
  // This is a separate signal layered on top of the existing macro EMAs.
  // The store fetches multi-year daily candles on a slow cadence and caches
  // them to disk. The score is recomputed on each macro update cycle.
  /** @type {ReturnType<typeof createLongTermCandleStore>|null} */
  let longTermStore = null;
  let longTermBias = null;

  /**
   * Fetch hourly candles (200 most recent)
   * @returns {Promise<Array>}
   */
  const fetchHourlyCandles = async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - (200 * 3600); // 200 hours ago
    return adapter.getCandles(productId, start, now, 'ONE_HOUR');
  };

  /**
   * Fetch daily candles (30 most recent)
   * @returns {Promise<Array>}
   */
  const fetchDailyCandles = async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - (30 * 86400); // 30 days ago
    return adapter.getCandles(productId, start, now, 'ONE_DAY');
  };

  /**
   * Update macro regime: fetch candles, compute EMAs, score, classify
   * @param {number} [currentPrice] - Optional current price override
   * @returns {Promise<void>}
   */
  const update = async (currentPrice) => {
    const [rawHourly, rawDaily] = await Promise.all([
      fetchHourlyCandles(),
      fetchDailyCandles(),
    ]);

    // Sort candles oldest-first (Coinbase may return newest-first)
    const hourlyCandles = (rawHourly || []).sort((a, b) => a.timestamp - b.timestamp);
    const dailyCandles = (rawDaily || []).sort((a, b) => a.timestamp - b.timestamp);

    if (!hourlyCandles || hourlyCandles.length < 50) {
      console.log(`⏳ [${exchange}] Macro: insufficient hourly candles (${hourlyCandles?.length || 0}/50 min)`);
      return;
    }
    if (!dailyCandles || dailyCandles.length < 20) {
      console.log(`⏳ [${exchange}] Macro: insufficient daily candles (${dailyCandles?.length || 0}/20 min)`);
      return;
    }

    candleCounts = { hourly: hourlyCandles.length, daily: dailyCandles.length };

    // Compute EMAs
    const h21 = calculateEMA(hourlyCandles, 21);
    const h50 = calculateEMA(hourlyCandles, 50);
    const h200 = hourlyCandles.length >= 200 ? calculateEMA(hourlyCandles, 200) : 0;
    const d20 = calculateEMA(dailyCandles, 20);

    // Previous day's 20d EMA for the slope term: recompute the EMA over the
    // daily series excluding the most recent (still-forming) daily candle.
    // Measuring the slope across two consecutive *daily* candles makes it a
    // true daily-trend signal. The old code snapshotted prevEma20d every
    // ~5-min update cycle, so the slope measured a 20-day EMA's movement over
    // 5 minutes — effectively zero, silently killing up to 20 points of
    // macro-score range (#153). Computing it from the series is stateless, so
    // it stays correct across engine restarts. With exactly 20 daily candles
    // the prior series has 19 (< 20 period) and calculateEMA returns 0,
    // leaving the slope term neutral until a 21st daily candle exists.
    const prevD20 = calculateEMA(dailyCandles.slice(0, -1), 20);

    emas = { h21, h50, h200, d20 };

    // Use provided price or latest candle close
    const price = currentPrice || hourlyCandles[hourlyCandles.length - 1].close;

    // Compute component scores
    const alignmentScore = scoreEMAAlignment(h21, h50, h200);
    const priceVsLongScore = h200 > 0 ? scorePriceVsLongEMA(price, h200) : 0;
    const dailyTrendScore = scoreDailyTrend(price, d20, prevD20);
    const convergenceScore = scoreEMAConvergence(h21, h50);

    const newScore = clamp(
      alignmentScore + priceVsLongScore + dailyTrendScore + convergenceScore,
      -100,
      100
    );

    const prevMode = mode;
    score = newScore;

    const hysteresis = config.macroHysteresis || 5;
    const thresholds = {
      decline: config.macroDeclineThreshold || -50,
      accumulation: config.macroAccumulationThreshold || -15,
      markup: config.macroMarkupThreshold || 35,
    };

    mode = classifyMacroMode(score, mode, hysteresis, thresholds);
    lastUpdate = Date.now();

    // Compute long-term bias / depression score from the candle store.
    // If the cache is empty or under-filled (e.g. first update on a cold
    // start, or recovering from a previous partial fetch), wait for the
    // in-flight refresh to settle so we don't display stale data for an
    // entire macro update cycle.
    if (longTermStore && config.longTermBiasEnabled !== false) {
      let stats = longTermStore.getStats();
      if (stats.health === 'empty' || stats.health === 'sparse' || stats.health === 'partial') {
        try {
          await longTermStore.refresh();
          stats = longTermStore.getStats();
        } catch {
          // Non-fatal — fall through with whatever we have
        }
      }
      const ltCandles = longTermStore.getCandles();
      longTermBias = computeDepressionScore(price, ltCandles);
    }

    if (prevMode !== mode) {
      console.log(`🔭 [${exchange}] Macro regime: ${prevMode} → ${mode} (score=${score.toFixed(1)}, EMAs: 21h=$${h21.toFixed(0)} 50h=$${h50.toFixed(0)} 200h=$${h200.toFixed(0)} 20d=$${d20.toFixed(0)})`);
    } else {
      console.log(`🔭 [${exchange}] Macro update: ${mode} score=${score.toFixed(1)} (align=${alignmentScore} price200=${priceVsLongScore.toFixed(1)} daily=${dailyTrendScore.toFixed(1)} conv=${convergenceScore.toFixed(1)})`);
    }

    // Log the long-term bias on every cycle so we can correlate it with
    // entries and watch the score evolve. Compact one-liner.
    if (longTermBias?.ready) {
      const c = longTermBias.components;
      console.log(`🗓️ [${exchange}] LT bias: ${(longTermBias.score * 100).toFixed(0)}/100 → ${longTermBias.suggestedLevel.toUpperCase()} ` +
        `(pct=${(c.percentile.score * 100).toFixed(0)} ` +
        `dd=${c.drawdown.drawdownPct.toFixed(1)}% ` +
        `z=${c.zscore.zscore.toFixed(2)}) ` +
        `n=${longTermBias.sampleSize}`);
    }
  };

  /**
   * Get current macro mode
   * @returns {MacroRegimeMode}
   */
  const getMode = () => mode;

  /**
   * Get multipliers for current mode from config
   * @returns {MacroMultipliers}
   */
  const getMultipliers = () => {
    switch (mode) {
      case 'ACCUMULATION':
        return {
          sizeMult: config.macroAccumulationSizeMult || 1.3,
          tpMult: config.macroAccumulationTpMult || 0.85,
          offsetMult: config.macroAccumulationOffsetMult || 0.8,
        };
      case 'MARKUP':
        return {
          sizeMult: config.macroMarkupSizeMult || 0.7,
          tpMult: config.macroMarkupTpMult || 1.3,
          offsetMult: config.macroMarkupOffsetMult || 1.2,
        };
      case 'DECLINE':
        return {
          sizeMult: config.macroDeclineSizeMult || 0.4,
          tpMult: config.macroDeclineTpMult || 0.7,
          offsetMult: config.macroDeclineOffsetMult || 1.5,
        };
      default: // RANGING
        return { sizeMult: 1.0, tpMult: 1.0, offsetMult: 1.0 };
    }
  };

  /**
   * Get full state for dashboard/persistence
   * @returns {MacroRegimeState}
   */
  const getState = () => ({
    mode,
    score,
    emas: { ...emas },
    lastUpdate,
    candles: { ...candleCounts },
    // Long-term bias is intentionally not persisted to disk — it's
    // recomputed from cached candles on every update cycle.
    longTermBias: longTermBias ? {
      ...longTermBias,
      cache: longTermStore ? longTermStore.getStats() : null,
    } : null,
  });

  /**
   * Restore state from persistence
   * @param {MacroRegimeState} saved - Saved state
   */
  const restoreState = (saved) => {
    if (!saved) return;
    mode = saved.mode || 'RANGING';
    score = saved.score || 0;
    if (saved.emas) emas = { ...saved.emas };
    lastUpdate = saved.lastUpdate || 0;
    if (saved.candles) candleCounts = { ...saved.candles };
    console.log(`📂 [${exchange}] Macro state restored: ${mode} score=${score.toFixed(1)}`);
  };

  /**
   * Update config values (hot-reload)
   * Config is a mutable reference from regime-engine, so Object.assign works
   * @param {Object} updates - Config updates
   */
  const updateConfig = (updates) => {
    // Config is already updated by regime-engine's Object.assign
    // This is a hook for any macro-specific reinitialization if needed
  };

  /**
   * Start periodic updates
   */
  const start = () => {
    const interval = config.macroUpdateIntervalMs || 300000;
    console.log(`🔭 [${exchange}] Macro regime started (update every ${(interval / 1000).toFixed(0)}s)`);

    // Spin up the long-term candle store on its own slow cadence.
    // Default off-by-default could be enabled later, but Phase 1 is observe-only
    // so it's safe to leave on by default — no sizing impact.
    if (config.longTermBiasEnabled !== false) {
      longTermStore = createLongTermCandleStore(exchange, adapter, productId, {
        lookbackDays: config.longTermLookbackDays || 365,
        refreshIntervalMs: config.longTermUpdateIntervalMs || 3600000,
      });
      longTermStore.start();
      console.log(`🗓️ [${exchange}] Long-term bias store started (${config.longTermLookbackDays || 365}d window, refresh every ${((config.longTermUpdateIntervalMs || 3600000) / 60000).toFixed(0)}m)`);
    }

    // Initial update
    update().catch(err => {
      console.log(`⚠️ [${exchange}] Macro initial update failed: ${err.message}`);
    });

    // Periodic updates
    updateTimer = setInterval(() => {
      update().catch(err => {
        console.log(`⚠️ [${exchange}] Macro update failed: ${err.message}`);
      });
    }, interval);
  };

  /**
   * Stop periodic updates
   */
  const stop = () => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
    if (longTermStore) {
      longTermStore.stop();
      longTermStore = null;
    }
    console.log(`🔭 [${exchange}] Macro regime stopped`);
  };

  return {
    start,
    stop,
    update,
    getMode,
    getMultipliers,
    getState,
    restoreState,
    updateConfig,
  };
};

module.exports = {
  createMacroRegime,
  // Exported for testing
  scoreEMAAlignment,
  scorePriceVsLongEMA,
  scoreDailyTrend,
  scoreEMAConvergence,
  classifyMacroMode,
};
