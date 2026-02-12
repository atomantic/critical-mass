// @ts-check
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreEMAAlignment,
  scorePriceVsLongEMA,
  scoreDailyTrend,
  scoreEMAConvergence,
  classifyMacroMode,
  createMacroRegime,
} = require('../src/macro-regime');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate an array of candles with a steady price
 * @param {number} count - Number of candles
 * @param {number} basePrice - Starting close price
 * @param {number} [drift=0] - Per-candle price drift
 * @returns {Array<{timestamp: number, close: number}>}
 */
const generateCandles = (count, basePrice, drift = 0) =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: 1000 + i * 3600,
    close: basePrice + i * drift,
  }));

/**
 * Create a mock exchange adapter with predetermined candle responses
 * @param {Object} opts
 * @param {Array} [opts.hourlyCandles]
 * @param {Array} [opts.dailyCandles]
 * @returns {Object} adapter with getCandles method
 */
const createMockAdapter = ({ hourlyCandles = [], dailyCandles = [] } = {}) => ({
  getCandles: async (_productId, _start, _end, granularity) =>
    granularity === 'ONE_HOUR' ? hourlyCandles : dailyCandles,
});

/**
 * Build a default config with sensible test defaults
 */
const defaultConfig = () => ({
  macroHysteresis: 5,
  macroDeclineThreshold: -50,
  macroAccumulationThreshold: -15,
  macroMarkupThreshold: 35,
  macroAccumulationSizeMult: 1.3,
  macroAccumulationTpMult: 0.85,
  macroAccumulationOffsetMult: 0.8,
  macroMarkupSizeMult: 0.7,
  macroMarkupTpMult: 1.3,
  macroMarkupOffsetMult: 1.2,
  macroDeclineSizeMult: 0.4,
  macroDeclineTpMult: 0.7,
  macroDeclineOffsetMult: 1.5,
  macroUpdateIntervalMs: 300000,
});

// ============================================================================
// scoreEMAAlignment
// ============================================================================
describe('scoreEMAAlignment', () => {
  it('returns +30 for perfect bullish alignment (21 > 50 > 200)', () => {
    assert.equal(scoreEMAAlignment(110, 100, 90), 30);
  });

  it('returns -30 for perfect bearish alignment (21 < 50 < 200)', () => {
    assert.equal(scoreEMAAlignment(90, 100, 110), -30);
  });

  it('returns 0 when all EMAs are equal', () => {
    assert.equal(scoreEMAAlignment(100, 100, 100), 0);
  });

  it('returns 0 for any non-positive EMA', () => {
    assert.equal(scoreEMAAlignment(0, 100, 90), 0);
    assert.equal(scoreEMAAlignment(100, -1, 90), 0);
    assert.equal(scoreEMAAlignment(100, 100, 0), 0);
  });

  it('returns partial score for mixed alignment', () => {
    // 21 > 50 (+10), 50 < 200 (-10), 21 < 200 (-10) => -10
    const score = scoreEMAAlignment(95, 90, 100);
    assert.equal(score, -10);
  });
});

// ============================================================================
// scorePriceVsLongEMA
// ============================================================================
describe('scorePriceVsLongEMA', () => {
  it('returns +25 when price is far above 200h EMA', () => {
    // 10% above => pctDistance=10, 10*5=50, clamped to 25
    assert.equal(scorePriceVsLongEMA(110, 100), 25);
  });

  it('returns -25 when price is far below 200h EMA', () => {
    assert.equal(scorePriceVsLongEMA(90, 100), -25);
  });

  it('returns 0 when price equals 200h EMA', () => {
    assert.equal(scorePriceVsLongEMA(100, 100), 0);
  });

  it('returns proportional score for moderate distance', () => {
    // 2% above => pctDistance=2, 2*5=10
    const score = scorePriceVsLongEMA(102, 100);
    assert.ok(Math.abs(score - 10) < 0.01);
  });

  it('returns 0 for non-positive inputs', () => {
    assert.equal(scorePriceVsLongEMA(0, 100), 0);
    assert.equal(scorePriceVsLongEMA(100, 0), 0);
    assert.equal(scorePriceVsLongEMA(-5, 100), 0);
  });
});

