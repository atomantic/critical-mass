const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAggressivenessAdvisory, detectCurrentLevel } = require('../src/aggressiveness-advisory');
const { validateRegimeConfig, validateNotificationConfigUpdate } = require('../src/config-validator');
const { shouldSendEvent } = require('../src/notifier');
const { NOTIFICATION_DEFAULTS } = require('../src/config-utils');

const sample = (now, overrides = {}) => ({ now, current: 'moderate', suggested: 'aggressive', ready: true, hours: 1, maxGapMs: 3600000, ...overrides });
describe('sustained advisory', () => {
  it('waits the configured period, fires once and never mutates sizing', () => {
    const tracker = createAggressivenessAdvisory();
    const input = sample(0);
    assert.equal(tracker.observe(input), null);
    assert.equal(tracker.observe(sample(3599999)), null);
    const alert = tracker.observe(sample(3600000));
    assert.equal(alert.first, true);
    assert.equal(alert.since, 0);
    assert.equal(tracker.observe(sample(3600001)).first, false);
    assert.deepEqual(input, sample(0));
  });
  it('restarts dwell on flapping and current level changes', () => {
    const tracker = createAggressivenessAdvisory();
    tracker.observe(sample(0));
    tracker.observe(sample(2000000, { suggested: 'maximum' }));
    assert.equal(tracker.observe(sample(3600000)), null);
    assert.equal(tracker.observe(sample(7200000)).first, true);
    assert.equal(tracker.observe(sample(7200001, { current: 'conservative' })), null);
  });
  it('resets for equal, custom, unavailable, disabled data and observation gaps', () => {
    for (const overrides of [{ suggested: 'moderate' }, { current: null }, { ready: false }]) {
      const tracker = createAggressivenessAdvisory();
      tracker.observe(sample(0));
      assert.equal(tracker.observe(sample(2000000, overrides)), null);
      assert.equal(tracker.observe(sample(3600000)), null);
    }
    const tracker = createAggressivenessAdvisory();
    tracker.observe(sample(0));
    assert.equal(tracker.observe(sample(3600001)), null);
    tracker.reset();
    assert.equal(tracker.observe(sample(7200000)), null);
  });
  it('detects effective custom sizing rather than trusting the saved level', () => {
    const presets = { conservative: { size: 1 }, moderate: { size: 2 }, aggressive: { size: 3 }, maximum: { size: 4 } };
    assert.equal(detectCurrentLevel({ aggressiveness: 'moderate', size: 3 }, presets), 'aggressive');
    assert.equal(detectCurrentLevel({ aggressiveness: 'moderate', size: 2.5 }, presets), null);
  });
  it('validates waiting hours and the opt-in event', () => {
    for (const value of [-1, 0, 721, NaN, Infinity, '6']) {
      assert.equal(validateRegimeConfig({ aggressivenessSuggestionHours: value }).valid, false);
    }
    assert.equal(validateRegimeConfig({ aggressivenessSuggestionHours: 0.5 }).valid, true);
    assert.deepEqual(validateNotificationConfigUpdate({ events: { aggressiveness_suggestion: true } }).errors, []);
  });
  it('requires explicit Telegram opt-in and respects quiet hours', () => {
    const config = { ...NOTIFICATION_DEFAULTS, enabled: true, telegram: { botToken: 'test', chatId: 'test' }, events: {} };
    assert.equal(shouldSendEvent(config, 'aggressiveness_suggestion'), false);
    config.events.aggressiveness_suggestion = true;
    assert.equal(shouldSendEvent(config, 'aggressiveness_suggestion'), true);
    config.quietHours = { enabled: true, start: 0, end: 23 };
    assert.equal(shouldSendEvent(config, 'aggressiveness_suggestion', new Date(2026, 0, 1, 12)), false);
  });
});

it('macro updates expose one sustained fund advisory and emit it through the notifier channel', async () => {
  const { mock } = require('node:test');
  const stores = require('../src/long-term-candle-store');
  const configUtils = require('../src/config-utils');
  const { tradeEvents } = require('../src/trade-events');
  let now = 100000000;
  const candles = Array.from({ length: 365 }, (_, i) => ({ timestamp: i * 86400, close: 100 + i }));
  mock.method(Date, 'now', () => now);
  mock.method(stores, 'createLongTermCandleStore', () => ({
    start() {}, stop() {}, getStats: () => ({ health: 'full' }), getCandles: () => candles,
  }));
  mock.method(configUtils, 'getAggressivenessPresets', () => ({}));
  delete require.cache[require.resolve('../src/macro-regime')];
  const { createMacroRegime } = require('../src/macro-regime');
  const config = { aggressiveness: 'moderate', aggressivenessSuggestionHours: 0.01, longTermBiasEnabled: true };
  const before = { ...config };
  const engine = createMacroRegime('gemini', config, { getCandles: async () => candles }, 'BTC-USD');
  const events = [];
  const listener = event => { if (event.type === 'aggressiveness_suggestion') events.push(event); };
  tradeEvents.on('trade', listener);
  try {
    engine.start();
    await new Promise(resolve => setImmediate(resolve));
    await engine.update(1);
    assert.equal(engine.getState().longTermBias.advisory, null);
    now += 36000;
    await engine.update(1);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.pair, 'BTC-USD');
    assert.equal(events[0].data.suggestedLevel, 'maximum');
    assert.equal(engine.getState().longTermBias.advisory.currentLevel, 'moderate');
    await engine.update(1);
    assert.equal(events.length, 1);
    engine.updateConfig({});
    assert.equal(engine.getState().longTermBias.advisory, null);
    assert.deepEqual(config, before);
  } finally {
    engine.stop();
    tradeEvents.off('trade', listener);
    mock.restoreAll();
    delete require.cache[require.resolve('../src/macro-regime')];
  }
});