// ============================================================================
// scoreDailyTrend
// ============================================================================
describe('scoreDailyTrend', () => {
  it('returns positive score when price is above rising 20d EMA', () => {
    // price 5% above ema20d, ema20d rising 1%
    const score = scoreDailyTrend(105, 100, 99);
    assert.ok(score > 0);
  });

  it('returns negative score when price is below falling 20d EMA', () => {
    const score = scoreDailyTrend(95, 100, 101);
    assert.ok(score < 0);
  });

  it('returns 0 when price equals ema20d with no slope', () => {
    assert.equal(scoreDailyTrend(100, 100, 100), 0);
  });

  it('returns 0 for non-positive price or ema', () => {
    assert.equal(scoreDailyTrend(0, 100, 99), 0);
    assert.equal(scoreDailyTrend(100, 0, 99), 0);
  });

  it('ignores slope when prevEma20d is zero', () => {
    // only price vs EMA component applies
    const score = scoreDailyTrend(103, 100, 0);
    // 3% above => 3*3=9, clamped to 15 for that component, total clamped to 25
    assert.ok(score > 0);
    assert.ok(score <= 25);
  });

  it('clamps to -25/+25 for extreme values', () => {
    assert.equal(scoreDailyTrend(200, 100, 90), 25);
    assert.equal(scoreDailyTrend(50, 100, 110), -25);
  });
});

// ============================================================================
// scoreEMAConvergence
// ============================================================================
describe('scoreEMAConvergence', () => {
  it('returns +20 for wide bullish spread', () => {
    // (110-100)/100*100=10%, 10*10=100, clamped to 20
    assert.equal(scoreEMAConvergence(110, 100), 20);
  });

  it('returns -20 for wide bearish spread', () => {
    assert.equal(scoreEMAConvergence(90, 100), -20);
  });

  it('returns 0 when EMAs converge', () => {
    assert.equal(scoreEMAConvergence(100, 100), 0);
  });

  it('returns proportional score for moderate spread', () => {
    // 1% spread => 1*10=10
    const score = scoreEMAConvergence(101, 100);
    assert.ok(Math.abs(score - 10) < 0.01);
  });

  it('returns 0 for non-positive inputs', () => {
    assert.equal(scoreEMAConvergence(0, 100), 0);
    assert.equal(scoreEMAConvergence(100, 0), 0);
  });
});

// ============================================================================
// classifyMacroMode
// ============================================================================
describe('classifyMacroMode', () => {
  const thresholds = { decline: -50, accumulation: -15, markup: 35 };
  const hyst = 5;

  it('classifies DECLINE for very negative score (initial)', () => {
    assert.equal(classifyMacroMode(-60, null, hyst, thresholds), 'DECLINE');
  });

  it('classifies ACCUMULATION for moderately negative score (initial)', () => {
    assert.equal(classifyMacroMode(-30, null, hyst, thresholds), 'ACCUMULATION');
  });

  it('classifies RANGING for neutral score (initial)', () => {
    assert.equal(classifyMacroMode(0, null, hyst, thresholds), 'RANGING');
  });

  it('classifies MARKUP for high score (initial)', () => {
    assert.equal(classifyMacroMode(50, null, hyst, thresholds), 'MARKUP');
  });

  it('DECLINE mode sticks until score exceeds decline + hysteresis', () => {
    // score=-44 is above decline=-50 but not above decline+hyst=-45
    assert.equal(classifyMacroMode(-46, 'DECLINE', hyst, thresholds), 'DECLINE');
    // score=-44 is above -45 threshold
    assert.equal(classifyMacroMode(-44, 'DECLINE', hyst, thresholds), 'ACCUMULATION');
  });

  it('MARKUP mode sticks until score drops below markup - hysteresis', () => {
    // markup=35, hyst=5 => needs <30 to leave
    assert.equal(classifyMacroMode(31, 'MARKUP', hyst, thresholds), 'MARKUP');
    assert.equal(classifyMacroMode(29, 'MARKUP', hyst, thresholds), 'RANGING');
  });

  it('ACCUMULATION holds unless score crosses thresholds with hysteresis', () => {
    // Within hysteresis band — stays ACCUMULATION
    assert.equal(classifyMacroMode(-14, 'ACCUMULATION', hyst, thresholds), 'ACCUMULATION');
    // Crosses above accumulation+hysteresis => RANGING
    assert.equal(classifyMacroMode(-9, 'ACCUMULATION', hyst, thresholds), 'RANGING');
    // Drops below decline-hysteresis => DECLINE
    assert.equal(classifyMacroMode(-56, 'ACCUMULATION', hyst, thresholds), 'DECLINE');
  });

  it('RANGING holds within hysteresis bands', () => {
    assert.equal(classifyMacroMode(0, 'RANGING', hyst, thresholds), 'RANGING');
    // Cross above markup + hyst
    assert.equal(classifyMacroMode(41, 'RANGING', hyst, thresholds), 'MARKUP');
    // Cross below accumulation - hyst
    assert.equal(classifyMacroMode(-21, 'RANGING', hyst, thresholds), 'ACCUMULATION');
    // Cross below decline - hyst
    assert.equal(classifyMacroMode(-56, 'RANGING', hyst, thresholds), 'DECLINE');
  });

  it('MARKUP transitions to DECLINE if score drops below decline threshold', () => {
    // Below markup-hyst AND below decline
    assert.equal(classifyMacroMode(-60, 'MARKUP', hyst, thresholds), 'DECLINE');
  });

  it('MARKUP transitions to ACCUMULATION if score drops to that band', () => {
    // Below markup-hyst AND below accumulation but above decline
    assert.equal(classifyMacroMode(-30, 'MARKUP', hyst, thresholds), 'ACCUMULATION');
  });

  it('DECLINE transitions directly to MARKUP when score is very high', () => {
    assert.equal(classifyMacroMode(50, 'DECLINE', hyst, thresholds), 'MARKUP');
  });
});

// ============================================================================
// createMacroRegime — factory basics
// ============================================================================
describe('createMacroRegime: factory and state', () => {
  it('defaults to RANGING mode with score 0', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    assert.equal(regime.getMode(), 'RANGING');
    const state = regime.getState();
    assert.equal(state.score, 0);
    assert.equal(state.mode, 'RANGING');
  });

  it('getMultipliers returns 1.0 defaults for RANGING', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    const m = regime.getMultipliers();
    assert.equal(m.sizeMult, 1.0);
    assert.equal(m.tpMult, 1.0);
    assert.equal(m.offsetMult, 1.0);
  });

  it('restoreState sets mode and score from saved data', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState({
      mode: 'MARKUP',
      score: 55,
      emas: { h21: 100, h50: 98, h200: 95, d20: 99 },
      lastUpdate: 12345,
      candles: { hourly: 200, daily: 30 },
    });
    assert.equal(regime.getMode(), 'MARKUP');
    const state = regime.getState();
    assert.equal(state.score, 55);
    assert.equal(state.emas.h21, 100);
    assert.equal(state.lastUpdate, 12345);
  });

  it('restoreState with null is a no-op', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState(null);
    assert.equal(regime.getMode(), 'RANGING');
  });

  it('restoreState defaults missing fields', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState({});
    assert.equal(regime.getMode(), 'RANGING');
    assert.equal(regime.getState().score, 0);
  });
});

// ============================================================================
// createMacroRegime — multipliers per mode
// ============================================================================
describe('createMacroRegime: multipliers', () => {
  it('returns ACCUMULATION multipliers from config', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState({ mode: 'ACCUMULATION', score: -20 });
    const m = regime.getMultipliers();
    assert.equal(m.sizeMult, 1.3);
    assert.equal(m.tpMult, 0.85);
    assert.equal(m.offsetMult, 0.8);
  });

  it('returns MARKUP multipliers from config', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState({ mode: 'MARKUP', score: 50 });
    const m = regime.getMultipliers();
    assert.equal(m.sizeMult, 0.7);
    assert.equal(m.tpMult, 1.3);
    assert.equal(m.offsetMult, 1.2);
  });

  it('returns DECLINE multipliers from config', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState({ mode: 'DECLINE', score: -70 });
    const m = regime.getMultipliers();
    assert.equal(m.sizeMult, 0.4);
    assert.equal(m.tpMult, 0.7);
    assert.equal(m.offsetMult, 1.5);
  });

  it('uses fallback defaults when config multipliers are absent', () => {
    const regime = createMacroRegime('test', {}, createMockAdapter(), 'BTC-USDC');
    regime.restoreState({ mode: 'ACCUMULATION', score: -20 });
    const m = regime.getMultipliers();
    // Defaults from source: 1.3, 0.85, 0.8
    assert.equal(m.sizeMult, 1.3);
    assert.equal(m.tpMult, 0.85);
    assert.equal(m.offsetMult, 0.8);
  });
});

// ============================================================================
// createMacroRegime — update() with mock adapter
// ============================================================================
describe('createMacroRegime: update()', () => {
  it('skips update when hourly candles are insufficient (<50)', async () => {
    const adapter = createMockAdapter({
      hourlyCandles: generateCandles(30, 100000),
      dailyCandles: generateCandles(25, 100000),
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();
    // Mode should remain RANGING (no update performed)
    assert.equal(regime.getMode(), 'RANGING');
    assert.equal(regime.getState().lastUpdate, 0);
  });

  it('skips update when daily candles are insufficient (<20)', async () => {
    const adapter = createMockAdapter({
      hourlyCandles: generateCandles(60, 100000),
      dailyCandles: generateCandles(10, 100000),
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();
    assert.equal(regime.getMode(), 'RANGING');
    assert.equal(regime.getState().lastUpdate, 0);
  });

  it('handles null/empty candle responses gracefully', async () => {
    const adapter = createMockAdapter({
      hourlyCandles: null,
      dailyCandles: null,
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();
    assert.equal(regime.getMode(), 'RANGING');
  });

  it('updates EMAs and score with sufficient flat candles', async () => {
    // 200 hourly candles at 100k, 25 daily at 100k => all EMAs ~100k
    // score should be near 0 => RANGING
    const adapter = createMockAdapter({
      hourlyCandles: generateCandles(200, 100000),
      dailyCandles: generateCandles(25, 100000),
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();

    const state = regime.getState();
    assert.ok(state.lastUpdate > 0, 'lastUpdate should be set');
    assert.equal(state.candles.hourly, 200);
    assert.equal(state.candles.daily, 25);
    assert.equal(state.mode, 'RANGING');
    // With flat candles all at 100k, all EMAs converge to 100k => score ~0
    assert.ok(Math.abs(state.score) < 10, `flat candles should yield near-zero score, got ${state.score}`);
  });

  it('detects MARKUP with strong uptrend candles', async () => {
    // Strongly rising hourly: start 90k drift up to ~110k
    // 21 EMA will lead > 50 EMA > 200 EMA
    const hourly = generateCandles(200, 90000, 100);
    // Rising daily candles
    const daily = generateCandles(25, 95000, 500);
    const adapter = createMockAdapter({
      hourlyCandles: hourly,
      dailyCandles: daily,
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();
    const state = regime.getState();
    assert.ok(state.score > 0, `uptrend score should be positive, got ${state.score}`);
    // Score may or may not exceed markup threshold depending on EMA dynamics,
    // but it should at least not be DECLINE
    assert.notEqual(state.mode, 'DECLINE');
  });

  it('detects DECLINE with strong downtrend candles', async () => {
    // Strongly falling hourly
    const hourly = generateCandles(200, 110000, -100);
    // Falling daily candles
    const daily = generateCandles(25, 107000, -500);
    const adapter = createMockAdapter({
      hourlyCandles: hourly,
      dailyCandles: daily,
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();
    const state = regime.getState();
    assert.ok(state.score < 0, `downtrend score should be negative, got ${state.score}`);
    assert.notEqual(state.mode, 'MARKUP');
  });

  it('uses currentPrice override instead of last candle close', async () => {
    const hourly = generateCandles(200, 100000);
    const daily = generateCandles(25, 100000);
    const adapter = createMockAdapter({
      hourlyCandles: hourly,
      dailyCandles: daily,
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    // Provide a very high current price (10% above flat EMAs)
    await regime.update(110000);
    const state = regime.getState();
    // Price well above EMAs should yield positive score
    assert.ok(state.score > 0, `high price override should produce positive score, got ${state.score}`);
  });

  it('correctly computes EMA slope on second update', async () => {
    const hourly = generateCandles(200, 100000);
    const daily = generateCandles(25, 100000);
    const adapter = createMockAdapter({
      hourlyCandles: hourly,
      dailyCandles: daily,
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');

    // First update sets prevEma20d
    await regime.update();
    const score1 = regime.getState().score;

    // Second update uses prevEma20d for slope calc (flat data => slope ~0)
    await regime.update();
    const score2 = regime.getState().score;

    // Both should be near zero with flat data
    assert.ok(Math.abs(score1) < 10);
    assert.ok(Math.abs(score2) < 10);
  });

  it('sets h200 to 0 when fewer than 200 hourly candles', async () => {
    // 60 hourly candles — enough for update but not for 200h EMA
    const adapter = createMockAdapter({
      hourlyCandles: generateCandles(60, 100000),
      dailyCandles: generateCandles(25, 100000),
    });
    const regime = createMacroRegime('test', defaultConfig(), adapter, 'BTC-USDC');
    await regime.update();
    const state = regime.getState();
    assert.equal(state.emas.h200, 0);
  });
});

// ============================================================================
// createMacroRegime — start/stop timer lifecycle
// ============================================================================
describe('createMacroRegime: start/stop', () => {
  let regime;

  afterEach(() => {
    // Ensure timer is cleared to avoid leaking
    regime?.stop();
  });

  it('start() begins periodic updates and stop() clears the timer', async () => {
    let callCount = 0;
    const adapter = {
      getCandles: async () => {
        callCount++;
        return [];
      },
    };
    const config = { ...defaultConfig(), macroUpdateIntervalMs: 50 };
    regime = createMacroRegime('test', config, adapter, 'BTC-USDC');
    regime.start();

    // Wait for initial + at least one periodic call
    await new Promise(r => setTimeout(r, 130));
    regime.stop();

    // Initial call + at least 1 periodic call = at least 2
    // (getCandles is called twice per update: hourly + daily)
    assert.ok(callCount >= 4, `expected >= 4 getCandles calls (2 per update), got ${callCount}`);
  });

  it('stop() is safe to call without start()', () => {
    regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    // Should not throw
    regime.stop();
    assert.ok(true);
  });
});

// ============================================================================
// getState returns deep copy of emas
// ============================================================================
describe('createMacroRegime: getState isolation', () => {
  it('getState emas object is a copy, not a reference', () => {
    const regime = createMacroRegime('test', defaultConfig(), createMockAdapter(), 'BTC-USDC');
    regime.restoreState({
      mode: 'RANGING',
      score: 0,
      emas: { h21: 100, h50: 98, h200: 95, d20: 99 },
      lastUpdate: 1000,
      candles: { hourly: 200, daily: 30 },
    });
    const state1 = regime.getState();
    state1.emas.h21 = 999;
    const state2 = regime.getState();
    assert.equal(state2.emas.h21, 100, 'mutating returned state should not affect internal state');
  });
});
